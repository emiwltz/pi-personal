// Start, stop and inspect agents and their channels in Herdr Core. Pi-Personal only ever touches terminals it
// created: it finds them by the labels it set (the agent, the private area it belongs to, the channel or the
// agent role), never by guessing.
import * as fs from "node:fs";
import * as path from "node:path";
import { type Agent, type AgentRecord, channels, labels, preparePi, list, load, loadRecord, ownLabels, readSettings, type Settings, terminalName } from "./agents.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, SLUG } from "./name.ts";
import { home, ROOT } from "./paths.ts";
import * as port from "./port.ts";
import { lockFile, lockHolder, readKeeper, writeKeeper } from "./runner.ts";

/** The keeper's log: every action it takes, in plain text. */
export function note(agent: AgentRecord, text: string): void {
	try {
		fs.appendFileSync(agent.paths.log, `${new Date().toISOString()} [${agent.name}] ${text}\n`, { mode: 0o600 });
	} catch {}
}

/** Record a fact on the port; never fails a command because the port cannot be written. */
function fact(agent: AgentRecord, e: port.PortEvent): void {
	try {
		port.append(agent.paths.port, e);
	} catch (err) {
		note(agent, `could not write to the port: ${(err as Error).message}`);
	}
}

function matches(t: herdr.Terminal, want: Record<string, string>): boolean {
	return Object.entries(want).every(([k, v]) => t.labels?.[k] === v);
}

/** The labels that make a terminal ours: agent, private area, and the channel or the agent role. */
function identity(agent: AgentRecord, channel?: string): Record<string, string> {
	const { where: _where, ...id } = labels(agent, channel);
	return id;
}

/** The live terminal running this agent (or channel), if any. */
export function find(agent: AgentRecord, channel?: string): herdr.Terminal | undefined {
	const want = identity(agent, channel);
	for (const x of herdr.ls(want)) {
		if (x.state !== "live") continue;
		const t = herdr.get(x.address);
		if (t && t.state === "live" && matches(t, want)) return t;
	}
	return undefined;
}

/** All live terminals of this agent (itself and its channels) belonging to this private area. */
function own(name: string): herdr.Terminal[] {
	const want = ownLabels(name);
	return herdr
		.ls(want)
		.map((x) => herdr.get(x.address))
		.filter((t): t is herdr.Terminal => !!t && t.state === "live" && matches(t, want));
}

function launch(agent: Agent, channel?: string): herdr.Terminal {
	// Programs in Herdr Core get the core's environment, not ours. Give the runner (and so pi and the channels) the
	// private area and our PATH, so the agent can run what we can: hc, node, pi-personal.
	const argv = ["/usr/bin/env", `${ENV}_HOME=${home()}`, `PATH=${process.env.PATH ?? ""}`, process.execPath, path.join(ROOT, "core", "cli.ts"), "_run", agent.name, ...(channel ? [channel] : [])];
	const t = herdr.run({ name: terminalName(agent.name, channel), cwd: fs.existsSync(agent.folder) ? agent.folder : home(), labels: labels(agent, channel), argv });
	note(agent, `started ${channel ? `channel ${channel}` : "the agent"} in terminal ${t.address}`);
	return t;
}

export interface UpResult {
	agent: string;
	started: string[]; // "agent" or channel names
	running: string[];
	elsewhere: string[]; // running in another terminal or Herdr Core (its runner holds the lock)
	stoppedChannels: string[];
	skipped?: string;
	error?: string;
}

/** Make sure what should run is running. Idempotent: it starts what is missing and touches nothing else. */
export function up(name: string): UpResult {
	const agent = load(name);
	preparePi(); // agents made by an older version get what pi's shared settings now hold, at their next start
	const r: UpResult = { agent: name, started: [], running: [], elsewhere: [], stoppedChannels: [] };
	const stopped = () => fs.existsSync(agent.paths.stopped);
	if (stopped()) {
		r.skipped = "stopped on purpose";
		return r;
	}
	const ended = cleanFinished(agent);
	const enabled = channels(agent).map((c) => c.name);
	for (const ch of [undefined, ...enabled]) {
		if (find(agent, ch)) {
			r.running.push(ch ?? "agent");
			continue;
		}
		const holder = lockHolder(lockFile(agent, ch));
		if (holder) {
			r.elsewhere.push(`${ch ?? "agent"} (runner pid ${holder.pid})`);
			continue;
		}
		if (stopped()) break; // a stop arrived meanwhile: it wins
		// Coming back after its terminal ended (a reboot, a killed runner)? Say so, with the reason Herdr gives.
		const kept = readKeeper(agent, ch);
		const why = ended.get(ch ?? "") ?? (kept?.running ? "its terminal was gone" : undefined);
		if (why) {
			const reason = `started again by up: ${why}`;
			fact(agent, { type: "restarted", reason, ...(ch ? { channel: ch } : {}) });
			writeKeeper(agent, ch, { ...(kept ?? { safeMode: null, failed: null }), running: false, lastRestart: { at: new Date().toISOString(), reason } });
			note(agent, `${ch ? `channel ${ch}` : "the agent"} was not running (${why}): starting it again`);
		}
		try {
			launch(agent, ch);
		} catch (err) {
			// Another command started it a moment ago (two shells, or the login service): it runs, which is what was asked.
			if (err instanceof herdr.HerdrError && /already named/i.test(err.message) && find(agent, ch)) {
				r.running.push(ch ?? "agent");
				continue;
			}
			throw err;
		}
		r.started.push(ch ?? "agent");
	}
	// Channels that were turned off in the settings: stop their terminals.
	for (const t of own(name)) {
		const ch = t.labels?.[`${SLUG}.channel`];
		if (ch && !enabled.includes(ch)) {
			herdr.kill(t.address);
			herdr.rm(t.address);
			fact(agent, { type: "stopped", channel: ch });
			note(agent, `stopped channel ${ch}: it is no longer enabled`);
			r.stoppedChannels.push(ch);
		}
	}
	return r;
}

export function upAll(): UpResult[] {
	return list().map((n) => {
		try {
			return up(n);
		} catch (err) {
			const message = (err as Error).message;
			try {
				const agent = loadRecord(n);
				// Already running with the settings it read before: say so, the fix applies at its next start.
				if (find(agent)) return { agent: n, started: [], running: ["agent"], elsewhere: [], stoppedChannels: [], skipped: `running; its settings cannot be read now: ${message}` };
				note(agent, `could not start: ${message}`);
			} catch {}
			return { agent: n, started: [], running: [], elsewhere: [], stoppedChannels: [], error: message };
		}
	});
}

/**
 * Start an agent and its channels, then watch for a few seconds what really happened: pi reaching the port,
 * or stopping at once. Reports what was observed, never what was assumed.
 */
export async function start(name: string, waitMs = 30_000): Promise<UpResult & { ready: boolean | undefined; trouble?: string }> {
	const agent = load(name);
	// Stopped on purpose before: tell the bridge once, at its next start, so work that was open is closed, not resumed
	// (pi may have been down when the stop came, after a crash or while waiting to retry).
	if (fs.existsSync(agent.paths.stopped)) fs.renameSync(agent.paths.stopped, agent.paths.wasStopped);
	let pos = port.end(agent.paths.port);
	const r = up(name);
	if (!r.started.includes("agent")) return { ...r, ready: undefined };
	const until = Date.now() + waitMs;
	const evs: port.Seen[] = [];
	while (Date.now() < until) {
		const batch = port.events(agent.paths.port, pos);
		pos = batch.next;
		evs.push(...batch.events.filter((e) => !e.channel));
		if (evs.some((e) => e.type === "started")) return { ...r, ready: true };
		// The runner's own restarts (not the note up writes before it launches a terminal that had ended).
		const bad = evs.find((e) => e.type === "failed" || e.type === "safe_mode" || (e.type === "restarted" && !String(e.reason).startsWith("started again by up")));
		if (bad?.type === "safe_mode") return { ...r, ready: false, trouble: `it runs in safe mode: ${bad.reason}` };
		if (bad) return { ...r, ready: false, trouble: `pi stopped while starting (${bad.reason}); the keeper keeps trying: ${COMMAND} status ${name}` };
		if (!find(agent)) return { ...r, ready: false, trouble: `it stopped at once; see: ${COMMAND} log ${name}` };
		await new Promise((res) => setTimeout(res, 300));
	}
	return { ...r, ready: false, trouble: `pi has not reported ready after ${waitMs / 1000} s; see: ${COMMAND} log ${name}` };
}

/**
 * Stop the agent and its channels, and remember that the user wants it stopped: "up" and the login service leave it
 * alone until "start". The bridge reads the same mark when pi gets the signal: work stopped on purpose is not resumed.
 * Returns once the terminals have ended, so a start right after finds their names free.
 */
export async function stop(name: string): Promise<string[]> {
	const agent = loadRecord(name);
	const mine = own(name);
	// The runner holding the lock is not one of ours: the agent runs elsewhere (ours, if any, only waits for the lock).
	const holder = lockHolder(lockFile(agent));
	if (holder && !mine.some((t) => t.pid === holder.pid))
		throw new Error(`${name} runs in another terminal or Herdr Core (runner pid ${holder.pid}): stop it from there`);
	fs.writeFileSync(agent.paths.stopped, `${new Date().toISOString()}\n`);
	const ended: string[] = [];
	for (const t of mine) {
		try {
			herdr.kill(t.address);
		} catch (err) {
			if (herdr.get(t.address)?.state === "live") throw err; // it ended meanwhile: that is what was wanted
		}
		const ch = t.labels?.[`${SLUG}.channel`];
		fact(agent, ch ? { type: "stopped", channel: ch } : { type: "stopped" });
		ended.push(ch ?? "agent");
	}
	const until = Date.now() + 15_000;
	while (Date.now() < until && mine.some((t) => herdr.get(t.address)?.state === "live")) await new Promise((r) => setTimeout(r, 200));
	for (const t of mine) herdr.rm(t.address);
	if (ended.length) note(agent, `stopped ${ended.join(", ")} (it stays stopped until started again)`);
	return ended;
}

/** Stop and start again. A settings file that cannot be read stops nothing: the agent keeps running as it is. */
export async function restart(name: string) {
	try {
		load(name);
	} catch (err) {
		throw new Error(`${(err as Error).message}; nothing was stopped: fix it, then restart again`);
	}
	await stop(name);
	return start(name);
}

/** Remove our own finished terminals, so they do not pile up in Herdr; return why each ended, by channel ("" = agent). */
function cleanFinished(agent: AgentRecord): Map<string, string> {
	const want = ownLabels(agent.name);
	const why = new Map<string, string>();
	for (const x of herdr.ls(want, true)) {
		if (x.state !== "finished") continue;
		const t = herdr.get(x.address);
		if (!t || !matches(t, want)) continue;
		const detail = [t.reason, t.signal ? `signal ${t.signal}` : t.exit_code != null ? `exit code ${t.exit_code}` : ""].filter(Boolean).join(", ");
		why.set(t.labels?.[`${SLUG}.channel`] ?? "", `its terminal ended (${detail || "no reason given"})`);
		herdr.rm(t.address);
	}
	return why;
}

export interface ProgramStatus {
	running: boolean; // its terminal is live
	address?: string;
	state: string; // working, idle, blocked (waiting for a person), failed, starting, running (a channel), stopped, not running
	question?: string;
	lastRestart?: { at: string; reason: string };
	failed?: { at: string; reason: string; retryAt: string };
	lastError?: { at: string; error: string };
	elsewhere?: number; // the pid of its runner, when it runs in another terminal or Herdr Core
}
export interface AgentStatus extends ProgramStatus {
	name: string;
	folder: string;
	model?: string;
	stoppedOnPurpose: boolean;
	safeMode: { off: string[]; broken: string[]; reason: string } | null;
	pending: number;
	settingsError?: string;
	problems?: string[];
	channels: (ProgramStatus & { name: string })[];
}

export function status(name: string): AgentStatus {
	const agent = loadRecord(name);
	let settings: Settings | undefined;
	let settingsError: string | undefined;
	try {
		settings = readSettings(agent.folder);
	} catch (err) {
		settingsError = (err as Error).message;
	}
	const stoppedOnPurpose = fs.existsSync(agent.paths.stopped);
	// What the keeper wrote down (keeper.json), and what Herdr Core says of the terminal.
	const program = (channel?: string): ProgramStatus => {
		const k = readKeeper(agent, channel);
		const holder = lockHolder(lockFile(agent, channel));
		let t = find(agent, channel);
		if (t && holder && t.pid !== holder.pid) t = undefined; // our terminal only waits: it runs elsewhere
		const s: ProgramStatus = { running: !!t, state: t ? "starting" : stoppedOnPurpose ? "stopped" : "not running" };
		if (t) {
			s.address = t.address;
			// pi says "error" after a request that failed; it is still up and ready: the error itself is in lastError.
			if (t.status?.state) s.state = ["done", "error"].includes(t.status.state) && !channel ? "idle" : t.status.state;
			else if (channel) s.state = "running"; // a channel reports no status of its own
			if (t.status?.state === "blocked" && t.status.msg) s.question = t.status.msg;
			if (k?.failed) {
				s.failed = k.failed;
				s.state = "failed";
			}
		} else if (holder) {
			s.state = "running elsewhere";
			s.elsewhere = holder.pid;
		}
		if (k?.lastRestart) s.lastRestart = k.lastRestart;
		return s;
	};
	const main = program();
	const kept = readKeeper(agent);
	let lastError: ProgramStatus["lastError"];
	try {
		lastError = JSON.parse(fs.readFileSync(agent.paths.lastError, "utf8")); // written by the bridge
	} catch {}
	return {
		name,
		folder: agent.folder,
		...(settings?.model ? { model: settings.model } : {}),
		...main,
		...(lastError ? { lastError } : {}),
		stoppedOnPurpose,
		safeMode: main.running && kept?.safeMode ? kept.safeMode : null,
		pending: port.pending(agent.paths.port).length,
		...(settingsError ? { settingsError } : {}),
		...(settings?.problems ? { problems: settings.problems } : {}),
		channels: settings ? channels({ settings }).map((c) => ({ name: c.name, ...program(c.name) })) : [],
	};
}
