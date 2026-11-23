// Interrupting from the port: a control message ("control": "interrupt") stops the run in progress, whatever pi is
// doing, and is itself settled at once with its result; it never waits behind a run, never reaches the model and is
// never written into the session. `pp interrupt` refuses when the agent does not run, and withdraws what got no result.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import * as port from "../core/port.ts";
import { CLI, type Env, lastStart, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const P = () => t.portOf("main");
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);
const settled = (id: string, from = 0, ms = 30_000) => t.waitEvent("main", from, (e) => e.type === "settled" && has(e, id), ms);
const probe = (f: string) => path.join(t.home, "agents", "main", "extensions", "probe", f);
const until = async (pred: () => boolean, what: string, ms = 30_000) => {
	for (const end = Date.now() + ms; !pred(); await sleep(100)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};
/** A long run: its tool has started (the model asked for it) when this returns. */
async function longRun(id: string, seconds = 30) {
	const from = port.end(P());
	const asked = t.model.requests.length;
	port.submit(P(), { id, text: `tool: sleep ${seconds}`, conversation: "telegram:4242", from: { message: 9 } });
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === id);
	await until(() => t.model.requests.slice(asked).some((r) => r.users.at(-1) === `tool: sleep ${seconds}`), "the model to call the tool");
	await sleep(500); // the tool runs
	return from;
}

/** An extension that, like a kit's helper sessions, stops work of its own on an interrupt and says so in one line; and
 * that, when its flag files exist, holds a run in before_agent_start (the message is handed, not placed yet), or holds
 * the end of a run in agent_settled (pi then keeps a message handed meanwhile for after it, and is idle until then),
 * each until the test writes `release` (no timer that a slow machine could outrun); or kills pi while it is told of
 * an interrupt. */
const PROBE = `import * as fs from "node:fs";
import * as path from "node:path";
const dir = path.join(process.env.PI_PERSONAL_STATE, "probe");
fs.mkdirSync(dir, { recursive: true });
const flag = (f) => fs.existsSync(path.join(dir, f)) && (fs.rmSync(path.join(dir, f)), true);
const hold = async (mark) => {
	fs.writeFileSync(path.join(dir, mark), "");
	for (const end = Date.now() + 30000; !flag("release") && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));
	fs.rmSync(path.join(dir, mark));
};
export default function (pi) {
	pi.events.on("pi-personal.interrupt", (e) => {
		if (flag("kill")) process.kill(process.pid, "SIGKILL");
		fs.appendFileSync(path.join(dir, "interrupts"), "x");
		e.say("probe: stopped 2 helper sessions\\nand a second line that stays on it");
	});
	pi.on("before_agent_start", async () => {
		if (flag("hold")) await hold("holding");
	});
	pi.on("agent_settled", async () => {
		if (flag("hold-end")) await hold("holding-end");
	});
}
`;

before(async () => {
	t = await setup("intr");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	fs.mkdirSync(path.join(folder(), ".pi", "extensions", "probe"), { recursive: true });
	fs.writeFileSync(path.join(folder(), ".pi", "extensions", "probe", "index.ts"), PROBE);
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.equal(lastStart(P()).safeMode, null, "the probe loads");
});
after(async () => t?.close());

test("interrupt during a long tool call: the run's message settles with the aborted error within seconds, the control message with its result, and the next message in the inbox is answered", async () => {
	const from = await longRun("i-long");
	port.submit(P(), { id: "i-next", text: "the next one", conversation: "telegram:1002" });
	const at = Date.now();
	const r = await t.cli("interrupt", "main", "--id", "i-stop");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^asked the run to stop\n/);
	const end = await settled("i-long", from, 10_000);
	assert.ok(Date.now() - at < 8_000, `stopped within seconds, not after the 30 s of its tool (${Date.now() - at} ms)`);
	assert.match(String(end.error), /the work was stopped before these messages were answered/, "the existing sentence for an aborted run");
	assert.deepEqual(end.refs, [{ id: "i-long", from: { message: 9 }, conversation: "telegram:4242" }]);
	const stop = await settled("i-stop", from);
	assert.equal(stop.error, undefined);
	assert.match(String(stop.result), /^asked the run to stop/);
	assert.ok(port.events(P(), from).events.some((e) => e.type === "taken" && e.id === "i-stop"), "taken, then settled, as every message");
	assert.ok(fs.existsSync(path.join(P(), "taken", "i-stop.json")));
	// The message that waited was untouched: it gets its turn, and its own answer.
	const next = await settled("i-next", from);
	assert.equal(next.error, undefined);
	assert.ok(port.events(P(), from).events.some((e) => e.type === "message" && has(e, "i-next") && e.text === "echo: the next one"));
	assert.ok(stop.cursor < next.cursor, "the control message never waited behind a run");
});

test("interrupt while idle: nothing was running, and nothing changes", async () => {
	await until(() => port.events(P()).events.filter((e) => e.type === "status").at(-1)?.state === "idle", "the agent to be idle");
	const from = port.end(P());
	const r = await t.cli("interrupt", "main", "--json");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(JSON.parse(r.stdout).result, /^nothing was running/);
	assert.deepEqual(
		port.events(P(), from).events.filter((e) => !["taken", "settled"].includes(e.type)).map((e) => e.type),
		[],
		"no run, no status change",
	);
	const after = await t.cli("send", "main", "still here", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: still here");
});

test("an extension listening to pi-personal.interrupt adds its line to the result", async () => {
	const before = fs.existsSync(probe("interrupts")) ? fs.readFileSync(probe("interrupts"), "utf8").length : 0;
	const r = await t.cli("interrupt", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.equal(r.stdout, "nothing was running\nprobe: stopped 2 helper sessions and a second line that stays on it\n", "one line each: its own line ends are spaces");
	assert.equal(fs.readFileSync(probe("interrupts"), "utf8").length, before + 1, "told once");
});

test("interrupt of a run that is starting (handed, not placed): the run stops and its message settles with the aborted error", async () => {
	fs.writeFileSync(probe("hold"), "");
	const from = port.end(P());
	const asked = t.model.requests.length;
	port.submit(P(), { id: "i-starting", text: "held while starting", conversation: "telegram:4242" });
	await until(() => fs.existsSync(probe("holding")), "the run to be held in before_agent_start");
	assert.equal(port.events(P(), from).events.some((e) => e.type === "taken" && e.id === "i-starting"), false, "not placed yet");
	const r = await t.cli("interrupt", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^asked the run to stop\n/, "a message handed counts as a run in progress");
	assert.ok(fs.existsSync(probe("holding")), "the interrupt came while the run was still starting");
	fs.writeFileSync(probe("release"), "");
	const end = await settled("i-starting", from);
	assert.match(String(end.error), /the work was stopped before these messages were answered/);
	assert.equal(t.model.requests.slice(asked).some((q) => q.users.at(-1) === "held while starting"), false, "the model was never asked");
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "settled" && has(e, "i-starting")).length, 1, "one settled");
	const after = await t.cli("send", "main", "after the held one", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: after the held one", "the next run is not stopped");
});

test("interrupt of a message handed while pi was still ending the previous run (pi idle, no run yet to abort): its run is stopped when it starts", async () => {
	const from = port.end(P());
	const asked = t.model.requests.length;
	fs.writeFileSync(probe("hold-end"), "");
	port.submit(P(), { id: "i-before", text: "the run before", conversation: "telegram:4242" });
	port.submit(P(), { id: "i-deferred", text: "handed while the last run ends", conversation: "telegram:4242" });
	await settled("i-before", from);
	await until(() => fs.existsSync(probe("holding-end")), "the end of the run to be held");
	await sleep(500); // the bridge hands the next message: pi keeps it for after the end of the run
	const r = await t.cli("interrupt", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^asked the run to stop\n/, "a message the bridge has just handed counts as a run in progress");
	assert.ok(fs.existsSync(probe("holding-end")), "the interrupt came while pi was still ending the previous run");
	fs.writeFileSync(probe("release"), "");
	const end = await settled("i-deferred", from);
	assert.match(String(end.error), /the work was stopped before these messages were answered/);
	assert.equal(t.model.requests.slice(asked).some((q) => q.users.at(-1) === "handed while the last run ends"), false, "the model was never asked");
	const after = await t.cli("send", "main", "after the deferred one", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: after the deferred one", "the next run is not stopped");
});

test("a control file older than 15 s does nothing: settled with an error, and the run goes on", async () => {
	const from = await longRun("i-goes-on", 3);
	const tmp = path.join(P(), "inbox", ".i-late.tmp");
	fs.writeFileSync(tmp, JSON.stringify({ id: "i-late", text: "", control: "interrupt" }));
	const old = new Date(Date.now() - 20_000);
	fs.utimesSync(tmp, old, old);
	fs.linkSync(tmp, path.join(P(), "inbox", "i-late.json"));
	fs.rmSync(tmp);
	const late = await settled("i-late", from);
	assert.equal(late.error, "came too late; nothing was done");
	assert.equal(late.result, undefined);
	const end = await settled("i-goes-on", from);
	assert.equal(end.error, undefined, "the run was not stopped");
	assert.ok(port.events(P(), from).events.some((e) => e.type === "message" && has(e, "i-goes-on") && String(e.text).startsWith("done:")));
});

test("the same id twice: done once; pp interrupt says it was already done", async () => {
	const from = port.end(P());
	const first = await t.cli("interrupt", "main", "--id", "i-twice");
	assert.equal(first.code, 0, first.stdout + first.stderr);
	const again = await t.cli("interrupt", "main", "--id", "i-twice");
	assert.equal(again.code, 0, again.stdout + again.stderr);
	assert.match(again.stdout, /i-twice was already done/);
	// Written by a channel of its own, without the check submit makes: dropped as a duplicate by the bridge.
	fs.writeFileSync(path.join(P(), "inbox", "i-twice.json"), JSON.stringify({ id: "i-twice", text: "", control: "interrupt" }));
	await t.waitEvent("main", from, (e) => e.type === "duplicate" && e.id === "i-twice");
	await sleep(1500);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "settled" && has(e, "i-twice")).length, 1);
});

test("an unknown control word is settled with an error; an invalid control message is set aside", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "i-unknown", text: "", control: "dance" });
	assert.match(String((await settled("i-unknown", from)).error), /unknown control "dance"/);
	fs.writeFileSync(path.join(P(), "inbox", "i-texted.json"), JSON.stringify({ id: "i-texted", text: "stop now", control: "interrupt" }));
	const r = await t.waitEvent("main", from, (e) => e.type === "rejected" && e.id === "i-texted");
	assert.match(String(r.reason), /text must be empty on a control message/);
});

test("pp interrupt refuses at once, writing nothing, when the agent is not running", async () => {
	assert.equal((await t.cli("init", "off", path.join(t.dir, "agents", "off"), "--model", "fake/echo-1")).code, 0);
	const r = await t.cli("interrupt", "off");
	assert.equal(r.code, 1);
	assert.match(r.stderr, /off is not running: nothing was sent/);
	assert.deepEqual(fs.readdirSync(path.join(t.portOf("off"), "inbox")), []);
});

test("pp interrupt that gets no result within 20 s withdraws its file: it never takes effect later", async () => {
	const pid = Number(lastStart(P()).pid);
	const from = port.end(P());
	process.kill(pid, "SIGSTOP"); // pi hangs: its runner and terminal are there, nobody reads the inbox
	let r;
	try {
		r = await t.cli("interrupt", "main", "--id", "i-unread");
	} finally {
		process.kill(pid, "SIGCONT");
	}
	assert.equal(r.code, 1);
	assert.match(r.stderr, /no result within 20 s; nothing was done/);
	assert.equal(fs.existsSync(path.join(P(), "inbox", "i-unread.json")), false, "withdrawn");
	const after = await t.cli("send", "main", "awake again", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: awake again");
	assert.equal(port.events(P(), from).events.some((e) => JSON.stringify(e).includes("i-unread")), false, "never taken, never settled");
});

test("pp interrupt with the id of a control message still waiting does not say it was already done", async () => {
	const pid = Number(lastStart(P()).pid);
	const from = port.end(P());
	process.kill(pid, "SIGSTOP");
	let r;
	try {
		port.submit(P(), { id: "i-waits", text: "", control: "interrupt" }); // a first try cut off while it waited
		r = await t.cli("interrupt", "main", "--id", "i-waits");
	} finally {
		process.kill(pid, "SIGCONT");
	}
	assert.equal(r.code, 1, r.stdout + r.stderr);
	assert.doesNotMatch(r.stdout + r.stderr, /already done/);
	assert.match(r.stderr, /no result within 20 s; nothing was done/);
	assert.equal(fs.existsSync(path.join(P(), "inbox", "i-waits.json")), false, "withdrawn");
	const after = await t.cli("send", "main", "awake once more", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: awake once more");
	assert.equal(port.events(P(), from).events.some((e) => JSON.stringify(e).includes("i-waits")), false);
});

test("pp interrupt stopped by Ctrl+C while it waits withdraws its file: the interrupt never happens after it", async () => {
	const pid = Number(lastStart(P()).pid);
	const from = port.end(P());
	process.kill(pid, "SIGSTOP");
	let code: number | null;
	let stderr = "";
	try {
		const child = spawn(process.execPath, [CLI, "interrupt", "main", "--id", "i-ctrlc"], { env: t.env, stdio: ["ignore", "pipe", "pipe"] });
		child.stderr.on("data", (d) => (stderr += d));
		const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
		await until(() => fs.existsSync(path.join(P(), "inbox", "i-ctrlc.json")), "the control message to be submitted");
		await sleep(300);
		child.kill("SIGINT");
		code = await exited;
	} finally {
		process.kill(pid, "SIGCONT");
	}
	assert.equal(code, 130, stderr);
	assert.match(stderr, /stopped before a result; nothing was done/);
	assert.equal(fs.existsSync(path.join(P(), "inbox", "i-ctrlc.json")), false, "withdrawn");
	const after = await t.cli("send", "main", "awake after ctrl-c", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: awake after ctrl-c");
	assert.equal(port.events(P(), from).events.some((e) => JSON.stringify(e).includes("i-ctrlc")), false, "never taken, never settled");
});

test("a control file that cannot be moved to taken/ does not hold up the inbox, and is settled once", { skip: process.getuid?.() === 0 && "root writes into a read-only folder" }, async () => {
	const from = port.end(P());
	const taken = path.join(P(), "taken");
	fs.chmodSync(taken, 0o500);
	try {
		port.submit(P(), { id: "i-ro", text: "", control: "interrupt" });
		port.submit(P(), { id: "i-ro-next", text: "behind a stuck control file", conversation: "telegram:1003" });
		await t.waitEvent("main", from, (e) => e.type === "message" && has(e, "i-ro-next") && e.text === "echo: behind a stuck control file", 30_000);
		assert.match(String((await settled("i-ro", from)).result), /^nothing was running|^asked the run to stop/);
	} finally {
		fs.chmodSync(taken, 0o700);
	}
	await until(() => fs.existsSync(path.join(taken, "i-ro.json")) && !fs.existsSync(path.join(P(), "inbox", "i-ro.json")), "the control file to be moved once it can be");
	await settled("i-ro-next", from);
	await sleep(1500);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "settled" && has(e, "i-ro")).length, 1, "done once");
});

test("a control message whose doing kills pi is settled once after the restart, never lost", async () => {
	const from = port.end(P());
	fs.writeFileSync(probe("kill"), "");
	port.submit(P(), { id: "i-killed", text: "", control: "interrupt" });
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel, 60_000);
	await settled("i-killed", from, 40_000);
	await sleep(1500);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "settled" && has(e, "i-killed")).length, 1);
	const after = await t.cli("send", "main", "back after the kill", "--wait", "--timeout", "30");
	assert.equal(after.stdout.trim(), "echo: back after the kill");
});

test("a control message never appears in the session nor in a request to the model", () => {
	const ids = ["i-stop", "i-twice", "i-late", "i-unknown", "i-unread", "i-waits", "i-ctrlc", "i-ro", "i-killed"];
	const dir = path.join(t.home, "agents", "main", "sessions");
	const sessions = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
	assert.ok(sessions.join("").includes("i-long"), "the session holds the port messages");
	for (const id of ids) assert.equal(sessions.some((s) => s.includes(`"${id}"`)), false, `${id} is not in the session`);
	assert.equal(t.model.requests.some((q) => q.users.some((u) => u === "" || /interrupt/.test(u))), false, "no request carried one");
});
