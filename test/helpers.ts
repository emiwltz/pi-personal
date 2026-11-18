// Test harness: an isolated Herdr Core, a fake model, and a private Pi-Personal home, all in a short scratch folder.
// Safety first: the user's own Herdr Core carries their real work. Every hc call made by the tests goes to a
// separate core (its own HC_SESSION and XDG directories), and the harness checks its identity before stopping it.
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isRunning } from "../core/herdr.ts";
import * as port from "../core/port.ts";

export const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "core", "cli.ts");

export interface Env {
	dir: string;
	home: string;
	env: NodeJS.ProcessEnv;
	model: FakeModel;
	cli: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	hc: (...args: string[]) => any;
	portOf: (agent: string) => string;
	waitEvent: (agent: string, from: number, pred: (e: port.Seen) => boolean, ms?: number) => Promise<port.Seen>;
	close: () => Promise<void>;
}

/** The identity of the user's default Herdr Core, read before anything changes the environment (and only if it runs:
 * asking a core that is not running would start it). */
async function defaultCoreId(): Promise<string | undefined> {
	if (!(await isRunning(process.env))) return undefined;
	try {
		return JSON.parse(execFileSync("hc", ["server", "status", "--json"], { encoding: "utf8", timeout: 10_000 })).core?.id;
	} catch {
		return undefined;
	}
}
const DEFAULT_CORE = await defaultCoreId();

/** requireKey: the fake model answers 401 unless the request carries that bearer key, and the provider in models.json has
 * no apiKey of its own (so pi takes the key from auth.json, as with a real provider). */
export async function setup(name: string, opts: { requireKey?: string } = {}): Promise<Env> {
	// Unix socket paths are limited to about 100 characters: keep the scratch folder short.
	const dir = fs.mkdtempSync(`/tmp/pt-${name.slice(0, 6)}-`);
	for (const d of ["run", "state", "config", "data", "cache", "home"]) fs.mkdirSync(path.join(dir, d), { mode: 0o700 });
	const session = `pt${path.basename(dir).replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "HC_SOCKET"]) delete env[k];
	Object.assign(env, {
		HC_SESSION: session,
		XDG_RUNTIME_DIR: path.join(dir, "run"),
		XDG_STATE_HOME: path.join(dir, "state"),
		XDG_CONFIG_HOME: path.join(dir, "config"),
		XDG_DATA_HOME: path.join(dir, "data"),
		XDG_CACHE_HOME: path.join(dir, "cache"),
		PI_PERSONAL_HOME: path.join(dir, "home"),
		PI_OFFLINE: "1",
		PI_PERSONAL_WINDOW_MS: process.env.PI_PERSONAL_WINDOW_MS ?? "20000",
		PI_PERSONAL_RETRY_MS: process.env.PI_PERSONAL_RETRY_MS ?? "8000",
	});
	const guard = () => {
		if (!env.HC_SESSION?.startsWith("pt") || !env.XDG_RUNTIME_DIR?.startsWith("/tmp/pt-") || env.HC_SOCKET)
			throw new Error("refusing to call hc outside an isolated Herdr Core");
	};
	const hc = (...args: string[]) => {
		guard();
		const out = execFileSync("hc", [...args, "--json"], { env, encoding: "utf8", timeout: 30_000 });
		return out.trim() ? JSON.parse(out) : {};
	};
	const model = await fakeModel(opts.requireKey);
	// pi's shared configuration in the private area: one fake provider.
	const piDir = path.join(dir, "home", "pi");
	fs.mkdirSync(piDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(piDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `http://127.0.0.1:${model.port}/v1`,
					api: "openai-completions",
					...(opts.requireKey === undefined ? { apiKey: "fake" } : {}),
					models: [{ id: "echo-1", name: "Fake", contextWindow: 32000, maxTokens: 2000 }],
				},
			},
		}),
	);
	// Start the isolated core now, with this environment, and make sure it is not the user's.
	const core = hc("server", "status").core?.id;
	if (!core || core === DEFAULT_CORE) throw new Error("the test core is the default core: stopping");
	const cli = async (...args: string[]) => {
		guard();
		try {
			const r = await run(process.execPath, [CLI, ...args], { env, timeout: 120_000 });
			return { code: 0, stdout: r.stdout, stderr: r.stderr };
		} catch (err) {
			const e = err as { code?: number; stdout?: string; stderr?: string };
			return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
		}
	};
	const portOf = (agent: string) => path.join(dir, "home", "agents", agent, "port");
	const waitEvent = async (agent: string, from: number, pred: (e: port.Seen) => boolean, ms = 20_000) => {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), ms);
		let found: port.Seen | undefined;
		await port.follow(portOf(agent), from, (e) => (pred(e) ? ((found = e), true) : false), ac.signal);
		clearTimeout(t);
		if (!found) throw new Error(`timed out waiting for an event of ${agent}; events:\n${fs.readFileSync(port.eventsFile(portOf(agent)), "utf8").slice(-3000)}`);
		return found;
	};
	// Stop the isolated core and check it is gone (through its socket: any hc command would start it again)
	// before removing the folder that holds the socket. A core left running is reported, never orphaned.
	const close = async () => {
		model.close();
		let trouble = "";
		try {
			const id = hc("server", "status").core?.id;
			if (id && id !== DEFAULT_CORE && id === core) hc("server", "stop");
		} catch (err) {
			trouble = (err as Error).message;
		}
		for (let i = 0; i < 50 && (await isRunning(env)); i++) await sleep(100);
		if (await isRunning(env))
			throw new Error(`the isolated Herdr Core ${env.HC_SESSION} is still running${trouble ? ` (${trouble})` : ""}; its folder ${dir} is kept so that it can be reached`);
		fs.rmSync(dir, { recursive: true, force: true });
	};
	return { dir, home: path.join(dir, "home"), env, model, cli, hc, portOf, waitEvent, close };
}

/** Change an agent's settings file: `extensions` lists the folders under extensions/ to turn on, by putting them where
 * pi finds them (.pi/extensions/); every other key is merged into pi-personal.json. */
export function changeSettings(folder: string, patch: Record<string, unknown>): void {
	const { extensions, ...rest } = patch as { extensions?: string[] };
	if (extensions) {
		const dir = path.join(folder, ".pi", "extensions");
		fs.rmSync(dir, { recursive: true, force: true });
		for (const n of extensions) fs.cpSync(path.join(folder, "extensions", n), path.join(dir, n), { recursive: true });
	}
	const file = path.join(folder, "pi-personal.json");
	if (Object.keys(rest).length) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...rest }, null, 2));
}

/** The agent's last start (not a channel's), from its events. */
export const lastStart = (portDir: string) => [...port.events(portDir).events].reverse().find((e) => e.type === "started" && !e.channel)!;

export interface FakeModel {
	port: number;
	requests: { users: string[]; last: string; raw: string }[]; // users: without the "From:" line the bridge adds; raw: as sent
	close: () => void;
}

/** An OpenAI-compatible fake model. Replies "echo: <last user text>"; "tool: <cmd>" makes it call bash with <cmd>;
 * "call: <tool> <json>" calls any tool; "long:<n>" replies n x's; "fail: <why>" is refused with an HTTP 400;
 * "denied:" is refused with an HTTP 401, as a wrong key is; "silent:" ends the run with an empty answer; "flaky: <x>" is refused once with a passing error, then answered;
 * "interim-fail:" writes a sentence and calls a tool, then the next request is refused. */
export async function fakeModel(requireKey?: string): Promise<FakeModel> {
	const requests: FakeModel["requests"] = [];
	const flaked = new Set<string>(); // "flaky: <x>" is refused once with a passing error (503), then answered
	const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join(" "));
	let n = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "echo-1", object: "model" }] }));
				return;
			}
			if (requireKey !== undefined && req.headers.authorization !== `Bearer ${requireKey}`) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_fake" }));
				return;
			}
			const r = JSON.parse(body || "{}");
			const msgs: any[] = r.messages ?? [];
			const last = msgs.at(-1) ?? {};
			const users = msgs.filter((m) => m.role === "user").map((m) => textOf(m).replace(/^From: [^\n]*\n\n/, "")); // echo the text, not who wrote it
			const utext = users.at(-1) ?? "";
			requests.push({ users, last: last.role, raw: textOf(msgs.filter((m) => m.role === "user").at(-1) ?? {}) });
			n++;
			let call: { name: string; arguments: string } | undefined;
			let reply = "";
			// "fail: <why>" makes the provider refuse the request, as a real one does for a bad key or a bad request.
			if (last.role !== "tool" && utext.includes("flaky:") && !flaked.has(utext)) {
				flaked.add(utext);
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "fake overload, try again", type: "overloaded_error" } }));
				return;
			}
			// "interim-fail:" writes a sentence and calls a tool, then the next request is refused (a final failure).
			if (last.role === "tool" && utext.includes("interim-fail:")) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "fake refusal after an interim reply", type: "invalid_request_error" } }));
				return;
			}
			// "denied:" is refused as a wrong key is, word for word as Anthropic refuses one.
			if (last.role !== "tool" && utext.includes("denied:")) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_fake" }));
				return;
			}
			if (last.role !== "tool" && utext.includes("fail:") && !utext.includes("interim-fail:")) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `fake refusal: ${utext.split("fail:")[1].trim()}`, type: "invalid_request_error" } }));
				return;
			}
			if (last.role !== "tool" && utext.includes("interim-fail:")) {
				reply = "Let me check.";
				call = { name: "bash", arguments: JSON.stringify({ command: "echo checking" }) };
			} else if (last.role === "tool") reply = `done: ${textOf(last).trim().slice(0, 200)}`;
			else if (utext.includes("tool:")) call = { name: "bash", arguments: JSON.stringify({ command: utext.split("tool:")[1].trim() }) };
			else if (utext.includes("call:")) {
				// "call: <tool name> <JSON arguments>": any tool the agent has (an MCP server's, for example).
				const [name, ...rest] = utext.split("call:")[1].trim().split(" ");
				call = { name, arguments: rest.join(" ") || "{}" };
			}
			else if (utext.includes("long:")) reply = `${"x".repeat(Number(utext.split("long:")[1]) || 5000)}`;
			else if (utext.includes("silent:")) reply = "";
			else reply = `echo: ${utext.trim()}`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null = null) =>
				res.write(`data: ${JSON.stringify({ id: `f${n}`, object: "chat.completion.chunk", created: 0, model: "echo-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			if (call) {
				chunk({ role: "assistant", content: reply || null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: call }] });
				chunk({}, "tool_calls");
			} else {
				chunk({ role: "assistant", content: reply });
				chunk({}, "stop");
			}
			res.write(`data: ${JSON.stringify({ id: `f${n}`, object: "chat.completion.chunk", created: 0, model: "echo-1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return { port: (server.address() as AddressInfo).port, requests, close: () => server.close() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
