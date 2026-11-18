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

/** The default parent of agents' visible folders, proposed by `init`. */
export function defaultFolderParent(): string {
	return path.join(os.homedir(), SLUG);
}

export interface AgentPaths {
	dir: string; // the agent's private area
	record: string; // agent.json: which visible folder belongs to this agent
	port: string;
	sessions: string; // pi's conversation logs
	secrets: string;
	channels: string; // per-channel state
	log: string; // the keeper's plain-text log for this agent
	stopped: string; // present when the user stopped the agent on purpose
}

export function agentPaths(name: string, env: NodeJS.ProcessEnv = process.env): AgentPaths {
	const dir = path.join(home(env), "agents", name);
	return {
		dir,
		record: path.join(dir, "agent.json"),
		port: path.join(dir, "port"),
		sessions: path.join(dir, "sessions"),
		secrets: path.join(dir, "secrets"),
		channels: path.join(dir, "channels"),
		log: path.join(dir, "log.txt"),
		stopped: path.join(dir, "stopped"),
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

/** Agent names become terminal names in Herdr Core, `pi-personal-<name>` and `pi-personal-<name>_<channel>`, which Herdr keeps
 * to 32 characters: with channel names of up to 9, an agent name gets what is left. */
export const NAME_MAX = 32 - `${SLUG}-_`.length - 9;
export const NAME_RE = new RegExp(`^[a-z][a-z0-9-]{0,${NAME_MAX - 1}}$`);
