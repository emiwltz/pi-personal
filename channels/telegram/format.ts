// Telegram formatting: the agent writes Markdown; Telegram shows HTML (a small subset). This is the Telegram
// channel's own business: the core and the port carry plain text, whatever the messaging service.
//
// Supported: **bold**, *italic* and _italic_ (around words only), ~~strikethrough~~, `code`, ```code blocks```,
// [links](url), "# headings" (shown in bold) and "- item" lists (shown with a bullet). Everything else is shown as
// written: file paths, globs, URLs and Python names keep their * and _. If Telegram still refuses a message, the
// channel sends it again as plain text (see telegram.ts), so a formatting mistake never loses a reply.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");
const URL_RE = /https?:\/\/(?:[^\s()<>]|\([^\s()<>]*\))+/; // one level of parentheses, as in Wikipedia's links

function inline(text: string): string {
	// Parts that must not be formatted are kept aside behind placeholders: code, links, bare URLs, paths.
	const kept: string[] = [];
	const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
	const restore = (s: string) => s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]);
	let s = text.replace(/\u0000/g, "");
	s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<code>${esc(code)}</code>`));
	s = s.replace(new RegExp(`\\[([^\\]\\n]+)\\]\\((${URL_RE.source})\\)`, "g"), (_m, label: string, url: string) =>
		keep(`<a href="${attr(url)}">${restore(esc(label))}</a>`),
	);
	s = s.replace(new RegExp(URL_RE.source, "g"), (url) => keep(esc(url)));
	s = s.replace(/[\w.~-]*\/[\w.*~/-]*|\b\w*__\w+__\w*\b/g, (path) => (/[*_]/.test(path) ? keep(esc(path)) : path)); // src/*.ts, __init__
	s = esc(s);
	s = s.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
	s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• "); // Telegram has no lists: a bullet reads better than a dash
	s = s.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "<b>$1</b>");
	s = s.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "<s>$1</s>");
	// A single * or _ only opens after a space, a line start or an opening bracket or quote, and closes before one.
	s = s.replace(/(^|[\s(["'])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?=$|[\s.,;:!?)\]"'])/gm, "$1<i>$2</i>");
	s = s.replace(/(^|[\s(["'])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?=$|[\s.,;:!?)\]"'])/gm, "$1<i>$2</i>");
	return restore(s);
}

/** Markdown to Telegram HTML. A code block left open runs to the end of the piece. */
export function toHtml(markdown: string): string {
	const out: string[] = [];
	const fence = /^```([\w+#.-]*)[ \t]*\n([\s\S]*?)(?:^```[ \t]*$|(?![\s\S]))/gm;
	let last = 0;
	for (let m = fence.exec(markdown); m; m = fence.exec(markdown)) {
		if (m[0] === "") break;
		out.push(inline(markdown.slice(last, m.index)));
		const lang = m[1] ? ` class="language-${attr(m[1])}"` : "";
		out.push(`<pre><code${lang}>${esc(m[2].replace(/\n$/, ""))}</code></pre>`);
		last = m.index + m[0].length;
	}
	out.push(inline(markdown.slice(last)));
	return out.join("").replace(/\n{3,}/g, "\n\n");
}

/**
 * Keep code blocks whole across pieces of a long reply: a piece that ends inside a block closes it, and the next
 * piece opens it again with the same language.
 */
export function closeFences(pieces: string[]): string[] {
	let carry: string | null = null; // the language of a block that runs over into the next piece
	return pieces.map((piece) => {
		let text = carry !== null ? `\`\`\`${carry}\n${piece}` : piece;
		let open: string | null = null;
		for (const line of text.split("\n")) {
			const m = /^```([\w+#.-]*)\s*$/.exec(line);
			if (m) open = open === null ? m[1] : null;
		}
		if (open !== null) text = `${text}\n\`\`\``;
		carry = open;
		return text;
	});
}
