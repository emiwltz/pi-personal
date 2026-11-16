#!/usr/bin/env node
// The Telegram channel: a Pi-personal side program. It talks to Telegram by long polling (no public address needed)
// and to the agent through the port only (docs/port.md); it imports nothing from Pi-personal's core.
//
// Deny by default: it obeys only the Telegram user ids on its guest list (allow.json in its private state
// folder, outside the agent's working folder). With no list it obeys nobody. Unlisted senders are recorded, never added.
//
//   run (started by Pi-personal's keeper):  node telegram.ts
//   who wrote and is not listed:        pi-personal channel <agent> telegram who
//   add someone to the list:            pi-personal channel <agent> telegram allow <user id>
//   check the token and the list:       pi-personal channel <agent> telegram check   (pi-personal doctor runs it)
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

function token(): string {
	const file = path.join(SECRETS, "telegram-token");
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		log(`no bot token: store it with "pi-personal secret set ${env("AGENT")} telegram-token" (it is read from standard input)`);
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
	log(`ignored a message from an unlisted sender: ${who.id}${who.username ? ` (@${who.username})` : ""}. To let them in: pi-personal channel ${env("AGENT")} telegram allow ${who.id}`);
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
	const body = [m.text ?? m.caption ?? "", ...notes].filter(Boolean).join("\n");
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
const whoOf = (f: any) =>
	`${[f.first_name, f.last_name].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || "someone"} (Telegram user ${f.id}${f.username ? `, @${f.username}` : ""})`.slice(0, 200);

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
				log(`Telegram refuses the bot token: store a valid one (pi-personal secret set ${env("AGENT")} telegram-token), then: pi-personal restart ${env("AGENT")}`);
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
		if (!arg || !/^\d+$/.test(arg)) throw new Error(`usage: pi-personal channel <agent> telegram ${cmd} <numeric Telegram user id>`);
		const now = guests();
		if (!now) throw new Error(`the guest list ${allowFile()} cannot be read; fix or delete it first`);
		const ids = writeGuests(cmd === "allow" ? [...new Set([...now, arg])] : now.filter((i) => i !== arg));
		console.log(`Allowed: ${ids.join(", ") || "nobody"} (it applies at once)`);
		return;
	}
	if (cmd === "check") {
		// Run by `pi-personal doctor`: one line per check, "ok", "note" or "FAIL", then the text.
		let tok = "";
		try {
			tok = fs.readFileSync(path.join(SECRETS, "telegram-token"), "utf8").trim();
		} catch {}
		if (!tok) console.log(`FAIL  bot token missing: pi-personal secret set ${env("AGENT")} telegram-token`);
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
		else console.log(allow.length ? `ok    guest list: ${allow.length} allowed` : `note  nobody allowed yet (deny by default): write to the bot, then pi-personal channel ${env("AGENT")} telegram who`);
		return;
	}
	if (cmd) throw new Error(`unknown command "${cmd}": use who, allow <id>, deny <id> or check`);
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
