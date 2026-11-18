// Crashes and the terminal: pi killed in the middle of a run resumes its work; a killed keeper comes back with `up`;
// a person typing in the terminal while messages arrive; the agent blocked on a question.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

let t: Env;
const P = () => t.portOf("main");
const lastStarted = () => [...port.events(P()).events].reverse().find((e) => e.type === "started" && !e.channel)!;
const status = async () => JSON.parse((await t.cli("status", "main", "--json")).stdout);

before(async () => {
	t = await setup("a05");
	const folder = path.join(t.dir, "agents", "main");
	assert.equal((await t.cli("init", "main", folder, "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.equal((await t.cli("send", "main", "remember the word apricot", "--wait", "--timeout", "30")).code, 0);
});
after(async () => t.close());

test("pi killed mid-run comes back with its conversation; pending messages delivered once; the cut-off work resumes", async () => {
	const from = port.end(P());
	const pid = Number(lastStarted().pid);
	await t.cli("send", "main", "tool: sleep 5; echo five", "--id", "k1");
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "k1");
	await sleep(500); // the tool is running
	await t.cli("send", "main", "are you back", "--id", "k2");
	process.kill(pid, "SIGKILL"); // the pid the bridge reported when it started
	await t.waitEvent("main", from, (e) => e.type === "restarted");
	const back = await t.waitEvent("main", from, (e) => e.type === "started" && e.pid !== pid);
	await t.waitEvent("main", back.cursor, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("k2"), 30_000);
	const after = port.events(P(), from).events;
	assert.equal(after.filter((e) => e.type === "taken" && e.id === "k2").length, 1);
	assert.equal(after.filter((e) => e.type === "message" && e.text === "echo: are you back").length, 1);
	// The cut-off run was resumed first: the bridge's note gets its own turn, linked to k1; the message that
	// waited comes right after, linked to k2.
	const noteReply = after.find((e) => e.type === "message" && String(e.text).includes("Pi-Personal restarted you"));
	assert.ok(noteReply, "the agent was asked to continue");
	assert.deepEqual(noteReply.refs.map((r: port.Ref) => r.id), ["k1"]);
	const reply = after.find((e) => e.type === "message" && e.text === "echo: are you back")!;
	assert.ok(noteReply.cursor < reply.cursor);
	assert.deepEqual(reply.refs.map((r: port.Ref) => r.id), ["k2"]);
	// The conversation is intact: the model still sees the first message.
	assert.ok(t.model.requests.at(-1)!.users.includes("remember the word apricot"));
	const s = await status();
	assert.match(s.lastRestart.reason, /killed by SIGKILL/);
});

test("the keeper (up, the login service) can die and come back; it adopts running agents without restarting them", async () => {
	const s1 = await status();
	const pid = lastStarted().pid;
	const from = port.end(P());
	const r = await t.cli("up");
	assert.match(r.stdout, /main: running/);
	const s2 = await status();
	assert.equal(s2.address, s1.address);
	assert.equal(lastStarted().pid, pid);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "restarted" || e.type === "started").length, 0);
	// The runner inside the terminal is killed too: Herdr ends the terminal and pi with it (never two sessions);
	// the next `up` starts a fresh terminal on the same conversation, and nothing is delivered twice.
	const runnerPid = t.hc("get", s1.address).pid;
	process.kill(runnerPid, "SIGKILL");
	for (let i = 0; i < 50 && (await status()).running; i++) await sleep(100);
	assert.equal((await status()).running, false);
	await t.cli("send", "main", "while you were gone", "--id", "g1");
	assert.match((await t.cli("up")).stdout, /main: started agent/);
	await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("g1"), 30_000);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "taken" && e.id === "g1").length, 1);
	assert.ok(t.model.requests.at(-1)!.users.includes("remember the word apricot"));
});

test("a person types in the terminal while messages arrive through the port", async () => {
	const s = await status();
	const from = port.end(P());
	await t.cli("send", "main", "tool: sleep 2; echo t13", "--id", "p1");
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "p1");
	// Herdr refuses to type into a program that started less than a few seconds ago, until its output settles.
	for (let i = 0; ; i++) {
		try {
			execFileSync("hc", ["send", s.address, "typed by a person"], { env: t.env, stdio: "pipe" });
			break;
		} catch (err) {
			if (i > 30) throw err;
			await sleep(500);
		}
	}
	await t.cli("send", "main", "from the port after typing", "--id", "p2");
	await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("p2"), 30_000);
	const ev = port.events(P(), from).events;
	assert.equal(ev.filter((e) => e.type === "input" && e.text === "typed by a person").length, 1);
	const typedReply = ev.find((e) => e.type === "message" && e.text === "echo: typed by a person")!;
	assert.ok(typedReply, "the typed message was answered");
	assert.ok(!JSON.stringify(typedReply.refs).includes("p2"));
	const portReply = ev.find((e) => e.type === "message" && e.text === "echo: from the port after typing")!;
	assert.deepEqual(portReply.refs.map((r: port.Ref) => r.id), ["p2"]);
	assert.equal(ev.filter((e) => e.type === "taken" && e.id === "p2").length, 1);
});

test("blocked on a question, the port carries it and the core answers nothing", async () => {
	const folder = path.join(t.dir, "agents", "main");
	fs.mkdirSync(path.join(folder, ".pi", "extensions", "gate"), { recursive: true });
	fs.copyFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/examples/extensions/permission-gate.ts"), path.join(folder, ".pi", "extensions", "gate", "index.ts"));
	assert.equal((await t.cli("ext", "check", "main", "gate")).code, 0);
	await t.cli("restart", "main");
	const from0 = port.end(P());
	await t.waitEvent("main", 0, (e) => e.type === "started" && e.cursor >= 0 && e.safeMode === null && e.cursor > 0);
	const from = port.end(P());
	await t.cli("send", "main", "tool: echo sudo is harmless here", "--id", "q1");
	const blocked = await t.waitEvent("main", from, (e) => e.type === "status" && e.state === "blocked");
	assert.match(String(blocked.question), /Dangerous command/);
	await t.cli("send", "main", "message during the question", "--id", "q2");
	await sleep(2000);
	const s = await status();
	assert.equal(s.state, "blocked");
	assert.match(s.question ?? "", /Dangerous command/);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "taken" && e.id === "q2").length, 0, "nothing answered the question");
	execFileSync("hc", ["keys", s.address, "enter"], { env: t.env }); // a person answers "Yes"
	await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("q2"), 30_000);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "message" && e.text === "echo: message during the question").length, 1);
	void from0;
});
