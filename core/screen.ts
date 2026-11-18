// How Pi-Personal looks in a terminal, in one place: the colours, the four levels of text, the mark, the stars. The
// guide and the home screen decide what to say; this file decides how it is drawn. Every drawing is a function of its
// arguments (time, palette, colour depth) that returns lines of text, so a screen can be tested as text. No dependency.
//
// The language is the sky: the agent is a star that stays lit. The opening is a burst of stars that falls back into the
// mark, a square « Pp »; a star is lit when something starts; a star twinkles beside an agent that is alive.
import * as fs from "node:fs";
import * as path from "node:path";
import { ENV, PRODUCT } from "./name.ts";
import { home } from "./paths.ts";

export type Rgb = readonly [number, number, number];
/** `a` to `b` is the gradient of the mark. `a` also says "this concerns you" (a question, a warning, the current
 * step); `b` says "alive, done". `ink`, `mute` and `deep` are the levels of text: bright, secondary, and decoration. */
export interface Palette {
	a: Rgb;
	b: Rgb;
	ink: Rgb;
	mute: Rgb;
	deep: Rgb;
	bad: Rgb;
}
/** For a dark terminal: amber to teal. Measured on indigo and on black: ink 14:1 or more, mute 5.4:1 or more. */
export const NIGHT: Palette = { a: [255, 181, 72], b: [94, 216, 200], ink: [236, 234, 251], mute: [146, 142, 186], deep: [62, 58, 104], bad: [255, 122, 122] };
/** The same two colours for a light terminal, dark enough to be read as text on white (5:1 or more). */
export const DAY: Palette = { a: [168, 88, 0], b: [11, 125, 114], ink: [28, 26, 59], mute: [93, 90, 128], deep: [211, 208, 230], bad: [179, 38, 30] };

/** When the background is not known: colours that read on white and on black (4:1 or more on both), and the words
 * themselves in the terminal's own colour (see `bright` and `second`). */
export const TWILIGHT: Palette = { a: DAY.a, b: DAY.b, ink: [150, 148, 170], mute: [128, 126, 150], deep: [128, 126, 150], bad: DAY.bad };

export type Depth = "truecolor" | "256" | "none";
export interface Look {
	palette: Palette;
	ground: "light" | "dark" | "unknown"; // the terminal's background, as far as it is known
	depth: Depth; // "none": no colour at all (a pipe, NO_COLOR, a dumb terminal)
	motion: boolean; // false: nothing moves
}

/** How to draw here: no colour and no motion outside a terminal, under NO_COLOR, or in a dumb terminal; no motion
 * under CI or `PI_PERSONAL_MOTION=never`; the light palette when `PI_PERSONAL_THEME=light` asks for it, or else when
 * the terminal said its background is light (`sense`), or else when COLORFGBG says so. */
export function look(env: NodeJS.ProcessEnv = process.env, out: { isTTY?: boolean } = process.stdout, said: Background | undefined = sensed): Look {
	const depth: Depth = !out.isTTY || env.NO_COLOR || env.TERM === "dumb" ? "none" : /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
	const theme = env[`${ENV}_THEME`];
	const background = Number((env.COLORFGBG ?? "").split(";").pop()); // "foreground;background", in the 16 colours: 7 and 15 are light
	// "light" or "dark" when PI_PERSONAL_THEME, the terminal itself (sense) or COLORFGBG says; otherwise unknown.
	const ground = theme === "light" || theme === "dark" ? theme : said ?? (background === 7 || background === 15 ? "light" : background >= 0 && background <= 15 && env.COLORFGBG ? "dark" : "unknown");
	return { palette: ground === "light" ? DAY : ground === "dark" ? NIGHT : TWILIGHT, ground, depth, motion: depth !== "none" && !env.CI && env[`${ENV}_MOTION`] !== "never" };
}

// ---- the terminal's background ------------------------------------------------------------------------------------------------
export type Background = "light" | "dark";
let sensed: Background | undefined;
/** What a terminal answers to "what is your background colour?" (OSC 11): rgb:RRRR/GGGG/BBBB, 1 to 4 hex digits each.
 * Light when its luminance is over one half. */
export function background(answer: string): Background | undefined {
	const m = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(answer);
	if (!m) return undefined;
	const [r, g, b] = m.slice(1, 4).map((h) => Number.parseInt(h, 16) / (16 ** h.length - 1));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}
/**
 * Ask the terminal its background colour, once, before anything is drawn; `look` then follows it. The question is
 * followed by a second one every terminal answers (DA1, \e[c): its answer means "done", and both answers are read here,
 * so that neither can arrive later as keys typed into a question. A local terminal answers in a few milliseconds; over a
 * slow link, it is waited for up to `ms`. Only in a terminal, and not when PI_PERSONAL_THEME already says.
 */
export async function sense(ms = 1000, input: NodeJS.ReadStream = process.stdin, out: NodeJS.WriteStream = process.stdout, env: NodeJS.ProcessEnv = process.env): Promise<Background | undefined> {
	if (sensed || env[`${ENV}_THEME`] || !input.isTTY || !out.isTTY || input.isRaw || env.TERM === "dumb") return sensed;
	let got = "";
	await new Promise<void>((done) => {
		const onData = (d: Buffer) => {
			got += d.toString("latin1");
			if (/\x1b\[\?[\d;]*c/.test(got)) finish();
		};
		const timer = setTimeout(() => finish(), ms);
		let over = false;
		const finish = () => {
			if (over) return;
			over = true;
			clearTimeout(timer);
			input.off("data", onData);
			input.setRawMode(false);
			input.pause();
			done();
		};
		input.setRawMode(true);
		input.resume();
		input.on("data", onData);
		out.write("\x1b]11;?\x1b\\\x1b[c");
	});
	sensed = background(got);
	return sensed;
}

// ---- colour ---------------------------------------------------------------------------------------------------------------
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => ((x = clamp(x)), x * x * (3 - 2 * x));
const easeOut = (x: number) => 1 - (1 - clamp(x)) ** 3;
const span = (t: number, from: number, to: number) => clamp((t - from) / (to - from));
const mix = (c1: Rgb, c2: Rgb, k: number): Rgb => ((k = clamp(k)), [c1[0] + (c2[0] - c1[0]) * k, c1[1] + (c2[1] - c1[1]) * k, c1[2] + (c2[2] - c1[2]) * k]);
function code(c: Rgb, background: boolean, depth: Depth): string {
	const [r, g, b] = c.map(Math.round);
	const lead = background ? 48 : 38;
	return depth === "truecolor" ? `\x1b[${lead};2;${r};${g};${b}m` : `\x1b[${lead};5;${nearest256([r, g, b])}m`;
}
/** Without 24-bit colour: the nearest of the colours every 256-colour terminal has, the 6×6×6 cube (whose levels are
 * 0, 95, 135, 175, 215, 255, not evenly spaced) or the 24 greys (8 to 238). */
const LEVELS = [0, 95, 135, 175, 215, 255];
export function nearest256(c: Rgb): number {
	const level = (v: number) => LEVELS.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(LEVELS[best] - v) ? i : best), 0);
	const [i, j, k] = c.map(level);
	const cube: Rgb = [LEVELS[i], LEVELS[j], LEVELS[k]];
	const g = Math.min(23, Math.max(0, Math.round(((c[0] + c[1] + c[2]) / 3 - 8) / 10)));
	const grey: Rgb = [8 + 10 * g, 8 + 10 * g, 8 + 10 * g];
	const far = (d: Rgb) => (d[0] - c[0]) ** 2 + (d[1] - c[1]) ** 2 + (d[2] - c[2]) ** 2;
	return far(grey) < far(cube) ? 232 + g : 16 + 36 * i + 6 * j + k;
}
/** Text in a colour. Without colour (`depth: "none"`), the text as it is. */
export function paint(l: Look, s: string, fg: Rgb, o: { bg?: Rgb; bold?: boolean } = {}): string {
	if (l.depth === "none") return s;
	return `${o.bold ? "\x1b[1m" : ""}${code(fg, false, l.depth)}${o.bg ? code(o.bg, true, l.depth) : ""}${s}\x1b[0m`;
}
/** The four levels of text, and the two colours that mean something. `faint` can still be read (steps to come,
 * labels); `line` is for rules and frames, never for words. */
// When the background is not known, words keep the terminal's own colour: bold for the bright level, dim for the others.
const own = (l: Look, s: string, sgr: string) => (l.depth === "none" ? s : sgr ? `\x1b[${sgr}m${s}\x1b[0m` : s);
export const bright = (l: Look, s: string, bold = false) => (l.ground === "unknown" ? own(l, s, bold ? "1" : "") : paint(l, s, l.palette.ink, { bold }));
export const second = (l: Look, s: string) => (l.ground === "unknown" ? own(l, s, "2") : paint(l, s, l.palette.mute));
export const faint = (l: Look, s: string) => (l.ground === "unknown" ? own(l, s, "2") : paint(l, s, mix(l.palette.deep, l.palette.mute, 0.6)));
export const line = (l: Look, s: string) => paint(l, s, l.palette.deep);
export const yours = (l: Look, s: string, bold = false) => paint(l, s, l.palette.a, { bold });
export const alive = (l: Look, s: string) => paint(l, s, l.palette.b);
export const broken = (l: Look, s: string) => paint(l, s, l.palette.bad);
/** What a line takes on the screen, colour codes left out. */
export const width = (s: string) => [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;

// ---- the mark: « Pp » in square strokes, described as rectangles, so it is drawn at the size the stage has ----------------------
const BOX = 1.3; // the mark is 1.3 wide for 1 high
type Point = readonly [number, number];
/** [left, top, right, bottom] in that box: the capital P (stem, top bar, right side, middle bar), then the small p, whose
 * bowl sits on the same baseline (0.82) and whose stem goes below it. */
const RECTS: readonly (readonly [number, number, number, number])[] = [
	[0.05, 0.03, 0.2, 0.82],
	[0.05, 0.03, 0.58, 0.18],
	[0.43, 0.03, 0.58, 0.48],
	[0.05, 0.33, 0.58, 0.48],
	[0.72, 0.3, 0.87, 1],
	[0.72, 0.3, 1.24, 0.45],
	[1.09, 0.3, 1.24, 0.82],
	[0.72, 0.67, 1.24, 0.82],
];
const inMark = (u: number, v: number) => RECTS.some(([x0, y0, x1, y1]) => u >= x0 && u <= x1 && v >= y0 && v <= y1);
const masks = new Map<string, Uint8Array>();
/** Which points of a W by H grid are inside the mark. */
function mask(W: number, H: number): Uint8Array {
	const key = `${W}x${H}`;
	let m = masks.get(key);
	if (!m) {
		m = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = inMark(((x + 0.5) / W) * BOX, (y + 0.5) / H) ? 1 : 0;
		masks.set(key, m);
	}
	return m;
}

/** The stage of the opening: 26 character cells by 10. In half blocks it is 26 x 20 pixels; in braille dots, 52 x 40. */
const C = 26;
const R = 10;
/** The lines every opening takes, so that nothing below it jumps when it ends. */
export const OPENING_ROWS = R + 2;
/** The columns the opening needs: under that, the small mark instead. */
export const OPENING_COLS = 62;
export const OPENING_MS = 2200;

/** A picture in half blocks: two pixels per character cell. `colour(x, y)` gives a pixel its colour, or nothing. */
function pixels(l: Look, w: number, rows: number, colour: (x: number, y: number) => Rgb | undefined): string[] {
	const out: string[] = [];
	for (let r = 0; r < rows; r++) {
		let row = "";
		for (let x = 0; x < w; x++) {
			const top = colour(x, 2 * r);
			const bottom = colour(x, 2 * r + 1);
			row += top && bottom ? paint(l, "▀", top, { bg: bottom }) : top ? paint(l, "▀", top) : bottom ? paint(l, "▄", bottom) : " ";
		}
		out.push(row);
	}
	return out;
}

/** A canvas of braille dots, 2 by 4 per character cell. Each cell remembers its hottest dot, which whitens it. */
const DOT = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];
class Canvas {
	w: number;
	h: number;
	bits: Uint8Array;
	heat: Float32Array;
	constructor(w: number, h: number) {
		this.w = w;
		this.h = h;
		this.bits = new Uint8Array(w * h);
		this.heat = new Float32Array(w * h);
	}
	set(x: number, y: number, heat: number): void {
		x = Math.round(x);
		y = Math.round(y);
		if (x < 0 || y < 0 || x >= this.w * 2 || y >= this.h * 4) return;
		const i = (y >> 2) * this.w + (x >> 1);
		this.bits[i] |= DOT[y & 3][x & 1];
		if (heat > this.heat[i]) this.heat[i] = heat;
	}
	rows(l: Look, colour: (cx: number, cy: number, heat: number) => Rgb): string[] {
		const out: string[] = [];
		for (let cy = 0; cy < this.h; cy++) {
			let row = "";
			for (let cx = 0; cx < this.w; cx++) {
				const i = cy * this.w + cx;
				row += this.bits[i] ? paint(l, String.fromCodePoint(0x2800 + this.bits[i]), colour(cx, cy, this.heat[i])) : " ";
			}
			out.push(row);
		}
		return out;
	}
}
/** The same numbers each time it is called with the same seed: the stars fly the same way at every opening. */
function random(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}
let dots: Point[] | undefined;
/** Every braille dot of the mark on the stage: where the stars land. */
function targets(): Point[] {
	if (!dots) {
		dots = [];
		const m = mask(C * 2, R * 4);
		for (let y = 0; y < R * 4; y++) for (let x = 0; x < C * 2; x++) if (m[y * C * 2 + x]) dots.push([x, y]);
	}
	return dots;
}
const tone = (P: Palette, x: number, y: number) => mix(P.a, P.b, (x / (C - 1)) * 0.8 + (y / (R * 2 - 1)) * 0.2);

/** The name, beside the mark. `a` and `b` (0 to 1) bring it out of the dark. */
function words(l: Look, version: string, a: number, b: number): string[] {
	const out = (s: string, to: Rgb, k: number, bold = false) => (k <= 0.03 ? " ".repeat(s.length) : paint(l, s, mix(l.palette.deep, to, k), { bold }));
	return [`${out(PRODUCT, l.palette.ink, a, true)}  ${out(version, l.palette.mute, b)}`, out("your own agent, always there", l.palette.mute, b)];
}
const stage = (rows: string[], text: string[]) => ["", ...rows.map((row, i) => `  ${row}   ${text[i - 4] ?? ""}`.trimEnd()), ""];

/**
 * The opening, at `t` milliseconds: a burst of stars leaves the centre, falls back into the mark, and the mark catches
 * fire and stays, solid. From OPENING_MS on, it is the still picture. Always OPENING_ROWS lines.
 */
export function opening(l: Look, version: string, t: number): string[] {
	const P = l.palette;
	let rows: string[];
	if (t < 1500) {
		const c = new Canvas(C, R);
		const rnd = random(41);
		for (const [tx, ty] of targets()) {
			const angle = rnd() * 6.283;
			const far = 6 + rnd() * 20;
			const wait = rnd() * 0.25;
			const out = easeOut(span(t, 0, 420));
			const x = C + Math.cos(angle) * far * 1.3 * out;
			const y = R * 2 + Math.sin(angle) * far * 0.8 * out;
			const back = ease(clamp((t - 380 - wait * 380) / 720));
			c.set(x + (tx - x) * back, y + (ty - y) * back, 1 - back);
		}
		rows = c.rows(l, (cx, cy, heat) => mix(mix(P.a, P.b, (cx / (C - 1)) * 0.8 + (cy / (R - 1)) * 0.2), P.ink, heat * 0.8));
	} else {
		const flash = 1 - ease(span(t, 1500, 1950));
		const m = mask(C, R * 2);
		rows = pixels(l, C, R, (x, y) => (m[y * C + x] ? mix(tone(P, x, y), P.ink, flash * 0.9) : undefined));
	}
	return stage(rows, words(l, version, ease(span(t, 1500, 1850)), ease(span(t, 1650, 2050))));
}

// ---- the small mark, for everyday screens: 16 columns by 4 lines ---------------------------------------------------------------
const SMALL = [
	".######.........",
	".##..##.........",
	".##..##..######.",
	".######..##..##.",
	".##......##..##.",
	".##......######.",
	".........##.....",
	".........##.....",
];
/** The small mark. `light` (0 to 1) passes a light over it, left to right; outside 0 to 1, none. */
export function mark(l: Look, light = -1): string[] {
	const P = l.palette;
	return pixels(l, 16, 4, (x, y) => {
		if (SMALL[y][x] !== "#") return undefined;
		const glow = light < 0 || light > 1 ? 0 : Math.exp(-(((x - light * 24 + 4) / 2.4) ** 2));
		return mix(mix(P.a, P.b, (x / 15) * 0.8 + (y / 7) * 0.2), P.ink, glow * 0.7);
	});
}

/** What opens a screen once the opening has played: the small mark beside the name; in a narrow terminal, a star and
 * the name on one line; without colour, the name and the version, plain. */
export function header(l: Look, version: string, columns: number): string[] {
	if (l.depth === "none") return [`${PRODUCT} ${version}`];
	if (columns < 52) return [`${star(l)} ${bright(l, PRODUCT, true)} ${second(l, version)}`];
	const text = ["", `${bright(l, PRODUCT, true)}  ${second(l, version)}`, second(l, "your own agent, always there"), ""];
	return ["", ...mark(l).map((row, i) => `  ${row}   ${text[i]}`.trimEnd()), ""];
}

// ---- signs --------------------------------------------------------------------------------------------------------------------
/** A star that is alive: it twinkles between its colour and white. Without motion: a still star. */
export const star = (l: Look, t = 0) => paint(l, "✦", l.motion ? mix(l.palette.b, l.palette.ink, 0.5 + 0.5 * Math.sin(t / 330)) : l.palette.b);
const LIGHTING = ["·", "∙", "•", "✧", "✦", "✧"];
/** A star being lit, while something starts: a point, then larger, then a star. */
export const lighting = (l: Look, t: number) => paint(l, LIGHTING[Math.floor(t / 130) % LIGHTING.length], mix(l.palette.a, l.palette.ink, 0.5 + 0.5 * Math.sin(t / 130)));
/** A light that passes over words, again and again, while a model thinks. Without motion: the words, secondary. */
export function shimmer(l: Look, text: string, t: number): string {
	if (!l.motion || l.depth === "none" || l.ground === "unknown") return second(l, text);
	const chars = [...text];
	const at = ((t % 1600) / 1600) * (chars.length + 12) - 6;
	return chars.map((c, i) => paint(l, c, mix(l.palette.mute, l.palette.ink, Math.exp(-(((i - at) / 3) ** 2))))).join("");
}

// ---- keys -------------------------------------------------------------------------------------------------------------------
/** What a read from the keyboard holds: keys, one at a time (an arrow's escape sequence is one key), and the start of
 * an escape sequence cut off at its end, which comes whole with the next read. A terminal's answers to a question (its
 * background colour, its kind) are not keys: they are dropped whole, never typed. */
export function split(text: string): { keys: string[]; held: string } {
	const held = /\x1b(?:\[[?>=]?[0-9;]*|\](?:[^\x07\x1b]|\x1b(?!\\))*)?$/.exec(text)?.[0] ?? "";
	const all = text.slice(0, text.length - held.length).match(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)|\x1b\[[?>=]?[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/gu) ?? [];
	return { keys: all.filter((k) => !/^\x1b(\]|\[[?>=])/.test(k)), held };
}

// ---- motion -------------------------------------------------------------------------------------------------------------------
const seenFile = () => path.join(home(), "opening-seen");
/** Has the opening played on this machine? It plays in full once; afterwards screens open on the still picture
 * (`PI_PERSONAL_MOTION=always` plays it every time, `never` never). */
export function openingDue(l: Look, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!l.motion) return false;
	return env[`${ENV}_MOTION`] === "always" || !fs.existsSync(seenFile());
}
export function openingSeen(): void {
	try {
		fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
		fs.writeFileSync(seenFile(), `${new Date().toISOString()}\n`);
	} catch {} // not being able to remember it only means it plays again
}

/**
 * Play a drawing in place, `frame(t)` giving the same number of lines at every `t`, for `ms` milliseconds; then leave
 * its last picture on the screen. Any key skips to the end (Ctrl+C leaves, as everywhere). Nothing is asked of the
 * person meanwhile, and the drawing never waits for anything.
 */
export async function play(frame: (t: number) => string[], ms: number, out: NodeJS.WriteStream = process.stdout, input: NodeJS.ReadStream = process.stdin): Promise<void> {
	let skip = false;
	const onKey = (key: Buffer) => {
		if (key[0] === 3) {
			restore();
			out.write("\n");
			process.exit(130);
		}
		skip = true;
	};
	const raw = !!input.isTTY && !input.isRaw;
	const restore = () => {
		out.write("\x1b[?25h");
		if (!raw) return;
		input.off("data", onKey);
		input.setRawMode(false);
		input.pause();
	};
	if (raw) {
		input.setRawMode(true);
		input.resume();
		input.on("data", onKey);
	}
	out.write("\x1b[?25l"); // no cursor while it plays
	const began = Date.now();
	try {
		for (;;) {
			const t = Date.now() - began;
			const last = skip || t >= ms;
			const lines = frame(last ? ms : t);
			// One update per picture (terminals that know synchronized output show it whole), each line cleared to its end.
			out.write(`\x1b[?2026h${lines.map((s) => `${s}\x1b[K`).join("\n")}\n\x1b[?2026l`);
			if (last) break;
			out.write(`\x1b[${lines.length}A`);
			await new Promise((r) => setTimeout(r, 33));
		}
	} finally {
		restore();
	}
}

/**
 * A screen that lives until a key decides: `frame(t)` is drawn (again every `every` ms, so that what moves moves and
 * what changed is seen, and after each key), `onKey` returns a result to end, or undefined to go on. `top`: drawn from
 * the top of the screen (a full-screen view, in the terminal's alternate screen, see `fullScreen`); otherwise in place
 * under what is already there, and `erase` (returned) takes it away. Ctrl+C ends with `interrupted`; Escape alone is a
 * key once nothing follows it for 40 ms. Without a terminal, nothing is drawn and `interrupted` is returned at once.
 */
export async function live<T>(
	frame: (t: number) => string[],
	onKey: (key: string) => T | undefined,
	interrupted: T,
	o: { every?: number; top?: boolean; out?: NodeJS.WriteStream; input?: NodeJS.ReadStream } = {},
): Promise<{ result: T; erase: () => void }> {
	const { every = 120, top = false, out = process.stdout, input = process.stdin } = o;
	let drawn = 0; // rows on the screen, a line wider than the terminal counting for the rows it wraps onto
	const erase = () => {
		if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`);
		drawn = 0;
	};
	if (!input.isTTY || !out.isTTY) return { result: interrupted, erase };
	const began = Date.now();
	const draw = () => {
		const columns = out.columns || 80;
		let lines = frame(Date.now() - began);
		if (top && out.rows) lines = lines.slice(0, out.rows - 1); // never more than the screen holds: it would scroll
		out.write(`\x1b[?2026h${top ? "\x1b[H" : drawn ? `\x1b[${drawn}A\r` : ""}${lines.map((s) => `${s}\x1b[K`).join("\n")}\n\x1b[J\x1b[?2026l`);
		drawn = lines.reduce((n, s) => n + Math.max(1, Math.ceil(width(s) / columns)), 0);
	};
	out.write("\x1b[?25l");
	input.setRawMode(true);
	input.resume();
	let held = "";
	let escape: NodeJS.Timeout | undefined;
	try {
		const result = await new Promise<T>((resolve) => {
			const timer = setInterval(draw, every);
			const onResize = () => draw();
			let over = false;
			const done = (r: T) => {
				over = true;
				clearInterval(timer);
				clearTimeout(escape);
				input.off("data", onData);
				out.off("resize", onResize);
				resolve(r);
			};
			const press = (keys: string[]) => {
				for (const k of keys) {
					const r = k === "\u0003" ? interrupted : onKey(k);
					if (r !== undefined) return done(r);
				}
				draw();
			};
			const onData = (buf: Buffer) => {
				clearTimeout(escape);
				const read = split(held + buf.toString("utf8"));
				held = read.held;
				press(read.keys);
				// A lone Escape looks like the start of a longer key: it is Escape itself when nothing follows.
				if (!over && held === "\x1b")
					escape = setTimeout(() => {
						held = "";
						press(["\x1b"]);
					}, 40);
			};
			input.on("data", onData);
			out.on("resize", onResize);
			draw();
		});
		return { result, erase };
	} finally {
		input.setRawMode(false);
		input.pause();
		out.write("\x1b[?25h");
	}
}

/** The terminal's alternate screen, as full-screen programs use it: `on` clears it and draws from its top; `off`
 * gives back the screen as it was before, with what was printed there. */
let alternate = false;
export function fullScreen(on: boolean, out: NodeJS.WriteStream = process.stdout): void {
	if (!out.isTTY || on === alternate) return; // asked twice, done once: a second "off" would move the cursor back
	alternate = on;
	out.write(on ? "\x1b[?1049h\x1b[H\x1b[2J" : "\x1b[?1049l");
}
