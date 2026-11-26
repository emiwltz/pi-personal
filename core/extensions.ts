// An agent's extensions, as pi itself sees them: the extensions in its folder (.pi/extensions/), the pi packages it or
// every agent has, and the skills. Pi-Personal keeps no list of its own: pi's resolver says what there is and what is
// on, and turning one off or on writes what `pi config` writes, with pi's own settings writer. Adding, removing and
// updating run pi's own package commands. The home screen (`pp`) and `pp ext` share these functions.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentRecord, preparePi } from "./agents.ts";
import { piDir } from "./paths.ts";
import { piCli } from "./runner.ts";

type Kind = "extensions" | "skills";
/** One thing pi loads, as its resolver reports it. */
interface Resource {
	path: string;
	enabled: boolean;
	type: Kind;
	metadata: { source: string; scope: "user" | "project"; origin: "top-level" | "package"; baseDir?: string; packageRoot?: string };
}
export interface Extension {
	name: string;
	kind: "extension" | "package" | "skill";
	every: boolean; // for every agent of this machine (Pi-Personal's pi settings); else this agent's folder only
	on: boolean;
	source?: string; // a package's, as pi's settings name it
	version?: string;
	description?: string;
	path: string;
	resources: Resource[];
}

async function pi(agent: AgentRecord) {
	preparePi(); // Pi-Personal's pi settings, which trust the agents' folders
	const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const settings = SettingsManager.create(agent.folder, piDir());
	return { settings, packages: new DefaultPackageManager({ cwd: agent.folder, agentDir: piDir(), settingsManager: settings }) };
}

const readJson = (file: string): Record<string, any> | undefined => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};
/** A skill's one-line description, from the front matter of its SKILL.md. */
const said = (file: string) => {
	try {
		return /^description:\s*(.+)$/m.exec(fs.readFileSync(file, "utf8").split(/^---\s*$/m)[1] ?? "")?.[1].trim();
	} catch {
		return undefined;
	}
};

/** Everything pi would load for this agent, one row per extension, package or skill, packages first. */
export async function list(agent: AgentRecord): Promise<Extension[]> {
	const { packages } = await pi(agent);
	const resolved = await packages.resolve(async () => "skip"); // nothing missing is installed by looking
	const rows = new Map<string, Extension>();
	for (const type of ["extensions", "skills"] as const)
		for (const r of resolved[type] as Omit<Resource, "type">[]) {
			const m = r.metadata;
			const key = m.origin === "package" ? `${m.scope}:${m.source}` : r.path;
			let x = rows.get(key);
			if (!x) {
				if (m.origin === "package") {
					const p = readJson(path.join(m.packageRoot ?? "", "package.json"));
					x = { name: p?.name ?? m.source, kind: "package", source: m.source, version: p?.version, description: p?.description, path: m.packageRoot ?? r.path, every: m.scope === "user", on: false, resources: [] };
				} else {
					// .pi/extensions/<name>/index.ts or .pi/extensions/<name>.ts; .pi/skills/<name>/SKILL.md
					const here = path.relative(m.baseDir ?? path.dirname(r.path), r.path).split(path.sep);
					const name = (type === "skills" || here.length > 2 ? here.at(-2) : here.at(-1)?.replace(/\.[jt]s$/, "")) ?? r.path;
					x = { name, kind: type === "skills" ? "skill" : "extension", description: type === "skills" ? said(r.path) : undefined, path: r.path, every: m.scope === "user", on: false, resources: [] };
				}
				rows.set(key, x);
			}
			x.resources.push({ ...r, type });
			x.on ||= r.enabled;
		}
	const order = { package: 0, extension: 1, skill: 2 };
	return [...rows.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/**
 * Turn it on or off where it is set: this agent's folder, or every agent. As `pi config` does: "-<path>" in the list of
 * its kind (in a package's filter, for a package's), which pi reads as "not this one", or "+<path>", "this one too".
 */
export async function setOn(agent: AgentRecord, x: Extension, on: boolean): Promise<void> {
	const { settings } = await pi(agent);
	const flip = (entries: string[] = [], pattern: string) => [...entries.filter((e) => e.replace(/^[!+-]/, "") !== pattern), `${on ? "+" : "-"}${pattern}`];
	for (const r of x.resources) {
		const project = r.metadata.scope === "project";
		const current = project ? settings.getProjectSettings() : settings.getGlobalSettings();
		if (r.metadata.origin === "top-level") {
			const entries = flip(current[r.type], path.relative(r.metadata.baseDir ?? path.dirname(r.path), r.path));
			if (r.type === "extensions") project ? settings.setProjectExtensionPaths(entries) : settings.setExtensionPaths(entries);
			else project ? settings.setProjectSkillPaths(entries) : settings.setSkillPaths(entries);
			continue;
		}
		const all = [...(current.packages ?? [])];
		const i = all.findIndex((p) => (typeof p === "string" ? p : p.source) === r.metadata.source);
		if (i < 0) continue;
		const pkg = typeof all[i] === "string" ? { source: all[i] } : { ...all[i] };
		const entries = flip(pkg[r.type], path.relative(r.metadata.baseDir ?? path.dirname(r.path), r.path));
		pkg[r.type] = entries;
		all[i] = pkg;
		project ? settings.setProjectPackages(all) : settings.setPackages(all);
	}
	await settings.flush();
}

/** pi's own package command (install, remove, update), in the agent's folder, with Pi-Personal's pi settings. Quiet:
 * what it says is kept, for a screen to show; otherwise it goes to this terminal. */
export function run(agent: AgentRecord, args: string[], quiet = false): Promise<{ ok: boolean; said: string }> {
	preparePi();
	return new Promise((done) => {
		const child = spawn(process.execPath, [piCli(), ...args], { cwd: agent.folder, env: { ...process.env, PI_CODING_AGENT_DIR: piDir() }, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit" });
		let out = "";
		child.stdout?.on("data", (b) => (out += b));
		child.stderr?.on("data", (b) => (out += b));
		child.on("error", (err) => done({ ok: false, said: err.message }));
		child.on("close", (code) => done({ ok: code === 0, said: out.replace(/\x1b\[[0-9;]*m/g, "").trim() }));
	});
}
/** For this agent alone (pi's "-l": its folder's settings), or for every agent. */
export const add = (agent: AgentRecord, source: string, every: boolean, quiet = false) => run(agent, ["install", ...(every ? [] : ["-l"]), source], quiet);
/** How pi's commands name a package: its source, or for a folder its whole path (the settings keep it relative to them). */
const named = (x: Extension) => (!x.source || /^[~./]/.test(x.source) ? x.path : x.source);
export const remove = (agent: AgentRecord, x: Extension, quiet = false) => run(agent, ["remove", ...(x.every ? [] : ["-l"]), named(x)], quiet);
/** One package, or all of them; never pi itself (`pi update` alone would update pi, which Pi-Personal pins). */
export const update = (agent: AgentRecord, x: Extension | undefined, quiet = false) => run(agent, ["update", x ? named(x) : "--extensions"], quiet);

/** What can be installed: npm packages marked "pi-package", the ones pi's package gallery lists. */
export async function search(words: string): Promise<{ name: string; description: string; version: string }[]> {
	const r = await fetch(`https://registry.npmjs.org/-/v1/search?size=12&text=${encodeURIComponent(`keywords:pi-package ${words}`)}`, { signal: AbortSignal.timeout(10_000) });
	if (!r.ok) throw new Error(`the npm registry answered ${r.status}`);
	const body = (await r.json()) as { objects: { package: { name: string; description?: string; version: string } }[] };
	return body.objects.map(({ package: p }) => ({ name: p.name, description: p.description ?? "", version: p.version }));
}

/** A source pi installs as it is (npm:, git:, a URL, a path); anything else is words to search for. */
export const isSource = (s: string) => /^(npm:|git:|https?:\/\/|[~./])/.test(s);
