// Models and sign-ins are pi's: pi's own screen does them (/login connects a provider, with an account or an API key;
// /model chooses the model), with Pi-Personal's pi directory, shared by all agents. Pi-Personal only reads what pi
// stored: which providers pi lists models for, and the model pi keeps as its default. Nothing here prints a secret.
import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { piDir, privateDir, ROOT } from "./paths.ts";
import { preparePi } from "./agents.ts";
import { piCli, piPackage } from "./runner.ts";

export interface Provider {
	id: string;
	name: string;
	account?: { label: string; subscription: boolean }; // sign-in with an account (a browser or a code)
	apiKey: boolean; // sign-in with an API key
}
export type Kind = "api_key" | "oauth";

/** A module of pi's own packages, by its public path, or by its file when the package is not hoisted. */
async function piModule(specifier: string, file: string): Promise<any> {
	try {
		return await import(specifier);
	} catch {
		return import(pathToFileURL(path.join(piPackage().dir, "..", file)).href);
	}
}

/** Every provider pi can sign in to, in the order pi's own /login shows them. */
export async function providers(): Promise<Provider[]> {
	const { builtinProviders } = await piModule("@earendil-works/pi-ai/providers/all", "pi-ai/dist/providers/all.js");
	const first: Record<string, number> = { radius: 0, openrouter: 1 }; // pi's preferred providers come first
	return (builtinProviders() as any[])
		.map((p) => ({
			id: String(p.id),
			name: String(p.name),
			account: p.auth?.oauth ? { label: String(p.auth.oauth.loginLabel ?? "Sign in with an account"), subscription: p.auth.oauth.isSubscription !== false } : undefined,
			apiKey: typeof p.auth?.apiKey?.login === "function",
		}))
		.filter((p) => p.account || p.apiKey)
		.sort((a, b) => (first[a.id] ?? 2) - (first[b.id] ?? 2) || a.name.localeCompare(b.name));
}

/** pi's default model for a provider (what pi itself starts with), if pi names one. */
export async function defaultModel(id: string): Promise<string | undefined> {
	try {
		const m = await import(pathToFileURL(path.join(piPackage().dir, "dist", "core", "model-resolver.js")).href);
		return m.defaultModelPerProvider?.[id];
	} catch {
		return undefined;
	}
}

const ourAuth = () => path.join(piDir(), "auth.json");

/** Which providers Pi-Personal's pi holds credentials for, and of which kind: ids and kinds only. */
export function stored(file = ourAuth()): Record<string, Kind> {
	let data: unknown;
	try {
		data = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	const out: Record<string, Kind> = {};
	if (data && typeof data === "object")
		for (const [id, v] of Object.entries(data as Record<string, any>)) if (v?.type === "api_key" || v?.type === "oauth") out[id] = v.type;
	return out;
}

/** Change Pi-Personal's credentials file under pi's own lock, keeping it readable by its owner only. */
async function editAuth(change: (data: Record<string, unknown>) => void): Promise<void> {
	privateDir(piDir());
	const file = ourAuth();
	if (!fs.existsSync(file)) fs.writeFileSync(file, "{}", { mode: 0o600 });
	// pi's own lock, as pi takes it: a sign-in refreshed by a running agent is never overwritten by this write.
	let lockfile: any;
	try {
		lockfile = createRequire(path.join(ROOT, "package.json"))("proper-lockfile");
	} catch {} // without pi's lock library (it comes with pi), the write below is still atomic
	const release: (() => Promise<void>) | undefined = lockfile ? await lockfile.lock(file, { retries: { retries: 40, minTimeout: 200, maxTimeout: 1000 }, stale: 30_000 }) : undefined;
	try {
		let data: Record<string, unknown> = {};
		try {
			data = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
		} catch {}
		change(data);
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
		fs.chmodSync(file, 0o600);
	} finally {
		await release?.();
	}
}

const piEnv = () => ({ ...process.env, PI_CODING_AGENT_DIR: piDir() });
/** pi's environment with only what is not a credential (an allow-list: cloud credentials come in many names): what
 * agents can count on, whatever environment they start in. */
function storedOnly(): NodeJS.ProcessEnv {
	const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|TERM|TMPDIR|TMP|TEMP|TZ|NO_COLOR|LC_\w+|XDG_\w+|PI_\w+|NODE_\w+|SSL_CERT_\w+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy)$/;
	return Object.fromEntries(Object.entries(piEnv()).filter(([k]) => keep.test(k)));
}

/** pi's own screen, in this terminal, with Pi-Personal's pi directory: /login and /model there, /quit to come back.
 * Without a session (nothing to keep), in the private area (no project files around), with only what agents get from
 * the environment (a key in this terminal's environment would not reach them), plus what its screen and a browser
 * sign-in need. The exit code of pi. */
export function openPi(): number {
	preparePi(); // its shared settings first: in this screen too, Ctrl+C and Ctrl+D do not quit
	return spawnSync(process.execPath, [piCli(), "--no-session"], { stdio: "inherit", cwd: piDir(), env: { ...storedOnly(), ...screenEnv() } }).status ?? 1;
}
const screenEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(COLORTERM|TERM_PROGRAM|TERM_PROGRAM_VERSION|KITTY_WINDOW_ID|WT_SESSION|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|BROWSER)$/.test(k)));

/** pi's command-line sign-in (`pi auth login <provider> [--api-key] [--no-browser]`), for scripts and people who know
 * their provider. A terminal left in bracketed-paste mode (by another program) wraps a paste in marks, which pi's hidden
 * prompt drops, or keeps in the key: plain pastes for it, and the key cleaned after. */
export async function login(args: string[]): Promise<number> {
	preparePi();
	if (process.stdout.isTTY) process.stdout.write("\x1b[?2004l");
	const r = spawnSync(process.execPath, [piCli(), "auth", "login", ...args], { stdio: "inherit", env: piEnv() });
	const id = args.find((x) => !x.startsWith("-"));
	if (r.status === 0 && id && args.includes("--api-key") && !(await tidyKey(id))) {
		console.error(`no key received for ${id}: paste it, then Enter`);
		return 1;
	}
	return r.status ?? 1;
}

/** The API key just stored for a provider, cleaned of what a terminal adds around a paste (spaces, line ends, paste
 * marks). False when there is no key left: nothing was pasted. */
export async function tidyKey(id: string): Promise<boolean> {
	if (stored()[id] !== "api_key") return false;
	let left = false;
	await editAuth((d) => {
		const e = d[id] as { key?: unknown } | undefined;
		if (typeof e?.key !== "string") return;
		e.key = e.key.replace(/\x1b?\[20[01]~/g, "").trim();
		left = e.key !== "";
	});
	return left;
}

/** The providers agents can use now: those pi lists models for. */
export const connected = (): string[] => [...new Set(models().map((m) => m.provider))];

export interface Model {
	provider: string;
	id: string;
	context?: string;
	thinking?: boolean;
}

/** The models of the providers Pi-Personal is connected to (by its sign-ins, or by pi's models.json), from pi's own list. */
export function models(search?: string): Model[] {
	const r = spawnSync(process.execPath, [piCli(), "--list-models", ...(search ? [search] : [])], { encoding: "utf8", env: storedOnly(), timeout: 60_000 });
	return parseModels(r.stdout ?? "");
}
/** The same, without blocking (so that a wait can be drawn meanwhile); `error` when pi did not answer, which is not the
 * same as "nothing connected". */
export function modelsAsync(): Promise<{ list: Model[]; error?: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [piCli(), "--list-models"], { encoding: "utf8", env: storedOnly(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			const list = parseModels(stdout ?? "");
			resolve(err && !list.length ? { list, error: (stderr || err.message).trim().split("\n").pop() } : { list });
		});
	});
}
function parseModels(stdout: string): Model[] {
	const rows = stdout.split("\n").map((l) => l.trim().split(/\s{2,}/));
	const head = rows.findIndex((c) => c[0] === "provider" && c[1] === "model");
	if (head < 0) return [];
	return rows
		.slice(head + 1)
		.filter((c) => c.length >= 2 && c[0] && c[1])
		.map((c) => ({ provider: c[0], id: c[1], context: c[2], thinking: c[4] === "yes" }));
}

/** The model pi keeps as its default (chosen in pi with /model, then Ctrl+S), if its provider is connected; otherwise
 * what pi itself starts with for the first connected provider: pi's default for it, or the first model pi lists. */
export async function chosenModel(list: Model[] = models()): Promise<string | undefined> {
	let s: { defaultProvider?: unknown; defaultModel?: unknown } = {};
	try {
		s = JSON.parse(fs.readFileSync(path.join(piDir(), "settings.json"), "utf8")) ?? {};
	} catch {}
	if (list.some((m) => m.provider === s.defaultProvider && m.id === s.defaultModel)) return `${s.defaultProvider}/${s.defaultModel}`;
	const first = list[0]?.provider;
	if (!first) return undefined;
	const preferred = await defaultModel(first);
	return `${first}/${list.some((m) => m.provider === first && m.id === preferred) ? preferred : list.find((m) => m.provider === first)!.id}`;
}
