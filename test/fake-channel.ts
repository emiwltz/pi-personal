// A channel for tests: sends what it finds in $PI_PERSONAL_STATE/outbox/*.txt, and records the agent's replies
// to its own messages in $PI_PERSONAL_STATE/sent.jsonl, resuming from a saved cursor after a restart. It pilots the
// agent as a channel does for its owner: for each $PI_PERSONAL_STATE/remote/<n>.json ({ words, stdin?, id? }), read then
// removed at once (it may hold a secret), it runs $PI_PERSONAL_REMOTE with the words, the input on standard input and
// the id as PI_PERSONAL_REMOTE_ID, and writes { code, stdout, stderr } to remote/<n>.out.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as port from "../core/port.ts";

const P = process.env.PI_PERSONAL_PORT!;
const S = process.env.PI_PERSONAL_STATE!;
fs.writeFileSync(path.join(S, "pid"), String(process.pid));
const outbox = path.join(S, "outbox");
fs.mkdirSync(outbox, { recursive: true });
const cursorFile = path.join(S, "cursor");
let cursor = fs.existsSync(cursorFile) ? Number(fs.readFileSync(cursorFile, "utf8")) : port.end(P);
const flush = () => {
	for (const f of fs.readdirSync(outbox).filter((f) => f.endsWith(".txt"))) {
		const id = f.slice(0, -4);
		port.submit(P, { id, text: fs.readFileSync(path.join(outbox, f), "utf8"), from: { channel: "fake" } });
		fs.rmSync(path.join(outbox, f));
	}
};
setInterval(flush, 200);
const remote = path.join(S, "remote");
fs.mkdirSync(remote, { recursive: true });
let piloting = false;
setInterval(() => {
	if (piloting) return;
	piloting = true;
	for (const f of fs.readdirSync(remote).filter((f) => f.endsWith(".json"))) {
		const file = path.join(remote, f);
		const ask = JSON.parse(fs.readFileSync(file, "utf8")) as { words: string[]; stdin?: string; id?: string };
		fs.rmSync(file);
		const command = JSON.parse(process.env.PI_PERSONAL_REMOTE!) as string[];
		const env = { ...process.env, ...(ask.id ? { PI_PERSONAL_REMOTE_ID: ask.id } : {}) };
		const r = spawnSync(command[0], [...command.slice(1), ...ask.words], { env, input: ask.stdin ?? "", encoding: "utf8", timeout: 120_000 });
		fs.writeFileSync(`${file}.tmp`, JSON.stringify({ code: r.status, stdout: r.stdout, stderr: r.stderr }));
		fs.renameSync(`${file}.tmp`, `${file.slice(0, -5)}.out`); // whole, for the test that waits for it
	}
	piloting = false;
}, 200);
await port.follow(P, cursor, (e) => {
	if (e.type === "message" && (e.refs as port.Ref[]).some((r) => r.from?.channel === "fake"))
		fs.appendFileSync(path.join(S, "sent.jsonl"), `${JSON.stringify({ text: e.text, cursor: e.cursor })}\n`);
	cursor = e.after;
	fs.writeFileSync(cursorFile, String(cursor));
});
