// The keeper: a killed channel comes back and resends nothing; safe mode for an extension broken at load; an
// extension failing during a run; a program that cannot start; everything back after a reboot, with `up`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { changeSettings, type Env, lastStart, ROOT, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const P = () => t.portOf("main");
const chState = () => path.join(t.home, "agents", "main", "channels", "fake");
const settings = (patch: Record<string, unknown>) => changeSettings(folder(), patch);
const status = async () => JSON.parse((await t.cli("status", "main", "--json")).stdout);
const lastStarted = () => lastStart(P());
const viaChannel = async (id: string, text: string) => {
	fs.writeFileSync(path.join(chState(), "outbox", `${id}.txt`), text);
};
const sent = () => (fs.existsSync(path.join(chState(), "sent.jsonl")) ? fs.readFileSync(path.join(chState(), "sent.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (pred: () => boolean | Promise<boolean>, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!(await pred())) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(200);
	}
};

before(async () => {
	t = await setup("a07");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	settings({ channels: { fake: { command: [process.execPath, path.join(ROOT, "test", "fake-channel.ts")] } } });
	const r = await t.cli("start", "main");
	assert.match(r.stdout, /pi is ready\n.*started channel fake/);
	await until(() => fs.existsSync(path.join(chState(), "pid")));
});
after(async () => t.close());

test("a channel killed is restarted, resumes from its cursor and resends nothing; the agent is unaffected", async () => {
	await viaChannel("c1", "first through the channel");
	await until(() => sent().length === 1);
	const piPid = lastStarted().pid;
	const from = port.end(P());
	process.kill(Number(fs.readFileSync(path.join(chState(), "pid"), "utf8")), "SIGKILL");
	await t.waitEvent("main", from, (e) => e.type === "restarted" && e.channel === "fake");
	await sleep(1000);
	await viaChannel("c2", "second through the channel");
	await until(() => sent().length === 2);
	assert.deepEqual(sent().map((s) => s.text), ["echo: first through the channel", "echo: second through the channel"]);
	assert.equal(lastStarted().pid, piPid, "pi was not restarted");
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "restarted" && !e.channel).length, 0);
	const s = await status();
	assert.equal(s.channels[0].running, true);
	assert.match(s.channels[0].lastRestart.reason, /SIGKILL/);
});

test("an extension broken at load: safe mode, the user is told which, messages still flow", async () => {
	fs.mkdirSync(path.join(folder(), "extensions", "broken"), { recursive: true });
	fs.writeFileSync(path.join(folder(), "extensions", "broken", "index.ts"), 'throw new Error("broken on purpose");\n');
	settings({ extensions: ["broken"] });
	const check = await t.cli("ext", "check", "main");
	assert.equal(check.code, 1);
	assert.match(check.stdout, /pi does not start: failing: broken/);
	assert.match((await t.cli("ext", "check", "main", "broken")).stdout, /broken: FAILS: .*broken on purpose/);
	const from = port.end(P());
	await t.cli("restart", "main");
	const safe = await t.waitEvent("main", from, (e) => e.type === "safe_mode");
	assert.deepEqual(safe.extensions, ["broken"]);
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && Array.isArray(e.safeMode));
	assert.equal((await t.cli("send", "main", "still there?", "--wait", "--timeout", "30")).stdout.trim(), "echo: still there?");
	const s = await status();
	assert.deepEqual(s.safeMode, { off: ["broken"], broken: ["broken"], reason: "failing to load: broken; off: broken; an extension that is off enforces nothing while messages keep flowing; pi packages and pi's built-in extensions are off too" });
	assert.match((await t.cli("status", "main")).stdout, /SAFE MODE: running with extensions off: failing to load: broken; off: broken; /);
	// Fixed and restarted on purpose: safe mode ends.
	settings({ extensions: [] });
	const from2 = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from2, (e) => e.type === "started" && !e.channel && e.safeMode === null);
	assert.equal((await status()).safeMode, null);
});

test("an extension failing during a run: the agent keeps working, the error is visible", async () => {
	fs.mkdirSync(path.join(folder(), "extensions", "flaky"), { recursive: true });
	fs.writeFileSync(
		path.join(folder(), "extensions", "flaky", "index.ts"),
		'export default function (pi) { pi.on("tool_call", async () => { throw new Error("flaky handler exploded"); }); }\n',
	);
	settings({ extensions: ["flaky"] });
	const from = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.safeMode === null);
	const r = await t.cli("send", "main", "tool: echo runs anyway", "--wait", "--timeout", "30");
	assert.equal(r.code, 0, r.stderr);
	assert.ok(r.stdout.trim().length > 0);
	const screen = execFileSync("hc", ["read", (await status()).address], { env: t.env, encoding: "utf8" });
	assert.match(screen, /flaky handler exploded/);
	assert.equal((await t.cli("send", "main", "and after", "--wait", "--timeout", "30")).stdout.trim(), "echo: and after");
	settings({ extensions: [] });
});

test("pi stops before it is ready for a reason the load check cannot see: no safe mode by guess; it fails with its reason, and a fix applies at the next start", async () => {
	// An extension that exits only in a real terminal: the load check (no terminal) finds nothing wrong. Safe mode
	// is kept for what the check can show; this is a plain failure, retried later, with the exit code as the reason.
	fs.mkdirSync(path.join(folder(), "extensions", "exits"), { recursive: true });
	fs.writeFileSync(path.join(folder(), "extensions", "exits", "index.ts"), "if (process.stdout.isTTY) process.exit(3);\nexport default function () {}\n");
	settings({ extensions: ["exits"] });
	const from = port.end(P());
	await t.cli("restart", "main");
	const failed = await t.waitEvent("main", from, (e) => e.type === "failed" && !e.channel, 120_000);
	assert.match(String(failed.reason), /exited with code 3/);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "safe_mode").length, 0, "no safe mode on a guess");
	assert.match((await t.cli("status", "main")).stdout, /FAILED: .*exited with code 3/);
	// The fix is read at the scheduled attempt (the settings are read again at each start).
	settings({ extensions: [] });
	await t.waitEvent("main", failed.after, (e) => e.type === "started" && !e.channel, 60_000);
	assert.equal((await t.cli("send", "main", "back", "--wait", "--timeout", "30")).stdout.trim(), "echo: back");
	assert.equal((await status()).failed, undefined);
});

test("the program cannot start at all: retries stop at the limit, status failed with a reason, no busy loop", async () => {
	// The agent's folder disappears while it runs (an unmounted drive): every start fails at once.
	const started = port.events(P()).events.filter((e) => e.type === "started" && !e.channel).at(-1)!; // the pi running now
	assert.equal((await status()).running, true);
	const away = `${folder()}.away`;
	fs.renameSync(folder(), away);
	const from = port.end(P());
	const t0 = Date.now();
	process.kill(Number(started.pid)); // pi only, by the pid Pi-Personal reported; its runner stays
	const failed = await t.waitEvent("main", from, (e) => e.type === "failed" && !e.channel, 60_000);
	const restarts = port.events(P(), from).events.filter((e) => e.type === "restarted" && !e.channel);
	assert.ok(restarts.length <= 5, `${restarts.length} restarts`);
	assert.ok(Date.now() - t0 > 3000, "backoff between attempts");
	assert.match(String(failed.reason), /stopped 5 times/);
	assert.match(String(failed.reason), /folder .* is missing/);
	const s = await status();
	assert.ok(s.failed, "status shows the failure");
	assert.match((await t.cli("status", "main")).stdout, /FAILED: .*next attempt/);
	// Nothing happens until the scheduled attempt (PI_PERSONAL_RETRY_MS is short in tests).
	const quiet = port.end(P());
	await sleep(3000);
	assert.equal(port.events(P(), quiet).events.filter((e) => e.type === "restarted" && !e.channel).length, 0);
	fs.renameSync(away, folder()); // the drive is back: the scheduled attempt succeeds by itself
	await t.waitEvent("main", quiet, (e) => e.type === "restarted" && e.reason === "scheduled attempt after failure", 20_000);
	await t.waitEvent("main", quiet, (e) => e.type === "started" && !e.channel, 30_000);
	assert.equal((await t.cli("send", "main", "healthy again", "--wait", "--timeout", "30")).stdout.trim(), "echo: healthy again");
});

test("everything stopped as after a reboot, then up: agents come back with their conversations and channels", async () => {
	const core = t.hc("server", "status").core.id;
	t.hc("server", "stop"); // the isolated core only: the helper checked its identity
	await sleep(500);
	assert.equal(t.hc("server", "status").core.id, core); // a fresh start of the same isolated core
	assert.equal((await status()).running, false);
	await viaChannel("c3", "after the reboot");
	const r = await t.cli("up");
	assert.match(r.stdout, /main: started agent, fake/);
	await until(() => sent().some((s) => s.text === "echo: after the reboot"), 30_000);
	assert.ok(t.model.requests.at(-1)!.users.includes("first through the channel"), "conversation intact");
	const st = await status();
	assert.match(st.lastRestart.reason, /started again by up: its terminal ended \(stopped_by_restart|server_stop/, "status says why it came back");
	assert.match(st.channels[0].lastRestart.reason, /started again by up/);
	assert.equal(sent().filter((s) => s.text === "echo: first through the channel").length, 1, "nothing resent");
});
