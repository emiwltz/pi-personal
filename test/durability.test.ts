// Durability: an events file that cannot be written kills neither pi nor the keeper, and nothing is lost; readers
// survive an events file replaced by hand.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, setup, sleep } from "./helpers.ts";


let t: Env;
const P = () => t.portOf("main");
const ids = (e: port.Seen) => ((e.refs as { id: string }[] | undefined) ?? []).map((r) => r.id);
const all = () => port.events(P(), 0).events;
const piPid = () => Number(all().filter((e) => e.type === "started" && !e.channel).at(-1)?.pid);
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
async function until(f: () => boolean, ms: number, what: string) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (f()) return;
		await sleep(200);
	}
	throw new Error(`timed out: ${what}`);
}

before(async () => {
	t = await setup("dura");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	await t.cli("start", "main");
	assert.equal((await t.cli("send", "main", "first words", "--wait", "--timeout", "30")).code, 0);
});
after(async () => {
	try {
		fs.chmodSync(port.eventsFile(P()), 0o600);
	} catch {}
	await t.close();
});

test("an events file that cannot be written does not kill pi; the events come once it can", async (ctx) => {
	if (process.getuid?.() === 0) return ctx.skip("root can write anywhere");
	const pid = piPid();
	assert.ok(pid > 1 && alive(pid));
	const startsBefore = all().filter((e) => e.type === "started" || e.type === "restarted").length;
	const file = port.eventsFile(P());
	fs.chmodSync(file, 0o444); // like a full disk or a read-only file: appending fails with EACCES
	try {
		port.submit(P(), { id: "ro-1", text: "while the log is read-only" });
		await until(() => port.isTaken(P(), "ro-1"), 40_000, "ro-1 moved to taken/ although events cannot be written");
		await until(() => t.model.requests.some((r) => r.users.at(-1)?.includes("while the log is read-only")), 40_000, "the model was asked");
		await sleep(1500);
		assert.ok(alive(pid), "pi died when the events file could not be written");
		assert.ok(!all().some((e) => e.id === "ro-1" || ids(e).includes("ro-1")), "the events file was written despite 0444 (is the test running as root?)");
	} finally {
		fs.chmodSync(file, 0o600);
	}
	// Writable again: what waited is written, in order, and nothing was restarted.
	await until(() => all().some((e) => e.type === "settled" && ids(e).includes("ro-1")), 30_000, "backlog flushed");
	const evs = all();
	const order = ["taken", "message", "settled"].map((ty) => evs.findIndex((e) => e.type === ty && (e.id === "ro-1" || ids(e).includes("ro-1"))));
	assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `backlog out of order: ${order}`);
	assert.equal(evs.find((e) => e.type === "message" && ids(e).includes("ro-1"))!.text, "echo: while the log is read-only");
	assert.equal(evs.filter((e) => e.type === "started" || e.type === "restarted").length, startsBefore, "the agent was restarted");
	assert.equal(piPid(), pid);
	// And it keeps working normally.
	const r = await t.cli("send", "main", "after the file is back", "--wait", "--timeout", "30");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /echo: after the file is back/);
});

test("the keeper survives too: it keeps pi running while its own events cannot be written", async () => {
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.ok(s.running, "agent not running before the test");
	const pid = piPid();
	const file = port.eventsFile(P());
	fs.chmodSync(file, 0o444);
	try {
		// A crash of pi makes the keeper write "restarted"/"started": it must restart pi even though it cannot log it.
		process.kill(pid, "SIGKILL"); // pid from the bridge's own started event
		await until(() => !alive(pid), 10_000, "pi gone");
		await sleep(15_000);
		const st = JSON.parse((await t.cli("status", "main", "--json")).stdout);
		assert.ok(st.running, `the keeper died with an unwritable events file: ${JSON.stringify(st)}`);
	} finally {
		fs.chmodSync(file, 0o600);
	}
	await until(() => all().some((e) => e.type === "started" && !e.channel && Number(e.pid) !== pid), 60_000, "new pi announced after the file is writable");
	const r = await t.cli("send", "main", "after a crash with a read-only log", "--wait", "--timeout", "40");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /echo: after a crash with a read-only log/);
});

test("a line cut off by a full disk does not swallow the next event", async () => {
	const file = port.eventsFile(P());
	fs.appendFileSync(file, '{"type":"message","text":"cut of'); // no newline: a write interrupted halfway
	const r = await t.cli("send", "main", "after a torn line", "--wait", "--timeout", "40");
	assert.equal(r.code, 0, r.stderr);
	const evs = all();
	assert.ok(evs.some((e) => e.type === "message" && e.text === "echo: after a torn line"), "the reply was lost in the torn line");
	assert.ok(evs.some((e) => e.type === "settled"));
});

test("a cursor past the end of the events file (replaced by hand) reads the new file from its start, without hanging", async () => {
	const stale = fs.statSync(port.eventsFile(P())).size + 100_000; // a byte offset from a log that was much longer
	port.submit(P(), { id: "pr-4", text: "numeric cursor after the archive" });
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 30_000);
	let got = false;
	await port.follow(P(), stale, (e) => (got = e.type === "message" && e.text === "echo: numeric cursor after the archive"), ac.signal);
	clearTimeout(timer);
	assert.ok(got, "a cursor past the end of the new file never saw the new events");
});

