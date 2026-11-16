// The port's file protocol (docs/port.md), on its own: no Herdr Core, no pi.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as port from "../core/port.ts";

const made: string[] = [];
const tmp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personal-port-"));
	made.push(d);
	return d;
};
after(() => {
	for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const types = (p: string, from?: number) => port.events(p, from).events.map((e) => e.type);
const old = (file: string) => fs.utimesSync(file, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));

test("submit is atomic, exclusive and private", () => {
	const p = path.join(tmp(), "port");
	assert.equal(port.submit(p, { id: "a1", text: "hello" }), "accepted");
	assert.equal(port.submit(p, { id: "a1", text: "hello again" }), "duplicate");
	assert.equal((fs.statSync(p).mode & 0o777).toString(8), "700");
	assert.deepEqual(fs.readdirSync(path.join(p, "inbox")), ["a1.json"]); // no temporary file left
	assert.equal(fs.readFileSync(path.join(p, "version"), "utf8").trim(), "1");
	port.take(p, "a1");
	assert.equal(port.submit(p, { id: "a1", text: "after taken" }), "duplicate");
	assert.equal(port.isTaken(p, "a1"), true);
});

test("invalid messages are refused before they reach the inbox", () => {
	const p = path.join(tmp(), "port");
	assert.throws(() => port.submit(p, { id: "../x", text: "x" }));
	assert.throws(() => port.submit(p, { id: "x", text: "" }));
	assert.throws(() => port.submit(p, { id: "x", text: "a", attachments: ["relative.png"] }));
	assert.throws(() => port.submit(p, { id: "x", text: "a", conversation: 3 as never }));
	assert.throws(() => port.submit(p, { id: "x", text: "a", conversation: "c".repeat(201) }));
	assert.equal(port.submit(p, { id: "x", text: "a", conversation: "telegram:42" }), "accepted");
});

test("pending keeps the order of writing; a broken file waits while young, then is set aside, and its id stays free", async () => {
	const p = path.join(tmp(), "port");
	for (const id of ["z", "b", "m"]) {
		port.submit(p, { id, text: id });
		await new Promise((r) => setTimeout(r, 5));
	}
	const broken = path.join(p, "inbox", "broken.json");
	fs.writeFileSync(broken, "{nope");
	fs.writeFileSync(path.join(p, "inbox", ".ignored.tmp"), "x");
	fs.mkdirSync(path.join(p, "inbox", "adir.json")); // not a regular file: never pending
	const list = port.pending(p);
	assert.deepEqual(list.map((x) => x.id), ["z", "b", "m", "broken"]);
	assert.deepEqual(port.read(list[0]), { msg: { id: "z", text: "z" } });
	assert.deepEqual(port.read(list[3]), { reason: "incomplete", later: true }); // it may still be being written
	old(broken);
	assert.deepEqual(port.read(list[3]), { reason: "not valid JSON" });
	port.reject(p, "broken");
	assert.ok(fs.existsSync(path.join(p, "rejected", "broken.json")));
	assert.equal(port.submit(p, { id: "broken", text: "fixed" }), "accepted");
	fs.writeFileSync(path.join(p, "inbox", "other.json"), JSON.stringify({ id: "different", text: "x" }));
	assert.deepEqual(port.read({ id: "other", file: path.join(p, "inbox", "other.json") }), { reason: "id does not match the file name" });
	assert.deepEqual(port.read({ id: "gone", file: path.join(p, "inbox", "gone.json") }), { reason: "gone", later: true });
});

test("the events file only grows; cursors are stable and replay from where a reader stopped", async () => {
	const p = path.join(tmp(), "port");
	port.ensurePort(p);
	assert.equal(port.end(p), 0, "a new port has an empty events file");
	port.append(p, { type: "taken", id: "a" });
	port.append(p, { type: "message", text: "é ünïcode ✓", refs: [] });
	const first = port.events(p);
	assert.deepEqual(first.events.map((e) => e.type), ["taken", "message"]);
	assert.equal(first.events[0].cursor, 0);
	assert.equal(first.events[1].cursor, first.events[0].after);
	port.append(p, { type: "settled", refs: [] });
	fs.appendFileSync(port.eventsFile(p), '{"type":"half'); // an incomplete line is not read yet
	const again = port.events(p, first.next);
	assert.deepEqual(again.events.map((e) => e.type), ["settled"]);
	fs.appendFileSync(port.eventsFile(p), '"}\n');
	assert.deepEqual(types(p, again.next), ["half"]);
	const seen: string[] = [];
	const stop = await port.follow(p, first.next, (e) => {
		seen.push(e.type);
		return e.type === "half";
	});
	assert.deepEqual(seen, ["settled", "half"]);
	assert.equal(stop, port.end(p));
});

test("follow wakes up on new events", async () => {
	const p = path.join(tmp(), "port");
	port.ensurePort(p);
	setTimeout(() => port.append(p, { type: "message", text: "late" }), 100);
	const t0 = Date.now();
	let got = "";
	await port.follow(p, port.end(p), (e) => {
		got = String(e.text);
		return true;
	});
	assert.equal(got, "late");
	assert.ok(Date.now() - t0 < 2000);
});

test("an events file replaced by hand (the agent and its channels stopped) is read from its start", () => {
	const p = path.join(tmp(), "port");
	port.ensurePort(p);
	for (let i = 0; i < 20; i++) port.append(p, { type: "old", n: i });
	const at = port.end(p);
	fs.renameSync(port.eventsFile(p), `${port.eventsFile(p)}.2026-11`); // what the owner does to keep it small
	port.append(p, { type: "new" });
	assert.deepEqual(port.events(p, at).events.map((e) => e.type), ["new"]);
});

test("ties in modification time are ordered by id, numbers as numbers", () => {
	const p = path.join(tmp(), "port");
	for (const id of ["m-10", "m-9", "m-2"]) port.submit(p, { id, text: id });
	const t = new Date(1_700_000_000_000);
	for (const id of ["m-10", "m-9", "m-2"]) fs.utimesSync(path.join(p, "inbox", `${id}.json`), t, t);
	assert.deepEqual(port.pending(p).map((x) => x.id), ["m-2", "m-9", "m-10"]);
});

test("a torn last line cannot swallow the next event", () => {
	const p = path.join(tmp(), "port");
	port.ensurePort(p);
	port.append(p, { type: "a" });
	fs.appendFileSync(port.eventsFile(p), '{"type":"torn');
	port.append(p, { type: "b" });
	assert.deepEqual(types(p), ["a", "b"]);
});

test("the emitter never throws: what cannot be written waits, in order, and is written when it works again", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root can write anywhere");
	const p = path.join(tmp(), "port");
	port.ensurePort(p);
	const troubles: string[] = [];
	const emit = port.emitter(p, (m) => troubles.push(m));
	fs.chmodSync(port.eventsFile(p), 0o400);
	emit({ type: "first" });
	emit({ type: "second" });
	assert.deepEqual(types(p), []);
	assert.equal(troubles.length, 1);
	fs.chmodSync(port.eventsFile(p), 0o600);
	await new Promise((r) => setTimeout(r, 2500));
	assert.deepEqual(types(p), ["first", "second"]);
	assert.match(troubles.at(-1) ?? "", /again/);
	// An events file that was removed is created again by the next event.
	fs.rmSync(port.eventsFile(p));
	emit({ type: "third" });
	assert.deepEqual(port.events(p).events.map((e) => e.type), ["third"]);
});

test("ids never start with a dot (the inbox ignores such files), and from stays small", () => {
	const p = path.join(tmp(), "port");
	for (const id of [".x", ".", ".."]) assert.throws(() => port.submit(p, { id, text: "a" }), /not starting with a dot/);
	assert.throws(() => port.submit(p, { id: "big", text: "a", from: { pad: "x".repeat(5000) } }), /at most 4096 bytes/);
	assert.equal(port.submit(p, { id: "a.b", text: "a", from: { channel: "t" } }), "accepted");
});

test("a half-written file dated in the future (a clock set back) is judged at once, never kept waiting", () => {
	const p = path.join(tmp(), "port");
	port.ensurePort(p);
	const f = path.join(p, "inbox", "future.json");
	fs.writeFileSync(f, '{"id":"future","te');
	const later = new Date(Date.now() + 3_600_000);
	fs.utimesSync(f, later, later);
	const r = port.read(port.pending(p)[0]);
	assert.ok("reason" in r && !r.later, JSON.stringify(r));
});
