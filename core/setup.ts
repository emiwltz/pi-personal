// Installation helpers: doctor, the optional login service, uninstall.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT } from "./name.ts";
import { home, piDir, ROOT } from "./paths.ts";
import { channelProgram, checkExtension, checkModel, foundExtensions, piCli, piPackage } from "./runner.ts";

const HERDR_MIN = "0.1.18"; // the oldest Herdr Core the tests ran against
const NODE_MIN = "22.19.0";

const newer = (a: string, b: string) => {
	const pa = a.split(/[.-]/).map(Number);
	const pb = b.split(/[.-]/).map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	return true; // equal counts as new enough
};

// ---- the login service ----------------------------------------------------------------------------------------

const unitName = COMMAND; // pi-personal.service, pi-personal.timer
const launchLabel = `local.${COMMAND}.up`;
const systemdDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
const launchFile = () => path.join(os.homedir(), "Library", "LaunchAgents", `${launchLabel}.plist`);
const launchctl = (...args: string[]) => spawnSync(process.env[`${ENV}_LAUNCHCTL`] || "launchctl", args, { stdio: "pipe", encoding: "utf8" });
const systemctl = (...args: string[]) => execFileSync(process.env[`${ENV}_SYSTEMCTL`] || "systemctl", ["--user", ...args], { stdio: "pipe", encoding: "utf8" });

function hcPath(): string {
	const set = process.env[`${ENV}_HC`];
	if (set) return set;
	const r = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" });
	const p = r.stdout.trim();
	if (!p) throw new Error("Herdr Core's hc command is not on PATH");
	return p;
}

/** The command the service runs: `up`, with everything it needs spelled out (a service starts with almost no environment). */
function upCommand(): { argv: string[]; env: Record<string, string> } {
	const hc = hcPath();
	return {
		argv: [process.execPath, path.join(ROOT, "core", "cli.ts"), "up", "--if-running", "--home", home()],
		// The PATH of the shell that installed the service: agents started by it get the same tools as from a shell.
		env: { [`${ENV}_HC`]: hc, PATH: [...new Set([path.dirname(hc), path.dirname(process.execPath), ...(process.env.PATH ?? "").split(":").filter(Boolean), "/usr/local/bin", "/usr/bin", "/bin"])].join(":") },
	};
}

function serviceInstall(): string {
	const { argv, env } = upCommand();
	if (process.platform === "darwin") {
		const q = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${launchLabel}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${q(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${q(v)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>${q(path.join(home(), "service.log"))}</string>
</dict></plist>
`;
		fs.mkdirSync(path.dirname(launchFile()), { recursive: true });
		fs.writeFileSync(launchFile(), plist);
		launchctl("bootout", `gui/${process.getuid?.()}/${launchLabel}`);
		const r = launchctl("bootstrap", `gui/${process.getuid?.()}`, launchFile());
		if (r.status !== 0) throw new Error(`launchctl could not load ${launchFile()}: ${r.stderr.trim()}`);
		return `installed ${launchFile()}: runs "${COMMAND} up" at login and every 5 minutes`;
	}
	const dir = systemdDir();
	fs.mkdirSync(dir, { recursive: true });
	const quote = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/["\\]/g, "\\$&")}"` : s);
	fs.writeFileSync(
		path.join(dir, `${unitName}.service`),
		`[Unit]
Description=${PRODUCT}: start the agents that should run
[Service]
Type=oneshot
KillMode=process
${Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`).join("\n")}
ExecStart=${argv.map(quote).join(" ")}
`,
	);
	fs.writeFileSync(
		path.join(dir, `${unitName}.timer`),
		`[Unit]
Description=${PRODUCT}: keep the agents that should run running
[Timer]
OnStartupSec=15s
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
`,
	);
	systemctl("daemon-reload");
	systemctl("enable", "--now", `${unitName}.timer`);
	return `installed ${path.join(dir, `${unitName}.timer`)}: runs "${COMMAND} up" at login and every 5 minutes`;
}

function serviceUninstall(): string[] {
	const removed: string[] = [];
	if (process.platform === "darwin") {
		launchctl("bootout", `gui/${process.getuid?.()}/${launchLabel}`);
		if (fs.existsSync(launchFile())) {
			fs.rmSync(launchFile());
			removed.push(launchFile());
		}
		return removed;
	}
	const dir = systemdDir();
	const timer = path.join(dir, `${unitName}.timer`);
	if (fs.existsSync(timer)) {
		try {
			systemctl("disable", "--now", `${unitName}.timer`);
		} catch {}
	}
	for (const f of [timer, path.join(dir, `${unitName}.service`)])
		if (fs.existsSync(f)) {
			fs.rmSync(f);
			removed.push(f);
		}
	if (removed.length)
		try {
			systemctl("daemon-reload");
		} catch {}
	return removed;
}

function serviceInstalled(): boolean {
	return process.platform === "darwin" ? fs.existsSync(launchFile()) : fs.existsSync(path.join(systemdDir(), `${unitName}.timer`));
}

// ---- doctor ---------------------------------------------------------------------------------------------------

interface Check {
	ok: boolean | "warn";
	what: string;
	detail?: string;
}

export function doctor(): Check[] {
	const checks: Check[] = [];
	const add = (ok: boolean | "warn", what: string, detail?: string) => checks.push({ ok, what, detail });
	add(newer(process.versions.node, NODE_MIN), `Node.js ${process.versions.node}`, newer(process.versions.node, NODE_MIN) ? undefined : `needs ${NODE_MIN} or newer`);
	try {
		const p = piPackage();
		add(true, `pi ${p.version} (Pi-personal's own copy)`, p.dir);
	} catch (err) {
		add(false, "pi", (err as Error).message);
	}
	try {
		const v = herdr.version();
		add(newer(v, HERDR_MIN) ? true : "warn", `Herdr Core ${v}`, newer(v, HERDR_MIN) ? undefined : `tested from ${HERDR_MIN}`);
		const s = herdr.server();
		add(true, `Herdr Core is running (core ${s.id.slice(0, 8)})`);
	} catch (err) {
		add(false, "Herdr Core", (err as Error).message);
	}
	const h = home();
	const mode = fs.existsSync(h) ? fs.statSync(h).mode & 0o777 : undefined;
	add(mode === undefined ? "warn" : (mode & 0o077) === 0, `private area ${h}`, mode === undefined ? "not created yet (it is created by init)" : (mode & 0o077) === 0 ? undefined : `mode ${mode.toString(8)}: should be 700`);
	add(serviceInstalled() ? true : "warn", "login service", serviceInstalled() ? "installed" : `not installed (optional): ${COMMAND} service install`);
	for (const name of agents.list()) {
		let agent: agents.Agent;
		try {
			agent = agents.load(name);
		} catch (err) {
			add(false, `agent ${name}`, (err as Error).message);
			continue;
		}
		add(fs.existsSync(agent.folder), `agent ${name}: folder ${agent.folder}`, fs.existsSync(agent.folder) ? undefined : "missing");
		const known = agent.settings.model ? checkModel(agent.settings.model, fs.existsSync(agent.folder) ? agent.folder : home()) : undefined;
		if (agent.settings.model && known && !known.ok) add(false, `agent ${name}: model ${agent.settings.model}`, `${known.error}; ${COMMAND} models lists the ones you can use`);
		else if (agent.settings.model) {
			const model = agent.settings.model;
			const provider = model.split("/")[0];
			if (known?.warning) add("warn", `agent ${name}: model ${model}`, `${known.warning} (pi passes the id to the provider as it is)`);
			const check = (env: NodeJS.ProcessEnv) =>
				spawnSync(process.execPath, [piCli(), "auth", "check", "--model", model], { encoding: "utf8", env: { ...env, PI_CODING_AGENT_DIR: piDir() } }).status === 0;
			// The agent runs in Herdr Core, with the core's environment, not this shell's: a key exported here may not reach it.
			const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(_API_KEY|_TOKEN|_SECRET)$/.test(k)));
			if (check(bare)) add(true, `agent ${name}: model ${model}`, "credentials ready");
			else if (check(process.env))
				add("warn", `agent ${name}: model ${model}`, `its key is only in this shell's environment, which the agent may not get; store it for all agents: ${COMMAND} login ${provider} --api-key`);
			else add(false, `agent ${name}: model ${model}`, `not signed in: ${COMMAND} login ${provider}`);
		} else add("warn", `agent ${name}: no model set`, `pi will use its default; set "model" in ${path.join(agent.folder, "pi-personal.json")}`);
		for (const e of foundExtensions(agent)) {
			const c = checkExtension(agent, e);
			add(c.ok, `agent ${name}: extension ${e}`, c.ok ? "loads" : c.error);
		}
		// Each channel checks itself (its secrets, its settings): the core knows nothing about any messaging service.
		for (const ch of agents.channels(agent, ROOT)) {
			if (ch.settings.command !== undefined || !agents.shipped(ch.name)) {
				// A program of your own is not run by doctor: it may not know what "check" means.
				add("warn", `agent ${name}: channel ${ch.name}`, `your own program (${ch.command.join(" ")}); if it has a check: ${COMMAND} channel ${name} ${ch.name} check`);
				continue;
			}
			const p = channelProgram(agent, ch.name);
			const r = spawnSync(p.command, [...p.args, "check"], { cwd: p.cwd, env: p.env, encoding: "utf8", timeout: 20_000 });
			const lines = (r.stdout ?? "").split("\n").map((l) => /^(ok|note|FAIL)\s+(.*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m);
			for (const [, level, text] of lines) add(level === "ok" ? true : level === "note" ? "warn" : false, `agent ${name}: channel ${ch.name}: ${text}`);
			if (!lines.length) add(r.status === 0, `agent ${name}: channel ${ch.name}`, r.status === 0 ? "checked" : `its check failed (${r.error?.message ?? `exit code ${r.status}`})`);
		}
		try {
			const s = control.status(name);
			if (s.safeMode) add(false, `agent ${name}: safe mode`, `running without its extensions: ${s.safeMode.reason}`);
			if (s.failed) add(false, `agent ${name}: failed`, s.failed.reason);
		} catch (err) {
			add(false, `agent ${name}: status`, (err as Error).message);
		}
	}
	return checks;
}

// ---- uninstall --------------------------------------------------------------------------------------------------

/** Why the private area must not be deleted as a whole, if it must not. */
function purgeRefusal(): string | undefined {
	const h = home();
	const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
	if (h === path.parse(h).root || inside(os.homedir(), h)) return `${h} is not a folder ${PRODUCT} made (it holds your home folder)`;
	if (!fs.existsSync(path.join(h, "agents")) && !fs.existsSync(path.join(h, "pi"))) return `${h} does not look like ${PRODUCT}'s private area`;
	for (const name of agents.list())
		try {
			const folder = agents.loadRecord(name).folder;
			if (inside(folder, h)) return `the folder of the agent ${name} (${folder}) is inside it; move it out first`;
		} catch {}
	return undefined;
}

export async function uninstall(purge: boolean): Promise<string[]> {
	const done: string[] = [];
	const refusal = purge ? purgeRefusal() : undefined;
	if (refusal) throw new Error(`not deleting the private area: ${refusal}. Nothing was changed`);
	// The service first, so it cannot start agents again while they are being stopped.
	for (const f of serviceUninstall()) done.push(`removed ${f}`);
	for (const name of agents.list()) {
		try {
			const ended = await control.stop(name);
			if (ended.length) done.push(`stopped ${name}: ${ended.join(", ")}`);
		} catch (err) {
			done.push(`could not stop ${name}: ${(err as Error).message}`);
		}
	}
	if (purge) {
		fs.rmSync(home(), { recursive: true, force: true });
		done.push(`deleted the private area ${home()} (conversations, secrets, state)`);
	} else done.push(`kept the private area ${home()} (conversations, secrets); delete it with --purge`);
	const marker = path.join(ROOT, ".installed");
	if (fs.existsSync(marker)) {
		const shim = fs.readFileSync(marker, "utf8").trim();
		if (shim && fs.existsSync(shim)) {
			fs.rmSync(shim);
			done.push(`removed ${shim}`);
		}
		fs.rmSync(ROOT, { recursive: true, force: true });
		done.push(`removed ${ROOT}`);
	}
	done.push("agents' folders were not touched");
	return done;
}

export async function setup(cmd: string, args: string[], opt: Record<string, string | true>): Promise<number> {
	const json = !!opt.json;
	if (cmd === "doctor") {
		const checks = doctor();
		if (json) console.log(JSON.stringify(checks, null, 2));
		else for (const c of checks) console.log(`${c.ok === true ? "ok  " : c.ok === "warn" ? "note" : "FAIL"}  ${c.what}${c.detail ? `: ${c.detail}` : ""}`);
		return checks.some((c) => c.ok === false) ? 1 : 0;
	}
	if (cmd === "service") {
		const sub = args[0];
		if (sub === "install") console.log(serviceInstall());
		else if (sub === "uninstall") console.log(serviceUninstall().map((f) => `removed ${f}`).join("\n") || "no service was installed");
		else if (sub === "status") console.log(serviceInstalled() ? "installed" : "not installed");
		else throw new Error(`usage: ${COMMAND} service install|uninstall|status`);
		return 0;
	}
	if (cmd === "uninstall") {
		for (const line of await uninstall(!!opt.purge)) console.log(line);
		return 0;
	}
	throw new Error(`unknown command ${cmd}`);
}
