// Conversations and the inbox: a reply never mixes two conversations; a file written in two steps; junk in the inbox;
// a message pi never started a run with is tried again without blocking the others.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, setup, sleep } from "./helpers.ts";

let t: Env;
const P = () => t.portOf("main");
const inbox = (f: string) => path.join(P(), "inbox", f);
const ids = (e: port.Seen) => ((e.refs as { id: string }[] | undefined) ?? []).map((r) => r.id);
const evs = (from: number) => port.events(P(), from).events;
const settledOf = (from: number, id: string, ms = 60_000) => t.waitEvent("main", from, (e) => e.type === "settled" && ids(e).includes(id), ms);
const old = (file: string) => fs.utimesSync(file, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));

before(async () => {
	t = await setup("conv");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	await t.cli("start", "main");
	assert.equal((await t.cli("send", "main", "first words", "--wait", "--timeout", "30")).code, 0);
});
after(async () => t.close());

test("a message of another conversation waits for the run to end; no reply goes to both", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "c-a1", text: "tool: sleep 4; echo alpha", conversation: "A", from: { channel: "x", conversation: "A" } });
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "c-a1", 30_000);
	// A's run is working (its tool sleeps): B arrives, and so does a second message of A.
	port.submit(P(), { id: "c-b1", text: "hello from B", conversation: "B", from: { channel: "x", conversation: "B" } });
	port.submit(P(), { id: "c-a2", text: "more from A", conversation: "A", from: { channel: "x", conversation: "A" } });
	await settledOf(from, "c-b1");
	await settledOf(from, "c-a1");
	const all = evs(from);
	const replies = all.filter((e) => e.type === "message");
	for (const r of replies) {
		const convs = new Set(((r.refs as { conversation?: string }[]) ?? []).map((x) => x.conversation));
		assert.ok(convs.size <= 1, `a reply carries refs of two conversations: ${JSON.stringify(r.refs)}`);
	}
	const forB = replies.filter((e) => ids(e).includes("c-b1"));
	assert.equal(forB.length, 1);
	assert.deepEqual(ids(forB[0]), ["c-b1"]);
	assert.equal(forB[0].text, "echo: hello from B");
	// No run mixes the two: every settled marker carries one conversation only, and B was taken after A's run settled.
	for (const s of all.filter((e) => e.type === "settled")) {
		assert.ok(new Set((s.refs as { conversation?: string }[]).map((x) => x.conversation)).size <= 1, `settled mixes conversations: ${JSON.stringify(s.refs)}`);
	}
	const settledA = all.find((e) => e.type === "settled" && ids(e).includes("c-a1"))!;
	const takenB = all.find((e) => e.type === "taken" && e.id === "c-b1")!;
	assert.ok(takenB.cursor > settledA.cursor, "B was taken in before A's run ended");
	// The second message of A came after B's: B, which waited longer, goes first; then A2 in a run of its own.
	await settledOf(from, "c-a2");
	const later = evs(from);
	const takenA2 = later.find((e) => e.type === "taken" && e.id === "c-a2")!;
	assert.ok(takenA2.cursor > takenB.cursor, "A2 overtook B, which had waited longer");
	assert.ok(later.some((e) => e.type === "message" && ids(e).includes("c-a2")), "c-a2 was never answered");
	assert.ok(!later.some((e) => e.type === "message" && ids(e).includes("c-a2") && ids(e).includes("c-b1")));
});

test("a message without a conversation does not join a run of a named one", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "n-a1", text: "tool: sleep 3; echo gamma", conversation: "G" });
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "n-a1", 30_000);
	port.submit(P(), { id: "n-none", text: "no conversation" });
	await settledOf(from, "n-none");
	const all = evs(from);
	const reply = all.find((e) => e.type === "message" && ids(e).includes("n-none"))!;
	assert.deepEqual(ids(reply), ["n-none"]);
	const sA = all.find((e) => e.type === "settled" && ids(e).includes("n-a1"))!;
	assert.ok(!ids(sA).includes("n-none"));
});

test("a slow writer that is not atomic is not rejected, loses nothing, and is answered once with its whole text", async () => {
	const from = port.end(P());
	const file = inbox("slow-1.json");
	const fd = fs.openSync(file, "w");
	fs.writeSync(fd, '{"id":"slow-1","text":"written by a slow, ');
	await sleep(2500); // longer than a tick, shorter than the 5 s the bridge waits
	assert.ok(!evs(from).some((e) => e.type === "rejected"), "a half-written file was rejected");
	assert.ok(fs.existsSync(file), "the half-written file was moved away");
	fs.writeSync(fd, 'non-atomic writer"}');
	fs.closeSync(fd);
	await settledOf(from, "slow-1", 30_000);
	const reply = evs(from).find((e) => e.type === "message" && ids(e).includes("slow-1"))!;
	assert.equal(reply.text, "echo: written by a slow, non-atomic writer");
	assert.equal(evs(from).filter((e) => e.type === "taken" && e.id === "slow-1").length, 1);
	assert.ok(!fs.existsSync(path.join(P(), "rejected", "slow-1.json")));
});

test("a file abandoned half written is set aside after 5 s, and its id is not burnt", async () => {
	const from = port.end(P());
	const file = inbox("abandoned-1.json");
	fs.writeFileSync(file, '{"id":"abandoned-1","text":"cut of');
	old(file);
	const rej = await t.waitEvent("main", from, (e) => e.type === "rejected" && e.id === "abandoned-1", 30_000);
	assert.match(String(rej.reason), /JSON/);
	assert.ok(fs.existsSync(path.join(P(), "rejected", "abandoned-1.json")));
	assert.ok(!fs.existsSync(file));
	assert.equal(port.submit(P(), { id: "abandoned-1", text: "the whole message" }), "accepted"); // the id stays free
	await settledOf(from, "abandoned-1", 30_000);
	assert.equal(evs(from).find((e) => e.type === "message" && ids(e).includes("abandoned-1"))!.text, "echo: the whole message");
});

test("a message that cannot be read does not block the messages after it; it is set aside after 60 s", async () => {
	const from = port.end(P());
	const file = inbox("locked-1.json");
	fs.writeFileSync(file, JSON.stringify({ id: "locked-1", text: "cannot read me" }));
	fs.chmodSync(file, 0o000);
	port.submit(P(), { id: "after-locked", text: "I come after" });
	await settledOf(from, "after-locked", 30_000); // not held back by the unreadable file
	assert.ok(fs.existsSync(file), "still waiting while young");
	old(file); // as if it had been unreadable for two minutes
	const rej = await t.waitEvent("main", from, (e) => e.type === "rejected" && e.id === "locked-1", 30_000);
	assert.match(String(rej.reason), /unreadable/);
	assert.ok(fs.existsSync(path.join(P(), "rejected", "locked-1.json")));
	assert.equal(port.pending(P()).length, 0);
	// Its id is free again, and the inbox still works.
	assert.equal(port.submit(P(), { id: "locked-1", text: "readable now" }), "accepted");
	await settledOf(from, "locked-1", 30_000);
});

test("a message that is invalid (wrong id for its file) is set aside at once and later ones still pass", async () => {
	const from = port.end(P());
	fs.writeFileSync(inbox("liar.json"), JSON.stringify({ id: "someone-else", text: "x" }));
	old(inbox("liar.json"));
	port.submit(P(), { id: "after-liar", text: "next in line" });
	await t.waitEvent("main", from, (e) => e.type === "rejected" && e.id === "liar", 30_000);
	await settledOf(from, "after-liar", 30_000);
});

test("junk in the inbox is not pending, not counted by status, and does not stop real messages", async () => {
	const from = port.end(P());
	fs.mkdirSync(inbox("adir.json"));
	fs.symlinkSync("/nonexistent/target", inbox("dangling.json"));
	fs.writeFileSync(inbox("notes.txt"), "not a message");
	fs.writeFileSync(inbox(".hidden.json"), "{}");
	fs.writeFileSync(inbox("half.tmp"), "x");
	assert.deepEqual(port.pending(P()), []);
	const status = await t.cli("status", "main");
	assert.ok(!/waiting in the port/.test(status.stdout), `status counts junk as pending:\n${status.stdout}`);
	port.submit(P(), { id: "after-junk", text: "past the junk" });
	await settledOf(from, "after-junk", 30_000);
	assert.ok(!evs(from).some((e) => e.type === "rejected"), "junk was rejected as if it were a message");
	assert.ok(!evs(from).some((e) => e.type === "error"), `errors: ${JSON.stringify(evs(from).filter((e) => e.type === "error"))}`);
	assert.deepEqual(port.pending(P()).map((p) => p.id), []);
	assert.ok(fs.statSync(inbox("adir.json")).isDirectory());
});
