#!/usr/bin/env node
// The Telegram channel: a Pi-Personal side program. It talks to Telegram by long polling (no public address needed)
// and to the agent through the port only (docs/port.md); it imports nothing from Pi-Personal's core.
//
// Deny by default: it obeys only the Telegram user ids on its guest list (allow.json in its private state
// folder, outside the agent's working folder). With no list it obeys nobody. Unlisted senders are recorded, never added.
//
//   run (started by Pi-Personal's keeper):  node telegram.ts
//   who wrote and is not listed:        pp channel <agent> telegram who
//   add someone to the list:            pp channel <agent> telegram allow <user id>
//   check the token and the list:       pp channel <agent> telegram check   (pp doctor runs it)
//
// Everything specific to Telegram lives here: long polling, the guest list, Markdown shown as Telegram formatting
// (format.ts), replies quoting the message they answer, "typing..." while the agent works, errors told to the
// sender, splitting at 4,096 characters, and Telegram's rates.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { closeFences, toHtml } from "./format.ts";

const env = (k: string) => process.env[`PI_PERSONAL_${k}`] ?? "";
const PORT = env("PORT");
const STATE = env("STATE");
const SECRETS = env("SECRETS");
const FILES = path.join(STATE, "files"); // files received for the agent
const LIMIT = 4096; // Telegram's maximum message length, in UTF-16 code units (a JavaScript string's length)

const log = (text: string) => process.stderr.write(`${new Date().toISOString()} [telegram] ${text}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- settings and state -------------------------------------------------------------------------------------

interface Settings {
	apiBase?: string; // another Bot API server, such as a local one; default https://api.telegram.org
}
const SETTINGS: Settings = JSON.parse(env("SETTINGS") || "{}"); // this channel's object in pi-personal.json, read at its start
const settings = () => SETTINGS;

const allowFile = () => path.join(STATE, "allow.json");
let unreadable = false;
/** The guest list (Telegram user ids). undefined when it cannot be read: then nothing is decided, nothing is lost. */
function guests(): string[] | undefined {
	try {
		const ids = JSON.parse(fs.readFileSync(allowFile(), "utf8")).allow;
		if (!Array.isArray(ids)) throw new Error("no allow list in it");
		unreadable = false;
		return ids.map(String);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no list yet: nobody is allowed
		if (!unreadable) log(`cannot read the guest list ${allowFile()} (${(err as Error).message}): waiting until it is fixed; nothing is answered or dropped meanwhile`);
		unreadable = true;
		return undefined;
	}
}
/** The owner: the Telegram user who said "that is me" in the setup, at the terminal. Their messages say so, and only
 * theirs: the agent changes its settings for its owner only. */
const ownerFile = () => path.join(STATE, "owner");
function owner(): string | undefined {
	try {
		return fs.readFileSync(ownerFile(), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
function setOwner(id: string): void {
	if (owner()) return; // the first one stays the owner
	fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
	fs.writeFileSync(ownerFile(), `${id}\n`, { mode: 0o600 });
}
function writeGuests(ids: string[]): string[] {
	fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
	fs.writeFileSync(`${allowFile()}.tmp`, `${JSON.stringify({ allow: ids }, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(`${allowFile()}.tmp`, allowFile());
	return ids;
}

interface State {
	offset: number; // the next Telegram update to fetch; everything before it is confirmed
	events?: number; // where we are in the agent's events.jsonl: a byte offset
}
const stateFile = () => path.join(STATE, "state.json");
function loadState(): State {
	try {
		return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
	} catch {
		return { offset: 0 };
	}
}
let state: State;
function saveState(): void {
	const tmp = `${stateFile()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state));
	fs.renameSync(tmp, stateFile());
}

// ---- Telegram ---------------------------------------------------------------------------------------------

/** A token that setup is checking with Telegram, before it is stored. */
let trying: string | undefined;

function token(): string {
	if (trying) return trying;
	const file = path.join(SECRETS, "telegram-token");
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		log(`no bot token: store it with "pp secret set ${env("AGENT")} telegram-token" (it is read from standard input)`);
		process.exit(2);
	}
}

class TelegramError extends Error {
	code: number;
	retryAfter?: number;
	constructor(code: number, description: string, retryAfter?: number) {
		super(`Telegram error ${code}: ${description}`);
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

/** Never let the token reach a log: errors from fetch can quote the URL, which holds it. */
const redact = (err: unknown) => new Error(String((err as Error)?.message ?? err).replaceAll(token(), "<token>"));

async function call(method: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
	const base = settings().apiBase ?? "https://api.telegram.org";
	let res: Response;
	try {
		res = await fetch(`${base}/bot${token()}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		throw redact(err);
	}
	const data = (await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }))) as any;
	if (!data.ok) throw new TelegramError(data.error_code ?? res.status, String(data.description ?? "unknown").replaceAll(token(), "<token>"), data.parameters?.retry_after);
	return data.result;
}

async function download(fileId: string, name: string): Promise<string> {
	const f = await call("getFile", { file_id: fileId });
	if (!f.file_path) throw new Error("Telegram gave no file path (files over 20 MB cannot be downloaded by bots)");
	const base = settings().apiBase ?? "https://api.telegram.org";
	const res = await fetch(`${base}/file/bot${token()}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) }).catch((err) => {
		throw redact(err);
	});
	if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
	fs.mkdirSync(FILES, { recursive: true, mode: 0o700 });
	const file = path.join(FILES, name.replace(/[^A-Za-z0-9._-]/g, "_"));
	fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
	return file;
}

// ---- the port (docs/port.md) --------------------------------------------------------------------------------

/** Submit a message: write a temporary file, then link it into the inbox under its id (exclusive and atomic). */
function submit(msg: Record<string, unknown> & { id: string }): void {
	const inbox = path.join(PORT, "inbox");
	const final = path.join(inbox, `${msg.id}.json`);
	if (fs.existsSync(final) || fs.existsSync(path.join(PORT, "taken", `${msg.id}.json`))) return; // already sent
	const tmp = path.join(inbox, `.${msg.id}.${process.pid}.tmp`);
	const fd = fs.openSync(tmp, "w", 0o600);
	fs.writeSync(fd, JSON.stringify(msg));
	fs.fsyncSync(fd);
	fs.closeSync(fd);
	try {
		fs.linkSync(tmp, final);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

const eventsFile = () => path.join(PORT, "events.jsonl");

/** The agent's events from a byte offset: complete lines only. A file shorter than the offset was replaced by hand. */
function readEvents(from: number): { list: { e: any; after: number }[]; next: number } {
	let fd: number;
	try {
		fd = fs.openSync(eventsFile(), "r");
	} catch {
		return { list: [], next: from };
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size < from) from = 0;
		if (size === from) return { list: [], next: from };
		const buf = Buffer.alloc(size - from);
		fs.readSync(fd, buf, 0, buf.length, from);
		const list: { e: any; after: number }[] = [];
		let pos = 0;
		for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, pos)) {
			try {
				list.push({ e: JSON.parse(buf.subarray(pos, nl).toString("utf8")), after: from + nl + 1 });
			} catch {}
			pos = nl + 1;
		}
		return { list, next: from + pos };
	} finally {
		fs.closeSync(fd);
	}
}

// ---- receiving ------------------------------------------------------------------------------------------------

function recordStranger(m: any): void {
	const who = { id: m.from.id, username: m.from.username ?? null, name: [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") };
	const file = path.join(STATE, "unlisted.jsonl");
	const seen = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (!seen.includes(`"id":${who.id},`)) fs.appendFileSync(file, `${JSON.stringify({ ...who, at: new Date().toISOString() })}\n`, { mode: 0o600 });
	log(`ignored a message from an unlisted sender: ${who.id}${who.username ? ` (@${who.username})` : ""}. To let them in: pp channel ${env("AGENT")} telegram allow ${who.id}`);
}

async function handle(u: any, allowed: string[]): Promise<void> {
	const m = u.message;
	if (!m?.from || m.chat?.type !== "private") return; // only private chats; groups are not supported yet
	if (!allowed.includes(String(m.from.id))) return recordStranger(m);
	const attachments: string[] = [];
	const notes: string[] = [];
	const files: [string, string][] = [];
	if (m.photo?.length) files.push([m.photo.at(-1).file_id, `${u.update_id}-photo.jpg`]);
	for (const k of ["document", "voice", "audio", "video", "video_note"]) {
		const f = m[k];
		if (f?.file_id) files.push([f.file_id, `${u.update_id}-${f.file_name ?? `${k}${extension(f.mime_type)}`}`]);
	}
	for (const [id, name] of files) {
		try {
			attachments.push(await download(id, name));
		} catch (err) {
			notes.push(`(an attachment could not be saved: ${(err as Error).message})`);
		}
	}
	// A forwarded message was written by someone else: said so, so that it never reads as the sender's own request.
	const origin = forwardedFrom(m);
	const body = [...(origin ? [`(Forwarded: written by ${origin}, not by the sender.)`] : []), m.text ?? m.caption ?? "", ...notes].filter(Boolean).join("\n");
	if (!body && !attachments.length) return; // stickers, locations...: nothing to pass on
	const id = `tg-${u.update_id}`;
	const conversation = `telegram:${m.chat.id}`; // one chat is one conversation: the agent answers it in a run of its own
	submit({
		id,
		// Several guests share one agent: the first line says who wrote, and where an answer can be sent later.
		text: `From: ${whoOf(m.from)} · ${conversation}\n\n${body}`,
		...(attachments.length ? { attachments } : {}),
		from: { message: m.message_id }, // ours, echoed back on the answer: the message to quote
		conversation,
	});
}

/** Who wrote, for the agent: the name the person gave Telegram, which anyone can choose, and the id, which is theirs. */
/** Who wrote a forwarded message, as far as Telegram says: a name in quotes (chosen by them), or "someone". */
function forwardedFrom(m: any): string | undefined {
	const o = m.forward_origin;
	const raw = o ? (o.sender_user ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ") : (o.sender_user_name ?? o.chat?.title ?? "")) : m.forward_from ? [m.forward_from.first_name, m.forward_from.last_name].filter(Boolean).join(" ") : (m.forward_sender_name ?? m.forward_from_chat?.title);
	if (raw === undefined && !o) return undefined;
	const name = String(raw ?? "").replace(/["“”«»()[\]{}\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
	return name ? `"${name}"` : "someone";
}

/** Who wrote, for the agent's "From:" line. The name is chosen by whoever writes: it comes in quotes, without quotes,
 * brackets or line ends of its own, so it can never pass for what this channel writes ("the owner", an id). */
export const whoOf = (f: any, ownerId = owner()) => {
	const name = [f.first_name, f.last_name].filter(Boolean).join(" ").replace(/["“”«»()[\]{}\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64) || "someone";
	const handle = typeof f.username === "string" && /^\w{1,32}$/.test(f.username) ? `, @${f.username}` : "";
	return `${String(f.id) === ownerId ? "the owner, " : ""}"${name}" (Telegram user ${f.id}${handle})`;
};

const extension = (mime?: string) => (mime ? `.${mime.split("/")[1]?.split(";")[0] ?? "bin"}` : "");

async function receive(): Promise<never> {
	for (let failures = 0; ; ) {
		try {
			const updates = await call("getUpdates", { offset: state.offset, timeout: 30, allowed_updates: ["message"] }, 45_000);
			failures = 0;
			for (const u of updates) {
				const allowed = guests();
				if (!allowed) break; // the guest list cannot be read: confirm nothing, fetch these again later
				await handle(u, allowed);
				// The update is in the port (or deliberately ignored): only now confirm it to Telegram.
				state.offset = u.update_id + 1;
				saveState();
			}
		} catch (err) {
			if (err instanceof TelegramError && err.code === 401) {
				log(`Telegram refuses the bot token: store a valid one (pp secret set ${env("AGENT")} telegram-token), then: pp restart ${env("AGENT")}`);
				process.exit(3);
			}
			const wait = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : Math.min(60_000, 1000 * 2 ** failures++);
			log(`receiving failed (${(err as Error).message}); retrying in ${Math.round(wait / 1000)} s`);
			await sleep(wait);
		}
		if (unreadable) await sleep(5000);
	}
}

// ---- "typing..." while the agent works on a message from a chat -----------------------------------------------

const working = new Map<string, { ids: Set<string>; since: number }>(); // chat -> messages the agent took, not settled
const TYPING_MAX_MS = 10 * 60_000;

function typing(): void {
	for (const [chat, w] of working) {
		if (Date.now() - w.since > TYPING_MAX_MS) working.delete(chat);
		else call("sendChatAction", { chat_id: chat, action: "typing" }, 10_000).catch(() => {}); // only a courtesy
	}
}
function track(e: any): void {
	// The agent took in a message of one of our chats (its refs say which), on the guest list.
	const chat = e.type === "taken" ? (e.refs ?? []).map((r: any) => String(r.conversation ?? "")).find((c: string) => c.startsWith("telegram:"))?.slice(9) : undefined;
	if (chat && guests()?.includes(chat)) {
		const w = working.get(chat) ?? { ids: new Set<string>(), since: Date.now() };
		w.ids.add(e.id);
		working.set(chat, w);
		typing();
	}
	if (e.type === "settled" || e.type === "error")
		for (const r of e.refs ?? []) for (const [chat, w] of working) if (w.ids.delete(r.id) && !w.ids.size) working.delete(chat);
	if ((e.type === "stopped" || e.type === "restarted") && !e.channel) working.clear(); // the agent went away
}

// ---- sending --------------------------------------------------------------------------------------------------

/**
 * Split a long reply into pieces Telegram accepts. Each piece ends at the last paragraph break that leaves it at least
 * half full; failing that a line break, then the end of a sentence, then a space; only then mid-word.
 */
export function split(text: string, limit = LIMIT): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const head = rest.slice(0, limit + 1);
		const sentence = Math.max(...[". ", "! ", "? ", ".\n", "… "].map((p) => head.lastIndexOf(p, limit - p.length))) + 1;
		const choices = [head.lastIndexOf("\n\n", limit), head.lastIndexOf("\n", limit), sentence > 0 ? sentence : -1, head.lastIndexOf(" ", limit)];
		let cut = choices.find((c) => c >= limit / 2) ?? limit;
		const code = rest.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut--; // never cut a character in two
		parts.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) parts.push(rest);
	return parts;
}

const lastSent = new Map<string, number>();
let lastAny = 0;
/**
 * Send one piece. Telegram's own behaviour lives here, not in the core: Markdown shown as Telegram formatting,
 * a reply quoting the message it answers, and Telegram's limits. If Telegram refuses the formatting, the piece
 * goes again as plain text, so a formatting mistake never loses a reply.
 */
async function sendOne(chat: string, text: string, replyTo?: number, format = true): Promise<void> {
	let formatted = format;
	for (let attempt = 0; ; attempt++) {
		// Telegram's limits: about one message per second in a chat, about thirty per second overall.
		const wait = Math.max((lastSent.get(chat) ?? 0) + 1050 - Date.now(), lastAny + 40 - Date.now(), 0);
		if (wait) await sleep(wait);
		try {
			await call("sendMessage", {
				chat_id: chat,
				...(formatted ? { text: toHtml(text), parse_mode: "HTML" } : { text }),
				link_preview_options: { is_disabled: true },
				...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
			});
			lastSent.set(chat, Date.now());
			lastAny = Date.now();
			return;
		} catch (err) {
			if (err instanceof TelegramError && err.code === 429) {
				log(`Telegram asks to slow down; waiting ${err.retryAfter ?? 5} s`);
				await sleep((err.retryAfter ?? 5) * 1000);
				continue;
			}
			if (err instanceof TelegramError && err.code === 400 && formatted) {
				log(`Telegram refused the formatting (${err.message}); sending this piece as plain text`);
				formatted = false;
				continue;
			}
			if (err instanceof TelegramError && err.code >= 400 && err.code < 500) {
				log(`could not send to chat ${chat}, skipping this reply: ${err.message}`);
				return;
			}
			const delay = Math.min(60_000, 1000 * 2 ** attempt);
			log(`sending failed (${(err as Error).message}); retrying in ${Math.round(delay / 1000)} s`);
			await sleep(delay);
		}
	}
}

const told = new Set<string>(); // messages whose sender was already told of an error (once is enough)

async function send(): Promise<never> {
	for (;;) {
		const { list, next } = readEvents(state.events!);
		let held = false;
		for (const { e, after } of list) {
			track(e);
			// A reply; trouble with a message that will be tried again (error); the end of a run without a reply (settled).
			const note = e.type === "error" ? `⚠️ ${String(e.error).slice(0, 500)}` : e.type === "settled" && e.error ? `⚠️ The agent could not answer: ${String(e.error).slice(0, 500)}` : undefined;
			if (e.type === "message" || note) {
				// Each Telegram chat this event belongs to, and the last of its messages it answers (to quote it).
				const chats = new Map<string, { replyTo?: number; ids: string[] }>();
				for (const r of e.refs ?? [])
					if (typeof r.conversation === "string" && r.conversation.startsWith("telegram:")) {
						const chat = r.conversation.slice("telegram:".length);
						const c = chats.get(chat) ?? { ids: [] };
						chats.set(chat, { replyTo: r.from?.message ?? c.replyTo, ids: [...c.ids, String(r.id)] });
					}
				const allowed = chats.size ? guests() : [];
				if (!allowed) {
					held = true; // the guest list cannot be read: send nothing now, skip nothing
					break;
				}
				for (const [chat, c] of chats) {
					// Only to people on the guest list (in a private chat, the chat id is the person's id).
					if (!allowed.includes(chat)) {
						log(`not sending to chat ${chat}: it is not on the guest list`);
						continue;
					}
					if (note) {
						const key = (id: string) => `${e.type}:${id}`; // each kind of note once per message
						if (c.ids.every((id) => told.has(key(id)))) continue;
						for (const id of c.ids) told.add(key(id));
						await sendOne(chat, note, c.replyTo, false);
						continue;
					}
					const pieces = closeFences(split(String(e.text), LIMIT - 20)); // room to close and reopen a code block
					for (let i = 0; i < pieces.length; i++) await sendOne(chat, pieces[i], i === 0 ? c.replyTo : undefined);
				}
			}
			state.events = after; // an event is marked done once it is handled, so a restart never sends it again
			saveState();
		}
		if (!held && state.events !== next) {
			state.events = next;
			saveState();
		}
		await sleep(held ? 5000 : 300);
	}
}

// ---- setup: a bot token, then the first person to let in ------------------------------------------------------

/** One answer in the terminal. A paste is taken whole, line ends included (BotFather's message is several lines): the
 * terminal marks it (bracketed paste, turned on while asking), or, in a terminal without it, it comes in one piece. */
const ask = (q: string, hidden = false): Promise<string> =>
	new Promise((resolve) => {
		process.stdout.write(q);
		const stdin = process.stdin;
		if (!stdin.isTTY) {
			let buf = "";
			const onData = (c: Buffer) => {
				buf += c.toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl < 0) return;
				stdin.off("data", onData);
				stdin.pause();
				process.stdout.write("\n");
				resolve(buf.slice(0, nl).trim());
			};
			stdin.on("data", onData).resume();
			return;
		}
		const done = () => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write("\x1b[?2004l");
		};
		stdin.setRawMode(true);
		process.stdout.write("\x1b[?2004h");
		stdin.resume();
		let value = "";
		let pasting = false;
		let held = ""; // the start of a mark cut off at the end of a read: it comes whole with the next one
		const onData = (b: Buffer) => {
			let chunk = held + b.toString("utf8");
			held = /\x1b(\[[0-9;]*)?$/.exec(chunk)?.[0] ?? "";
			chunk = chunk.slice(0, chunk.length - held.length);
			const whole = /[\r\n][\s\S]*\S/.test(chunk); // text after a line end: a paste, in a terminal that does not mark it
			for (const k of chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/gu) ?? []) {
				if (k === "\x1b[200~" || k === "\x1b[201~") {
					pasting = k === "\x1b[200~";
					continue;
				}
				if (k === "\u0003") {
					done();
					console.log("\n  Skipped: Telegram stays as it was. Later: pp setup");
					process.exit(3); // Ctrl+C skips this step, as during the wait
				}
				if ((k === "\r" || k === "\n") && !pasting && !whole) {
					done();
					process.stdout.write(hidden ? "\n" : `${value}\n`);
					return resolve(value.trim());
				}
				if (k === "\u007f" || k === "\b") value = value.slice(0, -1);
				else if (k === "\r" || k === "\n") value += "\n";
				else if (k.length === 1 && k >= " ") {
					value += k;
					if (!hidden) process.stdout.write(k);
				}
			}
			// A secret is never shown, but its arrival is: a few dots, then how much came. A paste that did not arrive, or
			// arrived twice, is seen at once.
			if (hidden) {
				const n = value.replace(/\s/g, "").length;
				process.stdout.write(`\r\x1b[K${q}${"•".repeat(Math.min(n, 12))}${n > 12 ? ` ${n} characters` : ""}`);
			}
		};
		stdin.on("data", onData);
	});

/** The bot token in what was pasted: BotFather's whole message, or the token alone. */
export function findToken(text: string): string | undefined {
	const m = /\b\d{5,}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/.exec(text);
	if (!m) return undefined;
	// Pasted twice in a row, the number of the second copy runs into the end of the first: the first copy is the token.
	const [id, rest] = m[0].split(":");
	const first = rest.endsWith(id) ? `${id}:${rest.slice(0, -id.length)}` : undefined;
	return first && text.startsWith(`${first}${first}`, m.index) ? first : m[0];
}

/** `pp setup` runs this before the channel starts: it stores the bot's token and lets the first person in. */
async function setup(): Promise<void> {
	const tokenFile = path.join(SECRETS, "telegram-token");
	const refusal = (err: unknown) => err instanceof TelegramError && (err.code === 401 || err.code === 404);
	let me: any;
	if (fs.existsSync(tokenFile))
		me = await call("getMe", {}, 15_000).catch((err) => {
			if (refusal(err)) console.log("  ! Telegram refuses the token stored earlier: it was replaced or revoked. A new one is needed.");
			return undefined;
		});
	if (me) console.log(`  ✔ bot @${me.username} is set up`);
	while (!me) {
		console.log("  In Telegram, open a chat with @BotFather and send /newbot. Choose a name; BotFather answers with a token.");
		console.log("  For a bot you already have, copy its current token from @BotFather: an older one stops working once a new one is made.");
		const pasted = await ask("  ? Paste the token, then Enter (empty to skip): ", true);
		if (!pasted) {
			console.log("  Skipped: Telegram stays off. Later: pp setup");
			process.exit(3);
		}
		const tok = findToken(pasted);
		if (!tok) {
			console.log("  ✘ That is not a bot token. A token is one line like 123456789:AAH…, in BotFather's message: copy it, or the whole message.");
			continue;
		}
		// Checked with Telegram before it is kept: a token Telegram refuses is never stored.
		trying = tok;
		me = await call("getMe", {}, 15_000).catch((err) => {
			const why = refusal(err)
				? `Telegram refuses this token (${tok.length} characters, ending in ${tok.slice(-4)}): it is mistyped, or a newer one replaced it`
				: `Telegram could not be reached (${(err as Error).message})`;
			console.log(`  ✘ ${why}. Nothing was stored. Try again.`);
			return undefined;
		});
		trying = undefined;
		if (!me) continue;
		fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
		fs.writeFileSync(tokenFile, `${tok}\n`, { mode: 0o600 });
		fs.chmodSync(tokenFile, 0o600);
		console.log(`  ✔ bot @${me.username} answers; its token is stored`);
	}
	if (guests()?.length) {
		console.log(`  ✔ allowed: ${guests()!.join(", ")}`);
		return;
	}
	console.log(`  Now write any message to @${me.username} from your own Telegram account. Waiting... (Ctrl+C to skip this step)`);
	const skip = () => {
		console.log("\n  Skipped: nobody allowed yet. Later: write to the bot, then pp channel telegram who");
		process.exit(3);
	};
	process.on("SIGINT", skip);
	// The channel is not running yet, so this is the only reader. It never passes an offset, which would confirm the
	// updates to Telegram: once the channel starts, it reads the same message, and the agent answers it. Messages
	// written before this step began are not offered: only someone writing now can be let in.
	const since = Math.floor(Date.now() / 1000) - 5;
	const until = Date.now() + 10 * 60_000;
	const seen = new Set<number>();
	let told = "";
	while (Date.now() < until) {
		let ups: any[] = [];
		try {
			ups = await call("getUpdates", { timeout: 25, allowed_updates: ["message"] }, 35_000);
		} catch (err) {
			const why =
				err instanceof TelegramError && err.code === 409 ? "another program reads this bot, or a webhook is set (Telegram allows one reader)" : (err as Error).message;
			if (why !== told) console.log(`  ! Telegram: ${why}; trying again...`);
			told = why;
			await sleep(err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : 5000);
			continue;
		}
		const fresh = ups.filter((u) => !seen.has(u.update_id));
		if (!fresh.length) await sleep(ups.length ? 2000 : 0); // only old ones pending: Telegram answers at once, so wait
		for (const u of fresh) {
			seen.add(u.update_id);
			const m = u.message;
			if (!m?.from || m.from.is_bot || m.chat?.type !== "private" || (m.date ?? 0) < since) continue;
			const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || "someone";
			console.log(`  ✔ ${who}${m.from.username ? ` (@${m.from.username})` : ""}, Telegram user ${m.from.id}, wrote: "${String(m.text ?? "(an attachment)").slice(0, 60)}"`);
			// No default: Enter alone neither lets a stranger in nor refuses the owner.
			let yes: boolean | undefined;
			while (yes === undefined) {
				const a = (await ask("  ? Is that you? Let them talk to your agent? [y/n] ")).toLowerCase();
				if (/^(y|yes|o|oui)$/.test(a)) yes = true;
				else if (/^(n|no|non)$/.test(a)) yes = false;
				else console.log("    Type y or n, then Enter.");
			}
			if (yes) {
				writeGuests([...new Set([...(guests() ?? []), String(m.from.id)])]);
				setOwner(String(m.from.id)); // said "that is me" at the terminal: the owner (the first one stays)
				console.log(`  ✔ Telegram user ${m.from.id} is allowed. Others who write are refused until you allow them: pp channel telegram who`);
				process.off("SIGINT", skip);
				return;
			}
			console.log("  Not allowed. Waiting for another message... (Ctrl+C to skip this step)");
		}
	}
	console.log("  Nobody was allowed within 10 minutes. Later: write to the bot, then pp channel telegram who, and allow <id>");
	process.exit(3);
}

// ---- commands -------------------------------------------------------------------------------------------------

async function main(args: string[]): Promise<void> {
	const [cmd, arg] = args;
	if (cmd === "who") {
		const file = path.join(STATE, "unlisted.jsonl");
		const rows = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
		if (!rows.length) console.log("Nobody unlisted has written yet. Send a message to the bot from Telegram, then run this again.");
		for (const r of rows) console.log(`${r.id}  ${r.username ? `@${r.username}  ` : ""}${r.name}  (first message ${r.at})`);
		console.log(`Allowed: ${guests()?.join(", ") || "nobody"}`);
		return;
	}
	if (cmd === "allow" || cmd === "deny") {
		if (!arg || !/^\d+$/.test(arg)) throw new Error(`usage: pp channel <agent> telegram ${cmd} <numeric Telegram user id>`);
		const now = guests();
		if (!now) throw new Error(`the guest list ${allowFile()} cannot be read; fix or delete it first`);
		const ids = writeGuests(cmd === "allow" ? [...new Set([...now, arg])] : now.filter((i) => i !== arg));
		console.log(`Allowed: ${ids.join(", ") || "nobody"} (it applies at once)`);
		return;
	}
	if (cmd === "owner") {
		// Typed at the terminal: who the owner is (the person whose messages the agent may take settings changes from).
		if (!arg) {
			console.log(`Owner: ${owner() ?? "nobody yet"}${owner() ? "" : `. To set it: pp channel ${env("AGENT")} telegram owner <your numeric Telegram user id> (see: who)`}`);
			return;
		}
		if (!/^\d+$/.test(arg)) throw new Error(`usage: pp channel <agent> telegram owner <numeric Telegram user id>`);
		if (!guests()?.includes(arg)) throw new Error(`${arg} is not on the guest list: allow it first (pp channel ${env("AGENT")} telegram allow ${arg})`);
		fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
		fs.writeFileSync(ownerFile(), `${arg}\n`, { mode: 0o600 });
		console.log(`Owner: ${arg} (it applies at once)`);
		return;
	}
	if (cmd === "check") {
		// Run by `pp doctor`: one line per check, "ok", "note" or "FAIL", then the text.
		let tok = "";
		try {
			tok = fs.readFileSync(path.join(SECRETS, "telegram-token"), "utf8").trim();
		} catch {}
		if (!tok) console.log(`FAIL  bot token missing: pp secret set ${env("AGENT")} telegram-token`);
		else
			try {
				const me = await call("getMe", {}, 10_000);
				console.log(`ok    bot @${me.username} answers`);
			} catch (err) {
				if (err instanceof TelegramError && err.code === 401) console.log("FAIL  Telegram refuses the bot token: store a new one");
				else console.log(`note  bot token stored, but Telegram could not be reached to check it (${(err as Error).message})`);
			}
		const allow = guests();
		if (!allow) console.log(`FAIL  the guest list ${allowFile()} cannot be read`);
		else console.log(allow.length ? `ok    guest list: ${allow.length} allowed` : `note  nobody allowed yet (deny by default): write to the bot, then pp channel ${env("AGENT")} telegram who`);
		return;
	}
	if (cmd === "setup") return setup();
	if (cmd) throw new Error(`unknown command "${cmd}": use setup, who, allow <id>, deny <id> or check`);
	fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
	state = loadState();
	if (state.events === undefined) {
		state.events = fs.existsSync(eventsFile()) ? fs.statSync(eventsFile()).size : 0; // a first start: only what comes next
		saveState();
	}
	const me = await call("getMe", {});
	const g = guests();
	log(`connected as @${me.username}; ${g?.length ? `obeying ${g.join(", ")}` : g ? "obeying nobody yet (deny by default)" : "the guest list cannot be read"}`);
	setInterval(typing, 4500).unref();
	await Promise.race([receive(), send()]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	main(process.argv.slice(2)).catch((err) => {
		log(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
