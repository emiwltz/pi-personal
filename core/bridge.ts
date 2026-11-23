// The bridge: the one piece of Pi-Personal that runs inside pi. It connects the port to the conversation.
//
// In:  one port message, one run. The bridge keeps its own queue (the port's inbox) and, when pi is idle, starts a run
//      with the oldest message. Messages that arrive while pi works wait their turn, in the order they were written:
//      a reply never reaches someone it was not meant for, and every message gets its own. Nothing of ours waits in
//      pi's own queues, where an abort could drop or keep it.
//      Each message goes in as a custom message (customType "pi-personal.message") carrying its id in its details:
//      the model reads it as a user message, and the session itself records which messages were taken in.
//      A message is moved to taken/ and reported "taken" only once its entry is in the session file on disk.
//      Above its text the model reads a header that the bridge, and nobody else, writes: who wrote it (when its
//      channel named a sender) and when. Text typed in the terminal has no header at all.
// Out: every assistant text message, the end of each run (settled, with the error when the message got no reply),
//      trouble that does not end a run (error), status changes and typed input become port events. Who a reply is
//      for is read from the session itself (openWork), and told to the extensions that ask (pi-personal.who).
//      A file goes out through the bridge's one tool, attach_file: a `file` event for the person the run answers.
// Control: a port message with `control` is a word for the bridge itself ("interrupt", "answer"), done as soon as it is
//      seen, whatever pi is doing: never queued behind a run, never shown to the model, never written into the session.
// Questions: an in-agent extension asks its owner through the bridge (pi-personal.ask, on pi's bus): the question is
//      shown in the terminal and said on the port (`question`); the first answer wins, the terminal's or the port's.
// Told without waking: a port message with `wake: false` starts no run. Its text is said to its conversation as soon as
//      it is seen (a reminder is on time), and what the conversation keeps of it (its text, or its `note`) is stored when
//      pi is idle, as an entry of its own (customType "pi-personal.note") that never opens a run nor answers one.
// Safe mode: pi records in the conversation that the tools of the extensions turned off were removed, and keeps them
//      off at later starts even once they load again. The bridge writes down which (pi-personal.tools-off) and turns
//      them on again at the first start out of safe mode.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND, PRODUCT } from "./name.ts";
import { below, filesIn, home, version, writeWhole } from "./paths.ts";
import * as port from "./port.ts";

const MESSAGE = "pi-personal.message";
const RESTARTED = "pi-personal.restarted";
const NOTE = "pi-personal.note"; // what the conversation keeps of a message told without waking the model: never a run's
const SETTLED = "pi-personal.settled"; // a run ended (finished, or aborted by a person): what came before is closed
const STOPPED = "pi-personal.stopped"; // the user stopped the agent on purpose: do not resume
const WHO = "pi-personal.who"; // on pi's bus: an extension asks who the open run is for
const ATTACH = "attach_file"; // the bridge's tool: a file for the person the run answers; a success counts as a reply
const INTERRUPT = "pi-personal.interrupt"; // on pi's bus: the run is being stopped; extensions stop work of their own
const ASK = "pi-personal.ask"; // on pi's bus: an extension asks the owner a question
const TOOLS_OFF = "pi-personal.tools-off"; // safe mode: the tools the conversation declares and pi does not have now
const TOOLS_ON = "pi-personal.tools-on"; // out of safe mode: those tools were turned on again
const TOOLS_BACK_MS = 60_000; // how long tools that were off are looked for after a start (MCP tools register late)
const ASK_MS = 5 * 60_000; // how long a question waits by default
const TITLE_MAX = 4000; // an approval must be able to show what is approved
const TOO_LATE_MS = 15_000; // a control message is good only now: one that waited this long (pi was down) does nothing
const RETRY_STEPS_MS = [10_000, 30_000, 60_000, 300_000]; // a message pi did not start a run with (no model, no key...)

type Content = string | { type: string; text?: string }[] | undefined;
const textOf = (content: Content) =>
	typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

/**
 * A name, an id or a conversation as the bridge prints it: on one line (control and line separator characters become a
 * space) and without what cannot be seen (format characters: zero-width, bidi marks). With `max`, for a name or an id:
 * without quotes or brackets of its own, so that it never passes for what the bridge writes around it, and cut to
 * `max` characters (length is never a reason to refuse a message).
 */
function clean(text: string, max?: number): string {
	let s = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/\p{Cf}/gu, "");
	if (max !== undefined) s = s.replace(/["“”«»()[\]{}]/g, " ");
	s = s.replace(/\s+/g, " ").trim();
	return max === undefined ? s : [...s].slice(0, max).join("").trim(); // by character: never half of one
}

/** A sender as the bridge keeps and prints it. Cleaned once, before the message is placed: the header and the details
 * of the session entry carry the same values. */
const tidy = (s: port.Sender): port.Sender => {
	const name = typeof s.name === "string" ? clean(s.name, 64) : "";
	const id = typeof s.id === "string" ? clean(s.id, 100) : "";
	return { ...(name ? { name } : {}), ...(id ? { id } : {}), ...(s.owner === true ? { owner: true } : {}) };
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const two = (n: number) => String(n).padStart(2, "0");
/** When a message was sent, for the model: pi's system prompt holds no date and a session lives for weeks. In the time
 * zone of this process, with a weekday from a fixed list: the same words whatever language the machine is set to. */
export function sentLine(at: Date): string {
	const offset = -at.getTimezoneOffset();
	const utc = `UTC${offset < 0 ? "-" : "+"}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;
	return `Sent: ${WEEKDAYS[at.getDay()]} ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())} ${utc}`;
}

/**
 * The lines the model reads above a port message's text. `From:` only when the message has a sender (tidied): a
 * message without one comes from a program, and nothing in its text can make it the owner's. "the owner" is written
 * here alone, outside the quotes and brackets that hold what a person or a channel chose.
 */
function header(msg: Pick<port.Message, "sender" | "conversation">, at: Date): string {
	const s = msg.sender;
	if (!s) return sentLine(at);
	const who = [s.owner === true ? "the owner" : "", s.name ? `"${s.name}"` : ""].filter(Boolean).join(", ");
	const conversation = clean(msg.conversation ?? "");
	return `From: ${[who, s.id ? `(${s.id})` : ""].filter(Boolean).join(" ") || "someone"}${conversation ? ` · ${conversation}` : ""}\n${sentLine(at)}`;
}

/** What the agent sees for a port message: the header, a blank line, its text as the channel wrote it, and the paths
 * of its attachments. `at`: when it entered the inbox. */
function compose(msg: port.Message, at: Date): string {
	const files = msg.attachments?.length ? `${msg.text ? "\n\n" : ""}Attached files:\n${msg.attachments.map((a) => `- ${a}`).join("\n")}` : "";
	return `${header(msg, at)}\n\n${msg.text}${files}`;
}

/** What the model reads of a message told without waking it: a line in parentheses first, so that a note never starts
 * with `From: the owner`, then the header and what is kept (its `note` when given, else its text and attachments). */
function noteText(msg: port.Message, at: Date): string {
	const conversation = clean(msg.conversation ?? "");
	const kept = msg.note === undefined ? msg : { ...msg, text: msg.note, attachments: undefined };
	return `${conversation ? `(Said to ${conversation} without waking you.)` : "(A note left for you.)"}\n${compose(kept, at)}`;
}

/** A note Herdr Core types into the agent's terminal by itself (a terminal the agent started ended, a helper reports):
 * the whole text is one <hc ...>...</hc> block. A program's note, never the owner typing. Exactly one, with no other
 * hc tag inside: words typed between two blocks are the owner's, and during a guest's run the answer to them would
 * go to the guest. */
export const hcNote = (text: string): boolean => /^<hc(\s[^>]*)?>(?:(?!<\/?hc[\s>])[\s\S])*<\/hc>$/.test(text.trim());

/** A provider's error, said for a person: a JSON body shortened to its message, and, when the provider refused the
 * credentials, the command that enters new ones. */
export function explain(raw: string | undefined, provider?: string): string {
	let text = (raw ?? "").trim() || "the model request failed";
	const body = /^(\d{3}):?\s+([[{][\s\S]*[\]}])$/.exec(text); // "401 {…}" (the whole body) or "401: {…}" (its error)
	if (body)
		try {
			const parsed = JSON.parse(body[2]);
			const j = Array.isArray(parsed) ? parsed[0] : parsed;
			const said = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : undefined);
			if (typeof said === "string" && said.trim()) text = `${body[1]} ${said.trim()}`;
		} catch {} // not JSON after all: kept whole
	// `pp login` alone: an account or an API key, as the person chooses, with what the guide does around pi's prompt.
	return provider && (refused(raw ?? "") || refused(text)) ? `${provider} refused the credentials: ${text.replace(/[.\s]+$/, "")}. To enter new ones: ${COMMAND} login` : text;
}

/** Whether an error says the provider refused the credentials: a wrong, revoked or missing key, or an expired sign-in.
 * An HTTP 401 at the start (pi puts the status first), or a provider's own words for it; not any 403 (a model the
 * plan does not include) nor any word "authentication". */
export const refused = (text: string): boolean =>
	/^401\b/.test(text.trim()) ||
	/authentication[\s_]*(error|fails|failed)|unauthori[sz]ed|invalid[\s_-]*(x-)?api[\s_-]*key|incorrect api key|api key not valid|no auth credentials|invalid[\s_-]*(credentials|token)|token (has )?expired|refused the credentials/i.test(text);

type Entry = Record<string, any>;
type Details = { id: string; from?: port.From; conversation?: string; attachments?: string[]; sender?: port.Sender };
const isOurs = (e: Entry) => e.type === "custom_message" && e.customType === MESSAGE && typeof e.details?.id === "string";
/** A port message the session holds: one a run was started with, or a note. Notes count for duplicates and crash copies
 * only: openWork reads isOurs, and a note is never a run's message nor an answer. */
const isKept = (e: Entry) => isOurs(e) || (e.type === "custom_message" && e.customType === NOTE && typeof e.details?.id === "string");
const isMark = (e: Entry, kind: string) => e.type === "custom" && e.customType === kind;
const refOf = (d: Details): port.Ref => ({ id: d.id, ...(d.from ? { from: d.from } : {}), ...(d.conversation !== undefined ? { conversation: d.conversation } : {}) });
const convOf = (m: { conversation?: string }) => m.conversation ?? "";

export interface Work {
	run: port.Ref[]; // the port messages of the last run: everything since it began
	unanswered: port.Ref[]; // those placed since the run's last reply
	typed: boolean; // something was typed in the terminal during this run: the rest of the run is the terminal's
	sender?: port.Sender; // who wrote the run's last port message, when its channel said
	cutOff: boolean; // the run neither ended (its last entry is not a finished answer) nor was stopped on purpose
}

/**
 * The work the session holds open, read from the session itself: who a reply is for is never kept anywhere else.
 * A run begins after a SETTLED mark (it ended) or a STOPPED mark (it was stopped on purpose); what came before
 * is closed. Only the run after the last mark can be open, and it serves one conversation.
 */
export function openWork(branch: Entry[]): Work {
	let start = branch.length;
	while (start > 0 && !isMark(branch[start - 1], SETTLED) && !isMark(branch[start - 1], STOPPED)) start--;
	const run: port.Ref[] = [];
	let unanswered: port.Ref[] = [];
	let typed = false;
	let sender: port.Sender | undefined;
	let last: string | undefined; // what the run did last: "done" when the agent's final message ended it normally
	// pi writes the end of an aborted step (a tool result, an aborted answer) after the STOPPED mark: that tail
	// belongs to the stopped run. A new run begins with new input only.
	let tail = start > 0 && isMark(branch[start - 1], STOPPED);
	for (const e of branch.slice(start)) {
		const input = isOurs(e) || (e.type === "custom_message" && e.customType === RESTARTED) || (e.type === "message" && e.message?.role === "user");
		if (tail && !input) continue;
		tail = false;
		if (isOurs(e)) {
			run.push(refOf(e.details));
			unanswered.push(refOf(e.details));
			sender = e.details.sender;
			last = "message";
		} else if (e.type === "custom_message" && e.customType === RESTARTED) last = "message";
		else if (e.type === "message" && ["user", "assistant", "toolResult"].includes(e.message?.role)) {
			const m = e.message;
			// The owner took over in the terminal: never undone within the run. Not when Herdr Core typed a note there.
			if (m.role === "user" && !hcNote(textOf(m.content))) typed = true;
			last = m.role === "assistant" && m.stopReason === "stop" ? "done" : m.role;
			// A reply: text, or a file sent. Not once the owner took over: what follows answers the terminal.
			// A file sent from inside another tool (codemode's scripts, ctx.executeTool) leaves no result of its own: pi
			// records it in the calling tool's nestedCalls.
			const sent = m.role === "toolResult" && ((m.toolName === ATTACH && !m.isError) || (m.nestedCalls?.calls ?? []).some((c: Entry) => c.name === ATTACH && c.status === "ok"));
			if (!typed && ((m.role === "assistant" && textOf(m.content).trim()) || sent)) unanswered = [];
		}
	}
	return { run, unanswered, typed, ...(sender ? { sender } : {}), cutOff: last !== undefined && last !== "done" };
}

/** The tools a session declares to the model, replayed from its system messages as pi replays them (pi-ai's
 * getCurrentTools, which pi does not export): each adds tools and removes others. */
function declaredTools(branch: Entry[]): string[] {
	const tools = new Set<string>();
	for (const e of branch)
		if (e.type === "message" && e.message?.role === "system") {
			for (const t of e.message.toolsRemoved ?? []) tools.delete(t.name);
			for (const t of e.message.toolsAdded ?? []) tools.add(t.name);
		}
	return [...tools];
}

/** The tools safe mode turned off, while no start out of it has turned them on again (the last TOOLS_OFF, not followed
 * by a TOOLS_ON). */
function toolsOff(branch: Entry[]): string[] {
	for (const e of [...branch].reverse()) {
		if (isMark(e, TOOLS_ON)) return [];
		if (isMark(e, TOOLS_OFF)) return Array.isArray(e.data?.names) ? e.data.names.filter((n: unknown) => typeof n === "string") : [];
	}
	return [];
}

/** Whether each of these messages has a `settled` after its last `taken` in the events. */
function settledOutside(portDir: string, refs: port.Ref[]): boolean {
	const open = new Map(refs.map((r) => [r.id, true]));
	for (const e of port.events(portDir).events) {
		if (e.channel) continue;
		if (e.type === "taken" && typeof e.id === "string" && open.has(e.id)) open.set(e.id, true);
		else if (e.type === "settled") for (const r of (e.refs as port.Ref[] | undefined) ?? []) if (open.has(r.id)) open.set(r.id, false);
	}
	return ![...open.values()].includes(true);
}

/** A reply goes to one conversation only, whatever happened before: the last one these messages belong to. */
const oneConversation = (refs: port.Ref[]) => refs.filter((r) => convOf(r) === convOf(refs.at(-1) ?? {}));
/** Whom a reply of the open run is for: its messages not answered yet, or else the run's. Nobody once the owner took
 * over in the terminal. */
const replyRefs = (w: Work) => (w.typed ? [] : oneConversation(w.unanswered.length ? w.unanswered : w.run));
/** Refs grouped by conversation, in order: every event names one conversation only. */
const byConversation = (refs: port.Ref[]) => {
	const groups = new Map<string, port.Ref[]>();
	for (const r of refs) groups.set(convOf(r), [...(groups.get(convOf(r)) ?? []), r]);
	return [...groups.values()];
};

/**
 * The file a path names, if it may be sent out: a regular file (links followed), not in Pi-Personal's private area
 * (secrets, sign-ins, conversations, the port), except what a channel of this agent received (`channels/<name>/files/`)
 * and in-agent extensions' own state. A guard against a slip, not a wall: the agent can read the private area and
 * copy a file elsewhere first. `given` is absolute or relative to the agent's folder; a leading @ is dropped, as pi's
 * own tools do.
 */
function sendable(given: string, folder: string, agentDir: string): { file: string } | { why: string } {
	const shown = given.startsWith("@") ? given.slice(1) : given;
	let file: string;
	try {
		file = fs.realpathSync(path.resolve(folder, shown));
		if (!fs.statSync(file).isFile()) return { why: `${shown} is not a file` };
	} catch {
		return { why: `${shown} does not exist` };
	}
	const under = (dir: string) => below(dir, file);
	const own = filesIn(agentDir);
	const received = under(own.channels);
	if (under(home()) && !under(own.extensions) && !(received && received.length > 2 && received[1] === "files"))
		return { why: `${shown} is in ${PRODUCT}'s private area (secrets, sign-ins, conversations), where no file is sent from` };
	return { file };
}

export default function bridge(pi: ExtensionAPI) {
	const portDir = process.env.PI_PERSONAL_PORT;
	if (!portDir) throw new Error("PI_PERSONAL_PORT is not set: the Pi-Personal bridge only runs under the Pi-Personal runner");
	let safeMode: string[] | null = null; // the extensions turned off, when the runner started pi in safe mode
	try {
		safeMode = process.env.PI_PERSONAL_SAFE_MODE ? JSON.parse(process.env.PI_PERSONAL_SAFE_MODE) : null;
	} catch {}
	const restarted = process.env.PI_PERSONAL_RESTARTED || "";
	let core = ""; // this Pi-Personal's version, said at each start (a package.json that cannot be read stops nothing)
	try {
		core = version();
	} catch {}
	const { stopped, wasStopped, lastError: lastErrorFile, session: sessionIdFile } = filesIn(path.dirname(portDir));
	port.ensurePort(portDir);
	// Writing an event must never kill pi: what cannot be written waits and is written later.
	const emit = port.emitter(portDir, (m) => process.stderr.write(`[pi-personal] ${m}\n`));
	const guarded =
		<A extends unknown[]>(where: string, f: (...a: A) => void) =>
		(...a: A) => {
			try {
				f(...a);
			} catch (err) {
				emit({ type: "error", error: `bridge (${where}): ${(err as Error).message}`, refs: [] });
			}
		};

	let ctx: ExtensionContext | undefined;
	const known = new Map<string, number>(); // ids in the session, and when they entered it (ms)
	const handed = new Map<string, number>(); // handed to pi, not placed yet: when
	let handing: Details | undefined; // the last message handed: who the starting run is for, until its entry is in the session
	let typedStart = false; // the run was started by text from the terminal, which the session does not hold yet
	const unconfirmed = new Set<string>(); // placed, not yet known to be on disk
	const stuck = new Map<string, { tries: number; next: number }>(); // pi did not start a run with them
	const parsed = new Map<string, { mtime: bigint; msg: port.Message }>(); // inbox files already read, until they change
	const unmoved = new Set<string>(); // settled at once (a control message, a note) but whose file could not be moved to taken/ yet
	const said = new Set<string>(); // messages told without waking, said in this life of pi: once each
	const born = Date.now(); // a file older than this life of pi may have been settled by an earlier one
	let runError: string | undefined; // the model request failed (pi may still retry it within the run)
	let working = false; // between agent_start and agent_settled
	let starting = 0; // when a run was requested that has not started yet (0: none)
	let halt = false; // interrupted while a message was handed and pi had no run yet to abort: abort it when it starts
	let signalled = false; // pi is being stopped: the run is closed (on purpose) or left to resume (otherwise)
	// The bridge's own questions, waiting for an answer. `end` answers one: once, the first answer wins.
	const questions = new Map<string, { options?: string[]; inRun: boolean; end: (answer: string | undefined, by?: string) => void }>();
	let prompting = false; // a dialog is open in the terminal (pi's ui_prompt span: the bridge's own or another extension's)
	const toldBlocked = new Set<string>(); // messages already told that the agent waits in its terminal: once each
	let alone = 0; // since when the agent has been seen waiting in its terminal only
	const early: (() => void)[] = []; // questions asked before the session started
	let toolsBack: { names: string[]; until: number } | undefined; // tools safe mode turned off, to turn on as they register
	let toolsOpen = false; // a TOOLS_OFF entry waits for its TOOLS_ON
	let watcher: fs.FSWatcher | undefined;
	let timer: NodeJS.Timeout | undefined;
	let soon: NodeJS.Timeout | undefined;

	const entries = (): Entry[] => (ctx?.sessionManager.getEntries() ?? []) as unknown as Entry[];
	const work = (): Work => openWork((ctx?.sessionManager.getBranch() ?? []) as unknown as Entry[]);
	const kept = (id: string) => entries().find((e) => isKept(e) && e.details.id === id);
	const inSession = (id: string) => kept(id) !== undefined;
	const sessionFile = () => (ctx?.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.();
	/** The session file, once pi wrote it: only once the session holds a user or assistant message; from then on every
	 * entry is appended to it at once. */
	const written = (): string | undefined => {
		const file = sessionFile();
		return file && fs.existsSync(file) ? file : undefined;
	};
	const durable = (file: string) => {
		try {
			const fd = fs.openSync(file, "r");
			fs.fsyncSync(fd);
			fs.closeSync(fd);
		} catch {}
	};
	/** A message settled at once (a control message, a note) leaves the inbox; when taken/ cannot be written now, its file
	 * stays, done, and is moved by a later look. Not while its events wait in memory either: the file is the mark that
	 * something is still owed, and a restart before they are written finds it and says it again rather than lose it. */
	const move = (id: string) => {
		unmoved.add(id);
		if (emit.troubled()) return;
		try {
			port.take(portDir, id);
			unmoved.delete(id);
		} catch {}
	};
	/**
	 * Who the open run is for, as openWork reads it; undefined when no run is open (pi is idle and nothing was handed).
	 * A message handed to pi is not in the session before its run begins: until then the answer is that message.
	 */
	const who = (): { refs: port.Ref[]; conversation?: string; sender?: port.Sender; typed: boolean } | undefined => {
		const c = ctx;
		if (!c) return undefined;
		const w = work();
		// Once its entry is in the session, the session answers: even when that run is closed and the entry not yet on disk.
		const id = handing?.id ?? "";
		const d = (handed.has(id) || unconfirmed.has(id)) && !inSession(id) ? handing : undefined;
		if (!d && c.isIdle()) return undefined;
		const refs = d ? [refOf(d)] : oneConversation(w.run);
		const conversation = refs.at(-1)?.conversation;
		const sender = d ? d.sender : w.sender;
		return { refs, ...(conversation !== undefined ? { conversation } : {}), ...(sender ? { sender } : {}), typed: !d && (w.typed || typedStart) };
	};

	const lastError = (error?: string) => {
		try {
			if (error) fs.writeFileSync(lastErrorFile, `${JSON.stringify({ at: new Date().toISOString(), error })}\n`, { mode: 0o600 });
			else fs.rmSync(lastErrorFile, { force: true });
		} catch {}
	};
	/** A message pi did not keep (it never started a run with it, or could not record it): say so, try again later. */
	const retryLater = (id: string, why: string) => {
		const tries = (stuck.get(id)?.tries ?? 0) + 1;
		const wait = RETRY_STEPS_MS[Math.min(tries, RETRY_STEPS_MS.length - 1)];
		const retryAt = Date.now() + wait;
		stuck.set(id, { tries, next: retryAt });
		const msg = parsed.get(id)?.msg;
		const error = `${why}; trying again in ${Math.round(wait / 1000)} s`;
		emit({ type: "error", error, retryAt: new Date(retryAt).toISOString(), refs: [msg ? refOf(msg) : { id }] });
		lastError(error);
	};
	/**
	 * End the run. `settled` is its last word: it names the run's message, and carries the error when that message got no
	 * reply (pi had retried a passing provider error by itself before this point).
	 */
	const close = (w: Work, why: string, mark: string) => {
		// Placed in this run, but not in the session (pi could not write it: a full disk): it is still in the inbox.
		const lost = [...unconfirmed].filter((x) => !inSession(x));
		for (const id of lost) {
			unconfirmed.delete(id);
			retryLater(id, "the agent could not record this message in its conversation");
		}
		// No reply, or the run did not end on a finished answer (a final failure, a stop after "let me check..."):
		// the message gets the error. If the owner took over in the terminal first, that is the reason.
		const reason = w.typed && w.unanswered.length ? "the owner took over in the agent's terminal before an answer" : why;
		const error = w.unanswered.length || w.cutOff || runError ? (runError ?? reason) : undefined;
		const failed = new Set((w.unanswered.length ? w.unanswered : w.run).map((r) => r.id));
		// One settled per conversation (a run holds one message; grouping keeps the rule should it ever hold more). Said
		// before the session mark: a crash in between repeats the last word rather than losing it.
		for (const g of w.run.length ? byConversation(w.run) : [[]])
			emit({ type: "settled", refs: g, ...(error && (!g.length || g.some((r) => failed.has(r.id))) ? { error } : {}) });
		try {
			pi.appendEntry(mark, {}); // what came before is closed: a later reply never goes to these messages
		} catch (err) {
			emit({ type: "error", error: `bridge: could not mark the end of the run in the session (${(err as Error).message})`, refs: [] });
		}
		if (error || !lost.length) lastError(error);
		runError = undefined;
	};

	/** Report messages taken in once they are durably in the session; keep the others for later. */
	const confirm = guarded("confirm", () => {
		if (!unconfirmed.size) return;
		const file = written();
		if (!file) return;
		const stored = [...unconfirmed].filter(inSession);
		if (!stored.length) return;
		durable(file); // before saying "taken"
		for (const id of stored) {
			unconfirmed.delete(id);
			known.set(id, Date.now());
			port.take(portDir, id);
			emit({ type: "taken", id, refs: [refOf(kept(id)?.details ?? { id })] }); // like every event about a message
		}
	});

	/** Stop the run, if one is in progress: pi counts as busy from the moment a run is requested, and a message the
	 * bridge has just handed may not have reached pi yet. Extensions hear of it first, and may add a line each. */
	const interrupt = (c: ExtensionContext): string => {
		const running = !c.isIdle() || starting > 0 || handed.size > 0;
		const lines: string[] = [];
		let open = true; // a line said later, once the result is written, is lost rather than misplaced
		pi.events.emit(INTERRUPT, {
			say: (line: unknown) => {
				const l = open ? clean(String(line)) : "";
				if (l) lines.push(l);
			},
		});
		open = false;
		if (running) {
			if (c.isIdle()) halt = true; // pi's abort only stops a run it has
			c.abort(); // pi only asks: the run's own settled says that it stopped
		}
		for (const q of [...questions.values()]) q.end(undefined, "interrupted");
		return [running ? "asked the run to stop" : "nothing was running", ...lines].join("\n");
	};
	/** `"control": "answer"`: with options, an option's number from 1 (read first) or its text (case ignored); otherwise the text. An
	 * answer that fits no option leaves the question waiting. */
	const answer = (msg: port.Message): { result: string } | { error: string } => {
		const q = msg.question === undefined ? undefined : questions.get(msg.question);
		if (!q) return { error: msg.question === undefined ? "no question was named (question: its id)" : "that question is closed" };
		const given = msg.answer ?? "";
		let chosen: string | undefined = given;
		if (q.options) {
			const g = given.trim();
			// A number in range first: every display numbers the options, so a tapped number means what was shown under it,
			// even when the options are numerals themselves.
			chosen = /^\d+$/.test(g) && Number(g) >= 1 ? q.options[Number(g) - 1] : undefined;
			chosen ??= q.options.find((o) => o.toLowerCase() === g.toLowerCase());
			if (chosen === undefined)
				return { error: `"${[...clean(given)].slice(0, 100).join("")}" is none of the options: ${q.options.map((o, i) => `${i + 1} ${o}`).join(", ")}; the question still waits` };
		}
		q.end(chosen, "port");
		return { result: `answered ${msg.question}` };
	};
	/** The agent waits in its terminal only: a dialog is open there and none of the bridge's own questions waits (pi's
	 * event names no asker, and the bridge's dialog opens the same span). Each message concerned is told once, without
	 * the question's text, which belongs to another conversation. The state must hold for a second: pi closes the
	 * bridge's own dialog a moment after its question is answered (ui_prompt_end comes later). */
	const tellBlocked = () => {
		if (!prompting || questions.size) return void (alone = 0);
		alone ||= Date.now();
		if (Date.now() - alone < 1000) return;
		const tell = (ref: port.Ref, what: string) => {
			if (toldBlocked.has(ref.id)) return;
			toldBlocked.add(ref.id);
			emit({ type: "error", error: `the agent waits for an answer in its terminal before it can ${what}`, refs: [ref] });
		};
		const run = who();
		for (const r of run && !run.typed ? run.refs : []) tell(r, "go on");
		for (const [id, { msg }] of parsed) if (msg.wake !== false && !handed.has(id) && !unconfirmed.has(id) && !known.has(id)) tell(refOf(msg), "read this message");
	};

	/**
	 * A control message: done, then moved to taken/, then settled. The file stays in the inbox while it is done: should pi
	 * die meanwhile, it is seen again at the next start and settled as too late, said twice rather than lost. One its
	 * writer withdrew first does nothing; one withdrawn while it is done is settled all the same (pp interrupt looks).
	 */
	const obey = (c: ExtensionContext, msg: port.Message, file: string, age: number) => {
		if (!fs.existsSync(file)) return;
		const ref = refOf(msg);
		let done: { result: string } | { error: string };
		try {
			if (age > TOO_LATE_MS) done = { error: "came too late; nothing was done" };
			else if (msg.control === "interrupt") done = { result: interrupt(c) };
			else if (msg.control === "answer") done = answer(msg);
			else done = { error: `unknown control "${msg.control}" (this agent knows: interrupt, answer)` };
		} catch (err) {
			done = { error: `the bridge could not do it: ${(err as Error).message}` }; // seen: its settled is owed all the same
		}
		move(msg.id);
		emit({ type: "taken", id: msg.id, refs: [ref] });
		emit({ type: "settled", refs: [ref], ...done });
	};

	/**
	 * A message told without waking (`wake: false`), said to its conversation once in this life of pi, whatever pi is
	 * doing, so that a reminder is on time: its text as a reply, its attachments as files (checked as attach_file checks
	 * them). False when an earlier life settled it already and only its file was left (it is moved now).
	 */
	const announce = (msg: port.Message, mtimeMs: number): boolean => {
		if (said.has(msg.id)) return true;
		said.add(msg.id);
		const ref = refOf(msg);
		if (mtimeMs < born && settledOutside(portDir, [ref])) {
			move(msg.id);
			return false;
		}
		if (!msg.conversation) return true; // a note for the agent alone
		if (msg.text.trim()) emit({ type: "message", text: msg.text, refs: [ref] });
		for (const a of msg.attachments ?? []) {
			const ok = sendable(a, ctx?.cwd ?? process.cwd(), path.dirname(portDir));
			// The reason names a path, maybe in the private area, and the channel tells it to the conversation: only the name.
			emit("why" in ok ? { type: "error", error: `not sent: ${path.basename(a)} may not be sent from here`, refs: [ref] } : { type: "file", path: ok.file, refs: [ref] });
		}
		return true;
	};
	/** Told, and what is kept durable in the session (or nothing kept): taken, settled, then the file moves. The file is
	 * the mark that something is still owed: a crash before it moves says the message again, rather than lose it. */
	const told = (ref: port.Ref) => {
		emit({ type: "taken", id: ref.id, refs: [ref] });
		emit({ type: "settled", refs: [ref] });
		move(ref.id);
	};
	/**
	 * What the conversation keeps of a message told without waking, stored while pi is idle, in its turn: pi appends it at
	 * once and starts no run (sendMessage with triggerTurn false sends extensions no message_start: it never enters
	 * `handed` nor sets `starting`). Checked at once, made durable, then settled; one pi did not record is tried later.
	 */
	const keep = (msg: port.Message, at: Date, file: string) => {
		const sender = msg.sender && tidy(msg.sender);
		if (!inSession(msg.id))
			pi.sendMessage({ customType: NOTE, content: noteText({ ...msg, sender }, at), display: true, details: { ...refOf(msg), ...(sender ? { sender } : {}) } }, { triggerTurn: false });
		if (!inSession(msg.id)) return retryLater(msg.id, "the agent could not record this note in its conversation");
		durable(file);
		known.set(msg.id, Date.now());
		stuck.delete(msg.id);
		told(refOf(msg));
	};

	/**
	 * Messages waiting in the inbox that may be handed to pi now, each with the time of its file: the oldest of each
	 * conversation, oldest first.
	 * Settles duplicates and broken files. A file is read once, and again only if it changes: a burst of thousands of
	 * messages costs a listing of the inbox, not thousands of reads, each time.
	 */
	const ready = (): { messages: { msg: port.Message; at: Date }[]; notes: { msg: port.Message; at: Date }[] } => {
		const out: { msg: port.Message; at: Date }[] = [];
		const notes: { msg: port.Message; at: Date }[] = []; // told without waking, what they keep not stored yet
		const held = new Set<string>(); // conversations with an earlier message still waiting: nothing passes it
		const seen = new Set<string>();
		const now = Date.now();
		for (const p of port.pending(portDir)) {
			seen.add(p.id);
			if (handed.has(p.id) || unconfirmed.has(p.id)) continue;
			const ms = Number(p.mtime / 1_000_000n);
			if (unmoved.has(p.id)) {
				move(p.id);
				continue;
			}
			const inSessionSince = known.get(p.id);
			if (inSessionSince !== undefined) {
				// Already in the session: the same id sent again, or the copy a crash left before it was moved. A copy never
				// has a file in taken/ beside it (a move is one rename), so one there says a resend, whatever the file's time:
				// the kernel's file clock is coarser than Date.now(), and a resend written within its tick reads as older.
				// Without one (cleaned up after 30 days), written after it was taken in: a resend.
				const again = ms > inSessionSince || port.isTaken(portDir, p.id);
				const e = again ? undefined : kept(p.id);
				if (e?.customType === NOTE) {
					// A note stored before a crash, its file not moved: settled already, only the file is left; otherwise said
					// again rather than lost, then settled.
					if (settledOutside(portDir, [refOf(e.details)])) move(p.id);
					else {
						const r = port.read(p);
						if ("reason" in r && r.later) continue;
						if ("msg" in r) announce(r.msg, ms);
						told(refOf(e.details));
					}
					continue;
				}
				port.take(portDir, p.id);
				if (again) emit({ type: "duplicate", id: p.id });
				else emit({ type: "taken", id: p.id, refs: [refOf(e?.details ?? { id: p.id })] });
				continue;
			}
			let msg = parsed.get(p.id)?.mtime === p.mtime ? parsed.get(p.id)!.msg : undefined;
			if (!msg) {
				if (port.isTaken(portDir, p.id)) {
					port.take(portDir, p.id); // removes the new copy
					emit({ type: "duplicate", id: p.id });
					continue;
				}
				const r = port.read(p);
				if ("reason" in r) {
					if (r.later) continue; // still being written, or not readable right now
					port.reject(portDir, p.id);
					emit({ type: "rejected", id: p.id, reason: r.reason });
					continue;
				}
				msg = r.msg;
				if (msg.control !== undefined) {
					if (ctx) obey(ctx, msg, p.file, now - ms);
					continue;
				}
				parsed.set(p.id, { mtime: p.mtime, msg });
			}
			const s = stuck.get(p.id);
			if (msg.wake === false) {
				// Told without waking: it holds up no conversation, its own included, and is kept when pi is idle.
				if (!announce(msg, ms)) continue;
				if (msg.note === "") told(refOf(msg)); // nothing to keep: only said
				else if (!(s && s.next > now)) notes.push({ msg, at: new Date(ms) });
				continue;
			}
			const conv = convOf(msg);
			if (held.has(conv) || (s && s.next > now)) {
				held.add(conv);
				continue;
			}
			out.push({ msg, at: new Date(ms) }); // when it entered the inbox
			held.add(conv);
		}
		for (const id of parsed.keys()) if (!seen.has(id)) parsed.delete(id);
		return { messages: out, notes };
	};

	const hand = (msg: port.Message, at: Date) => {
		if (known.has(msg.id)) return; // never twice into the session
		handed.set(msg.id, Date.now());
		const sender = msg.sender && tidy(msg.sender);
		const details: Details = { ...refOf(msg), ...(msg.attachments?.length ? { attachments: msg.attachments } : {}), ...(sender ? { sender } : {}) };
		handing = details;
		pi.sendMessage({ customType: MESSAGE, content: compose({ ...msg, sender }, at), display: true, details }, { triggerTurn: true });
	};

	/** When pi is idle: store what the notes waiting keep, then start a run with the oldest message. */
	const deliver = guarded("deliver", () => {
		const c = ctx;
		if (!c || signalled || working || starting || handed.size || !c.isIdle()) {
			if (c) {
				ready(); // still settle duplicates and broken files at once
				tellBlocked();
			}
			return;
		}
		const { messages, notes } = ready();
		// Never before pi wrote the session file (a new agent, a fresh conversation, until its first reply): a note placed
		// then would sit before the session's system prompt for the life of the conversation. It waits for that.
		const file = written();
		if (file) for (const n of notes) keep(n.msg, n.at, file);
		const first = messages[0];
		if (!first) return;
		starting = Date.now();
		hand(first.msg, first.at);
	});
	// The inbox changes several times per message written (a temporary file, a link, a removal): look once.
	const deliverSoon = () => {
		soon ??= setTimeout(() => {
			soon = undefined;
			deliver();
		}, 50);
	};

	/** A message handed to an idle pi that never started a run with it: tell its sender, try again later, keep the order. */
	const retryStuck = guarded("retry", () => {
		const c = ctx;
		if (!c || working || !c.isIdle()) return;
		const now = Date.now();
		if (starting && !handed.size && now - starting > RETRY_STEPS_MS[0]) {
			starting = 0; // the restart note never started a run
			halt = false;
		}
		for (const [id, at] of [...handed]) {
			if (now - at < RETRY_STEPS_MS[0]) continue;
			handed.delete(id);
			starting = 0;
			halt = false;
			if (inSession(id)) {
				unconfirmed.add(id); // it did get in
				continue;
			}
			retryLater(id, "the agent did not start working on this message");
		}
	});

	/** Out of safe mode: turn on again the tools it turned off, as each registers (MCP tools come late), for a minute. */
	const turnToolsOn = guarded("tools", () => {
		if (!toolsBack) return;
		if (Date.now() > toolsBack.until) return void (toolsBack = undefined);
		const active = pi.getActiveTools();
		const have = new Set(pi.getAllTools().map((t) => t.name));
		const back = toolsBack.names.filter((n) => have.has(n) && !active.includes(n));
		if (!back.length) return;
		toolsBack.names = toolsBack.names.filter((n) => !back.includes(n)); // once each: the owner may turn one off again
		pi.setActiveTools([...active, ...back]);
	});

	/**
	 * In safe mode, write down the tools the conversation declares and pi does not have (their extension is off): pi
	 * records them as removed at the next request and keeps them off afterwards, even once they load again. Out of safe
	 * mode, while that note is open, turn them on again. Its own guard: trouble here never keeps the session from starting.
	 */
	const toolsAtStart = guarded("tools", (c: ExtensionContext) => {
		const branch = c.sessionManager.getBranch() as unknown as Entry[];
		const off = toolsOff(branch);
		toolsBack = undefined;
		toolsOpen = !safeMode && off.length > 0; // closed only by a start out of safe mode
		if (safeMode) {
			const have = new Set(pi.getAllTools().map((t) => t.name));
			const names = [...new Set([...off, ...declaredTools(branch).filter((n) => !have.has(n))])];
			if (names.length > off.length) pi.appendEntry(TOOLS_OFF, { names });
		} else if (off.length) {
			toolsBack = { names: off, until: Date.now() + TOOLS_BACK_MS };
			turnToolsOn();
		}
	});
	/** The first run out of safe mode declared those tools again in its request: the note is closed. */
	const toolsSettled = guarded("tools", () => {
		if (!toolsOpen) return;
		toolsOpen = false;
		pi.appendEntry(TOOLS_ON, {});
	});

	const tick = guarded("tick", () => {
		turnToolsOn();
		confirm();
		retryStuck();
		deliver(); // a fallback: file watching is not reliable everywhere
	});

	pi.on("session_start", async (event, c) => {
		guarded("session_start", () => {
			ctx = c;
			// Whoever looks at this screen (pp, Herdr) is shown how to leave it without stopping the agent.
			if (c.hasUI) c.ui.setStatus("pi-personal", "ctrl+\\ leaves this screen · the agent keeps running");
			known.clear();
			handed.clear();
			unconfirmed.clear();
			parsed.clear(); // another session may know other ids: read every file again
			starting = 0;
			halt = false;
			typedStart = false;
			signalled = false;
			runError = undefined;
			for (const e of entries()) if (isKept(e)) known.set(e.details.id, Date.parse(e.timestamp) || 0);
			toolsAtStart(c);
			// The session pi opened is the agent's own from now on: the runner starts pi with it again. This is how an agent
			// made by 0.4 (resumed once as pi's newest session) gets its id, and how /new or /resume typed in the terminal is
			// kept across restarts. Written only when it changes; a disk that refuses it stops nothing.
			try {
				const id = c.sessionManager.getSessionId();
				if (id && (fs.existsSync(sessionIdFile) ? fs.readFileSync(sessionIdFile, "utf8").trim() : "") !== id) writeWhole(sessionIdFile, `${id}\n`, 0o600);
			} catch {}
			// A run already settled outside pi (pp new while pi was down settles it in the events, and cannot reach this
			// session) is closed without a word: opening this session again never answers it a second time.
			try {
				const open = work().run;
				if (open.length && settledOutside(portDir, open)) pi.appendEntry(STOPPED, {});
			} catch {} // not marked: the run is resumed or closed below, said twice rather than lost
			emit({ type: "started", pid: process.pid, safeMode, ...(core ? { core } : {}) });
			for (const ask of early.splice(0)) ask();
			if (event.reason !== "startup") return;
			const w = work();
			// Stopped on purpose while pi was down (after a crash, or while it waited to retry): close, never resume.
			const afterStop = fs.existsSync(wasStopped);
			fs.rmSync(wasStopped, { force: true });
			if (w.cutOff && afterStop) close(w, "the agent was stopped before answering these messages", STOPPED);
			else if (w.cutOff) {
				// Work cut off by a crash or a stop that was not on purpose: ask the agent to continue it first.
				// Its reply goes to the message of that run; messages that waited come next.
				starting = Date.now();
				pi.sendMessage(
					{
						customType: RESTARTED,
						content: `(Pi-Personal restarted you after ${restarted ? `an unexpected stop: ${restarted}` : "an interruption"}. Your previous work was cut off. Continue where you left off.)`,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} else if (w.run.length) close(w, "the agent stopped before answering these messages", SETTLED); // its end was never recorded
		})();
		deliver();
		if (!watcher) {
			watcher = fs.watch(path.join(portDir, "inbox"), deliverSoon);
			watcher.on("error", () => {}); // the timer below keeps delivering
		}
		timer ??= setInterval(tick, 1000);
		timer.unref?.();
	});

	// What started the run, for who(): text from the terminal is not in the session yet. pi loads the bridge before the
	// extensions it finds, so this is set before theirs ask; were it not, they would be told "not typed", never the reverse.
	pi.on("before_agent_start", async (event) => {
		const e = event as unknown as { messageType?: string; prompt?: string };
		typedStart = e.messageType === "user" && !hcNote(e.prompt ?? "");
	});
	// An extension asks who the open run is for, on pi's bus, which calls its listeners in the asker's own turn: the
	// answer is on its object when emit returns. Left unset when no run is open.
	pi.events.on(
		WHO,
		guarded("who", (q: unknown) => {
			const run = typeof q === "object" && q !== null ? who() : undefined;
			if (run) (q as { run?: unknown }).run = run;
		}),
	);

	// A question for the owner, from an in-agent extension: { title, options?, timeoutMs?, resolve }. `taken` is set before
	// emit returns: an asker that finds it unset is not under Pi-Personal. Shown in the terminal when there is a screen,
	// and said on the port; the first answer wins (the terminal's or a control message), and the other side is closed.
	// After the time limit, at an interrupt or at the end of its run, the answer is undefined.
	pi.events.on(
		ASK,
		guarded("ask", (q: unknown) => {
			const a = q as { title?: unknown; options?: unknown; timeoutMs?: unknown; resolve?: unknown; taken?: boolean } | null;
			if (typeof a !== "object" || a === null || typeof a.resolve !== "function") return;
			const resolve = a.resolve as (answer: string | undefined) => void;
			a.taken = true;
			const title = [...String(a.title ?? "")].slice(0, TITLE_MAX).join("");
			const options = Array.isArray(a.options) && a.options.length ? a.options.map(String) : undefined;
			// setTimeout fires at once past 2^31 ms: a longer wait is cut to that (24 days).
			const ms = typeof a.timeoutMs === "number" && a.timeoutMs > 0 ? Math.min(a.timeoutMs, 2 ** 31 - 1) : ASK_MS;
			// Asked while pi loads its extensions: said once the session is up, after its `started`, which would close it.
			const open = () => {
				// Short and never used twice, across restarts too: the time and a random part.
				const id = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
				const refs = who()?.refs ?? [];
				const shown = new AbortController();
				const end = (answer: string | undefined, by?: string) => {
					if (questions.get(id) !== question) return; // answered already
					questions.delete(id);
					clearTimeout(timer);
					shown.abort(); // the terminal's dialog closes
					if (by) emit({ type: "answered", id, by, refs }); // without `by`: pi's session ends, and the next `started` closes it
					try {
						resolve(answer);
					} catch (err) {
						emit({ type: "error", error: `bridge (ask): the extension that asked failed on its answer: ${(err as Error).message}`, refs: [] });
					}
				};
				const question = { ...(options ? { options } : {}), inRun: !!ctx && (!ctx.isIdle() || starting > 0), end };
				const timer = setTimeout(() => end(undefined, "timeout"), ms);
				questions.set(id, question);
				emit({ type: "question", id, title, ...(options ? { options } : {}), until: new Date(Date.now() + ms).toISOString(), refs });
				if (ctx?.hasUI) {
					// Escape in the terminal is the owner's answer too: none.
					const dialog = options ? ctx.ui.select(title, options, { signal: shown.signal }) : ctx.ui.input(title, undefined, { signal: shown.signal });
					dialog.then((answer) => end(answer, "terminal"), () => {});
				}
			};
			if (ctx) open();
			else early.push(open);
		}),
	);

	// A file for the person the run answers. Said at once, and nothing is kept in memory: after a crash between the
	// event and the session, the resumed run may send it again (twice, never lost). In safe mode too: it is the bridge's.
	pi.registerTool({
		name: ATTACH,
		label: "Attach file",
		description: "Send a file to the person you are answering, through the channel their message came from. The path is absolute, or relative to your folder.",
		// The model often writes a file and sends it in one step: run after the other calls of that step, not beside them.
		executionMode: "sequential",
		parameters: { type: "object", properties: { path: { type: "string", description: "The file to send" } }, required: ["path"] } as any,
		async execute(_id, params: { path?: unknown }, _signal, _onUpdate, c) {
			const said = (text: string, file?: string) => ({ content: [{ type: "text" as const, text }], details: file ? { path: file } : undefined, ...(file ? {} : { isError: true }) });
			const refs = replyRefs(work());
			if (!refs.length) return said("There is nobody to send the file to: this run answers no message from a channel (it was typed in the terminal, or the owner took it over there). Say where the file is instead.");
			const ok = sendable(String(params.path ?? ""), c?.cwd ?? process.cwd(), path.dirname(portDir));
			if ("why" in ok) return said(`Not sent: ${ok.why}.`);
			emit({ type: "file", path: ok.file, refs });
			return said(`Sent ${ok.file} to the person you are answering.`, ok.file);
		},
	});

	pi.on("message_start", async (event) => {
		guarded("message_start", () => {
			const m = event.message as unknown as { role: string; customType?: string; details?: Details; content: Content };
			if (m.role === "custom" && m.customType === MESSAGE && m.details?.id) {
				handed.delete(m.details.id);
				stuck.delete(m.details.id);
				starting = 0;
				unconfirmed.add(m.details.id);
			} else if (m.role === "custom" && m.customType === RESTARTED) starting = 0;
			else if (m.role === "user") emit({ type: "input", source: "terminal", text: textOf(m.content) });
		})();
	});

	pi.on("message_end", async (event) => {
		guarded("message_end", () => {
			const m = event.message as unknown as { role: string; content: Content; stopReason?: string; errorMessage?: string };
			// pi stores a message right after every message_end handler is done: check what reached the session then.
			setImmediate(confirm);
			if (m.role !== "assistant") return;
			// Read from the session (this message is not in it yet): a reply answers the run's port message. After
			// something typed in the terminal, it answers the terminal.
			const refs = replyRefs(work());
			const text = textOf(m.content).trim();
			if (text) {
				emit({ type: "message", text, refs });
				runError = undefined;
				lastError();
			}
			if (m.stopReason === "error") runError = explain(m.errorMessage, (m as { provider?: string }).provider); // said by settled, at the end
			// pi retried a passing error and the model answered: a file-only reply (no text above) must not keep it.
			else if (m.stopReason === "stop" || m.stopReason === "toolUse") runError = undefined;
		})();
	});

	pi.on("agent_start", async (_event, c) => {
		starting = 0;
		if (halt) {
			halt = false;
			c.abort();
		}
		if (working) return;
		working = true;
		emit({ type: "status", state: "working" });
	});

	pi.on("agent_settled", async (event) => {
		guarded("agent_settled", () => {
			toolsSettled();
			working = false;
			starting = 0;
			halt = false;
			typedStart = false;
			confirm();
			// A question asked for this run waits for nothing any more.
			for (const q of [...questions.values()]) if (q.inRun) q.end(undefined, "interrupted");
			// pi is being stopped: a stop on purpose closed the run already; otherwise it resumes at the next start.
			if (signalled) return;
			close(work(), event.aborted ? "the work was stopped before these messages were answered" : "the agent finished without answering these messages", SETTLED);
			emit({ type: "status", state: "idle" });
			setImmediate(() => {
				confirm();
				deliver();
			});
		})();
	});

	pi.on("ui_prompt_start", async (event) => {
		prompting = true;
		emit({ type: "status", state: "blocked", kind: event.kind, ...(event.title ? { question: event.title } : {}) });
		guarded("blocked", tellBlocked)();
	});
	pi.on("ui_prompt_end", async () => {
		prompting = false;
		alone = 0;
		emit({ type: "status", state: working ? "working" : "idle" });
	});

	// Closing the terminal or stopping the agent makes pi abort its run. Stopped on purpose (the mark of "pi-personal
	// stop"), the run is closed now and its senders told; otherwise it is left as it is, cut off, and the next start
	// resumes it.
	for (const sig of ["SIGHUP", "SIGTERM"] as const)
		process.once(sig, () => {
			try {
				if (!ctx || signalled) return;
				signalled = true;
				const w = work();
				if (fs.existsSync(stopped) && (working || w.run.length)) close(w, "the agent was stopped before answering these messages", STOPPED);
			} catch {}
		});

	pi.on("session_shutdown", async () => {
		confirm();
		for (const q of [...questions.values()]) q.end(undefined); // the next `started` says they are closed
		prompting = false;
		watcher?.close();
		watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (soon) clearTimeout(soon);
		soon = undefined;
		ctx = undefined;
	});
}
