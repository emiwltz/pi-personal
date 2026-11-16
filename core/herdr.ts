// The few Herdr Core verbs Pi-personal uses: run, get, ls, kill, rm. Everything goes through the `hc` command,
// with the caller's environment, so the same code reaches the user's default core in real use and an
// isolated one in tests (HC_SESSION and the XDG directories select the instance).
import { execFileSync } from "node:child_process";
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

const bin = () => process.env[`${ENV}_HC`] || "hc";

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
