// A first agent and a first message: the agent runs in its Herdr Core terminal, reports its status, and answers.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Env, setup } from "./helpers.ts";

let t: Env;
before(async () => (t = await setup("a01")));
after(async () => t.close());

test("init, start, send --wait, status", async () => {
	const folder = path.join(t.dir, "agents", "main");
	let r = await t.cli("init", "main", folder, "--model", "fake/echo-1");
	assert.equal(r.code, 0, r.stderr);
	assert.ok(fs.existsSync(path.join(folder, "AGENTS.md")));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, "pi-personal.json"), "utf8")), { model: "fake/echo-1" });
	assert.deepEqual(fs.readdirSync(folder).sort(), ["AGENTS.md", "pi-personal.json"]); // nothing else in the visible folder
	assert.equal((fs.statSync(t.home).mode & 0o777).toString(8), "700");

	r = await t.cli("start", "main");
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /started; pi is ready/);
	r = await t.cli("start", "main");
	assert.match(r.stdout, /already running: agent/); // idempotent

	r = await t.cli("send", "main", "hello there", "--wait", "--timeout", "30");
	assert.equal(r.code, 0, r.stderr);
	assert.equal(r.stdout.trim(), "echo: hello there");

	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	assert.equal(s.running, true);
	assert.ok(["done", "idle"].includes(s.state), `status reported to Herdr: ${s.state}`);
	const term = t.hc("get", s.address);
	assert.equal(term.status.app, "pi");
	assert.equal(term.name, "pi-personal-main");
	assert.equal(term.labels["pi-personal.agent"], "main");
	assert.equal(term.labels.where, "pi-personal / main");
});
