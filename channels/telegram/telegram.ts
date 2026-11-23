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
// sender, splitting at 4,096 characters, files the agent sends uploaded by kind, Telegram's rates, the owner's
// commands (/stop, /new, /login...), run through the command Pi-Personal gives its channels (PI_PERSONAL_REMOTE), and
// the agent's questions, shown to its owner with a command to tap for each answer (/answer_<id>_<n>).
import { spawn } from "node:child_process";
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
const UPLOAD_MAX = 50 * 1024 * 1024; // the largest file a bot may send
const KEEP_FILES_MS = 30 * 86_400_000; // how long files received are kept (removeOldFiles)
const REMOTE_MAX_MS = 120_000; // how long an owner's command may run (remote)

const log = (text: string) => process.stderr.write(`${new Date().toISOString()} [telegram] ${text}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- settings and state -------------------------------------------------------------------------------------

interface Settings {
	apiBase?: string; // another Bot API server, such as a local one; default https://api.telegram.org
}
const SETTINGS: Settings = JSON.parse(env("SETTINGS") || "{}"); // this channel's object in pi-personal.json, read at its start

const allowFile = () => path.join(STATE, "allow.json");
const tokenFile = () => path.join(SECRETS, "telegram-token");
/** The name a person gave Telegram (first and last), as it is: chosen by them. */
const nameOf = (u: any): string => [u.first_name, u.last_name].filter(Boolean).join(" ");
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
/** The owner: the Telegram user who said "that is me" in the setup, at the terminal. Their messages say so (`sender`),
 * and only theirs: the agent changes its settings for its owner only. */
const ownerFile = () => path.join(STATE, "owner");
function owner(): string | undefined {
	try {
		return fs.readFileSync(ownerFile(), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
function setOwner(id: string): void {
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
	questions?: string[]; // the agent's questions shown to the owner and not closed yet: told when they close
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
	try {
		return fs.readFileSync(tokenFile(), "utf8").trim();
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

/** Never let the token reach a log: errors from fetch can quote the URL, which holds it. (An empty token hides nothing.) */
const hide = (text: string) => {
	const t = token();
	return t ? text.replaceAll(t, "<token>") : text;
};
const redact = (err: unknown) => new Error(hide(String((err as Error)?.message ?? err)));

/** One Bot API call: JSON, or a multipart form for an upload. */
async function call(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<any> {
	const base = SETTINGS.apiBase ?? "https://api.telegram.org";
	const form = body instanceof FormData;
	let res: Response;
	try {
		res = await fetch(`${base}/bot${token()}/${method}`, {
			method: "POST",
			...(form ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		throw redact(err);
	}
	const data = (await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }))) as any;
	if (!data.ok) throw new TelegramError(data.error_code ?? res.status, hide(String(data.description ?? "unknown")), data.parameters?.retry_after);
	return data.result;
}

async function download(fileId: string, name: string): Promise<string> {
	const f = await call("getFile", { file_id: fileId });
	if (!f.file_path) throw new Error("Telegram gave no file path (files over 20 MB cannot be downloaded by bots)");
	const base = SETTINGS.apiBase ?? "https://api.telegram.org";
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

/** Files received for the agent are passed on as paths: what the agent wants to keep, it copies. The others go after
 * 30 days, so the folder does not grow forever. */
function removeOldFiles(): void {
	let names: string[] = [];
	try {
		names = fs.readdirSync(FILES);
	} catch {
		return; // nothing received yet
	}
	for (const n of names)
		try {
			const f = path.join(FILES, n);
			const st = fs.lstatSync(f);
			if (st.isFile() && Date.now() - st.mtimeMs > KEEP_FILES_MS) fs.rmSync(f);
		} catch {} // removed meanwhile: never a reason not to start
}

// ---- receiving ------------------------------------------------------------------------------------------------

function recordStranger(m: any): void {
	const who = { id: m.from.id, username: m.from.username ?? null, name: nameOf(m.from) };
	const file = path.join(STATE, "unlisted.jsonl");
	const seen = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	if (!seen.includes(`"id":${who.id},`)) fs.appendFileSync(file, `${JSON.stringify({ ...who, at: new Date().toISOString() })}\n`, { mode: 0o600 });
	log(`ignored a message from an unlisted sender: ${who.id}${who.username ? ` (@${who.username})` : ""}. To let them in: pp channel ${env("AGENT")} telegram allow ${who.id}`);
}

async function handle(u: any, allowed: string[]): Promise<void> {
	await menu();
	if (u.callback_query) return tapped(u, allowed);
	const m = u.message;
	if (!m?.from || m.chat?.type !== "private") return; // only private chats; groups are not supported yet
	if (!allowed.includes(String(m.from.id))) return recordStranger(m);
	const c = commandOf(m.text);
	if (c) return obey(u, m, c); // never passed to the agent, whoever sent it
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
		text: body,
		// Several guests share one agent: who wrote goes beside the text, never in it. The core writes it above the text
		// for the agent, where nothing a person typed can pass for it.
		sender: senderOf(m.from),
		...(attachments.length ? { attachments } : {}),
		from: { message: m.message_id }, // ours, echoed back on the answer: the message to quote
		conversation,
	});
}

/** Who wrote a forwarded message, as far as Telegram says: a name in quotes (chosen by them), or "someone". */
function forwardedFrom(m: any): string | undefined {
	const o = m.forward_origin;
	const raw = o ? (o.sender_user ? nameOf(o.sender_user) : (o.sender_user_name ?? o.chat?.title ?? "")) : m.forward_from ? nameOf(m.forward_from) : (m.forward_sender_name ?? m.forward_from_chat?.title);
	if (raw === undefined && !o) return undefined;
	const name = String(raw ?? "").replace(/["“”«»()[\]{}\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 64);
	return name ? `"${name}"` : "someone";
}

/** Who wrote, as the port's `sender`. The name and the handle are chosen by whoever writes and can change: they go
 * together, as the name. The id is Telegram's own number for the account and nothing else. `owner` only for the owner. */
export const senderOf = (f: any, ownerId = owner()): { name?: string; id: string; owner?: boolean } => {
	const handle = typeof f.username === "string" && /^\w{1,32}$/.test(f.username) ? `@${f.username}` : "";
	const name = [nameOf(f), handle].filter(Boolean).join(" ");
	return { ...(name ? { name } : {}), id: `Telegram user ${f.id}`, ...(String(f.id) === ownerId ? { owner: true } : {}) };
};

const extension = (mime?: string) => (mime ? `.${mime.split("/")[1]?.split(";")[0] ?? "bin"}` : "");

async function receive(): Promise<never> {
	for (let failures = 0; ; ) {
		try {
			const updates = await call("getUpdates", { offset: state.offset, timeout: 30, allowed_updates: ["message", "callback_query"] }, 45_000);
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

// ---- the owner's commands -----------------------------------------------------------------------------------------

/** What each command runs: the words given to Pi-Personal's `remote` command. */
const COMMANDS: Record<string, string[]> = {
	stop: ["interrupt"],
	new: ["new"],
	model: ["model"],
	thinking: ["thinking"],
	status: ["status"],
	restart: ["restart"],
	login: ["login"],
	secret: ["secret", "set"],
	kit: ["kit"],
	answer: ["answer"],
	help: [],
};
/** What each command's reply starts with, so that a reply is told from the agent's own at a glance. */
const ICON: Record<string, string> = { stop: "⏹", new: "✨", model: "🧠", thinking: "💭", status: "📊", restart: "🔄", login: "🔑", secret: "🔒", kit: "🧰", answer: "✅" };
const HELP = [
	"📖 **Commands** (only you can use them)",
	"",
	"**The agent**",
	"/stop — stop what it is doing",
	"/new — start a fresh conversation",
	"/status — how it is doing",
	"/restart — restart it",
	"",
	"**Settings** (tap to choose)",
	"/model — its model",
	"/thinking — how much it thinks",
	"",
	"**Keys** (your message is deleted at once)",
	"/login `provider` `key` — an API key",
	"/secret `name` `value` — a secret for its tools",
	"",
	"A question from the agent comes with buttons to answer it. /kit runs the kit's commands, when one is installed. Anything else goes to the agent.",
].join("\n");
/** The menu Telegram shows when the owner types "/": in the owner's chat only, guests see none. */
const MENU = [
	["stop", "Stop what it is doing"],
	["new", "Start a fresh conversation"],
	["status", "How it is doing"],
	["model", "Choose its model"],
	["thinking", "Choose how much it thinks"],
	["restart", "Restart it"],
	["login", "Give it an API key: /login provider key"],
	["secret", "Store a secret: /secret name value"],
	["help", "All commands"],
].map(([command, description]) => ({ command, description }));
let menuFor: string | undefined; // the owner Telegram shows the menu to

/** Show the menu to the owner, and take it from one who no longer is: the owner can change while the channel runs. */
async function menu(): Promise<void> {
	const me = owner();
	if (me === menuFor) return;
	try {
		if (menuFor) await call("deleteMyCommands", { scope: { type: "chat", chat_id: Number(menuFor) } });
		if (me) await call("setMyCommands", { commands: MENU, scope: { type: "chat", chat_id: Number(me) } });
		menuFor = me;
	} catch (err) {
		log(`the command menu could not be set (${(err as Error).message}); the commands still work`);
		menuFor = me; // tried once for this owner: no retry on every message
	}
}

/** The command a message is, if it is one: "/stop", "/stop@thebot", then its words. A question's commands carry its
 * id, and an option's number, in the word itself, so that Telegram makes them tappable: "/answer_<id>_<n>". */
export function commandOf(text: unknown): { word: string; rest: string; parts: string[] } | undefined {
	const m = /^\/([A-Za-z]+)((?:_[A-Za-z0-9]+)*)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(typeof text === "string" ? text.trim() : "");
	const word = m?.[1].toLowerCase();
	const parts = m?.[2] ? m[2].split("_").slice(1) : [];
	if (!word || !Object.hasOwn(COMMANDS, word) || (parts.length && word !== "answer")) return undefined;
	return { word, rest: (m![3] ?? "").trim(), parts };
}

/**
 * Obey a command, only from the owner, in a message of their own: a guest's, or a forward of someone else's words, is
 * refused in one line. /login and /secret take their value in the same message, so that no waiting state can turn a
 * later message into one for the model; that message is deleted from the chat before anything else, and the value
 * goes on standard input only: never in an argument, the port, a log or this channel's state, and never repeated.
 */
async function obey(u: any, m: any, c: { word: string; rest: string; parts: string[] }): Promise<void> {
	const chat = String(m.chat.id);
	// A message deleted from the chat is not quoted.
	const say = (text: string, quote = true) => sendOne(chat, text, quote ? m.message_id : undefined, false);
	if (String(m.from.id) !== owner() || forwardedFrom(m) !== undefined) return say(`/${c.word} is obeyed only from this agent's owner, in a message of their own.`);
	if (c.word === "help") return sendOne(chat, HELP, m.message_id);
	if (c.word === "login" || c.word === "secret") {
		const form = `Send it in one message: /${c.word} ${c.word === "login" ? "<provider> <key>" : "<name> <value>"}. That message is deleted from this chat at once.`;
		if (!c.rest) return say(form);
		// Any word after it may be the value, given without its name: deleted first, whatever the form.
		const gone = await call("deleteMessage", { chat_id: m.chat.id, message_id: m.message_id }).then(
			() => true,
			() => false,
		);
		const warn = gone ? "" : "⚠️ Your message could not be deleted from this chat: delete it yourself.\n";
		const v = /^(\S+)\s+([\s\S]+)$/.exec(c.rest);
		if (!v) return say(`${warn}${form}`, false);
		const said = await remote([...COMMANDS[c.word], v[1]], u.update_id, v[2].trim());
		return say(`${warn}${shown(c.word, said)}`, false);
	}
	if (c.word === "answer") {
		const [id, n] = c.parts;
		const text = n ?? c.rest;
		if (!id || !text || c.parts.length > 2) return say("Tap the command shown under the agent's question, or send: /answer_<id> <your text>.");
		answeredHere.add(id); // before it runs: its `answered` may be read first
		const said = await remote([...COMMANDS[c.word], id, ...text.split(/\s+/)], u.update_id);
		// Refused (no such option, closed, no result): a later answer from elsewhere is told to the owner.
		if (said !== `answered ${id}`) answeredHere.delete(id);
		return say(said === `answered ${id}` ? "✅ Answered." : shown(c.word, said));
	}
	const said = await remote([...COMMANDS[c.word], ...(c.rest ? c.rest.split(/\s+/) : [])], u.update_id);
	// Without a value, a setting comes with what may be chosen (its last line, "choose: ..."): buttons to tap.
	const choose = /\nchoose: (.+)$/.exec(said);
	if ((c.word === "model" || c.word === "thinking") && !c.rest && !said.startsWith("⚠️")) {
		const now = choose ? said.slice(0, choose.index) : said;
		const title = c.word === "model" ? "Model" : "Thinking";
		const options = choose ? choices(c.word, now, choose[1].split(" ")) : [];
		const text = `${ICON[c.word]} **${title}**: ${now.startsWith("not set") ? now.replace(/^not set: /, "not set (") + ")" : `\`${now}\``}${options.length ? "\nTap to change it:" : ""}`;
		return sendOne(chat, text, m.message_id, true, options.length ? options : undefined);
	}
	return say(shown(c.word, said));
}

/** What a command said, for the chat: its icon, and a capital unless it starts with the agent's name; trouble keeps
 * its warning sign instead. */
function shown(word: string, said: string): string {
	if (said.startsWith("⚠️")) return said;
	const text = said.startsWith(env("AGENT")) ? said : `${said[0]?.toUpperCase() ?? ""}${said.slice(1)}`;
	return `${ICON[word] ?? ""} ${text}`.trim();
}

/** Buttons for a setting's choices, the one in use marked: the thinking levels; for the model, those of the same
 * provider, without the dated copies of a model. Telegram carries at most 64 bytes in a button. */
function choices(word: string, now: string, all: string[]): { text: string; data: string }[][] {
	const provider = now.includes("/") ? now.split("/")[0] : undefined;
	const list = word === "thinking" ? all : all.filter((id) => (!provider || id.startsWith(`${provider}/`)) && !/-\d{8}$/.test(id)).slice(0, 16);
	const buttons = list
		.map((id) => ({ text: `${id === now ? "• " : ""}${provider ? id.slice(provider.length + 1) : id}`, data: `/${word} ${id}` }))
		.filter((b) => Buffer.byteLength(b.data) <= 64);
	const per = word === "thinking" ? 4 : 2;
	return Array.from({ length: Math.ceil(buttons.length / per) }, (_x, i) => buttons.slice(i * per, i * per + per));
}

/** A button tapped (a setting's choice, a question's option): what it carries is a command, obeyed as if the owner
 * had typed it, with the same checks. Its buttons go at once, so that one choice is made once. */
async function tapped(u: any, allowed: string[]): Promise<void> {
	const q = u.callback_query;
	call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {}); // only ends the spinner on the button
	const m = q.message;
	if (!q.from || m?.chat?.type !== "private" || !allowed.includes(String(q.from.id))) return;
	const c = commandOf(q.data);
	const carried = c && (c.word === "answer" ? c.parts.length === 2 : (c.word === "model" || c.word === "thinking") && c.rest);
	if (!carried) return; // only what this channel's buttons carry
	call("editMessageReplyMarkup", { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
	return obey(u, { chat: m.chat, from: q.from, message_id: m.message_id }, c!);
}

/** Run Pi-Personal's `remote` command with these words, `input` on its standard input; what it said, for the chat. Its
 * id for the request is the update's, so a command fetched twice (a restart before its update was confirmed) is done once. */
function remote(words: string[], update: number, input = ""): Promise<string> {
	let command: string[];
	try {
		command = JSON.parse(env("REMOTE"));
	} catch {
		return Promise.resolve("⚠️ This Pi-Personal is too old to take commands from Telegram: pp update, on the machine.");
	}
	return new Promise((resolve) => {
		// A group of its own, so that what it started (a kit's program) is stopped with it when it takes too long.
		const child = spawn(command[0], [...command.slice(1), ...words], { env: { ...process.env, PI_PERSONAL_REMOTE_ID: `tg-${update}` }, stdio: ["pipe", "pipe", "pipe"], detached: true });
		let out = "";
		child.stdout.on("data", (b) => (out += b));
		child.stderr.on("data", (b) => (out += b));
		child.stdin.on("error", () => {}); // it may end before reading its input
		child.stdin.end(input);
		// The updates are read one after the other: a command that never ends (the kit runs anything) would keep every
		// later message, /stop included, from being read. The other commands end well within this.
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {} // ended meanwhile
			resolve(`⚠️ It took more than ${REMOTE_MAX_MS / 1000} s and was stopped.`);
		}, REMOTE_MAX_MS);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve(`⚠️ The command could not run: ${err.message}`);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const said = out.trim().slice(0, 3500);
			resolve(code ? `⚠️ ${said || `It failed (exit code ${code}).`}` : said || "Done."); // trouble is marked, for the reply
		});
	});
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
const toldFirst = new Set<string>(); // messages said before they were taken: told without waking the agent, no run follows
function track(e: any): void {
	if (e.type === "message" || e.type === "file") for (const r of e.refs ?? []) toldFirst.add(String(r.id));
	// The agent took in a message of one of our chats (its refs say which), on the guest list.
	const chat = e.type === "taken" && !toldFirst.has(String(e.id)) ? (e.refs ?? []).map((r: any) => String(r.conversation ?? "")).find((c: string) => c.startsWith("telegram:"))?.slice(9) : undefined;
	if (chat && guests()?.includes(chat)) {
		const w = working.get(chat) ?? { ids: new Set<string>(), since: Date.now() };
		w.ids.add(e.id);
		working.set(chat, w);
		typing();
	}
	if (e.type === "settled") for (const r of e.refs ?? []) toldFirst.delete(String(r.id));
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
/** Telegram's limits: about one message per second in a chat, about thirty per second overall. */
async function turn(chat: string): Promise<void> {
	const wait = Math.max((lastSent.get(chat) ?? 0) + 1050 - Date.now(), lastAny + 40 - Date.now(), 0);
	if (wait) await sleep(wait);
}
function sentTo(chat: string): void {
	lastSent.set(chat, Date.now());
	lastAny = Date.now();
}
/**
 * Send one piece. Telegram's own behaviour lives here, not in the core: Markdown shown as Telegram formatting,
 * a reply quoting the message it answers, and Telegram's limits. If Telegram refuses the formatting, the piece
 * goes again as plain text, so a formatting mistake never loses a reply.
 */
async function sendOne(chat: string, text: string, replyTo?: number, format = true, buttons?: { text: string; data: string }[][]): Promise<void> {
	let formatted = format;
	for (let attempt = 0; ; attempt++) {
		await turn(chat);
		try {
			await call("sendMessage", {
				chat_id: chat,
				...(formatted ? { text: toHtml(text), parse_mode: "HTML" } : { text }),
				link_preview_options: { is_disabled: true },
				...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
				...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
			});
			sentTo(chat);
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

/** Each kind of file as Telegram shows it, by its name; anything else goes as a document. */
const KINDS: [RegExp, string, string][] = [
	[/\.(jpe?g|png|webp)$/i, "sendPhoto", "photo"],
	[/\.(ogg|oga)$/i, "sendVoice", "voice"],
	[/\.(mp3|m4a)$/i, "sendAudio", "audio"],
	[/\.mp4$/i, "sendVideo", "video"],
];
const DOCUMENT: [RegExp, string, string] = [/$/, "sendDocument", "document"];

/**
 * Upload a file the agent sent, as its kind. One Telegram refuses as its kind (a photo it cannot process) goes again
 * as a document. What cannot be sent (too large, gone, refused) is told to the sender in one line: a failed upload
 * never holds up the events after it.
 */
async function sendFile(chat: string, file: string, replyTo?: number): Promise<void> {
	const name = path.basename(file);
	const tell = (why: string) => sendOne(chat, `⚠️ The agent sent a file that could not be delivered: ${name} (${why}).`, replyTo, false);
	let data: Buffer;
	try {
		const st = fs.statSync(file); // as it is now: the agent may have changed it since it sent it
		if (!st.isFile()) return tell("it is not a regular file");
		if (st.size > UPLOAD_MAX) return tell("it is over Telegram's 50 MB limit for bots");
		data = fs.readFileSync(file);
	} catch (err) {
		return tell(`it cannot be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
	}
	let [, method, field] = KINDS.find(([re]) => re.test(name)) ?? DOCUMENT;
	// 30 s, and the file at 200 KB/s: an upload that stalls is given up within minutes, not a quarter of an hour.
	const timeout = 30_000 + Math.round(data.length / 200);
	let tries = 0; // answers that failed (5xx) and stalled uploads; a network that is down is waited for, as sendOne does
	for (let attempt = 0; ; attempt++) {
		await turn(chat);
		const form = new FormData();
		form.set("chat_id", chat);
		if (replyTo) form.set("reply_parameters", JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
		form.set(field, new Blob([data]), name);
		const began = Date.now();
		try {
			await call(method, form, timeout);
			sentTo(chat);
			return;
		} catch (err) {
			const refused = err instanceof TelegramError && err.code >= 400 && err.code < 500;
			if (err instanceof TelegramError && err.code === 429) {
				await sleep((err.retryAfter ?? 5) * 1000);
				continue;
			}
			if (refused && field !== "document") {
				log(`Telegram refused ${name} as a ${field} (${err.message}); sending it as a document`);
				[, method, field] = DOCUMENT;
				continue;
			}
			const counted = err instanceof TelegramError || Date.now() - began > timeout - 1000;
			if (refused || (counted && ++tries >= 3)) {
				log(`could not send ${name} to chat ${chat}: ${(err as Error).message}`);
				return tell((err as Error).message);
			}
			await sleep(Math.min(60_000, 1000 * 2 ** attempt));
		}
	}
}

const told = new Set<string>(); // messages whose sender was already told of an error (once is enough)

// ---- the agent's questions -------------------------------------------------------------------------------------

const answeredHere = new Set<string>(); // questions the owner answered from this chat: the command's own reply said so
/** Why a question closed, for the owner. */
const CLOSED = new Map([
	["terminal", "it was answered in the agent's terminal"],
	["port", "it was answered elsewhere"],
	["timeout", "no answer came in time"],
	["interrupted", "the work it was asked for ended (finished or stopped)"],
]);

/**
 * The agent's questions go to its owner's private chat, whatever conversation the run belongs to (answering is the
 * owner's act): the title, then a command to tap for each option, or the form for a free answer. A chat on the guest
 * list whose run waits for it is told so in one line, without the question. The owner is told when a question closes
 * without them. With no owner on the guest list, only the terminal or the time limit answers.
 */
async function relayQuestion(e: any, allowed: string[]): Promise<void> {
	const me = owner();
	if (e.type === "question") {
		if (!me || !allowed.includes(me)) return;
		const conv = (e.refs ?? []).at(-1)?.conversation;
		const other = typeof conv === "string" && conv !== `telegram:${me}` ? conv : undefined;
		const options: string[] = Array.isArray(e.options) ? e.options.map(String) : [];
		const lines = [`❓ ${String(e.title)}`, ...(other ? [`(asked while it works for ${other})`] : [])];
		// An option is a button to tap, under the question; a free answer is typed after its command.
		const buttons = options.map((o, i) => [{ text: o, data: `/answer_${e.id}_${i + 1}` }]);
		if (!options.length) lines.push(`To answer: /answer_${e.id} <your text>`);
		state.questions = [...(state.questions ?? []), String(e.id)];
		const pieces = split(lines.join("\n"));
		for (let i = 0; i < pieces.length; i++) await sendOne(me, pieces[i], undefined, false, i === pieces.length - 1 && buttons.length ? buttons : undefined);
		const chat = other?.startsWith("telegram:") ? other.slice("telegram:".length) : undefined;
		if (chat && allowed.includes(chat)) await sendOne(chat, "⏳ The agent waits for its owner's answer before it can go on.", undefined, false);
	} else if (e.type === "answered" && state.questions?.includes(String(e.id))) {
		state.questions = state.questions.filter((q) => q !== String(e.id));
		const here = e.by === "port" && answeredHere.delete(String(e.id));
		if (me && !here) await sendOne(me, `The question ${e.id} is closed: ${CLOSED.get(String(e.by)) ?? "it was answered"}.`, undefined, false);
	} else if (["started", "stopped", "restarted"].includes(e.type) && !e.channel && state.questions?.length) {
		// Every question asked before it is closed: no answer will come.
		const closed = state.questions;
		state.questions = [];
		if (me) await sendOne(me, `${closed.length === 1 ? `The question ${closed[0]} is` : `The questions ${closed.join(", ")} are`} closed: the agent ${e.type === "stopped" ? "was stopped" : "restarted"} before an answer.`, undefined, false);
	}
}

/** A run that ended without an answer: stopped on purpose says so plainly; anything else is trouble. */
function settledNote(error: string): string {
	if (/^the work was stopped/.test(error)) return "⏹ Stopped before an answer.";
	if (/^a new conversation was started/.test(error)) return "✨ A new conversation started before an answer.";
	return `⚠️ The agent could not answer: ${error.slice(0, 500)}`;
}

async function send(): Promise<never> {
	for (;;) {
		const { list, next } = readEvents(state.events!);
		let held = false;
		for (const { e, after } of list) {
			track(e);
			// A reply; trouble with a message that will be tried again (error); the end of a run without a reply (settled).
			const note = e.type === "error" ? `⚠️ ${String(e.error).slice(0, 500)}` : e.type === "settled" && e.error ? settledNote(String(e.error)) : undefined;
			// Each Telegram chat this event belongs to, and the last of its messages it answers (to quote it).
			const chats = new Map<string, { replyTo?: number; ids: string[] }>();
			if (e.type === "message" || e.type === "file" || note)
				for (const r of e.refs ?? [])
					if (typeof r.conversation === "string" && r.conversation.startsWith("telegram:")) {
						const chat = r.conversation.slice("telegram:".length);
						const c = chats.get(chat) ?? { ids: [] };
						chats.set(chat, { replyTo: r.from?.message ?? c.replyTo, ids: [...c.ids, String(r.id)] });
					}
			const allowed = e.type === "question" || chats.size ? guests() : [];
			if (!allowed) {
				held = true; // the guest list cannot be read: send nothing now, skip nothing
				break;
			}
			await relayQuestion(e, allowed);
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
				if (e.type === "file") {
					await sendFile(chat, String(e.path), c.replyTo);
					continue;
				}
				const pieces = closeFences(split(String(e.text), LIMIT - 20)); // room to close and reopen a code block
				for (let i = 0; i < pieces.length; i++) await sendOne(chat, pieces[i], i === 0 ? c.replyTo : undefined);
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
	const refusal = (err: unknown) => err instanceof TelegramError && (err.code === 401 || err.code === 404);
	let me: any;
	if (fs.existsSync(tokenFile()))
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
		fs.writeFileSync(tokenFile(), `${tok}\n`, { mode: 0o600 });
		fs.chmodSync(tokenFile(), 0o600);
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
	let problem = ""; // the last one said: each is said once
	while (Date.now() < until) {
		let ups: any[] = [];
		try {
			ups = await call("getUpdates", { timeout: 25, allowed_updates: ["message"] }, 35_000);
		} catch (err) {
			const why =
				err instanceof TelegramError && err.code === 409 ? "another program reads this bot, or a webhook is set (Telegram allows one reader)" : (err as Error).message;
			if (why !== problem) console.log(`  ! Telegram: ${why}; trying again...`);
			problem = why;
			await sleep(err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : 5000);
			continue;
		}
		const fresh = ups.filter((u) => !seen.has(u.update_id));
		if (!fresh.length) await sleep(ups.length ? 2000 : 0); // only old ones pending: Telegram answers at once, so wait
		for (const u of fresh) {
			seen.add(u.update_id);
			const m = u.message;
			if (!m?.from || m.from.is_bot || m.chat?.type !== "private" || (m.date ?? 0) < since) continue;
			const who = nameOf(m.from) || "someone";
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
				if (!owner()) setOwner(String(m.from.id)); // said "that is me" at the terminal: the owner (the first one stays)
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
		setOwner(arg);
		console.log(`Owner: ${arg} (it applies at once)`);
		return;
	}
	if (cmd === "check") {
		// Run by `pp doctor`: one line per check, "ok", "note" or "FAIL", then the text.
		let tok = "";
		try {
			tok = fs.readFileSync(tokenFile(), "utf8").trim();
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
	removeOldFiles();
	state = loadState();
	if (state.events === undefined) {
		state.events = fs.existsSync(eventsFile()) ? fs.statSync(eventsFile()).size : 0; // a first start: only what comes next
		saveState();
	}
	const me = await call("getMe", {});
	const g = guests();
	log(`connected as @${me.username}; ${g?.length ? `obeying ${g.join(", ")}` : g ? "obeying nobody yet (deny by default)" : "the guest list cannot be read"}`);
	await menu();
	setInterval(typing, 4500).unref();
	await Promise.race([receive(), send()]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
	main(process.argv.slice(2)).catch((err) => {
		log(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
