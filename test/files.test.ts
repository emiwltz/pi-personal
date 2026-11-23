// Files out: the bridge's attach_file tool sends a file to the person a run answers (a `file` event with the run's
// refs), counts as a reply, refuses what lies in the private area and what is no file, and finds nobody to send to in a
// run typed in the terminal; `pp send --wait` prints it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { openWork } from "../core/bridge.ts";
import * as port from "../core/port.ts";
import { type Env, setup } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const priv = () => path.join(t.home, "agents", "main");
const P = () => t.portOf("main");
const has = (e: port.Seen, id: string) => ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id);

/** A message whose run calls attach_file with `p`: what the run said and sent, and its last word. */
async function attach(id: string, p: string, keyword = "call:") {
	const from = port.end(P());
	port.submit(P(), { id, text: `${keyword} attach_file ${JSON.stringify({ path: p })}`, conversation: "telegram:4242", from: { message: 7 } });
	const settled = await t.waitEvent("main", from, (e) => e.type === "settled" && has(e, id), 60_000);
	const all = port.events(P(), from).events.filter((e) => e.cursor < settled.cursor);
	return { settled, files: all.filter((e) => e.type === "file"), said: all.filter((e) => e.type === "message" && has(e, id)).map((e) => String(e.text)) };
}

before(async () => {
	t = await setup("files");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	fs.writeFileSync(path.join(folder(), "report.txt"), "the report\n");
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t?.close());

test("a run that calls attach_file for a file in the agent's folder: one file event with the run's refs, then settled without error", async () => {
	const r = await attach("f-1", "report.txt");
	const real = fs.realpathSync(path.join(folder(), "report.txt"));
	assert.equal(r.files.length, 1, "one file event");
	assert.equal(r.files[0].path, real, "the real path, absolute");
	assert.deepEqual(r.files[0].refs, [{ id: "f-1", from: { message: 7 }, conversation: "telegram:4242" }], "the run's refs, as for a reply");
	assert.equal(r.settled.error, undefined);
	assert.match(r.said.join("\n"), /done: Sent .*report\.txt to the person you are answering/, "the tool answered that it was sent");
});

test("a file written and sent in the same step is sent: attach_file runs after the step's other calls", async () => {
	const from = port.end(P());
	const steps = [["bash", { command: "sleep 1; echo made > made.txt" }], ["attach_file", { path: "made.txt" }]];
	port.submit(P(), { id: "f-same-step", text: `calls: ${JSON.stringify(steps)}`, conversation: "telegram:4242", from: { message: 8 } });
	const settled = await t.waitEvent("main", from, (e) => e.type === "settled" && has(e, "f-same-step"), 60_000);
	const files = port.events(P(), from).events.filter((e) => e.cursor < settled.cursor && e.type === "file");
	assert.equal(files.length, 1, "the file was there when it was sent");
	assert.equal(files[0].path, fs.realpathSync(path.join(folder(), "made.txt")));
	assert.equal(settled.error, undefined);
});

test("a file-only run settles clean: a file sent is a reply", async () => {
	const r = await attach("f-only", "@report.txt", "silent-call:"); // a leading @ is dropped, as pi's own tools do
	assert.equal(r.files.length, 1);
	assert.deepEqual(r.said, [], "not a word, only the file");
	assert.equal(r.settled.error, undefined, "no 'finished without answering'");
});

test("a file-only run after pi retried a passing provider error settles clean", async () => {
	const r = await attach("f-flaky", "report.txt", "flaky: silent-call:"); // refused once (503), retried by pi, then the file
	assert.equal(r.files.length, 1, "one file event");
	assert.equal(r.settled.error, undefined, "the overload pi got past is not the run's error");
});

test("a run that fails after sending a file still gets its error", async () => {
	const r = await attach("f-then-fail", "report.txt", "then-refuse: silent-call:"); // the file, then a final refusal
	assert.equal(r.files.length, 1, "the file was sent");
	assert.match(String(r.settled.error), /fake refusal after an interim reply/);
});

test("a file sent from inside another tool (codemode's nestedCalls) counts as a reply; a refused one does not", () => {
	const ours = { type: "custom_message", customType: "pi-personal.message", details: { id: "m1", conversation: "telegram:1" } };
	const script = (status: string) => ({ type: "message", message: { role: "toolResult", toolName: "codemode", content: [], isError: false, nestedCalls: { calls: [{ id: "n1", name: "attach_file", status }], complete: true } } });
	const silent = { type: "message", message: { role: "assistant", content: [], stopReason: "stop" } };
	const sent = openWork([ours, script("ok"), silent]);
	assert.deepEqual({ unanswered: sent.unanswered, cutOff: sent.cutOff }, { unanswered: [], cutOff: false });
	assert.deepEqual(openWork([ours, script("error"), silent]).unanswered.map((r) => r.id), ["m1"], "refused inside the script: no reply");
});

test("a secrets file, a link to one, a channel's own state, a directory and a missing path are refused with a reason", async () => {
	const secret = path.join(priv(), "secrets", "token");
	fs.mkdirSync(path.dirname(secret), { recursive: true });
	fs.writeFileSync(secret, "s3cret\n", { mode: 0o600 });
	fs.symlinkSync(secret, path.join(folder(), "innocent.txt"));
	const state = path.join(priv(), "channels", "telegram", "allow.json");
	fs.mkdirSync(path.dirname(state), { recursive: true });
	fs.writeFileSync(state, '{"allow":[]}\n');
	const cases: [string, string, RegExp][] = [
		["f-secret", secret, /secrets\/token is in Pi-Personal's private area/],
		["f-link", "innocent.txt", /innocent\.txt is in Pi-Personal's private area/],
		["f-state", state, /allow\.json is in Pi-Personal's private area/],
		["f-dir", ".", /\. is not a file/],
		["f-missing", "nowhere/nothing.txt", /nowhere\/nothing\.txt does not exist/],
	];
	for (const [id, p, why] of cases) {
		const r = await attach(id, p);
		assert.equal(r.files.length, 0, `${id}: nothing sent`);
		assert.match(r.said.join("\n"), new RegExp(`done: Not sent: (?:.*/)?${why.source}`), `${id}: the tool says why`);
	}
});

test("a received file can be sent back, and so can an in-agent extension's own file", async () => {
	const received = path.join(priv(), "channels", "telegram", "files", "1042-photo.jpg");
	fs.mkdirSync(path.dirname(received), { recursive: true });
	fs.writeFileSync(received, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
	const back = await attach("f-back", received);
	assert.deepEqual(back.files.map((e) => e.path), [fs.realpathSync(received)]);
	const own = path.join(priv(), "extensions", "charts", "week.png");
	fs.mkdirSync(path.dirname(own), { recursive: true });
	fs.writeFileSync(own, "png");
	assert.deepEqual((await attach("f-ext", own)).files.map((e) => e.path), [fs.realpathSync(own)]);
});

test("attach_file in a run typed in the terminal answers that there is nobody to send it to", async () => {
	const from = port.end(P());
	await t.type("main", 'call: attach_file {"path":"report.txt"}');
	const end = await t.waitEvent("main", from, (e) => e.type === "settled" && !(e.refs as port.Ref[]).length, 60_000);
	const all = port.events(P(), from).events.filter((e) => e.cursor < end.cursor);
	assert.equal(all.filter((e) => e.type === "file").length, 0);
	assert.match(all.filter((e) => e.type === "message").map((e) => String(e.text)).join("\n"), /done: There is nobody to send the file to/);
});

test("pp send --wait prints the [file] line and counts the file as the answer", async () => {
	const real = fs.realpathSync(path.join(folder(), "report.txt"));
	const r = await t.cli("send", "main", 'silent-call: attach_file {"path":"report.txt"}', "--wait", "--timeout", "60");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout, `[file] ${real}\n`);
	const j = await t.cli("send", "main", 'silent-call: attach_file {"path":"report.txt"}', "--wait", "--timeout", "60", "--json");
	assert.equal(j.code, 0, j.stderr);
	assert.deepEqual({ said: JSON.parse(j.stdout).said, files: JSON.parse(j.stdout).files }, { said: [], files: [real] });
});
