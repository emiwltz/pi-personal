// The port, version 1: plain files. See docs/port.md, which is the contract; this module only implements it.
import * as fs from "node:fs";
import * as path from "node:path";

export const VERSION = "1";
const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/; // never a leading dot: the inbox ignores such files
const FROM_MAX = 4096; // bytes of JSON: "from" is copied into every event that answers the message
const YOUNG_MS = 5_000; // a file younger than this that does not parse may still be being written
const UNREADABLE_MS = 60_000; // a file that cannot be read for this long is set aside

export interface From {
	[key: string]: unknown;
}
export interface Message {
	id: string;
	text: string;
	attachments?: string[];
	from?: From;
	conversation?: string; // where the answer goes ("<channel>:<id>"); messages of one conversation keep their order
}
export interface Ref {
	id: string;
	from?: From;
	conversation?: string;
}
export type PortEvent = { type: string; at?: string; [key: string]: unknown };
export type Cursor = number; // a byte offset in events.jsonl: where a reader is

const inbox = (port: string) => path.join(port, "inbox");
const taken = (port: string) => path.join(port, "taken");
const rejectedDir = (port: string) => path.join(port, "rejected");
export const eventsFile = (port: string) => path.join(port, "events.jsonl");

/** Create the port's folders (mode 0700), its version file and its events file. Safe to call many times. */
export function ensurePort(port: string): void {
	for (const dir of [port, inbox(port), taken(port), rejectedDir(port)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(port, 0o700);
	const version = path.join(port, "version");
	if (!fs.existsSync(version)) fs.writeFileSync(version, `${VERSION}\n`);
	try {
		if (!fs.existsSync(eventsFile(port))) fs.writeFileSync(eventsFile(port), "", { mode: 0o600, flag: "a" });
	} catch {} // a full disk: the first event that can be written creates it
}

/** Validate a message; returns the reason it is not valid, or undefined. */
export function invalid(msg: unknown): string | undefined {
	if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return "not a JSON object";
	const m = msg as Record<string, unknown>;
	if (typeof m.id !== "string" || !ID_RE.test(m.id)) return "id must be 1 to 128 characters of A-Z a-z 0-9 . _ -, not starting with a dot";
	if (typeof m.text !== "string") return "text must be a string";
	if (m.attachments !== undefined && (!Array.isArray(m.attachments) || !m.attachments.every((a) => typeof a === "string" && path.isAbsolute(a))))
		return "attachments must be absolute paths";
	if (m.text === "" && !(Array.isArray(m.attachments) && m.attachments.length > 0)) return "text is empty and there are no attachments";
	if (m.from !== undefined && (typeof m.from !== "object" || m.from === null || Array.isArray(m.from))) return "from must be an object";
	if (m.from !== undefined && Buffer.byteLength(JSON.stringify(m.from)) > FROM_MAX) return `from must be at most ${FROM_MAX} bytes of JSON`;
	if (m.conversation !== undefined && (typeof m.conversation !== "string" || m.conversation.length > 200)) return "conversation must be a string of at most 200 characters";
	return undefined;
}

function fsyncDir(dir: string): void {
	try {
		const fd = fs.openSync(dir, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// Some platforms cannot open a directory for fsync; the file itself is already flushed.
	}
}

/**
 * Submit a message: write it durably and exclusively into the inbox.
 * Returns "accepted", or "duplicate" when a message with this id is already waiting or taken.
 */
export function submit(port: string, msg: Message): "accepted" | "duplicate" {
	const why = invalid(msg);
	if (why) throw new Error(`invalid message: ${why}`);
	ensurePort(port);
	const final = path.join(inbox(port), `${msg.id}.json`);
	if (fs.existsSync(final) || fs.existsSync(path.join(taken(port), `${msg.id}.json`))) return "duplicate";
	const tmp = path.join(inbox(port), `.${msg.id}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		fs.writeSync(fd, `${JSON.stringify(msg)}\n`);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.linkSync(tmp, final);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
		throw err;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
	fsyncDir(inbox(port));
	return "accepted";
}

const byId = new Intl.Collator("en", { numeric: true });

export interface Pending {
	id: string; // from the file name
	file: string;
	mtime: bigint; // when it was written (nanoseconds): a reader may keep what it parsed until this changes
}

/** Messages waiting in the inbox, in the order they were written. Only regular files count. */
export function pending(port: string): Pending[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(inbox(port), { withFileTypes: true });
	} catch {
		return [];
	}
	const list: { id: string; file: string; mtime: bigint }[] = [];
	for (const d of entries) {
		if (!d.isFile() || d.name.startsWith(".") || !d.name.endsWith(".json")) continue;
		const file = path.join(inbox(port), d.name);
		try {
			list.push({ id: d.name.slice(0, -5), file, mtime: fs.statSync(file, { bigint: true }).mtimeNs });
		} catch {
			// Taken meanwhile.
		}
	}
	// Files written within one clock tick share a modification time: their ids decide, numbers compared as numbers.
	list.sort((a, b) => (a.mtime < b.mtime ? -1 : a.mtime > b.mtime ? 1 : byId.compare(a.id, b.id)));
	return list;
}

/**
 * Read a pending message. `{ msg }`, or `{ reason, later }`: with `later`, the file may still be being written or
 * cannot be read right now, so try again; without it, the file breaks the protocol and is set aside.
 */
export function read(p: Pending): { msg: Message } | { reason: string; later?: boolean } {
	let text: string;
	let age = Number.POSITIVE_INFINITY;
	try {
		age = Date.now() - fs.statSync(p.file).mtimeMs;
		if (age < -60_000) age = Number.POSITIVE_INFINITY; // dated in the future (a clock set back): not "being written"
		text = fs.readFileSync(p.file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { reason: "gone", later: true };
		return age < UNREADABLE_MS ? { reason: "unreadable", later: true } : { reason: `unreadable: ${(err as Error).message}` };
	}
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return age < YOUNG_MS ? { reason: "incomplete", later: true } : { reason: "not valid JSON" };
	}
	const why = invalid(msg);
	if (why) return age < YOUNG_MS && text.trim() === "" ? { reason: "incomplete", later: true } : { reason: why };
	if ((msg as Message).id !== p.id) return { reason: "id does not match the file name" };
	return { msg: msg as Message };
}

export function isTaken(port: string, id: string): boolean {
	return fs.existsSync(path.join(taken(port), `${id}.json`));
}

/** Move a message from the inbox to taken/. Idempotent. A missing taken/ folder is created again. */
export function take(port: string, id: string): void {
	const from = path.join(inbox(port), `${id}.json`);
	const to = path.join(taken(port), `${id}.json`);
	for (let i = 0; i < 2; i++)
		try {
			if (fs.existsSync(to)) fs.rmSync(from, { force: true });
			else fs.renameSync(from, to);
			return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			if (!fs.existsSync(from)) return; // already moved
			fs.mkdirSync(taken(port), { recursive: true, mode: 0o700 });
		}
}

/** Set a broken file aside in rejected/. Its id stays free: a corrected message with the same id is accepted. */
export function reject(port: string, id: string): void {
	fs.mkdirSync(rejectedDir(port), { recursive: true, mode: 0o700 });
	try {
		fs.renameSync(path.join(inbox(port), `${id}.json`), path.join(rejectedDir(port), `${id}.json`));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
}

/**
 * Append one event, as a single write of one line, so concurrent writers never interleave within a line.
 * If the file does not end with a newline (a write cut off by a power loss or a full disk), the broken
 * line is closed first, so it cannot swallow this event. Throws when the file cannot be written.
 */
export function append(port: string, event: PortEvent): void {
	const line = Buffer.from(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
	const fd = fs.openSync(eventsFile(port), "a+", 0o600);
	try {
		const size = fs.fstatSync(fd).size;
		let buf = line;
		if (size > 0) {
			const last = Buffer.alloc(1);
			fs.readSync(fd, last, 0, 1, size - 1);
			if (last[0] !== 10) buf = Buffer.concat([Buffer.from("\n"), line]);
		}
		for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * An emitter that never throws: what cannot be written now (a full disk, a read-only file) waits in memory,
 * in order, and is written as soon as writing works again. The agent and its keeper never die of a log write.
 */
export function emitter(port: string, onTrouble: (message: string) => void = () => {}): ((e: PortEvent) => void) & { troubled: () => boolean } {
	const backlog: PortEvent[] = [];
	let troubled = false;
	let timer: NodeJS.Timeout | undefined;
	const flush = () => {
		while (backlog.length) {
			try {
				append(port, backlog[0]);
				backlog.shift();
			} catch (err) {
				if (!troubled) onTrouble(`cannot write the port's events (${(err as Error).message}); keeping them until it works again`);
				troubled = true;
				timer ??= setInterval(flush, 2000);
				timer.unref?.();
				return;
			}
		}
		if (troubled) onTrouble("the port's events can be written again");
		troubled = false;
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	const emit = (e: PortEvent) => {
		backlog.push({ at: new Date().toISOString(), ...e });
		if (backlog.length > 5000) backlog.splice(0, backlog.length - 5000); // a bound, so memory never grows without end
		flush();
	};
	return Object.assign(emit, { troubled: () => troubled });
}

export type Seen = PortEvent & { cursor: Cursor; after: Cursor };

/**
 * Events from a byte offset: complete lines only. Each event gets `cursor` (where its line starts) and `after` (where
 * the next one starts). If the file is shorter than the offset, it was replaced by hand: read it from its start.
 */
export function events(port: string, from: Cursor = 0): { events: Seen[]; next: Cursor } {
	let fd: number;
	try {
		fd = fs.openSync(eventsFile(port), "r");
	} catch {
		return { events: [], next: from };
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size < from) from = 0;
		if (size === from) return { events: [], next: from };
		const buf = Buffer.alloc(size - from);
		const n = fs.readSync(fd, buf, 0, buf.length, from);
		const out: Seen[] = [];
		let pos = 0;
		for (;;) {
			const nl = buf.subarray(0, n).indexOf(10, pos);
			if (nl < 0) break; // an incomplete last line is read next time
			try {
				out.push({ ...(JSON.parse(buf.subarray(pos, nl).toString("utf8")) as PortEvent), cursor: from + pos, after: from + nl + 1 });
			} catch {
				// A corrupt line is skipped, never fatal.
			}
			pos = nl + 1;
		}
		return { events: out, next: from + pos };
	} finally {
		fs.closeSync(fd);
	}
}

/** The offset at the end of the events file: a cursor that sees only what comes next. */
export function end(port: string): Cursor {
	try {
		return fs.statSync(eventsFile(port)).size;
	} catch {
		return 0;
	}
}

/** Call `onEvent` for every event from `from` on, until it returns true or the signal aborts. Returns where it stopped. */
export async function follow(port: string, from: Cursor, onEvent: (e: Seen) => void | boolean | Promise<void | boolean>, signal?: AbortSignal): Promise<Cursor> {
	ensurePort(port);
	let pos = from;
	let wake: (() => void) | undefined;
	const watcher = fs.watch(port, () => wake?.());
	const onAbort = () => wake?.();
	signal?.addEventListener("abort", onAbort);
	try {
		while (!signal?.aborted) {
			const batch = events(port, pos);
			for (const e of batch.events) {
				pos = e.after;
				if ((await onEvent(e)) === true) return pos;
			}
			pos = batch.next;
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, 500); // a fallback: file watching is not reliable everywhere
				wake = () => {
					clearTimeout(t);
					resolve();
				};
				if (signal?.aborted) wake();
			});
			wake = undefined;
		}
		return pos;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		watcher.close();
	}
}
