// Questions in the terminal, for `pp setup`: a choice in a list, yes or no, a line of text, a secret. No dependency:
// raw keys on a TTY, plain lines otherwise (a pipe, a test), and colours only where they help (NO_COLOR turns them off).
import * as readline from "node:readline";
import * as screen from "./screen.ts";
import { split } from "./screen.ts";

const tty = () => !!process.stdin.isTTY && !!process.stdout.isTTY;
/** The levels of text of the palette (screen.ts): bright, secondary, and the meanings: "this concerns you", "alive, done",
 * "broken". Without a terminal, plain text. */
const level = (draw: (l: screen.Look, s: string) => string) => (s: string) => (tty() ? draw(screen.look(), s) : s);
export const style = {
	bright: level((l, s) => screen.bright(l, s, true)),
	second: level(screen.second),
	alive: level(screen.alive),
	yours: level((l, s) => screen.yours(l, s)),
	broken: level(screen.broken),
};

/** What every line starts with while a step of the guide runs: its line in the margin (see `margin`). */
let left = "";
/** Draw `prefix` (the guide's line in the margin) at the start of every line written here, until `margin("")`. */
export function margin(prefix: string): void {
	left = prefix;
}
export const marginNow = () => left;
export const say = (s = "") => process.stdout.write(`${left}${s}\n`);
/** The end of a line a question has started (its answer): no margin again. */
const tail = (s: string) => process.stdout.write(`${s}\n`);
export const ok = (s: string) => say(`  ${style.alive("✔")} ${s}`);
export const warn = (s: string) => say(`  ${style.yours("!")} ${s}`);
export const fail = (s: string) => say(`  ${style.broken("✘")} ${s}`);
export const hint = (s: string) => say(`    ${style.second(s)}`);

/** Lines read from a non-TTY standard input, one per question (tests and scripted setups answer this way). */
let piped: string[] | undefined;
async function pipedLine(): Promise<string> {
	if (!piped) {
		const chunks: Buffer[] = [];
		for await (const c of process.stdin) chunks.push(c as Buffer);
		piped = Buffer.concat(chunks).toString("utf8").split("\n");
	}
	const line = piped.shift();
	if (line === undefined) throw new Error("no more answers on standard input");
	return line.replace(/\r$/, "");
}

/** Raw keys until `onKey` returns true. A chunk may hold several keys (pasted text, fast typing): one at a time, an
 * arrow's escape sequence counting as one key; what follows the deciding key is dropped. A terminal in bracketed-paste
 * mode marks pasted text: the marks are not keys, and a line end inside a paste is not Enter. */
function keys(onKey: (key: string) => boolean | undefined): Promise<void> {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		let pasting = false;
		let held = ""; // an escape sequence cut off at the end of a read: it comes whole with the next one
		const onData = (buf: Buffer) => {
			const read = split(held + buf.toString("utf8"));
			held = read.held;
			for (const k of read.keys) {
				if (k === "\x1b[200~" || k === "\x1b[201~") {
					pasting = k === "\x1b[200~";
					continue;
				}
				if (pasting && (k === "\r" || k === "\n")) continue;
				if (k === "\u0003") {
					stdin.setRawMode(false);
					process.stdout.write("\n");
					process.exit(130); // Ctrl+C: leave at once, as everywhere in a terminal
				}
				if (onKey(k)) {
					stdin.off("data", onData);
					stdin.setRawMode(false);
					stdin.pause();
					return resolve();
				}
			}
		};
		stdin.on("data", onData);
	});
}

const question = (q: string, extra = "") => `${left}  ${style.yours("?")} ${style.bright(q)}${extra ? ` ${style.second(extra)}` : ""}`;

export interface Option<T> {
	label: string;
	value: T;
	note?: string;
}

/** One choice in a list: arrows and Enter (and the option's number in a short list). A long list shows 8 rows at a
 * time and narrows as you type, like pi's own pickers. Without a TTY: a number, a label or a value on a line. */
export async function choose<T>(q: string, options: Option<T>[], initial = 0): Promise<T> {
	if (!options.length) throw new Error(`nothing to choose for: ${q}`);
	if (!tty()) {
		tail(question(q));
		options.forEach((o, i) => say(`    ${i + 1}. ${o.label}${o.note ? `  ${o.note}` : ""}`));
		const a = (await pipedLine()).trim();
		const n = Number(a);
		const hit = a === "" ? options[initial] : Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : options.find((o) => o.label === a || String(o.value) === a);
		if (!hit) throw new Error(`"${a}" is not one of the choices for: ${q}`);
		say(`    ${hit.label}`);
		return hit.value;
	}
	const long = options.length > 9;
	const ROWS = 8;
	let query = "";
	let shown = options;
	let i = initial;
	let top = 0;
	let drawn = 0;
	const draw = () => {
		if (drawn) {
			readline.moveCursor(process.stdout, 0, -drawn);
			readline.clearScreenDown(process.stdout);
		}
		const lines: string[] = [];
		if (long) lines.push(`${left}    ${style.second("type to search:")} ${query}${style.second("▏")}`);
		if (i < top) top = i;
		if (i >= top + ROWS) top = i - ROWS + 1;
		const rows = long ? shown.slice(top, top + ROWS) : shown;
		const width = Math.max(20, (process.stdout.columns || 80) - 1 - screen.width(left)); // the margin takes room too
		rows.forEach((o, k) => {
			const at = (long ? top : 0) + k === i;
			// One screen line per row (a wrapped row would break the redraw): the label first, the note if it fits.
			const label = o.label.length > width - 6 ? `${o.label.slice(0, width - 7)}…` : o.label;
			const room = width - 6 - label.length - 2;
			const note = o.note && room > 3 ? (o.note.length > room ? `${o.note.slice(0, room - 1)}…` : o.note) : "";
			lines.push(`${left}    ${at ? style.yours("›") : " "} ${at ? style.bright(label) : label}${note ? `  ${style.second(note)}` : ""}`);
		});
		if (!shown.length) lines.push(`${left}    ${style.second("nothing matches")}`);
		if (long && shown.length > ROWS) lines.push(`${left}    ${style.second(`(${i + 1}/${shown.length})`)}`);
		process.stdout.write(`${lines.join("\n")}\n`);
		drawn = lines.length;
	};
	tail(question(q, long ? "(type to search, ↑ ↓, Enter)" : "(↑ ↓, Enter)"));
	draw();
	await keys((k) => {
		if ((k === "\r" || k === "\n") && shown.length) return true;
		if (k === "\x1b[A") i = (i - 1 + shown.length) % Math.max(shown.length, 1);
		else if (k === "\x1b[B") i = (i + 1) % Math.max(shown.length, 1);
		else if (!long && /^[1-9]$/.test(k) && Number(k) <= options.length) i = Number(k) - 1;
		else if (long && (k === "\u007f" || k === "\b")) query = query.slice(0, -1);
		else if (long && k.length === 1 && k >= " ") query += k;
		else return;
		if (long) {
			const words = query.toLowerCase().split(/\s+/).filter(Boolean);
			const before = shown[i];
			shown = options.filter((o) => words.every((w) => `${o.label} ${o.note ?? ""}`.toLowerCase().includes(w)));
			const kept = before ? shown.indexOf(before) : -1;
			i = kept >= 0 ? kept : 0;
		}
		draw();
	});
	readline.moveCursor(process.stdout, 0, -drawn);
	readline.clearScreenDown(process.stdout);
	say(`    ${style.alive(shown[i].label)}`);
	return shown[i].value;
}

/** Yes or no: y or n, then Enter (Enter alone takes the default), so an Enter typed after y never answers the next
 * question. */
export async function confirm(q: string, yes = true): Promise<boolean> {
	const extra = yes ? "[Y/n]" : "[y/N]";
	if (!tty()) {
		tail(question(q, extra));
		const a = (await pipedLine()).trim().toLowerCase();
		return a === "" ? yes : /^(y|yes|o|oui)$/.test(a);
	}
	process.stdout.write(`${question(q, extra)} `);
	let answer: boolean | undefined;
	await keys((k) => {
		const c = k.toLowerCase();
		if (c === "\r" || c === "\n") return true;
		// The first letter decides ("no" is no, "oui" is yes); Backspace takes it back.
		if ((c === "y" || c === "o" || c === "n") && answer === undefined) {
			answer = c !== "n";
			process.stdout.write(c);
		} else if ((c === "\u007f" || c === "\b") && answer !== undefined) {
			process.stdout.write("\b \b");
			answer = undefined;
		}
	});
	const result = answer ?? yes;
	if (answer !== undefined) process.stdout.write("\b \b");
	tail(style.alive(result ? "yes" : "no"));
	return result;
}

/** A line of text, with a default taken on Enter. */
export async function text(q: string, initial = ""): Promise<string> {
	if (!tty()) {
		tail(question(q, initial ? `(${initial})` : ""));
		return (await pipedLine()).trim() || initial;
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	rl.on("SIGINT", () => {
		rl.close();
		process.stdout.write("\n");
		process.exit(130); // Ctrl+C: leave at once, as in the other questions
	});
	const a = await new Promise<string>((resolve) => rl.question(`${question(q, initial ? `(${initial})` : "")} `, resolve));
	rl.close();
	return a.trim() || initial;
}

/** A secret: read without echo on a TTY, never printed. */
export async function secret(q: string): Promise<string> {
	if (!tty()) {
		tail(question(q, "(not shown)"));
		return (await pipedLine()).trim();
	}
	process.stdout.write(`${question(q, "(not shown; paste it, then Enter)")} `);
	let value = "";
	await keys((k) => {
		if (k === "\r" || k === "\n") return true;
		if (k === "\u007f" || k === "\b") value = value.slice(0, -1);
		else if (k.length === 1 && k >= " ") value += k;
	});
	tail(value ? style.alive("received") : style.second("nothing"));
	return value.trim();
}

export const interactive = tty;
