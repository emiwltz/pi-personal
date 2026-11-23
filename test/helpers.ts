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
	type: (agent: string, text: string) => Promise<void>; // as the owner types in the agent's terminal
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
					// A reasoning model, so that pi sends a reasoning effort (pp thinking) as it does to a real one.
					models: [{ id: "echo-1", name: "Fake", contextWindow: 32000, maxTokens: 2000, reasoning: true }],
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
	// Text typed in the agent's terminal (hc send, run outside any terminal, adds nothing to it).
	const type = async (agent: string, text: string) => {
		guard();
		const addr = JSON.parse((await cli("status", agent, "--json")).stdout).address;
		for (let i = 0; ; i++)
			try {
				execFileSync("hc", ["send", addr, text], { env, stdio: "pipe" });
				return;
			} catch (err) {
				if (i > 20) throw err;
				await sleep(500);
			}
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
	return { dir, home: path.join(dir, "home"), env, model, cli, hc, portOf, waitEvent, type, close };
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
	// users: without the header the bridge writes; raw: the last one as sent; first: the role of the first message (the
	// system prompt's); the model and reasoning effort pi asked for; the names of the tools it declared
	requests: { users: string[]; last: string; raw: string; first?: string; model?: string; effort?: string; tools: string[] }[];
	close: () => void;
}

/** The header the bridge writes above a port message's text (core/bridge.ts): the note line if any (a message told
 * without waking), the `From:` line if any, the `Sent:` line, one blank line. Exactly that and nothing else: text typed
 * in the terminal has none, and a `From:` line a channel wrote itself stays in the text. */
const HEADER = /^(?:\((?:Said to [^\n]* without waking you|A note left for you)\.\)\n)?(?:From: [^\n]*\n)?Sent: (?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day \d{4}-\d\d-\d\d \d\d:\d\d UTC[+-]\d\d:\d\d\n\n/;

/** An OpenAI-compatible fake model. Replies "echo: <last user text>" (without the bridge's header); "tool: <cmd>" makes it call bash with <cmd>;
 * "call: <tool> <json>" calls any tool, and "silent-call: <tool> <json>" the same, then answers nothing; "calls:
 * [[<tool>, <args>], ...]" makes several calls in one step; "long:<n>" replies n x's; "fail: <why>" is refused with an HTTP 400;
 * "denied:" is refused with an HTTP 401, as a wrong key is; "silent:" ends the run with an empty answer; "flaky: <x>" is refused once with a passing error, then answered;
 * "interim-fail:" writes a sentence and calls a tool, then the next request is refused; "then-refuse:" refuses the request
 * after a tool's result (with "silent-call:", a run whose only reply is the tool's). */
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
			const users = msgs.filter((m) => m.role === "user").map((m) => textOf(m).replace(HEADER, "")); // echo the text, not who wrote it nor when
			const utext = users.at(-1) ?? "";
			requests.push({ users, last: last.role, raw: textOf(msgs.filter((m) => m.role === "user").at(-1) ?? {}), first: msgs[0]?.role, model: r.model, effort: r.reasoning_effort, tools: (r.tools ?? []).map((x: any) => x.function?.name) });
			n++;
			let calls: { name: string; arguments: string }[] = [];
			let reply = "";
			// "fail: <why>" makes the provider refuse the request, as a real one does for a bad key or a bad request.
			if (last.role !== "tool" && utext.includes("flaky:") && !flaked.has(utext)) {
				flaked.add(utext);
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "fake overload, try again", type: "overloaded_error" } }));
				return;
			}
			// "interim-fail:" writes a sentence and calls a tool, then the next request is refused (a final failure).
			if (last.role === "tool" && (utext.includes("interim-fail:") || utext.includes("then-refuse:"))) {
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
				calls = [{ name: "bash", arguments: JSON.stringify({ command: "echo checking" }) }];
			} else if (last.role === "tool") reply = utext.includes("silent-call:") ? "" : `done: ${textOf(last).trim().slice(0, 200)}`;
			else if (utext.includes("tool:")) calls = [{ name: "bash", arguments: JSON.stringify({ command: utext.split("tool:")[1].trim() }) }];
			else if (utext.includes("calls:"))
				// "calls: [[<tool>, <arguments>], ...]": several tool calls in one step, as models often make them.
				calls = JSON.parse(utext.split("calls:")[1].trim()).map(([name, args]: [string, unknown]) => ({ name, arguments: JSON.stringify(args) }));
			else if (utext.includes("call:")) {
				// "call: <tool name> <JSON arguments>": any tool the agent has (an MCP server's, for example). "silent-call:" too.
				const [name, ...rest] = utext.split("call:")[1].trim().split(" ");
				calls = [{ name, arguments: rest.join(" ") || "{}" }];
			}
			else if (utext.includes("long:")) reply = `${"x".repeat(Number(utext.split("long:")[1]) || 5000)}`;
			else if (utext.includes("silent:")) reply = "";
			else reply = `echo: ${utext.trim()}`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null = null) =>
				res.write(`data: ${JSON.stringify({ id: `f${n}`, object: "chat.completion.chunk", created: 0, model: "echo-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			if (calls.length) {
				chunk({ role: "assistant", content: reply || null, tool_calls: calls.map((c, i) => ({ index: i, id: `call_${n}_${i}`, type: "function", function: c })) });
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

/** An in-agent extension that asks its owner through the bridge (pi-personal.ask), for the tests of questions. Its tool
 * `ask_owner` ({ title, options?, timeoutMs?, wait? }) answers "answer: <the answer>" ("none" when there was none), or
 * at once "asked" with `wait: false` (the answer is only recorded, in its state folder's `answers`); its tool
 * `confirm_probe` ({ title, timeoutMs }) opens pi's own dialog, as another extension's approval does. With the file
 * `ask-at-load` in its state folder, it asks once while loading and records whether the question was `taken`. */
export const ASKER = `import * as fs from "node:fs";
import * as path from "node:path";
const dir = path.join(process.env.PI_PERSONAL_STATE, "asker");
fs.mkdirSync(dir, { recursive: true });
const note = (f, v) => fs.appendFileSync(path.join(dir, f), JSON.stringify(v) + "\\n");
const said = (text) => ({ content: [{ type: "text", text }], details: undefined });
export default function (pi) {
	if (fs.existsSync(path.join(dir, "ask-at-load"))) {
		fs.rmSync(path.join(dir, "ask-at-load"));
		const q = { title: "asked while loading", resolve: () => {} };
		pi.events.emit("pi-personal.ask", q);
		note("at-load", { taken: q.taken ?? null });
	}
	pi.registerTool({
		name: "ask_owner",
		label: "Ask the owner",
		description: "Ask the owner a question",
		parameters: { type: "object", properties: { title: { type: "string" }, options: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number" } }, required: ["title"] },
		async execute(_id, p) {
			const asked = new Promise((resolve) => {
				const q = { ...p, resolve };
				pi.events.emit("pi-personal.ask", q);
				if (!q.taken) resolve("(not taken)");
			}).then((answer) => (note("answers", { title: p.title, answer: answer ?? null }), answer));
			if (p.wait === false) return said("asked");
			const answer = await asked;
			return said("answer: " + (answer ?? "none"));
		},
	});
	pi.registerTool({
		name: "confirm_probe",
		label: "Confirm",
		description: "Ask for a confirmation in the terminal",
		parameters: { type: "object", properties: { title: { type: "string" }, timeoutMs: { type: "number" } }, required: ["title"] },
		async execute(_id, p, _signal, _update, ctx) {
			const ok = await ctx.ui.confirm(p.title, "Go on?", { timeout: p.timeoutMs });
			return said("confirmed: " + ok);
		},
	});
}
`;
