// The agent's own session: pinned by its id (the `session` file), so that no other pi becomes the agent; an agent made
// by 0.4 keeps its conversation; a fresh conversation (pp new), a new model (pp model) and a thinking level
// (pp thinking), each applied by restarting the agent's terminal only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as port from "../core/port.ts";
import { piCli } from "../core/runner.ts";
import { type Env, lastStart, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const P = () => t.portOf("main");
const area = () => path.join(t.home, "agents", "main");
const pinned = () => fs.readFileSync(path.join(area(), "session"), "utf8").trim();
const sessionFiles = () => (fs.readdirSync(path.join(area(), "sessions"), { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(area(), "sessions", f));
const idOf = (file: string) => JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]).id;
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);
const settledOf = (id: string) => port.events(P()).events.filter((e) => e.type === "settled" && has(e, id));
const settled = (id: string, ms = 30_000) => t.waitEvent("main", 0, (e) => e.type === "settled" && has(e, id), ms);
const until = async (pred: () => boolean, what: string, ms = 30_000) => {
	for (const end = Date.now() + ms; !pred(); await sleep(100)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};
/** What the model was sent along with this text, its last user message. */
const requestFor = (text: string) => t.model.requests.findLast((r) => r.users.at(-1) === text);
const ask = async (text: string) => {
	const r = await t.cli("send", "main", text, "--wait", "--timeout", "60");
	assert.equal(r.stdout.trim(), `echo: ${text}`, r.stderr);
	return requestFor(text)!;
};
/** A long run: its tool has started when this returns. */
async function longRun(id: string, seconds: number) {
	const from = port.end(P());
	const text = `tool: sleep ${seconds}`;
	port.submit(P(), { id, text, conversation: "telegram:4242", sender: { name: "Ann", id: "Telegram user 4242" } });
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === id);
	await until(() => t.model.requests.some((r) => r.users.at(-1) === text), "the model to call the tool");
	await sleep(500); // the tool runs
}

before(async () => {
	t = await setup("sess");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t?.close());

test("a new agent gets the id of its session before its first start, and pi's session carries it", async () => {
	const id = pinned();
	assert.ok(id, "written before pi started");
	await ask("remember the word apricot");
	assert.equal(sessionFiles().length, 1);
	assert.equal(idOf(sessionFiles()[0]), id);
	assert.equal(fs.statSync(path.join(area(), "session")).mode & 0o777, 0o600);
});

test("an agent of 0.4 (a session, no session file) keeps its conversation across the update", async () => {
	const before = idOf(sessionFiles()[0]);
	assert.equal((await t.cli("stop", "main")).code, 0);
	fs.rmSync(path.join(area(), "session")); // as 0.4 left it: its conversation, and no id
	assert.equal((await t.cli("start", "main")).code, 0);
	await until(() => fs.existsSync(path.join(area(), "session")), "the bridge to write the id");
	assert.equal(pinned(), before, "the id of the session pi resumed");
	assert.ok((await ask("still there?")).users.includes("remember the word apricot"), "the conversation was kept, not replaced by an empty one");
	await t.cli("restart", "main");
	assert.ok((await ask("and now?")).users.includes("remember the word apricot"), "and stays the agent's after a restart");
	assert.equal(sessionFiles().length, 1);
});

test("a pi started by hand in the agent's folder with its environment does not become the agent at the next restart", async () => {
	// The agent's own bash runs pi, as a helper or a sub-agent package would: it leaves a newer session in the same folder.
	const tool = `tool: '${process.execPath}' '${piCli()}' --model fake/echo-1 -p 'a helper says hi' < /dev/null`;
	const r = await t.cli("send", "main", tool, "--wait", "--timeout", "90");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /echo: a helper says hi/);
	assert.equal(sessionFiles().length, 2, "the helper's session, beside the agent's");
	const id = pinned();
	await t.cli("restart", "main");
	const users = (await ask("who am I talking to?")).users;
	assert.ok(users.includes("remember the word apricot"), "the agent's conversation");
	assert.ok(!users.includes("a helper says hi"), "not the helper's");
	assert.equal(pinned(), id);
});

test("pp new during a run: one settled with an error for the open message, the next message answered in a conversation that knows nothing of the old one, which a restart keeps; the same id is still refused", async () => {
	const old = pinned();
	await longRun("n-long", 31);
	port.submit(P(), { id: "n-next", text: "the next one", conversation: "telegram:1002" });
	const r = await t.cli("new", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^main: a new conversation; pi is ready/);
	const end = await settled("n-long");
	assert.match(String(end.error), /stopped before answering/, "closed by the path of a stop on purpose");
	assert.equal((await settled("n-next", 60_000)).error, undefined);
	assert.deepEqual(requestFor("the next one")!.users, ["the next one"], "a conversation that knows nothing of the old one");
	assert.notEqual(pinned(), old);
	assert.ok(sessionFiles().some((f) => idOf(f) === old), "the old session stays where it was");
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.equal(s.stoppedOnPurpose, false, "not left stopped");
	await t.cli("restart", "main");
	const users = (await ask("one more")).users;
	assert.ok(users.includes("the next one"), "a second restart stays in the new conversation");
	assert.ok(!users.includes("remember the word apricot"));
	assert.equal(settledOf("n-long").length, 1, "exactly one settled");
	const again = await t.cli("send", "main", "tool: sleep 31", "--id", "n-long");
	assert.match(again.stdout, /duplicate/, "the same id sent again is still refused");
});

test("after pp new, an id taken before it is refused only while its file in taken/ is kept (30 days)", async () => {
	const file = path.join(P(), "taken", "n-long.json");
	const old = new Date(Date.now() - 31 * 86_400_000);
	fs.utimesSync(file, old, old);
	await t.cli("restart", "main"); // the runner removes taken/ files older than 30 days
	assert.ok(!fs.existsSync(file));
	const r = await t.cli("send", "main", "an old id", "--id", "n-long", "--wait", "--timeout", "60");
	assert.equal(r.stdout.trim(), "echo: an old id", "the new conversation does not know it: taken in and answered");
});

test("pp new with pi down and a cut-off run: the command says the missing settled itself", async () => {
	await longRun("d-long", 32);
	// The runner and pi die at once: nobody can close the run.
	const runner = JSON.parse(fs.readFileSync(path.join(area(), "runner.lock"), "utf8")).pid;
	process.kill(Number(lastStart(P()).pid), "SIGKILL");
	process.kill(runner, "SIGKILL");
	spawnSync("pkill", ["-KILL", "-f", "sleep 32"]);
	for (const end = Date.now() + 20_000; JSON.parse((await t.cli("status", "main", "--json")).stdout).running; await sleep(300))
		if (Date.now() > end) throw new Error("the agent's terminal did not end");
	const old = pinned();
	const r = await t.cli("new", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /1 message\(s\) taken in before were not answered/);
	assert.equal((await settled("d-long")).error, "a new conversation was started before this message was answered");
	assert.deepEqual((await ask("after the crash")).users, ["after the crash"]);
	assert.equal(settledOf("d-long").length, 1, "said once");
	// The owner goes back to the old session (pi's /resume writes it down as the agent's): its run is closed, not resumed.
	fs.writeFileSync(path.join(area(), "session"), `${old}\n`);
	const from = port.end(P());
	assert.equal((await t.cli("restart", "main")).code, 0);
	await sleep(5000);
	assert.ok(!port.events(P(), from).events.some((e) => e.type === "message" && has(e, "d-long")), "nothing more said to its sender");
	assert.equal(settledOf("d-long").length, 1, "still said once");
});

test("pp model while a run is going: the run is resumed with the new model, and settles once", async () => {
	assert.equal((await t.cli("model", "main")).stdout.trim(), "fake/echo-1");
	await longRun("m-long", 33);
	const asked = t.model.requests.length;
	const r = await t.cli("model", "main", "fake/echo-2"); // an id pi does not list: passed to the provider as it is
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /it runs with fake\/echo-2; pi is ready/);
	const end = await settled("m-long", 60_000);
	assert.equal(end.error, undefined, "resumed, then answered");
	await sleep(1000);
	assert.equal(settledOf("m-long").length, 1, "settled once");
	assert.ok(t.model.requests.slice(asked).length > 0 && t.model.requests.slice(asked).every((q) => q.model === "echo-2"), "the resumed run asks the new model");
	assert.equal(JSON.parse(fs.readFileSync(path.join(folder(), "pi-personal.json"), "utf8")).model, "fake/echo-2");
	assert.equal((await ask("with the new model")).model, "echo-2");
	const bad = await t.cli("model", "main", "nowhere/at-all");
	assert.notEqual(bad.code, 0, "a provider pi does not know is refused");
	assert.equal(JSON.parse(fs.readFileSync(path.join(folder(), "pi-personal.json"), "utf8")).model, "fake/echo-2", "and nothing written");
});

test("pp thinking high reaches the model as a reasoning effort", async () => {
	assert.equal((await t.cli("model", "main", "fake/echo-1")).code, 0); // a model pi knows reasons
	assert.match((await t.cli("thinking", "main")).stdout, /^not set/);
	assert.equal((await t.cli("thinking", "main", "loud")).code, 2, "a level pi does not take is refused");
	const r = await t.cli("thinking", "main", "high");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.equal((await ask("think hard")).effort, "high");
	assert.equal((await t.cli("thinking", "main")).stdout.trim(), "high");
	// A wrong value written by hand is set aside, and said.
	const file = path.join(folder(), "pi-personal.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), thinking: "loud" }));
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.ok(s.problems?.some((p: string) => /thinking must be one of off, minimal, low, medium, high, xhigh, max/.test(p)), JSON.stringify(s.problems));
});

test("pp new on an agent stopped on purpose starts nothing: the next start begins the new conversation", async () => {
	assert.equal((await t.cli("stop", "main")).code, 0);
	const old = pinned();
	const r = await t.cli("new", "main");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /main is stopped: a new conversation from its next start/);
	assert.equal(JSON.parse((await t.cli("status", "main", "--json")).stdout).running, false, "still stopped");
	assert.notEqual(pinned(), old);
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.deepEqual((await ask("hello again")).users, ["hello again"]);
});

test("pp stop while pp model waits for the agent's terminal to end: the agent stays stopped", async () => {
	const ext = path.join(folder(), ".pi", "extensions", "slow-exit.ts");
	const ending = path.join(t.dir, "pi-is-ending");
	fs.mkdirSync(path.dirname(ext), { recursive: true });
	// pi says when it begins to end, then holds its terminal until Herdr Core escalates (about a second): time for a
	// stop to come while pp model waits for that terminal.
	fs.writeFileSync(
		ext,
		`import * as fs from "node:fs";\nexport default function (pi) {\n\tpi.on("session_shutdown", () => {\n\t\tfs.writeFileSync(${JSON.stringify(ending)}, "");\n\t\tfor (const end = Date.now() + 4000; Date.now() < end; );\n\t});\n}\n`,
	);
	try {
		assert.equal((await t.cli("restart", "main")).code, 0);
		fs.rmSync(ending, { force: true });
		const model = t.cli("model", "main", "fake/echo-2");
		await until(() => fs.existsSync(ending), "pi to begin to end", 15_000);
		assert.equal((await t.cli("stop", "main")).code, 0);
		const r = await model;
		assert.equal(r.code, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /main is stopped: it runs with fake\/echo-2 from its next start/);
		await sleep(2000);
		const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
		assert.equal(s.running, false, "the stop is not undone");
		assert.equal(s.stoppedOnPurpose, true);
	} finally {
		fs.rmSync(ext, { force: true });
	}
});
