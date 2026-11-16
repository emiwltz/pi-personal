// Install, run, uninstall: no Pi-personal process or service remains, and the agent's folder is kept.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

const run = promisify(execFile);
let t: Env;
before(async () => (t = await setup("a15")));
after(async () => t.close());

test("install.sh, doctor, service, uninstall", async () => {
	const dest = path.join(t.dir, "install");
	const bin = path.join(t.dir, "bin");
	// The service manager is replaced by a script that only records its arguments: no real service is ever installed.
	const fakeManager = path.join(t.dir, "service-manager");
	fs.writeFileSync(fakeManager, `#!/bin/sh\necho "$@" >> ${t.dir}/service.log\n`, { mode: 0o755 });
	const env = { ...t.env, PI_PERSONAL_INSTALL_DIR: dest, PI_PERSONAL_BIN_DIR: bin, PI_PERSONAL_SYSTEMCTL: fakeManager, PI_PERSONAL_LAUNCHCTL: fakeManager };
	const userHome = path.join(t.dir, "userhome"); // where macOS's LaunchAgents folder goes in this test
	fs.mkdirSync(userHome, { recursive: true });
	await run(path.join(ROOT, "install.sh"), [], { env, timeout: 300_000 });
	const command = path.join(bin, "pi-personal");
	assert.ok(fs.existsSync(command));
	assert.ok(fs.existsSync(path.join(dest, "node_modules", "@earendil-works", "pi-coding-agent")));
	const p = (...args: string[]) => run(command, args, { env: args[0] === "service" || args[0] === "uninstall" ? { ...env, HOME: userHome } : env, timeout: 120_000 });

	const folder = path.join(t.dir, "agents", "main");
	await p("init", "main", folder, "--model", "fake/echo-1");
	const file = path.join(folder, "pi-personal.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), channels: { fake: { command: [process.execPath, path.join(ROOT, "test", "fake-channel.ts")] } } }));
	await p("start", "main");
	assert.equal((await p("send", "main", "installed", "--wait", "--timeout", "30")).stdout.trim(), "echo: installed");
	const doctor = await p("doctor").catch((e) => e);
	assert.match(doctor.stdout, /ok\s+pi 1\.5\.2/);
	assert.match(doctor.stdout, /ok\s+Herdr Core/);
	assert.match(doctor.stdout, /ok\s+agent main: model fake\/echo-1: credentials ready/);
	const mac = process.platform === "darwin";
	assert.match((await p("service", "install")).stdout, mac ? /installed .*local\.pi-personal\.up\.plist/ : /installed .*pi-personal\.timer/);
	const unit = mac ? path.join(userHome, "Library", "LaunchAgents", "local.pi-personal.up.plist") : path.join(t.dir, "config", "systemd", "user", "pi-personal.service");
	const text = fs.readFileSync(unit, "utf8");
	assert.match(text, mac ? /<key>AbandonProcessGroup<\/key><true\/>/ : /KillMode=process/);
	assert.match(text, mac ? /<string>up<\/string><string>--if-running<\/string>/ : /ExecStart=.*core\/cli\.ts up --if-running --home/);
	assert.match(fs.readFileSync(path.join(t.dir, "service.log"), "utf8"), mac ? /bootstrap gui\// : /enable --now pi-personal.timer/);

	const live = () => t.hc("ls").terminals.filter((x: { name?: string }) => x.name?.startsWith("pi-personal-"));
	assert.equal(live().length, 2); // the agent and its channel
	const out = (await p("uninstall")).stdout;
	assert.match(out, /stopped main: (agent, fake|fake, agent)/);
	await sleep(500);
	assert.equal(live().length, 0, "no Pi-personal terminal is left");
	assert.ok(!fs.existsSync(unit), "the service is removed");
	assert.match(fs.readFileSync(path.join(t.dir, "service.log"), "utf8"), mac ? /bootout gui\// : /disable --now pi-personal.timer/);
	assert.ok(!fs.existsSync(command) && !fs.existsSync(dest), "the installed code is removed");
	assert.ok(fs.existsSync(path.join(folder, "AGENTS.md")), "the agent's folder is kept");
	assert.ok(fs.existsSync(path.join(t.home, "agents", "main", "sessions")), "the private area is kept without --purge");
	// With --purge (from the source copy), the private area goes too; the folder still stays.
	await run(process.execPath, [path.join(ROOT, "core", "cli.ts"), "uninstall", "--purge"], { env: { ...env, HOME: userHome } });
	assert.ok(!fs.existsSync(t.home));
	assert.ok(fs.existsSync(path.join(folder, "AGENTS.md")));
	// No runner or pi of this test is left: Herdr Core holds no live terminal.
	assert.equal(t.hc("ls").terminals.length, 0);
});
