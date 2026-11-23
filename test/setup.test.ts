// `pp setup` and `pp` alone, answered through standard input (no terminal): the machine is checked, the provider pi
// is already connected to is kept (pi's own screen is not opened), a first agent is created with pi's model, started,
// and says hello; and, at a terminal, the menu of what can be changed once everything is set up.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as port from "../core/port.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

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
	// Answers: keep pi's connection (its one model is taken) · the name "main" · Telegram later · no login service.
	const r = await answered(["setup"], ["", "", "", "n"]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /◆ {2}This machine {2}1\/5[\s\S]*Herdr Core \d+\.\d+\.\d+ found[\s\S]*◇ {2}Herdr Core \d+\.\d+\.\d+, running/);
	assert.match(r.out, /◆ {2}A model {2}2\/5[\s\S]*│ +✔ pi is connected: fake[\s\S]*◇ {2}fake · echo-1/);
	assert.match(r.out, /no sandbox/, "the rule of the game is said before the agent runs");
	assert.match(r.out, /main is alive\./);
	assert.match(r.out, /◆ {2}Reach it {2}4\/5[\s\S]*Talk to main from Telegram\?[\s\S]*◆ {2}Stay alive {2}5\/5/);
	assert.match(r.out, /main created in \S+, with fake\/echo-1/);
	assert.match(r.out, /main › echo: Hello! I have just set you up/);
	assert.match(t.model.requests.find((q) => /just set you up/.test(q.raw))!.raw, /^From: the owner, "[^"\n]+" \(pp chat\) · cli\nSent: /, "the hello is the owner's, as pp chat is");
	assert.match(r.out, /Open it: +pp /);
	assert.doesNotMatch(r.out, /pp chat/, "pp, then Enter: the one way to talk to it");
	assert.ok(fs.existsSync(path.join(t.dir, "home", "agents", "main")), "the agent's record is in the private area");
	assert.equal(JSON.parse(fs.readFileSync(path.join(t.env.HOME ?? "", "pi-personal", "main", "pi-personal.json"), "utf8")).model, "fake/echo-1");
});

test("pp setup again: everything is kept, nothing is asked twice but the optional steps", async () => {
	const r = await answered(["setup"], ["", "n"]); // Telegram later · no login service
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /✔ main {2}fake\/echo-1/);
	assert.doesNotMatch(r.out, /Name your agent/);
});

test("pp alone, with an agent: how it is, and what to do next", async () => {
	const r = await t.cli();
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /main {2}(idle|working)/);
	assert.match(r.stdout, /Open it: +pp attach/);
});

test("with one agent, commands need no name", async () => {
	const s = await t.cli("send", "no name needed", "--wait");
	assert.equal(s.code, 0, s.stderr);
	assert.match(s.stdout, /echo: no name needed/);
	const st = await t.cli("status");
	assert.match(st.stdout, /^main /m);
});

test("pp setup with no provider connected, outside a terminal: says so and how to do it later, and ends", async () => {
	const bare = path.join(t.dir, "bare-home");
	fs.mkdirSync(bare, { recursive: true, mode: 0o700 });
	const r = await answered(["setup"], [], { ...t.env, PI_PERSONAL_HOME: bare });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /This step needs a terminal\. Later: pp setup, or pp login <provider> --api-key/);
	assert.match(r.out, /No provider connected\. Later: pp setup/);
	assert.match(r.out, /◇ {2}no model yet/);
	assert.doesNotMatch(r.out, /Name your agent/);
});

test("pp setup's menu, at a terminal: a new model restarts the agent's terminal with it, as pp model does", async () => {
	const file = path.join(t.home, "pi", "models.json");
	const conf = JSON.parse(fs.readFileSync(file, "utf8"));
	conf.providers.fake.models.push({ id: "echo-2", name: "Fake 2", contextWindow: 32000, maxTokens: 2000 }); // one more to choose
	fs.writeFileSync(file, JSON.stringify(conf));
	const from = port.end(t.portOf("main"));
	const term = t.hc("run", "--bg", "--no-parent", "--no-notify", "--cwd", t.env.HOME!, "--", "env", `HOME=${t.env.HOME}`, process.execPath, path.join(ROOT, "core", "cli.ts"), "setup");
	const shown = () => execFileSync("hc", ["read", term.address, "--lines", "300"], { env: t.env, encoding: "utf8" });
	const until = async (re: RegExp) => {
		for (const end = Date.now() + 90_000; !re.test(shown()); await sleep(200)) if (Date.now() > end) throw new Error(`timed out waiting for ${re}; the screen:\n${shown()}`);
	};
	const keys = async (...k: string[]) => {
		for (const x of k) t.hc("keys", term.address, x);
		await sleep(300);
	};
	try {
		await until(/What would you like to change\?/);
		await keys("down", "enter"); // its model
		await until(/Use it\?/);
		await keys("enter"); // the provider connected
		await until(/Use this model\?/);
		await keys("down", "enter"); // another one
		await until(/Which model\?[\s\S]*fake\/echo-2/);
		const list = shown().slice(shown().lastIndexOf("Which model?"));
		await keys(...(list.indexOf("fake/echo-2") > list.indexOf("fake/echo-1") ? ["down"] : []), "enter");
		await until(/main runs with fake\/echo-2/);
	} finally {
		t.hc("kill", term.address);
	}
	assert.equal(JSON.parse(fs.readFileSync(path.join(t.env.HOME ?? "", "pi-personal", "main", "pi-personal.json"), "utf8")).model, "fake/echo-2");
	assert.ok(port.events(t.portOf("main"), from).events.some((e) => e.type === "restarted" && e.reason === "model set to fake/echo-2"), "the agent's terminal restarted to apply it");
	const r = await t.cli("send", "main", "which model now?", "--wait", "--timeout", "60");
	assert.equal(r.stdout.trim(), "echo: which model now?", r.stderr);
	assert.equal(t.model.requests.at(-1)!.model, "echo-2");
});
