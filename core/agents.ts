// An agent on disk: a visible folder (AGENTS.md, pi-personal.json, and pi's own .pi/) and a private area (port, sessions, secrets).
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMMAND, PRODUCT, SETTINGS_FILE, SLUG } from "./name.ts";
import { type AgentPaths, agentPaths, home, NAME_MAX, NAME_RE, piDir, privateDir, ROOT } from "./paths.ts";
import { ensurePort } from "./port.ts";

export const CHANNEL_RE = /^[a-z][a-z0-9-]{0,8}$/;
/** A channel that ships with Pi-personal: a folder channels/<name>/ holding <name>.ts. The core knows no channel by name. */
export const shipped = (name: string) => fs.existsSync(path.join(ROOT, "channels", name, `${name}.ts`));

export interface ChannelSettings {
	enabled?: boolean;
	command?: string[]; // for channels that do not ship with Pi-personal
	[key: string]: unknown;
}
export interface Settings {
	model?: string; // passed to pi as --model; otherwise pi's own default
	channels?: Record<string, ChannelSettings>;
	problems?: string[]; // set by readSettings: entries it had to ignore
}
/** What an agent is without reading its settings: enough to stop it, send to it, or show its status. */
export interface AgentRecord {
	name: string;
	folder: string;
	paths: AgentPaths;
}
export interface Agent extends AgentRecord {
	settings: Settings;
}

const DEFAULT_AGENTS_MD = (name: string) => `# ${name}

You are ${name}, a personal agent run by ${PRODUCT}.

- You are one continuous pi session. Your conversation continues across restarts.
- This folder is your home and your working directory. You can act on the whole machine with the user's permissions.
- You run in a terminal of Herdr Core. You can open other sessions or helper agents in their own terminals with \`hc\` (\`hc --skill\` explains how). A helper reports back to you with \`pp send ${name} "..." --conversation <where the answer should go>\`.
- People reach you from the terminal you run in, and through channels (a messaging app, a script). Write ordinary Markdown: each channel shows it the way its service can.
- Several people may write to you. A message from a channel can start with a line "From: ..." naming who wrote it (a name anyone can choose, and an id that is theirs). Answer the person who wrote. Do not pass one person's words, files or requests on to another unless the owner asked you to. Everything you know is shared by everyone who writes to you: keep that in mind.
- This file holds your instructions. The user edits it to change who you are and how you work.
`;

const RESERVED = ["add", "remove", "list", "check", "help"]; // words the command line uses after "channel" and "ext"

export function validateName(name: string): void {
	if (!NAME_RE.test(name) || RESERVED.includes(name))
		throw new Error(`"${name}" is not a valid agent name: use 1 to ${NAME_MAX} characters, a-z, 0-9 and "-", starting with a letter (not ${RESERVED.join(", ")})`);
}

export function readSettings(folder: string): Settings {
	const file = path.join(folder, SETTINGS_FILE);
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`);
	const s = raw as Settings;
	if (s.model !== undefined && (typeof s.model !== "string" || !s.model.trim())) throw new Error(`${file}: model must be a string, such as "anthropic/claude-haiku-5-5"`);
	// A broken channel entry never stops the agent: it is set aside and reported. So is a key this version does not know.
	const problems: string[] = [];
	for (const key of Object.keys(s))
		if (!["model", "channels"].includes(key))
			problems.push(`${file}: "${key}" is not a setting; it is ignored${key === "extensions" ? " (extensions go in .pi/extensions/, where pi finds them)" : ""}`);
	for (const [name, ch] of Object.entries(s.channels ?? {})) {
		let why = "";
		if (!CHANNEL_RE.test(name)) why = `"${name}" is not a valid channel name (1 to 9 characters, a-z, 0-9, "-")`;
		else if (typeof ch !== "object" || ch === null) why = `channels.${name} must be an object`;
		else if (ch.command !== undefined && !(Array.isArray(ch.command) && ch.command.length > 0 && ch.command.every((c) => typeof c === "string")))
			why = `channels.${name}.command must be a list of strings`;
		else if (ch.command === undefined && !shipped(name)) why = `channel "${name}" has no command and does not ship with ${PRODUCT}`;
		if (why) {
			problems.push(`${file}: ${why}; this channel is not started`);
			delete s.channels![name];
		}
	}
	if (problems.length) s.problems = problems;
	return s;
}

/**
 * Change the settings file. The change applies to the file as it is, so everything this version does not use, or
 * had to set aside (a channel entry it finds invalid, a channel's own settings), is kept as it was.
 */
export function editSettings(folder: string, change: (s: Settings) => void): void {
	readSettings(folder); // a file that cannot be read is refused, never overwritten
	const file = path.join(folder, SETTINGS_FILE);
	const raw: Settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	change(raw);
	writeSettings(folder, raw);
}

function writeSettings(folder: string, settings: Settings): void {
	const file = path.join(folder, SETTINGS_FILE);
	const { problems: _p, ...clean } = settings;
	settings = clean;
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
	fs.renameSync(tmp, file);
}

/** pi's shared configuration: Pi-personal trusts agents' own folders, so pi never stops at startup to ask. */
function ensurePiDir(): void {
	const dir = privateDir(piDir());
	const file = path.join(dir, "settings.json");
	let s: Record<string, unknown> = {};
	try {
		s = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {}
	if (s.defaultProjectTrust === undefined) {
		s.defaultProjectTrust = "always";
		fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
	}
}

/** May this agent live in this folder? Returns the folder, resolved; throws why not. Creates nothing. */
export function checkFolder(name: string, folder: string): string {
	validateName(name);
	const paths = agentPaths(name);
	folder = path.resolve(folder);
	if (fs.existsSync(paths.record)) {
		const existing = JSON.parse(fs.readFileSync(paths.record, "utf8")).folder;
		if (existing !== folder) throw new Error(`an agent named "${name}" already exists, with its folder at ${existing}`);
	}
	// The private area holds secrets and is deleted by "uninstall --purge": an agent's folder never lives inside it.
	const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
	if (inside(folder, home()) || inside(home(), folder))
		throw new Error(`${folder} overlaps ${PRODUCT}'s private area (${home()}): choose a folder outside it`);
	for (const other of list())
		if (other !== name && loadRecord(other).folder === folder) throw new Error(`${folder} is already the folder of the agent "${other}"`);
	return folder;
}

/**
 * Create an agent, or adopt an existing folder (copied from another machine, for example).
 * Writes AGENTS.md and the settings file only when they are missing.
 */
export function init(name: string, folder: string, opts: { model?: string } = {}): Agent {
	folder = checkFolder(name, folder);
	const paths = agentPaths(name);
	fs.mkdirSync(folder, { recursive: true });
	const agentsMd = path.join(folder, "AGENTS.md");
	if (!fs.existsSync(agentsMd)) fs.writeFileSync(agentsMd, DEFAULT_AGENTS_MD(name));
	if (!fs.existsSync(path.join(folder, SETTINGS_FILE))) {
		const s: Settings = {};
		if (opts.model) s.model = opts.model;
		writeSettings(folder, s);
	} else readSettings(folder); // fail early on a broken file
	privateDir(home());
	privateDir(path.dirname(paths.dir));
	privateDir(paths.dir);
	ensurePort(paths.port);
	fs.writeFileSync(paths.record, `${JSON.stringify({ folder }, null, 2)}\n`, { mode: 0o600 });
	ensurePiDir();
	return load(name);
}

/** The agent without its settings: a broken pi-personal.json never prevents stopping it, sending to it, or seeing it. */
export function loadRecord(name: string): AgentRecord {
	validateName(name);
	const paths = agentPaths(name);
	let folder: string;
	try {
		folder = JSON.parse(fs.readFileSync(paths.record, "utf8")).folder;
	} catch {
		throw new Error(`no agent named "${name}". Create it with: ${COMMAND} init ${name} --model <provider/model>`);
	}
	return { name, folder, paths };
}

export function load(name: string): Agent {
	const r = loadRecord(name);
	return { ...r, settings: readSettings(r.folder) };
}

export function list(): string[] {
	try {
		return fs
			.readdirSync(path.join(home(), "agents"))
			.filter((n) => NAME_RE.test(n) && fs.existsSync(agentPaths(n).record))
			.sort();
	} catch {
		return [];
	}
}

/** Channels this agent runs, with the command that runs each. */
export function channels(agent: Pick<Agent, "settings">, root: string): { name: string; command: string[]; settings: ChannelSettings }[] {
	return Object.entries(agent.settings.channels ?? {})
		.filter(([, ch]) => ch.enabled !== false)
		.map(([name, ch]) => ({
			name,
			settings: ch,
			command: ch.command ?? [process.execPath, path.join(root, "channels", name, `${name}.ts`)],
		}));
}

/** Which private area a terminal belongs to: two Pi-personal homes on one Herdr Core never touch each other's terminals. */
const homeTag = () => createHash("sha256").update(home()).digest("hex").slice(0, 12);

/** The labels every terminal of this agent carries (agent and channels alike). */
export const ownLabels = (name: string): Record<string, string> => ({ [`${SLUG}.agent`]: name, [`${SLUG}.home`]: homeTag() });

/** Labels that identify Pi-personal's terminals in Herdr Core. `where` is the label Herdr shows. */
export function labels(agent: AgentRecord, channel?: string): Record<string, string> {
	const where = `${SLUG} / ${agent.name}`;
	return channel
		? { ...ownLabels(agent.name), [`${SLUG}.channel`]: channel, where: `${where} / ${channel}` }
		: { ...ownLabels(agent.name), [`${SLUG}.role`]: "agent", where };
}

export const terminalName = (agent: string, channel?: string) => (channel ? `${SLUG}-${agent}_${channel}` : `${SLUG}-${agent}`); // hc allows a-z 0-9 - _
