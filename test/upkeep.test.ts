// Keeping it running: pp doctor by topic, the short help and the full one, and the login service's round after a
// restart of the machine (Herdr Core not running): it starts Herdr Core only when it may.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRunning } from "../core/herdr.ts";
import { type Env, setup, sleep } from "./helpers.ts";

let t: Env;
before(async () => {
	t = await setup("upkeep");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => t.close());

test("pp doctor: one heading per topic, in order, the levels scripts read, and what to fix", async () => {
	const r = await t.cli("doctor");
	const heads = r.stdout.split("\n").filter((l) => /^\S/.test(l));
	assert.deepEqual(heads.slice(0, 4), ["This machine", "Herdr Core", "Coming back by itself", "Agent main"]);
	assert.match(r.stdout, /^ {2}ok {4}pi \d+\.\d+\.\d+/m);
	assert.match(r.stdout, /^ {2}ok {4}agent main: model fake\/echo-1: credentials ready/m);
	assert.match(r.stdout, /^ {2}note {2}after a restart of this machine: Herdr Core and the agents are started by you/m);
	assert.match(r.stdout, /Nothing to fix\.|to fix: each FAIL line says what to do\./);
	const json = JSON.parse((await t.cli("doctor", "--json")).stdout);
	assert.ok(json.every((c: { topic?: string }) => typeof c.topic === "string"));
});

test("pp help: the six commands to know; pp help --all: every command", async () => {
	const short = (await t.cli("help")).stdout;
	for (const c of ["setup", "status", "doctor", "update", "help --all"]) assert.match(short, new RegExp(`^ {2}pp ${c}`, "m"));
	assert.ok(short.split("\n").length < 16, "short");
	const all = (await t.cli("help", "--all")).stdout;
	for (const c of ["chat", "send", "attach", "channel add", "secret set", "ext check", "follow"]) assert.match(all, new RegExp(c));
});

test("after a restart of the machine: the login service's round starts Herdr Core only when it may", async () => {
	const stopCore = async () => {
		t.hc("server", "stop");
		for (let i = 0; i < 50 && (await isRunning(t.env)); i++) await sleep(100);
		assert.equal(await isRunning(t.env), false);
	};
	await stopCore();
	let r = await t.cli("up", "--if-running");
	assert.match(r.stdout, /Herdr Core is not running: nothing started/);
	assert.equal(await isRunning(t.env), false, "not allowed: not started");
	fs.writeFileSync(path.join(t.home, "start-herdr-core-at-boot"), "yes\n");
	r = await t.cli("up", "--if-running");
	assert.equal(r.code, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /Herdr Core was not running: started/);
	assert.match(r.stdout, /main: started agent/);
	assert.equal(await isRunning(t.env), true);
	assert.match((await t.cli("send", "main", "back after the restart?", "--wait", "--timeout", "30")).stdout, /echo: back after the restart\?/);
	// Stopped again, on purpose, in the same start of the machine: the next rounds leave it stopped.
	await stopCore();
	r = await t.cli("up", "--if-running");
	assert.match(r.stdout, /nothing started \(it was started once since this machine started, and stopped since/);
	assert.equal(await isRunning(t.env), false);
	// Taken back with the service: uninstalling it removes the permission.
	fs.rmSync(path.join(t.home, "herdr-core-started-for-boot"));
	assert.match((await t.cli("doctor")).stdout, /after a restart of this machine: Herdr Core and the agents are started by you/);
	await t.cli("start", "main"); // Herdr Core again, for what follows and for the end of the test
});
