// A running agent whose provider refused its key: the person writes the right key into Pi-Personal's auth.json, and the
// same agent answers the next message without a restart. The fake provider has no apiKey of its own (pi takes the key
// from auth.json) and answers 401 to any other key.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";
import { type Env, setup } from "./helpers.ts";

let t: Env;
const RIGHT = "sk-right-123";
const authFile = () => path.join(t.home, "pi", "auth.json");
const writeKey = (key: string) => fs.writeFileSync(authFile(), JSON.stringify({ fake: { type: "api_key", key } }), { mode: 0o600 });

before(async () => {
	t = await setup("keyrl", { requireKey: RIGHT });
	writeKey("wrong");
	assert.equal((await t.cli("init", "main", path.join(t.dir, "agents", "main"), "--model", "fake/echo-1")).code, 0);
	assert.equal((await t.cli("start", "main")).code, 0);
});
after(async () => {
	await t?.close();
});

test("a running agent uses a key written into auth.json after its provider refused the old one, without a restart", async () => {
	const p = t.portOf("main");
	const before = port.events(p, 0).events;
	const starts = before.filter((e) => e.type === "started" && !e.channel).length;

	// 1. The wrong key is refused, and the person is told in plain words.
	const refused = await t.cli("send", "main", "hello with the wrong key", "--id", "k1", "--wait", "--timeout", "60");
	assert.equal(refused.code, 1, `send must fail with the wrong key: ${refused.stdout}${refused.stderr}`);
	assert.match(refused.stderr, /fake refused the credentials/);

	// 2. The person writes the right key into auth.json (what pp login <provider> --api-key stores). No restart.
	writeKey(RIGHT);

	// 3. The next message, same agent: answered with the new key, without a restart (pi re-reads auth.json when it changes).
	const from = port.end(p);
	const ok = await t.cli("send", "main", "hello with the new key", "--id", "k2", "--wait", "--timeout", "60");
	assert.equal(ok.code, 0, `${ok.stdout}${ok.stderr}`);
	assert.match(ok.stdout, /echo: hello with the new key/);
	const all = port.events(p, from).events;
	assert.ok(!all.some((e) => e.type === "restarted" || (e.type === "started" && !e.channel)), "the agent was not started again");
	assert.ok(starts >= 1);
});
