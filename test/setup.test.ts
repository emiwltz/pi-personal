// `pp setup` and `pp` alone, answered through standard input (no terminal): the machine is checked, the provider
// already connected is kept, a first agent is created with pi's model list, started, and says hello.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { type Env, ROOT, setup } from "./helpers.ts";

let t: Env;
before(async () => {
	t = await setup("setup");
	// A home folder of its own: the agent's folder goes in ~/pi-personal, and the user's own pi is looked for in ~/.pi.
	t.env.HOME = path.join(t.dir, "userhome");
	fs.mkdirSync(t.env.HOME, { recursive: true });
});
after(async () => t?.close());

/** Run the command line with these lines as the answers to its questions. */
function answered(args: string[], answers: string[], env: NodeJS.ProcessEnv = t.env): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [path.join(ROOT, "core", "cli.ts"), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.stdin.end(answers.map((a) => `${a}\n`).join(""));
		const timer = setTimeout(() => p.kill("SIGKILL"), 240_000);
		p.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, out });
		});
	});
}

test("pp alone, before anything: says where to start", async () => {
	const r = await t.cli();
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /Nothing is set up yet/);
	assert.match(r.stdout, /Start here: +pp setup/);
});

test("pp setup: keeps the connected provider, creates main with pi's model, starts it, and it says hello", async () => {
	// Answers: no other provider · the first model · the name "main" · no Telegram · no login service.
	const r = await answered(["setup"], ["", "", "", "", "n"]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /1\/5 {2}This machine[\s\S]*Herdr Core \d+\.\d+\.\d+, running/);
	assert.match(r.out, /connected: fake/);
	assert.match(r.out, /fake\/echo-1/);
	assert.match(r.out, /main created in/);
	assert.match(r.out, /main › echo: Say hello/);
	assert.match(r.out, /Talk to it: +pp chat/);
	assert.ok(fs.existsSync(path.join(t.dir, "home", "agents", "main")), "the agent's record is in the private area");
	assert.equal(JSON.parse(fs.readFileSync(path.join(t.env.HOME ?? "", "pi-personal", "main", "pi-personal.json"), "utf8")).model, "fake/echo-1");
});

test("pp setup again: everything is kept, nothing is asked twice but the optional steps", async () => {
	const r = await answered(["setup"], ["", "", "n"]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /✔ main {2}fake\/echo-1/);
	assert.doesNotMatch(r.out, /Name your agent/);
});

test("pp alone, with an agent: how it is, and what to do next", async () => {
	const r = await t.cli();
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /main {2}(idle|working)/);
	assert.match(r.stdout, /Talk to it: +pp chat/);
	assert.match(r.stdout, /Watch it work: pp attach/);
});

test("with one agent, commands need no name", async () => {
	const s = await t.cli("send", "no name needed", "--wait");
	assert.equal(s.code, 0, s.stderr);
	assert.match(s.stdout, /echo: no name needed/);
	const st = await t.cli("status");
	assert.match(st.stdout, /^main /m);
});
