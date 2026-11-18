// Regressions: crash windows, input rewritten by an extension, slow extensions, Escape, extensions pi finds by itself,
// two private areas on one Herdr Core, the login service never starting Herdr Core.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as herdr from "../core/herdr.ts";
import * as port from "../core/port.ts";
import { changeSettings, type Env, ROOT, run, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const P = () => t.portOf("main");
const settings = (patch: Record<string, unknown>) => changeSettings(folder(), patch);
const ext = (name: string, code: string) => {
	fs.mkdirSync(path.join(folder(), "extensions", name), { recursive: true });
	fs.writeFileSync(path.join(folder(), "extensions", name, "index.ts"), code);
};
const restartAndWait = async () => {
	const from = port.end(P());
	await t.cli("restart", "main");
	return t.waitEvent("main", from, (e) => e.type === "started" && !e.channel);
};
const count = (from: number, pred: (e: port.Seen) => boolean) => port.events(P(), from).events.filter(pred).length;

before(async () => {
	t = await setup("rev");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	await t.cli("start", "main");
	assert.equal((await t.cli("send", "main", "first words", "--wait", "--timeout", "30")).code, 0);
});
after(async () => t.close());

test("a message is reported taken only once pi stored it; a crash before that delivers it again, once", async () => {
	// An extension slows down pi between placing a message and storing it.
	ext("slow", 'export default function (pi) { pi.on("message_end", async (e) => { if (e.message.role === "custom") await new Promise((r) => setTimeout(r, 3000)); }); }\n');
	settings({ extensions: ["slow"] });
	const started = await restartAndWait();
	const from = port.end(P());
	await t.cli("send", "main", "do not lose me", "--id", "slow-1");
	await sleep(1500); // placed, not yet stored
	assert.equal(count(from, (e) => e.type === "taken" && e.id === "slow-1"), 0, "not reported taken yet");
	process.kill(Number(started.pid), "SIGKILL");
	await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("slow-1"), 40_000);
	assert.equal(count(from, (e) => e.type === "taken" && e.id === "slow-1"), 1);
	assert.equal(t.model.requests.filter((r) => r.users.at(-1) === "do not lose me").length, 1);
	settings({ extensions: [] });
});

test("an extension that rewrites typed input does not touch port messages, which are handled once", async () => {
	ext("rewrite", 'export default function (pi) { pi.on("input", async (e) => ({ action: "transform", text: "REWRITTEN " + e.text })); }\n');
	settings({ extensions: ["rewrite"] });
	await restartAndWait();
	const from = port.end(P());
	const r = await t.cli("send", "main", "keep my words", "--wait", "--timeout", "30");
	assert.equal(r.stdout.trim(), "echo: keep my words");
	await sleep(12_000); // longer than the bridge's retry delay
	assert.equal(count(from, (e) => e.type === "taken"), 1);
	assert.equal(count(from, (e) => e.type === "message"), 1);
	settings({ extensions: [] });
	await restartAndWait();
});

test("work cut off by killing the runner (not only pi) is resumed after up", async () => {
	const from = port.end(P());
	await t.cli("send", "main", "tool: sleep 4; echo long", "--id", "cut-1");
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "cut-1");
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	process.kill(t.hc("get", s.address).pid, "SIGKILL"); // the runner: Herdr ends the terminal, pi with it
	for (let i = 0; i < 50 && JSON.parse((await t.cli("status", "main", "--json")).stdout).running; i++) await sleep(100);
	await t.cli("up");
	const reply = await t.waitEvent("main", from, (e) => e.type === "message" && JSON.stringify(e.refs).includes("cut-1") && String(e.text).includes("interruption"), 30_000);
	assert.ok(reply);
});

test("send --wait on an id already answered shows that answer at once", async () => {
	await t.cli("send", "main", "answer me once", "--id", "again-1", "--wait", "--timeout", "30");
	const t0 = Date.now();
	const r = await t.cli("send", "main", "answer me once", "--id", "again-1", "--wait", "--timeout", "30");
	assert.equal(r.code, 0);
	assert.equal(r.stdout.trim(), "echo: answer me once");
	assert.ok(Date.now() - t0 < 10_000);
});

test("a second Pi-Personal home on the same Herdr Core never touches the first one's terminals", async () => {
	const other = { ...t.env, PI_PERSONAL_HOME: path.join(t.dir, "home2") };
	const cli = (...args: string[]) => run(process.execPath, [path.join(ROOT, "core", "cli.ts"), ...args], { env: other }).catch((e) => e);
	await cli("init", "main", path.join(t.dir, "agents", "main2"), "--model", "fake/echo-1");
	const before = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	const r = await cli("start", "main");
	assert.notEqual(r.code ?? 0, 0, "the terminal name is taken: the second home cannot start its own main here");
	await cli("stop", "main");
	const after = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.equal(after.running, true);
	assert.equal(after.address, before.address);
});

test("the login service's up never starts a Herdr Core that is not running", async () => {
	const env = { ...t.env, HC_SESSION: `${t.env.HC_SESSION}x` }; // a core nobody started
	assert.equal(await herdr.isRunning(env), false);
	const r = await run(process.execPath, [path.join(ROOT, "core", "cli.ts"), "up", "--if-running"], { env });
	assert.match(r.stdout, /Herdr Core is not running: nothing started/);
	assert.equal(await herdr.isRunning(env), false);
	assert.equal(await herdr.isRunning(t.env), true);
});

test("pi's own discovery stays on: an extension in the folder's .pi/extensions loads; a broken one there means safe mode", async () => {
	const dir = path.join(folder(), ".pi", "extensions", "found");
	fs.mkdirSync(dir, { recursive: true });
	const flag = path.join(t.dir, "found-loaded");
	fs.writeFileSync(path.join(dir, "index.ts"), `import * as fs from "node:fs";\nexport default function () { fs.writeFileSync(${JSON.stringify(flag)}, "yes"); }\n`);
	await restartAndWait();
	assert.ok(fs.existsSync(flag), "pi loaded the project extension it discovered");
	fs.writeFileSync(path.join(dir, "index.ts"), 'throw new Error("discovered and broken");\n');
	const from = port.end(P());
	await t.cli("restart", "main");
	const safe = await t.waitEvent("main", from, (e) => e.type === "safe_mode", 60_000);
	assert.match(JSON.stringify(safe.extensions), /found/);
	assert.equal((await t.cli("send", "main", "safe but here", "--wait", "--timeout", "30")).stdout.trim(), "echo: safe but here");
	fs.rmSync(path.join(folder(), ".pi"), { recursive: true });
	const from2 = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from2, (e) => e.type === "started" && !e.channel && e.safeMode === null);
});

test("another extension with a slow message_end handler does not make a message count twice", async () => {
	ext("slowend", 'export default function (pi) { pi.on("message_end", async () => { await new Promise((r) => setTimeout(r, 1500)); }); }\n');
	settings({ extensions: ["slowend"] });
	await restartAndWait();
	const from = port.end(P());
	assert.equal((await t.cli("send", "main", "count me once", "--id", "once-1", "--wait", "--timeout", "60")).code, 0);
	await sleep(4000);
	assert.equal(count(from, (e) => e.type === "taken" && e.id === "once-1"), 1);
	assert.equal(t.model.requests.filter((r) => r.users.at(-1) === "count me once").length, 1);
	settings({ extensions: [] });
	await restartAndWait();
});

test("Escape while a message waits: it is neither lost nor passed by a newer one", async () => {
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	const from = port.end(P());
	await t.cli("send", "main", "tool: sleep 3; echo esc", "--id", "e1");
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "e1");
	await t.cli("send", "main", "waiting one", "--id", "e2");
	await sleep(500);
	await run("hc", ["keys", s.address, "escape"], { env: t.env }); // a person interrupts the first run
	await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("e1"));
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "e2");
	await t.cli("send", "main", "newer one", "--id", "e3");
	await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("e3"), 40_000);
	const taken = port.events(P(), from).events.filter((e) => e.type === "taken").map((e) => e.id);
	assert.deepEqual(taken, ["e1", "e2", "e3"]);
	const lastUsers = t.model.requests.slice(-6).map((r) => r.users.at(-1));
	assert.equal(t.model.requests.filter((r) => r.users.includes("waiting one") && r.users.at(-1) === "waiting one").length, 1, JSON.stringify(lastUsers));
});

test("a run that ends on a terminating tool is finished: no resume note after a restart", async () => {
	ext("term", 'export default function (pi) { pi.on("tool_call", async () => ({ block: true, reason: "not now", terminate: true })); }\n');
	settings({ extensions: ["term"] });
	await restartAndWait();
	await t.cli("send", "main", "tool: echo terminated", "--wait", "--timeout", "30");
	settings({ extensions: [] });
	const from = port.end(P());
	await restartAndWait();
	await sleep(2500);
	assert.equal(count(from, (e) => e.type === "message"), 0, "nothing was resumed");
});

test("an extension that makes pi exit while loading, without a name: safe mode anyway", async () => {
	ext("quits", "process.exit(1);\n");
	settings({ extensions: ["quits"] });
	const from = port.end(P());
	await t.cli("restart", "main");
	const safe = await t.waitEvent("main", from, (e) => e.type === "safe_mode", 60_000);
	assert.deepEqual(safe.extensions, ["quits"], "tried alone, it is found");
	assert.equal((await t.cli("send", "main", "still reachable", "--wait", "--timeout", "30")).stdout.trim(), "echo: still reachable");
	settings({ extensions: [] });
	await restartAndWait();
});

test("a broken channel entry is set aside and reported; the agent still starts", async () => {
	settings({ channels: { Mail: {}, discord: {} } });
	await restartAndWait();
	const s = await t.cli("status", "main");
	assert.match(s.stdout, /SETTINGS: .*"Mail" is not a valid channel name/);
	assert.match(s.stdout, /SETTINGS: .*channel "discord" has no command/);
	assert.equal((await t.cli("send", "main", "fine anyway", "--wait", "--timeout", "30")).stdout.trim(), "echo: fine anyway");
	settings({ channels: {} });
});

test("doctor runs a channel's check only for the program that ships; the user can run their own program's check", async () => {
	const flag = path.join(t.dir, "custom-ran");
	const script = path.join(t.dir, "custom-channel.sh");
	fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> ${flag}\n`, { mode: 0o755 });
	settings({ channels: { telegram: { command: [script] } } }); // a program of the user's own, under a shipped name
	const d = await t.cli("doctor");
	assert.ok(!fs.existsSync(flag), "doctor did not start the user's program");
	assert.match(d.stdout, /channel telegram: your own program/);
	assert.equal((await t.cli("channel", "main", "telegram", "check")).code, 0);
	assert.match(fs.readFileSync(flag, "utf8"), /^check$/m);
	settings({ channels: {} });
});
