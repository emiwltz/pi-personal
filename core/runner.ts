// The runner: lives in a Pi-personal terminal of Herdr Core, runs one program (an agent's pi, or a channel),
// and brings it back when it ends. It keeps the restart rules (docs/decisions/0002-keeper.md):
// backoff, give up after 5 quick failures, try again every hour, safe mode for in-agent extensions.
// What it knows (ready, safe mode, failed, last restart) it keeps in keeper.json, which "pp status" reads.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type Agent, type AgentRecord, channels, load } from "./agents.ts";
import { ENV, SETTINGS_FILE } from "./name.ts";
import { piDir, ROOT } from "./paths.ts";
import * as port from "./port.ts";

export const LIMIT = 5; // failed starts...
const WINDOW_MS = Number(process.env[`${ENV}_WINDOW_MS`] ?? 10 * 60_000); // ...within this window
export const RETRY_MS = Number(process.env[`${ENV}_RETRY_MS`] ?? 60 * 60_000); // then one attempt per hour
const STARTUP_MS = Number(process.env[`${ENV}_STARTUP_MS`] ?? 120_000); // pi must reach the port within this time
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const KEEP_DAYS = 30; // taken/ and rejected/ files older than this are removed (the session still knows the ids)

/** The folder of the pi package Pi-personal pins (never the user's own `pi`). */
export function piPackage(): { dir: string; version: string; bin: string } {
	// The package only exports for `import`, so resolve it the way an import would.
	let dir = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	for (;;) {
		const file = path.join(dir, "package.json");
		if (fs.existsSync(file)) {
			const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
			if (pkg.name === "@earendil-works/pi-coding-agent") return { dir, version: pkg.version, bin: typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi };
		}
		const up = path.dirname(dir);
		if (up === dir) throw new Error("pi is not installed next to Pi-personal: run the installer again");
		dir = up;
	}
}

/** pi's command line entry. */
export function piCli(): string {
	const p = piPackage();
	return path.join(p.dir, p.bin);
}

/** The environment pi runs with: Pi-personal's shared pi configuration, this agent's own conversation logs. */
function piEnv(agent: Agent): NodeJS.ProcessEnv {
	return {
		...process.env,
		PI_CODING_AGENT_DIR: piDir(),
		PI_CODING_AGENT_SESSION_DIR: agent.paths.sessions,
		PI_SKIP_VERSION_CHECK: "1", // Pi-personal pins pi; updating it is Pi-personal's job
		PI_TELEMETRY: "0",
	};
}

/** pi's own place for an agent's extensions: <folder>/.pi/extensions/<name>. Pi-personal keeps no list of its own. */
export const extensionsDir = (agent: AgentRecord) => path.join(agent.folder, ".pi", "extensions");
export const extensionPath = (agent: AgentRecord, name: string) => path.join(extensionsDir(agent), name);
/** What pi loads from .pi/extensions/: .ts and .js files, and folders with an index.ts, an index.js or a package.json. */
export function foundExtensions(agent: AgentRecord): string[] {
	const dir = extensionsDir(agent);
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
			if (d.name.startsWith(".")) return [];
			if (d.isFile()) return /\.(ts|js)$/.test(d.name) ? [d.name] : [];
			return ["index.ts", "index.js", "package.json"].some((f) => fs.existsSync(path.join(dir, d.name, f))) ? [d.name] : [];
		});
	} catch {
		return [];
	}
}

/**
 * Start pi once without a model, a session or a screen, ask it for its state, and see whether it answers: a positive
 * sign that it got through loading. With `only`, it loads that one extension alone; with `all`, everything it finds for
 * this agent (.pi/extensions, packages, MCP servers); otherwise nothing but pi (`-ne`). `failing` lists the extensions
 * pi names as failing to load (by folder name when they are in .pi/extensions).
 */
export function dryStart(agent: Agent, what: { all: true } | { only: string } | { none: true }): { ok: boolean; failing: string[]; error: string } {
	if (!fs.existsSync(agent.folder)) return { ok: false, failing: [], error: `the agent's folder ${agent.folder} is missing` };
	const args = [piCli()]; // the bridge is left out: it is Pi-personal's own and always loads
	if ("only" in what) args.push("-ne", "-e", path.isAbsolute(what.only) ? what.only : extensionPath(agent, what.only));
	else if ("none" in what) args.push("-ne");
	if (agent.settings.model) args.push("--model", agent.settings.model); // pi checks the model while loading
	// In-agent extensions run with PI_PERSONAL_PORT (docs/port.md): give the check a throwaway port of its own.
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personal-check-"));
	const r = spawnSync(process.execPath, [...args, "--no-session", "--mode", "rpc"], {
		cwd: agent.folder,
		env: { ...piEnv(agent), PI_OFFLINE: "1", [`${ENV}_PORT`]: path.join(scratch, "port") },
		input: `${JSON.stringify({ type: "get_state" })}\n`,
		encoding: "utf8",
		timeout: 30_000,
		killSignal: "SIGKILL", // a pi blocked in a loop while loading cannot handle a gentler signal
	});
	fs.rmSync(scratch, { recursive: true, force: true });
	const out = `${r.stderr ?? ""}${r.stdout ?? ""}`;
	const answered = /"command"\s*:\s*"get_state"/.test(r.stdout ?? "") && /"success"\s*:\s*true/.test(r.stdout ?? "");
	const named = [...out.matchAll(/Failed to load extension "([^"]+)"/g)].map((m) => m[1]);
	// pi names a failing extension by its real path (on macOS /tmp is /private/tmp): compare real paths.
	const real = (p: string) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return path.resolve(p);
		}
	};
	const base = real(extensionsDir(agent));
	const nameOf = (p: string) => {
		const rel = path.relative(base, real(path.resolve(agent.folder, p)));
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : p;
	};
	const failing = [...new Set(named.map(nameOf))];
	const error = answered ? "" : (out.split("\n").find((l) => /error|fail/i.test(l)) ?? (r.error ? "it did not answer in time" : `it stopped (exit code ${r.status ?? r.signal}) without answering`)).trim().slice(0, 500);
	return { ok: answered, failing, error };
}

/**
 * Does pi know this model? Starts pi without extensions, a session or a screen: no network, no credentials needed.
 * An unknown provider is an error; an id pi does not know for a known provider is passed to the provider as it is
 * (pi warns), so it is only a warning.
 */
export function checkModel(model: string, cwd: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; warning?: string; error?: string } {
	const r = spawnSync(process.execPath, [piCli(), "-ne", "--no-session", "--mode", "rpc", "--model", model], {
		cwd,
		env: { ...env, PI_CODING_AGENT_DIR: piDir(env), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
		input: `${JSON.stringify({ type: "get_state" })}\n`,
		encoding: "utf8",
		timeout: 30_000,
		killSignal: "SIGKILL",
	});
	const out = `${r.stderr ?? ""}${r.stdout ?? ""}`;
	const warning = /Warning: (Model .* not found[^\n]*)/.exec(out)?.[1];
	if (/"command"\s*:\s*"get_state"/.test(r.stdout ?? "")) return { ok: true, ...(warning ? { warning } : {}) };
	return { ok: false, error: (/Error: ([^\n]*)/.exec(out)?.[1] ?? out.split("\n").find((l) => l.trim()) ?? "pi did not start").trim() };
}

/** Does this in-agent extension load? Starts pi with it alone, without a model, a session or a screen. */
export function checkExtension(agent: Agent, name: string): { ok: true } | { ok: false; error: string } {
	if (!fs.existsSync(extensionPath(agent, name))) return { ok: false, error: `${extensionPath(agent, name)} does not exist` };
	const r = dryStart(agent, { only: name });
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Why pi stops before it is ready. `broken`: the extensions to blame (empty when one could not be named);
 * `extensions`: true when they are the cause; `cause`: pi's own words when pi itself cannot start (a model it does
 * not know, a broken configuration), which no safe mode can help.
 */
function startFailure(agent: Agent): { extensions: boolean; broken: string[]; cause?: string } {
	const full = dryStart(agent, { all: true });
	if (full.ok) return { extensions: false, broken: [] }; // it loads here: the cause shows only in a real start
	if (full.failing.length) return { extensions: true, broken: full.failing };
	// pi stops or hangs while loading without naming anything: if it starts with no extension at all, one of them is the cause.
	const bare = dryStart(agent, { none: true });
	if (!bare.ok) return { extensions: false, broken: [], cause: bare.error || full.error };
	// Which one? Try each of the folder's extensions alone.
	return { extensions: true, broken: foundExtensions(agent).filter((e) => !dryStart(agent, { only: e }).ok) };
}

function logger(agent: Agent, channel?: string) {
	return (text: string) => {
		const line = `${new Date().toISOString()} [${channel ? `${agent.name}.${channel}` : agent.name}] ${text}\n`;
		try {
			fs.appendFileSync(agent.paths.log, line, { mode: 0o600 });
		} catch {}
		process.stderr.write(`\x1b[2m${line}\x1b[0m`);
	};
}

/** How a channel runs: its command, in its own private state folder, told where the port and its secrets are. */
export function channelProgram(agent: Agent, channel: string): Program {
	const ch = channels(agent, ROOT).find((c) => c.name === channel);
	if (!ch) throw new Error(`channel "${channel}" is not enabled for ${agent.name}`);
	const state = path.join(agent.paths.channels, channel);
	fs.mkdirSync(state, { recursive: true, mode: 0o700 });
	return {
		command: ch.command[0],
		args: ch.command.slice(1),
		cwd: state,
		env: {
			...process.env,
			[`${ENV}_AGENT`]: agent.name,
			[`${ENV}_CHANNEL`]: channel,
			[`${ENV}_PORT`]: agent.paths.port,
			[`${ENV}_STATE`]: state,
			[`${ENV}_SECRETS`]: agent.paths.secrets,
			[`${ENV}_SETTINGS`]: JSON.stringify(ch.settings),
		},
	};
}

export interface Program {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}

// ---- one runner per program ---------------------------------------------------------------------------------

export const lockFile = (agent: AgentRecord, channel?: string) =>
	channel ? path.join(agent.paths.channels, channel, "runner.lock") : path.join(agent.paths.dir, "runner.lock");

const readLock = (file: string): string | undefined => {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
};

/**
 * The live runner a lock's content names, if any. A lock left by a dead process does not count, nor one whose pid
 * now belongs to another process (after a reboot, for example): the holder is a Pi-personal runner that was already
 * running when the lock was written.
 */
function holderOf(raw: string): { pid: number } | undefined {
	let pid: number;
	let at: number;
	try {
		const lock = JSON.parse(raw);
		pid = Number(lock.pid);
		at = Date.parse(lock.at);
	} catch {
		return undefined;
	}
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
	try {
		process.kill(pid, 0);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return undefined;
	}
	const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart=,command="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
	if (r.status !== 0 || !/\b_run\b/.test(r.stdout)) return undefined;
	const started = Date.parse(r.stdout.trim().split(/\s+/).slice(0, 5).join(" ")); // "Mon Nov 16 15:47:12 2026", local time
	return Number.isFinite(started) && Number.isFinite(at) && started > at + 1000 ? undefined : { pid };
}

/** The live runner holding this lock, if any. */
export function lockHolder(file: string): { pid: number } | undefined {
	const raw = readLock(file);
	return raw === undefined ? undefined : holderOf(raw);
}

/** Take the lock if it is free (or stale). Two runners never run the same agent or channel, whatever the Herdr Core. */
function tryLock(file: string): boolean {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	for (let i = 0; i < 3; i++) {
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
		try {
			fs.linkSync(tmp, file);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		} finally {
			fs.rmSync(tmp, { force: true });
		}
		const seen = readLock(file);
		if (seen === undefined) continue; // released meanwhile
		if (holderOf(seen)) return false;
		// Left by a runner that died: move aside exactly the lock judged stale (only one process can move it). If what
		// was moved is another one (a runner that took over first), put it back and let that runner have it.
		const aside = `${file}.${process.pid}.stale`;
		try {
			fs.renameSync(file, aside);
		} catch {
			continue;
		}
		const moved = readLock(aside);
		if (moved !== seen) {
			try {
				fs.linkSync(aside, file);
			} catch {}
			fs.rmSync(aside, { force: true });
			return false;
		}
		fs.rmSync(aside, { force: true });
	}
	return false;
}

function releaseLock(file: string): void {
	try {
		if (Number(JSON.parse(fs.readFileSync(file, "utf8")).pid) === process.pid) fs.rmSync(file);
	} catch {}
}

/** What the keeper knows about its program. "pp status" reads it: nothing to search for in the events. */
export interface KeeperState {
	running: boolean; // a runner keeps it (false once it was stopped on request)
	pid?: number;
	readyAt?: string; // when the program last became ready
	safeMode: { off: string[]; broken: string[]; reason: string } | null;
	failed: { at: string; reason: string; retryAt: string } | null;
	lastRestart?: { at: string; reason: string };
}
const keeperFile = (agent: AgentRecord, channel?: string) => path.join(path.dirname(lockFile(agent, channel)), "keeper.json");
export function readKeeper(agent: AgentRecord, channel?: string): KeeperState | undefined {
	try {
		return JSON.parse(fs.readFileSync(keeperFile(agent, channel), "utf8"));
	} catch {
		return undefined;
	}
}
export function writeKeeper(agent: AgentRecord, channel: string | undefined, state: KeeperState): void {
	const file = keeperFile(agent, channel);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		fs.renameSync(`${file}.${process.pid}.tmp`, file);
	} catch {} // a full disk: status may be behind, the program runs on
}

/** Keep the private area from growing without end: the keeper's log, old taken/ and rejected/ files. */
function housekeeping(agent: Agent): void {
	try {
		if (fs.statSync(agent.paths.log).size > 5 * 1024 * 1024) fs.renameSync(agent.paths.log, `${agent.paths.log}.1`);
	} catch {}
	const limit = Date.now() - KEEP_DAYS * 86_400_000;
	for (const dir of ["taken", "rejected"].map((d) => path.join(agent.paths.port, d)))
		try {
			for (const f of fs.readdirSync(dir)) {
				const file = path.join(dir, f);
				if (fs.statSync(file).mtimeMs < limit) fs.rmSync(file, { force: true });
			}
		} catch {}
}

/** Status for Herdr Core while the program is down: the runner speaks OSC 7501 for it. */
function reportStatus(state: string, msg?: string): void {
	if (!process.stdout.isTTY) return;
	const fields = [`state=${state}`, "app=pi-personal"];
	if (msg) fields.push(`msg=${Buffer.from(msg).toString("base64")}`);
	process.stdout.write(`\x1b]7501;${fields.join(":")}\x1b\\`);
}

/** Run the agent's pi (channel undefined) or one of its channels, forever, in the current terminal. */
export async function runForever(agent: Agent, channel?: string): Promise<void> {
	const log = logger(agent, channel);
	port.ensurePort(agent.paths.port);
	const write = port.emitter(agent.paths.port, (m) => log(m));
	const emit = (e: port.PortEvent) => write(channel ? { ...e, channel } : e); // never throws
	let safe: { off: string[]; broken: string[]; reason: string } | null = null;
	let failures: number[] = [];
	let afterFailure = false; // the last start was the scheduled attempt after giving up
	let stopping = false;
	let child: ReturnType<typeof spawn> | undefined;
	let restartReason = "";
	const enabled = () => (channel ? [] : foundExtensions(agent));
	const lock = lockFile(agent, channel);
	const stoppedOnPurpose = () => fs.existsSync(agent.paths.stopped);
	const ks: KeeperState = { running: false, safeMode: null, failed: null };
	const save = () => writeKeeper(agent, channel, ks);
	const restarted = (reason: string) => {
		emit({ type: "restarted", reason });
		ks.lastRestart = { at: new Date().toISOString(), reason };
		save();
	};

	process.on("SIGINT", () => {}); // Ctrl+C in the terminal belongs to the program
	for (const sig of ["SIGTERM", "SIGHUP"] as const)
		process.on(sig, () => {
			stopping = true;
			if (ks.running) {
				ks.running = false;
				save();
			}
			child?.kill(sig);
			setTimeout(() => process.exit(0), 5000).unref();
		});
	process.on("exit", () => releaseLock(lock));

	// One runner per agent (and per channel), even across two Herdr Cores sharing this private area.
	for (let said = false; !tryLock(lock); said = true) {
		if (stoppedOnPurpose()) {
			log("stopped on purpose while waiting: not starting");
			return;
		}
		const h = lockHolder(lock);
		if (!said) {
			log(`already running in another terminal (runner pid ${h?.pid}); waiting until it stops`);
			reportStatus("error", `${channel ? `channel ${channel}` : agent.name} already runs elsewhere (pid ${h?.pid})`);
		}
		await sleep(15_000, () => stopping);
		if (stopping) return;
	}
	if (stoppedOnPurpose()) {
		log("stopped on purpose: not starting");
		return;
	}
	Object.assign(ks, { running: true, lastRestart: readKeeper(agent, channel)?.lastRestart });
	save();
	if (!channel) housekeeping(agent);

	const program = (): Program => {
		if (channel) return channelProgram(agent, channel);
		// Normally pi loads what it finds itself (.pi/extensions, packages, MCP servers) and the bridge; in safe mode,
		// only the bridge.
		const args = [piCli(), ...(safe ? ["-ne"] : []), "-e", path.join(ROOT, "core", "bridge.ts")];
		if (agent.settings.model) args.push("--model", agent.settings.model);
		if (hasSession(agent)) args.push("--continue");
		return {
			command: process.execPath,
			args,
			cwd: agent.folder,
			env: {
				...piEnv(agent),
				[`${ENV}_PORT`]: agent.paths.port,
				[`${ENV}_SAFE_MODE`]: safe ? JSON.stringify(safe.off) : "",
				[`${ENV}_RESTARTED`]: restartReason,
			},
		};
	};

	for (;;) {
		// Each start reads the settings again, so a fix to pi-personal.json applies at the next start.
		try {
			agent = load(agent.name);
		} catch (err) {
			log(`${SETTINGS_FILE} cannot be read (${(err as Error).message}); starting with the settings read before`);
		}
		// In safe mode, check before each start whether everything loads again: then leave it.
		if (safe && dryStart(agent, { all: true }).ok) {
			log(`the extensions load again: leaving safe mode`);
			safe = null;
		}
		const from = port.end(agent.paths.port);
		const t0 = Date.now();
		let result: { code: number | null; signal: NodeJS.Signals | null; pid?: number; spawnError?: string; hung?: boolean; ready?: boolean } = { code: null, signal: null };
		let p: Program | undefined;
		try {
			if (!channel && !fs.existsSync(agent.folder)) throw new Error(`the agent's folder ${agent.folder} is missing`);
			p = program();
		} catch (err) {
			result.spawnError = (err as Error).message;
		}
		if (p) {
			const prog = p;
			log(`starting ${channel ? `channel ${channel}` : "pi"}${safe ? ` in safe mode (without ${safe.off.join(", ")})` : ""}`);
			ks.safeMode = safe;
			save();
			result = await new Promise((resolve) => {
				let watchdog: NodeJS.Timeout | undefined;
				try {
					child = spawn(prog.command, prog.args, { cwd: prog.cwd, env: prog.env, stdio: "inherit" });
				} catch (err) {
					resolve({ code: null, signal: null, spawnError: (err as Error).message });
					return;
				}
				const pid = child.pid;
				let hung = false;
				let isReady = false;
				let troubledAt = 0;
				const ready = () => {
					isReady = true;
					Object.assign(ks, { pid, readyAt: new Date().toISOString(), failed: null });
					save();
				};
				if (channel && pid) {
					emit({ type: "started", pid });
					ready();
				}
				// pi that never reaches the port (an extension that hangs while loading) is stopped and counted as a failed start.
				if (!channel)
					watchdog = setInterval(() => {
						if (startedSince(agent, from, pid)) {
							ready();
							return clearInterval(watchdog);
						}
						if (Date.now() - t0 < STARTUP_MS) return;
						// The port cannot be written (a full disk): pi's "started" may be waiting in its memory. Do not kill it for
						// that; once writing works again, give pi time to write what it kept.
						if (write.troubled()) troubledAt = Date.now();
						if (Date.now() - troubledAt < 10_000) return;
						clearInterval(watchdog);
						hung = true;
						log(`pi did not get ready within ${STARTUP_MS / 1000} s: stopping it`);
						child?.kill("SIGTERM");
						setTimeout(() => child?.kill("SIGKILL"), 5000).unref();
					}, 1000);
				child.on("error", (err) => {
					clearInterval(watchdog);
					resolve({ code: null, signal: null, pid, spawnError: err.message });
				});
				child.on("exit", (code, signal) => {
					clearInterval(watchdog);
					resolve({ code, signal, pid, hung, ready: isReady });
				});
			});
		}
		child = undefined;
		if (stopping) {
			log("stopped on request");
			return;
		}
		const upMs = Date.now() - t0;
		let why = result.spawnError
			? `could not start: ${result.spawnError}`
			: result.hung
				? `did not get ready within ${STARTUP_MS / 1000} s`
				: result.signal
					? `killed by ${result.signal}`
					: result.code === 0
						? "exited normally"
						: `exited with code ${result.code}`;
		const reached = !channel && !result.spawnError && (result.ready || startedSince(agent, from, result.pid));
		// pi never reached the port: ask it why, once, without a model call (an extension, or pi itself).
		const failure = !channel && !reached && !result.spawnError ? startFailure(agent) : undefined;
		if (failure?.cause) why = `${why}: ${failure.cause}`;
		log(`${channel ? `channel ${channel}` : "pi"} ${why} after ${Math.round(upMs / 1000)} s`);

		if (reached) afterFailure = false; // the scheduled attempt got pi ready: it did not fail
		// Someone quit pi on purpose (/quit, Ctrl+D) after it had been up a while: start it again at once, not a failure.
		if (reached && result.code === 0 && !result.signal && upMs >= 10_000) {
			restartReason = "";
			restarted("pi was quit; started again");
			continue;
		}

		// pi does not load with its extensions, and does without them: safe mode. Only when the check shows it; a
		// failure the check cannot see is a plain failure (counted, then retried later), never a guess.
		if (failure?.extensions && !safe) {
			const reason = failure.broken.length ? `failing to load: ${failure.broken.join(", ")}` : "an extension stops or hangs pi while loading, and pi could not name it";
			safe = { off: enabled(), broken: failure.broken, reason };
			for (const e of failure.broken) log(`extension ${e} fails to load`);
			emit({ type: "safe_mode", extensions: failure.broken, off: safe.off, reason });
			log(`entering safe mode: starting with the bridge only (every extension off); ${reason}`);
			restartReason = why;
			restarted(`${why}; safe mode`);
			continue;
		}

		const now = Date.now();
		if (upMs >= WINDOW_MS) {
			failures = [];
			afterFailure = false;
		}
		failures = failures.filter((t) => now - t < WINDOW_MS);
		failures.push(now);
		restartReason = result.code === 0 ? "" : why;
		// Give up after LIMIT quick failures; after a scheduled attempt, one more failure is enough.
		if (failures.length >= LIMIT || afterFailure) {
			const retryAt = new Date(now + RETRY_MS).toISOString();
			const reason = afterFailure
				? `the scheduled attempt failed too: ${why}`
				: `${channel ? "channel" : "agent"} stopped ${LIMIT} times within ${Math.round(WINDOW_MS / 60_000)} min; last: ${why}`;
			emit({ type: "failed", reason, retryAt });
			ks.failed = { at: new Date(now).toISOString(), reason, retryAt };
			save();
			log(`giving up for now (${reason}); next attempt at ${retryAt}`);
			reportStatus("error", `${channel ? `channel ${channel}` : "agent"} failed: ${reason}; next attempt ${retryAt}`);
			await sleep(RETRY_MS, () => stopping);
			if (stopping) return;
			failures = [];
			afterFailure = true;
			ks.failed = null; // trying again: no longer given up (if this attempt fails too, it is marked again at once)
			restarted("scheduled attempt after failure");
			continue;
		}
		const delay = upMs > 60_000 ? 0 : BACKOFF_MS[Math.min(failures.length - 1, BACKOFF_MS.length - 1)];
		restarted(why);
		await sleep(delay, () => stopping);
		if (stopping) return;
	}
}

function hasSession(agent: Agent): boolean {
	try {
		const walk = (dir: string): boolean =>
			fs.readdirSync(dir, { withFileTypes: true }).some((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith(".jsonl")));
		return walk(agent.paths.sessions);
	} catch {
		return false;
	}
}

function startedSince(agent: Agent, from: port.Cursor, pid?: number): boolean {
	return port.events(agent.paths.port, from).events.some((e) => e.type === "started" && e.pid === pid && !e.channel);
}

async function sleep(ms: number, stop: () => boolean): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until && !stop()) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
}
