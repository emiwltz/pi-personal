// `pp` alone. In a terminal: the home screen. The agent and how it is, then a menu of everything that can be done,
// with a preview of the chosen line beside it; each line opens its screen (status, model and thinking, extensions, the
// log, settings, check everything, update), and the first opens the agent itself: pi's own screen, where ctrl+\ comes
// back here while the agent keeps running. What changes something runs pp's own command, so that the screen and the
// commands never differ. Outside a terminal (a script, a pipe): the same in plain text, with the next thing to do.
// Looking never starts Herdr Core; opening an agent that is not running does.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as ask from "./ask.ts";
import { hint, say, style } from "./ask.ts";
import * as control from "./control.ts";
import { type Extension, isSource } from "./extensions.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT } from "./name.ts";
import { ago, defaultFolderParent, repository, ROOT, tilde } from "./paths.ts";
import * as screen from "./screen.ts";
import { bootAllowed, type Check, serviceInstalled } from "./setup.ts";

const { fit } = screen;

export async function home(version: string): Promise<number> {
	return ask.interactive() ? live(version) : overview(version);
}

// ---- what the screen knows ----------------------------------------------------------------------------------------------------
interface Row {
	name: string;
	s?: control.AgentStatus;
	thinking?: string;
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
				const s = control.status(name);
				let thinking: string | undefined;
				try {
					thinking = agents.load(name).settings.thinking;
				} catch {} // broken settings are in the status already
				return { name, s, thinking };
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
function details(row: Row): string {
	const s = row.s;
	if (!s) return "";
	const channels = s.channels.map((c) => `${c.name} ${c.failed ? "failed" : c.running ? "on" : "off"}`);
	return [s.model ?? "no model", ...(row.thinking ? [`thinking ${row.thinking}`] : []), ...channels].join(" · ");
}
/** The keys and what they do, on one line; when it is too narrow, closer together, then only the arrows, Enter and q. */
function keyLine(l: screen.Look, keys: [string, string][], columns = 1000): string {
	const line = (ks: [string, string][], gap: string) => `  ${ks.map(([k, what]) => `${screen.yours(l, k, true)} ${screen.second(l, what)}`).join(gap)}`;
	const few = keys.filter(([k]) => k === "enter" || k === "q" || k === "esc" || k === "↑↓" || k === "←→");
	for (const candidate of [line(keys, "    "), line(keys, "  "), line(few, "  ")]) if (screen.width(candidate) < columns) return candidate;
	return line(few.filter(([k]) => k === "enter"), "");
}
/** An agent's status, as label and value: what it runs with, its channels, what waits, what happened lately. */
function statusRows(l: screen.Look, row: Row | undefined): [string, string][] {
	if (!row?.s) return [["State", row?.error ? screen.broken(l, row.error) : screen.second(l, "Herdr Core is not running")]];
	const s = row.s;
	const rows: [string, string][] = [
		["Model", s.model ?? screen.second(l, "pi's default")],
		["Thinking", row.thinking ?? screen.second(l, "as the conversation last used")],
		["Folder", tilde(s.folder)],
	];
	for (const c of s.channels) rows.push([c.name[0].toUpperCase() + c.name.slice(1), c.failed ? screen.broken(l, `failed: ${c.failed.reason}`) : c.running ? screen.alive(l, c.state) : screen.second(l, c.state)]);
	if (!s.channels.length) rows.push(["Channels", screen.second(l, "none yet: Settings adds Telegram")]);
	rows.push(["Waiting", s.pending ? `${s.pending} message${s.pending > 1 ? "s" : ""}` : screen.second(l, "nothing")]);
	if (s.question) rows.push(["Asks you", screen.yours(l, s.question)]);
	if (s.safeMode) rows.push(["Safe mode", screen.yours(l, s.safeMode.reason)]);
	if (s.settingsError) rows.push(["Settings", screen.broken(l, s.settingsError)]);
	if (s.failed) rows.push(["Failed", screen.broken(l, s.failed.reason)]);
	if (s.lastError) rows.push(["Last error", `${screen.second(l, `${ago(s.lastError.at)} ·`)} ${s.lastError.error}`]);
	if (s.lastRestart) rows.push(["Restarted", `${screen.second(l, `${ago(s.lastRestart.at)} ·`)} ${s.lastRestart.reason}`]);
	return rows;
}
const labelled = (l: screen.Look, rows: [string, string][], w: number) => rows.map(([k, v]) => ` ${screen.second(l, k.padEnd(12))}${fit(v, w - 14)}`);

// ---- the menu, and the screens behind it --------------------------------------------------------------------------------------
/** What a key asks of the screen. */
type Act =
	| { open: Pane } // a screen over this one; Esc comes back
	| { back: true }
	| { ask: string[]; yes: () => Act | undefined } // a window: y does it, any other key does not
	| { work: string; pp: string[]; then?: (ok: boolean) => Act | undefined } // pp's own command, quietly, while a star is lit; what it says is shown
	| { out: () => Promise<number | void> } // something on the normal screen (pi's own, a step of the guide); a number ends pp
	| { quit: true }
	| "done"; // the key was used: nothing else to do
/** A screen behind a line of the menu: what it draws under the header, its keys, and what a key does. */
interface Pane {
	title: string;
	draw(w: number, h: number, t: number): string[];
	keys(): [string, string][];
	key(k: string): Act | undefined;
	window?(): string[] | undefined; // a window it shows over itself (the line that adds an extension)
}
interface Ctx {
	l: screen.Look;
	version: string;
	snap: () => Snapshot;
	exts: (name: string) => Extension[] | undefined; // the last list read; read again in the background
	reload: (name: string) => void;
	own: (args: string[]) => number; // pp's own command, on the normal screen
	quiet: (args: string[]) => Promise<{ ok: boolean; out: string; said: string }>; // the same, its output kept
}
const rowOf = (c: Ctx, name: string) => c.snap().rows.find((r) => r.name === name);
/** On the normal screen, then a key comes back here. */
const aside = (l: screen.Look, show: () => unknown) => async () => {
	screen.fullScreen(false);
	await show();
	await back(l);
	screen.fullScreen(true);
};
const KIND = { package: "▣", extension: "◈", skill: "◇" };
const THINKS: Record<string, string> = {
	off: "no reasoning: fastest, cheapest",
	minimal: "a glance before answering",
	low: "quick tasks, everyday talk",
	medium: "the balance most work needs",
	high: "harder problems, more care",
	xhigh: "long, tricky work",
	max: "slowest and costliest",
};
/** ↑↓ (or j and k) through `n` lines. */
const move = (k: string, i: number, n: number) => (k === "up" || k === "k" ? Math.max(0, i - 1) : k === "down" || k === "j" ? Math.min(n - 1, i + 1) : i);
const restart = (name: string, fresh = false): Act => (fresh ? { work: `a new conversation for ${name}`, pp: ["new", name] } : { work: `restarting ${name}`, pp: ["restart", name] });

interface Item {
	key: string;
	label: string;
	badge?: string;
	gap?: boolean; // a little room above it: the start of Pi-Personal's own lines
	preview: (w: number, h: number) => string[];
	act: () => Act | undefined;
}
function menu(c: Ctx, at: number): Item[] {
	const { l } = c;
	const snap = c.snap();
	const quit: Item = { key: "q", label: "Quit", preview: () => [" Leaves pp. The agents keep running."], act: () => ({ quit: true }) };
	if (!snap.rows.length) return [{ key: "enter", label: "Set it up", preview: () => [" The guide, step by step: about four minutes."], act: () => ({ out: async () => (screen.fullScreen(false), (await import("./welcome.ts")).setup(c.version)) }) }, quit];
	const row = snap.rows[at];
	const name = row.name;
	const v = look(l, row, snap.up, 0);
	const exts = c.exts(name);
	const fails = row.s?.safeMode?.broken.length ?? 0;
	return [
		{
			key: "o",
			label: `${v.label[0].toUpperCase()}${v.label.slice(1)}`,
			preview: () => [` ${v.detail ?? "pi's own screen, with everything pi offers."}`, screen.faint(l, " ctrl+\\ comes back here; the agent keeps running.")],
			act: () => (v.action === "doctor" ? { open: doctorPane(c, name) } : v.action === "status" ? { open: statusPane(c, name) } : { out: () => openAgent(c, name, v.action === "restart") }),
		},
		{ key: "s", label: "Status", preview: (w) => labelled(l, statusRows(l, row), w), act: () => ({ open: statusPane(c, name) }) },
		{ key: "m", label: "Model and thinking", badge: row.s?.model?.split("/").pop(), preview: (w) => labelled(l, statusRows(l, row).slice(0, 2), w), act: () => ({ open: modelPane(c, name) }) },
		{
			key: "e",
			label: "Extensions",
			badge: exts ? (exts.length ? `${exts.filter((x) => x.on).length} on${fails ? `, ${fails} failing` : ""}` : "none yet") : undefined,
			preview: (w) => (exts?.length ? exts.map((x) => ` ${screen.second(l, KIND[x.kind])} ${fit(x.name, w - 12, true)} ${x.on ? screen.alive(l, "on") : screen.second(l, "off")}`) : [screen.second(l, exts ? " None yet: Enter, then + adds one." : " …")]),
			act: () => ({ open: extPane(c, name) }),
		},
		{ key: "n", label: "New conversation", preview: () => [` ${name} forgets this conversation.`, screen.faint(l, " Its log stays on disk. Asks first.")], act: () => ({ ask: [`Start a fresh conversation for ${name}?`, screen.second(l, "It will not remember this one; its log stays on disk.")], yes: () => restart(name, true) }) },
		{ key: "r", label: `Restart ${name}`, preview: () => [` Restarts ${name} and its channels.`, screen.faint(l, " Its conversation goes on: nothing is lost.")], act: () => restart(name) },
		{ key: "l", label: "Its log", preview: (w, h) => tail(logOf(name), h).map((s) => ` ${logLine(l, s, w - 2)}`), act: () => ({ open: logPane(c, name) }) },
		{ key: "c", label: "Settings", badge: "channels, sign-in, agents", gap: true, preview: (w) => settingRows(c, name).map(([k, v]) => ` ${fit(k, 22, true)}${screen.second(l, fit(v, w - 25))}`), act: () => ({ open: settingsPane(c, name) }) },
		{ key: "d", label: "Check everything", preview: () => [" This machine, Herdr Core, coming back by itself,", " each agent: its model, extensions and channels.", screen.faint(l, " Enter on a problem goes where it is fixed.")], act: () => ({ open: doctorPane(c, name) }) },
		{ key: "u", label: `Update ${PRODUCT}`, preview: () => [` You have ${c.version}. Enter looks for a newer one,`, " and says what it changes before anything is done."], act: () => ({ open: updatePane(c) }) },
		quit,
	];
}

// ---- the picture ----------------------------------------------------------------------------------------------------------
/** The mark, with a light that passes over it when the screen opens, then now and then: alive, not busy. */
const glint = (l: screen.Look, t: number) => (l.motion ? ((t % 9000) - 300) / 1100 : -1);
const nobody = (l: screen.Look, version: string, snap: Snapshot): Ctx => ({ l, version, snap: () => snap, exts: () => undefined, reload: () => {}, own: () => 1, quiet: async () => ({ ok: false, out: "", said: "" }) });

export function picture(l: screen.Look, version: string, snap: Snapshot, at: number, t: number, columns: number, rows = Number.POSITIVE_INFINITY, item = 0, c = nobody(l, version, snap), note = ""): string[] {
	const looks = snap.rows.map((r) => look(l, r, snap.up, t));
	const items = menu(c, at);
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
		const text = [fit(head, room), screen.second(l, fit(details(r), room)), chosen.detail ? screen.faint(l, fit(chosen.detail, room)) : "", screen.faint(l, `${PRODUCT} ${version}`)];
		out.push(...screen.mark(l, glint(l, t)).map((row, i) => `  ${row}   ${text[i]}`.trimEnd()));
	} else {
		// Several agents (or no colour, or a narrow terminal): the name of the product, then a line each, the chosen one
		// marked; its detail under it. When there are more agents than room, the ones around the chosen one.
		out.push(`  ${screen.bright(l, PRODUCT, true)}  ${screen.second(l, version)}`, "");
		const room = Number.isFinite(rows) ? Math.max(1, rows - 8 - items.length) : snap.rows.length * 2;
		const from = snap.rows.length <= room ? 0 : Math.min(Math.max(0, at - Math.floor(room / 2)), snap.rows.length - room);
		snap.rows.forEach((r, i) => {
			if (i < from || i >= from + room) return;
			const lk = looks[i];
			const pick = i === at && snap.rows.length > 1;
			const name = pick ? screen.yours(l, r.name, true) : screen.bright(l, r.name, true);
			out.push(fit(`  ${pick ? screen.yours(l, "▸") : " "} ${name}  ${lk.sign} ${lk.word}`, columns - 1));
			if (i === at) for (const more of [details(r), lk.detail]) if (more) out.push(screen.faint(l, fit(`      ${more}`, columns - 1)));
		});
	}
	// The menu: a line each, the key on the right; ↑↓ move, Enter or the key does it. Beside it, when there is room, what
	// the chosen line shows or does. Too low a terminal: the keys only.
	out.push("");
	const on = items[Math.min(item, items.length - 1)];
	if (!Number.isFinite(rows) || out.length + items.length + 5 <= rows) {
		const w = Math.min(44, columns - 6);
		const lines: string[] = [];
		items.forEach((it) => {
			if (it.gap) lines.push(screen.line(l, `    ${"─".repeat(w)}`));
			const key = it.key === "enter" ? "⏎" : it.key;
			const label = it === on ? screen.bright(l, it.label, true) : screen.second(l, it.label);
			const text = fit(`${label}${it.badge ? `  ${screen.faint(l, it.badge)}` : ""}`, w - 4, true);
			lines.push(it === on ? `  ${screen.yours(l, "›")} ${text}  ${screen.yours(l, key, true)}` : `    ${text}  ${screen.faint(l, key)}`);
		});
		const room = Math.min(64, columns - w - 8);
		const h = Math.max(lines.length, 8);
		if (l.depth !== "none" && room >= 40) out.push(...screen.beside([lines, screen.frame(l, on.label.toLowerCase(), room, h, on.preview(room - 2, h - 2))], 2));
		else out.push(...lines, "", ...on.preview(columns - 6, 2).slice(0, 2).map((s) => `  ${screen.faint(l, fit(s, columns - 4))}`));
		out.push("", note ? `  ${fit(note, columns - 3)}` : "");
		const keys: [string, string][] = [["↑↓", "choose"], ["enter", "do it"]];
		if (snap.rows.length > 1) keys.push(["←→", "agent"]);
		out.push(keyLine(l, keys, columns));
	} else out.push(keyLine(l, [["enter", on.label.toLowerCase()], ["↑↓", "choose"], ...items.map((it) => [it.key, it.label.split(/[ :]/)[0].toLowerCase()] as [string, string])], columns));
	out.push("");
	return out;
}

// ---- the screens behind the menu ------------------------------------------------------------------------------------------------
function statusPane(c: Ctx, name: string): Pane {
	return {
		title: "Status",
		draw: (w, h, t) => {
			const row = rowOf(c, name);
			const v = row ? look(c.l, row, c.snap().up, t) : undefined;
			const fw = Math.min(w, 84);
			return screen.frame(c.l, name, fw, h, [v ? ` ${v.sign} ${v.word}` : "", "", ...labelled(c.l, statusRows(c.l, row), fw - 2)]);
		},
		keys: () => [["r", "restart"], ["l", "log"], ["m", "model"], ["esc", "back"]],
		key: (k) => (k === "r" ? restart(name) : k === "l" ? { open: logPane(c, name) } : k === "m" ? { open: modelPane(c, name) } : undefined),
	};
}

function modelPane(c: Ctx, name: string): Pane {
	const { l } = c;
	let models: string[] | undefined;
	let col = 0; // 0: the models, 1: thinking
	let q = ""; // typed: keeps the models that have it
	let mi = -1;
	const now = () => rowOf(c, name);
	let ti = Math.max(0, agents.THINKING.indexOf(now()?.thinking ?? "medium"));
	const load = () =>
		import("./providers.ts")
			.then((p) => p.modelsAsync())
			.then((r) => {
				models = r.list.map((m) => `${m.provider}/${m.id}`);
			});
	load();
	const shown = () => [...(models ?? []).filter((m) => m.includes(q)), "sign in to another provider…"];
	return {
		title: "Model and thinking",
		draw: (w, h) => {
			const list = shown();
			if (mi < 0 && models) mi = Math.max(0, list.indexOf(now()?.s?.model ?? ""));
			const i = Math.max(0, Math.min(mi, list.length - 1));
			const room = h - 4;
			const from = Math.max(0, Math.min(i - Math.floor(room / 2), list.length - room));
			let last = "";
			const left = [` ${screen.yours(l, "⌕")} ${q}${col === 0 ? screen.yours(l, "▏") : ""}${q ? "" : screen.faint(l, "type to filter")}`];
			for (const [k, m] of list.slice(from, from + room - 1).entries()) {
				const provider = m.includes("/") ? m.split("/")[0] : "";
				if (provider && provider !== last && left.length < room) left.push(screen.faint(l, ` ${provider.toUpperCase()}`));
				last = provider || last;
				const on = from + k === i && col === 0;
				const label = provider ? m.slice(provider.length + 1) : screen.yours(l, m);
				left.push(`${on ? screen.yours(l, " › ") : "   "}${on ? screen.bright(l, label, true) : label}${m === now()?.s?.model ? screen.alive(l, "  ● now") : ""}`);
			}
			if (!models) left.push(screen.second(l, "   reading the models pi lists…"));
			const right = [screen.faint(l, " How much it thinks before answering"), ""];
			agents.THINKING.forEach((x, k) => {
				const on = k === ti && col === 1;
				right.push(`${on ? screen.yours(l, " › ") : "   "}${on ? screen.bright(l, x, true) : x}${" ".repeat(9 - x.length)}${screen.faint(l, THINKS[x])}${x === now()?.thinking ? screen.alive(l, "  ●") : ""}`);
			});
			right.push("", screen.faint(l, ` ${name} restarts with it; its conversation goes on.`));
			if (w < 92) return screen.frame(l, col ? "thinking" : "model", w, h, col ? right : left, true);
			const lw = Math.floor((w - 2) / 2);
			return screen.beside([screen.frame(l, "model", lw, h, left, col === 0), screen.frame(l, "thinking", w - 2 - lw, h, right, col === 1)], 2);
		},
		keys: () => [["type", "filter"], ["↑↓", "choose"], ["tab", col ? "models" : "thinking"], ["enter", "apply"], ["esc", "back"]],
		key: (k) => {
			if (k === "tab" || k === "left" || k === "right") col = 1 - col;
			else if (k === "esc" && q) q = "";
			else if (k === "esc") return undefined;
			else if (col === 1 && (k === "up" || k === "down" || k === "j" || k === "k")) ti = move(k, ti, agents.THINKING.length);
			else if (col === 0 && (k === "up" || k === "down")) mi = move(k, Math.max(0, mi), shown().length);
			else if (k === "enter" && col === 1) return agents.THINKING[ti] === now()?.thinking ? "done" : { work: `${name} thinks at ${agents.THINKING[ti]}`, pp: ["thinking", name, agents.THINKING[ti]] };
			else if (k === "enter") {
				const m = shown()[Math.max(0, Math.min(mi, shown().length - 1))];
				if (!m.includes("/")) return { out: aside(l, () => (c.own(["login"]), load())) };
				return m === now()?.s?.model ? "done" : { work: `${name} runs with ${m}`, pp: ["model", name, m] };
			} else if (col === 0 && k === "bs") q = q.slice(0, -1);
			else if (col === 0 && k.length === 1) {
				q += k;
				mi = 0;
			}
			return "done";
		},
	};
}

function extPane(c: Ctx, name: string): Pane {
	const { l } = c;
	let i = 0;
	let q: string | undefined; // being typed: keeps the ones that have it
	let changed = false; // something was turned on, off, added or removed: the agent restarts when this screen is left
	let win: { input: string; every: boolean; found?: { name: string; description: string; version: string }[] | string; searched?: string; j: number } | undefined;
	const rows = () => (c.exts(name) ?? []).filter((x) => !q || `${x.name} ${x.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
	const failing = (x: Extension) => x.kind === "extension" && (rowOf(c, name)?.s?.safeMode?.broken ?? []).includes(x.name);
	const state = (x: Extension) => (failing(x) ? screen.broken(l, "✗ fails") : x.on ? screen.alive(l, "● on") : screen.second(l, "○ off"));
	const done = (ok: boolean): undefined => {
		if (ok) changed = true;
		return undefined;
	};
	const where = (x: Extension) => (x.every ? "every agent" : name);
	return {
		title: "Extensions",
		draw: (w, h) => {
			const all = rows();
			i = Math.max(0, Math.min(i, all.length - 1));
			const lw = w < 92 ? w : Math.floor((w - 2) * 0.55);
			const room = h - 4;
			const from = Math.max(0, Math.min(i - Math.floor(room / 2), all.length - room));
			const left = [q !== undefined ? ` ${screen.yours(l, "⌕")} ${q}${screen.yours(l, "▏")}` : screen.faint(l, ` ${all.length ? "what pi loads for it" : "none yet: + adds one"}${changed ? `; ${name} restarts when you leave` : ""}`)];
			for (const [k, x] of all.slice(from, from + room).entries()) {
				const on = from + k === i;
				const label = fit(`${screen.second(l, KIND[x.kind])} ${on ? screen.bright(l, x.name, true) : x.name}${x.every ? screen.faint(l, "  all") : ""}`, lw - 14, true);
				left.push(`${on ? screen.yours(l, "▌") : " "}${label} ${state(x)}`);
			}
			const x = all[i];
			if (w < 92 || !x) return screen.frame(l, `what ${name} can do`, w, h, left);
			const right = [` ${screen.bright(l, x.name, true)}${x.version ? screen.second(l, `  ${x.version}`) : ""}`, screen.second(l, ` ${x.kind}, for ${where(x)}`), screen.faint(l, ` ${x.source ?? tilde(x.path)}`), ""];
			for (const s of wrap(x.description ?? "", w - lw - 6)) right.push(` ${s}`);
			if (failing(x)) right.push("", screen.broken(l, " ✗ It does not load: safe mode keeps it off."), screen.faint(l, " Fix it in its folder, or turn it off."));
			right.push("", screen.faint(l, ` space ${x.on ? "turns it off" : "turns it on"}${x.kind === "package" ? " · u updates · d removes" : ""}`));
			return screen.beside([screen.frame(l, `what ${name} can do`, lw, h, left), screen.frame(l, "details", w - 2 - lw, h, right)], 2);
		},
		keys: () =>
			win
				? [["type", "a source or words"], ["enter", win.found && win.input === win.searched ? "install" : "add or search"], ["↑↓", "a result"], ["tab", "this agent / every agent"], ["esc", "cancel"]]
				: [["space", "on / off"], ["+", "add"], ["u", "update"], ["d", "remove"], ["/", "search"], ["esc", "back"]],
		window: () => {
			if (!win) return undefined;
			const w = 66;
			const lines = [screen.faint(l, " npm:<name>, git:<repo>, a folder: added as it is."), screen.faint(l, " Other words: a search in pi's package gallery."), "", ` ${screen.yours(l, "›")} ${win.input}${screen.yours(l, "▏")}`, ""];
			if (typeof win.found === "string") lines.push(screen.second(l, ` ${win.found}`));
			else for (const [k, f] of (win.found ?? []).slice(0, 6).entries()) lines.push(`${k === win.j ? screen.yours(l, " › ") : "   "}${fit(f.name, 24, true)} ${screen.faint(l, fit(f.description, w - 32))}`);
			while (lines.length < 12) lines.push("");
			lines.push(` ${screen.second(l, "for")} ${win.every ? `${screen.second(l, "○ this agent")}  ${screen.bright(l, "● every agent")}` : `${screen.bright(l, "● this agent")}  ${screen.second(l, "○ every agent")}`}`, screen.faint(l, " A package runs code with your rights: read its source first."));
			return screen.frame(l, "add", w, lines.length + 2, lines, true);
		},
		key: (k) => {
			if (win) {
				const found = Array.isArray(win.found) ? win.found : [];
				if (k === "esc") win = undefined;
				else if (k === "tab") win.every = !win.every;
				else if (k === "up" || k === "down") win.j = move(k, win.j, found.length);
				else if (k === "bs") win.input = win.input.slice(0, -1);
				else if (k === "space") win.input += " ";
				else if (k === "enter") {
					const source = isSource(win.input.trim()) ? win.input.trim() : found.length && win.input === win.searched ? `npm:${found[win.j].name}` : undefined;
					if (source) {
						const every = win.every;
						win = undefined;
						return { work: `adding ${source}`, pp: ["ext", "add", name, source, ...(every ? ["--all"] : [])], then: done };
					}
					const words = win.input.trim();
					if (!words) return "done";
					const w0 = win;
					w0.found = "searching pi's package gallery…";
					w0.searched = win.input;
					w0.j = 0;
					import("./extensions.ts")
						.then((e) => e.search(words))
						.then((r) => (w0.found = r.length ? r : "nothing found"))
						.catch((err) => (w0.found = `the search failed: ${(err as Error).message}`));
				} else if (k.length === 1) win.input += k;
				return "done";
			}
			if (q !== undefined) {
				if (k === "esc" || (k === "enter" && !q)) q = undefined;
				else if (k === "up" || k === "down") i = move(k, i, rows().length);
				else if (k === "bs") q = q.slice(0, -1);
				else if (k === "space") q += " ";
				else if (k.length === 1) q += k;
				return "done";
			}
			const x = rows()[i];
			if (k === "esc") return changed ? { work: `restarting ${name} with what changed`, pp: ["restart", name], then: () => ({ back: true }) } : undefined;
			if (k === "/") q = "";
			else if (k === "+") win = { input: "", every: false, j: 0 };
			else if (k === "up" || k === "down" || k === "j" || k === "k") i = move(k, i, rows().length);
			else if (!x) return "done";
			else if (k === "space" || k === "enter") {
				const turn = { work: `turning ${x.name} ${x.on ? "off" : "on"}`, pp: ["ext", x.on ? "off" : "on", name, x.name], then: done };
				if (!x.on) return turn;
				return { ask: [`Turn ${x.name} off for ${where(x)}?`, screen.second(l, "It stays installed: space turns it on again.")], yes: () => turn };
			} else if (k === "u" && x.kind === "package") return { work: `updating ${x.name}`, pp: ["ext", "update", name, x.name], then: done };
			else if (k === "d" && x.kind === "package") return { ask: [`Remove ${x.name} from ${where(x)}?`, screen.second(l, "Its files go; add it again any time.")], yes: () => ({ work: `removing ${x.name}`, pp: ["ext", "rm", name, x.name], then: done }) };
			return "done";
		},
	};
}

const logOf = (name: string) => {
	try {
		return agents.loadRecord(name).paths.log;
	} catch {
		return ""; // a broken agent: no log to show
	}
};
/** The last `n` lines of a file (of its last 64 KB), read again only when it changed: screens draw it many times a second. */
const tails = new Map<string, { key: string; lines: string[] }>();
function tail(file: string, n: number): string[] {
	try {
		const st = fs.statSync(file);
		const key = `${st.size}:${st.mtimeMs}`;
		if (tails.get(file)?.key !== key) {
			const fd = fs.openSync(file, "r");
			const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
			fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
			fs.closeSync(fd);
			tails.set(file, { key, lines: buf.toString("utf8").trimEnd().split("\n") });
		}
		return tails.get(file)?.lines.slice(-n) ?? [];
	} catch {
		return [];
	}
}
/** A line of an agent's log: its local time, then what it says; trouble in its colour. */
function logLine(l: screen.Look, s: string, w: number): string {
	const m = /^(\S+) \[[^\]]+\] (.*)$/.exec(s);
	const at = m ? new Date(m[1]).toTimeString().slice(0, 5) : "";
	const text = fit(m ? m[2] : s, w - 7);
	return `${screen.faint(l, at.padEnd(5))}  ${/fail|error|refus|cannot|safe mode/i.test(text) ? screen.broken(l, text) : text}`;
}
function logPane(c: Ctx, name: string): Pane {
	const file = logOf(name);
	let up = 0; // lines above the newest: 0 follows what comes
	let q: string | undefined; // being typed: keeps the lines that have it
	return {
		title: "Its log",
		draw: (w, h) => {
			const all = tail(file, 2000).filter((s) => !q || s.toLowerCase().includes(q.toLowerCase()));
			const room = h - 3;
			up = Math.max(0, Math.min(up, all.length - room));
			const end = all.length - up;
			const head = q !== undefined ? ` ${screen.yours(c.l, "⌕")} ${q}${screen.yours(c.l, "▏")}` : screen.faint(c.l, up ? ` ${up} lines above the newest` : " following: new lines appear as they are written");
			return screen.frame(c.l, `${name}'s log`, w, h, [head, ...all.slice(Math.max(0, end - room), end).map((s) => ` ${logLine(c.l, s, w - 3)}`)]);
		},
		keys: () => [["↑↓", "scroll"], ["/", "filter"], ["esc", "back"]],
		key: (k) => {
			if (q !== undefined && k.length === 1) q += k;
			else if (q !== undefined && k === "space") q += " ";
			else if (q !== undefined && k === "bs") q = q.slice(0, -1);
			else if (q !== undefined && (k === "esc" || k === "enter")) q = k === "esc" ? undefined : q;
			else if (k === "/") q = "";
			else if (k === "up" || k === "k") up++;
			else if (k === "down" || k === "j") up = Math.max(0, up - 1);
			else return undefined;
			return "done";
		},
	};
}

/** The settings: each runs its step of the guide on the normal screen, as `pp setup` would, then comes back here. */
function settingRows(c: Ctx, name: string): [string, string, () => Promise<number | void>][] {
	const row = rowOf(c, name);
	const change = (what: "reach" | "model" | "stay") => aside(c.l, async () => (await import("./welcome.ts")).change(what, name));
	const service = serviceInstalled() ? (bootAllowed() ? "after a stop, and after a restart" : "after a stop") : "no: started by you";
	return [
		["Channels", row?.s?.channels.length ? row.s.channels.map((x) => `${x.name} ${x.running ? "on" : "off"}`).join(", ") : "none yet: Telegram", change("reach")],
		["Model and sign-in", row?.s?.model ?? "pi's default", change("model")],
		["Coming back by itself", service, change("stay")],
		["A new agent", agents.list().join(", "), aside(c.l, () => newAgent(c, row?.s?.model))],
		["The whole guide", `${COMMAND} setup, step by step`, aside(c.l, () => c.own(["setup"]))],
	];
}
async function newAgent(c: Ctx, model: string | undefined): Promise<void> {
	const name = (await ask.text("Its name (small letters, digits, -)")).trim();
	if (!name) return;
	if (c.own(["init", name, path.join(defaultFolderParent(), name), ...(model ? ["--model", model] : [])]) === 0) c.own(["start", name]);
}
function settingsPane(c: Ctx, name: string): Pane {
	let i = 0;
	return {
		title: "Settings",
		draw: (w, h) => {
			const rows = settingRows(c, name);
			const lines = [""];
			rows.forEach(([k, v], j) => lines.push(`${j === i ? screen.yours(c.l, " › ") : "   "}${fit(j === i ? screen.bright(c.l, k, true) : k, 24, true)}${screen.second(c.l, v)}`, ""));
			lines.push(screen.faint(c.l, " Each opens its step of the guide, then comes back here."));
			return screen.frame(c.l, `settings for ${name}`, Math.min(w, 96), h, lines);
		},
		keys: () => [["↑↓", "choose"], ["enter", "open"], ["esc", "back"]],
		key: (k) => {
			if (k === "enter") return { out: settingRows(c, name)[i][2] };
			if (k !== "up" && k !== "down" && k !== "j" && k !== "k") return undefined;
			i = move(k, i, 5);
			return "done";
		},
	};
}

function doctorPane(c: Ctx, name: string): Pane {
	let checks: Check[] | string = "checking…";
	let i = 0;
	const run = () => {
		checks = "checking…";
		c.quiet(["doctor", "--json"]).then((r) => {
			try {
				checks = JSON.parse(r.out);
			} catch {
				checks = r.said || "pp doctor said nothing";
			}
		});
	};
	run();
	/** Where a problem is fixed: the screen that changes what it is about. */
	const fix = (ch: Check): Act | undefined => {
		const m = /^agent (\S+): (extension|safe mode|model|channel)/.exec(ch.what);
		if (m) return { open: m[2] === "model" ? modelPane(c, m[1]) : m[2] === "channel" ? settingsPane(c, m[1]) : extPane(c, m[1]) };
		if (ch.topic === "Coming back by itself") return { open: settingsPane(c, name) };
	};
	return {
		title: "Check everything",
		draw: (w, h) => {
			if (typeof checks === "string") return screen.frame(c.l, "pp doctor", w, h, ["", ` ${screen.second(c.l, checks)}`]);
			const lines: string[] = [];
			let topic = "";
			checks.forEach((ch, j) => {
				if (ch.topic !== topic) lines.push(screen.faint(c.l, ` ${(topic = ch.topic).toUpperCase()}`));
				const sign = ch.ok === true ? screen.alive(c.l, "✓") : ch.ok === "warn" ? screen.yours(c.l, "•") : screen.broken(c.l, "✗");
				const text = `${ch.what.replace(/^agent \S+: /, "")}${ch.detail ? screen.second(c.l, `: ${ch.detail}`) : ""}`;
				lines.push(`${j === i ? screen.yours(c.l, " › ") : "   "}${sign} ${ch.ok === false ? screen.broken(c.l, text) : text}${j === i && ch.ok !== true && fix(ch) ? screen.faint(c.l, "  ⏎ fix it") : ""}`);
			});
			const at = lines.findIndex((s) => s.includes("›"));
			const room = h - 2;
			const from = Math.max(0, Math.min(at - Math.floor(room / 2), lines.length - room));
			const bad = checks.filter((x) => x.ok === false).length;
			return screen.frame(c.l, bad ? `pp doctor: ${bad} to fix` : "pp doctor: nothing to fix", w, h, lines.slice(from, from + room));
		},
		keys: () => [["↑↓", "move"], ["enter", "fix it"], ["c", "check again"], ["esc", "back"]],
		key: (k) => {
			if (typeof checks === "string") return k === "esc" ? undefined : "done";
			if (k === "enter") return fix(checks[i]) ?? "done";
			if (k === "c") run();
			else if (k === "up" || k === "down" || k === "j" || k === "k") i = move(k, i, checks.length);
			else return undefined;
			return "done";
		},
	};
}

function updatePane(c: Ctx): Pane {
	let news: { version: string; notes: string[] } | string = "looking for a newer version…";
	fetch(`https://api.github.com/repos/${repository()}/releases/latest`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/vnd.github+json" } })
		.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub answered ${r.status}`))))
		.then((b: { tag_name?: string; body?: string }) => {
			news = { version: String(b.tag_name ?? "").replace(/^v/, ""), notes: String(b.body ?? "").split("\n").filter((s) => /^\s*[-*] /.test(s)).map((s) => s.replace(/^\s*[-*]\s+/, "").replace(/\*\*|`/g, "")).slice(0, 10) };
		})
		.catch((err) => (news = `could not look (${(err as Error).message}); Enter updates all the same`));
	const newer = () => typeof news !== "string" && news.version !== c.version;
	return {
		title: "Update",
		draw: (w, h) => {
			const l = c.l;
			const lines = ["", ` You have ${screen.bright(l, c.version, true)}.`];
			if (typeof news === "string") lines.push(` ${screen.second(l, news)}`);
			else if (!newer()) lines.push(` ${screen.alive(l, "This is the newest.")}`);
			else lines.push(` ${screen.yours(l, `${news.version} is out.`, true)}`, "", screen.faint(l, " WHAT CHANGES"), ...news.notes.map((s) => ` ${screen.yours(l, "·")} ${fit(s, w - 6)}`));
			lines.push("", screen.faint(l, " The update keeps every agent, its conversation, its settings and its channels;"), screen.faint(l, " they restart once, at the end."));
			return screen.frame(l, "update", Math.min(w, 100), h, lines);
		},
		keys: () => [["enter", newer() || typeof news === "string" ? "update now" : "update again"], ["esc", "back"]],
		key: (k) =>
			k === "enter"
				? {
						out: async () => {
							// Once updated, the new pp takes over this terminal.
							screen.fullScreen(false);
							if (c.own(["update"]) === 0) return c.own([]);
							await back(c.l);
							screen.fullScreen(true);
						},
					}
				: undefined,
	};
}
function wrap(text: string, w: number): string[] {
	const out: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (out.length && screen.width(`${out.at(-1)} ${word}`) <= w) out[out.length - 1] += ` ${word}`;
		else out.push(word);
	}
	return out;
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

const KEYS: Record<string, string> = { "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\r": "enter", "\x1b": "esc", "\t": "tab", "\x7f": "bs", "\b": "bs", " ": "space" };

async function loop(version: string): Promise<number> {
	const cli = path.join(ROOT, "core", "cli.ts");
	const env = { ...process.env, [`${ENV}_COMMAND`]: COMMAND };
	let snap = await snapshot();
	let chosen = snap.rows[0]?.name ?? ""; // the chosen agent, by name: it stays chosen when the list changes
	const at = () => Math.max(0, snap.rows.findIndex((r) => r.name === chosen));
	const lists = new Map<string, Extension[]>();
	const reload = (name: string) => {
		import("./extensions.ts")
			.then((e) => e.list(agents.loadRecord(name)))
			.then((x) => lists.set(name, x))
			.catch(() => lists.set(name, []));
	};
	const c: Ctx = {
		l: screen.look(),
		version,
		snap: () => snap,
		exts: (name) => {
			if (!lists.has(name)) reload(name);
			return lists.get(name);
		},
		reload,
		own: (args) => spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env }).status ?? 1,
		quiet: (args) =>
			new Promise((done) => {
				const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
				let out = "";
				let err = "";
				child.stdout.on("data", (b) => (out += b));
				child.stderr.on("data", (b) => (err += b));
				child.on("close", (code) => done({ ok: code === 0, out, said: `${out}\n${err}`.split("\n").map((s) => s.replace(new RegExp(`^${COMMAND}: `), "").trim()).find(Boolean) ?? "" }));
			}),
	};
	const stack: Pane[] = []; // the screens open over the home screen
	let item = 0; // the menu line Enter does
	let note = ""; // what the last action said
	let asking: { lines: string[]; yes: () => Act | undefined } | undefined;
	let busy: { text: string; since: number } | undefined;
	const began = Date.now(); // the screen's own clock: its light passes when it opens
	for (;;) {
		const l = (c.l = screen.look());
		// What is shown is read again every few seconds: an agent that starts working, or stops, is seen without a key.
		let reading = false;
		const refresh = setInterval(async () => {
			if (reading) return;
			reading = true;
			try {
				snap = await snapshot();
				if (!snap.rows.some((r) => r.name === chosen)) chosen = snap.rows[0]?.name ?? "";
				if (chosen) reload(chosen);
			} finally {
				reading = false;
			}
		}, 3000);
		/** Do what a key asked; a result ends this screen's turn (the normal screen is needed, or pp ends). */
		const apply = (a: Act | undefined): Act | undefined => {
			if (!a || a === "done") return;
			if ("open" in a) stack.push(a.open);
			else if ("back" in a) stack.pop();
			else if ("ask" in a) asking = { lines: a.ask, yes: a.yes };
			else if ("work" in a) {
				busy = { text: a.work, since: Date.now() };
				c.quiet(a.pp).then(async (r) => {
					busy = undefined;
					note = r.ok ? screen.alive(l, `✓ ${r.said}`) : screen.broken(l, `✘ ${r.said}`);
					snap = await snapshot();
					reload(chosen);
					const next = a.then?.(r.ok);
					if (next && next !== "done" && ("open" in next || "back" in next || "ask" in next || "work" in next)) apply(next);
				});
			} else return a;
		};
		const { result } = await screen.live<Act>(
			(t) => {
				const columns = process.stdout.columns || 80;
				const rows = process.stdout.rows || 24;
				const top = stack.at(-1);
				let lines: string[];
				if (!top) lines = picture(l, version, snap, at(), Date.now() - began, columns, rows, item, c, note);
				else {
					const row = rowOf(c, chosen);
					const v = row ? look(l, row, snap.up, Date.now() - began) : undefined;
					const crumbs = `${screen.star(l, Date.now() - began)} ${screen.bright(l, "pp", true)}${stack.map((p) => `${screen.line(l, " › ")}${screen.yours(l, p.title, true)}`).join("")}`;
					lines = ["", fit(` ${crumbs}${v && row ? `   ${screen.second(l, row.name)} ${v.sign} ${v.word}` : ""}`, columns - 1), "", ...top.draw(columns - 2, rows - 7, t).map((s) => ` ${s}`)];
					while (lines.length < rows - 4) lines.push("");
					lines.push("", note ? `  ${fit(note, columns - 3)}` : "", keyLine(l, top.keys(), columns));
				}
				const win = top?.window?.();
				if (win) lines = screen.over(l, lines, win, columns);
				if (asking) lines = screen.over(l, lines, screen.frame(l, "", Math.min(64, columns - 4), asking.lines.length + 5, ["", ...asking.lines.map((s) => ` ${s}`), "", ` ${screen.yours(l, "y", true)} ${screen.second(l, "yes")}   ${screen.yours(l, "esc", true)} ${screen.second(l, "no")}`], true), columns);
				if (busy) lines = screen.over(l, lines, screen.frame(l, "", Math.min(64, columns - 4), 3, [` ${screen.lighting(l, Date.now() - busy.since)} ${busy.text}…`], true), columns);
				return lines;
			},
			(raw) => {
				const k = KEYS[raw] ?? raw;
				if (busy) return undefined; // keys wait for the work under way
				if (asking) {
					const yes = asking.yes;
					asking = undefined;
					return k === "y" ? apply(yes()) : undefined;
				}
				note = "";
				const top = stack.at(-1);
				if (top) {
					const a = top.key(k);
					return a === undefined && k === "esc" ? apply({ back: true }) : apply(a);
				}
				const list = menu(c, at());
				if (k === "esc" || (k === "q" && list.some((it) => it.key === "q"))) return { quit: true };
				const hit = k === "enter" ? list[Math.min(item, list.length - 1)] : list.find((it) => it.key === k);
				if (hit) {
					item = list.indexOf(hit);
					return apply(hit.act());
				}
				if (k === "up" || k === "k") item = (Math.min(item, list.length - 1) + list.length - 1) % list.length;
				if (k === "down" || k === "j") item = (Math.min(item, list.length - 1) + 1) % list.length;
				const n = snap.rows.length;
				if (n > 1 && (k === "left" || k === "h")) chosen = snap.rows[(at() + n - 1) % n].name;
				if (n > 1 && (k === "right" || k === "tab")) chosen = snap.rows[(at() + 1) % n].name;
				return undefined;
			},
			{ quit: true },
			{ top: true, every: l.motion ? 120 : 1000 },
		);
		clearInterval(refresh);
		if (result === "done" || !result) continue;
		if ("quit" in result) return 0;
		if ("out" in result) {
			const code = await result.out();
			if (typeof code === "number") return code;
			snap = await snapshot();
			reload(chosen);
		}
	}
}

/** Enter on the agent: started first if it must be (Herdr Core too), then its own screen, where pi works; ctrl+\ comes
 * back here, and the agent keeps running. */
async function openAgent(c: Ctx, name: string, again: boolean): Promise<void> {
	const { l } = c;
	const snap = c.snap();
	const row = rowOf(c, name);
	const v = row ? look(l, row, snap.up, 0) : undefined;
	if (v?.action !== "open") {
		const up = await bringUp(l, name, snap.up, again);
		if (up.cancelled) return;
		if (!up.ok) {
			const trouble = up.trouble;
			// Started, but not as it should (safe mode, slow to report): it still runs, and can be opened.
			if (control.find(agents.loadRecord(name))) await aside(l, () => say(`  ${screen.yours(l, "!")} ${name} runs, but ${trouble}`))();
			else return aside(l, () => say(`  ${screen.broken(l, "✘")} ${name} did not start: ${trouble}`))();
		}
	}
	const t = control.find(agents.loadRecord(name));
	if (!t) return aside(l, () => say(`  ${screen.broken(l, "✘")} ${name} is not running any more: ${COMMAND} status ${name}`))();
	// Its own screen, where pi works. ctrl+\ comes back here; the agent keeps running.
	screen.fullScreen(false);
	const r = spawnSync(herdr.command(), ["attach", t.address], { stdio: "inherit" });
	if (r.error || r.status) await back(l, "back", `could not open ${name}'s screen: ${r.error?.message ?? `Herdr Core said no (exit ${r.status})`}. Try: ${COMMAND} attach ${name}`);
	screen.fullScreen(true);
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
