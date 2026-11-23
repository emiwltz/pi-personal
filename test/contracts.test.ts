// Contracts: the behaviours of pi and Herdr Core that Pi-Personal's core relies on, checked directly. When pi or Herdr Core
// is updated, these tests say at once whether an assumption broke, before a user finds out.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { THINKING } from "../core/agents.ts";
import { hcNote } from "../core/bridge.ts";
import { piCli } from "../core/runner.ts";
import * as port from "../core/port.ts";
import { type Env, setup, sleep } from "./helpers.ts";

let t: Env;
before(async () => {
	t = await setup("ctr");
	fs.writeFileSync(path.join(t.home, "pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
});
after(async () => t.close());

/** pi as the runner starts it for its load check: no model call, no session, no screen. */
function dry(cwd: string, args: string[]) {
	return spawnSync(process.execPath, [piCli(), ...args, "--no-session", "--mode", "rpc"], {
		cwd,
		env: { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
		input: `${JSON.stringify({ type: "get_state" })}\n`,
		encoding: "utf8",
		timeout: 60_000,
	});
}
const folder = (name: string) => {
	const dir = path.join(t.dir, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

// ---- pi --------------------------------------------------------------------------------------------------------

test("pi: its providers' names and default models can be read (pp setup names them, and starts with pi's default)", async () => {
	const p = await import("../core/providers.ts");
	const all = await p.providers();
	assert.ok(all.length > 10, `pi lists ${all.length} providers`);
	assert.equal(all.find((x) => x.id === "anthropic")?.name, "Anthropic");
	assert.equal(typeof (await p.defaultModel("anthropic")), "string", "pi names a default model for Anthropic");
});

test("pi: auth login takes --api-key, and --list-models prints a provider/model table, whole when pi writes it into a file (pp login, pp models and pp setup use them)", async () => {
	const env = { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" };
	const login = spawnSync(process.execPath, [piCli(), "auth", "login"], { env, encoding: "utf8", timeout: 60_000 });
	assert.match(`${login.stdout}${login.stderr}`, /pi auth login <provider> \[--api-key\]/);
	// Through a pipe, pi cuts this list short on a busy machine (it ends before the pipe is drained, exit code 0): the
	// last providers go missing, the fake one among them. Pi-Personal has pi write into a file instead (piPrints).
	const list = (await import("../core/providers.ts")).piPrints(["--list-models"], env);
	assert.equal(list.status, 0, list.stderr);
	assert.match(list.stdout, /^provider\s{2,}model\s{2,}/m);
	assert.match(list.stdout, /^fake\s{2,}echo-1\s/m);
});

test("pp setup starts with the model pi keeps as its default (/model, then Ctrl+S), else pi's first for the provider", async () => {
	const p = await import("../core/providers.ts");
	const file = path.join(t.home, "pi", "settings.json");
	const kept = fs.readFileSync(file, "utf8");
	const was = process.env.PI_PERSONAL_HOME;
	process.env.PI_PERSONAL_HOME = t.home;
	try {
		assert.equal(await p.chosenModel(), "fake/echo-1", "no default kept: the first model pi lists for the provider");
		fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(kept), defaultProvider: "fake", defaultModel: "echo-1" }));
		assert.equal(await p.chosenModel(), "fake/echo-1");
		fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(kept), defaultProvider: "gone", defaultModel: "x" }));
		assert.equal(await p.chosenModel(), "fake/echo-1", "a default whose provider is not connected is not used");
	} finally {
		if (was === undefined) delete process.env.PI_PERSONAL_HOME;
		else process.env.PI_PERSONAL_HOME = was;
		fs.writeFileSync(file, kept);
	}
});

test("a pasted API key is stored without what a terminal adds around a paste (spaces, line ends, paste marks)", async () => {
	const p = await import("../core/providers.ts");
	const file = path.join(t.home, "pi", "auth.json");
	const kept = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
	const was = process.env.PI_PERSONAL_HOME;
	process.env.PI_PERSONAL_HOME = t.home;
	try {
		fs.writeFileSync(file, JSON.stringify({ made: { type: "api_key", key: " \x1b[200~sk-made-up-123[201~\n" } }), { mode: 0o600 });
		assert.equal(await p.tidyKey("made"), true);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).made.key, "sk-made-up-123");
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		fs.writeFileSync(file, JSON.stringify({ made: { type: "api_key", key: "\x1b[200~\x1b[201~" } }), { mode: 0o600 });
		assert.equal(await p.tidyKey("made"), false, "nothing was pasted");
		assert.equal(await p.tidyKey("absent"), false);
	} finally {
		if (was === undefined) delete process.env.PI_PERSONAL_HOME;
		else process.env.PI_PERSONAL_HOME = was;
		if (kept === undefined) fs.rmSync(file, { force: true });
		else fs.writeFileSync(file, kept, { mode: 0o600 });
	}
});

test("pi: a provider's API-key sign-in asks for the key in one hidden prompt and returns it as an api_key entry, and pi uses an entry stored that way (pp remote login, with no terminal)", async () => {
	const p = await import("../core/providers.ts");
	const file = path.join(t.home, "pi", "auth.json");
	const kept = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
	const was = process.env.PI_PERSONAL_HOME;
	process.env.PI_PERSONAL_HOME = t.home;
	const env = { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" };
	try {
		// A provider of pi's own and one of its models.json: each asked for the key alone, and stored under its id.
		for (const [id, key] of [["anthropic", "sk-ant-contract-123"], ["fake", "sk-fake-contract-456"]]) {
			assert.ok((await p.loginWithKey(id, key)).length > 0);
			assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8"))[id], { type: "api_key", key });
			const used = spawnSync(process.execPath, [piCli(), "auth", "print-api-key", "--provider", id], { env, encoding: "utf8", timeout: 60_000 });
			assert.equal(used.stdout.trim(), key, `pi uses the stored entry for ${id}: ${used.stderr}`);
		}
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		// One that asks for a choice first (Amazon Bedrock) or for more than the key (Cloudflare) is refused, nothing stored.
		for (const id of ["amazon-bedrock", "cloudflare-workers-ai"]) {
			await assert.rejects(p.loginWithKey(id, "sk-more"), /asks for more than a key: run pp login .* --api-key in a terminal/);
			assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))[id], undefined);
		}
	} finally {
		if (was === undefined) delete process.env.PI_PERSONAL_HOME;
		else process.env.PI_PERSONAL_HOME = was;
		if (kept === undefined) fs.rmSync(file, { force: true });
		else fs.writeFileSync(file, kept, { mode: 0o600 });
	}
});

test("pi: in rpc mode it answers get_state once it has loaded (the runner's sign that pi got through loading)", () => {
	const r = dry(folder("plain"), ["-ne"]);
	assert.match(r.stdout, /"command"\s*:\s*"get_state"/);
	assert.match(r.stdout, /"success"\s*:\s*true/);
});

test('pi: an extension that throws at load is named as Failed to load extension "<path>" (safe mode reads this)', () => {
	const dir = path.join(folder("broken"), "ext");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "index.ts"), 'throw new Error("broken on purpose");\nexport default function () {}\n');
	const r = dry(path.dirname(dir), ["-e", dir]);
	assert.match(`${r.stderr}${r.stdout}`, new RegExp(`Failed to load extension "${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("pi: it loads .pi/extensions of its folder by itself, and -ne turns them off (safe mode relies on -ne)", () => {
	const f = folder("found");
	const marker = path.join(f, "loaded");
	fs.mkdirSync(path.join(f, ".pi", "extensions", "probe"), { recursive: true });
	fs.writeFileSync(path.join(f, ".pi", "extensions", "probe", "index.ts"), `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "x");\nexport default function () {}\n`);
	dry(f, ["-ne"]);
	assert.ok(!fs.existsSync(marker), "-ne: not loaded");
	dry(f, []);
	assert.ok(fs.existsSync(marker), "found and loaded by pi itself");
});

test("pi: -ne -e <a> -e <b> loads exactly those extensions, none other it finds (safe mode keeps the healthy ones on this way)", () => {
	const f = folder("picked");
	const loaded = (n: string) => path.join(f, `loaded-${n}`);
	for (const n of ["a", "b", "c"]) {
		fs.mkdirSync(path.join(f, ".pi", "extensions", n), { recursive: true });
		fs.writeFileSync(path.join(f, ".pi", "extensions", n, "index.ts"), `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(loaded(n))}, "x");\nexport default function () {}\n`);
	}
	const r = dry(f, ["-ne", "-e", path.join(f, ".pi", "extensions", "a"), "-e", path.join(f, ".pi", "extensions", "b")]);
	assert.match(r.stdout, /"success"\s*:\s*true/);
	assert.deepEqual(["a", "b", "c"].filter((n) => fs.existsSync(loaded(n))), ["a", "b"]);
});

test("pi: a tool whose extension was off at a request is recorded as removed, and stays off at later starts once its extension loads again; pi.setActiveTools turns it on (the bridge's tools-off and tools-on)", async () => {
	const f = folder("removed");
	const ext = path.join(f, ".pi", "extensions", "tooly");
	fs.mkdirSync(ext, { recursive: true });
	const turnOn = path.join(f, "turn-on");
	fs.writeFileSync(
		path.join(ext, "index.ts"),
		`import * as fs from "node:fs";
export default function (pi) {
	pi.registerTool({ name: "tooly_ping", label: "Ping", description: "pong", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "pong" }], details: undefined }; } });
	pi.on("session_start", () => { if (fs.existsSync(${JSON.stringify(turnOn)})) pi.setActiveTools([...pi.getActiveTools(), "tooly_ping"]); });
}
`,
	);
	const env = { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_CODING_AGENT_SESSION_DIR: path.join(f, "sessions"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
	// One prompt, printed, on one session; the fake model answers in this process, so pi runs asynchronously.
	const ask = async (args: string[], text: string) => {
		const pi = spawn(process.execPath, [piCli(), ...args, "--model", "fake/echo-1", "--session-id", "6f0c1a52-6d1e-4c62-9a55-3f5d2d0b7a11", "-p", text], { cwd: f, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		pi.stdout.on("data", (d) => (out += d));
		pi.stderr.on("data", (d) => (out += d));
		assert.equal(await new Promise((r) => pi.on("exit", r)), 0, out);
		return t.model.requests.findLast((q) => q.users.at(-1) === text)!.tools;
	};
	assert.ok((await ask([], "with it")).includes("tooly_ping"));
	assert.ok(!(await ask(["-ne"], "without it")).includes("tooly_ping"), "-ne: its extension is off");
	assert.ok(!(await ask([], "loaded again")).includes("tooly_ping"), "loaded again, but pi keeps it off");
	fs.writeFileSync(turnOn, "");
	assert.ok((await ask([], "turned on")).includes("tooly_ping"), "pi.setActiveTools at session_start declares it again");
	fs.rmSync(turnOn);
	assert.ok((await ask([], "and after")).includes("tooly_ping"), "and pi recorded it as added");
});

test("pi: the session stores a custom message with its details, the bridge's markers, and lives in PI_CODING_AGENT_SESSION_DIR", async () => {
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.equal((await t.cli("send", "main", "remember me", "--id", "c-1", "--wait", "--timeout", "60")).stdout.trim(), "echo: remember me");
	const sessions = path.join(t.home, "agents", "main", "sessions");
	const files = (fs.readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
	assert.equal(files.length, 1, "one session file, in Pi-Personal's own folder");
	const entries = fs.readFileSync(path.join(sessions, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const ours = entries.find((e) => e.type === "custom_message" && e.customType === "pi-personal.message");
	assert.equal(ours?.details?.id, "c-1", "the port id travels inside pi's own session");
	assert.ok(entries.some((e) => e.type === "custom" && e.customType === "pi-personal.settled"), "appendEntry is stored");
	// The message is moved to taken/ only once that entry is on disk.
	assert.ok(fs.existsSync(path.join(t.portOf("main"), "taken", "c-1.json")));
});

test("pi: --session-id <id> creates that session, then opens it whatever is newer; --continue opens the newest (the runner pins the agent's session; an agent made by 0.4 is started once with --continue)", async () => {
	const f = folder("pinned");
	const sessions = path.join(t.dir, "pinned-sessions");
	// Not spawnSync: the fake model answers from this process. Standard input closed: pi -p would read it.
	const pi = async (...args: string[]) => {
		const p = spawn(process.execPath, [piCli(), "-ne", "--model", "fake/echo-1", ...args], {
			cwd: f,
			env: { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_CODING_AGENT_SESSION_DIR: sessions, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		assert.equal(await new Promise((r) => p.on("exit", r)), 0, err);
		return t.model.requests.at(-1)!.users;
	};
	await pi("--session-id", "pinned-1", "-p", "first");
	const files = () => (fs.readdirSync(sessions) as string[]).filter((x) => x.endsWith(".jsonl"));
	assert.equal(files().length, 1);
	assert.equal(JSON.parse(fs.readFileSync(path.join(sessions, files()[0]), "utf8").split("\n")[0]).id, "pinned-1", "created with that id");
	await pi("-p", "a helper's own session"); // newer, as a pi started with the agent's environment leaves
	assert.deepEqual(await pi("--continue", "-p", "third"), ["a helper's own session", "third"], "--continue: the newest session");
	assert.deepEqual(await pi("--session-id", "pinned-1", "-p", "second"), ["first", "second"], "--session-id: that session, not the newest");
	assert.equal(files().length, 2, "opened, not created again");
});

test("pi: a custom message sent with triggerTurn false while pi is idle is in the session when the call returns, starts no run and sends extensions no message_start; the session file is written only once a user or assistant message is in it, then each entry at once (notes told without waking)", async () => {
	const f = folder("noted");
	const sessions = path.join(t.dir, "noted-sessions");
	const out = path.join(t.dir, "noted.jsonl");
	const probe = path.join(f, "probe.ts");
	fs.writeFileSync(
		probe,
		`import * as fs from "node:fs";
export default function (pi) {
	let starts = 0;
	pi.on("message_start", (e) => { if (e.message.role === "custom") starts++; });
	pi.on("session_start", (_e, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		const idle = ctx.isIdle();
		pi.sendMessage({ customType: "probe.note", content: "kept " + process.env.PROBE_RUN, display: true, details: { n: 1 } }, { triggerTurn: false });
		const inSession = ctx.sessionManager.getEntries().some((e) => e.type === "custom_message" && e.customType === "probe.note" && e.content === "kept " + process.env.PROBE_RUN);
		const onDisk = fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("kept " + process.env.PROBE_RUN);
		fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ run: process.env.PROBE_RUN, idle, inSession, onDisk, fileBefore: fs.existsSync(file), starts }) + "\\n");
	});
}
`,
	);
	const pi = async (run: string, ...args: string[]) => {
		const p = spawn(process.execPath, [piCli(), "-ne", "-e", probe, "--model", "fake/echo-1", "--session-id", "noted-1", ...args], {
			cwd: f,
			env: { ...t.env, PROBE_RUN: run, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_CODING_AGENT_SESSION_DIR: sessions, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
			stdio: [args.includes("rpc") ? "pipe" : "ignore", "ignore", "pipe"],
		});
		let err = "";
		p.stderr.on("data", (d) => (err += d));
		if (args.includes("rpc")) p.stdin!.end(`${JSON.stringify({ type: "get_state" })}\n`); // pi answers, then ends with its input
		assert.equal(await new Promise((r) => p.on("exit", r)), 0, err);
	};
	const asked = t.model.requests.length;
	const files = () => (fs.existsSync(sessions) ? fs.readdirSync(sessions) : []).filter((x) => x.endsWith(".jsonl"));
	await pi("new", "--mode", "rpc");
	assert.equal(t.model.requests.length, asked, "no run: the model was not asked");
	assert.deepEqual(files(), [], "custom messages alone: pi wrote no session file");
	await pi("reply", "-p", "hello"); // a user message and the model's reply: now the file exists
	assert.equal(files().length, 1);
	await pi("kept", "--mode", "rpc");
	const seen = fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(seen[0], { run: "new", idle: true, inSession: true, onDisk: false, fileBefore: false, starts: 0 }, "idle: in the session at once, no message_start");
	assert.deepEqual(seen[2], { run: "kept", idle: true, inSession: true, onDisk: true, fileBefore: true, starts: 0 }, "once the file exists, the entry is on disk when the call returns");
	assert.equal(t.model.requests.length, asked + 1, "only the prompt reached the model");
});

test("pi: a dialog opened by an extension raises ui_prompt_start, and overlapping dialogs share one span that ends with the last; neither event names the asker; a dialog given an AbortSignal closes on abort (the bridge's blocked state and its own dialog)", async () => {
	const f = folder("prompts");
	const out = path.join(t.dir, "prompts.jsonl");
	const probe = path.join(f, "probe.ts");
	fs.writeFileSync(
		probe,
		`import * as fs from "node:fs";
const log = (x) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify(x) + "\\n");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export default function (pi) {
	pi.on("ui_prompt_start", (e) => log(e));
	pi.on("ui_prompt_end", (e) => log(e));
	pi.on("session_start", (_e, ctx) => {
		void (async () => {
			const a = new AbortController();
			const b = new AbortController();
			const first = ctx.ui.select("First?", ["x", "y"], { signal: a.signal });
			const second = ctx.ui.confirm("Second?", "body", { signal: b.signal });
			await pause(300);
			log({ mark: "both open" });
			a.abort();
			log({ mark: "first closed", answer: (await first) ?? null });
			await pause(300);
			b.abort();
			log({ mark: "second closed", answer: await second });
			await pause(300);
			log({ mark: "done" });
		})();
	});
}
`,
	);
	const p = spawn(process.execPath, [piCli(), "-ne", "-e", probe, "--no-session", "--mode", "rpc"], {
		cwd: f,
		env: { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
		stdio: ["pipe", "ignore", "ignore"],
	});
	const lines = () => (fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
	try {
		await until(() => lines().some((l) => l.mark === "done"), 60_000);
	} finally {
		p.stdin!.end();
		p.kill();
	}
	const seen = lines();
	const at = (mark: string) => seen.findIndex((l) => l.mark === mark);
	assert.deepEqual(
		seen.filter((l) => l.type),
		[
			{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "First?" },
			{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "First?" },
		],
		"one span, named by its first dialog, for both",
	);
	const end = seen.findIndex((l) => l.type === "ui_prompt_end");
	assert.ok(seen.findIndex((l) => l.type === "ui_prompt_start") < at("both open") && at("first closed") < end && end < at("done"), JSON.stringify(seen));
	assert.deepEqual([seen[at("first closed")].answer, seen[at("second closed")].answer], [null, false], "closed by the abort: no answer");
});

test("pi: -ne turns its built-in extensions off, MCP the witness (safe mode leaves them out: pi offers no way to pick among them)", async () => {
	const commands = (args: string[]) => {
		const r = spawnSync(process.execPath, [piCli(), ...args, "--no-session", "--mode", "rpc"], {
			cwd: folder("plain"),
			env: { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
			input: `${JSON.stringify({ type: "get_commands" })}\n`,
			encoding: "utf8",
			timeout: 60_000,
		});
		const answer = r.stdout.split("\n").map((l) => (l.startsWith("{") ? JSON.parse(l) : {})).find((m) => m.command === "get_commands");
		assert.ok(answer?.success, `${r.stdout}${r.stderr}`);
		return (answer.data.commands as { name: string }[]).map((c) => c.name);
	};
	assert.ok(commands([]).includes("mcp"), "the built-in MCP extension is on by itself");
	assert.ok(!commands(["-ne"]).includes("mcp"), "-ne: off");
});

test("pi: --thinking takes exactly the levels the core knows (pi only warns on another one)", () => {
	const r = dry(folder("plain"), ["-ne", "--thinking", "not-a-level"]);
	// Without pi's colours: node --test asks its children for them when it runs in a terminal.
	const said = /Valid values: ([^\n]*)/.exec(`${r.stderr}${r.stdout}`.replace(/\x1b\[[0-9;]*m/g, ""))?.[1];
	assert.equal(said?.trim(), THINKING.join(", "), `${r.stderr}${r.stdout}`);
	assert.match(r.stdout, /"success"\s*:\s*true/, "a warning only: pi starts");
});

test("pi: the agent's session is resumed after a restart", async () => {
	await t.cli("restart", "main");
	assert.equal((await t.cli("send", "main", "again", "--wait", "--timeout", "60")).stdout.trim(), "echo: again");
	assert.ok(t.model.requests.at(-1)!.users.includes("remember me"), "the earlier exchange is in the model's context");
	const sessions = path.join(t.home, "agents", "main", "sessions");
	assert.equal((fs.readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).length, 1);
});

test("pi: an MCP server declared in the agent's folder (.pi/mcp.json) reaches the agent under Pi-Personal", async () => {
	const f = path.join(t.dir, "agents", "main");
	const server = path.join(t.dir, "mcp-probe.mjs");
	const stamp = path.join(t.dir, "mcp-called");
	// The smallest stdio MCP server: one tool, "stamp", that leaves a file and says so.
	fs.writeFileSync(
		server,
		`import * as fs from "node:fs";
import * as readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
	else if (m.method === "tools/list") send({ id: m.id, result: { tools: [{ name: "stamp", description: "Leave a mark", inputSchema: { type: "object", properties: { word: { type: "string" } } } }] } });
	else if (m.method === "tools/call") { fs.writeFileSync(${JSON.stringify(stamp)}, String(m.params.arguments?.word)); send({ id: m.id, result: { content: [{ type: "text", text: "stamped " + m.params.arguments?.word }] } }); }
	else if (m.id !== undefined) send({ id: m.id, result: {} });
});
`,
	);
	fs.mkdirSync(path.join(f, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(f, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [server], exposure: "direct" } } }));
	await t.cli("restart", "main");
	const r = await t.cli("send", "main", 'call: mcp__probe__stamp {"word":"apricot"}', "--wait", "--timeout", "60");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8"), "apricot", "the MCP tool ran");
	assert.match(r.stdout, /stamped apricot/);
	fs.rmSync(path.join(f, ".pi", "mcp.json"));
});

test("pi: a pi package declared in the agent's folder (.pi/settings.json) loads under Pi-Personal, and safe mode turns it off", async () => {
	const f = path.join(t.dir, "agents", "main");
	const pkg = path.join(t.dir, "probe-package");
	const loaded = path.join(t.dir, "package-loaded");
	fs.mkdirSync(path.join(pkg, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "probe-package", version: "1.0.0", type: "module" }));
	fs.writeFileSync(path.join(pkg, "extensions", "probe.ts"), `import * as fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(loaded)}, "x");\nexport default function () {}\n`);
	fs.writeFileSync(path.join(f, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
	await t.cli("restart", "main");
	assert.ok(fs.existsSync(loaded), "the package's extension was loaded by pi under Pi-Personal");
	fs.rmSync(loaded);
	assert.ok(!fs.existsSync(loaded) && dry(f, ["-ne"]).status === 0 && !fs.existsSync(loaded), "-ne (safe mode) leaves it out");
	fs.rmSync(path.join(f, ".pi", "settings.json"));
	await t.cli("restart", "main");
});

// ---- Herdr Core ----------------------------------------------------------------------------------------------

/** hc run as core/herdr.ts calls it (--json goes before "--", or it would reach the program). */
const run = (name: string, labels: Record<string, string>, argv: string[], cwd = t.dir) =>
	JSON.parse(
		execFileSync("hc", ["run", "--bg", "--no-parent", "--no-notify", "--cwd", cwd, "--name", name, ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]), "--json", "--", ...argv], {
			env: t.env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	);
const until = async (pred: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(100);
	}
};

test("Herdr Core: a live name is unique; labels come back from get and filter ls", () => {
	const a = run("ctr-one", { "ctr.role": "probe", "ctr.n": "1" }, ["sleep", "30"]);
	assert.throws(() => run("ctr-one", { "ctr.role": "probe" }, ["sleep", "30"]), "a second live terminal with the same name is refused");
	const got = t.hc("get", a.address);
	assert.equal(got.state, "live");
	assert.equal(got.labels["ctr.n"], "1");
	const listed = t.hc("ls", "--label", "ctr.role=probe").terminals;
	assert.deepEqual(listed.map((x: { address: string }) => x.address), [a.address]);
	t.hc("kill", a.address);
	t.hc("rm", a.address);
});

test("Herdr Core: a terminal gets the core's environment, not the caller's (why the runner is given --home)", async () => {
	const out = path.join(t.dir, "env.txt");
	const marker = `CTR_ONLY_HERE_${process.pid}`;
	const env = { ...t.env, [marker]: "1" };
	execFileSync("hc", ["run", "--bg", "--no-parent", "--no-notify", "--cwd", t.dir, "--name", "ctr-env", "--json", "--", "sh", "-c", `echo "[\${${marker}:-}]" > ${out}`], { env, encoding: "utf8" });
	await until(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("]"));
	assert.equal(fs.readFileSync(out, "utf8").trim(), "[]");
});

test("Herdr Core: a finished terminal stays listed with its exit code until removed (up reports why it ended)", async () => {
	const a = run("ctr-exit", { "ctr.role": "exit" }, ["sh", "-c", "exit 7"]);
	await until(() => t.hc("get", a.address).state === "finished");
	const got = t.hc("get", a.address);
	assert.equal(got.exit_code, 7);
	assert.ok(t.hc("ls", "--all", "--label", "ctr.role=exit").terminals.some((x: { address: string }) => x.address === a.address));
	assert.ok(!t.hc("ls", "--label", "ctr.role=exit").terminals.some((x: { address: string }) => x.address === a.address), "not among live ones");
	t.hc("rm", a.address);
});

test("Herdr Core: a program's OSC 7501 status shows in get (the runner reports failures this way)", async () => {
	const msg = Buffer.from("probe failed").toString("base64");
	const a = run("ctr-osc", { "ctr.role": "osc" }, ["sh", "-c", `printf '\\033]7501;state=error:app=pi-personal:msg=${msg}\\033\\\\'; sleep 30`]);
	await until(() => t.hc("get", a.address).status?.state === "error");
	assert.equal(t.hc("get", a.address).status.msg, "probe failed");
	t.hc("kill", a.address);
	t.hc("rm", a.address);
});

test("Herdr Core: when a terminal the agent started ends, what it types into the agent's terminal is one <hc>...</hc> block (never taken for the owner typing); with --no-notify it types nothing", async () => {
	const P = t.portOf("main");
	const from = port.end(P);
	const settledAfter = (cursor: number) => t.waitEvent("main", cursor, (e) => e.type === "settled", 60_000);
	assert.equal((await t.cli("send", "main", "tool: hc run --bg --name ctr-kid -- sh -c 'echo last words; exit 3'", "--wait", "--timeout", "60")).code, 0);
	const typed = await t.waitEvent("main", from, (e) => e.type === "input", 60_000);
	assert.match(String(typed.text), /^<hc>t\d+ ctr-kid exited \(exit 3\)\. Last lines:\nlast words\nRead: hc read t\d+<\/hc>$/);
	assert.equal(hcNote(String(typed.text)), true, "the bridge's rule knows this shape");
	await settledAfter(typed.cursor); // the note woke the agent: let it finish
	// What the agent's instructions ask for: a helper started with --no-notify leaves no note.
	const quiet = port.end(P);
	assert.equal((await t.cli("send", "main", "tool: hc run --bg --no-notify --name ctr-quiet -- sh -c 'echo quiet; exit 3'", "--wait", "--timeout", "60")).code, 0);
	await until(() => t.hc("get", "ctr-quiet").state === "finished");
	await sleep(4000);
	assert.equal(port.events(P, quiet).events.filter((e) => e.type === "input").length, 0);
});

test("Herdr Core: kill reaches the program as a signal the bridge can catch before it ends", async () => {
	const out = path.join(t.dir, "sig.txt");
	const a = run("ctr-sig", { "ctr.role": "sig" }, ["sh", "-c", `trap 'echo got >> ${out}; exit 0' HUP TERM; while :; do sleep 0.2; done`]);
	await sleep(500);
	t.hc("kill", a.address);
	await until(() => fs.existsSync(out));
	assert.equal(fs.readFileSync(out, "utf8").trim(), "got");
	t.hc("rm", a.address);
});
