#!/usr/bin/env node
// The command line. Human-readable output by default, JSON with --json where it makes sense. `pp remote` is the entry
// for channels: a short list of commands, plain and short output for a phone, a secret only on standard input.
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT, SLUG } from "./name.ts";
import { ago, defaultFolderParent, home, piDir, privateDir, ROOT, tilde, version } from "./paths.ts";
import * as port from "./port.ts";
import { channelProgram, checkExtension, checkModel, dryStart, extensionPath, extensionsDir, foundExtensions, kitProgram, lockFile, lockHolder, piCli, piPackage, runForever } from "./runner.ts";

const VERSION = version();

/** The six commands to know; the rest is for scripts and for later (`help --all`). */
const HELP = `${PRODUCT} ${VERSION}: your own agent, living in Herdr Core, reachable from anywhere.

Usage: ${COMMAND} [command] [agent] [options]          with one agent, its name can be left out

  ${COMMAND}                 how your agent is doing; Enter opens it (ctrl+\\ comes back)
  ${COMMAND} setup           set things up, or change them: a channel, the model (safe to run again)
  ${COMMAND} status          what it and its channels are doing, and why
  ${COMMAND} doctor          check the installation and every agent, by topic
  ${COMMAND} update          the newest ${PRODUCT}, with the pi it was tested with
  ${COMMAND} help --all      every command: send, start, stop, channels, extensions, scripts

Its instructions: AGENTS.md in its folder (~/pi-personal/<name>). Guide: https://github.com/emiwltz/pi-personal`;

const HELP_ALL = `${PRODUCT} ${VERSION}: your own agent, living in Herdr Core, reachable from anywhere.

Usage: ${COMMAND} [command] [agent] [options]          with one agent, its name can be left out

Everyday
  ${COMMAND}                              how your agent is doing; Enter opens it (ctrl+\\ comes back)
  chat [agent]                    talk to it here (Ctrl+D to leave)
  send [agent] "<text>" [--wait]  send one message; --wait prints the answer
  interrupt [agent]               stop what it is doing now (messages waiting keep their turn)
  answer [agent] "<text>" [--question <id>]
                                  answer the question it asks (with options: one of them, or its number)
  attach [agent]                  its own screen: watch it work, or take over (ctrl+\\ to leave)
  status [agent]                  what it and its channels are doing, and why

Manage
  setup                           set everything up, step by step (safe to run again)
  start [agent] | --all           start it and its channels
  stop [agent] | --all            stop it (--all: every agent, then Herdr Core unless it runs other programs)
  restart [agent]                 stop and start again (also leaves safe mode)
  new [agent]                     a fresh conversation (the old ones stay; pi's /resume lists them)
  model [agent] [provider/id]     the model it runs with; given one, it changes to it (its run goes on)
  thinking [agent] [level]        how much it thinks: ${agents.THINKING.join(", ")}
  login [provider]                alone: pi's screen (/login, /model); with a provider: its sign-in (--api-key)
  models [search]                 the models you can use
  channel add|remove [agent] <channel>
                                  turn a channel on or off (Telegram ships with ${PRODUCT})
  channel [agent] <channel> <command...>
                                  a channel's own commands (Telegram: who, allow <id>, deny <id>, owner [<id>], check)
  service install|uninstall|status
                                  bring your agents back by themselves (at login and every 5 minutes)
  update                          install the newest ${PRODUCT}, with the pi it was tested with
  doctor                          check the installation and every agent
  uninstall [--purge]             remove ${PRODUCT} (--purge: conversations and secrets too)

Advanced
  init <agent> [folder] --model <provider/id>
                                  create an agent without the guide (or adopt a folder copied from elsewhere)
  follow [agent]                  print everything it does, as it happens
  log [agent]                     the keeper's log: every start, exit and restart, and why
  secret set [agent] <key>        store a secret for its channels (typed or piped, never shown)
  kit [agent] <words...>          the kit's own commands, when a kit is installed with ${PRODUCT}
  remote <agent> -- <command...>  the commands a channel runs for its owner ("remote <agent> -- help" lists them)
  ext check [agent] [extension]   its extensions (<folder>/.pi/extensions/) and whether pi loads them
  pi <args...>                    ${PRODUCT}'s own pi, with the settings all agents share
  send ... --conversation <c> --id <id> --timeout <s>
                                  send on behalf of a channel (the answer goes to that conversation)
  send ... --no-wake [--note "<text>"]
                                  tell it without waking it: said to --conversation if given, and kept in its
                                  conversation (the note instead of the text; --note "" keeps nothing)
  up [--if-running]               start every agent that should run (the login service runs this)
  port [agent]                    the folder of its port, for a channel of your own

Options: --json (machine-readable output), --home <dir> (another private area), -h, --version.`;

const VALUE_OPTIONS = ["model", "id", "timeout", "home", "conversation", "question", "note"];
const FLAGS = ["skill", "when-idle", "json", "wait", "no-wake", "if-running", "purge", "help", "version", "all"];
const PASSTHROUGH = ["login", "pi", "channel", "_run"]; // their options belong to the program they run

function parse(argv: string[]) {
	const pos: string[] = [];
	const opt: Record<string, string | true> = {};
	let rest: string[] | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		// pi's, a channel's and the kit's own commands: everything after belongs to them, options included (--help too).
		if ((pos[0] === "pi" || pos[0] === "login") && pos.length === 1) break;
		if ((pos[0] === "channel" && pos.length === 3 && pos[1] !== "add" && pos[1] !== "remove") || (pos[0] === "kit" && pos.length === 1)) {
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
/** The agent a command is about: the one named, or the only one there is. */
function agentName(given: string | undefined): string {
	if (given) return given;
	const all = agents.list();
	if (all.length === 1) return all[0];
	if (!all.length) throw new UsageError(`no agent yet: ${COMMAND} setup`);
	throw new UsageError(`which agent? ${all.join(", ")} (for example: ${COMMAND} <command> ${all[0]})`);
}
/** Split "[agent] <rest...>": the first word is the agent if one has that name, else the only agent is meant. */
function agentAnd(words: string[]): [string, string[]] {
	if (words.length && agents.list().includes(words[0])) return [words[0], words.slice(1)];
	return [agentName(undefined), words];
}

type Row = control.AgentStatus | { name: string; error: string };
/** One agent's status; a broken agent shows its error instead of breaking the list. */
function statusOf(name: string): Row {
	try {
		return control.status(name);
	} catch (err) {
		return { name, error: (err as Error).message };
	}
}

/** Set by `remote`: its output is read on a phone, where a command to type at the machine is no help. */
let remoting = false;
/** A next step typed at the machine: said in a terminal, left out for a channel. */
const hint = (text: string) => (remoting ? "" : text);

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
		lines.push(`  SAFE MODE: running with extensions off: ${s.safeMode.reason}. Fix them; it leaves safe mode at its next start${hint(`, or now with: ${COMMAND} restart ${s.name}`)}`);
	if (s.failed) lines.push(`  FAILED: ${s.failed.reason}; next attempt ${s.failed.retryAt}${hint(`. To try again now: ${COMMAND} restart ${s.name}`)}`);
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

/** The status for a channel: a few short lines, what matters now first; what is old or only Herdr Core's is left out. */
function brief(row: Row): string {
	if ("error" in row) return `${row.name}: ${row.error}`;
	const s = row;
	const state: Record<string, string> = { idle: "is idle", working: "is working", blocked: "waits for a person", failed: "has failed", starting: "is starting", stopped: "is stopped", "not running": "is not running", "running elsewhere": "runs in another terminal" };
	let thinking: string | undefined;
	try {
		thinking = agents.load(s.name).settings.thinking;
	} catch {} // a broken settings file is said below
	const lines = [`${s.name} ${state[s.state] ?? s.state}${s.safeMode ? ", in safe mode" : ""}`];
	if (s.model) lines.push(`Model: ${s.model}${thinking ? `, thinking ${thinking}` : ""}`);
	for (const c of s.channels) lines.push(`${c.name[0].toUpperCase()}${c.name.slice(1)}: ${c.failed ? `failed (${c.failed.reason})` : c.state}`);
	if (s.question) lines.push(`Waiting for a person: ${s.question}`);
	if (s.safeMode) lines.push(`Safe mode: ${s.safeMode.reason}`);
	if (s.failed) lines.push(`Failed: ${s.failed.reason}; next try ${new Date(s.failed.retryAt).toTimeString().slice(0, 5)}`);
	if (s.settingsError) lines.push(`Its settings have an error: ${s.settingsError}`);
	if (s.pending) lines.push(`${s.pending} message${s.pending > 1 ? "s" : ""} waiting`);
	const day = 24 * 3600_000;
	if (s.lastError && Date.now() - Date.parse(s.lastError.at) < day) lines.push(`Last error, ${ago(s.lastError.at)}: ${s.lastError.error}`);
	if (s.lastRestart && Date.now() - Date.parse(s.lastRestart.at) < 3600_000) lines.push(`Restarted ${ago(s.lastRestart.at)}: ${s.lastRestart.reason}`);
	return lines.join("\n");
}

function show(e: port.PortEvent): string {
	const t = e.at ? new Date(String(e.at)).toTimeString().slice(0, 8) : ""; // local time
	const who = e.channel ? `[${e.channel}] ` : "";
	switch (e.type) {
		case "message":
			return `${t} ${who}agent: ${e.text}`;
		case "file":
			return `${t} ${who}[file] ${e.path}`;
		case "input":
			return `${t} ${who}typed in the terminal: ${e.text}`;
		case "error":
			return `${t} ${who}trouble: ${e.error}`;
		case "settled": {
			const ids = ((e.refs as port.Ref[] | undefined) ?? []).map((r) => r.id).join(", ") || "terminal";
			return `${t} ${who}done with ${ids}${e.error ? `: could not answer: ${e.error}` : e.result ? `: ${e.result}` : ""}`;
		}
		case "status":
			return `${t} ${who}status ${e.state}${e.question ? `: ${e.question}` : ""}`;
		case "question":
			return `${t} ${who}asks (${e.id}): ${e.title}${Array.isArray(e.options) ? ` [${e.options.map((o, i) => `${i + 1} ${o}`).join(", ")}]` : ""}`;
		case "answered":
			return `${t} ${who}question ${e.id} answered (${e.by})`;
		default: {
			const { at: _a, type, cursor: _c, after: _f, ...rest } = e as Record<string, unknown>;
			return `${t} ${who}${type} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}`.trimEnd();
		}
	}
}

/** Whether the agent's runner runs, here or in another Herdr Core. */
const runs = (agent: agents.AgentRecord) => control.find(agent) !== undefined || lockHolder(lockFile(agent)) !== undefined;

async function send(name: string, text: string, opt: Record<string, string | true>): Promise<number> {
	const agent = agents.loadRecord(name);
	const id = typeof opt.id === "string" ? opt.id : `cli-${randomUUID()}`;
	// Told without waking, it starts no run: nothing answers it, and without --conversation it is said nowhere, only kept.
	const wake = !opt["no-wake"];
	if (!wake && opt.wait) throw new UsageError("--no-wake starts no run, so no answer comes: leave out --wait");
	if (wake && opt.note !== undefined) throw new UsageError("--note goes with --no-wake");
	// The conversation is the only address: the channel that owns it (by its prefix, "<channel>:...") routes the answer.
	const conversation = typeof opt.conversation === "string" ? opt.conversation : wake ? "cli" : undefined;
	const timeout = Number(opt.timeout ?? 600);
	if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError("--timeout takes a number of seconds");
	let cannotStart: string | undefined;
	const msg: port.Message = { id, text, ...(conversation !== undefined ? { conversation } : {}), ...(wake ? {} : { wake: false, ...(typeof opt.note === "string" ? { note: opt.note } : {}) }) };
	const start = port.end(agent.paths.port);
	const r = port.submit(agent.paths.port, msg);
	const running = runs(agent);
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
	const files: string[] = []; // sent by the agent: as much an answer as its words
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
			if (e.type === "file" && mine) {
				files.push(String(e.path));
				if (!opt.json) console.log(`[file] ${e.path}`);
			}
			// A question asked while it works on this message: its owner may be the one waiting here.
			if (e.type === "question" && mine)
				console.error(
					`${COMMAND}: the agent asks (${e.id}): ${e.title}${Array.isArray(e.options) ? e.options.map((o, i) => `\n  ${i + 1}. ${o}`).join("") : ""}\n  to answer: ${COMMAND} answer ${name} "<your answer>" --question ${e.id}`,
				);
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
	if (opt.json) console.log(JSON.stringify({ id, result: r, said, files, errors, settled: done, ...(settledError ? { error: settledError } : cannotStart ? { error: cannotStart } : {}) }));
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
	const answered = said.length + files.length > 0;
	if (settledError || !answered) {
		const why = settledError ?? errors.at(-1) ?? "the agent finished without a reply";
		if (!opt.json && !errors.includes(why)) console.error(`${COMMAND}: ${answered ? "no full reply" : "no reply"}: ${why}`);
		return 1;
	}
	return 0;
}

/**
 * A control message (`interrupt`, `answer` with `extra`): good only now. Refused at once, nothing written, when the agent
 * does not run or has given up starting; withdrawn from the inbox when no result came in time or the command is stopped
 * (Ctrl+C), so that a command that reported none never takes effect later.
 */
async function obeyed(name: string, word: string, opt: Record<string, string | true>, extra: { question?: string; answer?: string } = {}): Promise<number> {
	const agent = agents.loadRecord(name);
	const json = !!opt.json;
	if (!runs(agent)) {
		console.error(`${COMMAND}: ${name} is not running: nothing was sent${hint(`. To start it: ${COMMAND} start ${name}`)}`);
		return 1;
	}
	const failed = control.status(name).failed;
	if (failed) {
		console.error(`${COMMAND}: ${name} cannot start (${failed.reason}): nothing was sent${hint(`. See: ${COMMAND} status ${name}`)}`);
		return 1;
	}
	const id = typeof opt.id === "string" ? opt.id : `cli-${randomUUID()}`;
	const start = port.end(agent.paths.port);
	// The same id again: its own settled says how it went, from the start of the events; one still waiting is waited for.
	const duplicate = port.submit(agent.paths.port, { id, text: "", control: word, ...extra }) === "duplicate";
	let settled: port.Seen | undefined;
	const wait = async (ms: number, signal?: AbortSignal) => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), ms);
		signal?.addEventListener("abort", () => ac.abort());
		await port.follow(
			agent.paths.port,
			duplicate ? 0 : start,
			(e) => {
				if (e.type === "settled" && ((e.refs as port.Ref[] | undefined) ?? []).some((r) => r.id === id)) settled = e;
				return settled !== undefined;
			},
			ac.signal,
		);
		clearTimeout(timer);
	};
	// Stopped while it waits (Ctrl+C): withdrawn as well, so that it never takes effect after the command ended.
	const cut = new AbortController();
	let by: NodeJS.Signals | undefined;
	const onSignal = (s: NodeJS.Signals) => {
		by = s;
		cut.abort();
	};
	process.once("SIGINT", onSignal).once("SIGTERM", onSignal);
	await wait(20_000, cut.signal);
	const withdrawn = !settled && port.withdraw(agent.paths.port, id);
	// Taken meanwhile, or withdrawn while the bridge was doing it: its result is on its way.
	if (!settled && (withdrawn || !by)) await wait(withdrawn ? 1_000 : 5_000);
	process.off("SIGINT", onSignal).off("SIGTERM", onSignal);
	const s = settled as port.Seen | undefined;
	const done = !s && withdrawn ? "nothing was done" : `the agent took it but said nothing${hint(` (${COMMAND} follow ${name})`)}`;
	const error = s ? (s.error as string | undefined) : by ? `stopped before a result; ${done}` : `no result within 20 s; ${done}`;
	if (json) console.log(JSON.stringify({ id, ...(duplicate ? { duplicate: true } : {}), ...(error ? { error } : { result: s?.result }) }));
	else if (error) console.error(`${COMMAND}: ${error}`);
	else console.log(duplicate ? `${id} was already done` : s?.result);
	return by ? 128 + (by === "SIGINT" ? 2 : 15) : error ? 1 : 0;
}

/** The questions of the agent that still wait, from its events: each `question` until its `answered`, its time limit, or
 * the next start or stop of the agent, which closes every question asked before it. */
function waitingQuestions(portDir: string): port.PortEvent[] {
	const open = new Map<string, port.PortEvent>();
	for (const e of port.events(portDir).events) {
		if (e.type === "question") open.set(String(e.id), e);
		else if (e.type === "answered") open.delete(String(e.id));
		else if (["started", "stopped", "restarted"].includes(e.type) && !e.channel) open.clear();
	}
	return [...open.values()].filter((q) => Date.parse(String(q.until)) > Date.now());
}

/**
 * Run by an agent on itself (its pi runs this command, in its own terminal): a restart would stop the terminal, this
 * command with it, halfway, and the agent would stay stopped. True when one of these agents is the one running it.
 */
function fromInside(names: string[]): boolean {
	const mine = process.env[`${ENV}_PORT`];
	if (!mine) return false;
	return names.some((n) => {
		try {
			return agents.loadRecord(n).paths.port === mine;
		} catch {
			return false;
		}
	});
}
/** The same command again, in a terminal of its own in Herdr Core: stopping the agent's terminal stops everything
 * started in it, even a detached process, but not another terminal. What it says goes to `log` (the agent's log:
 * `pp log`); its terminal goes away when it ends. */
function detached(said: string, log: string): number {
	const args = process.argv.slice(2);
	const cut = args.indexOf("--"); // what follows "--" is taken as it is: the option goes before it
	const again = cut < 0 ? [...args, "--when-idle"] : [...args.slice(0, cut), "--when-idle", ...args.slice(cut)];
	// Herdr Core gives its terminals its own environment: what this command runs with is passed on by hand.
	const pass = [`PATH=${process.env.PATH ?? ""}`, `${ENV}_HOME=${home()}`, `${ENV}_COMMAND=${COMMAND}`, `${ENV}_HC=${herdr.command()}`, ...(process.env[`${ENV}_SOURCE`] ? [`${ENV}_SOURCE=${process.env[`${ENV}_SOURCE`]}`] : [])];
	try {
		herdr.run({ cwd: os.homedir(), labels: { [`${SLUG}.task`]: args[0] }, rm: true, argv: ["sh", "-c", 'exec "$@" >>"$0" 2>&1', log, "env", ...pass, process.execPath, path.join(ROOT, "core", "cli.ts"), ...again] });
	} catch (err) {
		console.error(`${COMMAND}: could not hand it to Herdr Core: ${(err as Error).message}. Ask your owner to run, in a terminal: ${COMMAND} ${args.join(" ")}`);
		return 1;
	}
	fs.appendFileSync(log, `${new Date().toISOString()} ${COMMAND} ${args.join(" ")}, run by the agent on itself: handed to a terminal of its own, once its answer is done\n`);
	console.log(said);
	return 0;
}
/** Run by that terminal: wait until the agent's current answer is done (a minute at most), so that the restart cuts
 * nothing and nobody is told it could not be answered. */
async function whenIdle(names: string[]): Promise<void> {
	for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
		const busy = names.some((n) => {
			try {
				return control.status(n).state === "working";
			} catch {
				return false;
			}
		});
		if (!busy) return;
	}
}

/**
 * new, model, thinking: the agent's terminal restarts with the change; its channels keep running. Run by the agent on
 * itself, the command is handed to a terminal of its own once its answer is done, as restart is. A channel has the
 * agent's port too, but runs it directly: its own terminal is not the one that stops.
 */
async function restartFor(name: string, what: string, opt: Record<string, string | true>, run: () => ReturnType<typeof control.restartAgent>): Promise<number> {
	if (fromInside([name]) && !process.env[`${ENV}_CHANNEL`]) {
		agents.load(name); // as restart: a broken settings file is said now, to the agent, not later in a log
		return detached(`${name} restarts once this answer is done (a minute at most): ${what}. What happened: ${COMMAND} log ${name}`, agents.loadRecord(name).paths.log);
	}
	if (opt["when-idle"]) await whenIdle([name]);
	const r = await run();
	const lines = [r.later ? `${name} is stopped: ${what} from its next start${hint(` (${COMMAND} start ${name})`)}` : r.ready === false ? `${name}: ${what}, but ${r.trouble}` : `${name}: ${what}; pi is ready`];
	if (r.told) lines.push(`  ${r.told} message(s) taken in before were not answered: their senders are told`);
	out(!!opt.json, r, () => lines.join("\n"));
	return !r.later && r.ready === false ? 1 : 0;
}

/** new: a fresh conversation. */
const fresh = (name: string, opt: Record<string, string | true>) =>
	restartFor(name, "a new conversation", opt, () => control.restartAgent(name, "a new conversation", () => {}, true));

/** model, thinking: without a value, the setting; with one, checked, written, then the agent's terminal restarts. */
async function setting(key: "model" | "thinking", name: string, value: string | undefined, opt: Record<string, string | true>): Promise<number> {
	const settings = agents.load(name).settings;
	if (!value) {
		const now = settings[key];
		const unset = key === "model" ? `pi's default model${hint(` (to choose one: ${COMMAND} model ${name} <provider/id>; the list: ${COMMAND} models)`)}` : `pi keeps the level the conversation last used${hint(` (to choose one: ${COMMAND} thinking ${name} <${agents.THINKING.join("|")}>)`)}`;
		out(!!opt.json, { [key]: now ?? null }, () => now ?? `not set: ${unset}`);
		// For a channel, what may be chosen, on one line it can turn into buttons: the levels, or the models pi lists.
		if (remoting) {
			const choices = key === "thinking" ? agents.THINKING : (await import("./providers.ts")).models().map((m) => `${m.provider}/${m.id}`);
			if (choices.length) console.log(`choose: ${choices.join(" ")}`);
		}
		return 0;
	}
	if (key === "model") {
		// pi checks the model without a network or credentials: an unknown provider is refused here, not at start.
		const known = checkModel(value, agents.loadRecord(name).folder);
		if (!known.ok) throw new UsageError(`${known.error}${hint(`. To list the models: ${COMMAND} models`)}`);
		if (known.warning) console.error(`note: ${known.warning}; pi will pass this id to the provider as it is`);
	} else if (!agents.THINKING.includes(value)) throw new UsageError(`"${value}" is not a thinking level: ${agents.THINKING.join(", ")}`);
	return restartFor(name, key === "model" ? `it runs with ${value}` : `it thinks at ${value}`, opt, () => control.setting(name, key, value));
}

/** A secret, typed without being shown at a terminal, read from standard input otherwise: never an argument (it would
 * show in the list of processes) nor an environment variable. */
async function hidden(prompt: string): Promise<string> {
	return (process.stdin.isTTY ? await (await import("./ask.ts")).secret(prompt) : fs.readFileSync(0, "utf8")).trim();
}

/** secret set: stored in the agent's private area, mode 0600, never printed. */
async function storeSecret(name: string, key: string | undefined): Promise<number> {
	const agent = agents.loadRecord(name);
	if (!key) throw new UsageError("missing the secret's name");
	if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new UsageError("secret names use A-Z a-z 0-9 . _ -");
	const value = await hidden(`The value for ${key}`);
	if (!value) throw new UsageError("nothing was given");
	privateDir(agent.paths.secrets);
	fs.writeFileSync(path.join(agent.paths.secrets, key), `${value}\n`, { mode: 0o600 });
	fs.chmodSync(path.join(agent.paths.secrets, key), 0o600);
	console.log(`stored ${key} for ${agent.name} (not shown)`);
	return 0;
}

/** The kit, a door and not an ability: run with the agent's environment when one is installed, whatever it does. */
function kit(name: string, words: string[]): number {
	const p = kitProgram(agents.loadRecord(name));
	if (!p) {
		console.log(`no kit is installed with this ${PRODUCT} (${path.join(ROOT, "kit", "kit.ts")} is missing)`);
		return 1;
	}
	return spawnSync(p.command, [...p.args, ...words], { stdio: "inherit", cwd: p.cwd, env: p.env }).status ?? 1;
}

const REMOTE = `${COMMAND} remote <agent> -- <command>:
  interrupt               stop what it is doing now
  answer <id> <text...>   answer one of its questions
  new                     a fresh conversation
  model [provider/id]     its model; given one, it changes to it
  thinking [level]        how much it thinks: ${agents.THINKING.join(", ")}
  status                  how it is doing
  restart                 restart it (its channels keep running)
  login <provider>        store an API key for a provider (the key on standard input)
  secret set <name>       store a secret for its channels (the value on standard input)
  kit <words...>          the kit's own commands
  help                    this list`;

/**
 * remote: the entry for channels, which run it for their owner. The first word is always the agent, and what follows
 * "--" is taken as it is, never read as an option of pp: an answer that says "--help" is an answer. Only the
 * commands of REMOTE, with short plain output for a phone. A channel sets PI_PERSONAL_REMOTE_ID to its own id for the
 * request, so that a request it fetched twice is done once.
 */
async function remote(name: string, words: string[], opt: Record<string, string | true>): Promise<number> {
	const [word, ...args] = words;
	remoting = true;
	const by = process.env[`${ENV}_REMOTE_ID`] ? { ...opt, id: process.env[`${ENV}_REMOTE_ID`] as string } : opt;
	try {
		agents.loadRecord(name);
		switch (word) {
			case "interrupt":
				return await obeyed(name, "interrupt", by);
			case "answer": {
				const [question, ...text] = args;
				if (!question || !text.length) throw new UsageError("usage: answer <question id> <text...>");
				return await obeyed(name, "answer", by, { question, answer: text.join(" ") });
			}
			case "new":
				return await fresh(name, opt);
			case "model":
			case "thinking":
				return await setting(word, name, args[0], opt);
			case "status":
				console.log(brief(statusOf(name)));
				return 0;
			case "restart":
				return await restartFor(name, "restarted", opt, () => control.restartAgent(name, "restarted by its owner from a channel", () => {}));
			case "login": {
				if (!args[0]) throw new UsageError("usage: login <provider>, with the key on standard input");
				const key = await hidden(`The API key for ${args[0]}`);
				if (!key) throw new UsageError("no key was given: nothing was stored");
				const provider = await (await import("./providers.ts")).loginWithKey(args[0], key);
				console.log(`stored an API key for ${provider} (not shown); the agents use it from their next message`);
				return 0;
			}
			case "secret":
				if (args[0] !== "set") break;
				return await storeSecret(name, args[1]);
			case "kit":
				return kit(name, args);
			case "help":
				console.log(REMOTE);
				return 0;
		}
		console.error(`"${words.join(" ")}" is not a command here.\n${REMOTE}`);
		return 2;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return err instanceof UsageError ? 2 : 1;
	}
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
	// Started in the background: say how to reach it, the one thing a person wants next.
	if (r.ready !== false && (r.started.includes("agent") || r.running.includes("agent"))) {
		lines.push(`  open it: ${COMMAND}, then Enter (ctrl+\\ comes back)`);
	}
	out(json, r, () => lines.join("\n"));
	return r.ready === false ? 1 : 0;
}

/** Everything after a command word, for a program that reads it (pi): without our own --home. */
const after = (argv: string[], word: string) =>
	argv.slice(argv.indexOf(word) + 1).filter((x, i, all) => x !== "--home" && all[i - 1] !== "--home" && !x.startsWith("--home="));

/** The installer's mark (.installed): only an installed copy updates itself; a source folder is updated with git. */
function installedCopy(): string {
	const marker = path.join(ROOT, ".installed");
	if (!fs.existsSync(marker)) throw new UsageError(`this ${PRODUCT} runs from a source folder (${ROOT}), not an installed copy: update it with git pull, then ./install.sh`);
	return marker;
}

/** `update`: the newest Pi-Personal from GitHub, through its own installer (downloaded whole before it runs), then
 * the agents that were running are restarted by the new command, with the Node.js it now uses (their conversations
 * continue), and the login service is rewritten to match. PI_PERSONAL_SOURCE (a folder) installs that copy instead. */
async function update(json: boolean): Promise<number> {
	const marker = installedCopy();
	const command = fs.readFileSync(marker, "utf8").split("\n")[0].trim();
	const repo = /github\.com\/([^/]+\/[^/.]+)/.exec(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).repository?.url ?? "")?.[1] ?? "emiwltz/pi-personal";
	const source = process.env[`${ENV}_SOURCE`];
	const quote = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
	const script =
		source && fs.existsSync(path.join(source, "install.sh"))
			? `sh ${quote(path.join(source, "install.sh"))}`
			: `t=$(mktemp) && curl -fsSL --proto '=https' https://raw.githubusercontent.com/${repo}/main/install.sh -o "$t" && sh "$t"; s=$?; rm -f "$t"; exit $s`;
	const running = agents.list().filter((n) => {
		try {
			return !!control.find(agents.loadRecord(n));
		} catch {
			return false;
		}
	});
	const { serviceInstalled } = await import("./setup.ts");
	const service = serviceInstalled();
	const env = { ...process.env, [`${ENV}_NO_SETUP`]: "1", [`${ENV}_UPDATING`]: "1", [`${ENV}_INSTALL_DIR`]: ROOT, [`${ENV}_BIN_DIR`]: path.dirname(command) };
	const r = spawnSync("sh", ["-c", script], { stdio: json ? ["ignore", "ignore", "inherit"] : "inherit", env });
	if (r.status !== 0) {
		console.error(`${COMMAND}: the update failed; ${PRODUCT} is unchanged`);
		return 1;
	}
	// The new command, not this process: the Node.js this one runs may be gone (the installer may use another now).
	const now = spawnSync(command, ["--version", "--json"], { encoding: "utf8", env: process.env });
	const to = (() => {
		try {
			return JSON.parse(now.stdout).version as string;
		} catch {
			return "?";
		}
	})();
	const restarted: string[] = [];
	const failed: string[] = [];
	for (const n of running) (spawnSync(command, ["restart", n], { stdio: json ? "ignore" : "inherit", env: process.env }).status === 0 ? restarted : failed).push(n);
	if (service) spawnSync(command, ["service", "install"], { stdio: "ignore", env: process.env });
	out(json, { from: VERSION, to, restarted, failed }, () =>
		[`${PRODUCT} ${VERSION} → ${to}`, ...(restarted.length ? [`restarted ${restarted.join(", ")} (conversations continue)`] : []), ...(failed.length ? [`could not restart ${failed.join(", ")}: ${COMMAND} status`] : [])].join("\n"),
	);
	return failed.length ? 1 : 0;
}

/** `stop --all`: every agent and its channels, then Herdr Core itself, unless it runs something else too. Herdr Core
 * not running: nothing runs, and every agent is marked stopped without starting it (any hc command would). */
async function stopAll(json: boolean): Promise<number> {
	const stopped: Record<string, string[] | string> = {};
	const running = await herdr.isRunning();
	for (const name of agents.list())
		try {
			if (running) stopped[name] = await control.stop(name);
			else {
				fs.writeFileSync(agents.loadRecord(name).paths.stopped, `${new Date().toISOString()}\n`);
				stopped[name] = [];
			}
		} catch (err) {
			stopped[name] = `could not stop: ${(err as Error).message}`;
		}
	const trouble = Object.values(stopped).some((v) => typeof v === "string");
	let herdrCore = "not running";
	if (running) {
		const others = herdr.ls({});
		if (trouble) herdrCore = "kept running: an agent could not be stopped";
		else if (others.length) herdrCore = `kept running: it also runs ${others.length} other program${others.length > 1 ? "s" : ""} (${others.map((t) => t.name ?? t.address).join(", ")})`;
		else {
			herdr.stopServer();
			herdrCore = "stopped";
		}
	}
	out(json, { stopped, herdrCore }, () =>
		[
			...Object.entries(stopped).map(([n, e]) => (typeof e === "string" ? `${n}: ${e}` : e.length ? `${n}: stopped ${e.join(", ")}` : `${n}: was not running; it stays stopped`)),
			`Herdr Core: ${herdrCore}`,
			`To start again: ${COMMAND} start --all`,
		].join("\n"),
	);
	return trouble ? 1 : 0;
}


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
	if (opt.skill) {
		// The agent's own manual, as hc --skill is Herdr Core's: read before it changes anything about itself.
		console.log(fs.readFileSync(path.join(ROOT, "docs", "for-agents.md"), "utf8").replaceAll("`pp ", `\`${COMMAND} `));
		return 0;
	}
	if (opt.help || cmd === "help") {
		console.log(opt.all ? HELP_ALL : HELP);
		return 0;
	}
	// The screens that draw in colour first ask the terminal its background (once, a few milliseconds). Not before
	// handing the terminal to another program (attach, chat, pi), which would get the answer as keys.
	if (!json && process.stdin.isTTY && process.stdout.isTTY && [undefined, "setup", "status", "doctor", "update"].includes(cmd)) await (await import("./screen.ts")).sense();
	if (cmd === undefined) {
		const { home } = await import("./home.ts");
		return home(VERSION);
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
					`  open it:          ${COMMAND}, then Enter`,
				].join("\n"),
			);
			return 0;
		}
		case "status": {
			const rows = (a ? [a] : agents.list()).map(statusOf);
			out(json, a ? rows[0] : rows, () => (rows.length ? rows.map((r) => describe(r, !!a)).join("\n") : `no agents yet: ${COMMAND} setup`));
			return rows.some((r) => "error" in r) ? 1 : 0;
		}
		case "start": {
			if (!opt.all) return startCmd(agentName(a), json);
			// Every agent, each on its own: one that cannot start does not keep the others down.
			let code = 0;
			const results: unknown[] = [];
			for (const name of agents.list())
				try {
					if (json) results.push({ name, ...(await control.start(name)) });
					else code = Math.max(code, await startCmd(name, false));
				} catch (err) {
					if (json) results.push({ name, error: (err as Error).message });
					else console.log(`${name}: could not start: ${(err as Error).message}`);
					code = 1;
				}
			if (json) console.log(JSON.stringify(results, null, 2));
			return code;
		}
		case "restart": {
			const name = agentName(a);
			if (fromInside([name])) {
				agents.load(name); // a broken settings file is said now, to the agent, not later in a log
				return detached(`${name} restarts once this answer is done (a minute at most); the conversation continues after it. What happened: ${COMMAND} log ${name}`, agents.loadRecord(name).paths.log);
			}
			if (opt["when-idle"]) await whenIdle([name]);
			return startCmd(name, json, true);
		}
		case "new":
			return fresh(agentName(a), opt);
		case "model":
		case "thinking": {
			const [name, words] = agentAnd(pos.slice(1));
			return setting(cmd, name, words[0], opt);
		}
		case "up": {
			// The login service runs `up --if-running`. It starts Herdr Core only when it may (Pi-Personal installed it, or
			// the person said yes in pp setup): a core started from a service gets the environment the service was
			// installed with, and the person's own Herdr Core may run other things of theirs.
			if (opt["if-running"] && !(await herdr.isRunning())) {
				const { bootStartDue, bootStarted } = await import("./setup.ts");
				const { due, why } = bootStartDue();
				if (!due) {
					console.log(`Herdr Core is not running: nothing started (${why}; it will be tried again later)`);
					return 0;
				}
				try {
					herdr.startServer();
					bootStarted();
					console.log("Herdr Core was not running: started (this machine has just started, or it had stopped)");
				} catch (err) {
					console.log(`Herdr Core does not start: ${(err as Error).message} (tried again later)`);
					return 1;
				}
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
			if (opt.all) return stopAll(json);
			const name = agentName(a);
			const ended = await control.stop(name);
			out(json, { stopped: ended }, () => (ended.length ? `${name}: stopped ${ended.join(", ")}` : `${name} was not running; it stays stopped`));
			return 0;
		}
		case "attach": {
			const agent = agents.loadRecord(agentName(a));
			const t = control.find(agent);
			if (!t) throw new Error(`${agent.name} is not running: ${COMMAND} start ${agent.name}`);
			console.error("ctrl+\\ leaves this screen; the agent keeps running.");
			return spawnSync(herdr.command(), ["attach", t.address], { stdio: "inherit" }).status ?? 1;
		}
		case "send": {
			const [name, words] = agentAnd(pos.slice(1));
			const text = [...words, ...(rest ?? [])].join(" ");
			return send(name, need(text, "message text"), opt);
		}
		case "interrupt":
			return obeyed(agentName(a), "interrupt", opt);
		case "answer": {
			const [name, words] = agentAnd(pos.slice(1));
			const text = need([...words, ...(rest ?? [])].join(" "), "the answer");
			// Typed at the machine, the question may be left out when only one waits.
			let question = typeof opt.question === "string" ? opt.question : undefined;
			if (!question) {
				const waiting = waitingQuestions(agents.loadRecord(name).paths.port);
				if (waiting.length !== 1)
					throw new UsageError(waiting.length ? `${waiting.length} questions wait: say which with --question <id> (${waiting.map((q) => q.id).join(", ")})` : `no question of ${name} waits for an answer`);
				question = String(waiting[0].id);
			}
			return obeyed(name, "answer", opt, { question, answer: text });
		}
		case "follow": {
			const agent = agents.loadRecord(agentName(a));
			await port.follow(agent.paths.port, port.end(agent.paths.port), (e) => {
				const { after: _a, ...ev } = e;
				console.log(json ? JSON.stringify(ev) : show(e));
			});
			return 0;
		}
		case "chat": {
			const agent = agents.loadRecord(agentName(a));
			if (!control.find(agent)) console.error(`note: ${agent.name} is not running; start it with: ${COMMAND} start ${agent.name}`);
			const r = spawnSync(process.execPath, [path.join(ROOT, "channels", "local", "chat.ts")], {
				stdio: "inherit",
				env: { ...process.env, [`${ENV}_PORT`]: agent.paths.port, [`${ENV}_AGENT`]: agent.name, [`${ENV}_COMMAND`]: COMMAND }, // in the command that answers a question
			});
			return r.status ?? 1;
		}
		case "port":
			console.log(agents.loadRecord(agentName(a)).paths.port);
			return 0;
		case "log": {
			const agent = agents.loadRecord(agentName(a));
			process.stdout.write(fs.existsSync(agent.paths.log) ? fs.readFileSync(agent.paths.log, "utf8") : "");
			return 0;
		}
		case "login": {
			// Alone: pi's own screen, for /login. With a provider: pi's command-line sign-in, given everything after "login".
			const args = after(argv, "login");
			const providers = await import("./providers.ts");
			if (!args.length) {
				if (!process.stdin.isTTY) throw new UsageError(`usage: ${COMMAND} login (opens pi: /login there), or ${COMMAND} login <provider> [--api-key] [--no-browser]. ${PROVIDERS()}`);
				console.log("pi opens: /login connects a provider, /model chooses the model (Ctrl+S keeps it as the default), /quit comes back (Ctrl+C and Ctrl+D are off in Pi-Personal's pi).");
				return providers.openPi();
			}
			return providers.login(args);
		}
		case "pi": {
			// Pi-Personal's pinned pi, with the settings folder all agents share (packages, MCP servers, models, sign-ins).
			const args = after(argv, "pi");
			agents.preparePi();
			return spawnSync(process.execPath, [piCli(), ...args], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: piDir() } }).status ?? 1;
		}
		case "models": {
			privateDir(piDir());
			// Read from a file pi writes, never through a pipe: on a busy machine a pipe loses the end of the list.
			const r = (await import("./providers.ts")).piPrints(["--list-models", ...(a ? [a] : [])], { ...process.env, PI_CODING_AGENT_DIR: piDir() });
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
			if (a !== "set") throw new UsageError(`usage: ${COMMAND} secret set [agent] <key>`);
			const [name, words] = agentAnd(pos.slice(2));
			return storeSecret(name, need(words[0], "secret name"));
		}
		case "kit": {
			const [name, words] = agentAnd(rest ?? []);
			return kit(name, words);
		}
		case "remote":
			if (!a || pos.length > 2 || !rest) throw new UsageError(`usage: ${COMMAND} remote <agent> -- <command> [words...]. ${COMMAND} remote <agent> -- help lists the commands`);
			return remote(a, rest, opt);
		case "channel": {
			if (a === "add" || a === "remove") {
				const [name, words] = agentAnd(pos.slice(2));
				const agent = agents.loadRecord(name);
				const ch = need(words[0], "channel name");
				if (!agents.CHANNEL_RE.test(ch)) throw new UsageError(`"${ch}" is not a valid channel name: 1 to 9 characters, a-z, 0-9 and "-", starting with a letter`);
				if (a === "add") {
					if (!rest?.length && !agents.shipped(ch))
						throw new UsageError(`"${ch}" does not ship with ${PRODUCT}: give its command after --, for example: ${COMMAND} channel add ${agent.name} ${ch} -- python3 /path/to/${ch}.py`);
					agents.turnOn(agent.folder, ch, rest);
				} else
					agents.editSettings(agent.folder, (s) => {
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
			const [name, words] = agentAnd(pos.slice(1));
			const agent = agents.load(name);
			const ch = need(words[0], "channel name");
			// A shipped channel's commands work before it is turned on (its setup comes first).
			const on = agents.channels(agent).some((c) => c.name === ch);
			const p = channelProgram(on || !agents.shipped(ch) ? agent : agents.withChannel(agent, ch), ch);
			return spawnSync(p.command, [...p.args, ...words.slice(1), ...(rest ?? [])], { stdio: "inherit", cwd: p.cwd, env: p.env }).status ?? 1;
		}
		case "ext": {
			// pi finds an agent's extensions in <folder>/.pi/extensions/<name>/: put one there to turn it on, take it out
			// to turn it off. This only lists them and checks that pi loads them.
			if (a !== "check") throw new UsageError(`usage: ${COMMAND} ext check [agent] [extension]. Extensions live in <agent folder>/.pi/extensions/<name>/`);
			const [name, words] = agentAnd(pos.slice(2));
			const agent = agents.load(name);
			if (words[0]) {
				const r = { name: words[0], ...checkExtension(agent, words[0]) };
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
		case "setup": {
			const { setup } = await import("./welcome.ts");
			return setup(VERSION);
		}
		case "update": {
			// Run by an agent on itself: checked here, then handed to a terminal of its own (the update restarts it).
			const self = agents.list().find((n) => fromInside([n]));
			if (self) installedCopy();
			if (opt["when-idle"]) await whenIdle(agents.list());
			if (self) return detached("The update runs in a moment, outside this terminal; the agents restart after it, this one included.", agents.loadRecord(self).paths.log);
			return update(json);
		}
		case "doctor":
		case "service":
		case "uninstall": {
			const { maintain } = await import("./setup.ts");
			return maintain(cmd, pos.slice(1), opt);
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
