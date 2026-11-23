// Piloting from a channel: `pp remote <agent> -- <command>`, run by a channel (the fake one) through the command
// Pi-Personal gives it (PI_PERSONAL_REMOTE). Every command, what is refused, words after "--" taken as they are, a key
// stored without a terminal and used by the running agent at once, a secret that appears nowhere else, and the kit's door.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { ASKER, type Env, ROOT, run, setup, sleep } from "./helpers.ts";

let t: Env;
const RIGHT = "sk-remote-right-7f3a9c";
const SECRET = "hunter2-very-secret-91b";
const P = () => t.portOf("main");
const folder = () => path.join(t.dir, "agents", "main");
const state = () => path.join(t.home, "agents", "main", "channels", "fake");
const until = async (pred: () => boolean, ms = 30_000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(100);
	}
};

let n = 0;
/** What the channel's owner asks: the fake channel runs PI_PERSONAL_REMOTE with these words, `stdin` on its standard input. */
async function pilot(words: string[], opts: { stdin?: string; id?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	const dir = path.join(state(), "remote");
	await until(() => fs.existsSync(dir));
	const name = `r${++n}`;
	fs.writeFileSync(path.join(dir, `.${name}`), JSON.stringify({ words, ...opts }));
	fs.renameSync(path.join(dir, `.${name}`), path.join(dir, `${name}.json`));
	const out = path.join(dir, `${name}.out`);
	await until(() => fs.existsSync(out), 150_000);
	return JSON.parse(fs.readFileSync(out, "utf8"));
}

/** Every file under `dir` that holds `text`, but those in `except`. */
const holding = (dir: string, text: string, except: string[]): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
		const p = path.join(dir, d.name);
		if (d.isDirectory()) return holding(p, text, except);
		if (!d.isFile() || except.includes(p)) return [];
		try {
			return fs.readFileSync(p).includes(text) ? [p] : [];
		} catch {
			return []; // a file this user cannot read holds nothing it wrote
		}
	});

before(async () => {
	t = await setup("remote", { requireKey: RIGHT });
	fs.writeFileSync(path.join(t.home, "pi", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "sk-wrong" } }), { mode: 0o600 });
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	const file = path.join(folder(), "pi-personal.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), channels: { fake: { command: [process.execPath, path.join(ROOT, "test", "fake-channel.ts")] } } }));
	fs.mkdirSync(path.join(folder(), ".pi", "extensions", "asker"), { recursive: true });
	fs.writeFileSync(path.join(folder(), ".pi", "extensions", "asker", "index.ts"), ASKER);
	const r = await t.cli("start", "main");
	assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
});
after(async () => {
	await t?.close();
});

test("login stores a key the provider then requires, and the running agent answers with it without a restart", async () => {
	const refused = await t.cli("send", "main", "hello before the key", "--wait", "--timeout", "60");
	assert.equal(refused.code, 1, "the provider refuses the old key");
	const from = port.end(P());
	const r = await pilot(["login", "fake"], { stdin: `${RIGHT}\n` });
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "stored an API key for fake (not shown); the agents use it from their next message");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.home, "pi", "auth.json"), "utf8")).fake, { type: "api_key", key: RIGHT });
	const ok = await t.cli("send", "main", "hello with the key from the channel", "--wait", "--timeout", "60");
	assert.equal(ok.code, 0, `${ok.stdout}${ok.stderr}`);
	assert.match(ok.stdout, /echo: hello with the key from the channel/);
	assert.ok(!port.events(P(), from).events.some((e) => (e.type === "started" || e.type === "restarted") && !e.channel), "the agent was not restarted");
});

test("login refuses a provider that asks for more than a key, one that is unknown, an empty key, and a key pi would run; nothing is stored", async () => {
	const auth = () => fs.readFileSync(path.join(t.home, "pi", "auth.json"), "utf8");
	const before = auth();
	const more = await pilot(["login", "amazon-bedrock"], { stdin: "AKIA-not-stored-123" });
	assert.equal(more.code, 1);
	assert.match(more.stderr, /^Amazon Bedrock asks for more than a key: run pp login amazon-bedrock --api-key in a terminal$/m);
	const unknown = await pilot(["login", "nowhere"], { stdin: "sk-x" });
	assert.equal(unknown.code, 1);
	assert.match(unknown.stderr, /pi knows no provider "nowhere"/);
	const empty = await pilot(["login", "fake"], { stdin: "  \n" });
	assert.equal(empty.code, 2);
	assert.match(empty.stderr, /no key was given: nothing was stored/);
	// pi would run the first as a command and fill the second in from the environment: neither is stored, so nothing runs.
	const ran = path.join(t.dir, "ran");
	for (const odd of [`!touch ${ran}`, "sk-$HOME"]) {
		const r = await pilot(["login", "fake"], { stdin: `${odd}\n` });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /is not stored from here \(pi would run it or fill it in\): run pp login fake --api-key in a terminal/);
		assert.ok(!r.stderr.includes(odd) && !r.stdout.includes(odd), "the refusal repeats nothing of it");
	}
	assert.equal(auth(), before);
	assert.ok(!fs.existsSync(ran));
});

test("secret set stores the value from standard input, and neither it nor the key appears in any file but its own", async () => {
	const r = await pilot(["secret", "set", "mail-password"], { stdin: `${SECRET}\n` });
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "stored mail-password for main (not shown)");
	const file = path.join(t.home, "agents", "main", "secrets", "mail-password");
	assert.equal(fs.readFileSync(file, "utf8"), `${SECRET}\n`);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	// The private area (the port, the logs, the session, the channel's state and its output), the agent's folder, and the
	// test's Herdr Core (its state and runtime folders).
	const auth = path.join(t.home, "pi", "auth.json");
	assert.deepEqual(holding(t.dir, RIGHT, [auth]), [], "the key is only in pi's auth.json");
	assert.deepEqual(holding(t.dir, SECRET, [file]), [], "the secret is only in its own file");
	assert.ok(!t.model.requests.some((q) => q.raw.includes(RIGHT) || q.raw.includes(SECRET)), "never sent to the model");
});

test("interrupt: a run in progress is stopped; the channel's id makes a request fetched twice done once", async () => {
	const from = port.end(P());
	await t.cli("send", "main", "tool: sleep 30", "--id", "long-run");
	await t.waitEvent("main", from, (e) => e.type === "taken" && e.id === "long-run");
	const r = await pilot(["interrupt"], { id: "fake-int-1" });
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "asked the run to stop");
	const settled = await t.waitEvent("main", from, (e) => e.type === "settled" && ((e.refs as port.Ref[]) ?? []).some((x) => x.id === "long-run"));
	assert.ok(settled.error);
	const again = await pilot(["interrupt"], { id: "fake-int-1" });
	assert.equal(again.code, 0, again.stderr);
	assert.equal(again.stdout.trim(), "fake-int-1 was already done");
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "taken" && e.id === "fake-int-1").length, 1);
});

test("answer writes the question and the text as they are (--help and --home are text) and reports what the bridge says: answered, then closed", async () => {
	const cases: [string[], string][] = [
		[["--help"], "--help"],
		[["--home", "/x"], "--home /x"],
		[["yes,", "the", "second"], "yes, the second"],
	];
	for (const [i, [words, text]] of cases.entries()) {
		const from = port.end(P());
		await t.cli("send", "main", `call: ask_owner {"title":"case ${i}"}`, "--id", `asking-${i}`);
		const q = await t.waitEvent("main", from, (e) => e.type === "question" && e.title === `case ${i}`);
		const id = `fake-ans-${i}`;
		const r = await pilot(["answer", String(q.id), ...words], { id });
		const msg = JSON.parse(fs.readFileSync(path.join(P(), "taken", `${id}.json`), "utf8"));
		assert.deepEqual({ control: msg.control, question: msg.question, answer: msg.answer, text: msg.text }, { control: "answer", question: q.id, answer: text, text: "" });
		assert.equal(r.code, 0, r.stderr);
		assert.equal(r.stdout.trim(), `answered ${q.id}`);
		const reply = await t.waitEvent("main", from, (e) => e.type === "message" && ((e.refs as port.Ref[]) ?? []).some((x) => x.id === `asking-${i}`));
		assert.equal(reply.text, `done: answer: ${text}`);
		// Answered: the same words again find it closed.
		const again = await pilot(["answer", String(q.id), "again"]);
		assert.equal(again.code, 1);
		assert.equal(again.stderr.trim(), "pp: that question is closed");
	}
	const usage = await pilot(["answer", "q4"]);
	assert.equal(usage.code, 2);
	assert.match(usage.stderr, /usage: answer <question id> <text\.\.\.>/);
});

test("status, model and thinking without a value, and help: short plain answers; a setting ends with what may be chosen", async () => {
	const s = await pilot(["status"]);
	assert.equal(s.code, 0, s.stderr);
	// A few lines for a phone: the state, the model, each channel; nothing of Herdr Core, no date, no colour.
	assert.equal(s.stdout.trim(), "main is idle\nModel: fake/echo-1\nFake: running");
	const m = await pilot(["model"]);
	const [now, choose] = m.stdout.trim().split("\n");
	assert.equal(now, "fake/echo-1");
	assert.match(choose, /^choose: (\S+\/\S+ )*fake\/echo-1( \S+\/\S+)*$/, "the models pi lists, on one line");
	const th = await pilot(["thinking"]);
	assert.match(th.stdout, /^not set: /);
	assert.match(th.stdout, /\nchoose: off minimal low medium high xhigh max\n$/);
	assert.match((await t.cli("thinking", "main")).stdout, /^not set: [^\n]*\n$/, "at the machine, no such line");
	const h = await pilot(["help"]);
	assert.equal(h.code, 0);
	for (const w of ["interrupt", "answer <id> <text...>", "new", "model [provider/id]", "thinking [level]", "status", "restart", "login <provider>", "secret set <name>", "kit <words...>", "help"]) assert.ok(h.stdout.includes(`  ${w} `), w);
});

test("what a channel is told names no command to type at the machine", async () => {
	const hints = /\bpp (start|restart|model|thinking|models|log|follow|status)\b/;
	for (const words of [["status"], ["model"], ["thinking"], ["model", "nowhere/x"]]) {
		const r = await pilot(words);
		assert.doesNotMatch(r.stdout + r.stderr, hints, words.join(" "));
	}
	assert.match((await pilot(["thinking"])).stdout, /^not set: pi keeps the level the conversation last used$/m);
	// Stopped, the channel is too: its owner's request is run as a channel runs it.
	assert.equal((await t.cli("stop", "main")).code, 0);
	try {
		const stopped = await t.cli("remote", "main", "--", "interrupt");
		assert.equal(stopped.code, 1);
		assert.match(stopped.stderr, /main is not running: nothing was sent$/m);
		const restart = await t.cli("remote", "main", "--", "restart");
		assert.match(restart.stdout, /^main is stopped: restarted from its next start$/m);
		for (const r of [stopped, restart]) assert.doesNotMatch(r.stdout + r.stderr, hints);
		// Typed at the machine, the same words keep their next step.
		assert.match((await t.cli("interrupt", "main")).stderr, /To start it: pp start main/);
	} finally {
		assert.equal((await t.cli("start", "main")).code, 0);
	}
});

test("a command that is not on the list is refused with the list, and nothing is done", async () => {
	const pending = port.pending(P()).length;
	for (const words of [["stop"], ["channel", "add", "x"], ["secret", "get", "mail-password"], ["--home", "/x", "status"], []]) {
		const r = await pilot(words);
		assert.equal(r.code, 2, words.join(" "));
		assert.match(r.stderr, /is not a command here\.\npp remote <agent> -- <command>:\n {2}interrupt/);
	}
	assert.equal(port.pending(P()).length, pending);
	// Typed at the machine, "--" is required: the words after the agent are never read as options.
	const r = await t.cli("remote", "main", "status");
	assert.equal(r.code, 2);
	assert.match(r.stderr, /usage: pp remote <agent> -- <command>/);
});

test("restart, model, thinking and new restart the agent's terminal only; the channel keeps running", async () => {
	const pid = fs.readFileSync(path.join(state(), "pid"), "utf8");
	const restarted = await pilot(["restart"]);
	assert.equal(restarted.code, 0, restarted.stderr);
	assert.equal(restarted.stdout.trim(), "main: restarted; pi is ready");
	assert.ok(port.events(P()).events.some((e) => e.type === "restarted" && !e.channel && e.reason === "restarted by its owner from a channel"));
	const m = await pilot(["model", "fake/echo-1"]);
	assert.equal(m.stdout.trim(), "main: it runs with fake/echo-1; pi is ready", m.stderr);
	const th = await pilot(["thinking", "high"]);
	assert.equal(th.stdout.trim(), "main: it thinks at high; pi is ready", th.stderr);
	assert.equal(JSON.parse(fs.readFileSync(path.join(folder(), "pi-personal.json"), "utf8")).thinking, "high");
	const wrong = await pilot(["thinking", "loud"]);
	assert.equal(wrong.code, 2);
	assert.match(wrong.stderr, /"loud" is not a thinking level/);
	const session = fs.readFileSync(path.join(t.home, "agents", "main", "session"), "utf8");
	const fresh = await pilot(["new"]);
	assert.equal(fresh.stdout.trim(), "main: a new conversation; pi is ready", fresh.stderr);
	assert.notEqual(fs.readFileSync(path.join(t.home, "agents", "main", "session"), "utf8"), session);
	assert.equal(fs.readFileSync(path.join(state(), "pid"), "utf8"), pid, "the channel was never restarted");
	const ok = await t.cli("send", "main", "still there?", "--wait", "--timeout", "60");
	assert.match(ok.stdout, /echo: still there\?/);
});

test("kit: without a kit, it says none is installed; with one, pp kit and remote run it with the agent's environment", async () => {
	const none = await pilot(["kit", "install", "voice"]);
	assert.equal(none.code, 1);
	assert.match(none.stdout, /^no kit is installed with this Pi-Personal \(.*kit\/kit\.ts is missing\)$/m);
	// An installation with a kit: the same core, beside a kit folder.
	const inst = path.join(t.dir, "inst");
	fs.mkdirSync(path.join(inst, "kit"), { recursive: true });
	fs.cpSync(path.join(ROOT, "core"), path.join(inst, "core"), { recursive: true });
	fs.copyFileSync(path.join(ROOT, "package.json"), path.join(inst, "package.json"));
	for (const d of ["node_modules", "channels", "docs"]) fs.symlinkSync(path.join(ROOT, d), path.join(inst, d));
	fs.writeFileSync(
		path.join(inst, "kit", "kit.ts"),
		`const e = process.env;\nconsole.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), agent: e.PI_PERSONAL_AGENT, port: e.PI_PERSONAL_PORT, secrets: e.PI_PERSONAL_SECRETS, state: e.PI_PERSONAL_STATE, folder: e.PI_PERSONAL_FOLDER, remote: JSON.parse(e.PI_PERSONAL_REMOTE ?? "null") }));\n`,
	);
	const cli = path.join(inst, "core", "cli.ts");
	const want = {
		cwd: fs.realpathSync(folder()),
		agent: "main",
		port: P(),
		secrets: path.join(t.home, "agents", "main", "secrets"),
		state: path.join(t.home, "agents", "main", "extensions"),
		folder: folder(),
		// The core finds itself by its real path: on macOS /tmp is a link to /private/tmp.
		remote: [process.execPath, fs.realpathSync(cli), "--home", t.home, "remote", "main", "--"],
	};
	const direct = await run(process.execPath, [cli, "kit", "main", "install", "voice", "--force"], { env: t.env });
	assert.deepEqual(JSON.parse(direct.stdout), { args: ["install", "voice", "--force"], ...want });
	const remote = await run(process.execPath, [cli, "--home", t.home, "remote", "main", "--", "kit", "list", "--json"], { env: t.env });
	assert.deepEqual(JSON.parse(remote.stdout), { args: ["list", "--json"], ...want });
});
