// Install, run, uninstall: no Pi-Personal process or service remains, and the agent's folder is kept.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Env, ROOT, run, setup, sleep } from "./helpers.ts";

let t: Env;
before(async () => (t = await setup("a15")));
after(async () => t.close());

test("install.sh, doctor, service, uninstall", async () => {
	const dest = path.join(t.dir, "install");
	const bin = path.join(t.dir, "bin");
	// The service manager is replaced by a script that only records its arguments: no real service is ever installed.
	const fakeManager = path.join(t.dir, "service-manager");
	fs.writeFileSync(fakeManager, `#!/bin/sh\necho "$@" >> ${t.dir}/service.log\n`, { mode: 0o755 });
	const env = { ...t.env, PI_PERSONAL_NO_SETUP: "1", PI_PERSONAL_INSTALL_DIR: dest, PI_PERSONAL_BIN_DIR: bin, PI_PERSONAL_SYSTEMCTL: fakeManager, PI_PERSONAL_LAUNCHCTL: fakeManager };
	const userHome = path.join(t.dir, "userhome"); // where macOS's LaunchAgents folder goes in this test
	fs.mkdirSync(userHome, { recursive: true });
	await run(path.join(ROOT, "install.sh"), [], { env, timeout: 300_000 });
	const command = path.join(bin, "pp");
	assert.equal(fs.readFileSync(path.join(bin, "pi-personal"), "utf8"), fs.readFileSync(command, "utf8").replace("PI_PERSONAL_COMMAND:=pp}", "PI_PERSONAL_COMMAND:=pi-personal}"), "the long name is the same command, which knows its name");
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
	// The installed copy's service runs its pp command, which finds the Node.js the installer chose even after an update.
	assert.match(text, mac ? /<string>[^<]*\/pp<\/string><string>up<\/string><string>--if-running<\/string>/ : /ExecStart=\S*\/pp up --if-running --home/);
	assert.match(fs.readFileSync(path.join(t.dir, "service.log"), "utf8"), mac ? /bootstrap gui\// : /enable --now pi-personal.timer/);

	const live = () => t.hc("ls").terminals.filter((x: { name?: string }) => x.name?.startsWith("pi-personal-"));
	assert.equal(live().length, 2); // the agent and its channel
	// Installs up to 0.3.0 wrote the name "Pi-personal" in their marks: they are still recognised and removed.
	const longName = path.join(bin, "pi-personal");
	fs.writeFileSync(longName, fs.readFileSync(longName, "utf8").replaceAll("Pi-Personal's command", "Pi-personal's command"));
	const profile = path.join(userHome, ".profile");
	fs.writeFileSync(profile, `export KEEP=1\nexport PATH="${bin}:$PATH" # added by Pi-personal's installer\n`);
	const out = (await p("uninstall")).stdout;
	assert.match(out, /stopped main: (agent, fake|fake, agent)/);
	await sleep(500);
	assert.equal(live().length, 0, "no Pi-Personal terminal is left");
	assert.ok(!fs.existsSync(unit), "the service is removed");
	assert.match(fs.readFileSync(path.join(t.dir, "service.log"), "utf8"), mac ? /bootout gui\// : /disable --now pi-personal.timer/);
	assert.ok(!fs.existsSync(command) && !fs.existsSync(dest), "the installed code is removed");
	assert.ok(!fs.lstatSync(longName, { throwIfNoEntry: false }), "the long name is removed too, with its 0.3.0 mark");
	assert.equal(fs.readFileSync(profile, "utf8"), "export KEEP=1\n", "the 0.3.0 PATH line goes, the rest stays");
	assert.ok(fs.existsSync(path.join(folder, "AGENTS.md")), "the agent's folder is kept");
	assert.ok(fs.existsSync(path.join(t.home, "agents", "main", "sessions")), "the private area is kept without --purge");
	// With --purge (from the source copy), the private area goes too; the folder still stays.
	await run(process.execPath, [path.join(ROOT, "core", "cli.ts"), "uninstall", "--purge"], { env: { ...env, HOME: userHome } });
	assert.ok(!fs.existsSync(t.home));
	assert.ok(fs.existsSync(path.join(folder, "AGENTS.md")));
	// No runner or pi of this test is left: Herdr Core holds no live terminal.
	assert.equal(t.hc("ls").terminals.length, 0);
});
