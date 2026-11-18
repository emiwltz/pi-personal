// Edge cases found by adversarial reviews: who a reply goes to after a stop and a crash; silence after a stop or an
// empty run; an extension stuck in a loop; bursts; fairness; a lock shared with another Herdr Core; settings edits
// that lose nothing; a full disk; text typed in the terminal; extension checks; the sender line.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { openWork } from "../core/bridge.ts";
import * as port from "../core/port.ts";
import { type FakeTelegram, fakeTelegram } from "./fake-telegram.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

process.env.PI_PERSONAL_STARTUP_MS = "15000"; // the keeper's watchdog, read by the core when it starts

const CLI = path.join(ROOT, "core", "cli.ts");
const run = promisify(execFile);
const ALICE = 1001;
const BOB = 1002;
let t: Env;
let tg: FakeTelegram;
const folder = (n: string) => path.join(t.dir, "agents", n);
const P = (n = "main") => t.portOf(n);
const evs = (n = "main", from = 0) => port.events(P(n), from).events;
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);
const status = async (n = "main") => JSON.parse((await t.cli("status", n, "--json")).stdout);
const piPid = (n = "main") => Number(evs(n).filter((e) => e.type === "started" && !e.channel).at(-1)!.pid);
const dm = (from: number, text: string) => tg.push({ from: { id: from, first_name: from === ALICE ? "Alice" : "Bob" }, chat: { id: from, type: "private" }, text });
const until = async (pred: () => boolean | Promise<boolean>, ms = 30_000, what = "condition") => {
	const end = Date.now() + ms;
	while (!(await pred())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(200);
	}
};
async function mkAgent(name: string, settings: Record<string, unknown> = {}) {
	const r = await t.cli("init", name, folder(name), "--model", "fake/echo-1");
	assert.equal(r.code, 0, r.stderr);
	const f = path.join(folder(name), "pi-personal.json");
	fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...settings }, null, 2));
}
const secret = (name: string, token: string) =>
	execFileSync(process.execPath, [CLI, "secret", "set", name, "telegram-token"], { env: t.env, input: `${token}\n` });

before(async () => {
	t = await setup("fab2");
	tg = await fakeTelegram();
	await mkAgent("main", { channels: { telegram: { apiBase: tg.base } } });
	secret("main", tg.token);
	assert.equal((await t.cli("start", "main")).code, 0);
	for (const id of [ALICE, BOB]) assert.equal((await t.cli("channel", "main", "telegram", "allow", String(id))).code, 0);
	assert.equal((await t.cli("send", "main", "warm up", "--wait", "--timeout", "30")).code, 0);
	await until(() => tg.polls.length > 0, 20_000, "Telegram polling");
});
after(async () => {
	tg?.close();
	await t?.close();
});

// ---- never silent -----------------------------------------------------------------------------------------------

test("a stop in the middle of a run: its message gets a settled with the error; a message waiting its turn stays waiting, and is answered after start; nothing is resumed", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "cut-1", text: "tool: sleep 20; echo first", conversation: "cli" });
	await until(() => evs("main", from).some((e) => e.type === "taken" && e.id === "cut-1"), 20_000, "cut-1 taken");
	const waiter = t.cli("send", "main", "my turn next", "--id", "cut-2", "--wait", "--timeout", "60");
	await sleep(1500);
	assert.equal((await t.cli("stop", "main")).code, 0);
	const w = await waiter;
	assert.equal(w.code, 1, w.stdout + w.stderr);
	assert.match(w.stderr, /stopped before your message's turn; it waits in its port/);
	const all = evs("main", from);
	const settled = all.find((e) => e.type === "settled" && has(e, "cut-1"));
	assert.match(String(settled?.error), /stopped before answering/);
	assert.ok(!all.some((e) => e.type === "taken" && e.id === "cut-2"), "cut-2 joined the stopped work");
	const restarted = port.end(P());
	assert.equal((await t.cli("start", "main")).code, 0);
	await until(() => evs("main", restarted).some((e) => e.type === "settled" && has(e, "cut-2")), 30_000, "cut-2 answered after start");
	const after = evs("main", restarted);
	assert.ok(after.some((e) => e.type === "message" && e.text === "echo: my turn next" && has(e, "cut-2")));
	assert.ok(!after.some((e) => e.type === "message" && has(e, "cut-1")), "stopped work was resumed");
});

test("after a restart cut Alice's run and a crash cut Bob's, the resumed reply goes to Bob only; Alice is told once that hers was stopped", async () => {
	const from = port.end(P());
	const sent0 = tg.sent.length;
	const ua = dm(ALICE, "tool: sleep 20; echo alice-work");
	await until(() => evs("main", from).some((e) => e.type === "taken" && e.id === `tg-${ua}`), 20_000, "Alice's message taken");
	await sleep(1000);
	assert.equal((await t.cli("restart", "main")).code, 0);
	const ub = dm(BOB, "tool: sleep 8; echo BOB-PRIVATE-RESULT-42");
	await until(() => evs("main", from).some((e) => e.type === "taken" && e.id === `tg-${ub}`), 20_000, "Bob's message taken");
	await sleep(1500);
	process.kill(piPid(), "SIGKILL"); // a crash while it works for Bob (the pid Pi-Personal reported)
	await until(() => evs("main", from).some((e) => e.type === "settled" && has(e, `tg-${ub}`)), 60_000, "Bob's run to settle");
	const all = evs("main", from);
	const mixed = all.filter((e) => e.type === "message" && new Set(((e.refs as port.Ref[]) ?? []).map((r) => r.conversation)).size > 1);
	assert.equal(mixed.length, 0, JSON.stringify(mixed));
	assert.ok(!all.some((e) => e.type === "message" && has(e, `tg-${ua}`)), "a reply went to Alice's stopped message");
	assert.ok(all.some((e) => e.type === "message" && has(e, `tg-${ub}`)), "Bob got no reply after the crash");
	await sleep(2000);
	const toAlice = tg.sent.slice(sent0).filter((s) => s.chat === String(ALICE));
	assert.equal(toAlice.length, 1, JSON.stringify(toAlice));
	assert.match(toAlice[0].text, /could not answer: .*stopped before answering/);
});

test("a run that ends without any reply: settled carries the error, the last word; Telegram tells the sender", async () => {
	const r = await t.cli("send", "main", "silent: nothing to say", "--id", "sil-1", "--wait", "--timeout", "30");
	assert.equal(r.code, 1, r.stdout + r.stderr);
	assert.match(r.stderr, /without answering/);
	const all = evs("main");
	assert.match(String(all.find((e) => e.type === "settled" && has(e, "sil-1"))?.error), /without answering/);
	assert.ok(!all.some((e) => e.type === "error" && has(e, "sil-1")), "the end of a run is said once, by settled");
	const n = tg.sent.length;
	dm(ALICE, "silent: from the phone");
	await until(() => tg.sent.slice(n).some((s) => s.chat === String(ALICE) && /could not answer/.test(s.text)), 30_000, "Alice to be told");
});

// ---- fairness and bursts ----------------------------------------------------------------------------------------

test("a conversation that keeps writing does not keep the agent: another conversation's older message goes first", async () => {
	const from = port.end(P());
	const feed = (i: number) => port.submit(P(), { id: `feed-${i}`, text: "tool: sleep 2; echo f", conversation: "feed", from: { channel: "t" } });
	feed(0);
	await until(() => evs("main", from).some((e) => e.type === "taken" && e.id === "feed-0"), 20_000, "feed-0 taken");
	feed(1);
	await sleep(1000);
	port.submit(P(), { id: "bob-1", text: "my turn?", conversation: "bob", from: { channel: "t" } });
	for (let i = 2; i <= 8; i++) {
		await sleep(1000);
		feed(i);
	}
	await until(() => evs("main", from).some((e) => e.type === "settled" && has(e, "feed-8")), 120_000, "the feed to finish");
	const order = evs("main", from)
		.filter((e) => e.type === "taken")
		.map((e) => String(e.id));
	assert.ok(order.indexOf("bob-1") >= 0 && order.indexOf("bob-1") < order.indexOf("feed-3"), order.join(" "));
});

test("a burst of 2,000 messages over 200 conversations: the first is taken within seconds, and the agent keeps going", async () => {
	await mkAgent("burst");
	assert.equal((await t.cli("start", "burst")).code, 0);
	const inbox = path.join(P("burst"), "inbox");
	const from = port.end(P("burst"));
	const t0 = Date.now();
	for (let i = 0; i < 2000; i++) {
		const id = `b-${i}`;
		const tmp = path.join(inbox, `.${id}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify({ id, text: "hi", conversation: `c${i % 200}` }));
		fs.linkSync(tmp, path.join(inbox, `${id}.json`));
		fs.rmSync(tmp);
	}
	await t.waitEvent("burst", from, (e) => e.type === "taken", 60_000);
	const ms = Date.now() - t0;
	assert.ok(ms < 15_000, `the first message was taken after ${ms} ms`);
	await until(() => evs("burst", from).filter((e) => e.type === "taken").length >= 20, 60_000, "20 messages taken");
	await t.cli("stop", "burst");
});

// ---- the keeper ---------------------------------------------------------------------------------------------------

test("an extension that blocks while loading: safe mode names it; ext check and doctor return", async () => {
	await mkAgent("hang");
	fs.mkdirSync(path.join(folder("hang"), ".pi", "extensions", "hang"), { recursive: true });
	fs.writeFileSync(path.join(folder("hang"), ".pi", "extensions", "hang", "index.ts"), "export default function () {\n\tfor (;;) {}\n}\n");
	const from = port.end(P("hang"));
	await t.cli("start", "hang");
	const safe = await t.waitEvent("hang", from, (e) => e.type === "safe_mode", 150_000);
	assert.deepEqual(safe.extensions, ["hang"]);
	assert.equal((await t.cli("send", "hang", "still there?", "--wait", "--timeout", "60")).stdout.trim(), "echo: still there?");
	const t0 = Date.now();
	const c = await t.cli("ext", "check", "hang", "hang");
	assert.equal(c.code, 1, c.stdout + c.stderr);
	assert.ok(Date.now() - t0 < 60_000, "ext check hung");
	const d = await t.cli("doctor");
	assert.match(d.stdout, /agent hang: safe mode/);
	await t.cli("stop", "hang");
});

test("restart with a broken pi-personal.json stops nothing and says so", async () => {
	const f = path.join(folder("main"), "pi-personal.json");
	const good = fs.readFileSync(f, "utf8");
	const pid = piPid();
	fs.writeFileSync(f, good.replace(/}\s*$/, ",}\n"));
	try {
		const r = await t.cli("restart", "main");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /not valid JSON.*nothing was stopped/);
		const s = await status();
		assert.equal(s.running, true);
		assert.equal(s.stoppedOnPurpose, false);
		assert.equal(piPid(), pid);
	} finally {
		fs.writeFileSync(f, good);
	}
});

test("status keeps safe mode and the last error when the events file is moved aside (it reads keeper.json and last-error.json)", async () => {
	await mkAgent("arch");
	fs.mkdirSync(path.join(folder("arch"), ".pi", "extensions", "bad"), { recursive: true });
	fs.writeFileSync(path.join(folder("arch"), ".pi", "extensions", "bad", "index.ts"), "process.exit(0);\nexport default function () {}\n");
	const from = port.end(P("arch"));
	await t.cli("start", "arch");
	await t.waitEvent("arch", from, (e) => e.type === "started" && !e.channel && Array.isArray(e.safeMode), 120_000);
	assert.equal((await t.cli("send", "arch", "fail: kept after the archive", "--wait", "--timeout", "30")).code, 1);
	fs.renameSync(port.eventsFile(P("arch")), `${port.eventsFile(P("arch"))}.old`); // the events file moved aside by hand
	const s = await status("arch");
	assert.deepEqual(s.safeMode?.broken, ["bad"], JSON.stringify(s));
	assert.match(String(s.lastError?.error), /kept after the archive/);
	assert.match((await t.cli("status", "arch")).stdout, /SAFE MODE/);
	await t.cli("stop", "arch");
});

test("pi's session file cannot be written (a full disk): the sender is told at once, and answered once there is space again", async () => {
	await mkAgent("disk");
	assert.equal((await t.cli("start", "disk")).code, 0);
	assert.equal((await t.cli("send", "disk", "a first line in the session", "--wait", "--timeout", "30")).code, 0);
	const dir = path.join(t.home, "agents", "disk", "sessions");
	const file = (fs.readdirSync(dir, { recursive: true }) as string[])
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => path.join(dir, f))
		.at(-1)!;
	const from = port.end(P("disk"));
	fs.renameSync(file, `${file}.aside`);
	fs.symlinkSync("/dev/full", file); // every write fails with "no space left"
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		fs.rmSync(file);
		fs.renameSync(`${file}.aside`, file);
	};
	try {
		const waiter = t.cli("send", "disk", "tool: echo written-after-the-disk-was-full", "--id", "full-1", "--wait", "--timeout", "100");
		const told = await t.waitEvent("disk", from, (e) => e.type === "error" && has(e, "full-1"), 30_000);
		assert.match(String(told.error), /could not record this message.*trying again/);
		restore();
		const r = await waiter;
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /done: written-after-the-disk-was-full/);
		assert.match(r.stderr, /could not record this message/);
	} finally {
		restore();
		await t.cli("stop", "disk");
	}
});

// ---- one private area seen from two Herdr Cores -------------------------------------------------------------------

test("the agent runs in another Herdr Core: status says where, send --wait is answered, stop refuses and changes nothing", async () => {
	const b = await setup("fab2b");
	const envB = { ...b.env, PI_PERSONAL_HOME: t.home };
	const pb = async (...args: string[]) => {
		const r = await run(process.execPath, [CLI, ...args], { env: envB, timeout: 90_000 }).catch((e) => e);
		return { code: Number(r.code ?? 0), stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
	};
	try {
		await mkAgent("far");
		const st = await pb("start", "far");
		assert.equal(st.code, 0, st.stdout + st.stderr);
		const s = await status("far");
		assert.equal(s.state, "running elsewhere");
		assert.ok(Number.isInteger(s.elsewhere));
		assert.match((await t.cli("status", "far")).stdout, /runs in another terminal or Herdr Core \(runner pid \d+\)/);
		const r = await t.cli("send", "far", "hello from here", "--wait", "--timeout", "30");
		assert.equal(r.stdout.trim(), "echo: hello from here", r.stderr);
		assert.doesNotMatch(r.stderr, /not running/);
		const stop = await t.cli("stop", "far");
		assert.equal(stop.code, 1);
		assert.match(stop.stderr, /runs in another terminal or Herdr Core .*stop it from there/);
		assert.equal(fs.existsSync(path.join(t.home, "agents", "far", "stopped")), false);
		assert.equal((await pb("stop", "far")).code, 0);
	} finally {
		await b.close();
	}
});

test("a stale lock and two cores starting the agent at once: one pi; the waiting runner gives up once the agent is stopped on purpose", async () => {
	const b = await setup("fab2c");
	const envB = { ...b.env, PI_PERSONAL_HOME: t.home };
	const pb = (...args: string[]) => run(process.execPath, [CLI, ...args], { env: envB, timeout: 90_000 }).catch((e) => e);
	type T = { name: string; state: string; pid: number; address: string };
	const live = (env: Env) =>
		((env.hc("ls").terminals ?? []) as T[]).filter((x) => x.name === "pi-personal-race" && x.state === "live").map((x) => env.hc("get", x.address) as T);
	try {
		await mkAgent("race");
		const lock = path.join(t.home, "agents", "race", "runner.lock");
		// What a reboot leaves: a lock naming a live process that is not a runner (here, this test).
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
		const from = port.end(P("race"));
		await Promise.all([t.cli("start", "race"), pb("start", "race")]);
		await t.waitEvent("race", from, (e) => e.type === "started" && !e.channel, 60_000);
		// If one core saw the other's lock in time, it started nothing: start a runner there anyway, as a race can.
		for (const [env, other] of [[t, b], [b, t]] as const)
			if (!live(env).length && live(other).length)
				execFileSync("hc", ["run", "--bg", "--no-parent", "--no-notify", "--cwd", t.dir, "--name", "pi-personal-race", "--", process.execPath, CLI, "_run", "race", "--home", t.home], { env: env.env, stdio: "pipe" });
		await sleep(8000);
		const pis = new Set(evs("race", from).filter((e) => e.type === "started" && !e.channel).map((e) => e.pid));
		assert.equal(pis.size, 1, `${pis.size} pi started`);
		const holder = Number(JSON.parse(fs.readFileSync(lock, "utf8")).pid);
		const inA = live(t);
		const inB = live(b);
		assert.equal(inA.length + inB.length, 2, "one runner in each core");
		const winnerInA = inA.some((x) => x.pid === holder);
		assert.ok(winnerInA || inB.some((x) => x.pid === holder), "the lock belongs to one of the two runners");
		// Stopped on purpose where it runs: the runner that waits in the other core must not take over.
		if (winnerInA) assert.equal((await t.cli("stop", "race")).code, 0);
		else assert.equal(Number((await pb("stop", "race")).code ?? 0), 0);
		const waiting = winnerInA ? b : t;
		await until(() => live(waiting).length === 0, 40_000, "the waiting runner to give up");
		await sleep(1000);
		assert.equal(new Set(evs("race", from).filter((e) => e.type === "started" && !e.channel).map((e) => e.pid)).size, 1, "the waiting runner started pi");
	} finally {
		await b.close();
	}
});

// ---- settings and the command line --------------------------------------------------------------------------------

test("channel add keeps what it does not understand, and a channel's own options reach it", async () => {
	const f = path.join(folder("main"), "pi-personal.json");
	const good = fs.readFileSync(f, "utf8");
	const before = JSON.parse(good);
	const printer = path.join(t.dir, "printer.mjs");
	fs.writeFileSync(printer, "if (process.argv.length > 2) console.log(JSON.stringify(process.argv.slice(2)));\nelse setInterval(() => {}, 1e9);\n");
	fs.writeFileSync(f, JSON.stringify({ ...before, channels: { ...before.channels, spool: { spool: "/some/path" }, Mail: { command: ["x"] } } }, null, 2));
	try {
		const r = await t.cli("channel", "add", "main", "spool", "--", process.execPath, printer);
		assert.equal(r.code, 0, r.stderr);
		const now = JSON.parse(fs.readFileSync(f, "utf8"));
		assert.equal(now.channels.spool.spool, "/some/path");
		assert.equal(now.channels.spool.enabled, true);
		assert.deepEqual(now.channels.Mail, { command: ["x"] });
		assert.deepEqual(now.channels.telegram, before.channels.telegram);
		const out = await t.cli("channel", "main", "spool", "allow", "alice", "--force", "-v");
		assert.deepEqual(JSON.parse(out.stdout.trim()), ["allow", "alice", "--force", "-v"]);
	} finally {
		await t.cli("channel", "remove", "main", "spool");
		fs.writeFileSync(f, good);
	}
});

test('send "-h" sends the text "-h"', async () => {
	assert.equal((await t.cli("send", "main", "-h", "--wait", "--timeout", "30")).stdout.trim(), "echo: -h");
});

test("an id starting with a dot is refused at once, not accepted and lost", async () => {
	const r = await t.cli("send", "main", "hello", "--id", ".hidden");
	assert.notEqual(r.code, 0);
	assert.match(r.stderr, /not starting with a dot/);
	assert.equal(fs.existsSync(path.join(P(), "inbox", ".hidden.json")), false);
});

test("the Telegram guest list is never read from the agent's folder: an allow list in pi-personal.json lets nobody in", async () => {
	const tg2 = await fakeTelegram("456:OTHER");
	try {
		await mkAgent("gift", { channels: { telegram: { apiBase: tg2.base, allow: [7777] } } });
		secret("gift", tg2.token);
		assert.equal((await t.cli("start", "gift")).code, 0);
		await until(() => tg2.polls.length > 0, 20_000, "polling");
		const from = port.end(P("gift"));
		tg2.push({ from: { id: 7777, first_name: "Stranger" }, chat: { id: 7777, type: "private" }, text: "tool: echo pwned" });
		await until(() => tg2.polls.length > 2, 20_000, "the update to be fetched");
		await sleep(2000);
		assert.equal(port.pending(P("gift")).length, 0);
		assert.equal(evs("gift", from).filter((e) => e.type === "taken").length, 0);
		const who = await t.cli("channel", "gift", "telegram", "who");
		assert.match(who.stdout, /7777/);
		assert.match(who.stdout, /Allowed: nobody/);
	} finally {
		await t.cli("stop", "gift");
		tg2.close();
	}
});

// ---- after the code review of these fixes -----------------------------------------------------------------------

test("a message already in the session is never handed again, even when moving it to taken/ fails (taken/ removed)", async () => {
	const from = port.end(P());
	fs.rmSync(path.join(P(), "taken"), { recursive: true, force: true });
	const r = await t.cli("send", "main", "once only", "--id", "once-1", "--wait", "--timeout", "30");
	assert.equal(r.stdout.trim(), "echo: once only", r.stderr);
	await sleep(3000);
	const all = evs("main", from);
	assert.equal(all.filter((e) => e.type === "message" && has(e, "once-1")).length, 1, "answered more than once");
	assert.equal(all.filter((e) => e.type === "taken" && e.id === "once-1").length, 1);
	assert.ok(fs.existsSync(path.join(P(), "taken", "once-1.json")), "taken/ is made again");
});

test("an id sent again after its taken/ file was cleaned up is a duplicate, not a silent 'taken'", async () => {
	assert.equal((await t.cli("send", "main", "nightly", "--id", "nightly-1", "--wait", "--timeout", "30")).code, 0);
	fs.rmSync(path.join(P(), "taken", "nightly-1.json")); // what the 30-day cleanup does
	const from = port.end(P());
	const r = await t.cli("send", "main", "nightly", "--id", "nightly-1", "--wait", "--timeout", "30");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stderr, /already taken earlier/);
	const all = evs("main", from);
	assert.ok(all.some((e) => e.type === "duplicate" && e.id === "nightly-1"));
	assert.ok(!all.some((e) => e.type === "taken" && e.id === "nightly-1"));
});

test("a passing provider error that pi retries by itself is not told to the sender: only the answer arrives", async () => {
	const from = port.end(P());
	const n = tg.sent.length;
	const u = dm(ALICE, "flaky: hello after an overload");
	await until(() => evs("main", from).some((e) => e.type === "settled" && has(e, `tg-${u}`)), 60_000, "the run to settle");
	const all = evs("main", from);
	assert.ok(!all.some((e) => (e.type === "error" || (e.type === "settled" && e.error)) && has(e, `tg-${u}`)), "an error was told for a request pi retried");
	assert.ok(all.some((e) => e.type === "message" && has(e, `tg-${u}`)));
	await until(() => tg.sent.slice(n).some((s) => /flaky: hello after an overload/.test(s.text)), 20_000, "the answer on Telegram");
	assert.ok(!tg.sent.slice(n).some((s) => /could not answer/.test(s.text)));
});

test("a stop while pi is down after a crash: the stopped work is closed at the next start, its sender told, nothing resumed", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "down-1", text: "tool: sleep 20; echo never", conversation: "cli", from: { channel: "cli" } });
	await until(() => evs("main", from).some((e) => e.type === "taken" && e.id === "down-1"), 20_000, "down-1 taken");
	await sleep(1500);
	process.kill(piPid(), "SIGKILL"); // a crash (the pid Pi-Personal reported)
	assert.equal((await t.cli("stop", "main")).code, 0); // at once: pi is down, or just coming back
	const mid = port.end(P());
	assert.equal((await t.cli("start", "main")).code, 0);
	await t.waitEvent("main", from, (e) => e.type === "settled" && has(e, "down-1") && !!e.error, 30_000);
	await sleep(3000);
	assert.ok(!evs("main", mid).some((e) => e.type === "message" && has(e, "down-1")), "the stopped work was resumed");
	assert.equal(fs.existsSync(path.join(t.home, "agents", "main", "was-stopped")), false, "the one-shot mark is used up");
});

test("a lock whose pid now belongs to another agent's runner (after a reboot) does not block this agent", async () => {
	await mkAgent("reuse");
	const other = Number(JSON.parse(fs.readFileSync(path.join(t.home, "agents", "main", "runner.lock"), "utf8")).pid); // a live runner
	fs.writeFileSync(path.join(t.home, "agents", "reuse", "runner.lock"), JSON.stringify({ pid: other, at: "2020-01-01T00:00:00.000Z" }));
	assert.notEqual((await status("reuse")).state, "running elsewhere");
	const r = await t.cli("start", "reuse");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /pi is ready/);
	assert.equal((await t.cli("send", "reuse", "free", "--wait", "--timeout", "30")).stdout.trim(), "echo: free");
	await t.cli("stop", "reuse");
});

// ---- after the final judge ---------------------------------------------------------------------------------------

test("the agent sees who wrote: the Telegram channel starts its text with a From line (name, id, conversation); the core adds nothing", async () => {
	const u = dm(BOB, "who am I?");
	await until(() => evs("main").some((e) => e.type === "settled" && has(e, `tg-${u}`)), 30_000, "Bob's message to settle");
	const asked = t.model.requests.filter((r) => /who am I\?/.test(r.raw)).at(-1)!;
	assert.match(asked.raw, /^From: "Bob" \(Telegram user 1002\) · telegram:1002\n\nwho am I\?/); // written by the channel, not the core
	assert.equal((await t.cli("send", "main", "plain line", "--wait", "--timeout", "30")).stdout.trim(), "echo: plain line");
	assert.equal(t.model.requests.filter((r) => /plain line/.test(r.raw)).at(-1)!.raw, "plain line");
	assert.match(fs.readFileSync(path.join(folder("main"), "AGENTS.md"), "utf8"), /Several people may write to you/);
});

test("pi-personal.json: a model that is not a string is refused with its reason; an unknown key is reported, not silently taken", async () => {
	const f = path.join(folder("main"), "pi-personal.json");
	const good = fs.readFileSync(f, "utf8");
	try {
		fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(good), model: 5 }));
		const r = await t.cli("restart", "main");
		assert.equal(r.code, 1);
		assert.match(r.stderr, /model must be a string.*nothing was stopped/);
		// pp up on a running agent whose settings cannot be read: it runs, and that is what up says.
		const up = await t.cli("up");
		assert.equal(up.code, 0, up.stdout + up.stderr);
		assert.match(up.stdout, /main: skipped \(running; its settings cannot be read now/);
		fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(good), modle: "fake/echo-1" }));
		assert.match((await t.cli("status", "main")).stdout, /SETTINGS: .*"modle" is not a setting; it is ignored/);
	} finally {
		fs.writeFileSync(f, good);
	}
});

test("a full disk while pi restarts: the keeper does not kill pi for not reporting ready; it answers once there is space", async (tc) => {
	if (!fs.existsSync("/dev/full")) return tc.skip("simulated with /dev/full, which only Linux has");
	const ev = port.eventsFile(P());
	const log = path.join(t.home, "agents", "main", "log.txt");
	const logBefore = fs.readFileSync(log, "utf8").length;
	const pid = piPid();
	fs.renameSync(ev, `${ev}.aside`);
	fs.symlinkSync("/dev/full", ev); // every write to the events file fails with "no space left"
	try {
		process.kill(pid, "SIGKILL"); // a crash while the disk is full
		await sleep(25_000); // longer than the 15 s watchdog of this file
	} finally {
		fs.rmSync(ev);
		fs.renameSync(`${ev}.aside`, ev);
	}
	const r = await t.cli("send", "main", "back after the full disk", "--wait", "--timeout", "60");
	assert.equal(r.stdout.trim(), "echo: back after the full disk", r.stderr);
	const since = fs.readFileSync(log, "utf8").slice(logBefore);
	assert.doesNotMatch(since, /did not get ready/, since);
	assert.doesNotMatch(since, /safe mode/);
});

test("restart while another command starts the agent at the same moment: both end well, never two terminals", async () => {
	for (let i = 0; i < 3; i++) {
		const [r, u] = await Promise.all([t.cli("restart", "main"), (async () => (await sleep(300 + i * 400), t.cli("up")))()]);
		assert.doesNotMatch(r.stderr + u.stderr, /already named/, r.stderr + u.stderr);
		assert.equal(u.code, 0, u.stdout + u.stderr);
	}
	await until(async () => (await status()).state === "idle", 60_000, "the agent to be idle");
	const live = ((t.hc("ls").terminals ?? []) as { name: string; state: string }[]).filter((x) => x.name === "pi-personal-main" && x.state === "live");
	assert.equal(live.length, 1);
	assert.equal((await t.cli("send", "main", "still one", "--wait", "--timeout", "30")).stdout.trim(), "echo: still one");
});

// ---- after the review of the cleanup ----------------------------------------------------------------------------

test("a final failure after an interim sentence is not silent: settled carries the error, send --wait exits 1, status shows it", async () => {
	const from = port.end(P());
	const r = await t.cli("send", "main", "interim-fail: check the build", "--id", "half-1", "--wait", "--timeout", "60");
	assert.equal(r.code, 1, r.stdout + r.stderr);
	assert.match(r.stdout, /Let me check\./);
	assert.match(r.stderr, /no full reply: .*fake refusal after an interim reply/);
	const settled = evs("main", from).find((e) => e.type === "settled" && has(e, "half-1"));
	assert.match(String(settled?.error), /fake refusal after an interim reply/);
	assert.match(String((await status()).lastError?.error), /fake refusal after an interim reply/);
});

test("text typed in the terminal during a port run never gets its answer sent to the port's sender", async () => {
	// With pi 1.5.2, text typed while a tool runs is handled after the run, in a run of its own.
	const from = port.end(P());
	port.submit(P(), { id: "typed-1", text: "tool: sleep 4; echo slow", conversation: "cli" });
	await until(() => evs("main", from).some((e) => e.type === "taken" && e.id === "typed-1"), 20_000, "typed-1 taken");
	const addr = (await status()).address;
	for (let i = 0; i < 20; i++) {
		try {
			execFileSync("hc", ["send", addr, "a private note from the owner"], { env: t.env, stdio: "pipe" });
			break;
		} catch {
			await sleep(500);
		}
	}
	await until(() => evs("main", from).some((e) => e.type === "message" && /private note/.test(String(e.text))), 60_000, "the typed text answered");
	const all = evs("main", from);
	const typedReply = all.find((e) => e.type === "message" && /private note/.test(String(e.text)))!;
	assert.deepEqual(typedReply.refs, [], "the answer to the typed text went to a port message");
	// If pi places typed text inside a port run, the rest of that run is the terminal's (the logic, on a session).
	const ours = (id: string) => ({ type: "custom_message", customType: "pi-personal.message", details: { id, conversation: "telegram:1" } });
	const said = (text: string, stopReason = "stop") => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason } });
	const typed = { type: "message", message: { role: "user", content: "private note" } };
	const w = openWork([ours("m1"), typed, said("the note says 1234", "toolUse")]);
	assert.equal(w.typed, true);
	assert.deepEqual(w.unanswered.map((r) => r.id), ["m1"], "m1 is still unanswered: the reply was the terminal's");
	const w2 = openWork([ours("m1"), said("let me check", "toolUse"), typed, said("the note says 1234")]);
	assert.equal(w2.typed, true, "after typing, later replies stay with the terminal");
});

test("extension checks count only what pi loads, and give extensions a port: a README is ignored, an extension that reads PI_PERSONAL_PORT loads", async () => {
	await mkAgent("needport");
	const dir = path.join(folder("needport"), ".pi", "extensions");
	fs.mkdirSync(path.join(dir, "needs-port"), { recursive: true });
	fs.writeFileSync(path.join(dir, "README.md"), "notes, not an extension\n");
	fs.writeFileSync(path.join(dir, "needs-port", "index.ts"), 'if (!process.env.PI_PERSONAL_PORT) throw new Error("no port");\nexport default function () {}\n');
	const c = await t.cli("ext", "check", "needport");
	assert.equal(c.code, 0, c.stdout + c.stderr);
	assert.doesNotMatch(c.stdout, /README/);
	assert.match(c.stdout, /needs-port/);
	assert.match(c.stdout, /pi starts fine/);
	assert.equal((await t.cli("start", "needport")).code, 0);
	assert.equal((await status("needport")).safeMode, null);
	await t.cli("stop", "needport");
});
