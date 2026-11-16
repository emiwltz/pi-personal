// Messages: two agents stay isolated; messages sent while the agent works wait their turn and get their own reply;
// the same id twice is handled once; one conversation per run; an error reaches the sender.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, setup } from "./helpers.ts";

let t: Env;
before(async () => {
	t = await setup("a02");
	for (const a of ["ann", "bob"]) {
		assert.equal((await t.cli("init", a, path.join(t.dir, "agents", a), "--model", "fake/echo-1")).code, 0);
		assert.equal((await t.cli("start", a)).code, 0);
	}
});
after(async () => t.close());

const events = (a: string) => port.events(t.portOf(a)).events;
const count = (a: string, pred: (e: port.Seen) => boolean) => events(a).filter(pred).length;

test("a message to one agent never reaches the other", async () => {
	const r = await t.cli("send", "ann", "only for ann", "--wait", "--timeout", "30");
	assert.equal(r.stdout.trim(), "echo: only for ann");
	assert.equal(count("bob", (e) => JSON.stringify(e).includes("only for ann")), 0);
	const bobSessions = path.join(t.home, "agents", "bob", "sessions");
	const all = fs.existsSync(bobSessions) ? fs.readdirSync(bobSessions, { recursive: true }).join(" ") : "";
	for (const f of all.split(" ").filter((x) => x.endsWith(".jsonl")))
		assert.ok(!fs.readFileSync(path.join(bobSessions, f), "utf8").includes("only for ann"));
	assert.notEqual(t.portOf("ann"), t.portOf("bob"));
	const b = await t.cli("send", "bob", "only for bob", "--wait", "--timeout", "30");
	assert.equal(b.stdout.trim(), "echo: only for bob");
	assert.equal(count("ann", (e) => JSON.stringify(e).includes("only for bob")), 0);
});

test("messages sent while the agent works wait their turn; each gets its own run and its own reply, once", async () => {
	const from = port.end(t.portOf("ann"));
	await t.cli("send", "ann", "tool: sleep 2; echo slow", "--id", "w1");
	await t.waitEvent("ann", from, (e) => e.type === "taken" && e.id === "w1");
	await t.cli("send", "ann", "second while working", "--id", "s1");
	await t.cli("send", "ann", "third while working", "--id", "f1");
	await t.waitEvent("ann", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("f1"), 30_000);
	const seq = port.events(t.portOf("ann"), from).events.filter((e) => ["taken", "message", "settled"].includes(e.type));
	const label = seq.map((e) => (e.type === "taken" ? `taken ${e.id}` : e.type === "settled" ? `settled ${(e.refs as port.Ref[]).map((r) => r.id).join("+")}` : `says ${e.text}`));
	// One run per message, in order: each is taken only after the previous one settled, and gets its own reply.
	assert.deepEqual(
		label.filter((l) => !l.startsWith("says")),
		["taken w1", "settled w1", "taken s1", "settled s1", "taken f1", "settled f1"],
	);
	for (const [id, text] of [["w1", "done: slow"], ["s1", "echo: second while working"], ["f1", "echo: third while working"]]) {
		const replies = seq.filter((e) => e.type === "message" && (e.refs as port.Ref[]).map((r) => r.id).join() === id);
		assert.equal(replies.length, 1, `${id}: ${label.join(" | ")}`);
		assert.equal(replies[0].text, text);
		assert.deepEqual(replies[0].refs, [{ id, conversation: "cli" }]);
	}
});

test("the same identifier twice is processed once", async () => {
	const before = t.model.requests.length;
	const r1 = await t.cli("send", "ann", "only once", "--id", "dup-1", "--wait", "--timeout", "30");
	assert.equal(r1.stdout.trim(), "echo: only once");
	const r2 = await t.cli("send", "ann", "only once", "--id", "dup-1", "--json");
	assert.equal(JSON.parse(r2.stdout).result, "duplicate");
	// A client that skips the check and drops the file anyway: the bridge drops it.
	const from = port.end(t.portOf("ann"));
	fs.writeFileSync(path.join(t.portOf("ann"), "inbox", "dup-1.json"), JSON.stringify({ id: "dup-1", text: "only once" }));
	await t.waitEvent("ann", from, (e) => e.type === "duplicate" && e.id === "dup-1");
	assert.equal(t.model.requests.length, before + 1);
	assert.equal(count("ann", (e) => e.type === "taken" && e.id === "dup-1"), 1);
	// A malformed file is set aside, not fatal.
	fs.writeFileSync(path.join(t.portOf("ann"), "inbox", "bad.json"), "{not json");
	await t.waitEvent("ann", from, (e) => e.type === "rejected" && e.id === "bad");
	assert.equal((await t.cli("send", "ann", "still fine", "--wait", "--timeout", "30")).stdout.trim(), "echo: still fine");
});

test("one run serves one conversation: a message of another conversation waits for the run to end, goes before a later message of the first, and no reply mixes the two", async () => {
	const from = port.end(t.portOf("ann"));
	await t.cli("send", "ann", "tool: sleep 2; echo alice work", "--id", "alice-1", "--conversation", "mail:alice");
	await t.waitEvent("ann", from, (e) => e.type === "taken" && e.id === "alice-1");
	await t.cli("send", "ann", "hello from bob", "--id", "bob-1", "--conversation", "mail:bob");
	await t.cli("send", "ann", "and alice again", "--id", "alice-2", "--conversation", "mail:alice");
	await t.waitEvent("ann", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("alice-2"), 30_000);
	const seq = port.events(t.portOf("ann"), from).events;
	const label = seq.filter((e) => e.type === "taken" || e.type === "settled").map((e) => (e.type === "taken" ? `taken ${e.id}` : `settled ${(e.refs as port.Ref[]).map((r) => r.id).join("+")}`));
	// Bob's message waits for Alice's run to end; Alice's second message, written after Bob's, waits its turn after him.
	assert.deepEqual(label, ["taken alice-1", "settled alice-1", "taken bob-1", "settled bob-1", "taken alice-2", "settled alice-2"]);
	for (const e of seq.filter((x) => x.type === "message" || x.type === "settled")) {
		const convs = new Set((e.refs as port.Ref[]).map((r) => r.conversation));
		assert.ok(convs.size <= 1, `one conversation per reply: ${JSON.stringify(e.refs)}`);
	}
	const bobReply = seq.find((e) => e.type === "message" && e.text === "echo: hello from bob")!;
	assert.deepEqual((bobReply.refs as port.Ref[]).map((r) => r.id), ["bob-1"]);
});

test("an error reaches the sender: send --wait prints it and exits 1; status shows it until something works", async () => {
	const r = await t.cli("send", "ann", "fail: the key was revoked", "--wait", "--timeout", "30");
	assert.equal(r.code, 1);
	assert.match(r.stderr, /fake refusal: the key was revoked/);
	assert.match((await t.cli("status", "ann")).stdout, /last error .*fake refusal/);
	assert.equal((await t.cli("send", "ann", "better now", "--wait", "--timeout", "30")).stdout.trim(), "echo: better now");
	assert.doesNotMatch((await t.cli("status", "ann")).stdout, /last error/);
});
