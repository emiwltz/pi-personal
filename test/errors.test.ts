// Errors reach the sender: a refused request, an agent never signed in, a model pi does not know. send --wait exits 1
// and says why, status shows the last error, Telegram and the local chat tell the person who wrote.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type FakeTelegram, fakeTelegram } from "./fake-telegram.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

let t: Env;
let tg: FakeTelegram;
const OWNER = 1001;
const P = (a = "main") => t.portOf(a);
const folder = (a: string) => path.join(t.dir, "agents", a);
const ids = (e: port.Seen) => ((e.refs as { id: string }[] | undefined) ?? []).map((r) => r.id);
const evs = (a: string, from: number) => port.events(P(a), from).events;
const settledOf = (a: string, from: number, id: string, ms = 60_000) => t.waitEvent(a, from, (e) => e.type === "settled" && ids(e).includes(id), ms);
const until = async (pred: () => boolean, ms = 30_000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(100);
	}
};

before(async () => {
	t = await setup("errs");
	tg = await fakeTelegram();
	assert.equal((await t.cli("init", "main", folder("main"), "--model", "fake/echo-1")).code, 0);
	const file = path.join(folder("main"), "pi-personal.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), channels: { telegram: { apiBase: tg.base } } }, null, 2));
	const { execFileSync } = await import("node:child_process");
	execFileSync(process.execPath, [path.join(ROOT, "core", "cli.ts"), "secret", "set", "main", "telegram-token"], { env: t.env, input: `${tg.token}\n` });
	assert.equal((await t.cli("start", "main")).code, 0);
	assert.equal((await t.cli("channel", "main", "telegram", "allow", String(OWNER))).code, 0);
	assert.equal((await t.cli("send", "main", "warm up", "--wait", "--timeout", "30")).code, 0);
});
after(async () => {
	tg?.close();
	await t?.close();
});

test("a refused request ends with a settled carrying the error, with refs (the last word of the run)", async () => {
	const from = port.end(P());
	const r = await t.cli("send", "main", "fail: bad key", "--id", "e1", "--wait", "--timeout", "60");
	assert.equal(r.code, 1, `send --wait must fail: ${r.stdout}${r.stderr}`);
	assert.match(r.stderr, /fake refusal: bad key/);
	const all = evs("main", from);
	assert.ok(!all.some((e) => e.type === "error" && ids(e).includes("e1")), "the end of a run is said once, by settled");
	const settled = all.find((e) => e.type === "settled" && ids(e).includes("e1"))!;
	assert.match(String(settled.error), /fake refusal: bad key/);
	assert.ok(!all.some((e) => e.type === "message" && ids(e).includes("e1")), "an error must not be sent as a reply");
	assert.ok(!all.some((e) => e.type === "status" && (e as any).state === "error"), 'no status "error" any more');
});

test("credentials the provider refuses are said in plain words, with the command that enters new ones", async () => {
	const r = await t.cli("send", "main", "denied: a wrong key", "--id", "e0", "--wait", "--timeout", "60");
	assert.equal(r.code, 1, `send --wait must fail: ${r.stdout}${r.stderr}`);
	assert.match(r.stderr, /fake refused the credentials: 401 invalid x-api-key\. To enter new ones: pp login\n/);
	assert.doesNotMatch(r.stderr, /request_id|\{"type"/, "the provider's JSON is not shown");
});

test("refused credentials are told from other errors: providers' own words, not any 403 or any word 'authentication'", async () => {
	const { explain, refused } = await import("../core/bridge.ts");
	for (const e of [
		`401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`,
		"401: Incorrect API key provided: sk-ab***cd.",
		`400 [{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]`,
		"401 No auth credentials found",
		"Invalid API Key",
		"Authentication Fails (no such user)",
	])
		assert.ok(refused(e) || refused(explain(e, "p")), `refused: ${e}`);
	for (const e of ["403: model claude-x is not available on your plan", "503 authentication service unavailable, try again", "fake refusal: bad key", "429 rate limited"])
		assert.ok(!refused(e) && !/refused the credentials/.test(explain(e, "p")), `not refused: ${e}`);
	assert.equal(explain(`400 [{"error":{"message":"API key not valid. Please pass a valid API key."}}]`, "google"), "google refused the credentials: 400 API key not valid. Please pass a valid API key. To enter new ones: pp login");
});

test("send --wait --json reports the error and exits 1", async () => {
	const r = await t.cli("send", "main", "fail: json please", "--id", "e2", "--wait", "--timeout", "60", "--json");
	assert.equal(r.code, 1);
	const j = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
	assert.equal(j.settled, true);
	assert.deepEqual(j.said, []);
	assert.match(String(j.error), /fake refusal: json please/);
});

test("status shows lastError, and a working answer clears it", async () => {
	await t.cli("send", "main", "fail: shown in status", "--id", "e3", "--wait", "--timeout", "60");
	const bad = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	const row = Array.isArray(bad) ? bad[0] : bad;
	assert.match(String(row.lastError?.error), /shown in status/);
	const human = (await t.cli("status", "main")).stdout;
	assert.match(human, /last error .*shown in status/);
	const ok = await t.cli("send", "main", "all good again", "--id", "e4", "--wait", "--timeout", "60");
	assert.equal(ok.code, 0);
	assert.match(ok.stdout, /echo: all good again/);
	const good = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.equal((Array.isArray(good) ? good[0] : good).lastError, undefined);
});

test("the agent keeps working after an error: the next message is answered", async () => {
	const from = port.end(P());
	await t.cli("send", "main", "fail: once", "--id", "e5", "--wait", "--timeout", "60");
	await t.cli("send", "main", "second try", "--id", "e6");
	await settledOf("main", from, "e6");
	assert.ok(evs("main", from).some((e) => e.type === "message" && e.text === "echo: second try"));
});

test("Telegram tells the sender about the error, once, quoting nothing it was not asked", async () => {
	const n = tg.sent.length;
	tg.push({ from: { id: OWNER, first_name: "Owner" }, chat: { id: OWNER, type: "private" }, text: "fail: from the phone" });
	await until(() => tg.sent.slice(n).some((s) => /could not answer/.test(s.text)), 60_000);
	await sleep(1500);
	const told = tg.sent.slice(n).filter((s) => s.chat === String(OWNER) && /could not answer/.test(s.text));
	assert.equal(told.length, 1, `told ${told.length} times`);
	assert.match(told[0].text, /fake refusal: from the phone/);
});

test("pp chat shows the error to the person who typed", async () => {
	const child = spawn(process.execPath, [path.join(ROOT, "channels", "local", "chat.ts")], { env: { ...t.env, PI_PERSONAL_PORT: P() }, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	try {
		await until(() => out.includes("Talking to the agent"), 15_000);
		child.stdin.write("fail: in the chat\n");
		await until(() => /the agent could not answer: .*fake refusal: in the chat/.test(out), 60_000);
	} finally {
		child.kill();
	}
});

test("an agent that never signed in answers the sender with an error, not silence", async () => {
	assert.equal((await t.cli("init", "nologin", folder("nologin"), "--model", "anthropic/claude-haiku-5-5")).code, 0);
	const s = await t.cli("start", "nologin");
	const from = port.end(P("nologin"));
	const r = await t.cli("send", "nologin", "hello, first message", "--id", "n1", "--wait", "--timeout", "50");
	assert.equal(r.code, 1, `start: ${s.stdout}${s.stderr}\nsend: ${r.stdout}${r.stderr}`);
	assert.match(r.stderr, /not configured|api key|login|credential|auth/i);
	const all = evs("nologin", from);
	assert.ok(all.some((e) => (e.type === "error" || (e.type === "settled" && e.error)) && ids(e).includes("n1")) || /not start|FAILED/i.test(s.stdout + s.stderr), "neither an error event nor a start failure");
	const st = JSON.parse((await t.cli("status", "nologin", "--json")).stdout);
	const row = Array.isArray(st) ? st[0] : st;
	assert.ok(row.lastError || row.failed, `status says nothing: ${JSON.stringify(row)}`);
});

test("an unknown model is refused at init; one that becomes unknown later is named by start, send, status and doctor", async () => {
	const bad = await t.cli("init", "typo", folder("typo"), "--model", "fkae/echo-1");
	assert.equal(bad.code, 2, bad.stderr);
	assert.match(bad.stderr, /Model "fkae\/echo-1" not found/);
	assert.equal(fs.existsSync(path.join(t.home, "agents", "typo")), false, "nothing was created");
	// A model that pi knows the provider of, but not the id: accepted, with a note (pi passes the id to the provider).
	const odd = await t.cli("init", "typo", folder("typo"), "--model", "fake/echo-2");
	assert.equal(odd.code, 0, odd.stderr);
	assert.match(odd.stderr, /note: Model "echo-2" not found for provider "fake"/);
	// The settings are edited by hand to a provider pi does not know.
	const file = path.join(folder("typo"), "pi-personal.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), model: "fkae/echo-1" }));
	const st = await t.cli("start", "typo");
	assert.equal(st.code, 1);
	assert.match(st.stdout, /pi stopped while starting .*Model "fkae\/echo-1" not found/);
	await t.waitEvent("typo", 0, (e) => e.type === "failed" && !e.channel, 90_000);
	const r = await t.cli("send", "typo", "hello?", "--id", "t1", "--wait", "--timeout", "20");
	assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
	assert.match(r.stderr, /cannot start: .*not found/);
	assert.doesNotMatch(r.stderr, /no answer within/, "the sender got silence until the timeout");
	assert.match((await t.cli("status", "typo")).stdout, /FAILED: .*Model "fkae\/echo-1" not found/);
	assert.match((await t.cli("doctor")).stdout, /FAIL\s+agent typo: model fkae\/echo-1: Model "fkae\/echo-1" not found/);
	await t.cli("stop", "typo");
});
