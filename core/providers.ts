// Model providers, the way pi offers them: pi's own list (its ids, names and sign-in methods, in pi's order), pi's own
// sign-in (`pi auth login`), pi's own credentials file (auth.json in Pi-personal's pi directory, shared by all agents).
// Nothing here prints a secret: credentials found elsewhere are listed by provider and kind only, and copied only on yes.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { piDir, privateDir, ROOT } from "./paths.ts";
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

/** The environment variables set for a provider (names only; their values are never read here). */
export async function envKeys(id: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	try {
		const { findEnvKeys } = await piModule("@earendil-works/pi-ai/compat", "pi-ai/dist/compat.js");
		return (findEnvKeys(id, env) as string[] | undefined) ?? [];
	} catch {
		return [];
	}
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

/** Which providers a credentials file holds, and of which kind: ids and kinds only. */
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

/** The credentials file of the user's own pi, if there is one (never Pi-personal's). */
export function userPiAuth(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const dir = env.PI_CODING_AGENT_DIR ? env.PI_CODING_AGENT_DIR.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), ".pi", "agent");
	const file = path.join(dir, "auth.json");
	if (path.resolve(dir) === path.resolve(piDir()) || !fs.existsSync(file)) return undefined;
	return file;
}

/** Change Pi-personal's credentials file under pi's own lock, keeping it readable by its owner only. */
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

/** Copy one provider's API key from another credentials file (the user's own pi). Account sign-ins are not copied. */
export async function copyKey(from: string, id: string): Promise<void> {
	const entry = (JSON.parse(fs.readFileSync(from, "utf8")) as Record<string, any>)[id];
	if (entry?.type !== "api_key") throw new Error(`${id} in ${from} is not an API key`);
	await editAuth((d) => {
		d[id] = entry;
	});
}

/** Save the API key found in an environment variable, so agents get it whatever environment they start in. */
export async function saveEnvKey(id: string, variable: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const key = env[variable];
	if (!key) throw new Error(`${variable} is not set`);
	await editAuth((d) => {
		d[id] = { type: "api_key", key };
	});
}

const piEnv = () => ({ ...process.env, PI_CODING_AGENT_DIR: piDir() });
/** pi's environment with only what is not a credential (an allow-list: cloud credentials come in many names): what
 * agents can count on, whatever environment they start in. */
function storedOnly(): NodeJS.ProcessEnv {
	const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|TERM|TMPDIR|TMP|TEMP|TZ|NO_COLOR|LC_\w+|XDG_\w+|PI_\w+|NODE_\w+|SSL_CERT_\w+|(HTTPS?|ALL|NO)_PROXY|(https?|all|no)_proxy)$/;
	return Object.fromEntries(Object.entries(piEnv()).filter(([k]) => keep.test(k)));
}

/** pi's own sign-in, in this terminal: a browser or a code for an account, or a hidden prompt for an API key. */
export function login(id: string, apiKey: boolean): boolean {
	privateDir(piDir());
	const r = spawnSync(process.execPath, [piCli(), "auth", "login", id, ...(apiKey ? ["--api-key"] : [])], { stdio: "inherit", env: piEnv() });
	return r.status === 0;
}

/** Whether pi can use a provider now, with what Pi-personal stored (environment variables do not count: agents may not get them). */
export function check(id: string): "ready" | "not_ready" | "invalid" {
	const r = spawnSync(process.execPath, [piCli(), "auth", "check", "--provider", id, "--json"], { encoding: "utf8", env: storedOnly(), timeout: 60_000 });
	try {
		const s = JSON.parse(r.stdout.trim().split("\n").pop() ?? "").status;
		return s === "ready" || s === "invalid" ? s : "not_ready";
	} catch {
		return "not_ready";
	}
}

/** The providers agents can use now: those pi lists models for. */
export const connected = (): string[] => [...new Set(models().map((m) => m.provider))];

export interface Model {
	provider: string;
	id: string;
	context?: string;
	thinking?: boolean;
}

/** The models of the providers Pi-personal is connected to (by its sign-ins, or by pi's models.json), from pi's own list. */
export function models(search?: string): Model[] {
	const r = spawnSync(process.execPath, [piCli(), "--list-models", ...(search ? [search] : [])], { encoding: "utf8", env: storedOnly(), timeout: 60_000 });
	const rows = (r.stdout ?? "").split("\n").map((l) => l.trim().split(/\s{2,}/));
	const head = rows.findIndex((c) => c[0] === "provider" && c[1] === "model");
	if (head < 0) return [];
	return rows
		.slice(head + 1)
		.filter((c) => c.length >= 2 && c[0] && c[1])
		.map((c) => ({ provider: c[0], id: c[1], context: c[2], thinking: c[4] === "yes" }));
}
