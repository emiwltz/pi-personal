// A fake Telegram Bot API server: getMe, getUpdates (long polling with offsets), sendMessage, sendChatAction,
// getFile and file downloads.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface Sent {
	chat: string;
	text: string; // what the user sees (formatting removed)
	raw: string; // what was sent
	parseMode?: string;
	replyTo?: number;
	at: number;
}
export interface FakeTelegram {
	base: string;
	token: string;
	sent: Sent[];
	polls: { offset: number }[];
	actions: { chat: string; action: string; at: number }[];
	push: (message: Record<string, unknown>) => number; // returns its update_id
	tooFast: (seconds: number) => void; // the next sendMessage gets a 429 with retry_after
	refuseFormatting: () => void; // the next formatted sendMessage gets "can't parse entities"
	close: () => void;
}

export async function fakeTelegram(token = "123:FAKE"): Promise<FakeTelegram> {
	const updates: { update_id: number; message: Record<string, unknown> }[] = [];
	const sent: Sent[] = [];
	const polls: { offset: number }[] = [];
	const actions: FakeTelegram["actions"] = [];
	let next = 1000;
	let retryAfter = 0;
	let refuse = false;
	const visible = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
	const waiters = new Set<() => void>();
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", async () => {
			const reply = (result: unknown) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true, result }));
			};
			const fail = (code: number, description: string, parameters?: unknown) => {
				res.writeHead(code, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) }));
			};
			if (req.url === `/file/bot${token}/photos/p1.jpg`) {
				res.writeHead(200);
				res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
				return;
			}
			const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
			if (!m || m[1] !== token) return fail(401, "Unauthorized");
			const args = body ? JSON.parse(body) : {};
			switch (m[2]) {
				case "getMe":
					return reply({ id: 1, is_bot: true, username: "pi_personal_test_bot" });
				case "getUpdates": {
					const offset = args.offset ?? 0;
					polls.push({ offset });
					const ready = () => updates.filter((u) => u.update_id >= offset);
					// Confirming: an offset forgets every earlier update, as Telegram does.
					for (let i = updates.length - 1; i >= 0; i--) if (updates[i].update_id < offset) updates.splice(i, 1);
					if (!ready().length) {
						await new Promise<void>((r) => {
							const t = setTimeout(r, Math.min((args.timeout ?? 0) * 1000, 1500));
							waiters.add(() => {
								clearTimeout(t);
								r();
							});
						});
					}
					return reply(ready());
				}
				case "sendMessage":
					if (retryAfter) {
						const s = retryAfter;
						retryAfter = 0;
						return fail(429, `Too Many Requests: retry after ${s}`, { retry_after: s });
					}
					if (refuse && args.parse_mode) {
						refuse = false;
						return fail(400, "Bad Request: can't parse entities: unsupported start tag");
					}
					if (typeof args.text !== "string") return fail(400, "Bad Request: message text is empty");
					const shown = args.parse_mode === "HTML" ? visible(args.text) : args.text;
					if (shown.length > 4096) return fail(400, "Bad Request: message is too long"); // counted after entities parsing
					sent.push({ chat: String(args.chat_id), text: shown, raw: args.text, parseMode: args.parse_mode, replyTo: args.reply_parameters?.message_id, at: Date.now() });
					return reply({ message_id: sent.length });
				case "sendChatAction":
					actions.push({ chat: String(args.chat_id), action: String(args.action), at: Date.now() });
					return reply(true);
				case "getFile":
					return reply({ file_id: args.file_id, file_path: "photos/p1.jpg" });
				default:
					return fail(404, "Not Found");
			}
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		base,
		token,
		sent,
		polls,
		actions,
		push: (message) => {
			const update_id = next++;
			updates.push({ update_id, message: { message_id: update_id, date: 0, ...message } });
			for (const w of waiters) w();
			waiters.clear();
			return update_id;
		},
		tooFast: (s) => (retryAfter = s),
		refuseFormatting: () => (refuse = true),
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}
