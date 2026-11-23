// A fake Telegram Bot API server: getMe, getUpdates (long polling with offsets), sendMessage, sendChatAction,
// getFile and file downloads, uploads (sendPhoto, sendDocument, sendVoice, sendAudio, sendVideo: multipart bodies,
// parsed as Telegram does), one of which can be refused on request, and deleteMessage, recorded or refused on request;
// the command menu (setMyCommands, deleteMyCommands), and buttons: their taps (callback queries) and their removal.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface Sent {
	chat: string;
	text: string; // what the user sees (formatting removed)
	raw: string; // what was sent
	parseMode?: string;
	replyTo?: number;
	buttons?: { text: string; data: string }[][]; // an inline keyboard under the message
	at: number;
}
export interface Upload {
	method: string; // sendPhoto, sendDocument...
	chat: string;
	name: string; // the file's name, as uploaded
	bytes: Buffer;
	replyTo?: number;
	at: number;
}
export const UPLOADS = ["sendPhoto", "sendDocument", "sendVoice", "sendAudio", "sendVideo"];
export interface FakeTelegram {
	base: string;
	token: string;
	sent: Sent[];
	polls: { offset: number }[];
	actions: { chat: string; action: string; at: number }[];
	uploads: Upload[];
	deleted: { chat: string; message: number; at: number }[]; // what deleteMessage removed, and when
	refuseDelete: () => void; // the next deleteMessage gets a 400, as a message too old to delete does
	refuseUpload: (method: string) => void; // the next upload by this method gets a 400, as a photo Telegram cannot process does
	dropUploads: (n: number) => void; // the next n uploads get no answer: the connection is cut, as a network blip does
	push: (message: Record<string, unknown>) => number; // returns its update_id
	tap: (from: Record<string, unknown>, chat: Record<string, unknown>, message: number, data: string) => number; // a button tapped
	menus: { scope: unknown; commands?: { command: string; description: string }[] }[]; // setMyCommands (commands) and deleteMyCommands (none), in order
	answered: string[]; // the taps answered (answerCallbackQuery)
	unbuttoned: number[]; // the messages whose buttons were removed
	tooFast: (seconds: number) => void; // the next sendMessage gets a 429 with retry_after
	refuseFormatting: () => void; // the next formatted sendMessage gets "can't parse entities"
	close: () => void;
}

export async function fakeTelegram(token = "123:FAKE"): Promise<FakeTelegram> {
	const updates: ({ update_id: number } & Record<string, unknown>)[] = [];
	const menus: FakeTelegram["menus"] = [];
	const answered: string[] = [];
	const unbuttoned: number[] = [];
	const sent: Sent[] = [];
	const polls: { offset: number }[] = [];
	const actions: FakeTelegram["actions"] = [];
	const uploads: Upload[] = [];
	const deleted: FakeTelegram["deleted"] = [];
	let refuseDelete = false;
	const refusing = new Set<string>();
	let dropping = 0;
	let next = 1000;
	let retryAfter = 0;
	let refuse = false;
	const visible = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
	const waiters = new Set<() => void>();
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			const body = Buffer.concat(chunks);
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
			let args: Record<string, any> = {};
			const type = req.headers["content-type"] ?? "";
			if (type.startsWith("multipart/form-data")) {
				// Text fields as strings (JSON ones parsed, as Telegram reads them), files as their name and bytes.
				for (const [k, v] of await new Response(body, { headers: { "content-type": type } }).formData())
					if (typeof v === "string") args[k] = /^[[{]/.test(v) ? JSON.parse(v) : v;
					else args[k] = { name: v.name, bytes: Buffer.from(await v.arrayBuffer()) };
			} else if (body.length) args = JSON.parse(body.toString("utf8"));
			if (UPLOADS.includes(m[2])) {
				const field = m[2].slice(4).toLowerCase(); // sendPhoto: photo
				if (dropping > 0) {
					dropping--;
					return req.socket.destroy();
				}
				if (refusing.delete(m[2])) return fail(400, "Bad Request: IMAGE_PROCESS_FAILED");
				const f = args[field];
				if (!f?.bytes) return fail(400, `Bad Request: there is no ${field} in the request`);
				uploads.push({ method: m[2], chat: String(args.chat_id), name: f.name, bytes: f.bytes, replyTo: args.reply_parameters?.message_id, at: Date.now() });
				return reply({ message_id: 10_000 + uploads.length });
			}
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
					sent.push({ chat: String(args.chat_id), text: shown, raw: args.text, parseMode: args.parse_mode, replyTo: args.reply_parameters?.message_id, ...(args.reply_markup?.inline_keyboard ? { buttons: args.reply_markup.inline_keyboard.map((row: any[]) => row.map((b) => ({ text: b.text, data: b.callback_data }))) } : {}), at: Date.now() });
					return reply({ message_id: sent.length });
				case "sendChatAction":
					actions.push({ chat: String(args.chat_id), action: String(args.action), at: Date.now() });
					return reply(true);
				case "deleteMessage":
					if (refuseDelete) {
						refuseDelete = false;
						return fail(400, "Bad Request: message can't be deleted");
					}
					deleted.push({ chat: String(args.chat_id), message: Number(args.message_id), at: Date.now() });
					return reply(true);
				case "setMyCommands":
					if (!Array.isArray(args.commands) || args.commands.some((c: any) => !/^[a-z0-9_]{1,32}$/.test(c.command) || !c.description)) return fail(400, "Bad Request: BOT_COMMAND_INVALID");
					menus.push({ scope: args.scope, commands: args.commands });
					return reply(true);
				case "deleteMyCommands":
					menus.push({ scope: args.scope });
					return reply(true);
				case "answerCallbackQuery":
					answered.push(String(args.callback_query_id));
					return reply(true);
				case "editMessageReplyMarkup":
					unbuttoned.push(Number(args.message_id));
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
		uploads,
		deleted,
		refuseDelete: () => {
			refuseDelete = true;
		},
		refuseUpload: (method) => refusing.add(method),
		dropUploads: (n) => {
			dropping = n;
		},
		menus,
		answered,
		unbuttoned,
		tap: (from, chat, message, data) => {
			const update_id = next++;
			updates.push({ update_id, callback_query: { id: `q${update_id}`, from, data, message: { message_id: message, date: 0, chat } } });
			for (const w of waiters) w();
			waiters.clear();
			return update_id;
		},
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
