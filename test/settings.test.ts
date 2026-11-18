// Settings and the private area: a broken pi-personal.json never blocks stop, send, status or Telegram; uninstall --purge
// refuses what it must not delete; an agent whose folder has gone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as port from "../core/port.ts";
import { type FakeTelegram, fakeTelegram } from "./fake-telegram.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

const run = promisify(execFile);
const CLI = path.join(ROOT, "core", "cli.ts");
let t: Env;
let tg: FakeTelegram;
const folder = (n = "main") => path.join(t.dir, "agents", n);
const P = (n = "main") => t.portOf(n);
const settingsFile = (n = "main") => path.join(folder(n), "pi-personal.json");
const GUESTS = () => path.join(t.home, "agents", "main", "channels", "telegram", "allow.json");
const ANN = 1001;
const ann = (text: string) => tg.push({ from: { id: ANN, first_name: "Ann" }, chat: { id: ANN, type: "private" }, text });
const until = async (pred: () => boolean, ms = 30_000, what = "condition") => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
};
const sentTexts = () => tg.sent.map((s) => s.text);
let good = "";

before(async () => {
	t = await setup("fset");
	tg = await fakeTelegram();
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	good = JSON.stringify({ ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")), channels: { telegram: { apiBase: tg.base } } }, null, 2);
	fs.writeFileSync(settingsFile(), good);
	execFileSync(process.execPath, [CLI, "secret", "set", "main", "telegram-token"], { env: t.env, input: `${tg.token}\n` });
	fs.mkdirSync(path.dirname(GUESTS()), { recursive: true });
	fs.writeFileSync(GUESTS(), JSON.stringify({ allow: [String(ANN)] }));
	assert.equal((await t.cli("start", "main")).code, 0);
	await until(() => tg.polls.length > 0, 30_000, "the channel polls");
});
after(async () => {
	tg?.close();
	await t?.close();
});

// ---- a broken pi-personal.json --------------------------------------------------------------------------------------------------------

test("with a broken pi-personal.json, status, send, port, log and stop still work", async () => {
	fs.writeFileSync(settingsFile(), `${good.slice(0, -3)}\n`); // a brace is missing: the owner is mid-edit
	try {
		const port1 = await t.cli("port", "main");
		assert.equal(port1.code, 0, port1.stderr);
		assert.equal(port1.stdout.trim(), P());
		const log = await t.cli("log", "main");
		assert.equal(log.code, 0, log.stderr);
		const st = await t.cli("status", "main");
		assert.ok(!/not valid JSON/.test(st.stderr), `status must not die on the settings: ${st.stderr}`);
		const from = port.end(P());
		const send = await t.cli("send", "main", "typo-send", "--id", "typo-1");
		assert.equal(send.code, 0, `send blocked: ${send.stderr}`);
		await t.waitEvent("main", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("typo-1"), 40_000);
	} finally {
		fs.writeFileSync(settingsFile(), good);
	}
});

test("stop works with a broken pi-personal.json (and says nothing about the typo)", async () => {
	// A separate agent, so that main keeps running for the Telegram tests.
	assert.equal((await t.cli("init", "spare", folder("spare"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "spare")).code, 0);
	fs.writeFileSync(settingsFile("spare"), "{ \"model\": ");
	const s = await t.cli("stop", "spare");
	assert.equal(s.code, 0, `stop blocked: ${s.stderr}`);
	assert.match(s.stdout, /stopped agent/);
	assert.deepEqual(
		t.hc("ls").terminals.filter((x: any) => x.labels?.["pi-personal.agent"] === "spare"),
		[],
		"no terminal of spare is left",
	);
});

test("uninstall (not --purge) stops an agent whose pi-personal.json is broken", async () => {
	// A private home of its own, with its own agent, in the same isolated core: main is not touched.
	const home = path.join(t.dir, "home2");
	const userHome = path.join(t.dir, "uhome");
	fs.mkdirSync(userHome);
	const fake = path.join(t.dir, "svc");
	fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const env = { ...t.env, PI_PERSONAL_HOME: home, HOME: userHome, PI_PERSONAL_SYSTEMCTL: fake, PI_PERSONAL_LAUNCHCTL: fake };
	const p = async (...a: string[]) => run(process.execPath, [CLI, ...a], { env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: String(e.stdout), stderr: String(e.stderr) }));
	fs.mkdirSync(path.join(home, "pi"), { recursive: true });
	fs.copyFileSync(path.join(t.home, "pi", "models.json"), path.join(home, "pi", "models.json"));
	const f = path.join(t.dir, "u-agent");
	assert.equal((await p("init", "u", f, "--model", "fake/echo-1")).code, 0);
	assert.equal((await p("start", "u")).code, 0);
	const mine = () => t.hc("ls").terminals.filter((x: any) => x.name === "pi-personal-u");
	assert.equal(mine().length, 1, "u runs");
	fs.writeFileSync(path.join(f, "pi-personal.json"), "{ nope");
	const r = await p("uninstall");
	assert.equal(r.code, 0, `uninstall blocked: ${r.stderr}`);
	assert.match(r.stdout, /stopped u/);
	assert.doesNotMatch(r.stdout, /could not stop/);
	assert.equal(mine().length, 0, "u was really stopped");
	assert.ok(fs.existsSync(path.join(f, "pi-personal.json")), "the visible folder is untouched");
});

test("Telegram: an update written while pi-personal.json is broken is not lost", async () => {
	const before = tg.sent.length;
	fs.writeFileSync(settingsFile(), `${good.slice(0, -3)}\n`);
	const id = ann("important: call the plumber at 5");
	try {
		await until(() => sentTexts().slice(before).some((x) => x.includes("call the plumber")), 40_000, "the answer to the update written during the typo");
	} finally {
		fs.writeFileSync(settingsFile(), good);
	}
	// Telegram has been told it is confirmed only because the message really reached the port.
	await until(() => tg.polls.at(-1)!.offset > id, 15_000, "the update to be confirmed");
	const events = port.events(P()).events;
	assert.ok(events.some((e) => e.type === "message" && JSON.stringify(e).includes("call the plumber")), "the agent answered it in the port");
});

test("Telegram: an unreadable guest list confirms nothing and sends nothing; the update arrives once it is readable", async () => {
	const before = tg.sent.length;
	const saved = fs.readFileSync(GUESTS(), "utf8");
	fs.writeFileSync(GUESTS(), "{ not json");
	const id = ann("hello while the list is broken");
	await sleep(7000); // more than one poll and the channel's own wait
	try {
		assert.equal(tg.sent.length, before, "nothing is sent while the guest list is unreadable");
		assert.ok(
			tg.polls.slice(-3).every((p) => p.offset <= id),
			`the update ${id} must not be confirmed; last offsets ${JSON.stringify(tg.polls.slice(-3))}`,
		);
		assert.ok(!fs.existsSync(path.join(P(), "inbox", `tg-${id}.json`)), "and it is not in the inbox either");
	} finally {
		fs.writeFileSync(GUESTS(), saved);
	}
	await until(() => sentTexts().slice(before).some((x) => x.includes("hello while the list is broken")), 40_000, "the answer once the list is fixed");
	// Exactly one answer: the update was fetched again, not duplicated.
	assert.equal(sentTexts().slice(before).filter((x) => x.includes("hello while the list is broken")).length, 1);
});

test("Telegram: an answer only goes to a chat that is on the guest list", async () => {
	const before = tg.sent.length;
	// A stranger writes: recorded as a stranger, never answered.
	tg.push({ from: { id: 9999, first_name: "Eve" }, chat: { id: 9999, type: "private" }, text: "let me in" });
	await sleep(4000);
	assert.ok(!tg.sent.slice(before).some((s) => s.chat === "9999"), "the stranger gets nothing");
});

// ---- uninstall --purge --------------------------------------------------------------------------------------------------------

/** Another private home inside the test folder, with a scratch HOME and a fake service manager. */
function purgeLab(name: string) {
	const userHome = path.join(t.dir, `uh-${name}`);
	fs.mkdirSync(userHome, { recursive: true });
	const fake = path.join(t.dir, "svc");
	fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const home = path.join(userHome, "pi-personal"); // the same name as the default folder of agents: the original trap
	const env = { ...t.env, HOME: userHome, PI_PERSONAL_HOME: home, PI_PERSONAL_SYSTEMCTL: fake, PI_PERSONAL_LAUNCHCTL: fake };
	// The fake model's provider, so that init's model check knows fake/echo-1 in this private area too.
	fs.mkdirSync(path.join(home, "pi"), { recursive: true });
	fs.copyFileSync(path.join(t.home, "pi", "models.json"), path.join(home, "pi", "models.json"));
	const p = async (...a: string[]) => run(process.execPath, [CLI, ...a], { env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: String(e.stdout), stderr: String(e.stderr) }));
	return { userHome, home, p };
}

test("init refuses to put an agent's folder inside the private area (PI_PERSONAL_HOME=~/pi-personal, default folder)", async () => {
	const l = purgeLab("trap");
	const r = await l.p("init", "diary", "--model", "fake/echo-1"); // the default folder is ~/pi-personal/diary
	assert.notEqual(r.code, 0, "init must refuse");
	assert.match(r.stderr, /private area/);
	assert.ok(!fs.existsSync(path.join(l.home, "diary", "AGENTS.md")), "no instructions were written inside the private area");
});

test("uninstall --purge refuses when an agent's folder sits inside the private area, and changes nothing", async () => {
	const l = purgeLab("inside");
	// An old record (made before init refused it) that points inside the private area.
	const diary = path.join(l.home, "diary");
	fs.mkdirSync(diary, { recursive: true });
	fs.writeFileSync(path.join(diary, "AGENTS.md"), "# diary\n\nMonths of careful instructions.\n");
	fs.mkdirSync(path.join(l.home, "agents", "diary"), { recursive: true });
	fs.writeFileSync(path.join(l.home, "agents", "diary", "agent.json"), JSON.stringify({ folder: diary }));
	const recordFiles = fs.readdirSync(path.join(l.home, "agents", "diary"));
	const r = await l.p("uninstall", "--purge");
	assert.notEqual(r.code, 0, `purge must refuse: ${r.stdout}`);
	assert.match(r.stderr, /inside it|not deleting/);
	assert.ok(fs.existsSync(path.join(diary, "AGENTS.md")), "the visible folder survives");
	assert.deepEqual(fs.readdirSync(path.join(l.home, "agents", "diary")), recordFiles, "nothing was changed");
});

test("uninstall --purge refuses a private area that holds the home folder, or is not Pi-Personal's", async () => {
	const l = purgeLab("notmine");
	// PI_PERSONAL_HOME = HOME itself.
	fs.writeFileSync(path.join(l.userHome, "precious.txt"), "do not delete");
	const env = { ...t.env, HOME: l.userHome, PI_PERSONAL_HOME: l.userHome };
	const same = await run(process.execPath, [CLI, "uninstall", "--purge"], { env }).then(() => 0, (e) => e.code as number);
	assert.notEqual(same, 0);
	assert.ok(fs.existsSync(path.join(l.userHome, "precious.txt")));
	// A folder that is not Pi-Personal's (no agents/, no pi/).
	const other = path.join(l.userHome, "docs");
	fs.mkdirSync(other);
	fs.writeFileSync(path.join(other, "thesis.txt"), "years of work");
	const r2 = await run(process.execPath, [CLI, "uninstall", "--purge"], { env: { ...env, PI_PERSONAL_HOME: other } }).then(() => 0, (e) => e.code as number);
	assert.notEqual(r2, 0);
	assert.ok(fs.existsSync(path.join(other, "thesis.txt")));
});

test("init refuses a folder already used by another agent, and one that contains the private area", async () => {
	const l = purgeLab("shared");
	const shared = path.join(l.userHome, "shared-folder");
	assert.equal((await l.p("init", "one", shared, "--model", "fake/echo-1")).code, 0);
	const two = await l.p("init", "two", shared, "--model", "fake/echo-1");
	assert.notEqual(two.code, 0);
	assert.match(two.stderr, /already the folder of the agent "one"/);
	const up = await l.p("init", "three", l.userHome, "--model", "fake/echo-1"); // the private area is inside this folder
	assert.notEqual(up.code, 0);
	assert.match(up.stderr, /private area/);
	// And a purge of a sound area works: only the private area goes, the agent's visible folder stays.
	const r = await l.p("uninstall", "--purge");
	assert.equal(r.code, 0, r.stderr);
	assert.ok(!fs.existsSync(l.home));
	assert.ok(fs.existsSync(path.join(shared, "AGENTS.md")), "the visible folder is untouched");
});

// ---- an agent whose folder has gone -------------------------------------------------------------------------------------------------------

test("an agent whose folder is gone says so clearly: start, status and doctor name the missing folder; stop works", async () => {
	assert.equal((await t.cli("init", "gone", folder("gone"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "gone")).code, 0);
	const started = [...port.events(P("gone")).events].reverse().find((e) => e.type === "started" && !e.channel)!;
	const from = port.end(P("gone"));
	fs.rmSync(folder("gone"), { recursive: true });
	// A send to an agent whose folder is gone still reaches the port (the inbox is in the private area).
	const send = await t.cli("send", "gone", "is your home gone", "--id", "gone-1");
	assert.equal(send.code, 0, send.stderr);
	process.kill(Number(started.pid), "SIGKILL"); // the pid comes from the bridge's own started event
	const failed = await t.waitEvent("gone", from, (e) => e.type === "failed", 60_000);
	assert.match(String(failed.reason), /folder .* is missing/);
	const st = await t.cli("status", "gone");
	assert.match(st.stdout + st.stderr, /FAILED|failed/);
	assert.match(st.stdout + st.stderr, /is missing/);
	const doctor = await t.cli("doctor");
	assert.match(doctor.stdout, /is missing/);
	const s = await t.cli("stop", "gone");
	assert.equal(s.code, 0, s.stderr);
	// Restoring the folder and starting again works, with the conversation intact.
	fs.mkdirSync(folder("gone"));
	fs.writeFileSync(path.join(folder("gone"), "pi-personal.json"), JSON.stringify({ model: "fake/echo-1" }));
	fs.writeFileSync(path.join(folder("gone"), "AGENTS.md"), "# gone\n");
	const again = await t.cli("start", "gone");
	assert.equal(again.code, 0, again.stdout + again.stderr);
	await t.waitEvent("gone", from, (e) => e.type === "settled" && JSON.stringify(e.refs).includes("gone-1"), 60_000);
});

test("start of an agent whose folder was deleted while stopped reports the missing folder instead of hanging", async () => {
	assert.equal((await t.cli("init", "gone2", folder("gone2"), "--model", "fake/echo-1")).code, 0);
	fs.rmSync(folder("gone2"), { recursive: true });
	const t0 = Date.now();
	const r = await t.cli("start", "gone2");
	assert.ok(Date.now() - t0 < 60_000);
	assert.match(r.stdout + r.stderr, /missing|No such file|cannot|ENOENT/i);
	await t.cli("stop", "gone2");
});
