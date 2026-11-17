// A fresh machine, simulated: an empty home folder, only the system's own commands on the PATH (so no Node.js recent
// enough and no Herdr Core), and a Herdr Core session of its own. The real installer runs in a real terminal (script(1)
// gives it one) and downloads Node.js and Herdr Core; `pp setup` is answered as a person would, keys and all; then the
// everyday commands, `pp stop --all`, and `pp uninstall --purge`.
//
// Manual, not part of `npm test`: it downloads about 100 MB and takes a few minutes. Run it before a release:
//   node --test test/fresh-install.manual.ts
// Its model is the tests' fake one, declared in the new private area as if the user had configured it; the sign-in
// step is still exercised, with a made-up OpenAI key that is saved but never used.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { isRunning } from "../core/herdr.ts";
import { fakeModel, type FakeModel, ROOT } from "./helpers.ts";

const mac = process.platform === "darwin";
/** The user's own default Herdr Core, read once (and only if it runs: asking one that does not would start it). */
const DEFAULT_CORE = (await isRunning(process.env)) ? JSON.parse(execFileSync("hc", ["server", "status", "--json"], { encoding: "utf8" })).core?.id : undefined;
let dir: string;
let env: NodeJS.ProcessEnv;
let model: FakeModel;
let term: ChildProcess | undefined;
let keysFd: number | undefined; // macOS: the named pipe the keys go through
function closeKeys() {
	if (keysFd !== undefined) fs.closeSync(keysFd);
	keysFd = undefined;
}
const home = () => path.join(dir, "home");
const pp = () => path.join(home(), ".local", "bin", "pp");
const hcFresh = () => path.join(home(), ".local", "bin", "hc");
const privateArea = () => (mac ? path.join(home(), "Library", "Application Support", "Pi-personal") : path.join(dir, "state", "pi-personal"));

before(async () => {
	dir = fs.mkdtempSync("/tmp/pt-fresh-"); // short: Unix socket paths are limited to about 100 characters
	for (const d of ["home", "run", "state", "config", "data", "cache"]) fs.mkdirSync(path.join(dir, d), { mode: 0o700 });
	model = await fakeModel();
	env = {
		HOME: home(),
		USER: process.env.USER,
		LOGNAME: process.env.LOGNAME,
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "xterm-256color",
		SHELL: "/bin/sh",
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		HC_SESSION: `ptfresh${path.basename(dir).replace(/[^a-z0-9]/gi, "").toLowerCase()}`,
		XDG_RUNTIME_DIR: path.join(dir, "run"),
		XDG_STATE_HOME: path.join(dir, "state"),
		XDG_CONFIG_HOME: path.join(dir, "config"),
		XDG_DATA_HOME: path.join(dir, "data"),
		XDG_CACHE_HOME: path.join(dir, "cache"),
		PI_PERSONAL_SOURCE: ROOT, // this copy, not GitHub's
		PI_TELEMETRY: "0",
	};
	// The model the user "already configured": the tests' fake one.
	fs.mkdirSync(path.join(privateArea(), "pi"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(privateArea(), "pi", "models.json"),
		JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${model.port}/v1`, api: "openai-completions", apiKey: "fake", models: [{ id: "echo-1", name: "Fake", contextWindow: 32000, maxTokens: 2000 }] } } }),
	);
});

after(async () => {
	closeKeys(); // else the pipeline around script(1) on macOS, and this process with it, never ends
	term?.kill("SIGKILL");
	term?.stdout?.destroy();
	term?.stderr?.destroy();
	model?.close();
	// The fresh Herdr Core, if the test stopped before `stop --all`: stop it, only after checking it is the fresh one.
	if (dir && (await isRunning(env)) && fs.existsSync(hcFresh()) && env.HC_SESSION?.startsWith("ptfresh")) {
		const id = JSON.parse(execFileSync(hcFresh(), ["server", "status", "--json"], { env, encoding: "utf8" })).core?.id;
		if (id && id !== DEFAULT_CORE) execFileSync(hcFresh(), ["server", "stop"], { env });
	}
	for (let i = 0; i < 50 && dir && (await isRunning(env)); i++) await new Promise((r) => setTimeout(r, 100));
	if (dir && (await isRunning(env))) throw new Error(`the fresh Herdr Core is still running; ${dir} is kept`);
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** A program in a real terminal, driven like expect(1): wait for text on the screen, then type. */
function terminal(command: string) {
	// -F (macOS) and -f (Linux): write what the program shows at once, not when it ends. macOS's script refuses
	// sockets around it (Node's pipes are sockets there): real pipes through cat, the keys from a named pipe.
	if (mac) {
		const fifo = path.join(dir, "keys");
		execFileSync("mkfifo", [fifo]);
		term = spawn("sh", ["-c", 'cat "$1" | script -qF /dev/null sh -c "$0" | cat', command, fifo], { env, stdio: ["ignore", "pipe", "pipe"] });
		keysFd = fs.openSync(fifo, "w"); // waits for cat to open it, which it does at once
	} else term = spawn("script", ["-qfec", command, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
	let screen = "";
	let waiters: (() => void)[] = [];
	const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][0-9A-B]/g, "").replace(/\r/g, "");
	const feed = (d: Buffer) => {
		screen += plain(d.toString("utf8"));
		fs.appendFileSync(path.join(dir, "screen.log"), plain(d.toString("utf8"))); // read it if the test is cut short
		for (const w of waiters) w();
	};
	term.stdout!.on("data", feed);
	term.stderr!.on("data", feed);
	let from = 0;
	const exited = new Promise<number>((resolve) => term!.on("close", (c) => resolve(c ?? 1)));
	return {
		/** Wait until this appears after what was already matched, and return the screen up to it. */
		async see(re: RegExp, ms = 120_000): Promise<string> {
			const until = Date.now() + ms;
			for (;;) {
				const rest = screen.slice(from);
				const m = re.exec(rest);
				if (m) {
					from += m.index + m[0].length;
					return rest.slice(0, m.index + m[0].length);
				}
				if (Date.now() > until) throw new Error(`not seen within ${ms / 1000} s: ${re}\n--- screen since the last match ---\n${rest.slice(-3000)}`);
				await new Promise<void>((r) => {
					waiters.push(r);
					setTimeout(r, 500);
				});
				waiters = [];
			}
		},
		type(keys: string) {
			if (keysFd !== undefined) fs.writeSync(keysFd, keys);
			else term!.stdin!.write(keys);
		},
		/** No more keys, then the exit code. On macOS the first cat ends only when the named pipe is closed. */
		end() {
			closeKeys();
			return exited;
		},
		screen: () => screen,
	};
}

/** pp, as a person would run it. Never synchronous: the fake model answers from this very process. */
function run(args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile(pp(), args, { env: { ...env, PATH: `${path.dirname(pp())}:${env.PATH}` }, encoding: "utf8", timeout: 180_000 }, (err, stdout, stderr) => {
			const e = err as (Error & { code?: number | string; signal?: string }) | null;
			resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: `${stdout}${stderr}${e && typeof e.code !== "number" ? ` (${e.signal ?? e.message})` : ""}` });
		});
	});
}

test("on a fresh machine: one command installs everything, and the guide ends with an agent that answers", { timeout: 20 * 60_000 }, async () => {
	// The installer's own exit code, printed after it: on macOS, the pipeline's code is the last cat's.
	const t = terminal(`sh '${path.join(ROOT, "install.sh")}'; echo "[installer exit $?]"`);
	const node = await t.see(/Installed: Pi-personal [\d.]+ \(pi [\d.]+, Herdr Core not found, Node ([\d.]+)\)/, 10 * 60_000);
	assert.doesNotMatch(node, /Node 20\./, "the Node.js used is a recent one");
	await t.see(/first on your PATH.*\[Y\/n\]/);
	t.type("y");
	t.type("\r");
	await t.see(/1\/5 {2}This machine/);
	await t.see(/Install Herdr Core now\?.*\[Y\/n\]/);
	t.type("y\r");
	await t.see(/Herdr Core [\d.]+, running/, 5 * 60_000);
	await t.see(/2\/5 {2}A model provider/);
	await t.see(/connected: fake/);
	await t.see(/Connect another provider\?.*\[y\/N\]/);
	t.type("y\r");
	await t.see(/How do you want to connect\?/);
	t.type("\x1b[B"); // ↓: Use an API key
	t.type("\r");
	await t.see(/Which provider\?/);
	t.type("openai");
	await t.see(/› OpenAI\b/);
	t.type("\r");
	await t.see(/API key/i, 60_000);
	t.type("sk-made-up-for-the-test\r");
	await t.see(/OpenAI: (connected|not connected)/, 120_000);
	await t.see(/Connect another provider\?.*\[y\/N\]/);
	t.type("n\r");
	await t.see(/3\/5 {2}Your agent/);
	await t.see(/Which model\?/, 120_000);
	t.type("echo");
	await t.see(/› fake\/echo-1/);
	t.type("\r");
	await t.see(/Name your agent/);
	t.type("\r");
	await t.see(/main created in ~\/pi-personal\/main/);
	await t.see(/4\/5 {2}Start it/);
	await t.see(/main › echo: Say hello/, 180_000);
	await t.see(/Talk to main from Telegram\?.*\[y\/N\]/);
	t.type("n\r");
	await t.see(/Bring main back by itself if it stops\?.*\[Y\/n\]/);
	t.type("n\r"); // the real login service manager is not touched by a test
	await t.see(/Talk to it: +\S*pp chat/); // the full path: this terminal does not find pp yet
	await t.see(/In this terminal, pp is not found yet/);
	const code = /\[installer exit (\d+)\]/.exec(await t.see(/\[installer exit \d+\]/))![1];
	assert.equal(code, "0", t.screen().slice(-2000));
	assert.equal(await t.end(), 0, t.screen().slice(-2000));
	assert.match(fs.readFileSync(path.join(home(), ".profile"), "utf8"), /added by Pi-personal's installer/);
});

test("then the everyday commands work, and stop --all leaves nothing running", { timeout: 10 * 60_000 }, async () => {
	const o = await run([]);
	assert.equal(o.code, 0, `exit ${o.code}: ${o.out}`);
	assert.match(o.out, /main {2}(idle|working)/);
	const s = await run(["send", "are you there?", "--wait"]);
	assert.equal(s.code, 0, `exit ${s.code}: ${s.out}\n--- status ---\n${(await run(["status"])).out}\n--- log ---\n${(await run(["log"])).out.slice(-2000)}`);
	assert.match(s.out, /echo: are you there\?/);
	const d = await run(["doctor"]);
	assert.match(d.out, /ok\s+Herdr Core [\d.]+/);
	const stop = await run(["stop", "--all"]);
	assert.equal(stop.code, 0, stop.out);
	assert.match(stop.out, /Herdr Core: stopped/);
	for (let i = 0; i < 50 && (await isRunning(env)); i++) await new Promise((r) => setTimeout(r, 100));
	assert.equal(await isRunning(env), false, "the fresh Herdr Core stopped");
	const u = await run(["uninstall", "--purge"]);
	assert.equal(u.code, 0, u.out);
	assert.ok(!fs.existsSync(pp()), "pp is gone");
	assert.ok(fs.existsSync(path.join(home(), "pi-personal", "main", "AGENTS.md")), "the agent's folder is kept");
});
