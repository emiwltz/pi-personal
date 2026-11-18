#!/usr/bin/env node
// The local channel: talk to a Pi-Personal agent from the command line, through the port and nothing else.
// It is also the worked example of docs/write-a-channel.md. It imports nothing from Pi-Personal's core:
// everything it does is described in docs/port.md.
//
//   PI_PERSONAL_PORT=$(pp port main) node channels/local/chat.ts      (or simply: pp chat main)
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const port = process.env.PI_PERSONAL_PORT;
if (!port) throw new Error("PI_PERSONAL_PORT is not set");
const me = `local:${process.pid}-${Date.now()}`; // my conversation: the agent answers it in a run of its own
let n = 0;

// 1. Sending: write the message to a temporary file, then link it into the inbox under its id (exclusive, atomic).
function send(text: string): void {
	const id = `local-${process.pid}-${Date.now()}-${++n}`;
	const tmp = path.join(port, "inbox", `.${id}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify({ id, text, conversation: me }));
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

function show(line: string): void {
	let e: { type?: string; text?: string; error?: string; state?: string; question?: string; refs?: { conversation?: string }[] };
	try {
		e = JSON.parse(line);
	} catch {
		return; // a damaged line is skipped
	}
	const mine = (e.refs ?? []).some((r) => r.conversation === me);
	if (e.type === "message" && mine) console.log(`\n${e.text}\n`);
	if (e.type === "settled" && e.error && mine) console.log(`\n(the agent could not answer: ${e.error})\n`);
	if (e.type === "error" && mine) console.log(`\n(${e.error})\n`); // trouble it will try again
	if (e.type === "status" && e.state === "blocked") console.log(`(the agent is waiting for a person in its terminal${e.question ? `: ${e.question}` : ""})`);
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
