// `pp` alone. In a terminal: the home screen, each agent and how it is, and Enter opens it (its own screen, where
// pi works; ctrl+\ comes back here, and the agent keeps running). Outside a terminal (a script, a pipe): the same in
// plain text, with the next thing to do. Looking never starts Herdr Core; Enter on an agent that is not running does.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as ask from "./ask.ts";
import { hint, say, style } from "./ask.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT } from "./name.ts";
import { ago, ROOT, tilde } from "./paths.ts";
import * as screen from "./screen.ts";

export async function home(version: string): Promise<number> {
	return ask.interactive() ? live(version) : overview(version);
}

// ---- what the screen knows ----------------------------------------------------------------------------------------------------
interface Row {
	name: string;
	s?: control.AgentStatus;
	error?: string;
}
interface Snapshot {
	up: boolean; // Herdr Core runs
	rows: Row[];
}
async function snapshot(): Promise<Snapshot> {
	const up = await herdr.isRunning();
	return {
		up,
		rows: agents.list().map((name) => {
			if (!up) return { name };
			try {
				return { name, s: control.status(name) };
			} catch (err) {
				return { name, error: (err as Error).message };
			}
		}),
	};
}

/** How an agent is, in a sign, a word, an optional line of detail, and what Enter does. */
interface Verdict {
	sign: string;
	word: string;
	detail?: string;
	action: "open" | "start" | "restart" | "doctor" | "status";
	label: string; // what Enter says it does
}
function look(l: screen.Look, row: Row, up: boolean, t: number): Verdict {
	const off = (word: string, detail?: string): Verdict => ({ sign: screen.second(l, "○"), word: screen.second(l, word), detail, action: "start", label: `start ${row.name}` });
	if (!up) return off("not running", "Herdr Core is not running; Enter starts both");
	if (row.error) return { sign: screen.broken(l, "✘"), word: screen.broken(l, "broken"), detail: row.error, action: "doctor", label: "see why" };
	const s = row.s as control.AgentStatus;
	// Its runner lives in another terminal or Herdr Core: nothing to start or open from here.
	if (s.elsewhere) return { sign: screen.second(l, "◌"), word: screen.second(l, "running elsewhere"), detail: `its runner (pid ${s.elsewhere}) is in another terminal or Herdr Core`, action: "status", label: "full status" };
	// Broken settings: a running agent still opens (it runs with what it had read); a stopped one cannot start.
	if (s.settingsError && !s.running) return { sign: screen.broken(l, "✘"), word: screen.broken(l, "its settings are broken"), detail: s.settingsError, action: "doctor", label: "see why" };
	if (s.failed) return { sign: screen.broken(l, "✦"), word: screen.broken(l, "cannot start"), detail: s.failed.reason, action: "restart", label: "try again" };
	if (!s.running) return off(s.stoppedOnPurpose ? "stopped" : "not running");
	const last = s.settingsError ? `its settings are broken: ${s.settingsError}` : s.lastError ? `last error (${s.lastError.at}): ${s.lastError.error}` : undefined;
	if (s.state === "blocked") return { sign: screen.yours(l, "✦"), word: screen.yours(l, "waiting for you"), detail: s.question ?? last, action: "open", label: `answer ${row.name}` };
	if (s.safeMode) return { sign: screen.yours(l, "✦"), word: screen.yours(l, "running with extensions off"), detail: s.safeMode.reason, action: "open", label: `open ${row.name}` };
	return { sign: screen.star(l, t), word: screen.alive(l, s.state), detail: last, action: "open", label: `open ${row.name}` };
}
function details(l: screen.Look, row: Row): string {
	const s = row.s;
	if (!s) return "";
	const channels = s.channels.map((c) => `${c.name} ${c.failed ? "failed" : c.running ? "on" : "off"}`);
	return [s.model ?? "no model", ...channels].join(" · ");
}
/** A line cut to `w` columns (colour codes are not counted), with … when cut. */
function fit(s: string, w: number): string {
	s = s.replace(/[\r\n\t]+/g, " "); // one line, whatever an error message holds
	if (screen.width(s) <= w) return s;
	const plain = s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	return `${[...plain].slice(0, Math.max(0, w - 1)).join("")}…`;
}
/** The keys and what they do, on one line; when it is too narrow, closer together, then only the arrows, Enter and q. */
function keyLine(l: screen.Look, keys: [string, string][], columns = 1000): string {
	const line = (ks: [string, string][], gap: string) => `  ${ks.map(([k, what]) => `${screen.yours(l, k, true)} ${screen.second(l, what)}`).join(gap)}`;
	const few = keys.filter(([k]) => k === "enter" || k === "q" || k === "↑↓" || k === "←→");
	for (const candidate of [line(keys, "    "), line(keys, "  "), line(few, "  ")]) if (screen.width(candidate) < columns) return candidate;
	return line(few.filter(([k]) => k === "enter"), "");
}

// ---- the menu -----------------------------------------------------------------------------------------------------------
/** What can be done from the home screen, for the chosen agent and for Pi-Personal: each with its key. */
type Choice =
	| { do: "quit" }
	| { do: "setup" }
	| { do: "agent"; name: string } // what its state calls for: open it, start it, try again, see why
	| { do: "status" | "model" | "new" | "restart" | "log"; name: string }
	| { do: "doctor" | "update" };
interface Item {
	key: string;
	label: string;
	choice: Choice;
	gap?: boolean; // a little room above it: the start of Pi-Personal's own items
}
function menu(snap: Snapshot, at: number, verdict?: Verdict): Item[] {
	if (!snap.rows.length) return [{ key: "enter", label: "Set it up", choice: { do: "setup" } }, { key: "q", label: "Quit", choice: { do: "quit" } }];
	const name = snap.rows[at].name;
	const first = verdict?.label ?? `open ${name}`;
	return [
		{ key: "o", label: `${first[0].toUpperCase()}${first.slice(1)}`, choice: { do: "agent", name } },
		{ key: "s", label: "Status", choice: { do: "status", name } },
		{ key: "m", label: "Model and thinking", choice: { do: "model", name } },
		{ key: "n", label: "New conversation", choice: { do: "new", name } },
		{ key: "r", label: `Restart ${name}`, choice: { do: "restart", name } },
		{ key: "l", label: "Its log", choice: { do: "log", name } },
		{ key: "c", label: "Set up: channels, model, agents", choice: { do: "setup" }, gap: true },
		{ key: "d", label: "Check everything", choice: { do: "doctor" } },
		{ key: "u", label: `Update ${PRODUCT}`, choice: { do: "update" } },
		{ key: "q", label: "Quit", choice: { do: "quit" } },
	];
}

// ---- the picture ----------------------------------------------------------------------------------------------------------
/** The mark, with a light that passes over it when the screen opens, then now and then: alive, not busy. */
const glint = (l: screen.Look, t: number) => (l.motion ? ((t % 9000) - 300) / 1100 : -1);

export function picture(l: screen.Look, version: string, snap: Snapshot, at: number, t: number, columns: number, rows = Number.POSITIVE_INFINITY, item = 0): string[] {
	const looks = snap.rows.map((r) => look(l, r, snap.up, t));
	const items = menu(snap, at, looks[at]);
	const out: string[] = [""];
	const wide = l.depth !== "none" && columns >= 52;
	if (!snap.rows.length) {
		const text = [`${screen.bright(l, PRODUCT, true)}  ${screen.second(l, version)}`, screen.second(l, "Nothing is set up yet."), "", ""];
		out.push(...(wide ? screen.mark(l, glint(l, t)).map((row, i) => `  ${row}   ${text[i]}`.trimEnd()) : text.slice(0, 2).map((s) => `  ${s}`)));
	} else if (snap.rows.length === 1 && wide) {
		// One agent: the mark, and the agent beside it.
		const r = snap.rows[0];
		const chosen = looks[0];
		const room = columns - 24;
		const head = `${screen.bright(l, r.name, true)}  ${chosen.sign} ${chosen.word}`;
		const text = [
			screen.width(head) <= room ? head : fit(head, room),
			screen.second(l, fit(details(l, r), room)),
			chosen.detail ? screen.faint(l, fit(chosen.detail, room)) : "",
			screen.faint(l, `${PRODUCT} ${version}`),
		];
		out.push(...screen.mark(l, glint(l, t)).map((row, i) => `  ${row}   ${text[i]}`.trimEnd()));
	} else {
		// Several agents (or no colour, or a narrow terminal): the name of the product, then a line each, the chosen one
		// marked; its detail under it. When there are more agents than room, the ones around the chosen one.
		out.push(`  ${screen.bright(l, PRODUCT, true)}  ${screen.second(l, version)}`, "");
		const menuRows = items.length + 4;
		const room = Number.isFinite(rows) ? Math.max(1, rows - 4 - menuRows) : snap.rows.length * 2;
		const from = snap.rows.length <= room ? 0 : Math.min(Math.max(0, at - Math.floor(room / 2)), snap.rows.length - room);
		snap.rows.forEach((r, i) => {
			if (i < from || i >= from + room) return;
			const lk = looks[i];
			const pick = i === at && snap.rows.length > 1;
			const name = pick ? screen.yours(l, r.name, true) : screen.bright(l, r.name, true);
			const line = `  ${pick ? screen.yours(l, "▸") : " "} ${name}  ${lk.sign} ${lk.word}`;
			out.push(screen.width(line) <= columns - 1 ? line : fit(line, columns - 1));
			if (i === at) for (const more of [details(l, r), lk.detail]) if (more) out.push(screen.faint(l, fit(`      ${more}`, columns - 1)));
		});
	}
	// The menu: a line each, the key on the right; ↑↓ move, Enter or the key does it. Too low a terminal: the keys only.
	out.push("");
	const fits = !Number.isFinite(rows) || out.length + items.length + 4 <= rows;
	if (fits) {
		const w = Math.min(44, columns - 6);
		items.forEach((it, i) => {
			if (it.gap) out.push(screen.line(l, `    ${"─".repeat(w)}`));
			const on = i === Math.min(item, items.length - 1);
			const key = it.key === "enter" ? "⏎" : it.key;
			const label = fit(it.label, Math.max(4, w - 4));
			const pad = " ".repeat(Math.max(1, w - screen.width(label)));
			out.push(on ? `  ${screen.yours(l, "›")} ${screen.bright(l, label, true)}${pad}${screen.yours(l, key, true)}` : `    ${screen.second(l, label)}${pad}${screen.faint(l, key)}`);
		});
		out.push("");
		const keys: [string, string][] = [["↑↓", "choose"], ["enter", "do it"]];
		if (snap.rows.length > 1) keys.push(["←→", "agent"]);
		out.push(keyLine(l, keys, columns));
	} else {
		const on = items[Math.min(item, items.length - 1)];
		out.push(keyLine(l, [["enter", on.label.toLowerCase()], ["↑↓", "choose"], ...items.map((it) => [it.key, it.label.split(/[ :]/)[0].toLowerCase()] as [string, string])], columns));
	}
	out.push("");
	return out;
}

/** An agent's status as a page: what it runs with, its channels, and what happened lately, in words read at a glance. */
function statusPage(l: screen.Look, name: string): string[] {
	let s: control.AgentStatus;
	try {
		s = control.status(name);
	} catch (err) {
		return ["", `  ${screen.broken(l, "✘")} ${screen.bright(l, name, true)}  ${(err as Error).message}`, ""];
	}
	const v = look(l, { name, s }, true, 0);
	let thinking: string | undefined;
	try {
		thinking = agents.load(name).settings.thinking;
	} catch {} // its broken settings are shown below
	const rows: [string, string][] = [
		["Model", s.model ?? screen.second(l, "pi's default")],
		["Thinking", thinking ?? screen.second(l, "as the conversation last used")],
		["Folder", tilde(s.folder)],
	];
	for (const c of s.channels) rows.push([c.name[0].toUpperCase() + c.name.slice(1), c.failed ? screen.broken(l, `failed: ${c.failed.reason}`) : c.running ? screen.alive(l, c.state) : screen.second(l, c.state)]);
	if (!s.channels.length) rows.push(["Channels", screen.second(l, "none yet: Set up (c) adds Telegram")]);
	rows.push(["Waiting", s.pending ? `${s.pending} message${s.pending > 1 ? "s" : ""}` : screen.second(l, "nothing")]);
	if (s.question) rows.push(["Asks you", screen.yours(l, s.question)]);
	if (s.safeMode) rows.push(["Safe mode", screen.yours(l, s.safeMode.reason)]);
	if (s.settingsError) rows.push(["Settings", screen.broken(l, s.settingsError)]);
	if (s.failed) rows.push(["Failed", screen.broken(l, s.failed.reason)]);
	if (s.lastError) rows.push(["Last error", `${screen.second(l, ago(s.lastError.at))} ${s.lastError.error}`]);
	if (s.lastRestart) rows.push(["Restarted", `${screen.second(l, ago(s.lastRestart.at))} ${s.lastRestart.reason}`]);
	const columns = process.stdout.columns || 80;
	return [
		"",
		`  ${v.sign} ${screen.bright(l, name, true)}  ${v.word}`,
		`  ${screen.line(l, "─".repeat(Math.min(56, columns - 4)))}`,
		...rows.map(([k, val]) => `  ${screen.second(l, k.padEnd(12))}${fit(val, columns - 16)}`),
		"",
	];
}

// ---- the screen that lives ---------------------------------------------------------------------------------------------------

/** The home screen, full screen (the terminal's alternate screen, as htop does): what is printed meanwhile (a full
 * status, Herdr's own lines) goes to the normal screen, which is given back as it was when the person leaves. */
async function live(version: string): Promise<number> {
	// Ctrl+C at a moment no screen reads the keys (while statuses are read, a child runs): the terminal is given back
	// as it was before leaving.
	const restore = () => {
		process.stdout.write("\x1b[?25h");
		screen.fullScreen(false);
	};
	const interrupted = () => {
		restore();
		process.exit(130);
	};
	process.on("SIGINT", interrupted);
	process.on("exit", restore);
	screen.fullScreen(true);
	try {
		return await loop(version);
	} finally {
		process.off("SIGINT", interrupted);
		process.off("exit", restore);
		restore();
	}
}

async function loop(version: string): Promise<number> {
	const cli = path.join(ROOT, "core", "cli.ts");
	const own = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env: { ...process.env, [`${ENV}_COMMAND`]: COMMAND } });
	/** Something to read or answer on the normal screen (a status, a question, a command's lines), then back here. */
	const aside = async (l: screen.Look, show: () => unknown, label = "back") => {
		screen.fullScreen(false);
		await show();
		await back(l, label);
		screen.fullScreen(true);
	};
	let chosen = ""; // the chosen agent, by name: it stays chosen when the list changes
	let item = 0; // the menu line Enter does
	const began = Date.now(); // the screen's own clock: its light passes when it opens
	for (;;) {
		const l = screen.look();
		let snap = await snapshot();
		const at = () => Math.max(0, snap.rows.findIndex((r) => r.name === chosen));
		chosen = snap.rows[at()]?.name ?? "";
		// What is shown is read again every few seconds: an agent that starts working, or stops, is seen without a key.
		let reading = false;
		const refresh = setInterval(async () => {
			if (reading) return;
			reading = true;
			try {
				snap = await snapshot();
				chosen = snap.rows[at()]?.name ?? "";
			} finally {
				reading = false;
			}
		}, 3000);
		const items = () => menu(snap, at(), snap.rows.length ? look(l, snap.rows[at()], snap.up, 0) : undefined);
		const { result } = await screen.live<Choice>(
			() => picture(l, version, snap, at(), Date.now() - began, process.stdout.columns || 80, process.stdout.rows || 24, item),
			(k) => {
				const list = items();
				if (k === "\x1b") return { do: "quit" };
				if (k === "\r") return list[Math.min(item, list.length - 1)].choice;
				const hit = list.find((it) => it.key === k);
				if (hit) return hit.choice;
				if (k === "\x1b[A" || k === "k") item = (Math.min(item, list.length - 1) + list.length - 1) % list.length;
				if (k === "\x1b[B" || k === "j") item = (Math.min(item, list.length - 1) + 1) % list.length;
				const n = snap.rows.length;
				if (n > 1 && (k === "\x1b[D" || k === "h")) chosen = snap.rows[(at() + n - 1) % n].name;
				if (n > 1 && (k === "\x1b[C" || k === "\t")) chosen = snap.rows[(at() + 1) % n].name;
				return undefined;
			},
			{ do: "quit" },
			{ top: true, every: l.motion ? 120 : 3000 },
		);
		clearInterval(refresh);
		if (result.do === "quit") return 0;
		if (result.do === "setup") {
			if (!snap.rows.length) {
				screen.fullScreen(false);
				const { setup } = await import("./welcome.ts");
				return setup(version);
			}
			await aside(l, () => own(["setup"]));
			continue;
		}
		if (result.do === "doctor") {
			await aside(l, () => own(["doctor"]));
			continue;
		}
		if (result.do === "update") {
			await aside(l, async () => {
				if (await ask.confirm(`Update ${PRODUCT}? The agents restart after it, and their conversations go on`, true)) own(["update"]);
			});
			continue;
		}
		const name = result.name;
		if (result.do === "status") {
			const { erase } = await screen.live(() => [...statusPage(l, name), keyLine(l, [["any key", "back"]])], () => true, true, { top: true, every: 60_000 });
			erase();
			continue;
		}
		if (result.do === "model") {
			await aside(l, () => chooseSettings(name, own));
			continue;
		}
		if (result.do === "new") {
			await aside(l, async () => {
				if (await ask.confirm(`Start a fresh conversation for ${name}? It will not remember this one (its log stays on disk)`, false)) own(["new", name]);
			});
			continue;
		}
		if (result.do === "restart") {
			await aside(l, () => own(["restart", name]));
			continue;
		}
		if (result.do === "log") {
			await aside(l, () => {
				const log = agents.loadRecord(name).paths.log;
				const lines = (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").trimEnd().split("\n").slice(-40);
				say(`  ${screen.bright(l, `${name}'s log`, true)}  ${screen.second(l, `the last ${lines.length} lines of ${tilde(log)}`)}\n`);
				for (const s of lines) say(`  ${s}`);
			});
			continue;
		}
		const row = snap.rows.find((r) => r.name === name) as Row;
		const what = look(l, row, snap.up, 0);
		if (what.action === "doctor" || what.action === "status") {
			await aside(l, () => own([what.action, ...(what.action === "status" ? [row.name] : [])]));
			continue;
		}
		if (what.action !== "open") {
			const up = await bringUp(l, row.name, snap.up, what.action === "restart");
			if (up.cancelled) continue;
			if (!up.ok) {
				const trouble = up.trouble;
				// Started, but not as it should (safe mode, slow to report): it still runs, and can be opened.
				if (control.find(agents.loadRecord(row.name))) await aside(l, () => say(`  ${screen.yours(l, "!")} ${row.name} runs, but ${trouble}`), `open ${row.name}`);
				else {
					await aside(l, () => say(`  ${screen.broken(l, "✘")} ${row.name} did not start: ${trouble}`));
					continue;
				}
			}
		}
		const t = control.find(agents.loadRecord(row.name));
		if (!t) {
			await aside(l, () => say(`  ${screen.broken(l, "✘")} ${row.name} is not running any more: ${COMMAND} status ${row.name}`));
			continue;
		}
		// Its own screen, where pi works. ctrl+\ comes back here; the agent keeps running.
		screen.fullScreen(false);
		const r = spawnSync(herdr.command(), ["attach", t.address], { stdio: "inherit" });
		if (r.error || r.status) await back(l, "back", `could not open ${row.name}'s screen: ${r.error?.message ?? `Herdr Core said no (exit ${r.status})`}. Try: ${COMMAND} attach ${row.name}`);
		screen.fullScreen(true);
	}
}

/** Model and thinking, chosen from lists, the ones in use first; only what changed is applied (each restarts the
 * agent's terminal; its conversation goes on). */
async function chooseSettings(name: string, own: (args: string[]) => unknown): Promise<void> {
	const settings = agents.load(name).settings;
	const { modelsAsync } = await import("./providers.ts");
	const { list } = await modelsAsync();
	const ids = list.map((m) => `${m.provider}/${m.id}`);
	const keep = settings.model ?? "";
	const model = await ask.choose(
		"Its model",
		[{ label: keep ? `keep ${keep}` : "keep pi's default", value: keep }, ...ids.filter((id) => id !== keep).map((id) => ({ label: id, value: id }))],
	);
	const level = settings.thinking ?? "";
	const thinking = await ask.choose("How much it thinks", [
		{ label: level ? `keep ${level}` : "keep: as the conversation last used", value: level },
		...agents.THINKING.filter((x) => x !== level).map((x) => ({ label: x, value: x })),
	]);
	if (model !== keep) own(["model", name, model]);
	if (thinking !== level) own(["thinking", name, thinking]);
	if (model === keep && thinking === level) say("  Nothing changed.");
}

/**
 * Start Herdr Core if it is not running, then the agent, while a star is lit. Keys typed meanwhile are dropped (they
 * would otherwise reach pi once its screen opens); Ctrl+C means "do not open it": the start itself goes on.
 */
async function bringUp(l: screen.Look, name: string, up: boolean, restart: boolean): Promise<{ ok: boolean; cancelled?: boolean; trouble?: string }> {
	const began = Date.now();
	let text = up ? `starting ${name}` : "starting Herdr Core";
	let cancelled = false;
	const draw = () => process.stdout.write(`\x1b[H\x1b[2J\n  ${screen.lighting(l, Date.now() - began)} ${screen.second(l, `${text}…`)}${cancelled ? screen.faint(l, "  (it will not open)") : ""}`);
	const timer = setInterval(draw, l.motion ? 120 : 1000);
	const input = process.stdin;
	const drop = (b: Buffer) => {
		if (b.includes(3)) cancelled = true;
	};
	input.setRawMode(true);
	input.on("data", drop);
	input.resume();
	draw();
	try {
		if (!up) {
			herdr.startServer();
			text = `starting ${name}`;
		}
		const r = restart ? await control.restart(name) : await control.start(name);
		return r.ready === false ? { ok: false, cancelled, trouble: r.trouble } : { ok: true, cancelled };
	} catch (err) {
		return { ok: false, cancelled, trouble: (err as Error).message };
	} finally {
		clearInterval(timer);
		input.off("data", drop);
		input.setRawMode(false);
		input.pause();
	}
}

/** Under something printed (a status, an error, a line `note`): a key brings the home screen back. */
async function back(l: screen.Look, label = "back", note?: string): Promise<void> {
	if (note) say(`  ${screen.broken(l, "✘")} ${note}`);
	const { erase } = await screen.live(() => ["", keyLine(l, [["any key", label]])], () => true, true, { every: 60_000 });
	erase(); // what was printed stays; the line about the key goes
}

// ---- outside a terminal: plain text, with the next thing to do ----------------------------------------------------------------
async function overview(version: string): Promise<number> {
	const names = agents.list();
	say(`${style.bright(PRODUCT)} ${style.second(version)}`);
	if (!names.length) {
		say("\nYour own agent, living in Herdr Core, reachable from anywhere. Nothing is set up yet.");
		say(`\n  Start here:  ${style.yours(`${COMMAND} setup`)}`);
		say(`  Everything:  ${COMMAND} help`);
		return 0;
	}
	const running = await herdr.isRunning();
	const next = new Set<string>();
	say("");
	for (const name of names) {
		if (!running) {
			say(`  ${style.bright(name)}  ${style.second("not running (Herdr Core is not running)")}`);
			next.add(`Start it:      ${COMMAND} start${names.length > 1 ? " --all" : ""}`);
			continue;
		}
		let s: control.AgentStatus;
		try {
			s = control.status(name);
		} catch (err) {
			say(`  ${style.bright(name)}  ${style.broken(`broken: ${(err as Error).message}`)}`);
			next.add(`See why:       ${COMMAND} doctor`);
			continue;
		}
		const state = s.failed ? style.broken("cannot start") : s.state === "blocked" ? style.yours("waiting for you") : s.running ? style.alive(s.state) : style.second(s.state);
		const channels = s.channels.map((c) => `${c.name} ${c.failed ? style.broken("failed") : c.running ? style.alive("on") : style.second("off")}`);
		say(`  ${style.bright(name)}  ${state}  ${style.second(s.model ?? "no model")}${channels.length ? `  ${style.second("·")} ${channels.join(", ")}` : ""}`);
		const who = names.length > 1 ? ` ${name}` : "";
		if (s.failed) {
			hint(s.failed.reason);
			next.add(`Why, in full:  ${COMMAND} status${who}`);
			next.add(`Try again:     ${COMMAND} restart${who}`);
		} else if (s.safeMode) {
			hint(`running with extensions off: ${s.safeMode.reason}`);
			next.add(`When fixed:    ${COMMAND} restart${who}`);
		} else if (s.settingsError) {
			hint(s.settingsError);
			next.add(`Its settings:  ${tilde(s.folder)}`);
		} else if (!s.running) next.add(`Start it:      ${COMMAND} start${who}`);
		else {
			if (s.state === "blocked") next.add(`Answer it:     ${COMMAND} attach${who}`);
			next.add(`Open it:       ${COMMAND} attach${who}`);
			if (!s.channels.length) next.add(`From Telegram: ${COMMAND} setup`);
		}
		if (s.lastError && !s.failed) hint(`last error (${s.lastError.at}): ${s.lastError.error}`);
	}
	say("");
	for (const n of next) say(`  ${n}`);
	say(`  Everything:    ${COMMAND} help`);
	return 0;
}
