// Installation helpers: doctor, the optional login service, uninstall.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT, SETTINGS_FILE, SLUG } from "./name.ts";
import { home, piDir, ROOT } from "./paths.ts";
import { channelProgram, checkExtension, checkModel, foundExtensions, piCli, piPackage } from "./runner.ts";

const NODE_MIN = "22.19.0";

// ---- coming back after a restart of the machine -------------------------------------------------------------
// The login service starts Herdr Core only when Pi-Personal installed it (then nothing else of the person's runs in
// it), or the person said yes in pp setup (this file); and once per start of the machine.
const bootFile = () => path.join(home(), "start-herdr-core-at-boot");
/** May the service start Herdr Core: Pi-Personal installed it, or the person said yes (the file). */
export const bootAllowed = () => fs.existsSync(bootFile()) || herdr.installedByUs();
/** This start of the machine: Linux's boot id, macOS's boot time. "" when unknown (then the service starts nothing). */
export function bootId(): string {
	try {
		if (process.platform === "linux") return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000 }).stdout.trim();
	} catch {
		return "";
	}
}
const startedFor = () => path.join(home(), "herdr-core-started-for-boot");
/**
 * Should the service start Herdr Core now? Only when it may, once per start of the machine (a Herdr Core stopped
 * since, by the person or anything else, stays stopped until the next one), and when an agent should run.
 */
export function bootStartDue(): { due: boolean; why: string } {
	if (!bootAllowed()) return { due: false, why: "not allowed (pp setup can allow it)" };
	const id = bootId();
	if (!id) return { due: false, why: "this machine's start cannot be told apart" };
	if (fs.existsSync(startedFor()) && fs.readFileSync(startedFor(), "utf8").trim() === id) return { due: false, why: "it was started once since this machine started, and stopped since" };
	const wanted = agents.list().some((n) => {
		try {
			return !fs.existsSync(agents.loadRecord(n).paths.stopped);
		} catch {
			return false;
		}
	});
	if (!wanted) return { due: false, why: "no agent should run" };
	return { due: true, why: "" };
}
export function bootStarted(): void {
	fs.writeFileSync(startedFor(), `${bootId()}\n`, { mode: 0o600 });
}
export function allowBoot(yes: boolean): void {
	if (!yes) return fs.rmSync(bootFile(), { force: true });
	fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
	fs.writeFileSync(bootFile(), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

// ---- the login service ----------------------------------------------------------------------------------------

const unitName = SLUG; // pi-personal.service, pi-personal.timer
const launchLabel = `local.${SLUG}.up`;
const systemdDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
const launchFile = () => path.join(os.homedir(), "Library", "LaunchAgents", `${launchLabel}.plist`);
const launchctl = (...args: string[]) => spawnSync(process.env[`${ENV}_LAUNCHCTL`] || "launchctl", args, { stdio: "pipe", encoding: "utf8" });
const systemctl = (...args: string[]) => execFileSync(process.env[`${ENV}_SYSTEMCTL`] || "systemctl", ["--user", ...args], { stdio: "pipe", encoding: "utf8" });

function hcPath(): string {
	const found = herdr.find();
	if (!found) throw new Error(`Herdr Core's hc command was not found: ${COMMAND} setup installs it`);
	return herdr.fullPath(found.bin);
}

/** The command the service runs: `up`, with everything it needs spelled out (a service starts with almost no environment). */
function upCommand(): { argv: string[]; env: Record<string, string> } {
	const hc = hcPath();
	// An installed copy runs its pp command, which finds the Node.js the installer chose even after an update moved it.
	const marker = path.join(ROOT, ".installed");
	const shim = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").split("\n")[0].trim() : "";
	const run = shim && fs.existsSync(shim) ? [shim] : [process.execPath, path.join(ROOT, "core", "cli.ts")];
	return {
		argv: [...run, "up", "--if-running", "--home", home()],
		// The PATH of the shell that installed the service: agents started by it get the same tools as from a shell.
		env: {
			// Which Herdr Core: the selection of the shell that installed the service, when it made one.
			...Object.fromEntries(["HC_SESSION", "HC_SOCKET", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", ...(process.platform === "darwin" ? ["XDG_RUNTIME_DIR"] : [])].filter((k) => process.env[k]).map((k) => [k, process.env[k] as string])),
			[`${ENV}_HC`]: hc,
			PATH: [...new Set([path.dirname(hc), path.dirname(process.execPath), ...(process.env.PATH ?? "").split(":").filter(Boolean), "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
		},
	};
}

export function serviceInstall(): string {
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
	allowBoot(false); // without the service, the permission means nothing: asked again with the next one
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

export function serviceInstalled(): boolean {
	return process.platform === "darwin" ? fs.existsSync(launchFile()) : fs.existsSync(path.join(systemdDir(), `${unitName}.timer`));
}

// ---- doctor ---------------------------------------------------------------------------------------------------

interface Check {
	ok: boolean | "warn";
	what: string;
	detail?: string;
	topic: string; // what it is about: printed as a heading, in this order
}

export async function doctor(): Promise<Check[]> {
	const checks: Check[] = [];
	let topic = "This machine";
	const add = (ok: boolean | "warn", what: string, detail?: string) => checks.push({ ok, what, detail, topic });
	const nodeOk = herdr.atLeast(process.versions.node, NODE_MIN);
	add(nodeOk, `Node.js ${process.versions.node}`, nodeOk ? undefined : `needs ${NODE_MIN} or newer`);
	try {
		const p = piPackage();
		add(true, `pi ${p.version} (Pi-Personal's own copy)`, p.dir);
	} catch (err) {
		add(false, "pi", (err as Error).message);
	}
	const h = home();
	const mode = fs.existsSync(h) ? fs.statSync(h).mode & 0o777 : undefined;
	add(mode === undefined ? "warn" : (mode & 0o077) === 0, `private area ${h}`, mode === undefined ? "not created yet (it is created by init)" : (mode & 0o077) === 0 ? undefined : `mode ${mode.toString(8)}: should be 700`);
	topic = "Herdr Core";
	const hc = herdr.find();
	if (!hc) add(false, "Herdr Core", `not found: ${COMMAND} setup installs it`);
	else {
		const v = hc.version;
		add(herdr.atLeast(v, herdr.MIN_VERSION) ? true : "warn", `Herdr Core ${v}`, herdr.atLeast(v, herdr.MIN_VERSION) ? undefined : `tested from ${herdr.MIN_VERSION}: hc update`);
		if (!(await herdr.isRunning())) add("warn", "Herdr Core is not running", `${COMMAND} start starts it`);
		else
			try {
				add(true, `Herdr Core is running (core ${herdr.server().id.slice(0, 8)})`);
			} catch (err) {
				add(false, "Herdr Core", (err as Error).message);
			}
	}
	topic = "Coming back by itself";
	add(serviceInstalled() ? true : "warn", "login service", serviceInstalled() ? "installed" : `not installed (optional): ${COMMAND} service install`);
	if (!serviceInstalled()) add("warn", "after a restart of this machine", `Herdr Core and the agents are started by you (${COMMAND} start)`);
	else if (!bootAllowed()) add("warn", "after a restart of this machine", `Herdr Core is started by you (${COMMAND} start); ${COMMAND} setup can let the login service do it`);
	else if (herdr.stopsAtLogout()) add("warn", "after a restart of this machine", `the login service starts Herdr Core, then the agents, once you log in; without logging in: sudo loginctl enable-linger ${os.userInfo().username}`);
	else add(true, "after a restart of this machine", "the login service starts Herdr Core, then the agents");
	for (const name of agents.list()) {
		topic = `Agent ${name}`;
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
		} else add("warn", `agent ${name}: no model set`, `pi will use its default; set "model" in ${path.join(agent.folder, SETTINGS_FILE)}`);
		for (const e of foundExtensions(agent)) {
			const c = checkExtension(agent, e);
			add(c.ok, `agent ${name}: extension ${e}`, c.ok ? "loads" : c.error);
		}
		// Each channel checks itself (its secrets, its settings): the core knows nothing about any messaging service.
		for (const ch of agents.channels(agent)) {
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
			if (s.safeMode) add(false, `agent ${name}: safe mode`, `running with extensions off: ${s.safeMode.reason}`);
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
		// One installed command per line: `pp`, and the same command under its long name.
		// Only files that still are Pi-Personal's command (another program may have taken the name since).
		const ours = (f: string) => {
			try {
				return fs.lstatSync(f).isSymbolicLink() || fs.readFileSync(f, "utf8").toLowerCase().includes("pi-personal's command"); // "Pi-personal" until 0.3.0
			} catch {
				return false;
			}
		};
		for (const shim of fs.readFileSync(marker, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
			if (ours(shim)) {
				fs.rmSync(shim, { force: true });
				done.push(`removed ${shim}`);
			}
		fs.rmSync(ROOT, { recursive: true, force: true });
		done.push(`removed ${ROOT}`);
		// The PATH line the installer added, and only that line.
		for (const rc of [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((f) => path.join(os.homedir(), f))) {
			let text: string;
			try {
				text = fs.readFileSync(rc, "utf8");
			} catch {
				continue;
			}
			const kept = text.split("\n").filter((l) => !l.toLowerCase().includes("# added by pi-personal's installer")); // "Pi-personal" until 0.3.0
			if (kept.length !== text.split("\n").length) {
				fs.writeFileSync(rc, kept.join("\n"));
				done.push(`removed the PATH line from ${rc}`);
			}
		}
		done.push("kept Herdr Core (it is Herdr's: hc server stop stops it)");
	}
	done.push("agents' folders were not touched");
	return done;
}

export async function maintain(cmd: string, args: string[], opt: Record<string, string | true>): Promise<number> {
	const json = !!opt.json;
	if (cmd === "doctor") {
		const checks = await doctor();
		if (json) console.log(JSON.stringify(checks, null, 2));
		else {
			// One heading per topic, then its lines; the levels as before (ok, note, FAIL), which scripts can read.
			let last = "";
			for (const c of checks) {
				if (c.topic !== last) console.log(`${last ? "\n" : ""}${c.topic}`);
				last = c.topic;
				console.log(`  ${c.ok === true ? "ok  " : c.ok === "warn" ? "note" : "FAIL"}  ${c.what}${c.detail ? `: ${c.detail}` : ""}`);
			}
			const bad = checks.filter((c) => c.ok === false).length;
			console.log(`\n${bad ? `${bad} to fix: each FAIL line says what to do.` : "Nothing to fix."}`);
		}
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
