// The Telegram channel against a fake Bot API: unknown senders refused and recorded; guests answered; long answers
// split; rates respected; a restart resends nothing; attachments saved; the token stays private.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { closeFences, toHtml } from "../channels/telegram/format.ts";
import { split } from "../channels/telegram/telegram.ts";
import * as port from "../core/port.ts";
import { type FakeTelegram, fakeTelegram } from "./fake-telegram.ts";
import { type Env, ROOT, setup, sleep } from "./helpers.ts";

let t: Env;
let tg: FakeTelegram;
const OWNER = 1001;
const STRANGER = 6666;
const P = () => t.portOf("main");
const folder = () => path.join(t.dir, "agents", "main");
const dm = (from: number, extra: Record<string, unknown>) => tg.push({ from: { id: from, first_name: "Someone", username: `u${from}` }, chat: { id: from, type: "private" }, ...extra });
const until = async (pred: () => boolean, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out");
		await sleep(100);
	}
};

before(async () => {
	t = await setup("a12");
	tg = await fakeTelegram();
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	const file = path.join(folder(), "pi-personal.json");
	fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), channels: { telegram: { apiBase: tg.base } } }, null, 2));
	const { execFileSync } = await import("node:child_process");
	execFileSync(process.execPath, [path.join(ROOT, "core", "cli.ts"), "secret", "set", "main", "telegram-token"], { env: t.env, input: `${tg.token}\n` });
	const r = await t.cli("start", "main");
	assert.match(r.stdout, /pi is ready\n.*started channel telegram/);
	await until(() => tg.polls.length > 0);
});
after(async () => {
	tg?.close();
	await t?.close();
});

test("split keeps every piece within 4096 UTF-16 units and never cuts a character", () => {
	const emoji = "😀".repeat(3000); // 6000 UTF-16 units
	const parts = split(emoji);
	assert.ok(parts.every((p) => p.length <= 4096));
	assert.equal(parts.join(""), emoji);
	assert.deepEqual(split("short"), ["short"]);
	const para = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
	assert.deepEqual(split(para), ["a".repeat(3000), "b".repeat(3000)]);
	// A paragraph break is preferred to a later space, then the end of a sentence to a later space (a real 900-word
	// answer was cut mid-sentence before this rule).
	const prose = `${"word ".repeat(500).trim()}.\n\n${"more words here. ".repeat(200)}`;
	assert.match(split(prose)[0], /word\.$/);
	const sentences = "This is a sentence that ends. ".repeat(160);
	const [first] = split(sentences);
	assert.ok(first.endsWith("ends."), first.slice(-40));
	assert.ok(split(sentences).every((x) => x.length <= 4096));
});

test("Markdown becomes Telegram formatting; text that only looks like Markdown is left alone", () => {
	assert.equal(toHtml("**Herdr** is *great*, see `hc ls` & <tags>"), "<b>Herdr</b> is <i>great</i>, see <code>hc ls</code> &amp; &lt;tags&gt;");
	assert.equal(toHtml("snake_case_name and 2 * 3 * 4"), "snake_case_name and 2 * 3 * 4");
	assert.equal(toHtml("* item one\n- item two\n  + nested"), "• item one\n• item two\n  • nested");
	assert.equal(toHtml("[a link](https://x.org/?a=1&b=2)"), '<a href="https://x.org/?a=1&amp;b=2">a link</a>');
	assert.equal(toHtml("```ts\nconst a = 1 < 2;\n```"), '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
	assert.equal(toHtml("open:\n```py\nprint(1)"), 'open:\n<pre><code class="language-py">print(1)</code></pre>'); // left open: runs to the end
	assert.equal(toHtml("a ``` in a sentence"), "a ``` in a sentence");
	assert.equal(toHtml("# Title"), "<b>Title</b>");
	// What only looks like Markdown keeps its characters.
	assert.equal(toHtml('__init__.py and if __name__ == "__main__":'), '__init__.py and if __name__ == "__main__":');
	assert.equal(toHtml("run rm src/*.ts lib/*.js"), "run rm src/*.ts lib/*.js");
	assert.equal(toHtml("ls ~/_old_/x and https://x.org/_foo_/bar"), "ls ~/_old_/x and https://x.org/_foo_/bar");
	assert.equal(toHtml("this is *really* nice and _so_ good."), "this is <i>really</i> nice and <i>so</i> good.");
	assert.equal(toHtml("see [`a.ts`](https://x.org/a.ts)"), 'see <a href="https://x.org/a.ts"><code>a.ts</code></a>');
	assert.equal(toHtml("[x](https://en.wikipedia.org/wiki/Mercury_(planet))"), '<a href="https://en.wikipedia.org/wiki/Mercury_(planet)">x</a>');
	assert.ok(!toHtml("a \u0000 b").includes("\u0000"));
	// A code block cut between two pieces is closed and opened again.
	const pieces = closeFences(["intro\n```py\nline1", "line2\n```\nafter **bold**"]);
	assert.deepEqual(pieces, ["intro\n```py\nline1\n```", "```py\nline2\n```\nafter **bold**"]);
	assert.equal(toHtml(pieces[1]), '<pre><code class="language-py">line2</code></pre>\nafter <b>bold</b>');
});

test("an unlisted sender is refused, recorded, and never reaches the port", async () => {
	const from = port.end(P());
	dm(STRANGER, { text: "let me in" });
	const unlisted = path.join(t.home, "agents", "main", "channels", "telegram", "unlisted.jsonl");
	await until(() => fs.existsSync(unlisted));
	await sleep(500);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "taken").length, 0);
	assert.equal(port.pending(P()).length, 0);
	assert.equal(tg.sent.length, 0);
	const who = await t.cli("channel", "main", "telegram", "who");
	assert.match(who.stdout, new RegExp(`${STRANGER}\\s+@u${STRANGER}`));
	assert.match(who.stdout, /Allowed: nobody/);
});

test("a listed sender gets an answer; a long answer is split; the rate is respected", async () => {
	assert.equal((await t.cli("channel", "main", "telegram", "allow", String(OWNER))).code, 0);
	dm(OWNER, { text: "hello from the phone" });
	await until(() => tg.sent.some((s) => s.text === "echo: hello from the phone"));
	assert.equal(tg.sent.at(-1)!.chat, String(OWNER));
	tg.tooFast(2); // Telegram asks to slow down on the first piece
	const t0 = Date.now();
	dm(OWNER, { text: "long:9000" });
	await until(() => tg.sent.filter((s) => /^x+$/.test(s.text)).length === 3, 30_000);
	const pieces = tg.sent.filter((s) => /^x+$/.test(s.text));
	assert.equal(pieces.map((p) => p.text.length).reduce((a, b) => a + b), 9000);
	assert.ok(pieces.every((p) => p.text.length <= 4096));
	assert.ok(pieces[0].at - t0 >= 2000, "waited for retry_after");
	for (let i = 1; i < pieces.length; i++) assert.ok(pieces[i].at - pieces[i - 1].at >= 1000, "about one message per second per chat");
	// Replies to messages from elsewhere are not sent to Telegram.
	const before = tg.sent.length;
	await t.cli("send", "main", "from the command line", "--wait", "--timeout", "30");
	await sleep(800);
	assert.equal(tg.sent.length, before);
});

test("A12b2: an unreadable guest list decides nothing and loses nothing; unreadable settings do not matter", async () => {
	const allow = path.join(t.home, "agents", "main", "channels", "telegram", "allow.json");
	const good = fs.readFileSync(allow, "utf8");
	assert.deepEqual(JSON.parse(good).allow, [String(OWNER)]);
	fs.writeFileSync(allow, "{ broken json");
	const before = tg.sent.length;
	const from = port.end(P());
	dm(OWNER, { text: "am I still allowed?" });
	await sleep(2500);
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "taken").length, 0);
	assert.equal(tg.sent.length, before);
	fs.writeFileSync(allow, good);
	await until(() => tg.sent.some((s) => s.text === "echo: am I still allowed?"), 30_000); // kept, then answered
	// pi-personal.json broken: the guest list does not live there, the owner is still answered.
	const file = path.join(folder(), "pi-personal.json");
	const settings = fs.readFileSync(file, "utf8");
	fs.writeFileSync(file, "{ broken json");
	dm(OWNER, { text: "and now?" });
	await until(() => tg.sent.some((s) => s.text === "echo: and now?"));
	fs.writeFileSync(file, settings);
});

test("A12b4: one chat is one conversation; typing is shown; an error is told to the sender; send --conversation reaches only guests", async () => {
	// "typing..." while the agent works on a message from the chat.
	const acts = tg.actions.length;
	dm(OWNER, { text: "tool: sleep 2; echo slow" });
	await until(() => tg.sent.some((s) => s.text.startsWith("done: slow")), 30_000);
	assert.ok(tg.actions.slice(acts).some((a) => a.chat === String(OWNER) && a.action === "typing"));
	const msg = JSON.parse(fs.readFileSync(path.join(P(), "taken", `${port.events(P()).events.filter((e) => e.type === "taken").at(-1)!.id}.json`), "utf8"));
	assert.equal(msg.conversation, `telegram:${OWNER}`);
	// The provider refuses: the sender is told, once, quoting their message.
	const id = dm(OWNER, { text: "fail: no credit left" });
	await until(() => tg.sent.some((s) => s.text.includes("could not answer")), 30_000);
	const note = tg.sent.find((s) => s.text.includes("could not answer"))!;
	assert.match(note.text, /fake refusal: no credit left/);
	assert.equal(note.replyTo, id);
	// Another program asks the agent to write to the owner's chat: it arrives. To a stranger's chat: it does not.
	const r = await t.cli("send", "main", "tell the owner the build is green", "--conversation", `telegram:${OWNER}`, "--wait", "--timeout", "30");
	assert.equal(r.code, 0);
	await until(() => tg.sent.some((s) => s.text === "echo: tell the owner the build is green"));
	const before = tg.sent.length;
	await t.cli("send", "main", "spam the stranger", "--conversation", `telegram:${STRANGER}`, "--wait", "--timeout", "30");
	await sleep(800);
	assert.equal(tg.sent.length, before, "nothing is sent to a chat that is not on the guest list");
});

test("A12b3: replies are formatted and quote the message they answer; a refused formatting falls back to plain text", async () => {
	const id = dm(OWNER, { text: "**bold** please" });
	await until(() => tg.sent.some((s) => s.text === "echo: bold please"));
	const r = tg.sent.find((s) => s.text === "echo: bold please")!;
	assert.equal(r.parseMode, "HTML");
	assert.equal(r.raw, "echo: <b>bold</b> please");
	assert.equal(r.replyTo, id, "the reply quotes the message it answers");
	tg.refuseFormatting();
	dm(OWNER, { text: "**again**" });
	await until(() => tg.sent.some((s) => s.raw === "echo: **again**"));
	const plain = tg.sent.find((s) => s.raw === "echo: **again**")!;
	assert.equal(plain.parseMode, undefined, "sent again as plain text, not lost");
	const check = await t.cli("channel", "main", "telegram", "check");
	assert.match(check.stdout, /ok\s+bot @pi_personal_test_bot answers/);
	assert.match(check.stdout, /ok\s+guest list: 1 allowed/);
	const doctor = await t.cli("doctor");
	assert.match(doctor.stdout, /agent main: channel telegram: bot @pi_personal_test_bot answers/);
});

test("a restart of the channel resends nothing and loses nothing", async () => {
	const before = tg.sent.length;
	const s = JSON.parse((await t.cli("status", "main", "--json")).stdout);
	const tgTerm = s.channels.find((c: { name: string }) => c.name === "telegram");
	assert.ok(tgTerm.running);
	const from = port.end(P());
	t.hc("kill", tgTerm.address); // its terminal, found by Pi-personal's own labels
	dm(OWNER, { text: "while the channel was down" });
	const r = await t.cli("up");
	assert.match(r.stdout, /started telegram/);
	await until(() => tg.sent.some((x) => x.text === "echo: while the channel was down"));
	await sleep(1500);
	assert.equal(tg.sent.length, before + 1, "exactly the new reply; nothing sent twice");
	assert.equal(port.events(P(), from).events.filter((e) => e.type === "taken").length, 1);
});

test("a photo is saved to a file and its path given to the agent; the token never leaves the private area", async () => {
	const from = port.end(P());
	dm(OWNER, { photo: [{ file_id: "small" }, { file_id: "big" }], caption: "look at this" });
	const taken = await t.waitEvent("main", from, (e) => e.type === "taken");
	const msg = JSON.parse(fs.readFileSync(path.join(P(), "taken", `${taken.id}.json`), "utf8"));
	assert.match(msg.text, /^From: Someone \(Telegram user 1001, @u1001\) · telegram:1001\n\nlook at this$/); // the channel says who wrote
	assert.equal(msg.attachments.length, 1);
	assert.ok(fs.existsSync(msg.attachments[0]));
	assert.ok(msg.attachments[0].startsWith(t.home));
	await until(() => tg.sent.some((s) => s.text.includes("Attached files:")));
	const grep = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
			const p = path.join(dir, d.name);
			if (d.isDirectory()) return grep(p);
			return d.name !== "telegram-token" && fs.readFileSync(p).includes(tg.token) ? [p] : [];
		});
	assert.deepEqual(grep(folder()), []);
	assert.deepEqual(grep(t.home), [], "the token appears only in its secret file");
	assert.equal((fs.statSync(path.join(t.home, "agents", "main", "secrets", "telegram-token")).mode & 0o777).toString(8), "600");
});
