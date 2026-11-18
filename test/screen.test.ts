// How Pi-Personal looks: the colour depth and the motion it allows itself, the four levels of text, the mark, the
// opening, the bar. Every drawing is a function that returns text, so everything here is checked as text; no terminal,
// no agent, no Herdr Core.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as screen from "../core/screen.ts";

const tty = { isTTY: true };
const colour = (env: NodeJS.ProcessEnv = {}) => screen.look({ COLORTERM: "truecolor", ...env }, tty);
const codes = /\x1b\[/;

test("no colour and no motion outside a terminal, under NO_COLOR, in a dumb terminal", () => {
	assert.deepEqual({ ...screen.look({ COLORTERM: "truecolor" }, { isTTY: false }), palette: undefined }, { palette: undefined, ground: "unknown", depth: "none", motion: false });
	assert.equal(screen.look({ NO_COLOR: "1", COLORTERM: "truecolor" }, tty).depth, "none");
	assert.equal(screen.look({ TERM: "dumb" }, tty).depth, "none");
	assert.equal(screen.look({ NO_COLOR: "1" }, tty).motion, false);
});

test("24-bit colour when the terminal says so, 256 colours otherwise; motion off under CI or when asked", () => {
	assert.equal(colour().depth, "truecolor");
	assert.equal(screen.look({ COLORTERM: "24bit" }, tty).depth, "truecolor");
	assert.equal(screen.look({ TERM: "xterm-256color" }, tty).depth, "256");
	assert.equal(colour().motion, true);
	assert.equal(colour({ CI: "true" }).motion, false);
	assert.equal(colour({ PI_PERSONAL_MOTION: "never" }).motion, false);
});

test("the light palette on a light terminal, the dark one on a dark one, or as asked; colours that read on both when nothing says", () => {
	assert.equal(colour().palette, screen.TWILIGHT);
	assert.equal(colour().ground, "unknown");
	assert.equal(colour({ COLORFGBG: "0;15" }).palette, screen.DAY);
	assert.equal(colour({ COLORFGBG: "15;0" }).palette, screen.NIGHT);
	assert.equal(colour({ PI_PERSONAL_THEME: "light" }).palette, screen.DAY);
	assert.equal(colour({ PI_PERSONAL_THEME: "dark", COLORFGBG: "0;15" }).palette, screen.NIGHT);
});

test("background unknown: the words keep the terminal's own colour (bold, dim), the two colours read on white and on black", () => {
	const l = colour();
	assert.equal(screen.bright(l, "name", true), "\x1b[1mname\x1b[0m");
	assert.equal(screen.bright(l, "name"), "name");
	assert.equal(screen.second(l, "hint"), "\x1b[2mhint\x1b[0m");
	assert.equal(screen.second(screen.look({}, { isTTY: false }), "hint"), "hint");
	const lum = (c: screen.Rgb) => {
		const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	for (const c of [screen.TWILIGHT.a, screen.TWILIGHT.b]) {
		assert.ok((1.05 / (lum(c) + 0.05)) >= 4, `${c} on white`);
		assert.ok((lum(c) + 0.05) / 0.05 >= 4, `${c} on black`);
	}
});

test("256 colours: the nearest of the cube's real levels (0, 95, 135, 175, 215, 255) or of the greys", () => {
	assert.equal(screen.nearest256([0, 0, 0]), 16);
	assert.equal(screen.nearest256([255, 255, 255]), 231);
	assert.equal(screen.nearest256([95, 135, 175]), 16 + 36 * 1 + 6 * 2 + 3);
	assert.equal(screen.nearest256([100, 100, 100]), 232 + 9, "a grey goes to the grey ramp (98)");
	assert.equal(screen.nearest256([168, 88, 0]), 16 + 36 * 3 + 6 * 1 + 0, "the light palette's amber stays dark enough: 175, 95, 0");
});

test("text is painted in the terminal's colour depth, and left alone without colour", () => {
	assert.equal(screen.paint(screen.look({}, { isTTY: false }), "hello", [1, 2, 3], { bold: true }), "hello");
	assert.equal(screen.paint(colour(), "x", [255, 181, 72]), "\x1b[38;2;255;181;72mx\x1b[0m");
	assert.equal(screen.paint(screen.look({}, tty), "x", [255, 0, 0], { bold: true }), "\x1b[1m\x1b[38;5;196mx\x1b[0m");
	assert.equal(screen.width(screen.bright(colour({ PI_PERSONAL_THEME: "dark" }), "four", true)), 4);
	assert.equal(screen.width(screen.bright(colour(), "four", true)), 4);
});

test("the two levels of text meant to be read keep a contrast of 4.5:1, on indigo and on black, in the dark palette; on white in the light one", () => {
	const lum = (c: screen.Rgb) => {
		const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a: screen.Rgb, b: screen.Rgb) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
	for (const ground of [[28, 26, 59], [0, 0, 0]] as screen.Rgb[]) for (const c of [screen.NIGHT.ink, screen.NIGHT.mute]) assert.ok(ratio(c, ground) >= 4.5, `${c} on ${ground}: ${ratio(c, ground).toFixed(1)}`);
	for (const c of [screen.DAY.ink, screen.DAY.mute, screen.DAY.a, screen.DAY.b]) assert.ok(ratio(c, [255, 255, 255]) >= 4.5, `${c} on white: ${ratio(c, [255, 255, 255]).toFixed(1)}`);
});

test("the opening keeps its height and its width at every moment, and ends on a still picture", () => {
	const l = colour();
	for (let t = 0; t <= screen.OPENING_MS + 500; t += 40) {
		const lines = screen.opening(l, "0.4", t);
		assert.equal(lines.length, screen.OPENING_ROWS, `at ${t} ms`);
		for (const s of lines) {
			assert.ok(screen.width(s) <= screen.OPENING_COLS, `at ${t} ms: ${screen.width(s)} columns`);
			assert.doesNotMatch(s, /undefined|NaN/);
		}
	}
	const still = screen.opening(l, "0.4", screen.OPENING_MS);
	assert.deepEqual(screen.opening(l, "0.4", screen.OPENING_MS + 60_000), still, "nothing moves after the end");
	assert.match(still.join("\n"), /Pi-Personal/);
	assert.match(still.join("\n"), /0\.4/);
	assert.match(still.join("\n"), /▀/, "the mark is solid at the end");
	assert.match(screen.opening(l, "0.4", 300).join("\n"), /[⠁-⣿]/, "it starts as stars");
});

test("a screen opens on the small mark beside the name, on one line in a narrow terminal, on one plain line without colour", () => {
	const l = colour();
	const wide = screen.header(l, "0.4", 100);
	assert.equal(wide.length, 6);
	for (const s of wide) assert.ok(screen.width(s) <= 52, `${screen.width(s)} columns`);
	assert.match(wide.join("\n"), /▀/);
	const narrow = screen.header(l, "0.4", 40);
	assert.equal(narrow.length, 1);
	assert.equal(screen.width(narrow[0]), "✦ Pi-Personal 0.4".length);
	assert.deepEqual(screen.header(screen.look({}, { isTTY: false }), "0.4", 100), ["Pi-Personal 0.4"]);
	const m = screen.mark(l);
	assert.equal(m.length, 4);
	for (const s of m) assert.equal(screen.width(s), 16);
});

test("the terminal's answer about its background: light over one half of luminance, dark under; nothing from noise", () => {
	assert.equal(screen.background("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"), "light");
	assert.equal(screen.background("\x1b]11;rgb:1c1c/1a1a/3b3b\x07"), "dark");
	assert.equal(screen.background("\x1b]11;rgb:fd/f6/e3\x07"), "light", "two hex digits per colour (Solarized light)");
	assert.equal(screen.background("\x1b]11;rgba:0000/0000/0000/ffff\x07"), "dark");
	assert.equal(screen.background("\x1b[?62;22c"), undefined, "only the second answer: the terminal does not know the question");
	assert.equal(screen.background(""), undefined);
});

test("what the terminal said decides the palette, unless PI_PERSONAL_THEME says; COLORFGBG only when it said nothing", () => {
	assert.equal(screen.look({ COLORTERM: "truecolor" }, tty, "light").palette, screen.DAY);
	assert.equal(screen.look({ COLORTERM: "truecolor", COLORFGBG: "0;15" }, tty, "dark").palette, screen.NIGHT);
	assert.equal(screen.look({ COLORTERM: "truecolor", PI_PERSONAL_THEME: "dark" }, tty, "light").palette, screen.NIGHT);
	assert.equal(screen.look({ COLORTERM: "truecolor", COLORFGBG: "0;15" }, tty, undefined).palette, screen.DAY);
});

test("asking the background: the question is sent, the answer read, the terminal left as it was; no wait past the limit", async () => {
	const { EventEmitter } = await import("node:events");
	const fake = (answer: string | undefined) => {
		const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, modes: [] as boolean[], setRawMode(on: boolean) { this.modes.push(on); this.isRaw = on; }, resume() {}, pause() {} });
		let sent = "";
		const out = { isTTY: true, write: (s: string) => ((sent += s), answer !== undefined && setTimeout(() => input.emit("data", Buffer.from(answer)), 5), true) };
		return { input, out, sent: () => sent };
	};
	// The module remembers a first answer: each case runs in a fresh copy of it.
	const fresh = async () => (await import(`../core/screen.ts?case=${Math.random()}`)) as typeof screen;
	const light = fake("\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;22c");
	const s1 = await fresh();
	assert.equal(await s1.sense(1000, light.input as never, light.out as never, {}), "light");
	assert.match(light.sent(), /\x1b\]11;\?/, "the question about the background");
	assert.match(light.sent(), /\x1b\[c/, "and the one every terminal answers");
	assert.deepEqual(light.input.modes, [true, false], "raw for the answer, then given back");
	assert.equal(light.input.listenerCount("data"), 0);
	assert.equal(s1.look({ COLORTERM: "truecolor" }, tty).palette, s1.DAY, "remembered for every later look");
	// A terminal that knows only the second question is not waited for.
	const plain = fake("\x1b[?62;22c");
	const began = Date.now();
	assert.equal(await (await fresh()).sense(5000, plain.input as never, plain.out as never, {}), undefined);
	assert.ok(Date.now() - began < 1000, "done on the second answer, not at the limit");
	// One that answers nothing: at most the limit.
	const mute = fake(undefined);
	const t0 = Date.now();
	assert.equal(await (await fresh()).sense(120, mute.input as never, mute.out as never, {}), undefined);
	assert.ok(Date.now() - t0 < 600);
	assert.deepEqual(mute.input.modes, [true, false]);
	// Not asked at all when PI_PERSONAL_THEME says, or outside a terminal.
	const never = fake("\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?1c");
	assert.equal(await (await fresh()).sense(100, never.input as never, never.out as never, { PI_PERSONAL_THEME: "dark" }), undefined);
	assert.equal(never.sent(), "");
});

test("the mark is the square « Pp »: the capital and the small p, side by side, the p going below the line", () => {
	const l = screen.look({}, { isTTY: false });
	assert.deepEqual(screen.header(l, "0.4", 100), ["Pi-Personal 0.4"]);
	const rows = screen.mark(colour()).map((r) => r.replace(/\x1b\[[0-9;]*m/g, ""));
	// Two points per character: ▀ is the top one (the bottom one, when lit, is its background colour), ▄ the bottom one alone.
	assert.deepEqual(rows.map((r) => r.trimEnd()), [" ▀▀▀▀▀▀", " ▀▀▄▄▀▀  ▀▀▀▀▀▀", " ▀▀      ▀▀▄▄▀▀", "         ▀▀"]);
	assert.equal((screen.mark(colour())[0].match(/\x1b\[48;/g) ?? []).length, 4, "in the top row, only the P's bowl sides are lit below as well");
});

test("the bar is as wide as asked, empty at 0 and full at 1", () => {
	const l = colour();
	for (const k of [0, 0.3, 0.999, 1]) assert.equal(screen.width(screen.bar(l, k, 24)), 24);
	assert.doesNotMatch(screen.bar(l, 1, 10), /─|╸/);
	assert.doesNotMatch(screen.bar(l, 0, 10), /━/);
	assert.doesNotMatch(screen.star(screen.look({}, { isTTY: false })), codes);
});

test("the opening plays in full once on a machine; afterwards it is due only when asked", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-personal-screen-"));
	const before = process.env.PI_PERSONAL_HOME;
	process.env.PI_PERSONAL_HOME = path.join(dir, "home");
	try {
		const l = colour();
		assert.equal(screen.openingDue(l, {}), true);
		assert.equal(screen.openingDue(screen.look({}, { isTTY: false }), {}), false, "never without motion");
		screen.openingSeen();
		assert.equal(screen.openingDue(l, {}), false);
		assert.equal(screen.openingDue(l, { PI_PERSONAL_MOTION: "always" }), true);
	} finally {
		if (before === undefined) delete process.env.PI_PERSONAL_HOME;
		else process.env.PI_PERSONAL_HOME = before;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("playing a drawing ends on its last picture, and gives the cursor back", async () => {
	let written = "";
	const out = { write: (s: string) => ((written += s), true) } as unknown as NodeJS.WriteStream;
	const input = { isTTY: false } as unknown as NodeJS.ReadStream;
	await screen.play((t) => [`line one at ${t >= 80 ? "the end" : "the start"}`, "line two"], 80, out, input);
	assert.match(written, /^\x1b\[\?25l/, "the cursor is hidden first");
	assert.match(written, /line one at the start/);
	assert.ok(written.lastIndexOf("line one at the end") > written.lastIndexOf("line one at the start"));
	assert.match(written, /\x1b\[\?25h$/, "and given back at the end");
	assert.match(written, /\x1b\[2A/, "each picture is drawn over the one before");
});

test("a keyboard read: keys one at a time; a terminal's answers dropped whole, even when cut between two reads", async () => {
	const { split } = screen;
	assert.deepEqual(split("ab\x1b[A\r"), { keys: ["a", "b", "\x1b[A", "\r"], held: "" });
	assert.deepEqual(split("\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;22cy"), { keys: ["y"], held: "" }, "a late answer is not typed into a question");
	assert.deepEqual(split("\x1b]11;rgb:1e1e/1e1e/1e1e\x07n"), { keys: ["n"], held: "" });
	const first = split("x\x1b]11;rgb:ff");
	assert.deepEqual(first, { keys: ["x"], held: "\x1b]11;rgb:ff" });
	const second = split(`${first.held}ff/ffff/ffff\x1b`);
	assert.deepEqual(second.keys, []);
	assert.deepEqual(split(`${second.held}\\2`).keys, ["2"]);
	assert.deepEqual(split("\x1b[?62;2").held, "\x1b[?62;2", "a cut answer waits for its end");
	assert.deepEqual(split("\x1b[200~text\x1b[201~").keys.join(""), "\x1b[200~text\x1b[201~", "paste marks still pass, as before");
});

