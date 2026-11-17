// The welcome: what `pp` alone shows (how each agent is doing, and the next thing to do; it never starts Herdr Core),
// and `pp setup`, which sets everything up step by step and can be run again at any time.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as ask from "./ask.ts";
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


const STEPS = 5;
/** The command as the person can type it now: the installer says when another `pp` comes first on this terminal's PATH. */
const run = () => process.env.PI_PERSONAL_COMMAND || COMMAND;
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

/** At least one model provider, the way pi offers them; credentials already on the machine are offered first. */
async function provider(): Promise<string[]> {
	head(2, "A model provider");
	const all = await providers.providers();
	const nameOf = (id: string) => all.find((p) => p.id === id)?.name ?? id;
	const ready = providers.connected;
	if (ready().length) ask.ok(`connected: ${ready().map(nameOf).join(", ")}`);
	else {
		// What this machine already has: keys in this terminal's environment, and the user's own pi.
		for (const p of all) {
			for (const v of await providers.envKeys(p.id)) {
				if (!/_API_KEY$|^HF_TOKEN$/.test(v) || ready().includes(p.id)) continue;
				if (await ask.confirm(`${v} is set in this terminal. Use it for ${p.name}?`)) {
					await providers.saveEnvKey(p.id, v);
					ask.ok(`${p.name}: key saved for your agents (${PRODUCT} keeps it in its private area, readable by you only)`);
				}
			}
		}
		const theirs = providers.userPiAuth();
		if (theirs) {
			const found = providers.stored(theirs);
			for (const [id, kind] of Object.entries(found)) {
				if (ready().includes(id)) continue;
				if (kind === "api_key") {
					if (await ask.confirm(`Your own pi has an API key for ${nameOf(id)}. Use it here too?`)) {
						await providers.copyKey(theirs, id);
						ask.ok(`${nameOf(id)}: key copied (your pi is not changed)`);
					}
				} else ask.hint(`Your own pi is signed in to ${nameOf(id)} with an account: sign in again below rather than share it (two programs sharing one sign-in can log each other out).`);
			}
		}
		if (ready().length) ask.ok(`connected: ${ready().map(nameOf).join(", ")}`);
	}
	while (!ready().length)
		if (!(await connect(all)) && !(await ask.confirm("Try again?"))) {
			ask.fail(`No provider connected. Later: ${COMMAND} login, then ${COMMAND} setup`);
			return [];
		}
	while (await ask.confirm("Connect another provider?", false)) await connect(all);
	return ready();
}

/** One sign-in, the way pi's own /login offers it: an account or an API key, then the provider. */
export async function connect(all?: providers.Provider[]): Promise<boolean> {
	all ??= await providers.providers();
	const ready = providers.connected();
	const how = await ask.choose("How do you want to connect?", [
		{ label: "Sign in with an account", value: "account" as const, note: "a subscription or an account, in your browser" },
		{ label: "Use an API key", value: "key" as const, note: "a key from the provider's website" },
	]);
	const choices = all.filter((p) => (how === "account" ? p.account : p.apiKey));
	const id = await ask.choose(
		"Which provider?",
		choices.map((p) => ({
			label: p.name,
			value: p.id,
			note: [ready.includes(p.id) ? "✓ connected" : "", how === "account" && p.account?.subscription ? "subscription" : ""].filter(Boolean).join(" · ") || undefined,
		})),
	);
	const name = all.find((p) => p.id === id)?.name ?? id;
	if (id === "anthropic" && how === "account")
		ask.hint("pi's note: with an Anthropic subscription, use by a program like this one draws from extra usage, billed per token (claude.ai/settings/usage).");
	ask.say("");
	const done = providers.login(id, how === "key");
	ask.say("");
	if (done && providers.check(id) === "ready") {
		ask.ok(`${name}: connected`);
		return true;
	}
	ask.fail(`${name}: not connected${done ? " (pi could not use it)" : ""}. Try again, or choose another.`);
	return false;
}

/** The agent: an existing one is kept; a first one gets a model and a name. `created` when this run made it. */
async function agent(connected: string[]): Promise<{ name: string; created: boolean } | undefined> {
	head(3, "Your agent");
	const names = agents.list();
	if (names.length) {
		for (const n of names) {
			try {
				const a = agents.load(n);
				ask.ok(`${n}  ${a.settings.model ?? "no model"}  ${tilde(a.folder)}`);
			} catch (err) {
				ask.fail(`${n}: ${(err as Error).message}`);
			}
		}
		return { name: names[0], created: false };
	}
	if (!connected.length) return undefined;
	const list = providers.models().filter((m) => connected.includes(m.provider));
	if (!list.length) {
		ask.fail(`pi lists no model for ${connected.join(", ")}. See: ${COMMAND} models`);
		return undefined;
	}
	const preferred = await providers.defaultModel(connected[0]);
	const sorted = [...list].sort((a, b) => Number(`${b.provider}/${b.id}` === `${connected[0]}/${preferred}`) - Number(`${a.provider}/${a.id}` === `${connected[0]}/${preferred}`));
	const model = await ask.choose(
		"Which model?",
		sorted.map((m) => ({ label: `${m.provider}/${m.id}`, value: `${m.provider}/${m.id}`, note: `${m.provider}/${m.id}` === `${connected[0]}/${preferred}` ? "pi's default" : m.context ? `${m.context} context` : undefined })),
	);
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
	} else ask.ok(`${name} created in ${tilde(folder)}`);
	ask.hint(`Its instructions, yours to edit: ${tilde(path.join(folder, "AGENTS.md"))}`);
	return { name, created: true };
}

/** Start the agent; one it has just met (created or started now) says hello. A running one is left alone: its
 * conversation is the person's, not the guide's. */
async function hello(name: string, created: boolean): Promise<boolean> {
	head(4, "Start it");
	const r = await control.start(name, 60_000);
	if (r.ready === false) {
		ask.fail(`${name} did not get ready: ${r.trouble}`);
		return false;
	}
	ask.ok(`${name} runs in Herdr Core, in the background: closing this window does not stop it`);
	if (!created) {
		ask.hint(`Watch it work, or take over: ${run()} attach   (ctrl+\\ to leave)`);
		return true;
	}
	const a = agents.loadRecord(name);
	const id = `setup-${randomUUID()}`;
	const from = port.end(a.paths.port);
	port.submit(a.paths.port, { id, text: "Say hello to the person who just set you up, in one or two short sentences.", conversation: "cli" });
	const said: string[] = [];
	let error: string | undefined;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 120_000);
	await port.follow(
		a.paths.port,
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
	if (said.length) for (const line of said.join("\n").split("\n")) ask.say(`  ${style.cyan(`${name} ›`)} ${line}`);
	else ask.warn(`no answer yet${error ? `: ${error}` : ""}. See: ${COMMAND} status`);
	ask.say("");
	ask.hint(`Watch it work, or take over: ${run()} attach   (ctrl+\\ to leave)`);
	return said.length > 0;
}

/** Channels that ship with Pi-personal and can set themselves up, then the login service. */
async function reach(name: string): Promise<void> {
	head(5, "Reach it from anywhere");
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
	const connected = await provider();
	if (!connected.length) return 1;
	const made = await agent(connected);
	if (!made) return 1;
	const { name } = made;
	const ok = await hello(name, made.created);
	await reach(name);
	ask.step("Done");
	const who = agents.list().length > 1 ? ` ${name}` : "";
	const pp = run();
	ask.say(`  Talk to it:     ${style.cyan(`${pp} chat${who}`)}`);
	ask.say(`  Watch it work:  ${pp} attach${who}`);
	ask.say(`  How it is:      ${pp}`);
	ask.say(`  Stop it:        ${pp} stop${who}   (and Herdr Core too: ${pp} stop --all)`);
	ask.say(`  After a reboot: ${pp} start${who}   (Herdr Core is not started for you at boot)`);
	ask.say(`  Everything:     ${pp} help`);
	return ok ? 0 : 1;
}
