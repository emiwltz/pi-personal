// Where things live. The private area holds secrets and machine state; it is created with mode 0700.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV, MAC_FOLDER, SLUG } from "./name.ts";

/** The root of the private area: `$PI_PERSONAL_HOME`, or the platform's per-user state directory. */
export function home(env: NodeJS.ProcessEnv = process.env): string {
	const set = env[`${ENV}_HOME`];
	if (set) return path.resolve(set);
	if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", MAC_FOLDER);
	const state = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(state, SLUG);
}

/** Write a file whole or not at all: written beside it, then renamed, so a reader never sees half of it. */
export function writeWhole(file: string, text: string, mode?: number): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
	fs.renameSync(tmp, file);
}

/** A path with its links followed, or as written when it does not exist: on macOS /tmp is /private/tmp, so paths are
 * compared real. */
export const realOr = (p: string): string => {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
};

/** The parts of `file`'s path below `dir`, both compared real, or undefined when it is not below it. */
export function below(dir: string, file: string): string[] | undefined {
	const rel = path.relative(realOr(dir), realOr(file));
	return rel && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== ".." ? rel.split(path.sep) : undefined;
}

/** A path as a person writes it: ~/… for what is under their home. */
export const tilde = (p: string) => (process.env.HOME && p.startsWith(`${process.env.HOME}/`) ? `~${p.slice(process.env.HOME.length)}` : p);
/** How long ago a time was, in words read at a glance: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: string, now = Date.now()): string {
	const min = Math.round((now - Date.parse(at)) / 60_000);
	if (!(min >= 1)) return "just now";
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** The default parent of agents' visible folders, proposed by `init`. */
export function defaultFolderParent(): string {
	return path.join(os.homedir(), SLUG);
}

export interface AgentPaths {
	dir: string; // the agent's private area
	record: string; // agent.json: which visible folder belongs to this agent
	port: string;
	sessions: string; // pi's conversation logs
	session: string; // the id of the agent's own session among them: the one it resumes
	secrets: string;
	channels: string; // per-channel state
	extensions: string; // in-agent extensions' own state (by convention, each in a subfolder of its name)
	log: string; // the keeper's plain-text log for this agent
	stopped: string; // present when the user stopped the agent on purpose (written by stop before it stops pi)
	wasStopped: string; // start after a stop: the conversation is not resumed (used up by the bridge)
	lastError: string; // last-error.json: the last error the bridge saw, read by status
}

export const agentPaths = (name: string): AgentPaths => filesIn(path.join(home(), "agents", name));

/** The files of an agent's private area `dir` (the bridge knows only that folder: its port's parent). */
export function filesIn(dir: string): AgentPaths {
	return {
		dir,
		record: path.join(dir, "agent.json"),
		port: path.join(dir, "port"),
		sessions: path.join(dir, "sessions"),
		session: path.join(dir, "session"),
		secrets: path.join(dir, "secrets"),
		channels: path.join(dir, "channels"),
		extensions: path.join(dir, "extensions"),
		log: path.join(dir, "log.txt"),
		stopped: path.join(dir, "stopped"),
		wasStopped: path.join(dir, "was-stopped"),
		lastError: path.join(dir, "last-error.json"),
	};
}

/** pi's configuration directory, shared by all agents so that one sign-in serves them all. */
export function piDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(home(env), "pi");
}

/** Create a private directory (and its parents) readable by the user only. */
export function privateDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	return dir;
}

/** The repository or installation root (the folder holding core/ and channels/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // decoded: spaces and accents work

/** This Pi-Personal's version, from its package.json. */
export const version = (): string => JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
/** The GitHub repository it comes from and updates from ("owner/name"), from its package.json. */
export const repository = (): string =>
	/github\.com\/([^/]+\/[^/.]+)/.exec(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).repository?.url ?? "")?.[1] ?? "emiwltz/pi-personal";

/** Agent names become terminal names in Herdr Core, `pi-personal-<name>` and `pi-personal-<name>_<channel>`, which Herdr keeps
 * to 32 characters: with channel names of up to 9, an agent name gets what is left. */
export const NAME_MAX = 32 - `${SLUG}-_`.length - 9;
export const NAME_RE = new RegExp(`^[a-z][a-z0-9-]{0,${NAME_MAX - 1}}$`);
