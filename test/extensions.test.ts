// pp ext: what pi loads for an agent (the extensions in its folder, its packages, its skills), turned off and on again as
// `pi config` does, and packages added and removed with pi's own commands. The home screen runs these same commands.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { type Env, setup } from "./helpers.ts";

let t: Env;
const folder = () => path.join(t.dir, "agents", "main");
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};
// Only what this test made: pi also lists the skills of the person's own ~/.agents/skills, for every agent.
const ours = ["broken", "note", "demo-pkg"];
const listed = async () =>
	JSON.parse((await t.cli("ext", "main", "--json")).stdout)
		.filter((x: { name: string }) => ours.includes(x.name))
		.map((x: { name: string; kind: string; on: boolean }) => `${x.kind} ${x.name} ${x.on ? "on" : "off"}`);

before(async () => {
	t = await setup("ext");
	assert.equal((await t.cli("init", "main", folder(), "--model", "fake/echo-1")).code, 0);
	write(path.join(folder(), ".pi", "extensions", "broken", "index.ts"), 'throw new Error("broken on purpose");\n');
	write(path.join(folder(), ".pi", "skills", "note", "SKILL.md"), "---\nname: note\ndescription: Take a note\n---\nWrite it down.\n");
});
after(async () => t?.close());

test("an extension turned off is not loaded by pi, and on again it is; an unknown name is refused", async () => {
	assert.deepEqual(await listed(), ["extension broken on", "skill note on"]);
	assert.equal((await t.cli("ext", "check", "main")).code, 1, "the broken extension keeps pi from starting");
	const off = await t.cli("ext", "off", "main", "broken");
	assert.equal(off.code, 0, off.stderr);
	assert.match(off.stdout, /^broken is off for main; main takes it at its next start \(pp restart main\)$/m);
	assert.deepEqual(await listed(), ["extension broken off", "skill note on"]);
	assert.equal((await t.cli("ext", "check", "main")).code, 0, "pi starts without it");
	assert.equal((await t.cli("ext", "on", "main", "broken")).code, 0);
	assert.equal((await t.cli("ext", "check", "main")).code, 1, "on again: pi loads it");
	const none = await t.cli("ext", "off", "main", "nowhere");
	assert.equal(none.code, 2);
	assert.match(none.stderr, /main has no extension "nowhere"/);
});

test("a package is added with pi's own command, listed with its name and version, turned off, then removed", async () => {
	const pkg = path.join(t.dir, "demo-pkg");
	write(path.join(pkg, "package.json"), JSON.stringify({ name: "demo-pkg", version: "1.2.0", keywords: ["pi-package"], pi: { extensions: ["./extensions"] } }));
	write(path.join(pkg, "extensions", "demo.ts"), "export default function () {}\n");
	const added = await t.cli("ext", "add", "main", pkg);
	assert.equal(added.code, 0, added.stdout + added.stderr);
	assert.match(added.stdout, /^added .*demo-pkg for main; main takes it at its next start/m);
	const row = JSON.parse((await t.cli("ext", "main", "--json")).stdout).find((x: { name: string }) => x.name === "demo-pkg");
	assert.deepEqual({ kind: row.kind, version: row.version, every: row.every, on: row.on }, { kind: "package", version: "1.2.0", every: false, on: true });
	assert.equal((await t.cli("ext", "off", "main", "demo-pkg")).code, 0);
	assert.ok((await listed()).includes("package demo-pkg off"));
	assert.match((await t.cli("ext", "rm", "main", "note")).stderr, /note is not a package but a skill/);
	const removed = await t.cli("ext", "rm", "main", "demo-pkg");
	assert.equal(removed.code, 0, removed.stdout + removed.stderr);
	assert.ok(!(await listed()).some((x: string) => x.includes("demo-pkg")));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder(), ".pi", "settings.json"), "utf8")).packages, []);
});
