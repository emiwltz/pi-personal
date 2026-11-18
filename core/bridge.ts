// The bridge: the one piece of Pi-Personal that runs inside pi. It connects the port to the conversation.
//
// In:  one port message, one run. The bridge keeps its own queue (the port's inbox) and, when pi is idle, starts a run
//      with the oldest message. Messages that arrive while pi works wait their turn, in the order they were written:
//      a reply never reaches someone it was not meant for, and every message gets its own. Nothing of ours waits in
//      pi's own queues, where an abort could drop or keep it.
//      Each message goes in as a custom message (customType "pi-personal.message") carrying its id in its details:
//      the model reads it as a user message, and the session itself records which messages were taken in.
//      A message is moved to taken/ and reported "taken" only once its entry is in the session file on disk.
// Out: every assistant text message, the end of each run (settled, with the error when the message got no reply),
//      trouble that does not end a run (error), status changes and typed input become port events. Who a reply is
//      for is read from the session itself (openWork).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND } from "./name.ts";
import { filesIn } from "./paths.ts";
import * as port from "./port.ts";

const MESSAGE = "pi-personal.message";
const NOTE = "pi-personal.restarted";
const SETTLED = "pi-personal.settled"; // a run ended (finished, or aborted by a person): what came before is closed
const STOPPED = "pi-personal.stopped"; // the user stopped the agent on purpose: do not resume
const RETRY_STEPS_MS = [10_000, 30_000, 60_000, 300_000]; // a message pi did not start a run with (no model, no key...)

type Content = string | { type: string; text?: string }[] | undefined;
const textOf = (content: Content) =>
	typeof content === "string" ? content : (content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

/** What the agent sees for a port message: its text as the channel wrote it, and the paths of its attachments. */
function compose(msg: port.Message): string {
	if (!msg.attachments?.length) return msg.text;
	const files = msg.attachments.map((a) => `- ${a}`).join("\n");
	return `${msg.text}${msg.text ? "\n\n" : ""}Attached files:\n${files}`;
}

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
type Details = { id: string; from?: port.From; conversation?: string };
const isOurs = (e: Entry) => e.type === "custom_message" && e.customType === MESSAGE && typeof e.details?.id === "string";
const isMark = (e: Entry, kind: string) => e.type === "custom" && e.customType === kind;
const refOf = (d: Details): port.Ref => ({ id: d.id, ...(d.from ? { from: d.from } : {}), ...(d.conversation !== undefined ? { conversation: d.conversation } : {}) });
const convOf = (m: { conversation?: string }) => m.conversation ?? "";

export interface Work {
	run: port.Ref[]; // the port messages of the last run: everything since it began
	unanswered: port.Ref[]; // those placed since the run's last reply
	typed: boolean; // something was typed in the terminal during this run: the rest of the run is the terminal's
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
	let last: string | undefined; // what the run did last: "done" when the agent's final message ended it normally
	// pi writes the end of an aborted step (a tool result, an aborted answer) after the STOPPED mark: that tail
	// belongs to the stopped run. A new run begins with new input only.
	let tail = start > 0 && isMark(branch[start - 1], STOPPED);
	for (const e of branch.slice(start)) {
		const input = isOurs(e) || (e.type === "custom_message" && e.customType === NOTE) || (e.type === "message" && e.message?.role === "user");
		if (tail && !input) continue;
		tail = false;
		if (isOurs(e)) {
			run.push(refOf(e.details));
			unanswered.push(refOf(e.details));
			last = "message";
		} else if (e.type === "custom_message" && e.customType === NOTE) last = "message";
		else if (e.type === "message" && ["user", "assistant", "toolResult"].includes(e.message?.role)) {
			const m = e.message;
			if (m.role === "user") typed = true; // the owner took over in the terminal: never undone within the run
			last = m.role === "assistant" && m.stopReason === "stop" ? "done" : m.role;
			if (m.role === "assistant" && textOf(m.content).trim() && !typed) unanswered = [];
		}
	}
	return { run, unanswered, typed, cutOff: last !== undefined && last !== "done" };
}

/** A reply goes to one conversation only, whatever happened before: the last one these messages belong to. */
const oneConversation = (refs: port.Ref[]) => refs.filter((r) => convOf(r) === convOf(refs.at(-1) ?? {}));
/** Refs grouped by conversation, in order: every event names one conversation only. */
const byConversation = (refs: port.Ref[]) => {
	const groups = new Map<string, port.Ref[]>();
	for (const r of refs) groups.set(convOf(r), [...(groups.get(convOf(r)) ?? []), r]);
	return [...groups.values()];
};

export default function bridge(pi: ExtensionAPI) {
	const portDir = process.env.PI_PERSONAL_PORT;
	if (!portDir) throw new Error("PI_PERSONAL_PORT is not set: the Pi-Personal bridge only runs under the Pi-Personal runner");
	let safeMode: string[] | null = null; // the extensions turned off, when the runner started pi in safe mode
	try {
		safeMode = process.env.PI_PERSONAL_SAFE_MODE ? JSON.parse(process.env.PI_PERSONAL_SAFE_MODE) : null;
	} catch {}
	const restarted = process.env.PI_PERSONAL_RESTARTED || "";
	const { stopped, wasStopped, lastError: lastErrorFile } = filesIn(path.dirname(portDir));
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
	const unconfirmed = new Set<string>(); // placed, not yet known to be on disk
	const stuck = new Map<string, { tries: number; next: number }>(); // pi did not start a run with them
	const parsed = new Map<string, { mtime: bigint; msg: port.Message }>(); // inbox files already read, until they change
	let runError: string | undefined; // the model request failed (pi may still retry it within the run)
	let working = false; // between agent_start and agent_settled
	let starting = false; // a run was requested and has not started yet
	let startingAt = 0;
	let signalled = false; // pi is being stopped: the run is closed (on purpose) or left to resume (otherwise)
	let watcher: fs.FSWatcher | undefined;
	let timer: NodeJS.Timeout | undefined;
	let soon: NodeJS.Timeout | undefined;

	const entries = (): Entry[] => (ctx?.sessionManager.getEntries() ?? []) as unknown as Entry[];
	const work = (): Work => openWork((ctx?.sessionManager.getBranch() ?? []) as unknown as Entry[]);
	const inSession = (id: string) => entries().some((e) => isOurs(e) && e.details.id === id);
	const sessionFile = () => (ctx?.sessionManager as { getSessionFile?: () => string | undefined } | undefined)?.getSessionFile?.();

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
		emit({ type: "error", error, retryAt: new Date(retryAt).toISOString(), refs: [msg ? refOf({ id, from: msg.from, conversation: msg.conversation }) : { id }] });
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
		const file = sessionFile();
		// pi writes its session file only once it holds a user or assistant message; then every entry is appended at once.
		if (!file || !fs.existsSync(file)) return;
		const stored = [...unconfirmed].filter(inSession);
		if (!stored.length) return;
		try {
			const fd = fs.openSync(file, "r"); // make the session's entries durable before saying "taken"
			fs.fsyncSync(fd);
			fs.closeSync(fd);
		} catch {}
		const details = new Map<string, Details>();
		for (const e of entries()) if (isOurs(e)) details.set(e.details.id, e.details);
		for (const id of stored) {
			unconfirmed.delete(id);
			known.set(id, Date.now());
			port.take(portDir, id);
			emit({ type: "taken", id, refs: [refOf(details.get(id) ?? { id })] }); // like every event about a message
		}
	});

	/**
	 * Messages waiting in the inbox that may be handed to pi now: the oldest of each conversation, oldest first.
	 * Settles duplicates and broken files. A file is read once, and again only if it changes: a burst of thousands of
	 * messages costs a listing of the inbox, not thousands of reads, each time.
	 */
	const ready = (): port.Message[] => {
		const out: port.Message[] = [];
		const held = new Set<string>(); // conversations with an earlier message still waiting: nothing passes it
		const seen = new Set<string>();
		const now = Date.now();
		for (const p of port.pending(portDir)) {
			seen.add(p.id);
			if (handed.has(p.id) || unconfirmed.has(p.id)) continue;
			const inSessionSince = known.get(p.id);
			if (inSessionSince !== undefined) {
				// Already in the session: written before it was taken in, it is a copy a crash left before it was moved;
				// written after, it is the same id sent again (its taken/ file was cleaned up): a duplicate.
				port.take(portDir, p.id);
				if (Number(p.mtime / 1_000_000n) > inSessionSince) emit({ type: "duplicate", id: p.id });
				else {
					const d = entries().find((e) => isOurs(e) && e.details.id === p.id)?.details as Details | undefined;
					emit({ type: "taken", id: p.id, refs: [refOf(d ?? { id: p.id })] });
				}
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
				parsed.set(p.id, { mtime: p.mtime, msg });
			}
			const conv = convOf(msg);
			const s = stuck.get(p.id);
			if (held.has(conv) || (s && s.next > now)) {
				held.add(conv);
				continue;
			}
			out.push(msg);
			held.add(conv);
		}
		for (const id of parsed.keys()) if (!seen.has(id)) parsed.delete(id);
		return out;
	};

	const hand = (msg: port.Message) => {
		if (known.has(msg.id)) return; // never twice into the session
		handed.set(msg.id, Date.now());
		const details: Details = refOf(msg);
		pi.sendMessage({ customType: MESSAGE, content: compose(msg), display: true, details }, { triggerTurn: true });
	};

	/** When pi is idle: start a run with the oldest message. */
	const deliver = guarded("deliver", () => {
		const c = ctx;
		if (!c || signalled || working || starting || handed.size || !c.isIdle()) {
			if (c) ready(); // still settle duplicates and broken files at once
			return;
		}
		const first = ready()[0];
		if (!first) return;
		starting = true;
		startingAt = Date.now();
		hand(first);
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
		if (starting && !handed.size && now - startingAt > RETRY_STEPS_MS[0]) starting = false; // the restart note never started a run
		for (const [id, at] of [...handed]) {
			if (now - at < RETRY_STEPS_MS[0]) continue;
			handed.delete(id);
			starting = false;
			if (inSession(id)) {
				unconfirmed.add(id); // it did get in
				continue;
			}
			retryLater(id, "the agent did not start working on this message");
		}
	});

	const tick = guarded("tick", () => {
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
			starting = false;
			signalled = false;
			runError = undefined;
			for (const e of c.sessionManager.getEntries() as unknown as Entry[]) if (isOurs(e)) known.set(e.details.id, Date.parse(e.timestamp) || 0);
			emit({ type: "started", pid: process.pid, safeMode });
			if (event.reason !== "startup") return;
			const w = work();
			// Stopped on purpose while pi was down (after a crash, or while it waited to retry): close, never resume.
			const afterStop = fs.existsSync(wasStopped);
			fs.rmSync(wasStopped, { force: true });
			if (w.cutOff && afterStop) close(w, "the agent was stopped before answering these messages", STOPPED);
			else if (w.cutOff) {
				// Work cut off by a crash or a stop that was not on purpose: ask the agent to continue it first.
				// Its reply goes to the message of that run; messages that waited come next.
				starting = true;
				startingAt = Date.now();
				pi.sendMessage(
					{
						customType: NOTE,
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

	pi.on("message_start", async (event) => {
		guarded("message_start", () => {
			const m = event.message as unknown as { role: string; customType?: string; details?: Details; content: Content };
			if (m.role === "custom" && m.customType === MESSAGE && m.details?.id) {
				handed.delete(m.details.id);
				stuck.delete(m.details.id);
				starting = false;
				unconfirmed.add(m.details.id);
			} else if (m.role === "custom" && m.customType === NOTE) starting = false;
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
			const w = work();
			const refs = w.typed ? [] : oneConversation(w.unanswered.length ? w.unanswered : w.run);
			const text = textOf(m.content).trim();
			if (text) {
				emit({ type: "message", text, refs });
				runError = undefined;
				lastError();
			}
			if (m.stopReason === "error") runError = explain(m.errorMessage, (m as { provider?: string }).provider); // said by settled, at the end
		})();
	});

	pi.on("agent_start", async () => {
		starting = false;
		if (working) return;
		working = true;
		emit({ type: "status", state: "working" });
	});

	pi.on("agent_settled", async (event) => {
		guarded("agent_settled", () => {
			working = false;
			starting = false;
			confirm();
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
		emit({ type: "status", state: "blocked", kind: event.kind, ...(event.title ? { question: event.title } : {}) });
	});
	pi.on("ui_prompt_end", async () => {
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
		watcher?.close();
		watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (soon) clearTimeout(soon);
		soon = undefined;
		ctx = undefined;
	});
}
