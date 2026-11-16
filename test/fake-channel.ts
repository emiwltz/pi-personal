// A channel for tests: sends what it finds in $PI_PERSONAL_STATE/outbox/*.txt, and records the agent's replies
// to its own messages in $PI_PERSONAL_STATE/sent.jsonl, resuming from a saved cursor after a restart.
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
await port.follow(P, cursor, (e) => {
	if (e.type === "message" && (e.refs as port.Ref[]).some((r) => r.from?.channel === "fake"))
		fs.appendFileSync(path.join(S, "sent.jsonl"), `${JSON.stringify({ text: e.text, cursor: e.cursor })}\n`);
	cursor = e.after;
	fs.writeFileSync(cursorFile, String(cursor));
});
