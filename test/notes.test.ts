// Telling without waking the model: a port message with `wake: false` starts no run. Its text is said to its
// conversation as soon as the bridge sees it, whatever pi is doing, and what the agent's conversation keeps of it (its
// text, or its `note`) is stored when pi is idle, never as a run's message nor an answer; never before pi wrote the
// session file; said again rather than lost after a crash, stored once.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as port from "../core/port.ts";
import { type Env, lastStart, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = (agent = "main") => path.join(t.dir, "agents", agent);
const P = (agent = "main") => t.portOf(agent);
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);
const settled = (id: string, from = 0, ms = 60_000, agent = "main") => t.waitEvent(agent, from, (e) => e.type === "settled" && has(e, id), ms);
const until = async (pred: () => boolean, what: string, ms = 30_000) => {
	for (const end = Date.now() + ms; !pred(); await sleep(100)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};
/** Every entry of the agent's sessions, as pi wrote them on disk. */
const entries = (agent = "main") => {
	const dir = path.join(t.home, "agents", agent, "sessions");
	if (!fs.existsSync(dir)) return [];
	return (fs.readdirSync(dir, { recursive: true }) as string[])
		.filter((f) => f.endsWith(".jsonl"))
		.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
};
const noteEntries = (id: string, agent = "main") => entries(agent).filter((e) => e.type === "custom_message" && e.customType === "pi-personal.note" && e.details?.id === id);
const textOf = (e: { content: unknown }) => (typeof e.content === "string" ? e.content : (e.content as { text?: string }[]).map((c) => c.text ?? "").join(""));
const of = (id: string, from = 0, agent = "main") => port.events(P(agent), from).events.filter((e) => has(e, id) || e.id === id);

/** A long run: its tool has started (the model asked for it) when this returns. */
async function longRun(id: string, seconds: number) {
	const from = port.end(P());
	const asked = t.model.requests.length;
	port.submit(P(), { id, text: `tool: sleep ${seconds}`, conversation: "telegram:1001" });
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === id);
	await until(() => t.model.requests.slice(asked).some((r) => r.users.at(-1) === `tool: sleep ${seconds}`), "the model to call the tool");
	return from;
}

before(async () => {
	t = await setup("notes");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
	// pi writes the session file at the first reply: from then on, notes are stored.
	assert.equal((await t.cli("send", "main", "hello", "--wait", "--timeout", "60")).code, 0);
});
after(async () => t?.close());

test("a note with a conversation while pi is in a long run: the message event comes at once, the entry after the run, and no request reaches the fake model for it", async () => {
	const from = await longRun("n-run", 8);
	const asked = t.model.requests.length;
	const at = Date.now();
	port.submit(P(), { id: "n-1", text: "Reminder: call Bob at five. (Three pages of details follow.)", note: "I reminded them to call Bob at five (reminders.md).", conversation: "telegram:4242", from: { message: 3 }, wake: false });
	const said = await t.waitEvent("main", from, (e) => e.type === "message" && has(e, "n-1"), 5_000);
	assert.ok(Date.now() - at < 3_000, `said at once, not after the run (${Date.now() - at} ms)`);
	assert.equal(said.text, "Reminder: call Bob at five. (Three pages of details follow.)", "the text, as the person reads it");
	assert.deepEqual(said.refs, [{ id: "n-1", from: { message: 3 }, conversation: "telegram:4242" }], "refs: itself");
	assert.equal(noteEntries("n-1").length, 0, "not stored while the run goes on");
	const run = await settled("n-run", from);
	const end = await settled("n-1", from);
	assert.ok(end.cursor > run.cursor, "stored, then settled, after the run");
	assert.equal(end.error, undefined);
	const events = of("n-1", from);
	assert.deepEqual(events.map((e) => e.type), ["message", "taken", "settled"], "said, then taken and settled once kept");
	assert.equal(run.error, undefined, "the run's own message is not touched");
	await until(() => fs.existsSync(path.join(P(), "taken", "n-1.json")), "its file to move last", 5_000);
	const kept = noteEntries("n-1");
	assert.equal(kept.length, 1);
	assert.match(textOf(kept[0]), /^\(Said to telegram:4242 without waking you\.\)\nSent: \w+day [^\n]*\n\nI reminded them to call Bob at five \(reminders\.md\)\.$/, "the note line first, the header, the note instead of the text");
	await sleep(1500);
	assert.ok(!t.model.requests.slice(asked).some((r) => r.users.some((u) => u.includes("Bob"))), "no request for the note: it woke nobody");
});

test("the next real message's request contains the note's kept text and its reply goes to its own sender only", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "n-next", text: "what is on my list?", conversation: "telegram:1001", sender: { name: "Ann", id: "Telegram user 1001" } });
	const end = await settled("n-next", from);
	assert.equal(end.error, undefined);
	const req = t.model.requests.at(-1)!;
	assert.equal(req.users.at(-1), "what is on my list?");
	assert.ok(req.users.includes("I reminded them to call Bob at five (reminders.md)."), "the note is in the model's context");
	assert.ok(!req.users.some((u) => u.includes("Three pages")), "what is kept is the note, not the text");
	const replies = port.events(P(), from).events.filter((e) => e.type === "message");
	assert.ok(replies.length > 0);
	for (const r of replies) assert.deepEqual(r.refs, [{ id: "n-next", conversation: "telegram:1001" }], "the reply goes to its sender only, never to the note's conversation");
});

test('note: "" leaves nothing in the session: the message is only said, then settled', async () => {
	const from = port.end(P());
	port.submit(P(), { id: "n-empty", text: "Your parcel arrived.", note: "", conversation: "telegram:4242", wake: false });
	const end = await settled("n-empty", from, 10_000);
	assert.equal(end.error, undefined);
	assert.deepEqual(of("n-empty", from).map((e) => e.type), ["message", "taken", "settled"]);
	await until(() => fs.existsSync(path.join(P(), "taken", "n-empty.json")), "its file to move, after its settled", 5_000);
	await sleep(1500);
	assert.ok(!entries().some((e) => e.details?.id === "n-empty" || JSON.stringify(e).includes("parcel")), "nothing of it in the session");
});

test("the same id twice: the second is dropped as a duplicate, never said again nor stored twice", async () => {
	const from = port.end(P());
	const msg = { id: "n-dup", text: "Water the plants.", conversation: "telegram:4242", wake: false };
	port.submit(P(), msg);
	await settled("n-dup", from);
	await until(() => fs.existsSync(path.join(P(), "taken", "n-dup.json")), "its file to move, after its settled", 5_000);
	assert.equal(port.submit(P(), msg), "duplicate", "its file in taken/ says so");
	// Sent again by a channel that does not look (a link into the inbox), and once more after taken/ was cleaned up:
	// the session remembers it. At once: while the first is in taken/, a resend is one whatever its file's time says.
	const again = async () => {
		const at = port.end(P());
		const tmp = path.join(P(), "inbox", ".n-dup.tmp");
		fs.writeFileSync(tmp, JSON.stringify(msg));
		fs.renameSync(tmp, path.join(P(), "inbox", "n-dup.json"));
		await t.waitEvent("main", at, (e) => e.type === "duplicate" && e.id === "n-dup", 10_000);
	};
	await again();
	fs.rmSync(path.join(P(), "taken", "n-dup.json"));
	await again();
	await sleep(1500);
	assert.equal(of("n-dup", from).filter((e) => e.type === "message").length, 1, "said once");
	assert.equal(of("n-dup", from).filter((e) => e.type === "settled").length, 1);
	assert.equal(noteEntries("n-dup").length, 1, "stored once");
});

test("a copy of a note a crash left in the inbox after it was settled is moved without a word: never said or settled twice", async () => {
	const from = port.end(P());
	const copy = path.join(P(), "inbox", "n-1.json");
	// As a crash leaves it: its file never moved (a move is one rename, so there is none in taken/).
	fs.renameSync(path.join(P(), "taken", "n-1.json"), copy);
	const before = new Date(Date.parse(noteEntries("n-1")[0].timestamp) - 60_000); // written before it was stored
	fs.utimesSync(copy, before, before);
	await until(() => !fs.existsSync(copy), "the copy to be moved", 10_000);
	await sleep(1500);
	assert.deepEqual(of("n-1", from), [], "nothing said, taken or settled again");
	assert.equal(noteEntries("n-1").length, 1);
});

test("a note with an attachment: the file follows as a file event, one that may not be sent is said to be refused, and the conversation keeps the paths", async () => {
	const report = path.join(folder(), "report.txt");
	fs.writeFileSync(report, "the report\n");
	const secret = path.join(t.home, "agents", "main", "secrets", "token");
	fs.mkdirSync(path.dirname(secret), { recursive: true });
	fs.writeFileSync(secret, "s3cret\n", { mode: 0o600 });
	const from = port.end(P());
	port.submit(P(), { id: "n-file", text: "Here is this week's report.", attachments: [report, secret], conversation: "telegram:4242", wake: false });
	const end = await settled("n-file", from);
	assert.equal(end.error, undefined);
	const events = of("n-file", from);
	assert.deepEqual(events.map((e) => e.type), ["message", "file", "error", "taken", "settled"]);
	assert.equal(events[1].path, fs.realpathSync(report));
	assert.equal(events[2].error, "not sent: token may not be sent from here", "its name only: the channel tells it to the conversation");
	assert.ok(!String(events[2].error).includes(t.home) && !String(events[2].error).includes("secrets/"), "no path into the private area");
	assert.ok(!events.some((e) => e.type === "file" && String(e.path).includes("secrets")), "never the secret");
	assert.match(textOf(noteEntries("n-file")[0]), /Here is this week's report\.\n\nAttached files:\n- .*report\.txt\n- .*secrets\/token$/);
});

test("kill -9 between the event and the session: said again, stored once", async () => {
	const from = await longRun("k-run", 30);
	const pid = Number(lastStart(P()).pid);
	port.submit(P(), { id: "k-1", text: "The build is green.", conversation: "telegram:4242", wake: false });
	await t.waitEvent("main", from, (e) => e.type === "message" && has(e, "k-1"), 5_000);
	process.kill(pid, "SIGKILL"); // a crash: said, not stored
	const restarted = await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.pid !== pid, 60_000);
	await t.waitEvent("main", restarted.cursor, (e) => e.type === "message" && has(e, "k-1"), 10_000);
	await settled("k-1", from);
	await sleep(2000);
	const events = of("k-1", from);
	assert.equal(events.filter((e) => e.type === "message").length, 2, "said twice rather than lost");
	assert.equal(events.filter((e) => e.type === "taken").length, 1);
	assert.equal(events.filter((e) => e.type === "settled").length, 1, "one last word");
	assert.equal(noteEntries("k-1").length, 1, "stored once");
	assert.ok(fs.existsSync(path.join(P(), "taken", "k-1.json")));
	await settled("k-run", from); // the cut-off run is resumed and ends by itself
});

test("a note only said while the events cannot be written stays in the inbox: after a restart it is said again and settled once", async (ctx) => {
	if (process.getuid?.() === 0) return ctx.skip("root can write anywhere");
	const from = port.end(P());
	const pid = Number(lastStart(P()).pid);
	const file = port.eventsFile(P());
	fs.chmodSync(file, 0o400); // like a full disk: its message, taken and settled wait in pi's memory
	try {
		port.submit(P(), { id: "w-1", text: "Bin day tomorrow.", note: "", conversation: "telegram:4242", wake: false });
		await sleep(3000);
		assert.ok(fs.existsSync(path.join(P(), "inbox", "w-1.json")), "its file stays, the mark that something is still owed");
		process.kill(pid, "SIGKILL"); // what waited in memory is lost
	} finally {
		fs.chmodSync(file, 0o600);
	}
	const restarted = await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.pid !== pid, 60_000);
	await t.waitEvent("main", restarted.cursor, (e) => e.type === "message" && has(e, "w-1"), 10_000);
	await settled("w-1", from);
	await sleep(1500);
	assert.equal(of("w-1", from).filter((e) => e.type === "settled").length, 1, "one last word");
	assert.ok(fs.existsSync(path.join(P(), "taken", "w-1.json")), "then its file moved");
});

test("pp send --no-wake: a note for the agent without --conversation, said there with it; --note keeps the note; --wait is a usage error", async () => {
	const from = port.end(P());
	const asked = t.model.requests.length;
	const r = await t.cli("send", "main", "the backup ran at 3:00", "--no-wake", "--id", "s-1");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "s-1");
	await settled("s-1", from);
	assert.deepEqual(of("s-1", from).map((e) => e.type), ["taken", "settled"], "no conversation: said nowhere, only kept");
	assert.equal(noteEntries("s-1")[0].details.conversation, undefined);
	assert.match(textOf(noteEntries("s-1")[0]), /^\(A note left for you\.\)\nSent: [^\n]*\n\nthe backup ran at 3:00$/, "a program's: no From: line");
	const c = await t.cli("send", "main", "Dinner at 8", "--no-wake", "--conversation", "telegram:4242", "--note", "told them: dinner at 8", "--id", "s-2");
	assert.equal(c.code, 0, c.stderr);
	await settled("s-2", from);
	assert.equal(of("s-2", from).find((e) => e.type === "message")?.text, "Dinner at 8");
	assert.match(textOf(noteEntries("s-2")[0]), /\n\ntold them: dinner at 8$/);
	const w = await t.cli("send", "main", "x", "--no-wake", "--wait");
	assert.equal(w.code, 2, "a usage error");
	assert.match(w.stderr, /--no-wake starts no run/);
	assert.equal((await t.cli("send", "main", "x", "--note", "y")).code, 2, "--note goes with --no-wake");
	const nothing = await t.cli("send", "main", "x", "--no-wake", "--note", "");
	assert.notEqual(nothing.code, 0, "neither said nor kept: refused");
	assert.match(nothing.stderr, /must keep something/);
	await sleep(1500);
	assert.equal(t.model.requests.length, asked, "none of them woke the model");
});

test("a note on a new agent is said at once and stored after the first answered message, and the model's first request still starts with the system prompt", async () => {
	assert.equal((await t.cli("init", "fresh", folder("fresh"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "fresh")).code, 0);
	const from = port.end(P("fresh"));
	port.submit(P("fresh"), { id: "e-1", text: "Welcome note.", conversation: "telegram:4242", wake: false });
	await t.waitEvent("fresh", from, (e) => e.type === "message" && has(e, "e-1"), 5_000);
	await sleep(2000);
	assert.deepEqual(of("e-1", from, "fresh").map((e) => e.type), ["message"], "said, not stored: pi wrote no session file yet");
	assert.ok(fs.existsSync(path.join(P("fresh"), "inbox", "e-1.json")), "its file waits in the inbox");
	const asked = t.model.requests.length;
	port.submit(P("fresh"), { id: "e-first", text: "first words", conversation: "telegram:4242" });
	const first = await settled("e-first", from, 60_000, "fresh");
	assert.equal(first.error, undefined, "the note let it pass, its own conversation's");
	const note = await settled("e-1", from, 30_000, "fresh");
	assert.ok(note.cursor > first.cursor, "stored after the first answered message");
	const req = t.model.requests[asked];
	assert.equal(req.first, "system", "the model's first request starts with the system prompt");
	assert.deepEqual(req.users, ["first words"], "and holds no note");
	const kept = entries("fresh");
	const at = kept.findIndex((e) => e.customType === "pi-personal.note");
	assert.ok(at > kept.findIndex((e) => e.type === "message" && e.message?.role === "assistant"), "in the session after the first reply");
	port.submit(P("fresh"), { id: "e-second", text: "second words", conversation: "telegram:4242" });
	await settled("e-second", from, 60_000, "fresh");
	assert.deepEqual(t.model.requests.at(-1)!.users, ["first words", "Welcome note.", "second words"], "then in its turn");
});
