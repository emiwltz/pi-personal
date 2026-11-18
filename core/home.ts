// `pp` alone. In a terminal: the home screen, each agent and how it is, and Enter opens it (its own screen, where
// pi works; ctrl+\ comes back here, and the agent keeps running). Outside a terminal (a script, a pipe): the same in
// plain text, with the next thing to do. Looking never starts Herdr Core; Enter on an agent that is not running does.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as agents from "./agents.ts";
import * as ask from "./ask.ts";
import { hint, say, style } from "./ask.ts";
import * as control from "./control.ts";
import * as herdr from "./herdr.ts";
import { COMMAND, ENV, PRODUCT } from "./name.ts";
import { ROOT, tilde } from "./paths.ts";
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
	if (s.safeMode) return { sign: screen.yours(l, "✦"), word: screen.yours(l, "running without its extensions"), detail: s.safeMode.reason, action: "open", label: `open ${row.name}` };
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
	const few = keys.filter(([k]) => k === "enter" || k === "q" || k === "↑↓");
	for (const candidate of [line(keys, "    "), line(keys, "  "), line(few, "  ")]) if (screen.width(candidate) < columns) return candidate;
	return line(few.filter(([k]) => k === "enter"), "");
}

// ---- the picture ----------------------------------------------------------------------------------------------------------
export function picture(l: screen.Look, version: string, snap: Snapshot, at: number, t: number, columns: number, rows = Number.POSITIVE_INFINITY): string[] {
	const keys: [string, string][] = [];
	if (!snap.rows.length) {
		const text = [`${screen.bright(l, PRODUCT, true)}  ${screen.second(l, version)}`, screen.second(l, "Nothing is set up yet."), "", ""];
		keys.push(["enter", "set it up"], ["q", "quit"]);
		const top = l.depth !== "none" && columns >= 52 ? screen.mark(l).map((row, i) => `  ${row}   ${text[i]}`.trimEnd()) : text.slice(0, 3).map((s) => `  ${s}`);
		return ["", ...top, "", keyLine(l, keys, columns), ""];
	}
	const looks = snap.rows.map((r) => look(l, r, snap.up, t));
	const chosen = looks[at];
	if (snap.rows.length > 1) keys.push(["↑↓", "choose"]);
	keys.push(["enter", chosen.label], ["s", "full status"], ["q", "quit"]);
	// One agent, with room: the mark, and the agent beside it.
	if (snap.rows.length === 1 && l.depth !== "none" && columns >= 52) {
		const r = snap.rows[0];
		const room = columns - 24;
		const head = `${screen.bright(l, r.name, true)}  ${chosen.sign} ${chosen.word}`;
		const text = [
			screen.width(head) <= room ? head : fit(head, room),
			screen.second(l, fit(details(l, r), room)),
			chosen.detail ? screen.faint(l, fit(chosen.detail, room)) : "",
			screen.faint(l, `${PRODUCT} ${version}`),
		];
		return ["", ...screen.mark(l).map((row, i) => `  ${row}   ${text[i]}`.trimEnd()), "", keyLine(l, keys, columns), ""];
	}
	// Several agents: the name of the product, then a card each, the chosen one drawn in the first colour (when every
	// name and state fit on the top of a card).
	const w = Math.min(68, columns - 4); // inside the card
	const tall = 3 + snap.rows.reduce((n, _r, i) => n + (looks[i].detail ? 4 : 3), 0) + 3; // the cards, with what surrounds them
	if (l.depth !== "none" && columns >= 40 && tall < rows && snap.rows.every((r, i) => 7 + screen.width(r.name) + screen.width(`${looks[i].sign} ${looks[i].word}`) <= w)) {
		const out = ["", `  ${screen.bright(l, PRODUCT, true)}  ${screen.second(l, version)}`, ""];
		snap.rows.forEach((r, i) => {
			const lk = looks[i];
			const edge = (s: string) => (i === at ? screen.yours(l, s) : screen.line(l, s));
			const state = `${lk.sign} ${lk.word}`;
			const name = i === at ? screen.yours(l, r.name, true) : screen.bright(l, r.name, true);
			const rule = Math.max(1, w - 6 - screen.width(r.name) - screen.width(state));
			const inside = (s: string) => `  ${edge("│")}  ${s}${" ".repeat(Math.max(0, w - 2 - screen.width(s)))}${edge("│")}`;
			out.push(`  ${edge("╭─")} ${name} ${edge("─".repeat(rule))} ${state} ${edge("─╮")}`);
			out.push(inside(screen.second(l, fit(details(l, r), w - 3))));
			if (lk.detail) out.push(inside(screen.faint(l, fit(lk.detail, w - 3))));
			out.push(`  ${edge(`╰${"─".repeat(w)}╯`)}`);
		});
		return [...out, "", keyLine(l, keys, columns), ""];
	}
	// No colour, a narrow or a low terminal: a line each, the chosen one marked; its detail when there is room; when
	// there are more agents than rows, the ones around the chosen one. The keys are always on the screen.
	const room = Number.isFinite(rows) ? Math.max(1, rows - 1 - 6) : snap.rows.length * 2;
	const withDetail = snap.rows.reduce((n, _r, i) => n + (looks[i].detail ? 1 : 0), 0) + snap.rows.length <= room;
	const from = snap.rows.length <= room ? 0 : Math.min(Math.max(0, at - Math.floor(room / 2)), snap.rows.length - room);
	const out = ["", `  ${PRODUCT} ${version}`, ""];
	snap.rows.forEach((r, i) => {
		if (i < from || i >= from + room) return;
		const lk = looks[i];
		const line = `${i === at && snap.rows.length > 1 ? "› " : "  "}${screen.bright(l, r.name, true)}  ${lk.sign} ${lk.word}`;
		out.push(screen.width(line) <= columns - 1 ? line : fit(line, columns - 1));
		if (lk.detail && withDetail) out.push(screen.faint(l, fit(`    ${lk.detail}`, columns - 1)));
	});
	return [...out, "", keyLine(l, keys, columns), ""];
}

// ---- the screen that lives ---------------------------------------------------------------------------------------------------
type Choice = { do: "quit" } | { do: "setup" } | { do: "status" } | { do: "agent"; name: string };

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
	/** Something to read on the normal screen (a status, an error), then back here with a key. */
	const aside = async (l: screen.Look, show: () => void, label = "back") => {
		screen.fullScreen(false);
		show();
		await back(l, label);
		screen.fullScreen(true);
	};
	let chosen = ""; // the chosen agent, by name: it stays chosen when the list changes
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
		const { result } = await screen.live<Choice>(
			(t) => picture(l, version, snap, at(), t, process.stdout.columns || 80, process.stdout.rows || 24),
			(k) => {
				if (k === "q" || k === "\x1b") return { do: "quit" };
				if (!snap.rows.length) return k === "\r" ? { do: "setup" } : undefined;
				if (k === "s") return { do: "status" };
				if (k === "\r") return { do: "agent", name: snap.rows[at()].name };
				const n = snap.rows.length;
				if (k === "\x1b[A" || k === "k") chosen = snap.rows[(at() + n - 1) % n].name;
				if (k === "\x1b[B" || k === "j") chosen = snap.rows[(at() + 1) % n].name;
				return undefined;
			},
			{ do: "quit" },
			{ top: true, every: l.motion ? 120 : 3000 },
		);
		clearInterval(refresh);
		if (result.do === "quit") return 0;
		if (result.do === "setup") {
			screen.fullScreen(false);
			const { setup } = await import("./welcome.ts");
			return setup(version);
		}
		if (result.do === "status") {
			await aside(l, () => own(["status"]));
			continue;
		}
		const row = snap.rows.find((r) => r.name === result.name) as Row;
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
			hint(`running without its extensions: ${s.safeMode.reason}`);
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
