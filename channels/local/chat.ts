#!/usr/bin/env node
// The local channel: talk to a Pi-Personal agent from the command line, through the port and nothing else.
// It is also the worked example of docs/write-a-channel.md. It imports nothing from Pi-Personal's core:
// everything it does is described in docs/port.md.
//
//   PI_PERSONAL_PORT=$(pp port main) node channels/local/chat.ts      (or simply: pp chat main)
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const port = process.env.PI_PERSONAL_PORT;
if (!port) throw new Error("PI_PERSONAL_PORT is not set");
// Whoever runs this on the agent's own machine is its owner; the login name is the name the agent reads.
const sender = { owner: true, name: os.userInfo().username, id: "pp chat" };
const me = `local:${process.pid}-${Date.now()}`; // my conversation: the agent answers it in a run of its own
let n = 0;

// 1. Sending: write the message to a temporary file, then link it into the inbox under its id (exclusive, atomic).
// `sender` says who wrote: whoever runs this command on the agent's own machine is its owner.
function send(text: string): void {
	const id = `local-${process.pid}-${Date.now()}-${++n}`;
	const tmp = path.join(port, "inbox", `.${id}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify({ id, text, conversation: me, sender }));
	fs.linkSync(tmp, path.join(port, "inbox", `${id}.json`));
	fs.rmSync(tmp);
}

// 2. Receiving: read events.jsonl from where we stopped, and show what concerns our conversation. The file only grows;
// we keep a byte offset, and handle complete lines only (up to the last newline).
const events = path.join(port, "events.jsonl");
let offset = fs.existsSync(events) ? fs.statSync(events).size : 0; // only what comes from now on

function readLines(): string[] {
	if (!fs.existsSync(events)) return [];
	const size = fs.statSync(events).size;
	if (size < offset) offset = 0; // replaced by hand: read the new file from its start
	if (size === offset) return [];
	const fd = fs.openSync(events, "r");
	const buf = Buffer.alloc(size - offset);
	fs.readSync(fd, buf, 0, buf.length, offset);
	fs.closeSync(fd);
	const end = buf.lastIndexOf(10) + 1;
	offset += end;
	return buf.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
}

// A question the agent asks while it works on one of our messages (an extension wants an approval or a choice) is for its
// owner, who is the one typing here: shown with the command that answers it, then how it closed.
const agent = process.env.PI_PERSONAL_AGENT; // set by pp chat; without it, pp answer takes the only agent
const command = process.env.PI_PERSONAL_COMMAND || "pp"; // set by pp chat: installed as pi-personal, pp may be another program
const asked = new Set<string>();
const how: Record<string, string> = { terminal: "answered in the agent's terminal", port: "answered", timeout: "closed: no answer in time", interrupted: "closed: the work it was asked for ended" };

function show(line: string): void {
	let e: { type?: string; id?: string; title?: string; options?: string[]; by?: string; channel?: string; text?: string; path?: string; error?: string; state?: string; question?: string; refs?: { conversation?: string }[] };
	try {
		e = JSON.parse(line);
	} catch {
		return; // a damaged line is skipped
	}
	const mine = (e.refs ?? []).some((r) => r.conversation === me);
	if (e.type === "question" && mine && e.id) {
		asked.add(e.id);
		const options = (e.options ?? []).map((o, i) => `\n  ${i + 1}. ${o}`).join("");
		console.log(`\n(the agent asks (${e.id}): ${e.title}${options}\n  to answer: ${command} answer ${agent ? `${agent} ` : ""}"<your answer>" --question ${e.id})\n`);
	}
	if (e.type === "answered" && e.id && asked.delete(e.id)) console.log(`(question ${e.id} ${how[e.by ?? ""] ?? "closed"})`);
	// The agent started, stopped or restarted: every question asked before is closed, and no `answered` follows.
	if (["started", "stopped", "restarted"].includes(e.type ?? "") && !e.channel) {
		for (const id of asked) console.log(`(question ${id} closed: the agent ${e.type === "stopped" ? "stopped" : "restarted"})`);
		asked.clear();
	}
	if (e.type === "message" && mine) console.log(`\n${e.text}\n`);
	if (e.type === "file" && mine) console.log(`\n[file] ${e.path}\n`); // a file the agent sent: here, where it already is
	if (e.type === "settled" && e.error && mine) console.log(`\n(the agent could not answer: ${e.error})\n`);
	if (e.type === "error" && mine) console.log(`\n(${e.error})\n`); // trouble it will try again
	// Not for our own question: its dialog in the terminal is the other way to answer it, and it was shown above.
	if (e.type === "status" && e.state === "blocked" && !asked.size) console.log(`(the agent is waiting for a person in its terminal${e.question ? `: ${e.question}` : ""})`);
}

function poll(): void {
	const lines = readLines();
	for (const l of lines) show(l);
	if (lines.length) rl.prompt();
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
rl.on("line", (line) => {
	if (line.trim()) send(line);
	else rl.prompt();
});
rl.on("close", () => process.exit(0));
fs.watch(port, poll);
setInterval(poll, 500); // file watching is not reliable everywhere
console.log("Talking to the agent. Ctrl+D to leave.");
rl.prompt();
