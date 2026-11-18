// Lifecycle: start says whether pi got ready; extensions that stop pi while loading; quitting pi is not a failure;
// work stopped on purpose is not resumed; one private area seen from two Herdr Cores.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import * as port from "../core/port.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

// Real restart rules for the /quit test: 5 failures within 10 minutes would give up. (Read by the core at its start.)
process.env.PI_PERSONAL_WINDOW_MS = "600000";

const run = promisify(execFile);
const CLI = path.join(ROOT, "core", "cli.ts");
let t: Env;
const folder = (n: string) => path.join(t.dir, "agents", n);
const P = (n: string) => t.portOf(n);
const evs = (n: string, from = 0) => port.events(P(n), from).events;
const started = (n: string) => evs(n).filter((e) => e.type === "started" && !e.channel);
const status = async (n: string) => JSON.parse((await t.cli("status", n, "--json")).stdout);
const until = async (pred: () => boolean | Promise<boolean>, ms = 30_000, what = "condition") => {
	const end = Date.now() + ms;
	while (!(await pred())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
};
/** Type into the agent's terminal, as a person does (retries while Herdr Core settles). */
async function type(n: string, text: string) {
	const addr = (await status(n)).address;
	for (let i = 0; i < 20; i++) {
		try {
			execFileSync("hc", ["send", addr, text], { env: t.env, stdio: "pipe" });
			return;
		} catch {
			await sleep(500);
		}
	}
	throw new Error(`could not type ${text}`);
}
async function mkAgent(name: string, extension?: string) {
	const r = await t.cli("init", name, folder(name), "--model", "fake/echo-1");
	assert.equal(r.code, 0, r.stderr);
	if (extension) {
		fs.mkdirSync(path.join(folder(name), ".pi", "extensions", "ext"), { recursive: true });
		fs.writeFileSync(path.join(folder(name), ".pi", "extensions", "ext", "index.ts"), extension);
	}
}

before(async () => {
	t = await setup("fkeep");
});
after(async () => t.close());

// ---- `start` says whether pi got ready ---------------------------------------------------------------------

test("start of a healthy agent says pi is ready (text and --json), and exits 0", async () => {
	await mkAgent("good");
	const r = await t.cli("start", "good");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /good: started; pi is ready/);
	assert.equal(started("good").length, 1, "the ready claim is backed by a 'started' event from pi");
	// Already running: no false "ready" claim, nothing started twice.
	const again = await t.cli("start", "good", "--json");
	assert.equal(again.code, 0);
	const j = JSON.parse(again.stdout);
	assert.deepEqual(j.started, []);
	assert.deepEqual(j.running, ["agent"]);
	assert.equal(j.ready, undefined);
	assert.equal(started("good").length, 1);
});

test("start of an agent whose pi cannot get ready says so and exits 1 (it does not just say 'started')", async () => {
	await mkAgent("bad", 'throw new Error("broken on purpose");\nexport default function () {}\n');
	const r = await t.cli("start", "bad", "--json");
	assert.equal(r.code, 1, r.stdout + r.stderr);
	const j = JSON.parse(r.stdout);
	assert.equal(j.ready, false);
	assert.match(String(j.trouble), /safe mode: failing to load: ext/);
	await t.cli("stop", "bad");
	const text = await t.cli("start", "bad");
	assert.match(text.stdout, /bad: started, but /);
	assert.equal(text.code, 1);
	assert.doesNotMatch(text.stdout, /pi is ready/);
	await t.cli("stop", "bad");
});

// ---- an extension that makes pi exit 0 while it loads ---------------------------------------------------------

test("an extension that always exits 0 at load: safe mode names it, messages still flow", async () => {
	await mkAgent("ext0", "process.exit(0);\nexport default function () {}\n");
	const from = port.end(P("ext0"));
	await t.cli("start", "ext0");
	const safe = await t.waitEvent("ext0", from, (e) => e.type === "safe_mode", 90_000);
	assert.deepEqual(safe.extensions, ["ext"], JSON.stringify(safe)); // pi could not name it; tried alone, it is found
	const s = await t.waitEvent("ext0", from, (e) => e.type === "started" && !e.channel && Array.isArray(e.safeMode), 60_000);
	assert.ok((s.safeMode as string[]).includes("ext"), JSON.stringify(s.safeMode)); // the unnamed-cause marker may follow
	assert.equal((await t.cli("send", "ext0", "still there?", "--wait", "--timeout", "40")).stdout.trim(), "echo: still there?");
	const st = await status("ext0");
	assert.ok(st.safeMode?.off.includes("ext"), JSON.stringify(st.safeMode));
	assert.match((await t.cli("status", "ext0")).stdout, /SAFE MODE/);
	// Fixed, restarted on purpose: safe mode ends.
	fs.writeFileSync(path.join(folder("ext0"), ".pi", "extensions", "ext", "index.ts"), "export default function () {}\n");
	const from2 = port.end(P("ext0"));
	await t.cli("restart", "ext0");
	await t.waitEvent("ext0", from2, (e) => e.type === "started" && !e.channel && e.safeMode === null, 60_000);
	await t.cli("stop", "ext0");
});

test("an extension that exits 0 only in a real terminal (the load check sees nothing): a plain failure with its reason, never a guessed safe mode", async () => {
	await mkAgent("extt", "if (process.stdout.isTTY) process.exit(0);\nexport default function () {}\n");
	const from = port.end(P("extt"));
	await t.cli("start", "extt");
	const failed = await t.waitEvent("extt", from, (e) => e.type === "failed" && !e.channel, 180_000);
	assert.match(String(failed.reason), /exited normally/);
	assert.equal(evs("extt", from).filter((e) => e.type === "safe_mode").length, 0);
	assert.equal((await t.cli("send", "extt", "ping", "--wait", "--timeout", "10")).code, 1, "send --wait says the agent cannot start");
	await t.cli("stop", "extt");
});

// ---- clean exits (/quit) are not failed starts ----------------------------------------------------------------

test("five /quit in a row (the give-up limit): each is started again at once, never 'failed', no safe mode", async () => {
	await t.cli("stop", "good"); // a fresh run so every quit is measured on its own
	const from0 = port.end(P("good"));
	assert.equal((await t.cli("start", "good")).code, 0);
	for (let i = 1; i <= 5; i++) {
		const before = started("good").length;
		const last = started("good").at(-1)!;
		// pi must have been up at least 10 s for a quit to count as "on purpose".
		await until(() => Date.now() - Number(new Date(String(last.at))) > 11_000, 20_000, "pi up for 11 s");
		const from = port.end(P("good"));
		await type("good", "/quit");
		await t.waitEvent("good", from, (e) => e.type === "restarted" && e.reason === "pi was quit; started again", 40_000);
		await until(() => started("good").length === before + 1, 60_000, `start ${i}`);
		assert.notEqual(started("good").at(-1)!.pid, last.pid);
	}
	const all = evs("good", from0);
	assert.equal(all.filter((e) => e.type === "failed").length, 0, "never gave up");
	assert.equal(all.filter((e) => e.type === "safe_mode").length, 0);
	assert.equal(all.filter((e) => e.type === "restarted" && e.reason !== "pi was quit; started again").length, 0);
	const s = await status("good");
	assert.equal(s.running, true);
	assert.equal(s.failed, undefined);
	assert.equal(s.safeMode, null);
	assert.equal((await t.cli("send", "good", "after my quits", "--wait", "--timeout", "40")).stdout.trim(), "echo: after my quits");
});

// ---- stop then start does not resume stopped work -----------------------------------------------------------

const modelAsks = () => t.model.requests.length;
/** Send a slow tool run and wait until its tool is running. Returns the event cursor from before the message. */
async function startWork(agent: string, id: string, sleepS: number) {
	const from = port.end(P(agent));
	await t.cli("send", agent, `tool: sleep ${sleepS}; echo done-${id}`, "--id", id);
	await t.waitEvent(agent, from, (e) => e.type === "taken" && e.id === id, 40_000);
	await until(async () => (await status(agent)).state === "working", 30_000, "working");
	await sleep(1500); // the tool is running now
	return from;
}

test("a crash in the middle of a run still resumes the work", async () => {
	const from = await startWork("good", "k1", 4);
	const pid = Number(started("good").at(-1)!.pid); // the pid Pi-Personal reported: pi only
	process.kill(pid, "SIGKILL");
	await t.waitEvent("good", from, (e) => e.type === "started" && e.pid !== pid, 60_000);
	await t.waitEvent("good", from, (e) => e.type === "message" && JSON.stringify(e.refs).includes('"k1"'), 60_000);
});

test("stop in the middle of a run, then start: the stopped work is not resumed", async () => {
	const from = await startWork("good", "k2", 20);
	assert.equal((await t.cli("stop", "good")).code, 0);
	assert.equal((await status("good")).running, false);
	await sleep(1000);
	const asks = modelAsks();
	const r = await t.cli("start", "good");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /pi is ready/);
	assert.equal(fs.existsSync(path.join(t.home, "agents", "good", "stopped")), false, "the stop mark is cleared by start");
	await sleep(8000); // absence of an event: give a resumed run time to show itself
	assert.equal(modelAsks(), asks, "the model was not asked again for the stopped work");
	const after = evs("good", from);
	assert.equal(after.filter((e) => e.type === "message" && JSON.stringify(e.refs).includes('"k2"')).length, 0, "no reply for stopped work");
	assert.equal(after.filter((e) => e.type === "taken" && e.id === "k2").length, 1);
	// A new message gets its own answer.
	assert.equal((await t.cli("send", "good", "fresh start", "--wait", "--timeout", "40")).stdout.trim(), "echo: fresh start");
	assert.equal(t.model.requests.at(-1)!.users.at(-1), "fresh start");
});

test("restart (stop + start) does not resume stopped work either", async () => {
	const from = await startWork("good", "k3", 20);
	await sleep(500);
	const asks = modelAsks();
	const r = await t.cli("restart", "good");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /pi is ready/);
	await sleep(8000);
	assert.equal(modelAsks(), asks);
	assert.equal(evs("good", from).filter((e) => e.type === "message" && JSON.stringify(e.refs).includes('"k3"')).length, 0);
});

// ---- one private area, two Herdr Cores ------------------------------------------------------------------------

test("the same private area seen from a second Herdr Core runs no second pi; a second runner waits for the lock", async () => {
	const b = await setup("fkeepb");
	const envB = { ...b.env, PI_PERSONAL_HOME: t.home };
	const pb = async (...args: string[]) => {
		const r = await run(process.execPath, [CLI, ...args], { env: envB, timeout: 90_000 }).catch((e) => e);
		return { code: Number(r.code ?? 0), stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
	};
	try {
		await t.cli("restart", "good");
		const effects = path.join(t.dir, "effects.txt");
		const pi0 = started("good").at(-1)!;
		const nStarted = started("good").length;
		const lock = JSON.parse(fs.readFileSync(path.join(t.home, "agents", "good", "runner.lock"), "utf8"));
		assert.ok(Number.isInteger(lock.pid));

		// 1. The commands a person or a login service runs from the other core.
		const st = await pb("start", "good");
		assert.match(st.stdout, /running in another terminal or Herdr Core: agent \(runner pid \d+\)/, st.stdout + st.stderr);
		assert.doesNotMatch(st.stdout, /pi is ready/);
		const up = await pb("up");
		assert.match(up.stdout, /good: running elsewhere/);

		// 2. A runner that reaches the lock anyway (the race the checks above cannot close) waits and starts nothing.
		const child = spawn(process.execPath, [CLI, "_run", "good", "--home", t.home], { env: envB, stdio: "ignore" });
		const exited = new Promise((res) => child.on("exit", res));
		const log = path.join(t.home, "agents", "good", "log.txt");
		await until(() => fs.existsSync(log) && /already running in another terminal \(runner pid \d+\)/.test(fs.readFileSync(log, "utf8")), 30_000, "the second runner says it waits");
		await sleep(3000);

		// 3. Four messages, each with one side effect: each happens once, by the one pi.
		const from = port.end(P("good"));
		for (let i = 1; i <= 4; i++) port.submit(P("good"), { id: `two-${i}`, text: `tool: echo effect-${i} >> ${effects}`, from: { channel: "t" } });
		await until(() => [1, 2, 3, 4].every((i) => evs("good", from).some((e) => e.type === "settled" && JSON.stringify(e.refs).includes(`"two-${i}"`))), 90_000, "four runs settled");
		child.kill("SIGTERM"); // our own child, by its handle
		await Promise.race([exited, sleep(20_000)]);
		const lines = fs.readFileSync(effects, "utf8").trim().split("\n").sort();
		assert.deepEqual(lines, ["effect-1", "effect-2", "effect-3", "effect-4"]);
		for (let i = 1; i <= 4; i++) assert.equal(evs("good", from).filter((e) => e.type === "taken" && e.id === `two-${i}`).length, 1);
		assert.equal(started("good").length, nStarted, "no second pi announced itself");
		assert.equal(started("good").at(-1)!.pid, pi0.pid);
		assert.equal(JSON.parse(fs.readFileSync(path.join(t.home, "agents", "good", "runner.lock"), "utf8")).pid, lock.pid, "the lock still belongs to the first runner");
	} finally {
		await b.close();
	}
});
