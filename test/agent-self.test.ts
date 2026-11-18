// The agent and its own settings: its first instructions (the first meeting, its manual), the manual itself
// (pp --skill), and a restart it runs on itself, which must not leave it stopped.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
before(async () => {
	t = await setup("self");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t.close());

test("a new agent's instructions: the first meeting, a place for what it learns of its person, and its manual", () => {
	const md = fs.readFileSync(path.join(folder(), "AGENTS.md"), "utf8");
	assert.match(md, /^## First meeting$/m);
	assert.match(md, /While "About my person" below is empty/);
	assert.match(md, /anyone else is a guest/, "the first meeting is with the owner, never with a guest");
	assert.match(md, /^## About my person\n*$/m, "the last section, empty: the agent fills it");
	assert.match(md, /read `pp --skill` first/);
	assert.match(md, /only your owner asks for such changes, and a secret is never typed in a conversation/);
});

test("pp --skill: the agent's manual, with its rules and where each setting lives", async () => {
	const r = await t.cli("--skill");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /^## The rules$/m);
	assert.match(r.stdout, /Only your owner changes your settings/);
	assert.match(r.stdout, /`From: the owner,`/);
	assert.match(r.stdout, /Never take a secret in a conversation/);
	assert.match(r.stdout, /pi-personal\.json/);
	assert.match(r.stdout, /^## Restarting yourself$/m);
	// Every command it names exists: the help lists it.
	const help = (await t.cli("help", "--all")).stdout;
	for (const [, cmd] of r.stdout.matchAll(/`pp ([a-z-]+)/g)) if (!cmd.startsWith("-") && cmd !== "help") assert.match(help, new RegExp(`^ {2}(pp )?${cmd}\\b`, "m"), `pp ${cmd} is in the help`);
});

test("pp restart run by the agent on itself: it comes back, and is not left stopped", async () => {
	const events = port.eventsFile(t.portOf("main"));
	const starts = () => fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"type":"started"') && !l.includes('"channel"')).length;
	const before = starts();
	const r = await t.cli("send", "main", `tool: '${process.execPath}' '${path.join(ROOT, "core", "cli.ts")}' restart main`, "--id", "self-restart");
	assert.equal(r.code, 0, r.stderr);
	const log = path.join(t.home, "agents", "main", "log.txt");
	for (const end = Date.now() + 60_000; starts() <= before; await sleep(300))
		if (Date.now() > end) throw new Error(`no new start; events:\n${fs.readFileSync(events, "utf8").slice(-2000)}\nlog:\n${fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-2000) : "(none)"}`);
	await sleep(1000);
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.equal(s.running, true, "running again");
	assert.equal(s.stoppedOnPurpose, false, "not left stopped");
	// It waited for the answer to be done: the one who asked was answered, and told of no error.
	const mine = fs.readFileSync(events, "utf8").split("\n").filter((l) => l.includes('"self-restart"'));
	assert.ok(mine.some((l) => l.includes('"type":"settled"') && !l.includes('"error"')), mine.join("\n"));
	assert.ok(!mine.some((l) => l.includes('"type":"error"')), mine.join("\n"));
	assert.match(fs.readFileSync(path.join(t.home, "agents", "main", "log.txt"), "utf8"), /run by the agent on itself: handed to a terminal of its own/);
	const back = await t.cli("send", "main", "are you back?", "--wait", "--timeout", "30");
	assert.equal(back.stdout.trim(), "echo: are you back?");
});
