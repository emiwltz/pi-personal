// Safe mode keeps what works: the extensions that fail to load are off, the others stay on (and are told who a run is
// for); the bridge alone is the floor whatever the extensions do, never `failed` because of safe mode itself; each start
// works out again what fails; it ends by itself once everything loads; and the tools it turned off come back.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as port from "../core/port.ts";
import { type Env, lastStart, setup, sleep } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const P = () => t.portOf("main");
const area = () => path.join(t.home, "agents", "main");
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);
const status = async () => JSON.parse((await t.cli("status", "main", "--json")).stdout);
const sorted = (a: unknown) => [...(a as string[])].sort();
/** Exactly these extensions in .pi/extensions, each an index.ts. */
function extensions(all: Record<string, string>) {
	const dir = path.join(folder(), ".pi", "extensions");
	fs.rmSync(dir, { recursive: true, force: true });
	for (const [name, code] of Object.entries(all)) {
		fs.mkdirSync(path.join(dir, name), { recursive: true });
		fs.writeFileSync(path.join(dir, name, "index.ts"), code);
	}
}
/** The bridge's entries about tools in the agent's session, in order. */
const toolMarks = () =>
	(fs.readdirSync(path.join(area(), "sessions"), { recursive: true }) as string[])
		.filter((f) => f.endsWith(".jsonl"))
		.flatMap((f) => fs.readFileSync(path.join(area(), "sessions", f), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
		.filter((e) => e.type === "custom" && /^pi-personal\.tools-/.test(e.customType))
		.map((e) => ({ type: e.customType, ...(e.data?.names ? { names: e.data.names } : {}) }));
const ask = async (text: string) => {
	const r = await t.cli("send", "main", text, "--wait", "--timeout", "60");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	return { said: r.stdout.trim(), request: t.model.requests.findLast((q) => q.users.at(-1) === text)! };
};

const BROKEN = 'throw new Error("broken on purpose");\nexport default function () {}\n';
// A healthy extension whose tool asks the bridge who the run is for, and keeps the answer in its state folder.
const GOOD = `import * as fs from "node:fs";
import * as path from "node:path";
export default function (pi) {
	pi.registerTool({
		name: "good_who",
		label: "Who",
		description: "Ask who the run is for",
		parameters: { type: "object", properties: {} },
		async execute() {
			const q = {};
			pi.events.emit("pi-personal.who", q);
			fs.appendFileSync(path.join(process.env.PI_PERSONAL_STATE, "who.jsonl"), JSON.stringify(q.run ?? null) + "\\n");
			return { content: [{ type: "text", text: "asked" }], details: undefined };
		},
	});
}
`;
const PING = `export default function (pi) {
	pi.registerTool({ name: "flip_ping", label: "Ping", description: "Answer pong", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "pong" }], details: undefined }; } });
}
`;

before(async () => {
	// Quick failures are counted over a window long enough to hold the five of a test: safe mode itself must add none.
	process.env.PI_PERSONAL_WINDOW_MS ??= "300000";
	t = await setup("safe");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t.close());

test("two extensions, one broken: the other's tool still answers in safe mode and is told who the run is for (pi-personal.who); off names only the broken one", async () => {
	extensions({ good: GOOD, broken: BROKEN });
	const from = port.end(P());
	await t.cli("restart", "main");
	const safe = await t.waitEvent("main", from, (e) => e.type === "safe_mode", 60_000);
	assert.deepEqual(safe.extensions, ["broken"]);
	assert.deepEqual(safe.off, ["broken"]);
	assert.match(String(safe.reason), /^failing to load: broken; off: broken; an extension that is off enforces nothing while messages keep flowing; pi packages and pi's built-in extensions are off too$/);
	const started = await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel, 60_000);
	assert.deepEqual(started.safeMode, ["broken"], "the started event says what is off");

	const owner = { name: "Emi", id: "Telegram user 4242", owner: true };
	port.submit(P(), { id: "s-who", text: "call: good_who {}", conversation: "telegram:4242", sender: owner });
	const end = await t.waitEvent("main", from, (e) => e.type === "settled" && has(e, "s-who"), 60_000);
	assert.equal(end.error, undefined);
	const said = port.events(P(), from).events.filter((e) => e.type === "message" && has(e, "s-who")).map((e) => e.text);
	assert.deepEqual(said, ["done: asked"], "the healthy extension's tool ran");
	const who = fs.readFileSync(path.join(area(), "extensions", "who.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(who.at(-1), { refs: [{ id: "s-who", conversation: "telegram:4242" }], conversation: "telegram:4242", sender: owner, typed: false });

	const s = await status();
	assert.deepEqual({ off: s.safeMode.off, broken: s.safeMode.broken }, { off: ["broken"], broken: ["broken"] });
	assert.match((await t.cli("status", "main")).stdout, /SAFE MODE: running with extensions off: failing to load: broken; off: broken; .*built-in extensions are off too/);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "failed").length, 0);
});

test("an extension removed while pi runs in safe mode, then pi killed: the next start leaves it out, works out the rest again, and stays reachable", async () => {
	// Continues from the test above: safe mode with `good` on. Removed, it must not be asked for at the next start.
	fs.rmSync(path.join(folder(), ".pi", "extensions", "good"), { recursive: true });
	const pid = Number(lastStart(P()).pid);
	const from = port.end(P());
	process.kill(pid, "SIGKILL");
	const back = await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.pid !== pid, 60_000);
	assert.deepEqual(back.safeMode, ["broken"]);
	const evs = port.events(P(), from).events;
	assert.deepEqual(evs.filter((e) => e.type === "restarted").map((e) => e.reason), ["killed by SIGKILL"], "pi started at once with what is there: no fall back to the bridge alone");
	assert.equal(evs.filter((e) => e.type === "safe_mode" || e.type === "failed").length, 0);
	assert.equal((await ask("still here after the kill")).said, "echo: still here after the kill");
});

test("leaving safe mode by itself: once everything loads again, the next start is a normal one, without a restart by hand", async () => {
	extensions({ good: GOOD }); // broken removed, good back
	const pid = Number(lastStart(P()).pid);
	const from = port.end(P());
	process.kill(pid, "SIGKILL");
	const back = await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.pid !== pid, 60_000);
	assert.equal(back.safeMode, null);
	assert.equal((await status()).safeMode, null);
	assert.equal((await ask("call: good_who {}")).said, "done: asked", "the extension is on again");
});

test("safe mode keeps off an extension the owner turned off in pi's settings", async () => {
	// `pi config --local` turns a discovered extension off in .pi/settings.json; `-e` would load it anyway.
	const settings = path.join(folder(), ".pi", "settings.json");
	const marker = path.join(area(), "extensions", "foo-loaded");
	extensions({ broken: BROKEN, foo: `import * as fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "");\nexport default function () {}\n` });
	fs.writeFileSync(settings, JSON.stringify({ extensions: ["-extensions/foo/index.ts"] }));
	try {
		const from = port.end(P());
		await t.cli("restart", "main");
		const safe = await t.waitEvent("main", from, (e) => e.type === "safe_mode", 60_000);
		assert.deepEqual(safe.extensions, ["broken"]);
		assert.deepEqual(sorted(safe.off), ["broken", "foo"]);
		await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel, 60_000);
		assert.equal((await ask("foo stays off")).said, "echo: foo stays off");
		assert.ok(!fs.existsSync(marker), "foo was loaded, by a check or by pi");
	} finally {
		fs.rmSync(settings, { force: true });
	}
});

test("a healthy-looking set that fails at the real start falls back to the bridge alone, at once, without reaching failed", async () => {
	// Three quick failures first, in the same life of the runner: with the two starts of safe mode counted, and the kill
	// of the next test, they would make five, and `failed`.
	extensions({ flip: PING });
	let from = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.safeMode === null, 60_000);
	const kill = async () => {
		const pid = Number(lastStart(P()).pid);
		const at = port.end(P());
		process.kill(pid, "SIGKILL");
		return at;
	};
	for (let i = 0; i < 2; i++) {
		const at = await kill();
		await t.waitEvent("main", at, (e) => e.type === "started" && !e.channel, 60_000);
	}
	// `ttyexit` loads in the check (no terminal) and stops pi in its terminal: the set {ttyexit} looks healthy.
	extensions({ broken: BROKEN, ttyexit: "if (process.stdout.isTTY) process.exit(3);\nexport default function () {}\n" });
	from = await kill();
	const floor = await t.waitEvent("main", from, (e) => e.type === "safe_mode" && (e.off as string[]).length === 2, 90_000);
	assert.deepEqual(sorted(floor.off), ["broken", "ttyexit"]);
	assert.match(String(floor.reason), /^failing to load: broken; pi did not get ready with the others on: every extension of \.pi\/extensions is off; .*built-in extensions are off too$/);
	const started = await t.waitEvent("main", floor.cursor, (e) => e.type === "started" && !e.channel, 60_000);
	assert.deepEqual(sorted(started.safeMode), ["broken", "ttyexit"]);
	const evs = port.events(P(), from).events;
	const first = evs.find((e) => e.type === "safe_mode")!;
	assert.deepEqual(first.off, ["broken"], "first the set without the broken one");
	assert.ok(evs.some((e) => e.type === "restarted" && /exited with code 3; safe mode, the bridge alone/.test(String(e.reason))));
	assert.equal((await ask("reachable on the floor")).said, "echo: reachable on the floor");
	await sleep(2000);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "failed").length, 0, "never failed because of safe mode");
	assert.deepEqual(sorted((await status()).safeMode.off), ["broken", "ttyexit"]);
});

test("on the bridge alone, what fails is worked out again at each start: the event and pp status name what fails now", async () => {
	// Continues from the floor above: `broken` is gone, `bad2` fails instead; the floor stays (ttyexit still there). The
	// kill is the fourth counted failure: the starts into safe mode and onto the floor must not have been counted.
	extensions({ bad2: BROKEN, ttyexit: "if (process.stdout.isTTY) process.exit(3);\nexport default function () {}\n" });
	const pid = Number(lastStart(P()).pid);
	const from = port.end(P());
	process.kill(pid, "SIGKILL");
	const safe = await t.waitEvent("main", from, (e) => e.type === "safe_mode", 60_000);
	assert.deepEqual(safe.extensions, ["bad2"]);
	assert.deepEqual(sorted(safe.off), ["bad2", "ttyexit"]);
	assert.match(String(safe.reason), /^failing to load: bad2; pi did not get ready with the others on: every extension of \.pi\/extensions is off; /);
	await t.waitEvent("main", safe.cursor, (e) => e.type === "started" && !e.channel, 60_000);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "failed").length, 0, "safe mode's own starts are not counted");
	const s = await status();
	assert.deepEqual(s.safeMode.broken, ["bad2"]);
	assert.match(s.safeMode.reason, /^failing to load: bad2; /);
});

test("a tool of the broken extension is callable again after it is fixed and the agent restarted (pi keeps removed tools off by itself)", async () => {
	extensions({ flip: PING });
	let from = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.safeMode === null, 60_000);
	const before = await ask('call: flip_ping {}');
	assert.equal(before.said, "done: pong");
	assert.ok(before.request.tools.includes("flip_ping"));
	const seen = toolMarks().length; // the tests above wrote some of their own
	const marks = () => toolMarks().slice(seen);

	// Broken: safe mode, and pi records that the tool was removed at the first request.
	extensions({ flip: BROKEN });
	from = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && Array.isArray(e.safeMode), 60_000);
	assert.ok(!(await ask("in safe mode")).request.tools.includes("flip_ping"));
	assert.deepEqual(marks(), [{ type: "pi-personal.tools-off", names: ["flip_ping"] }]);

	// Fixed and restarted: the tool is declared and runs again, and the entry is closed after the first run.
	extensions({ flip: PING });
	from = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.safeMode === null, 60_000);
	const after = await ask("call: flip_ping {} ");
	assert.ok(after.request.tools.includes("flip_ping"), JSON.stringify(after.request.tools));
	assert.equal(after.said, "done: pong");
	assert.deepEqual(marks(), [{ type: "pi-personal.tools-off", names: ["flip_ping"] }, { type: "pi-personal.tools-on" }]);
	// And it stays: pi recorded it as added again.
	from = port.end(P());
	await t.cli("restart", "main");
	await t.waitEvent("main", from, (e) => e.type === "started" && !e.channel && e.safeMode === null, 60_000);
	assert.ok((await ask("one more start")).request.tools.includes("flip_ping"));
	assert.equal(marks().length, 2);
	await t.cli("stop", "main");
});
