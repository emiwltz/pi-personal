// Contracts: the behaviours of pi and Herdr Core that Pi-personal's core relies on, checked directly. When pi or Herdr Core
// is updated, these tests say at once whether an assumption broke, before a user finds out.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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

test("pi: its providers, their sign-in methods, environment variables and default models can be read (pp setup shows them)", async () => {
	const p = await import("../core/providers.ts");
	const all = await p.providers();
	assert.ok(all.length > 10, `pi lists ${all.length} providers`);
	const anthropic = all.find((x) => x.id === "anthropic");
	assert.ok(anthropic?.account && anthropic.apiKey, "Anthropic: an account sign-in and an API key");
	assert.deepEqual(await p.envKeys("openai", { OPENAI_API_KEY: "x" }), ["OPENAI_API_KEY"]);
	assert.equal(typeof (await p.defaultModel("anthropic")), "string", "pi names a default model for Anthropic");
});

test("pi: auth check answers in JSON, auth login takes --api-key, and --list-models prints a provider/model table (pp reads them)", () => {
	const env = { ...t.env, PI_CODING_AGENT_DIR: path.join(t.home, "pi"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" };
	const check = spawnSync(process.execPath, [piCli(), "auth", "check", "--provider", "anthropic", "--json"], { env, encoding: "utf8", timeout: 60_000 });
	assert.equal(JSON.parse(check.stdout.trim().split("\n").pop() ?? "{}").status, "not_ready");
	const login = spawnSync(process.execPath, [piCli(), "auth", "login"], { env, encoding: "utf8", timeout: 60_000 });
	assert.match(`${login.stdout}${login.stderr}`, /pi auth login <provider> \[--api-key\]/);
	const list = spawnSync(process.execPath, [piCli(), "--list-models"], { env, encoding: "utf8", timeout: 60_000 });
	assert.match(list.stdout, /^provider\s{2,}model\s{2,}/m);
	assert.match(list.stdout, /^fake\s{2,}echo-1\s/m);
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

test("pi: the session stores a custom message with its details, the bridge's markers, and lives in PI_CODING_AGENT_SESSION_DIR", async () => {
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.equal((await t.cli("send", "main", "remember me", "--id", "c-1", "--wait", "--timeout", "60")).stdout.trim(), "echo: remember me");
	const sessions = path.join(t.home, "agents", "main", "sessions");
	const files = (fs.readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
	assert.equal(files.length, 1, "one session file, in Pi-personal's own folder");
	const entries = fs.readFileSync(path.join(sessions, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const ours = entries.find((e) => e.type === "custom_message" && e.customType === "pi-personal.message");
	assert.equal(ours?.details?.id, "c-1", "the port id travels inside pi's own session");
	assert.ok(entries.some((e) => e.type === "custom" && e.customType === "pi-personal.settled"), "appendEntry is stored");
	// The message is moved to taken/ only once that entry is on disk.
	assert.ok(fs.existsSync(path.join(t.portOf("main"), "taken", "c-1.json")));
});

test("pi: --continue resumes the same session after a restart", async () => {
	await t.cli("restart", "main");
	assert.equal((await t.cli("send", "main", "again", "--wait", "--timeout", "60")).stdout.trim(), "echo: again");
	assert.ok(t.model.requests.at(-1)!.users.includes("remember me"), "the earlier exchange is in the model's context");
	const sessions = path.join(t.home, "agents", "main", "sessions");
	assert.equal((fs.readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).length, 1);
});

test("pi: an MCP server declared in the agent's folder (.pi/mcp.json) reaches the agent under Pi-personal", async () => {
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

test("pi: a pi package declared in the agent's folder (.pi/settings.json) loads under Pi-personal, and safe mode turns it off", async () => {
	const f = path.join(t.dir, "agents", "main");
	const pkg = path.join(t.dir, "probe-package");
	const loaded = path.join(t.dir, "package-loaded");
	fs.mkdirSync(path.join(pkg, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "probe-package", version: "1.0.0", type: "module" }));
	fs.writeFileSync(path.join(pkg, "extensions", "probe.ts"), `import * as fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(loaded)}, "x");\nexport default function () {}\n`);
	fs.writeFileSync(path.join(f, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
	await t.cli("restart", "main");
	assert.ok(fs.existsSync(loaded), "the package's extension was loaded by pi under Pi-personal");
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

test("Herdr Core: kill reaches the program as a signal the bridge can catch before it ends", async () => {
	const out = path.join(t.dir, "sig.txt");
	const a = run("ctr-sig", { "ctr.role": "sig" }, ["sh", "-c", `trap 'echo got >> ${out}; exit 0' HUP TERM; while :; do sleep 0.2; done`]);
	await sleep(500);
	t.hc("kill", a.address);
	await until(() => fs.existsSync(out));
	assert.equal(fs.readFileSync(out, "utf8").trim(), "got");
	t.hc("rm", a.address);
});
