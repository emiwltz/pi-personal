#!/usr/bin/env node
// The command line. Human-readable output by default, JSON with --json where it makes sense.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT } from "./name.ts";
import { defaultFolderParent, piDir, privateDir, ROOT } from "./paths.ts";
import * as port from "./port.ts";
import { channelProgram, checkExtension, checkModel, dryStart, extensionPath, extensionsDir, foundExtensions, lockFile, lockHolder, piCli, piPackage, runForever } from "./runner.ts";

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;

const HELP = `${PRODUCT} ${VERSION}: personal agents that live in Herdr Core and answer on any channel.

Usage: ${COMMAND} <command> [options]

Agents
  init <name> [folder] --model <provider/id>   create an agent (or adopt a folder copied from elsewhere)
  start <name>                                 start it and its channels; says when pi is ready
  stop <name>                                  stop it and its channels, and keep it stopped
  restart <name>                               stop and start again (also leaves safe mode)
  status [name]                                what each agent and channel is doing, and why
  attach <name>                                take over the agent's terminal (ctrl+\\ to leave)
  up [--if-running]                            start every agent that should run (the login service runs this;
                                               --if-running: only if Herdr Core already runs)

Messages
  send <name> "<text>" [--wait] [--conversation <c>] [--id <id>] [--timeout <s>]
                                               quote the text (or put it after --); the answer goes to the
                                               conversation, which a channel routes (default: cli)
  follow <name>                                print the agent's events as they come
  chat <name>                                  talk to the agent here (the local channel)

Setup
  login <provider> [--api-key] [--no-browser]  sign in to a model provider (shared by all agents)
  models [search]                              list the models you can use with --model
  pi <args...>                                 run Pi-personal's own pi with its settings (packages, config...)
  secret set <name> <key>                      store a secret for an agent's channels (typed or piped, never shown)
  channel add <name> <channel> [-- <command...>]
                                               turn a channel on (a shipped one, or your own program after --)
  channel remove <name> <channel>              turn it off
  channel <name> <channel> <command...>        a channel's own commands (Telegram: who, allow <id>, deny <id>, check)
  ext check <name> [extension]                 the agent's extensions (<folder>/.pi/extensions/) and whether they load
  service install|uninstall|status             start agents when you log in (optional)
  doctor                                       check the installation
  log <name>                                   the keeper's log for this agent
  port <name>                                  print the folder of the agent's port
  uninstall [--purge]                          stop everything and remove the service (--purge: the private area too)

Options: --json (machine-readable output), --home <dir> (another private area), -h, --version.`;

const VALUE_OPTIONS = ["model", "id", "timeout", "home", "conversation"];
const FLAGS = ["json", "wait", "if-running", "purge", "help", "version"];
const PASSTHROUGH = ["login", "pi", "channel", "_run"]; // their options belong to the program they run

function parse(argv: string[]) {
	const pos: string[] = [];
	const opt: Record<string, string | true> = {};
	let rest: string[] | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		// pi's and a channel's own commands: everything after belongs to them, options included (--help too).
		if ((pos[0] === "pi" || pos[0] === "login") && pos.length === 1) break;
		if (pos[0] === "channel" && pos.length === 3 && pos[1] !== "add" && pos[1] !== "remove") {
			rest = argv[i] === "--" ? argv.slice(i + 1) : argv.slice(i);
			break;
		}
		if (a === "--") {
			rest = argv.slice(i + 1); // everything after -- is taken as it is
			break;
		}
		if (a === "-h" && !(pos[0] === "send" && pos.length >= 2)) opt.help = true;
		else if (a === "-h") pos.push(a); // part of the text to send
		else if (a.startsWith("--") && a.length > 2) {
			const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
			if (VALUE_OPTIONS.includes(key)) {
				const v = inline ?? argv[++i];
				if (v === undefined) throw new UsageError(`--${key} needs a value`);
				opt[key] = v;
			} else if (FLAGS.includes(key) || PASSTHROUGH.includes(pos[0])) opt[key] = true;
			else throw new UsageError(`unknown option --${key}${pos[0] === "send" ? ` (to send it as text, quote the message: ${COMMAND} send <name> "...")` : ""}`);
		} else pos.push(a);
	}
	return { pos, opt, rest };
}

class UsageError extends Error {}
const PROVIDERS = () =>
	`For example: ${COMMAND} login anthropic, ${COMMAND} login openai, ${COMMAND} login openrouter. Every provider: ${path.join(piPackage().dir, "docs", "providers.md")}`;
const out = (json: boolean, value: unknown, human: () => string) => console.log(json ? JSON.stringify(value, null, 2) : human());
function need(v: string | undefined, what: string): string {
	if (!v) throw new UsageError(`missing ${what}. "${COMMAND} help" lists the commands`);
	return v;
}
const tilde = (p: string) => (process.env.HOME && p.startsWith(`${process.env.HOME}/`) ? `~${p.slice(process.env.HOME.length)}` : p);

type Row = control.AgentStatus | { name: string; error: string };
/** One agent's status; a broken agent shows its error instead of breaking the list. */
function statusOf(name: string): Row {
	try {
		return control.status(name);
	} catch (err) {
		return { name, error: (err as Error).message };
	}
}

function describe(row: Row, full: boolean): string {
	if ("error" in row) return `${row.name}  ERROR: ${row.error}`;
	const s = row;
	const lines: string[] = [];
	const flags = [s.safeMode ? "SAFE MODE" : "", s.settingsError ? "SETTINGS ERROR" : "", ...s.channels.filter((c) => c.failed).map((c) => `channel ${c.name} FAILED`)].filter(Boolean);
	lines.push(`${s.name}  ${s.failed ? "FAILED" : s.state === "blocked" ? "waiting for a person" : s.state}${flags.length ? ` (${flags.join(", ")})` : ""}${s.model ? `  ${s.model}` : ""}  ${tilde(s.folder)}`);
	if (!full) return lines[0];
	if (s.question) lines.push(`  waiting for a person: ${s.question}`);
	if (s.elsewhere) lines.push(`  runs in another terminal or Herdr Core (runner pid ${s.elsewhere})`);
	if (s.settingsError) lines.push(`  SETTINGS ERROR: ${s.settingsError}`);
	for (const p of s.problems ?? []) lines.push(`  SETTINGS: ${p}`);
	if (s.safeMode)
		lines.push(`  SAFE MODE: running without its extensions: ${s.safeMode.reason}. Fix them; it leaves safe mode at its next start, or now with: ${COMMAND} restart ${s.name}`);
	if (s.failed) lines.push(`  FAILED: ${s.failed.reason}; next attempt ${s.failed.retryAt}. To try again now: ${COMMAND} restart ${s.name}`);
	if (s.lastError) lines.push(`  last error (${s.lastError.at}): ${s.lastError.error}`);
	if (s.lastRestart) lines.push(`  last restart (${s.lastRestart.at}): ${s.lastRestart.reason}`);
	if (s.pending) lines.push(`  ${s.pending} message(s) waiting in the port`);
	if (s.address) lines.push(`  terminal ${s.address}`);
	for (const c of s.channels) {
		lines.push(`  channel ${c.name}  ${c.failed ? "FAILED" : c.state}`);
		if (c.failed) lines.push(`    FAILED: ${c.failed.reason}; next attempt ${c.failed.retryAt}`);
		if (c.lastRestart) lines.push(`    last restart (${c.lastRestart.at}): ${c.lastRestart.reason}`);
	}
	return lines.join("\n");
}

function show(e: port.PortEvent): string {
	const t = e.at ? new Date(String(e.at)).toTimeString().slice(0, 8) : ""; // local time
	const who = e.channel ? `[${e.channel}] ` : "";
	switch (e.type) {
		case "message":
			return `${t} ${who}agent: ${e.text}`;
		case "input":
			return `${t} ${who}typed in the terminal: ${e.text}`;
		case "error":
			return `${t} ${who}trouble: ${e.error}`;
		case "settled": {
			const ids = ((e.refs as port.Ref[] | undefined) ?? []).map((r) => r.id).join(", ") || "terminal";
			return `${t} ${who}done with ${ids}${e.error ? `: could not answer: ${e.error}` : ""}`;
		}
		case "status":
			return `${t} ${who}status ${e.state}${e.question ? `: ${e.question}` : ""}`;
		default: {
			const { at: _a, type, cursor: _c, after: _f, ...rest } = e as Record<string, unknown>;
			return `${t} ${who}${type} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}`.trimEnd();
		}
	}
}

/** Read one line from the terminal without showing it. */
function askHidden(prompt: string): Promise<string> {
	return new Promise((resolve) => {
		process.stdout.write(prompt);
		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		let value = "";
		const done = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
			process.stdout.write("\n");
			resolve(value);
		};
		const onData = (buf: Buffer) => {
			for (const ch of buf.toString("utf8")) {
				if (ch === "\r" || ch === "\n") return done();
				if (ch === "\u0003") process.exit(130); // Ctrl+C
				if (ch === "\u007f") value = value.slice(0, -1);
				else if (ch >= " ") value += ch;
			}
		};
		stdin.on("data", onData);
	});
}

async function send(name: string, text: string, opt: Record<string, string | true>): Promise<number> {
	const agent = agents.loadRecord(name);
	const id = typeof opt.id === "string" ? opt.id : `cli-${randomUUID()}`;
	// The conversation is the only address: the channel that owns it (by its prefix, "<channel>:...") routes the answer.
	const conversation = typeof opt.conversation === "string" ? opt.conversation : "cli";
	const timeout = Number(opt.timeout ?? 600);
	if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError("--timeout takes a number of seconds");
	let cannotStart: string | undefined;
	const msg: port.Message = { id, text, conversation };
	const start = port.end(agent.paths.port);
	const r = port.submit(agent.paths.port, msg);
	const running = control.find(agent) !== undefined || lockHolder(lockFile(agent)) !== undefined; // here, or in another Herdr Core
	if (!running) console.error(`note: ${name} is not running; the message waits in its port until: ${COMMAND} start ${name}`);
	if (!opt.wait) {
		out(!!opt.json, { id, result: r }, () => (r === "accepted" ? id : `${id} (duplicate: already sent)`));
		return 0;
	}
	if (!running) return 1;
	const failed = control.status(name).failed;
	if (failed) {
		console.error(`${COMMAND}: ${name} cannot start: ${failed.reason}. The message waits in its port (${id}); next attempt ${failed.retryAt}, or now: ${COMMAND} restart ${name}`);
		return 1;
	}
	// Resending an id already sent (a script retried after a crash): show what the agent answered, from the start of
	// the events file, so a retry is always safe.
	const followFrom = r === "duplicate" ? 0 : start;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeout * 1000);
	const said: string[] = [];
	const errors: string[] = [];
	let settledError: string | undefined;
	let done = false;
	let duplicate = false;
	let stopped = false;
	let taken = false;
	await port.follow(
		agent.paths.port,
		followFrom,
		(e) => {
			const mine = Array.isArray(e.refs) && (e.refs as port.Ref[]).some((x) => x.id === id);
			if (e.type === "message" && mine) {
				said.push(String(e.text));
				if (!opt.json) console.log(e.text);
			}
			if (e.type === "error" && mine) {
				errors.push(String(e.error));
				if (!opt.json) console.error(`${COMMAND}: the agent reports: ${e.error}`);
			}
			if (e.type === "settled" && mine) {
				settledError = e.error ? String(e.error) : undefined;
				return (done = true);
			}
			if (e.type === "duplicate" && e.id === id && r === "accepted") return (duplicate = done = true);
			if (e.type === "taken" && e.id === id) taken = true;
			// Only what happens from now on counts (a resent id reads the history from its start).
			if (e.cursor < start || e.channel) return;
			// Stopped while the message waited for its turn: it waits in the port until the agent starts again. (Taken
			// already, it is closed with an error by its settled.)
			if (e.type === "stopped" && !taken) return (stopped = true);
			// The agent cannot start (it gave up for now): waiting longer would only hide it.
			if (e.type === "failed") {
				cannotStart = String(e.reason);
				return true;
			}
		},
		ac.signal,
	);
	clearTimeout(timer);
	if (opt.json) console.log(JSON.stringify({ id, result: r, said, errors, settled: done, ...(settledError ? { error: settledError } : cannotStart ? { error: cannotStart } : {}) }));
	if (cannotStart) {
		console.error(`${COMMAND}: ${name} cannot start: ${cannotStart}. The message waits in its port (${id}); see: ${COMMAND} status ${name}`);
		return 1;
	}
	if (stopped) {
		console.error(`${COMMAND}: ${name} was stopped before your message's turn; it waits in its port (${id}) until: ${COMMAND} start ${name}`);
		return 1;
	}
	if (!done) {
		console.error(`${COMMAND}: no answer within ${timeout} s; the message stays with the agent (${id})`);
		return 1;
	}
	if (duplicate) {
		if (!opt.json) console.error(`${COMMAND}: ${id} was already taken earlier; its answer is in the agent's history (${COMMAND} follow ${name} shows what comes next)`);
		return 0;
	}
	// Every message ends with a reply or an error: no full reply is a failure, whatever the reason.
	if (settledError || !said.length) {
		const why = settledError ?? errors.at(-1) ?? "the agent finished without a reply";
		if (!opt.json && !errors.includes(why)) console.error(`${COMMAND}: ${said.length ? "no full reply" : "no reply"}: ${why}`);
		return 1;
	}
	return 0;
}

async function startCmd(name: string, json: boolean, restart = false): Promise<number> {
	const r = restart ? await control.restart(name) : await control.start(name);
	const lines: string[] = [];
	if (r.skipped) lines.push(`${name}: ${r.skipped}`);
	if (r.started.includes("agent")) lines.push(r.ready ? `${name}: started; pi is ready` : `${name}: started, but ${r.trouble}`);
	const channelsStarted = r.started.filter((x) => x !== "agent");
	if (channelsStarted.length) lines.push(`${name}: started channel${channelsStarted.length > 1 ? "s" : ""} ${channelsStarted.join(", ")}`);
	if (r.running.length) lines.push(`${name}: already running: ${r.running.join(", ")}`);
	if (r.elsewhere.length) lines.push(`${name}: running in another terminal or Herdr Core: ${r.elsewhere.join(", ")}`);
	if (!restart) {
		const s = control.status(name);
		if (s.failed) lines.push(`${name} is FAILED (${s.failed.reason}); next attempt ${s.failed.retryAt}. To try again now: ${COMMAND} restart ${name}`);
	}
	out(json, r, () => lines.join("\n"));
	return r.ready === false ? 1 : 0;
}

const editSettings = (agent: agents.AgentRecord, change: (s: agents.Settings) => void) => agents.editSettings(agent.folder, change);

async function main(argv: string[]): Promise<number> {
	const { pos, opt, rest } = parse(argv);
	if (typeof opt.home === "string") process.env[`${ENV}_HOME`] = opt.home;
	const json = !!opt.json;
	const [cmd, a, b] = pos;
	if (opt.version && !cmd) {
		let hc = "not found";
		try {
			hc = herdr.version();
		} catch {}
		const pi = piPackage().version;
		out(json, { version: VERSION, pi, herdrCore: hc, node: process.versions.node }, () => `${PRODUCT} ${VERSION} (pi ${pi}, Herdr Core ${hc}, Node ${process.versions.node})`);
		return 0;
	}
	if (opt.help || cmd === undefined || cmd === "help") {
		console.log(HELP);
		return 0;
	}
	switch (cmd) {
		case "init": {
			const name = need(a, "agent name");
			agents.validateName(name);
			const model = opt.model;
			if (typeof model !== "string")
				throw new UsageError(`choose the model with --model <provider/id>, for example --model anthropic/claude-haiku-5-5. To list them: ${COMMAND} models`);
			const folder = agents.checkFolder(name, b ?? path.join(defaultFolderParent(), name));
			// pi checks the model without a network or credentials: an unknown provider is refused here, not at start.
			const known = checkModel(model, process.cwd());
			if (!known.ok) throw new UsageError(`${known.error}. To list the models: ${COMMAND} models (after ${COMMAND} login <provider>)`);
			const agent = agents.init(name, folder, { model });
			if (known.warning) console.error(`note: ${known.warning}; pi will pass this id to the provider as it is. Check the spelling: ${COMMAND} models ${model.split("/")[0]}`);
			out(json, { name, folder: agent.folder }, () =>
				[
					`Created ${name} in ${tilde(agent.folder)}`,
					`  its instructions: ${tilde(path.join(agent.folder, "AGENTS.md"))}`,
					`  sign in once:     ${COMMAND} login ${model.split("/")[0]}`,
					`  start it:         ${COMMAND} start ${name}`,
					`  talk to it:       ${COMMAND} chat ${name}`,
				].join("\n"),
			);
			return 0;
		}
		case "status": {
			const rows = (a ? [a] : agents.list()).map(statusOf);
			out(json, a ? rows[0] : rows, () => (rows.length ? rows.map((r) => describe(r, !!a)).join("\n") : `no agents yet: ${COMMAND} init <name> --model <provider/id>`));
			return rows.some((r) => "error" in r) ? 1 : 0;
		}
		case "start":
			return startCmd(need(a, "agent name"), json);
		case "restart":
			return startCmd(need(a, "agent name"), json, true);
		case "up": {
			// The login service runs `up --if-running`: it must never be the one that starts the user's Herdr Core
			// (a core started from a service gets the service's bare environment, and could die with the service).
			if (opt["if-running"] && !(await herdr.isRunning())) {
				console.log("Herdr Core is not running: nothing started (it will be tried again later)");
				return 0;
			}
			const rs = control.upAll();
			out(json, rs, () =>
				rs
					.map(
						(r) =>
							`${r.agent}: ${r.error ? `FAILED to start: ${r.error}` : r.skipped ? `skipped (${r.skipped})` : r.started.length ? `started ${r.started.join(", ")}` : r.elsewhere.length ? `running elsewhere: ${r.elsewhere.join(", ")}` : "running"}`,
					)
					.join("\n") || "no agents",
			);
			return rs.some((r) => r.error) ? 1 : 0;
		}
		case "stop": {
			const name = need(a, "agent name");
			const ended = await control.stop(name);
			out(json, { stopped: ended }, () => (ended.length ? `${name}: stopped ${ended.join(", ")}` : `${name} was not running; it stays stopped`));
			return 0;
		}
		case "attach": {
			const agent = agents.loadRecord(need(a, "agent name"));
			const t = control.find(agent);
			if (!t) throw new Error(`${agent.name} is not running: ${COMMAND} start ${agent.name}`);
			console.error("Leave with ctrl+\\ (Ctrl+D or /quit would quit pi; Pi-personal would start it again).");
			return spawnSync(process.env[`${ENV}_HC`] || "hc", ["attach", t.address], { stdio: "inherit" }).status ?? 1;
		}
		case "send": {
			const name = need(a, "agent name");
			const text = [...pos.slice(2), ...(rest ?? [])].join(" ");
			return send(name, need(text, "message text"), opt);
		}
		case "follow": {
			const agent = agents.loadRecord(need(a, "agent name"));
			await port.follow(agent.paths.port, port.end(agent.paths.port), (e) => {
				const { after: _a, ...ev } = e;
				console.log(json ? JSON.stringify(ev) : show(e));
			});
			return 0;
		}
		case "chat": {
			const agent = agents.loadRecord(need(a, "agent name"));
			if (!control.find(agent)) console.error(`note: ${agent.name} is not running; start it with: ${COMMAND} start ${agent.name}`);
			const r = spawnSync(process.execPath, [path.join(ROOT, "channels", "local", "chat.ts")], {
				stdio: "inherit",
				env: { ...process.env, [`${ENV}_PORT`]: agent.paths.port },
			});
			return r.status ?? 1;
		}
		case "port":
			console.log(agents.loadRecord(need(a, "agent name")).paths.port);
			return 0;
		case "log": {
			const agent = agents.loadRecord(need(a, "agent name"));
			process.stdout.write(fs.existsSync(agent.paths.log) ? fs.readFileSync(agent.paths.log, "utf8") : "");
			return 0;
		}
		case "login": {
			// Everything after "login" goes to pi as it is (the provider, --api-key, --no-browser...).
			const args = argv.slice(argv.indexOf("login") + 1).filter((x, i, all) => x !== "--home" && all[i - 1] !== "--home" && !x.startsWith("--home="));
			if (!args.length) throw new UsageError(`usage: ${COMMAND} login <provider> [--api-key] [--no-browser]. ${PROVIDERS()}`);
			privateDir(piDir());
			return spawnSync(process.execPath, [piCli(), "auth", "login", ...args], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: piDir() } }).status ?? 1;
		}
		case "pi": {
			// Pi-personal's pinned pi, with the settings folder all agents share (packages, MCP servers, models, sign-ins).
			const args = argv.slice(argv.indexOf("pi") + 1).filter((x, i, all) => x !== "--home" && all[i - 1] !== "--home" && !x.startsWith("--home="));
			privateDir(piDir());
			return spawnSync(process.execPath, [piCli(), ...args], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: piDir() } }).status ?? 1;
		}
		case "models": {
			privateDir(piDir());
			const r = spawnSync(process.execPath, [piCli(), "--list-models", ...(a ? [a] : [])], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: piDir() } });
			// pi lists the models of the providers you are signed in to; before any login, say how (pi's own hint names its /login).
			if (/No models available/.test(`${r.stdout}${r.stderr}`)) {
				console.log(`No models yet: sign in to a provider first, then run "${COMMAND} models" again. ${PROVIDERS()}`);
				return 1;
			}
			process.stdout.write(r.stdout ?? "");
			process.stderr.write(r.stderr ?? "");
			return r.status ?? 1;
		}
		case "secret": {
			if (a !== "set") throw new UsageError(`usage: ${COMMAND} secret set <agent> <key>`);
			const agent = agents.loadRecord(need(b, "agent name"));
			const key = need(pos[3], "secret name");
			if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new UsageError("secret names use A-Z a-z 0-9 . _ -");
			const value = (process.stdin.isTTY ? await askHidden(`Paste the value for ${key} (it is not shown), then press Enter: `) : fs.readFileSync(0, "utf8")).trim();
			if (!value) throw new UsageError("nothing was given");
			privateDir(agent.paths.secrets);
			fs.writeFileSync(path.join(agent.paths.secrets, key), `${value}\n`, { mode: 0o600 });
			fs.chmodSync(path.join(agent.paths.secrets, key), 0o600);
			console.log(`stored ${key} for ${agent.name} (not shown)`);
			return 0;
		}
		case "channel": {
			if (a === "add" || a === "remove") {
				const agent = agents.loadRecord(need(b, "agent name"));
				const ch = need(pos[3], "channel name");
				if (!agents.CHANNEL_RE.test(ch)) throw new UsageError(`"${ch}" is not a valid channel name: 1 to 9 characters, a-z, 0-9 and "-", starting with a letter`);
				if (a === "add") {
					if (!rest?.length && !agents.shipped(ch))
						throw new UsageError(`"${ch}" does not ship with ${PRODUCT}: give its command after --, for example: ${COMMAND} channel add ${agent.name} ${ch} -- python3 /path/to/${ch}.py`);
					editSettings(agent, (s) => {
						const prev = s.channels?.[ch];
						const own = typeof prev === "object" && prev !== null && !Array.isArray(prev) ? prev : {}; // its own settings stay
						s.channels = { ...(s.channels ?? {}), [ch]: { ...own, enabled: true, ...(rest?.length ? { command: rest } : {}) } };
					});
				} else
					editSettings(agent, (s) => {
						if (s.channels) delete s.channels[ch];
					});
				// A running agent picks the change up at once: up starts the new channel, or stops the removed one.
				const r = !fs.existsSync(agent.paths.stopped) && control.find(agent) ? control.up(agent.name) : undefined;
				out(json, { channel: ch, change: a, up: r }, () =>
					a === "add"
						? `${agent.name}: channel ${ch} added${r?.started.includes(ch) ? " and started" : `; it starts with the agent (${COMMAND} start ${agent.name})`}`
						: `${agent.name}: channel ${ch} removed${r?.stoppedChannels.includes(ch) ? " and stopped" : ""}`,
				);
				return 0;
			}
			// A channel's own command (for example: telegram who, telegram allow <id>), with the channel's environment.
			const agent = agents.load(need(a, "agent name"));
			const p = channelProgram(agent, need(b, "channel name"));
			return spawnSync(p.command, [...p.args, ...pos.slice(3), ...(rest ?? [])], { stdio: "inherit", cwd: p.cwd, env: p.env }).status ?? 1;
		}
		case "ext": {
			// pi finds an agent's extensions in <folder>/.pi/extensions/<name>/: put one there to turn it on, take it out
			// to turn it off. This only lists them and checks that pi loads them.
			if (a !== "check") throw new UsageError(`usage: ${COMMAND} ext check <agent> [extension]. Extensions live in <agent folder>/.pi/extensions/<name>/`);
			const agent = agents.load(need(b, "agent name"));
			if (pos[3]) {
				const r = { name: pos[3], ...checkExtension(agent, pos[3]) };
				out(json, [r], () => (r.ok ? `${r.name}: loads` : `${r.name}: FAILS: ${"error" in r ? r.error : ""}`));
				return r.ok ? 0 : 1;
			}
			const rows = foundExtensions(agent).map((name) => ({ name, path: extensionPath(agent, name) }));
			const d = dryStart(agent, { all: true }); // everything pi would load for this agent
			out(json, { extensions: rows, ...d }, () =>
				[
					...(rows.length ? rows.map((r) => `${r.name}  ${tilde(r.path)}`) : [`no extensions in ${tilde(extensionsDir(agent))}`]),
					d.ok ? "pi starts fine with all of them" : `pi does not start: ${d.failing.length ? `failing: ${d.failing.join(", ")}` : d.error}`,
					"(pi also loads the packages and MCP servers of its settings: docs/concepts.md)",
				].join("\n"),
			);
			return d.ok ? 0 : 1;
		}
		case "_run": {
			const agent = agents.load(need(a, "agent name"));
			await runForever(agent, b);
			return 0;
		}
		case "doctor":
		case "service":
		case "uninstall": {
			const { setup } = await import("./setup.ts");
			return setup(cmd, pos.slice(1), opt);
		}
		default:
			throw new UsageError(`unknown command "${cmd}". "${COMMAND} help" lists them.`);
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err) => {
		console.error(`${COMMAND}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = err instanceof UsageError ? 2 : 1;
	},
);
