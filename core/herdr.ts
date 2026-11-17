// The few Herdr Core verbs Pi-personal uses: run, get, ls, kill, rm. Everything goes through the `hc` command,
// with the caller's environment, so the same code reaches the user's default core in real use and an
// isolated one in tests (HC_SESSION and the XDG directories select the instance).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ENV } from "./name.ts";

export interface Status {
	state: string;
	kind?: string;
	app?: string;
	msg?: string;
}
export interface Terminal {
	address: string;
	name?: string | null;
	state: "live" | "finished";
	labels?: Record<string, string>;
	pid?: number | null;
	status?: Status | null;
	exit_code?: number | null;
	signal?: number | null;
	reason?: string | null;
	turn?: number;
}

export class HerdrError extends Error {
	kind?: string;
	constructor(message: string, kind?: string) {
		super(message);
		this.kind = kind;
	}
}

/** Herdr Core's command: the one set for Pi-personal, else the one find() picks (looked up once), else plain hc. */
let found: string | undefined;
const bin = () => process.env[`${ENV}_HC`] || (found ??= find()?.bin ?? "hc");

function hc(args: string[]): any {
	let out: string;
	try {
		// --json is hc's own option: before "--", or it would be passed to the program run in the terminal.
		const sep = args.indexOf("--");
		const full = sep < 0 ? [...args, "--json"] : [...args.slice(0, sep), "--json", ...args.slice(sep)];
		out = execFileSync(bin(), full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
	} catch (err) {
		const e = err as { code?: string; stdout?: string; stderr?: string; message: string };
		if (e.code === "ENOENT") throw new HerdrError(`Herdr Core's command "${bin()}" was not found. Install Herdr Core first.`, "missing");
		const text = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
		try {
			const parsed = JSON.parse(text.split("\n").find((l) => l.startsWith("{")) ?? "");
			if (parsed.error) throw new HerdrError(parsed.error.message ?? text, parsed.error.kind);
		} catch (inner) {
			if (inner instanceof HerdrError) throw inner;
		}
		throw new HerdrError(text || e.message);
	}
	const trimmed = out.trim();
	return trimmed ? JSON.parse(trimmed) : {};
}

/**
 * Where the selected core listens, computed the way Herdr Core does (paths.rs, platform/unix.rs). Every `hc`
 * command starts the core when it is not running; this lets Pi-personal ask "is it running?" without starting it.
 */
function socketPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.HC_SOCKET) return env.HC_SOCKET;
	const session = env.HC_SESSION?.trim() || "default";
	const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	try {
		const config = fs.readFileSync(path.join(configHome, "herdr-core", "config.toml"), "utf8");
		const m = /^\s*socket\s*=\s*"([^"]+)"/m.exec(config);
		if (m) return m[1];
	} catch {}
	const state = path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "herdr-core", session);
	let run = env.XDG_RUNTIME_DIR || "";
	if (!run && fs.existsSync(`/run/user/${process.getuid?.()}`)) run = `/run/user/${process.getuid?.()}`;
	return path.join(run ? path.join(run, "herdr-core") : state, `${session}.sock`);
}

/** Is the selected Herdr Core running? Connects to its socket and never starts it. */
export function isRunning(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	return new Promise((resolve) => {
		const s = net.createConnection(socketPath(env));
		const done = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.once("connect", () => done(true));
		s.once("error", () => done(false));
		setTimeout(() => done(false), 3000).unref();
	});
}

export function version(): string {
	return execFileSync(bin(), ["--version"], { encoding: "utf8" }).trim().replace(/^hc\s+/, "");
}

// ---- finding, installing and starting Herdr Core (for `pp setup`) ---------------------------------------------

export const MIN_VERSION = "0.1.18"; // the oldest Herdr Core Pi-personal is tested with
export const INSTALLER = "https://releases.herdr.dev/core/install.sh"; // Herdr's own installer

/** a >= b, for versions like 0.1.21. */
export function atLeast(a: string, b: string): boolean {
	const pa = a.split(/[.-]/).map(Number);
	const pb = b.split(/[.-]/).map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	return true;
}

/** Herdr Core's command on this machine, and its version: the one set for Pi-personal, the one on the PATH (if it
 * really is Herdr's: some window managers ship another hc), or where Herdr's installer puts it. */
export function find(): { bin: string; version: string } | undefined {
	const local = path.join(os.homedir(), ".local", "bin");
	const tries = [process.env[`${ENV}_HC`], "hc", path.join(local, "hc"), path.join(local, "herdr-core"), "herdr-core"].filter(Boolean) as string[];
	for (const b of tries) {
		const r = spawnSync(b, ["--version"], { encoding: "utf8", timeout: 10_000 });
		const m = /^(?:hc|herdr-core)\s+(\d+\.\d+\.\d+\S*)/m.exec(r.stdout ?? "");
		if (r.status === 0 && m) return { bin: b, version: m[1] };
	}
	return undefined;
}

/** Use this Herdr Core command from now on, in this process and in what it starts. */
export function use(command: string): void {
	if (command === "hc") return;
	process.env[`${ENV}_HC`] = command;
	found = command;
	if (command.includes("/")) {
		const dir = path.dirname(command);
		if (!(process.env.PATH ?? "").split(":").includes(dir)) process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
	}
}

/** Run Herdr's own installer, in this terminal (it says what it does). */
export function install(): boolean {
	// Downloaded whole first: a connection cut half-way must not run half a script.
	const script = process.env[`${ENV}_HERDR_INSTALLER`] || `t=$(mktemp) && curl -fsSL --proto '=https' ${INSTALLER} -o "$t" && sh "$t"; s=$?; rm -f "$t"; exit $s`;
	found = undefined;
	return spawnSync("sh", ["-c", script], { stdio: "inherit" }).status === 0;
}

/** Bring an older Herdr Core up to date the planned way (its running terminals keep running). */
export function update(): boolean {
	return spawnSync(bin(), ["update", "--version", MIN_VERSION], { stdio: "inherit" }).status === 0;
}

/** Start the selected core; it then runs in the background, whatever happens to this terminal. */
export function startServer(): void {
	hc(["server", "start"]);
}

/** On Linux, whether logging out would stop the user's programs (systemd's "linger" is off). */
export function stopsAtLogout(): boolean {
	if (process.platform !== "linux") return false;
	const r = spawnSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger"], { encoding: "utf8", timeout: 10_000 });
	return r.status === 0 && /Linger=no/.test(r.stdout);
}

/** The running core's identity and version. */
export function server(): { id: string; version: string } {
	const s = hc(["server", "status"]);
	return { id: s.core?.id, version: s.version };
}

/** Start a program in a new terminal and return at once. The terminal has no parent, so it outlives whoever ran this. */
export function run(opts: { name?: string; cwd: string; labels: Record<string, string>; argv: string[] }): Terminal {
	const args = ["run", "--bg", "--no-parent", "--no-notify", "--cwd", opts.cwd];
	if (opts.name) args.push("--name", opts.name);
	for (const [k, v] of Object.entries(opts.labels)) args.push("--label", `${k}=${v}`);
	return hc([...args, "--", ...opts.argv]) as Terminal;
}

export function get(address: string): Terminal | undefined {
	try {
		return hc(["get", address]) as Terminal;
	} catch (err) {
		if (err instanceof HerdrError && (err.kind === "not_found" || /not found|no terminal/i.test(err.message))) return undefined;
		throw err;
	}
}

/** Terminals carrying all of these labels (live ones, or finished ones too). */
export function ls(labels: Record<string, string>, all = false): Terminal[] {
	const args = ["ls"];
	if (all) args.push("--all");
	for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
	return (hc(args).terminals ?? []) as Terminal[];
}

/** Stop the selected core and every program in it. Callers check first that nothing else runs there. */
export function stopServer(): void {
	hc(["server", "stop"]);
}

export function kill(address: string): void {
	hc(["kill", address]);
}

export function rm(address: string): void {
	try {
		hc(["rm", address]);
	} catch (err) {
		if (!(err instanceof HerdrError)) throw err;
	}
}
