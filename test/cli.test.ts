// The command line: paths with spaces and accents, words joined into one message, options passed to pi, clear usage
// errors, one folder per agent, the installer's command.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, ROOT, run, setup } from "./helpers.ts";

let t: Env;
const folder = (n: string) => path.join(t.dir, "agents", n);
const lastUser = () => t.model.requests.at(-1)?.users.at(-1);
const sent = (agent: string, id: string) => port.events(t.portOf(agent)).events.some((e) => JSON.stringify(e).includes(id));

/** A copy of the program (code only, pi shared through a link) in a folder with a space and an accent. */
function spacedCopy(): string {
	const to = path.join(t.dir, "Mes Outils é", "pi-personal");
	fs.mkdirSync(to, { recursive: true });
	for (const f of ["core", "channels", "package.json"]) fs.cpSync(path.join(ROOT, f), path.join(to, f), { recursive: true });
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(to, "node_modules"));
	return to;
}
const cliAt = (root: string, ...args: string[]) =>
	run(process.execPath, [path.join(root, "core", "cli.ts"), ...args], { env: t.env, timeout: 60_000 }).then(
		(r) => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
		(e) => ({ code: e.code as number, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }),
	);

before(async () => {
	t = await setup("fcli");
	assert.equal((await t.cli("init", "main", folder("main"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t.close());

test("unquoted words are all sent: send main hello world", async () => {
	const r = await t.cli("send", "main", "hello", "world", "--wait", "--timeout", "40");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "echo: hello world");
	assert.equal(lastUser(), "hello world");
});

test("after -- everything is text, even words that look like options", async () => {
	const r = await t.cli("send", "main", "--wait", "--timeout", "40", "--", "--verbose", "please", "-h");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "echo: --verbose please -h");
});

test("-h and help print the usage; --version prints versions; no command shows the agents and what to do next", async () => {
	for (const args of [["-h"], ["help"], ["send", "-h"]]) {
		const r = await t.cli(...args);
		assert.equal(r.code, 0, `${args}`);
		assert.match(r.stdout, /Usage: pp \[command\] \[agent\]/, `${args}`);
	}
	const none = await t.cli();
	assert.equal(none.code, 0, none.stderr);
	assert.match(none.stdout, /Open it: +pp attach|Start here: +pp setup|Start it: +pp start/);
	const v = await t.cli("--version");
	assert.equal(v.code, 0, v.stderr);
	assert.match(v.stdout, /\d+\.\d+\.\d+/);
	assert.match(v.stdout, /Node/);
	const j = JSON.parse((await t.cli("--version", "--json")).stdout);
	assert.ok(j.version && j.pi && j.node);
});

test("a bad --timeout is a usage error (exit 2) and nothing is sent", async () => {
	for (const [i, bad] of ["abc", "0", "-5", "NaN"].entries()) {
		const id = `tmo-${i}`;
		const r = await t.cli("send", "main", "timeout test", "--id", id, "--wait", "--timeout", bad);
		assert.equal(r.code, 2, `--timeout ${bad}: ${r.stderr}`);
		assert.match(r.stderr, /--timeout takes a number/);
		assert.equal(sent("main", id), false, `--timeout ${bad} must not submit the message`);
	}
	const miss = await t.cli("send", "main", "x", "--timeout");
	assert.equal(miss.code, 2);
	assert.match(miss.stderr, /needs a value/);
});

test("missing text, an unknown option, unknown command and unknown agent fail with a clear message", async () => {
	const a = await t.cli("send", "main");
	assert.equal(a.code, 2);
	assert.match(a.stderr, /missing message text/);
	const b = await t.cli("send", "main", "x", "--when-busy", "later", "--id", "wb-1");
	assert.equal(b.code, 2);
	assert.equal(sent("main", "wb-1"), false);
	const c = await t.cli("frobnicate");
	assert.equal(c.code, 2);
	assert.match(c.stderr, /unknown command/);
	const d = await t.cli("attach", "nosuch");
	assert.notEqual(d.code, 0);
	assert.match(d.stderr, /no agent named "nosuch"/);
});

test("send --wait to an agent that is not running says so and exits 1 without waiting for the timeout", async () => {
	assert.equal((await t.cli("init", "idle", folder("idle"), "--model", "fake/echo-1")).code, 0);
	const t0 = Date.now();
	const r = await t.cli("send", "idle", "anyone home?", "--wait", "--timeout", "30");
	assert.equal(r.code, 1);
	assert.match(r.stderr, /not running/);
	assert.ok(Date.now() - t0 < 10_000, "it must not wait for the timeout");
});

test("init requires --model", async () => {
	const r = await t.cli("init", "nomodel", folder("nomodel"));
	assert.equal(r.code, 2);
	assert.match(r.stderr, /--model/);
});

test("login hands --api-key and --no-browser to pi", async () => {
	// With no provider, pi prints its own usage; the old code dropped the flags and Pi-Personal printed its own usage.
	const a = await t.cli("login", "--api-key");
	assert.match(a.stdout + a.stderr, /Usage: pi auth login/);
	const b = await t.cli("login", "--no-browser");
	assert.match(b.stdout + b.stderr, /Usage: pi auth login/);
	// A provider with the flags reaches pi too (no terminal here: pi says so, and exits 1 instead of hanging).
	const c = await t.cli("login", "anthropic", "--api-key");
	assert.equal(c.code, 1);
	assert.match(c.stdout + c.stderr, /requires an interactive terminal/);
	// Both flags together: pi itself refuses the combination, so both reached it.
	const c2 = await t.cli("login", "anthropic", "--api-key", "--no-browser");
	assert.equal(c2.code, 1);
	assert.match(c2.stdout + c2.stderr, /--no-browser only applies/);
	// No argument at all is Pi-Personal's own usage error.
	const d = await t.cli("login");
	assert.equal(d.code, 2);
	assert.match(d.stderr, /usage: pp login/);
});

test("a second agent cannot take the folder of the first, nor a folder inside the private area", async () => {
	const same = await t.cli("init", "twin", folder("main"), "--model", "fake/echo-1");
	assert.notEqual(same.code, 0);
	assert.match(same.stderr, /already the folder of the agent "main"/);
	// A different spelling of the same folder is refused as well.
	const spelled = await t.cli("init", "twin", `${folder("main")}/../main/`, "--model", "fake/echo-1");
	assert.notEqual(spelled.code, 0);
	assert.match(spelled.stderr, /already the folder/);
	const inside = await t.cli("init", "deep", path.join(t.home, "agents", "deep-folder"), "--model", "fake/echo-1");
	assert.notEqual(inside.code, 0);
	assert.match(inside.stderr, /private area/);
	for (const n of ["twin", "deep"]) {
		const s = await t.cli("status", n);
		assert.notEqual(s.code, 0, `${n} must not exist`);
		assert.equal(fs.existsSync(path.join(t.home, "agents", n, "agent.json")) || fs.existsSync(path.join(t.home, "agents", n, "record.json")), false);
	}
	// The same agent can be initialised again on its own folder.
	assert.equal((await t.cli("init", "main", folder("main"), "--model", "fake/echo-1")).code, 0);
});

test("installed in a folder with a space and an accent, an agent starts and answers", async () => {
	const root = spacedCopy();
	const v = await cliAt(root, "--version");
	assert.equal(v.code, 0, v.stderr);
	assert.doesNotMatch(v.stderr, /%20|%C3/);
	const init = await cliAt(root, "init", "sp", folder("sp"), "--model", "fake/echo-1");
	assert.equal(init.code, 0, init.stderr);
	const from = port.end(t.portOf("sp"));
	const s = await cliAt(root, "start", "sp");
	assert.equal(s.code, 0, s.stdout + s.stderr);
	const started = await t.waitEvent("sp", from, (e) => e.type === "started" && !e.channel, 40_000);
	assert.ok(started.pid);
	const r = await cliAt(root, "send", "sp", "from a spaced install", "--wait", "--timeout", "40");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "echo: from a spaced install");
	const st = await cliAt(root, "status", "sp");
	assert.equal(st.code, 0, st.stderr);
	const doctor = await cliAt(root, "doctor");
	assert.doesNotMatch(doctor.stdout + doctor.stderr, /%20|%C3|ENOENT/);
	await cliAt(root, "stop", "sp");
});

// The shim written by install.sh, evaluated without running the installer (it reaches the network): only the lines
// from `cat > "$BIN/pp" <<SHIM` to `SHIM`, with a Node and an install folder of our choice.
async function shim(nodePath: string, dest: string, pathEnv?: string) {
	const lines = fs.readFileSync(path.join(ROOT, "install.sh"), "utf8").split("\n");
	const a = lines.findIndex((l) => l.startsWith('cat > "$BIN/$n" <<SHIM'));
	const b = lines.findIndex((l, i) => i > a && l === "SHIM");
	assert.ok(a > 0 && b > a, "the shim is in install.sh");
	const bin = path.join(t.dir, `bin-${path.basename(nodePath)}-${Math.random().toString(36).slice(2, 6)}`);
	fs.mkdirSync(bin);
	await run("sh", ["-c", `NODE="$1"; DEST="$2"; BIN="$3"; n=pp\n${lines.slice(a, b + 1).join("\n")}`, "sh", nodePath, dest, bin]);
	const shimFile = path.join(bin, "pp");
	fs.chmodSync(shimFile, 0o755);
	const r = await run("sh", [shimFile, "--version"], { env: { ...t.env, PATH: pathEnv ?? t.env.PATH }, timeout: 30_000 }).then(
		(x) => ({ code: 0, out: x.stdout + x.stderr }),
		(e) => ({ code: e.code as number, out: String(e.stdout) + String(e.stderr) }),
	);
	return { text: fs.readFileSync(shimFile, "utf8"), ...r };
}

test("the shim runs the Node found at install time, quoted, in an install folder with a space", async () => {
	const root = path.join(t.dir, "Mes Outils é", "pi-personal");
	assert.ok(fs.existsSync(root), "the spaced copy exists (made by the test of paths with spaces)");
	const r = await shim(process.execPath, root, "/usr/bin:/bin"); // a PATH without the right Node: only the baked-in one can work
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /Pi-Personal \d+\.\d+\.\d+/);
	assert.ok(r.text.includes(process.execPath), "the Node path is written in the shim");
});

test("if that Node has moved, the shim falls back to the Node on the PATH", async () => {
	const root = path.join(t.dir, "Mes Outils é", "pi-personal");
	const r = await shim("/nonexistent/bin/node", root, `${path.dirname(process.execPath)}:/usr/bin:/bin`);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /Pi-Personal \d+\.\d+\.\d+/);
});
