// `pp` alone in a terminal, and the agent's own screen: Enter opens it, ctrl+\ comes back, and nothing typed there by
// habit (Ctrl+C twice, Ctrl+D) quits the agent.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

let t: Env;
before(async () => {
	t = await setup("home");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t.close());

const started = (agent: string) => fs.readFileSync(port.eventsFile(t.portOf(agent)), "utf8").split("\n").filter((l) => l.includes('"type":"started"') && !l.includes('"channel"')).length;

test("in the agent's screen, Ctrl+C twice and Ctrl+D do not quit pi; the screen says how to leave", async () => {
	const keys = JSON.parse(fs.readFileSync(path.join(t.home, "pi", "keybindings.json"), "utf8"));
	assert.deepEqual(keys, { "app.clear": [], "app.exit": [], "app.suspend": [] });
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	const pid = t.hc("get", s.address).pid;
	const before = started("main");
	for (const k of ["ctrl+c", "ctrl+c", "ctrl+d", "ctrl+z"]) {
		t.hc("keys", s.address, k);
		await sleep(300);
	}
	await sleep(2500);
	assert.equal(started("main"), before, "pi did not quit and start again");
	assert.equal(t.hc("get", s.address).pid, pid);
	assert.equal(JSON.parse((await t.cli("status", "main", "--json")).stdout).running, true);
	const r = await t.cli("send", "main", "still here", "--wait", "--timeout", "30");
	assert.equal(r.stdout.trim(), "echo: still here");
	const { execFileSync } = await import("node:child_process");
	const shown = execFileSync("hc", ["read", s.address], { env: t.env, encoding: "utf8" });
	assert.match(shown, /ctrl\+\\ leaves this screen · the agent keeps running/);
});

test("pi's shared key settings are written once; a person's file, or one pi cannot read, is left as it is", async () => {
	const file = path.join(t.home, "pi", "keybindings.json");
	fs.writeFileSync(file, JSON.stringify({ "app.exit": ["ctrl+q"], "app.session.new": "ctrl+shift+n" }));
	const { ensurePiDir } = await import("../core/agents.ts");
	const was = process.env.PI_PERSONAL_HOME;
	process.env.PI_PERSONAL_HOME = t.home;
	try {
		ensurePiDir();
	} finally {
		process.env.PI_PERSONAL_HOME = was;
	}
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { "app.exit": ["ctrl+q"], "app.session.new": "ctrl+shift+n" }, "once there, the file is the person's: nothing added back");
	// A file pi cannot read is the person's to fix: left exactly as it is.
	fs.writeFileSync(file, '{ "app.exit": [ "ctrl+q", }');
	process.env.PI_PERSONAL_HOME = t.home;
	try {
		ensurePiDir();
	} finally {
		process.env.PI_PERSONAL_HOME = was;
	}
	assert.equal(fs.readFileSync(file, "utf8"), '{ "app.exit": [ "ctrl+q", }');
	fs.writeFileSync(file, JSON.stringify({ "app.clear": [], "app.exit": [], "app.suspend": [] }));
});

test("pp in a terminal: the agent and a menu of what can be done; Enter opens its screen, ctrl+\\ comes back, s shows its status, Escape leaves", { skip: process.platform !== "linux" && "script(1) is driven this way on Linux" }, async () => {
	const term = spawn("script", ["-qfec", `stty cols 90 rows 30; '${process.execPath}' '${path.join(ROOT, "core", "cli.ts")}'`, "/dev/null"], { env: t.env, stdio: ["pipe", "pipe", "pipe"] });
	let screen = "";
	term.stdout!.on("data", (d) => (screen += d.toString()));
	const see = async (re: RegExp, from = 0, ms = 30_000) => {
		for (const end = Date.now() + ms; !re.test(screen.slice(from)); await sleep(100)) if (Date.now() > end) throw new Error(`not seen: ${re}\n--- screen ---\n${screen.slice(from)}`);
	};
	const exited = new Promise<number | null>((r) => term.on("exit", r));
	try {
		await see(/main/);
		await see(/Open main/);
		await see(/Check everything/);
		assert.match(screen, /fake\/echo-1/);
		assert.doesNotMatch(screen, /Talk to it/, "the screen, not the text for scripts");
		let mark = screen.length;
		term.stdin!.write("\r");
		await see(/ctrl\+\\ leaves this screen/, mark); // pi's own screen, with its line at the bottom
		mark = screen.length;
		term.stdin!.write("\x1c"); // ctrl+\
		await see(/Open main/, mark);
		mark = screen.length;
		term.stdin!.write("s");
		await see(/any key/, mark);
		assert.match(screen.slice(mark), /main/);
		mark = screen.length;
		term.stdin!.write("x");
		await see(/Open main/, mark);
		term.stdin!.write("\x1b"); // Escape alone leaves, as q does
		assert.equal(await Promise.race([exited, sleep(10_000).then(() => "still running")]), 0);
		assert.match(screen, /\x1b\[\?1049l[^]*$/, "the normal screen is given back");
		assert.equal(JSON.parse((await t.cli("status", "main", "--json")).stdout).running, true, "leaving pp leaves the agent running");
	} finally {
		term.kill();
	}
});

test("the home screen as text: what Enter does in each case, and no line wider than the terminal", async () => {
	const { picture } = await import("../core/home.ts");
	const screen = await import("../core/screen.ts");
	const st = (o: object) => ({ running: true, state: "idle", name: "main", folder: "/x", model: "fake/echo-1", stoppedOnPurpose: false, safeMode: null, pending: 0, channels: [], ...o });
	const one = (o: object) => ({ up: true, rows: [{ name: "main", s: st(o) }] });
	const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	for (const l of [screen.look({ COLORTERM: "truecolor", PI_PERSONAL_THEME: "dark" }, { isTTY: true }), screen.look({}, { isTTY: false })])
		for (const columns of [100, 60, 40]) {
			const cases: [object, number, RegExp][] = [
				[one({}), 0, /› Open main {2,}o[\s\S]*Status[\s\S]*Model and thinking[\s\S]*Check everything[\s\S]*Update Pi-Personal[\s\S]*Quit/],
				[one({ state: "blocked", question: "May I?" }), 0, /waiting for you[\s\S]*May I\?[\s\S]*› Answer main/],
				[one({ running: false, stoppedOnPurpose: true, state: "stopped" }), 0, /stopped[\s\S]*› Start main/],
				[one({ running: false, failed: { at: "", reason: "refused (401)", retryAt: "" } }), 0, /cannot start[\s\S]*refused \(401\)[\s\S]*› Try again/],
				[one({ running: false, settingsError: "pi-personal.json: bad JSON" }), 0, /settings are broken[\s\S]*› See why/],
				[one({ settingsError: "pi-personal.json: bad JSON" }), 0, /idle[\s\S]*its settings are broken[\s\S]*› Open main/],
				[one({ running: false, elsewhere: 4242 }), 0, /running elsewhere[\s\S]*pid 4242[\s\S]*› Full status/],
				[one({ name: "a-very-long-agent-name", safeMode: { off: [], broken: [], reason: "x\ny" } }), 0, /with extensions off|…/],
				[{ up: false, rows: [{ name: "main" }] }, 0, /not running[\s\S]*› Start main/],
				[{ up: true, rows: [] }, 0, /Nothing is set up yet[\s\S]*› Set it up/],
				[{ up: true, rows: [{ name: "main", s: st({}) }, { name: "work", s: st({ name: "work", state: "working" }) }] }, 1, /main[\s\S]*▸ work[\s\S]*› Open work[\s\S]*←→ agent/],
			];
			// A low terminal: everything (the keys first of all) on the screen, around the chosen agent.
			const many = { up: true, rows: Array.from({ length: 30 }, (_v, i) => ({ name: `agent${i}`, s: st({ name: `agent${i}`, lastError: { at: "now", error: "x" } }) })) };
			const low = picture(l, "0.4.0", many as never, 20, 500, columns, 15);
			assert.ok(low.length <= 14, `${low.length} lines for 15 rows`);
			assert.match(plain(low), /agent20[\s\S]*enter open agent20/, "too low for the menu: its keys on one line, what Enter does first");
			for (const [snap, at, want] of cases) {
				const lines = picture(l, "0.4.0", snap as never, at, 500, columns);
				assert.match(plain(lines), want, `${columns} columns, ${l.depth}`);
				for (const s of lines) assert.ok(screen.width(s) <= columns, `${columns} columns: ${screen.width(s)}: ${s}`);
				if (l.depth === "none") assert.doesNotMatch(lines.join(""), /\x1b/);
			}
		}
});
