// Questions: an in-agent extension asks its owner through the bridge (pi-personal.ask). The question is shown in the
// terminal and said on the port; the first answer wins (the port's, by an option's text or number, or the terminal's),
// and none comes after the time limit or an interrupt. Another extension's dialog cannot be answered from the port:
// each message it holds up is told so, once, without the question's text. `pp send --wait` and `pp chat` show a
// question about their message with the command that answers it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as port from "../core/port.ts";
import { ASKER, CLI, type Env, lastStart, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const P = () => t.portOf("main");
const state = (f: string) => path.join(t.home, "agents", "main", "extensions", "asker", f);
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);
const settled = (id: string, from: number, ms = 30_000) => t.waitEvent("main", from, (e) => e.type === "settled" && has(e, id), ms);
const ask = (title: string, more: Record<string, unknown> = {}) => `call: ask_owner ${JSON.stringify({ title, ...more })}`;
/** A run whose tool asks a question: the question's event when it is asked. */
async function asking(id: string, title: string, more: Record<string, unknown> = {}) {
	const from = port.end(P());
	port.submit(P(), { id, text: ask(title, more), conversation: "telegram:4242", from: { message: 7 } });
	const q = await t.waitEvent("main", from, (e) => e.type === "question" && has(e, id));
	return { from, q };
}
let n = 0;
/** A control message answering a question, as a channel writes it: its settled. */
async function answer(question: string | undefined, text: string) {
	const id = `ans-${++n}`;
	const from = port.end(P());
	port.submit(P(), { id, text: "", control: "answer", ...(question !== undefined ? { question } : {}), answer: text });
	return settled(id, from);
}
const replyOf = (id: string, from: number) => port.events(P(), from).events.find((e) => e.type === "message" && has(e, id))?.text;

before(async () => {
	t = await setup("quest");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	fs.mkdirSync(path.join(folder(), ".pi", "extensions", "asker"), { recursive: true });
	fs.writeFileSync(path.join(folder(), ".pi", "extensions", "asker", "index.ts"), ASKER);
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.equal(lastStart(P()).safeMode, null, "the asker loads");
});
after(async () => t?.close());

test("an extension asks with options from a tool call: the question is said on the port, and answered from the port by an option's text, case ignored", async () => {
	const at = Date.now();
	const { from, q } = await asking("q-text", "Which colour?\nFor the chart of May.", { options: ["Red", "Green"] });
	assert.match(String(q.id), /^q[a-z0-9]{6,20}$/);
	assert.equal(q.title, "Which colour?\nFor the chart of May.", "line breaks kept");
	assert.deepEqual(q.options, ["Red", "Green"]);
	assert.deepEqual(q.refs, [{ id: "q-text", from: { message: 7 }, conversation: "telegram:4242" }]);
	const until = Date.parse(String(q.until)) - at;
	assert.ok(until > 4.5 * 60_000 && until < 5.5 * 60_000, `five minutes by default (${until} ms)`);
	// A message that waits meanwhile is not told anything: the bridge's own question can be answered from the port.
	port.submit(P(), { id: "q-text-next", text: "after the question", conversation: "telegram:1002" });
	await sleep(2500);
	const s = await answer(String(q.id), "  gREEN ");
	assert.equal(s.error, undefined);
	assert.equal(s.result, `answered ${q.id}`);
	const done = await t.waitEvent("main", from, (e) => e.type === "answered" && e.id === q.id);
	assert.equal(done.by, "port");
	assert.deepEqual(done.refs, q.refs);
	const end = await settled("q-text", from);
	assert.equal(end.error, undefined);
	assert.equal(replyOf("q-text", from), "done: answer: Green");
	await settled("q-text-next", from);
	const events = port.events(P(), from).events;
	assert.ok(events.some((e) => e.type === "status" && e.state === "blocked"), "the terminal's dialog was shown (status blocked, as today)");
	assert.deepEqual(events.filter((e) => e.type === "error"), [], "nothing for the bridge's own question");
	assert.ok(!t.model.requests.some((r) => r.raw.includes("gREEN")), "the answer itself never reaches the model as a message");
});

test("answered from the port by an option's number, from 1", async () => {
	const { from, q } = await asking("q-number", "Ship it?", { options: ["Yes", "No", "Later"] });
	assert.equal((await answer(String(q.id), "3")).result, `answered ${q.id}`);
	await settled("q-number", from);
	assert.equal(replyOf("q-number", from), "done: answer: Later");
});

test("with options that are numerals, a number in range is the option shown under it, not the option that reads the same", async () => {
	const { from, q } = await asking("q-numerals", "How many retries?", { options: ["0", "1"] });
	assert.equal((await answer(String(q.id), "1")).result, `answered ${q.id}`);
	await settled("q-numerals", from);
	assert.equal(replyOf("q-numerals", from), "done: answer: 0");
});

test("an answer that fits no option keeps the question open; the first answer wins and a second finds it closed; an id never asked is closed", async () => {
	const { from, q } = await asking("q-wrong", "Which one?", { options: ["Red", "Green"] });
	for (const wrong of ["Blue", "0", "3"]) {
		const s = await answer(String(q.id), wrong);
		assert.equal(s.result, undefined);
		assert.match(String(s.error), /is none of the options: 1 Red, 2 Green; the question still waits$/, wrong);
	}
	assert.equal((await answer(String(q.id), "1")).result, `answered ${q.id}`);
	assert.equal((await answer(String(q.id), "2")).error, "that question is closed", "the first answer won");
	await settled("q-wrong", from);
	assert.equal(replyOf("q-wrong", from), "done: answer: Red");
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "answered" && e.id === q.id).length, 1, "answered once");
	assert.equal((await answer("qnever1234", "yes")).error, "that question is closed");
	assert.match(String((await answer(undefined, "yes")).error), /no question was named/);
});

test("answered in the terminal: the owner types the answer in pi's own dialog, and the port's answer then finds it closed", async () => {
	const { from, q } = await asking("q-terminal", "What name?");
	await sleep(1000); // the dialog is drawn
	const addr = JSON.parse((await t.cli("status", "main", "--json")).stdout).address;
	t.hc("send", "--force", addr, "typed in the terminal"); // --force: into the dialog the agent waits on
	const done = await t.waitEvent("main", from, (e) => e.type === "answered" && e.id === q.id);
	assert.equal(done.by, "terminal");
	assert.equal((await answer(String(q.id), "too late")).error, "that question is closed");
	await settled("q-terminal", from);
	assert.equal(replyOf("q-terminal", from), "done: answer: typed in the terminal");
});

test("after the time limit the answer is none, and answered says timeout", async () => {
	const { from, q } = await asking("q-timeout", "Quick?", { options: ["Yes"], timeoutMs: 1500 });
	assert.ok(Date.parse(String(q.until)) - Date.now() < 2000);
	const done = await t.waitEvent("main", from, (e) => e.type === "answered" && e.id === q.id);
	assert.equal(done.by, "timeout");
	await settled("q-timeout", from);
	assert.equal(replyOf("q-timeout", from), "done: answer: none");
});

test("an interrupt answers every waiting question none, and the run stops", async () => {
	const { from, q } = await asking("q-interrupt", "Wait for me?", { options: ["Yes", "No"] });
	const r = await t.cli("interrupt", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^asked the run to stop/);
	const done = await t.waitEvent("main", from, (e) => e.type === "answered" && e.id === q.id);
	assert.equal(done.by, "interrupted");
	const end = await settled("q-interrupt", from);
	assert.match(String(end.error), /the work was stopped before these messages were answered/);
	// The asker writes its line in a later turn of pi's loop than the bridge writes its events: wait for it.
	const told = () => JSON.parse(fs.readFileSync(state("answers"), "utf8").trim().split("\n").at(-1)!);
	for (let limit = Date.now() + 5_000; told().title !== "Wait for me?" && Date.now() < limit; ) await sleep(50);
	assert.deepEqual(told(), { title: "Wait for me?", answer: null }, "the asker got none");
	assert.equal((await answer(String(q.id), "Yes")).error, "that question is closed");
});

test("the end of the run answers a question asked for it none: an asker that did not wait is not left waiting", async () => {
	const { from, q } = await asking("q-end", "Later?", { wait: false });
	const done = await t.waitEvent("main", from, (e) => e.type === "answered" && e.id === q.id);
	assert.equal(done.by, "interrupted");
	assert.equal((await settled("q-end", from)).error, undefined);
	assert.equal(replyOf("q-end", from), "done: asked");
	// The asker writes its line in a later turn of pi's loop than the bridge writes its events: wait for it.
	const last = () => JSON.parse(fs.readFileSync(state("answers"), "utf8").trim().split("\n").at(-1)!);
	for (let end = Date.now() + 5_000; last().title !== "Later?" && Date.now() < end; ) await sleep(50);
	assert.deepEqual(last(), { title: "Later?", answer: null });
});

test("pp send --wait shows a question about its message with the command that answers it; pp answer finds the one question waiting", async () => {
	const from = port.end(P());
	const child = spawn(process.execPath, [CLI, "send", "main", ask("Name the file"), "--wait", "--id", "q-send", "--timeout", "60"], { env: t.env });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (b) => (stdout += b));
	child.stderr.on("data", (b) => (stderr += b));
	const exit = new Promise<number | null>((r) => child.on("close", r));
	const q = await t.waitEvent("main", from, (e) => e.type === "question" && has(e, "q-send"));
	for (let end = Date.now() + 10_000; !stderr.includes("to answer") && Date.now() < end; ) await sleep(100);
	assert.equal(stderr, `pp: the agent asks (${q.id}): Name the file\n  to answer: pp answer main "<your answer>" --question ${q.id}\n`);
	const r = await t.cli("answer", "main", "report", "final.pdf");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.equal(r.stdout.trim(), `answered ${q.id}`);
	assert.equal(await exit, 0, stderr);
	assert.equal(stdout.trim(), "done: answer: report final.pdf");
	// Nothing waits now: pp answer says so, and writes nothing.
	const none = await t.cli("answer", "main", "again");
	assert.equal(none.code, 2);
	assert.match(none.stderr, /no question of main waits for an answer/);
	const closed = await t.cli("answer", "main", "again", "--question", String(q.id));
	assert.equal(closed.code, 1);
	assert.match(closed.stderr, /that question is closed/);
});

test("pp chat shows a question about one of its messages with the command that answers it, under the installed command's name, and says when it was answered or closed", async () => {
	const from = port.end(P());
	// Installed as pi-personal (pp being another program): the command shown must be the one that reaches Pi-Personal.
	const chat = spawn(process.execPath, [CLI, "chat", "main"], { env: { ...t.env, PI_PERSONAL_COMMAND: "pi-personal" }, stdio: ["pipe", "pipe", "pipe"] });
	let shown = "";
	chat.stdout.on("data", (d) => (shown += d));
	const until = async (what: string, pred: () => boolean) => {
		for (let end = Date.now() + 30_000; !pred(); await sleep(100)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${shown}`);
	};
	try {
		await until("the chat", () => shown.includes("Talking to the agent"));
		chat.stdin.write(`${ask("Which size?", { options: ["Small", "Large"] })}\n`);
		const q = await t.waitEvent("main", from, (e) => e.type === "question" && e.title === "Which size?");
		await until("the question", () => shown.includes("to answer"));
		assert.ok(shown.includes(`(the agent asks (${q.id}): Which size?\n  1. Small\n  2. Large\n  to answer: pi-personal answer main "<your answer>" --question ${q.id})`), shown);
		assert.equal((await answer(String(q.id), "2")).result, `answered ${q.id}`);
		await until("answered", () => shown.includes(`(question ${q.id} answered)`));
		await until("the reply", () => shown.includes("done: answer: Large"));
		// One that gets no answer in time is said closed.
		const at = port.end(P());
		chat.stdin.write(`${ask("Quick one?", { timeoutMs: 1500 })}\n`);
		const q2 = await t.waitEvent("main", at, (e) => e.type === "question" && e.title === "Quick one?");
		await until("closed", () => shown.includes(`(question ${q2.id} closed: no answer in time)`));
		await until("the second reply", () => shown.includes("done: answer: none"));
		// A question about someone else's message is not shown here.
		const other = await asking("q-not-chat", "Not for the chat?", { timeoutMs: 1500 });
		await settled("q-not-chat", other.from);
		await sleep(1000);
		assert.doesNotMatch(shown, /asks \([^)]*\): Not for the chat\?/, "someone else's question is not asked here");
		assert.doesNotMatch(shown, /waiting for a person in its terminal: (Which size|Quick one)/, "not for its own question, shown above");
		// pp restart (a stop, then a start) closes its open question without an `answered`: said once, and another's
		// dialog is shown again after.
		const at3 = port.end(P());
		chat.stdin.write(`${ask("Before the restart?", { timeoutMs: 120_000 })}\n`);
		const q3 = await t.waitEvent("main", at3, (e) => e.type === "question" && e.title === "Before the restart?");
		await until("the third question", () => shown.includes(`--question ${q3.id}`));
		assert.equal((await t.cli("restart", "main")).code, 0);
		const closed = `(question ${q3.id} closed: the agent stopped)`;
		await until("closed by the restart", () => shown.includes(closed));
		const mark = shown.length;
		const at4 = port.end(P());
		port.submit(P(), { id: "c-after-restart", text: `call: confirm_probe ${JSON.stringify({ title: "Someone else's dialog?", timeoutMs: 1500 })}`, conversation: "telegram:4242" });
		await until("another's dialog", () => shown.slice(mark).includes("(the agent is waiting for a person in its terminal: Someone else's dialog?)"));
		await settled("c-after-restart", at4);
		assert.equal(shown.split(closed).length, 2, "said once");
	} finally {
		chat.stdin.end();
	}
});

test("an asker outside Pi-Personal sees taken unset: under plain pi (a check), nobody takes its question", async () => {
	fs.writeFileSync(state("ask-at-load"), "");
	const r = await t.cli("ext", "check", "main", "asker");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.deepEqual(JSON.parse(fs.readFileSync(state("at-load"), "utf8").trim().split("\n").at(-1)!), { taken: null });
	// Under Pi-Personal, the same asker is taken.
	fs.writeFileSync(state("ask-at-load"), "");
	const from = port.end(P());
	assert.equal((await t.cli("restart", "main")).code, 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(state("at-load"), "utf8").trim().split("\n").at(-1)!), { taken: true });
	const q = port.events(P(), from).events.find((e) => e.type === "question" && e.title === "asked while loading");
	assert.ok(q, "said on the port");
	assert.deepEqual(q.refs, [], "outside a run: no refs");
	assert.equal((await answer(String(q.id), "fine")).result, `answered ${q.id}`);
});

test("another extension's ctx.ui.confirm during a run: blocked, and one error for each message it holds up, without the question's text", async () => {
	const from = port.end(P());
	port.submit(P(), { id: "c-run", text: `call: confirm_probe ${JSON.stringify({ title: "Delete the secret folder?", timeoutMs: 9000 })}`, conversation: "telegram:4242" });
	await t.waitEvent("main", from, (e) => e.type === "status" && e.state === "blocked");
	port.submit(P(), { id: "c-wait-1", text: "first one waiting", conversation: "telegram:1002" });
	port.submit(P(), { id: "c-wait-2", text: "second one waiting", conversation: "cli" });
	const told = (id: string) => t.waitEvent("main", from, (e) => e.type === "error" && has(e, id));
	assert.equal((await told("c-run")).error, "the agent waits for an answer in its terminal before it can go on");
	for (const id of ["c-wait-1", "c-wait-2"]) {
		const e = await told(id);
		assert.equal(e.error, "the agent waits for an answer in its terminal before it can read this message");
		assert.equal(e.retryAt, undefined);
	}
	await sleep(3000); // more looks at the inbox while it waits
	const errors = port.events(P(), from).events.filter((e) => e.type === "error");
	assert.deepEqual(errors.map((e) => (e.refs as port.Ref[]).map((r) => r.id).join()).sort(), ["c-run", "c-wait-1", "c-wait-2"], "once per message");
	assert.ok(!errors.some((e) => JSON.stringify(e).includes("secret folder")), "the question belongs to another conversation");
	// The dialog closes by itself (its time limit): everything goes on, and nothing is said twice.
	assert.equal((await settled("c-run", from)).error, undefined);
	assert.equal(replyOf("c-run", from), "done: confirmed: false");
	for (const id of ["c-wait-1", "c-wait-2"]) assert.equal((await settled(id, from)).error, undefined);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "error").length, 3);
});
