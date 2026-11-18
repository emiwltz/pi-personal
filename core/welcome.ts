// `pp setup`, the guide: it sets everything up step by step and can be run again at any time. (`pp` alone: home.ts.)
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as ask from "./ask.ts";
import * as bridge from "./bridge.ts";
import { hint, say } from "./ask.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, PRODUCT, SETTINGS_FILE } from "./name.ts";
import { defaultFolderParent, ROOT, tilde } from "./paths.ts";
import * as port from "./port.ts";
import * as providers from "./providers.ts";
import { channelProgram, checkModel, piPackage } from "./runner.ts";
import * as screen from "./screen.ts";

// ---- `pp setup`: five steps, each drawn with its line in the margin; run again, it keeps what is done ---------------------
const STEPS = ["This machine", "A model", "Your agent", "Reach it", "Stay alive"];
const look = () => screen.look();
let numbered = true; // "2/5" beside a step's title: in the whole guide, not in the menu
/** A step begins: its diamond and its title, then everything it says carries the line in the margin. */
function begin(n: number): void {
	const l = look();
	ask.margin("");
	say("");
	say(`  ${screen.yours(l, "◆")}  ${screen.bright(l, STEPS[n - 1], true)}${numbered ? `  ${screen.faint(l, `${n}/${STEPS.length}`)}` : ""}`);
	ask.margin(`  ${screen.line(l, "│")}`);
}
/** A step ends: what it settled, on one line. */
function end(what: string, good = true): void {
	const l = look();
	ask.margin("");
	say(`  ${good ? screen.alive(l, "◇") : screen.yours(l, "◇")}  ${screen.second(l, what)}`);
}

/**
 * Something that takes time, said while it runs: a star being lit (or a light passing over the words), and the
 * seconds. Keys typed meanwhile are dropped, so that they are not typed into what comes next; Ctrl+C still leaves.
 * Without motion or a terminal: the words once.
 */
async function waiting<T>(text: string, work: () => Promise<T>, kind: "light" | "think" = "light"): Promise<T> {
	const l = look();
	if (!ask.interactive() || !l.motion) {
		say(`  ${screen.second(l, `${text}…`)}`);
		return work();
	}
	const began = Date.now();
	const draw = () => {
		const t = Date.now() - began;
		// One row, always: \r only goes back to the start of the last row of a line that wrapped.
		const room = (process.stdout.columns || 80) - 1 - screen.width(ask.marginNow()) - 4;
		const seconds = ` ${Math.floor(t / 1000)} s`;
		let said = `${text}…`;
		if ([...said].length + seconds.length > room) said = `${[...said].slice(0, Math.max(1, room - seconds.length - 1)).join("")}…`;
		const words = kind === "think" ? screen.shimmer(l, said, t) : `${screen.lighting(l, t)} ${screen.bright(l, said)}`;
		process.stdout.write(`\r\x1b[K${ask.marginNow()}  ${words}${screen.faint(l, seconds)}`);
	};
	const input = process.stdin;
	const drop = (b: Buffer) => {
		if (!b.includes(3)) return;
		process.stdout.write("\r\x1b[K\x1b[?25h\n");
		process.exit(130);
	};
	input.setRawMode(true);
	input.on("data", drop);
	input.resume();
	process.stdout.write("\x1b[?25l");
	draw();
	const timer = setInterval(draw, 120);
	try {
		return await work();
	} finally {
		clearInterval(timer);
		input.off("data", drop);
		input.setRawMode(false);
		input.pause();
		process.stdout.write("\r\x1b[K\x1b[?25h");
	}
}

/** 1. Herdr Core: found and used as it is, or installed with Herdr's own installer; recent enough; running. */
async function machine(): Promise<boolean> {
	begin(1);
	const l = look();
	ask.ok(`${process.platform === "darwin" ? "macOS" : "Linux"} ${os.arch()} · Node.js ${process.versions.node} · pi ${piPackage().version}`);
	let hc = herdr.find();
	if (hc) ask.ok(`Herdr Core ${hc.version} found (${tilde(herdr.fullPath(hc.bin))}): ${PRODUCT} uses it as it is`);
	else {
		say(`  ${screen.second(l, "Herdr Core is not on this machine.")} ${PRODUCT} runs your agent inside it: a small program that keeps`);
		say("  terminals alive in the background, so your agent keeps working when you close this window.");
		if (!(await ask.confirm("Install Herdr Core now? (Herdr's own installer, into ~/.local/bin)"))) {
			ask.fail(`${PRODUCT} needs Herdr Core. Install it yourself (https://herdr.dev), then run ${COMMAND} setup again.`);
			end("Herdr Core is missing", false);
			return false;
		}
		ask.margin("");
		const installed = herdr.install();
		ask.margin(`  ${screen.line(l, "│")}`);
		if (!installed || !(hc = herdr.find())) {
			ask.fail(`Herdr Core did not install. Its installer said why, above; or see https://herdr.dev. Then: ${COMMAND} setup`);
			end("Herdr Core is missing", false);
			return false;
		}
		herdr.markInstalled();
		ask.ok(`Herdr Core ${hc.version} installed`);
	}
	herdr.use(hc.bin);
	if (!herdr.atLeast(hc.version, herdr.MIN_VERSION)) {
		ask.warn(`Herdr Core ${hc.version} is older than ${herdr.MIN_VERSION}, the oldest ${PRODUCT} is tested with.`);
		if (!(await ask.confirm("Update it now? (its running terminals keep running)")) || !herdr.update() || !(hc = herdr.find()) || !herdr.atLeast(hc.version, herdr.MIN_VERSION)) {
			ask.fail(`Update Herdr Core (hc update), then run ${COMMAND} setup again.`);
			end(`Herdr Core ${hc?.version ?? ""} is too old`, false);
			return false;
		}
	}
	if (!(await herdr.isRunning())) {
		try {
			await waiting("Starting Herdr Core", () => herdr.startServerAsync());
		} catch (err) {
			ask.fail(`Herdr Core ${hc.version} does not start: ${(err as Error).message}`);
			end("Herdr Core does not start", false);
			return false;
		}
	}
	if (herdr.stopsAtLogout()) {
		ask.warn("On this machine, logging out stops your programs, your agent included. To keep it running:");
		hint(`sudo loginctl enable-linger ${os.userInfo().username}`);
	}
	end(`Herdr Core ${hc.version}, running`);
	return true;
}

/** pi's sign-in for one provider, in this terminal (pi asks, pi stores): with an account, or with an API key. */
async function signIn(p: providers.Provider): Promise<boolean> {
	let key = !p.account;
	if (p.account && p.apiKey)
		key = await ask.choose(`How do you sign in to ${p.name}?`, [
			{ label: p.account.label, value: false, note: p.account.subscription ? "your subscription" : undefined },
			{ label: "With an API key", value: true },
		]);
	hint(key ? "pi asks for the key here: paste it, then Enter. A first real answer checks it, in step 3." : "pi signs you in here: a browser opens, or pi shows a link and a code.");
	// Ctrl+C belongs to pi's sign-in (it cancels it); the guide goes on.
	const code = await handOver(() => providers.login([p.id, ...(key ? ["--api-key"] : [])]));
	if (code !== 0) {
		ask.warn(`${p.name}: not connected (pi said why, above).`);
		return false;
	}
	const { list, error } = await waiting("Asking pi what is connected now", () => providers.modelsAsync());
	if (list.some((m) => m.provider === p.id)) {
		ask.ok(`${p.name}: connected`);
		return true;
	}
	ask.warn(error ? `pi did not answer: ${error}` : `${p.name}: pi signed in, but lists no model for it.`);
	return false;
}

/** The terminal is handed to another program (pi, a channel's setup): no margin, and Ctrl+C is that program's (it
 * cancels what it does there); the guide goes on after it. */
async function handOver<T>(run: () => T | Promise<T>): Promise<T> {
	const kept = ask.marginNow();
	ask.margin("");
	const keep = () => {};
	process.on("SIGINT", keep);
	try {
		return await run();
	} finally {
		process.off("SIGINT", keep);
		ask.margin(kept);
	}
}

/** pi's own screen, in this terminal. */
async function piScreen(): Promise<void> {
	hint("pi opens here: /login connects a provider, /model chooses the model (Ctrl+S keeps it), /quit comes back.");
	await handOver(() => providers.openPi());
}

/** The model a provider starts with: pi's own choice for it, or the first pi lists. */
async function firstModel(id: string, list: providers.Model[]): Promise<string | undefined> {
	const mine = list.filter((m) => m.provider === id);
	if (!mine.length) return undefined;
	const preferred = await providers.defaultModel(id);
	return `${id}/${mine.some((m) => m.id === preferred) ? preferred : mine[0].id}`;
}

/**
 * 2. A model, the way pi does it: pi's list of providers here, pi's own sign-in (an account or an API key), pi's own
 * choice of model, which can be changed. pi's own screen stays there for what this does not cover. With agents
 * already made, only what is connected: each agent keeps its own model. The model to give a new agent, if any.
 */
async function model(existing: boolean, current?: string): Promise<{ model?: string; connected: boolean }> {
	begin(2);
	const all = await providers.providers();
	const name = (id: string) => all.find((p) => p.id === id)?.name ?? id;
	// One question to pi for what is connected, and the models it lists for it; asked again only after a sign-in.
	const read = async () => {
		const r = await waiting("Asking pi what is connected", () => providers.modelsAsync());
		if (r.error) ask.warn(`pi did not answer: ${r.error}`);
		return r.list;
	};
	let list = await read();
	const connectedNow = () => [...new Set(list.map((m) => m.provider))];
	let conn = connectedNow();
	if (conn.length) ask.ok(`pi is connected: ${conn.map(name).join(", ")}`);
	if (existing && conn.length) {
		end(`connected: ${conn.map(name).join(", ")}`);
		return { connected: true };
	}
	type Next = "keep" | "new" | "pi" | "later";
	let just: string | undefined; // the provider connected now
	let choice: Next = conn.length
		? await ask.choose<Next>("Use it?", [
				{ label: `Yes, ${conn.map(name).join(", ")}`, value: "keep" },
				{ label: "Connect another provider", value: "new" },
				{ label: "Open pi's own screen (/login, /model)", value: "pi", note: "for anything else" },
			])
		: "new";
	while (choice === "new" || choice === "pi") {
		if (!ask.interactive()) {
			ask.fail(`This step needs a terminal. Later: ${COMMAND} setup, or ${COMMAND} login <provider> --api-key`);
			break;
		}
		if (choice === "pi") await piScreen();
		else {
			if (!conn.length) hint(`pi signs in to these; ${PRODUCT} keeps nothing of it but what pi stores, in its own pi settings.`);
			const id = await ask.choose("Which provider?", [
				...all.map((p) => ({ label: p.name, value: p.id, note: [p.account ? (p.account.subscription ? "your subscription" : "an account") : "", p.apiKey ? "an API key" : ""].filter(Boolean).join(" or ") })),
				{ label: "Something else: pi's own screen", value: "\u0000pi", note: "/login there" },
				{ label: "Later", value: "\u0000later", note: `${COMMAND} setup again, any time` },
			]);
			if (id === "\u0000later") break;
			if (id === "\u0000pi") {
				choice = "pi";
				continue;
			}
			if (await signIn(all.find((p) => p.id === id) as providers.Provider)) just = id;
		}
		list = await read();
		conn = connectedNow();
		if (just || (choice === "pi" && conn.length)) break;
		choice = await ask.choose<Next>("What now?", [
			{ label: "Try another way", value: "new" },
			{ label: "Open pi's own screen (/login, /model)", value: "pi" },
			conn.length ? { label: `Use what is connected: ${conn.map(name).join(", ")}`, value: "keep" } : { label: "Later", value: "later", note: `${COMMAND} setup again, any time` },
		]);
	}
	if (!conn.length) {
		ask.fail(`No provider connected. Later: ${COMMAND} setup`);
		end("no model yet", false);
		return { connected: false };
	}
	// Agents already made keep their own model: nothing to choose.
	if (existing) {
		end(`connected: ${conn.map(name).join(", ")}`);
		return { connected: true };
	}
	// The agent's own model first, in the menu; pi's default otherwise; for a provider connected now, pi's choice for it.
	let m = just ? await firstModel(just, list) : current && list.some((x) => `${x.provider}/${x.id}` === current) ? current : await providers.chosenModel(list);
	if (!m) {
		ask.fail(`pi lists no model for ${conn.map(name).join(", ")}. See: ${COMMAND} models`);
		end("no model yet", false);
		return { connected: true };
	}
	ask.ok(current && m === current ? `the model: ${m} (what it runs with now)` : `the model: ${m}`);
	if (list.length > 1 && !(await ask.choose("Use this model?", [{ label: "Yes", value: true }, { label: "Choose another", value: false, note: `${list.length} models` }]))) {
		m = await ask.choose(
			"Which model?",
			list.map((x) => ({ label: `${x.provider}/${x.id}`, value: `${x.provider}/${x.id}`, note: x.context ? `context ${x.context}` : undefined })),
			Math.max(0, list.findIndex((x) => `${x.provider}/${x.id}` === m)),
		);
	}
	end(`${name(m.split("/")[0])} · ${m.slice(m.indexOf("/") + 1)}`);
	return { model: m, connected: true };
}

/** 3. The agent: one already made is kept; a first one gets a name and the model of step 2, starts in Herdr Core, and
 * says hello. `created` when this run made it. */
async function agent(model: string | undefined): Promise<{ name: string; created: boolean } | undefined> {
	begin(3);
	const names = agents.list();
	if (names.length) {
		const chosen = await providers.chosenModel();
		for (const n of names) {
			try {
				const a = agents.load(n);
				ask.ok(`${n}  ${a.settings.model ?? "no model"}  ${tilde(a.folder)}`);
				if (chosen && a.settings.model && chosen !== a.settings.model)
					hint(`it keeps its own model; for pi's default (${chosen}): "model" in ${tilde(path.join(a.folder, SETTINGS_FILE))}, then ${COMMAND} restart ${n}`);
			} catch (err) {
				ask.fail(`${n}: ${(err as Error).message}`);
			}
		}
		return { name: names[0], created: false };
	}
	if (!model) {
		end("not made yet: it needs a model (step 2)", false);
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
		end("not made", false);
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
	hint(`Its instructions, yours to edit: ${tilde(path.join(folder, "AGENTS.md"))}`);
	// The rule of the game, said once, before it runs.
	const l = look();
	say(`  ${screen.yours(l, "!")} ${name} is pi, the coding agent, with everything your account can do on this machine: there is no sandbox.`);
	say(`    ${screen.second(l, "It lives in Herdr Core, in the background: closing this window does not stop it.")}`);
	return { name, created: true };
}

/** Start the agent; one it has just met (created or started now) says hello. A running one is left alone: its
 * conversation is the person's, not the guide's. */
async function hello(name: string, created: boolean): Promise<boolean> {
	const l = look();
	const r = await waiting(`Starting ${name} in Herdr Core`, () => control.start(name, 60_000));
	if (r.ready === false) {
		ask.fail(`${name} did not get ready: ${r.trouble}`);
		end(`${name} is not running`, false);
		return false;
	}
	say(`  ${screen.star(l)} ${screen.bright(l, `${name} is alive.`, true)}`);
	const a = agents.loadRecord(name);
	let said: string[] = [];
	let error: string | undefined;
	const ask_ = () => waiting(`Asking ${name} to say hello`, () => greet(a.paths.port), "think");
	if (created) ({ said, error } = await ask_());
	else {
		// A kept agent is not greeted, unless its provider refused its credentials last time: then they are put right
		// below, and a hello checks them.
		const last = control.status(name).lastError?.error;
		if (!last || !bridge.refused(last)) {
			end(`${name} is alive`);
			return true;
		}
		({ said, error } = await ask_()); // perhaps put right since (pp login): asked again only if still refused
	}
	// The hello is the first real request: a provider refusing the credentials is put right here, with pi's sign-in.
	const provider = (agents.load(name).settings.model ?? "").split("/")[0];
	for (let tries = 0; !said.length && error && bridge.refused(error) && tries < 3 && ask.interactive(); tries++) {
		ask.fail(error.replace(/\. To enter new ones: .*$/, ""));
		const p = (await providers.providers()).find((x) => x.id === provider);
		if (!(await ask.confirm(`Sign in to ${p?.name ?? provider} again?`))) break;
		if (p) await signIn(p);
		else await piScreen();
		({ said, error } = await ask_());
	}
	if (said.length) for (const line of said.join("\n").split("\n")) say(`  ${screen.alive(l, `${name} ›`)} ${line}`);
	else ask.warn(`no answer yet${error ? `: ${error}` : ""}. See: ${COMMAND} status`);
	end(said.length ? `${name} is alive, and answered` : `${name} is running, but has not answered yet`, said.length > 0);
	return said.length > 0;
}

/** Ask the agent to say hello, and wait (2 minutes at most) for what it says, or why it could not. */
async function greet(dir: string): Promise<{ said: string[]; error?: string }> {
	const id = `setup-${randomUUID()}`;
	const from = port.end(dir);
	port.submit(dir, { id, text: "Hello! I have just set you up. (This is our first meeting: see \"First meeting\" in your instructions.)", conversation: "cli" });
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

/** 4. The channels that ship with Pi-Personal and can set themselves up: now, or later. */
async function reach(name: string): Promise<string[]> {
	begin(4);
	const a = agents.load(name);
	const shipped = fs.readdirSync(path.join(ROOT, "channels")).filter((c) => agents.shipped(c));
	const on: string[] = [];
	hint("From your phone, wherever you are. Telegram ships with it; any other channel is a small program.");
	for (const ch of shipped) {
		const title = ch[0].toUpperCase() + ch.slice(1);
		if (a.settings.channels?.[ch] && (a.settings.channels[ch] as { enabled?: boolean }).enabled !== false) {
			ask.ok(`${title}: on`);
			on.push(title);
			continue;
		}
		const now = await ask.choose(`Talk to ${name} from ${title}?`, [
			{ label: "Later", value: false, note: `${COMMAND} setup again, any time` },
			{ label: `Yes, set up ${title} now`, value: true, note: "about 2 minutes" },
		]);
		if (!now) continue;
		const p = channelProgram(agents.withChannel(a, ch), ch);
		// Ctrl+C belongs to the channel's setup (it skips that step); the guide goes on.
		const r = await handOver(() => spawnSync(p.command, [...p.args, "setup"], { stdio: "inherit", cwd: p.cwd, env: p.env }));
		if (r.status !== 0) {
			if (r.status !== 3) ask.fail(`${title} is not set up. Later: ${COMMAND} setup`);
			continue;
		}
		agents.turnOn(a.folder, ch);
		const u = control.up(name);
		ask.ok(`${title}: on${u.started.includes(ch) ? ", and running" : ""}`);
		on.push(title);
	}
	end(on.length ? `${on.join(", ")}: on` : `from this machine for now (${COMMAND}); ${COMMAND} setup adds a channel later`, true);
	return on;
}

/** 5. The login service: it brings the agent back by itself when it stops. */
async function stay(name: string): Promise<boolean> {
	begin(5);
	// It runs `pp up --if-running`: at login and every 5 minutes, it brings back what should run, as long as Herdr Core
	// runs, or after a restart of the machine when it may start Herdr Core (below).
	const { serviceInstalled, serviceInstall, bootAllowed, allowBoot } = await import("./setup.ts");
	let on = serviceInstalled();
	if (!on && (await ask.confirm(`Bring ${name} back by itself if it stops? (checked at login and every 5 minutes)`))) {
		try {
			serviceInstall();
			on = true;
		} catch (err) {
			ask.fail(`the login service did not install: ${(err as Error).message}`);
		}
	}
	// After a restart of the machine: the service may start Herdr Core too. Without asking when Pi-Personal installed
	// it (nothing else of the person's runs there); with a yes when it is the person's own (default no).
	let boot = on && bootAllowed();
	if (on && !boot) {
		if (herdr.installedByUs()) boot = true;
		else if (await ask.confirm("Also start Herdr Core when this machine starts? It is yours (it was here before): it would run with this service's settings.", false)) {
			allowBoot(true);
			boot = true;
		}
	}
	if (boot && herdr.stopsAtLogout()) ask.warn(`On this machine the service runs only once you log in, unless: sudo loginctl enable-linger ${os.userInfo().username}`);
	end(
		!on ? `brought back when you run ${COMMAND} start` : boot ? "brought back by itself if it stops, and after a restart of this machine" : `brought back by itself if it stops; after a restart of this machine: ${COMMAND} start`,
		on,
	);
	return on;
}

/** pp setup on a machine where everything is set up: a menu of what can be changed. undefined: the whole guide. */
async function menu(): Promise<number | undefined> {
	const names = agents.list();
	const name = names.length > 1 ? await ask.choose("Which agent?", names.map((n) => ({ label: n, value: n }))) : names[0];
	type Doing = "reach" | "model" | "stay" | "all" | "quit";
	for (;;) {
		ask.margin("");
		say("");
		const what = await ask.choose<Doing>(`${name} is set up. What would you like to change?`, [
			{ label: "Talk to it from my phone", value: "reach", note: "a channel: Telegram" },
			{ label: "Its model, or the provider", value: "model" },
			{ label: "Coming back by itself", value: "stay", note: "after a stop, after a restart of the machine" },
			{ label: "The whole guide again", value: "all" },
			{ label: "Nothing", value: "quit" },
		]);
		if (what === "quit") return 0;
		if (what === "all") return undefined;
		if (what === "reach") await reach(name);
		if (what === "stay") await stay(name);
		if (what === "model") {
			const a = agents.load(name);
			const m = await model(false, a.settings.model);
			if (m.model && m.model !== a.settings.model) {
				agents.editSettings(a.folder, (x) => {
					x.model = m.model;
				});
				const r = await waiting(`Restarting ${name} with ${m.model}`, () => control.restart(name));
				if (r.ready === false) ask.fail(`${name} did not get ready: ${r.trouble}`);
				else ask.ok(`${name} runs with ${m.model}`);
			} else if (m.model) ask.ok(`${name} already runs with ${m.model}`);
		}
	}
}

export async function setup(version: string): Promise<number> {
	// The opening plays in full the first time on a machine, where there is room; afterwards the guide opens on the
	// small mark. Outside a terminal: the name and the version, plain.
	if (ask.interactive()) await screen.sense(); // the terminal's background, before the first colour
	const l = look();
	const columns = process.stdout.columns || 80;
	if (ask.interactive() && columns >= screen.OPENING_COLS && (process.stdout.rows || 0) > screen.OPENING_ROWS + 2 && screen.openingDue(l)) {
		await screen.play((t) => screen.opening(l, version, t), screen.OPENING_MS);
		screen.openingSeen();
	} else for (const s of screen.header(l, version, columns)) say(s);
	say("  Your own agent: a pi session that lives in Herdr Core on this machine, and answers wherever you write to it.");
	say(`  ${screen.second(l, `Five steps, about 4 minutes: ${STEPS.join(" · ")}.`)}`);
	say(`  ${screen.faint(l, `Run ${COMMAND} setup again any time: it keeps what is done.`)}`);
	try {
		// Everything set up already, at a terminal: what to change, rather than the whole guide again.
		if (ask.interactive() && agents.list().length && (await herdr.isRunning())) {
			numbered = false;
			const done = await menu();
			numbered = true;
			if (done !== undefined) return done;
		}
		if (!(await machine())) return 1;
		const existing = agents.list().length > 0;
		const m = await model(existing);
		if (!m.connected && !existing) return 1;
		const made = await agent(m.model);
		if (!made) return 1;
		const { name } = made;
		const ok = await hello(name, made.created);
		const channels = await reach(name);
		await stay(name);
		// What now: the one thing to do first, then the rest.
		say("");
		say(
			!ok
				? `  ${screen.yours(l, "!")} ${screen.bright(l, `${name} runs, but has not answered yet: see step 3.`, true)}`
				: made.created
					? `  ${screen.star(l)} ${screen.bright(l, `${name} is ready, and waits for your answer.`, true)}`
					: `  ${screen.star(l)} ${screen.bright(l, `${name} is ready.`, true)}`,
		);
		say("");
		const row = (label: string, what: string) => say(`  ${label.padEnd(18)}${what}`);
		say(`  ${screen.yours(l, "Open it:".padEnd(18), true)}${screen.bright(l, COMMAND, true)}   ${screen.second(l, "(Enter opens it, ctrl+\\ comes back)")}`);
		if (channels.length) row("From your phone:", `write to it on ${channels.join(", ")}`);
		row("Everything:", `${COMMAND} help`);
		return ok ? 0 : 1;
	} finally {
		ask.margin("");
	}
}
