// The welcome: what `pp` alone shows (how each agent is doing, and the next thing to do; it never starts Herdr Core),
// and `pp setup`, which sets everything up step by step and can be run again at any time.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as ask from "./ask.ts";
import * as bridge from "./bridge.ts";
import { hint, say, style } from "./ask.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, PRODUCT, SETTINGS_FILE } from "./name.ts";
import { defaultFolderParent, ROOT } from "./paths.ts";
import * as port from "./port.ts";
import * as providers from "./providers.ts";
import { channelProgram, checkModel, piPackage } from "./runner.ts";

const tilde = (p: string) => (process.env.HOME && p.startsWith(`${process.env.HOME}/`) ? `~${p.slice(process.env.HOME.length)}` : p);

export async function overview(version: string): Promise<number> {
	const names = agents.list();
	say(`${style.bold(PRODUCT)} ${style.dim(version)}`);
	if (!names.length) {
		say("\nYour own agent, living in Herdr Core, reachable from anywhere. Nothing is set up yet.");
		say(`\n  Start here:  ${style.cyan(`${COMMAND} setup`)}`);
		say(`  Everything:  ${COMMAND} help`);
		return 0;
	}
	const running = await herdr.isRunning();
	const next = new Set<string>();
	say("");
	for (const name of names) {
		if (!running) {
			say(`  ${style.bold(name)}  ${style.dim("not running (Herdr Core is not running)")}`);
			next.add(`Start it:      ${COMMAND} start${names.length > 1 ? " --all" : ""}`);
			continue;
		}
		let s: control.AgentStatus;
		try {
			s = control.status(name);
		} catch (err) {
			say(`  ${style.bold(name)}  ${style.red(`broken: ${(err as Error).message}`)}`);
			next.add(`See why:       ${COMMAND} doctor`);
			continue;
		}
		const state = s.failed ? style.red("cannot start") : s.state === "blocked" ? style.yellow("waiting for you") : s.running ? style.green(s.state) : style.dim(s.state);
		const channels = s.channels.map((c) => `${c.name} ${c.failed ? style.red("failed") : c.running ? style.green("on") : style.dim("off")}`);
		say(`  ${style.bold(name)}  ${state}  ${style.dim(s.model ?? "no model")}${channels.length ? `  ${style.dim("·")} ${channels.join(", ")}` : ""}`);
		const who = names.length > 1 ? ` ${name}` : "";
		if (s.failed) {
			hint(s.failed.reason);
			next.add(`Why, in full:  ${COMMAND} status${who}`);
			next.add(`Try again:     ${COMMAND} restart${who}`);
		} else if (s.safeMode) {
			hint(`running without its extensions: ${s.safeMode.reason}`);
			next.add(`When fixed:    ${COMMAND} restart${who}`);
		} else if (s.settingsError) {
			hint(s.settingsError);
			next.add(`Its settings:  ${tilde(s.folder)}`);
		} else if (!s.running) next.add(`Start it:      ${COMMAND} start${who}`);
		else {
			if (s.state === "blocked") next.add(`Answer it:     ${COMMAND} attach${who}`);
			next.add(`Talk to it:    ${COMMAND} chat${who}`);
			next.add(`Watch it work: ${COMMAND} attach${who}`);
			if (!s.channels.length) next.add(`From Telegram: ${COMMAND} setup`);
		}
		if (s.lastError && !s.failed) hint(`last error (${s.lastError.at}): ${s.lastError.error}`);
	}
	say("");
	for (const n of next) say(`  ${n}`);
	say(`  Everything:    ${COMMAND} help`);
	return 0;
}

// ---- `pp setup`: everything, step by step; run again, it keeps what is done --------------------------------------


const STEPS = 4;
const head = (n: number, title: string) => ask.step(`${n}/${STEPS}  ${title}`);

/** Herdr Core, found or installed, up to date, running. */
async function machine(): Promise<boolean> {
	head(1, "This machine");
	ask.ok(`${process.platform === "darwin" ? "macOS" : "Linux"} ${os.arch()} · Node.js ${process.versions.node} · pi ${piPackage().version}`);
	let hc = herdr.find();
	if (!hc) {
		ask.say(`  ${PRODUCT} runs your agent inside ${style.bold("Herdr Core")}, a small program that keeps terminals alive in the`);
		ask.say("  background: your agent keeps working when you close this window, and you can watch it any time.");
		if (!(await ask.confirm("Install Herdr Core now? (Herdr's own installer, into ~/.local/bin)"))) {
			ask.fail(`${PRODUCT} needs Herdr Core. Install it yourself (https://herdr.dev), then run ${COMMAND} setup again.`);
			return false;
		}
		if (!herdr.install() || !(hc = herdr.find())) {
			ask.fail(`Herdr Core did not install. Its installer said why, above; or see https://herdr.dev. Then: ${COMMAND} setup`);
			return false;
		}
	}
	herdr.use(hc.bin);
	if (!herdr.atLeast(hc.version, herdr.MIN_VERSION)) {
		ask.warn(`Herdr Core ${hc.version} is older than ${herdr.MIN_VERSION}, the oldest ${PRODUCT} is tested with.`);
		if (!(await ask.confirm("Update it now? (its running terminals keep running)")) || !herdr.update() || !(hc = herdr.find()) || !herdr.atLeast(hc.version, herdr.MIN_VERSION)) {
			ask.fail(`Update Herdr Core (hc update), then run ${COMMAND} setup again.`);
			return false;
		}
	}
	if (!(await herdr.isRunning())) {
		try {
			herdr.startServer();
		} catch (err) {
			ask.fail(`Herdr Core ${hc.version} does not start: ${(err as Error).message}`);
			return false;
		}
	}
	ask.ok(`Herdr Core ${hc.version}, running`);
	if (herdr.stopsAtLogout()) {
		ask.warn("On this machine, logging out stops your programs, your agent included. To keep it running:");
		ask.hint(`sudo loginctl enable-linger ${os.userInfo().username}`);
	}
	return true;
}

/** A model, the way pi does it: pi's own screen opens here, for /login and /model; Pi-personal reads what pi stored. */
async function model(): Promise<string[]> {
	head(2, "A model, with pi");
	const all = await providers.providers();
	const names = (ids: string[]) => ids.map((id) => all.find((p) => p.id === id)?.name ?? id).join(", ");
	const ready = providers.connected;
	let open = false; // said yes already
	if (ready().length) {
		ask.ok(`pi is connected: ${names(ready())}`);
		if (!(open = await ask.confirm("Open pi, to connect another provider or choose the model?", false))) return ready();
	}
	for (let again = false; ; again = true) {
		ask.say("  pi opens here, as it always does. In pi:");
		ask.say(`    ${style.cyan("/login")}   connect a provider: an account (a subscription) or an API key`);
		ask.say(`    ${style.cyan("/model")}   choose the model; ${style.cyan("Ctrl+S")} there keeps it as the default`);
		ask.say(`    ${style.cyan("/quit")}    come back here`);
		if (!ask.interactive()) {
			ask.fail(`This step needs a terminal. Later: ${COMMAND} setup, or ${COMMAND} login <provider> --api-key`);
			return ready();
		}
		if (!open && !(await ask.confirm(again ? "Open pi again?" : "Open pi?"))) break;
		open = false;
		providers.openPi();
		ask.say("");
		if (ready().length) {
			ask.ok(`pi is connected: ${names(ready())}`);
			return ready();
		}
		ask.warn("pi has no provider connected yet: /login in pi connects one.");
	}
	if (!ready().length) ask.fail(`No provider connected. Later: ${COMMAND} setup`);
	return ready();
}

/** The agent: an existing one is kept; a first one gets a name, and the model chosen in pi. `created` when this run made it. */
async function agent(connected: string[]): Promise<{ name: string; created: boolean } | undefined> {
	head(3, "Your agent");
	const names = agents.list();
	if (names.length) {
		const chosen = await providers.chosenModel();
		for (const n of names) {
			try {
				const a = agents.load(n);
				ask.ok(`${n}  ${a.settings.model ?? "no model"}  ${tilde(a.folder)}`);
				if (chosen && a.settings.model && chosen !== a.settings.model)
					ask.hint(`it keeps its own model; for pi's default (${chosen}): "model" in ${tilde(path.join(a.folder, SETTINGS_FILE))}, then ${COMMAND} restart ${n}`);
			} catch (err) {
				ask.fail(`${n}: ${(err as Error).message}`);
			}
		}
		return { name: names[0], created: false };
	}
	if (!connected.length) return undefined;
	const model = await providers.chosenModel();
	if (!model) {
		ask.fail(`pi lists no model for ${connected.join(", ")}. See: ${COMMAND} models`);
		return undefined;
	}
	let name = "";
	for (;;) {
		name = await ask.text("Name your agent", "main");
		try {
			agents.validateName(name);
			break;
		} catch (err) {
			ask.warn((err as Error).message);
		}
	}
	const folder = agents.checkFolder(name, path.join(defaultFolderParent(), name));
	const known = checkModel(model, process.cwd());
	if (!known.ok) {
		ask.fail(`${model}: ${known.error}`);
		return undefined;
	}
	// A folder kept from an earlier install (uninstall never deletes it) is adopted, with what it holds.
	const kept = fs.existsSync(path.join(folder, SETTINGS_FILE));
	agents.init(name, folder, { model });
	if (kept) {
		const before = agents.load(name).settings.model;
		ask.ok(`${name} adopts ${tilde(folder)}, kept from before (its instructions and settings)`);
		if (before !== model && (await ask.confirm(`It was set to ${before ?? "no model"}. Use ${model} now?`)))
			agents.editSettings(folder, (s) => {
				s.model = model;
			});
	} else ask.ok(`${name} created in ${tilde(folder)}, with ${model}`);
	ask.hint(`Its instructions, yours to edit: ${tilde(path.join(folder, "AGENTS.md"))}`);
	ask.hint(`Its model: "model" in ${tilde(path.join(folder, SETTINGS_FILE))} (the ids: ${COMMAND} models), then ${COMMAND} restart`);
	return { name, created: true };
}

/** Start the agent; one it has just met (created or started now) says hello. A running one is left alone: its
 * conversation is the person's, not the guide's. */
async function hello(name: string, created: boolean): Promise<boolean> {
	const r = await control.start(name, 60_000);
	if (r.ready === false) {
		ask.fail(`${name} did not get ready: ${r.trouble}`);
		return false;
	}
	ask.ok(`${name} runs in Herdr Core, in the background: closing this window does not stop it`);
	const a = agents.loadRecord(name);
	let said: string[] = [];
	let error: string | undefined;
	if (created) ({ said, error } = await greet(a.paths.port));
	else {
		// A kept agent is not greeted, unless its provider refused its credentials last time: then they are put right
		// below, and a hello checks them.
		const last = control.status(name).lastError?.error;
		if (!last || !bridge.refused(last)) {
			ask.hint(`Watch it work, or take over: ${COMMAND} attach   (ctrl+\\ to leave)`);
			return true;
		}
		({ said, error } = await greet(a.paths.port)); // perhaps put right since (pp login): asked again only if still refused
	}
	// The hello is the first real request: a provider refusing the credentials is put right here, in a few keys.
	for (let tries = 0; !said.length && error && bridge.refused(error) && tries < 3 && ask.interactive(); tries++) {
		ask.fail(error.replace(/\. To enter new ones: .*$/, ""));
		if (!(await ask.confirm("Open pi to sign in again (/login there, then /quit)?"))) break;
		providers.openPi();
		ask.say("");
		({ said, error } = await greet(a.paths.port));
	}
	if (said.length) for (const line of said.join("\n").split("\n")) ask.say(`  ${style.cyan(`${name} ›`)} ${line}`);
	else ask.warn(`no answer yet${error ? `: ${error}` : ""}. See: ${COMMAND} status`);
	ask.say("");
	ask.hint(`Watch it work, or take over: ${COMMAND} attach   (ctrl+\\ to leave)`);
	return said.length > 0;
}

/** Ask the agent to say hello, and wait (2 minutes at most) for what it says, or why it could not. */
async function greet(dir: string): Promise<{ said: string[]; error?: string }> {
	const id = `setup-${randomUUID()}`;
	const from = port.end(dir);
	port.submit(dir, { id, text: "Say hello to the person who just set you up, in one or two short sentences.", conversation: "cli" });
	const said: string[] = [];
	let error: string | undefined;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 120_000);
	await port.follow(
		dir,
		from,
		(e) => {
			const mine = Array.isArray(e.refs) && (e.refs as port.Ref[]).some((x) => x.id === id);
			if (e.type === "message" && mine) said.push(String(e.text));
			if (e.type === "settled" && mine) {
				error = e.error ? String(e.error) : undefined;
				return true;
			}
		},
		ac.signal,
	);
	clearTimeout(timer);
	return { said, error };
}

/** Channels that ship with Pi-personal and can set themselves up, then the login service. */
async function reach(name: string): Promise<void> {
	head(4, "Reach it from anywhere");
	const a = agents.load(name);
	const shipped = fs.readdirSync(path.join(ROOT, "channels")).filter((c) => agents.shipped(c));
	for (const ch of shipped) {
		const on = a.settings.channels?.[ch] && (a.settings.channels[ch] as { enabled?: boolean }).enabled !== false;
		const title = ch[0].toUpperCase() + ch.slice(1);
		if (on) {
			ask.ok(`${title}: on`);
			continue;
		}
		if (!(await ask.confirm(`Talk to ${name} from ${title}?`, false))) continue;
		const p = channelProgram({ ...a, settings: { ...a.settings, channels: { ...(a.settings.channels ?? {}), [ch]: { enabled: true } } } }, ch);
		// Ctrl+C belongs to the channel's setup (it skips that step); the guide goes on.
		const keep = () => {};
		process.on("SIGINT", keep);
		const r = spawnSync(p.command, [...p.args, "setup"], { stdio: "inherit", cwd: p.cwd, env: p.env });
		process.off("SIGINT", keep);
		if (r.status !== 0) {
			if (r.status !== 3) ask.fail(`${title} is not set up. Later: ${COMMAND} setup`);
			continue;
		}
		agents.editSettings(a.folder, (s) => {
			const prev = s.channels?.[ch];
			s.channels = { ...(s.channels ?? {}), [ch]: { ...(typeof prev === "object" && prev ? prev : {}), enabled: true } };
		});
		const u = control.up(name);
		ask.ok(`${title}: on${u.started.includes(ch) ? ", and running" : ""}`);
	}
	// The login service runs `pp up --if-running`: at login and every 5 minutes, it brings back what should run, as
	// long as Herdr Core runs (it never starts Herdr Core itself).
	const { serviceInstalled, serviceInstall } = await import("./setup.ts");
	if (serviceInstalled()) ask.ok("brought back by itself (checked at login and every 5 minutes)");
	else if (await ask.confirm(`Bring ${name} back by itself if it stops? (checked at login and every 5 minutes)`)) {
		try {
			serviceInstall();
			ask.ok("brought back by itself (checked at login and every 5 minutes)");
		} catch (err) {
			ask.fail(`the login service did not install: ${(err as Error).message}`);
		}
	}
}

export async function setup(version: string): Promise<number> {
	ask.say(`${style.bold(PRODUCT)} ${style.dim(version)}`);
	ask.say("Your own agent: a pi session that lives in Herdr Core on this machine, and answers wherever you write to it.");
	ask.say(style.dim(`This takes a few minutes. Run ${COMMAND} setup again any time: it keeps what is done.`));
	if (!(await machine())) return 1;
	const connected = await model();
	if (!connected.length) return 1;
	const made = await agent(connected);
	if (!made) return 1;
	const { name } = made;
	const ok = await hello(name, made.created);
	await reach(name);
	ask.step(ok ? "Done" : `Done, but ${name} has not answered yet: see step 3`);
	const who = agents.list().length > 1 ? ` ${name}` : "";
	const pp = COMMAND;
	ask.say(`  Talk to it:     ${style.cyan(`${pp} chat${who}`)}`);
	ask.say(`  Watch it work:  ${pp} attach${who}`);
	ask.say(`  How it is:      ${pp}`);
	ask.say(`  Stop it:        ${pp} stop${who}   (and Herdr Core too: ${pp} stop --all)`);
	ask.say(`  After a reboot: ${pp} start${who}   (Herdr Core is not started for you at boot)`);
	ask.say(`  Everything:     ${pp} help`);
	return ok ? 0 : 1;
}
