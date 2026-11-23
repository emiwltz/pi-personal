# Contributing to Pi-Personal

How the project is kept: what it must stay, how the code is written, how it is tested, and how a version is made. For people and for the coding agents that work on it. [A map of the code](docs/code.md) says where everything is.

Before a change to the core, open an issue and say what you want to do: most abilities belong in a channel or a pi extension, which need no change to the core at all.

## What Pi-Personal must stay

These are what the project is. A change that breaks one is not taken, however useful.

1. **The core is three parts and does nothing else**: pi (the agent), Herdr Core (where it lives), and the port (how anything reaches it). It does not change to add an ability: what a messaging service does its own way belongs to its channel; what an agent could do belongs to pi's extensions. What every channel and extension needs from the core itself joins it only by the owner's decision, and the core then carries it and decides nothing with it (0.5: an interrupt, a file out, a question with its answer, a message told without waking; [decision 0004](docs/decisions/0004-what-the-core-carries.md)).
2. **Minimal, stable, proven.** When in doubt, leave it out. A feature only some people want is an extension. Something joins the core only after it has proven itself as an extension (pi's rule: "we wait until something has proven itself"), or, as in rule 1, by the owner's decision when extensions cannot do it without the core.
3. **Borrow, don't rebuild.** The agent loop, tools, sessions, models and sign-ins are pi's; terminals, liveness and taking over are Herdr Core's. Pi-Personal writes only what is missing between them.
4. **Transparent.** Everything is a plain file a person can open: queues, logs, state, settings. Every action reports what it observed, never what it assumed.
5. **Safe to experiment.** A broken extension or channel never takes the core down or leaves the agent unreachable.
6. **The person owns everything.** Their machine, models, files and conversations. No telemetry, no account, nothing sent anywhere they did not ask for.
7. **Small is a feature.** A core one person can read in a day. One dependency: pi, pinned.

## Every screen

What a person sees in a terminal (`pp`, `pp setup`, `pp status`, `pp doctor`, errors) follows six rules. `test/screen.test.ts` and `test/home.test.ts` check what can be checked.

1. **Three things per screen**: where you are, what just happened, what you can do now.
2. **Never a silent wait.** Anything longer than a second shows that it is working (the waits are drawn by `core/screen.ts`).
3. **An error gives its cause and the next step**, and nothing wrong is kept (a refused token is not stored).
4. **What is announced is checked.** "Connected" means a real call answered; "alive" means the agent replied.
5. **Beauty costs nothing.** It never delays (a key skips the opening), it turns off (`NO_COLOR`, `PI_PERSONAL_MOTION=never`, outside a terminal), and the same words say the same thing without colour.
6. **One piece draws.** Colours, the mark, the animations and the waits live in `core/screen.ts`; the other files ask it.

The words: plain, short, in English, for someone who has never used a terminal agent. A term the person may not know is explained the first time.

## Code

- **TypeScript run directly by Node.js** (22.19 or newer strips the types): no build step, and no type checker. Run the tests: they are the only check.
- **No dependency** besides pi. What pi brings (its TUI, its AI library) may be used through pi.
- **Nothing that writes an event may kill pi or the runner.** In pi and the runner, events go through `port.emitter`, which keeps them in memory while the disk refuses them; elsewhere a failed write is logged, never thrown.
- **One source of truth for each fact.** Who a reply is for is read from pi's session, never kept beside it; what the keeper knows is in `keeper.json`; a stop on purpose is the `stopped` file. Each file's name is written once (an agent's files in `core/paths.ts`).
- **The core knows no channel by name.** Channel-specific behaviour lives in `channels/<name>/`; channels import nothing from `core/` (they are examples of what anyone can write, in any language).
- **One copy of each thing.** A helper used twice lives in one place; two different things never share a name.
- **The product's name** is written once, in `core/name.ts`.
- **Comments say why.** Each file starts with what it is for; a line that is not obvious says what it protects against.
- **Everything in English**: code, comments, docs, messages.

## Tests

```sh
npm ci
npm test                                  # every test/*.test.ts, one file at a time (about 25 minutes)
node --test test/messages.test.ts         # one file
node --test test/fresh-install.manual.ts  # before a release: a fresh machine, simulated
```

The tests need Herdr Core's `hc` on your `PATH`. Nothing touches your own agents or your Herdr Core: `test/helpers.ts` (`setup`) starts an isolated Herdr Core for each file (its own session name and runtime folders; its identity is checked against your default core before it is stopped), a private area of its own, the real pi, and a fake model.

How to test:

- **One good test for each behaviour** a person or a channel relies on, and one for each defect found, so that it never comes back.
- **End to end first.** The interesting failures live at the seams: a real pi, a real (isolated) Herdr Core, killed in the middle of its work, its disk filled. Mocks only where the real thing cannot run (a model, Telegram).
- **Both systems**: Linux and macOS.
- **Say what was verified and how, and what was not.** Nothing is reported as working because it should.

The fake model answers `echo: <text>` (the text without the header the bridge writes above a port message, a note's first line included; what was sent is kept beside it), and obeys a few words in the last user message: `tool: <command>` (call bash), `call: <tool> <json>` (call any tool), `calls: [[<tool>, <args>], ...]` (several calls in one step), `silent-call: <tool> <json>` (the same, then an empty answer), `long:<n>` (a long answer), `fail: <why>` (a refusal), `denied:` (a wrong key), `silent:` (an empty answer), `flaky:` (refused once, then answered), `interim-fail:` (a sentence and a tool call, then a refusal), `then-refuse:` (a refusal after a tool's result). It records the model, the reasoning effort and the names of the tools of each request, and the role of its first message. `ASKER` in `test/helpers.ts` is an in-agent extension that asks its owner a question from a tool. `test/fake-telegram.ts` is a fake Bot API (uploads and deleted messages included, a refused or cut one on request), `test/fake-channel.ts` a channel that sends files from a folder, records the replies, and pilots the agent as a channel does (`PI_PERSONAL_REMOTE`, with words and standard input given in a file of its state folder).

| File | What it checks |
|---|---|
| `port.test.ts` | the file protocol on its own |
| `first-message.test.ts`, `messages.test.ts` | a first agent; isolation, one message per run, duplicates |
| `conversations.test.ts`, `errors.test.ts`, `key-reload.test.ts` | replies never mixed; errors reach the sender; a new key without a restart |
| `files.test.ts` | files out: `attach_file`, the `file` event, a file as the only reply, a file written and sent in the same step, what is refused and why, nobody to send to from the terminal, `pp send --wait` |
| `interrupt.test.ts` | interrupting from the port: during a long tool call, while idle, while a run starts; a control message that comes too late, twice, or unknown; what an extension adds; `pp interrupt`'s refusal and withdrawal (also on Ctrl+C); a crash while it is done; never in the session nor sent to the model |
| `notes.test.ts` | telling without waking (`wake: false`): said at once during a run, stored after it without a request to the model, read with the next message, whose reply goes to its own sender; `note`, `note: ""`; a new agent (stored after its first answer); a crash in between (said again, stored once), a copy left behind, the same id twice; attachments; `pp send --no-wake` |
| `questions.test.ts` | an extension's question for the owner (`pi-personal.ask`): answered from the port (an option's text or number), in the terminal, by the time limit, an interrupt or the end of its run; a wrong option, a closed question; `pp answer` and `pp send --wait`; an asker outside Pi-Personal; another extension's dialog, told to the messages it holds up; `pp chat` showing a question about its messages |
| `sender.test.ts` | who wrote: the header the agent reads (the owner, a guest, a program, when), names that try to pass for it; what an in-agent extension is given and told (`pi-personal.who`); Herdr Core's notes |
| `crash-and-terminal.test.ts`, `keeper.test.ts`, `lifecycle.test.ts` | crashes, the keeper's rules, safe mode, stop and start |
| `safe-mode.test.ts` | safe mode keeps what works: a healthy extension stays on (and is told who a run is for) beside a broken one, one turned off in pi's settings stays off, a set that fails for real falls back to the bridge alone without `failed`, what fails named again on the bridge alone, an extension removed meanwhile, leaving safe mode by itself, the tools turned off coming back |
| `durability.test.ts`, `edge-cases.test.ts`, `regressions.test.ts` | full disks, bursts, races, and every defect found so far |
| `settings.test.ts`, `cli.test.ts`, `install.test.ts` | settings, the command line, install and uninstall |
| `screen.test.ts`, `home.test.ts` | the drawing (as text: colours, contrast, the mark, the opening); `pp`'s screen and its menu, opening the agent and coming back, its status page |
| `setup.test.ts`, `upkeep.test.ts` | `pp setup` answered on standard input, and its menu at a terminal; doctor, the help, coming back after a restart of the machine |
| `session.test.ts` | the agent's own session: pinned by its id, never taken by another pi; an agent made by 0.4 keeps its conversation; `pp new` (during a run, with pi down, while stopped), `pp model` during a run or with a stop meanwhile, `pp thinking` |
| `remote.test.ts` | piloting from a channel (`pp remote`): every command, what is refused, words after `--` taken as they are, a key stored without a terminal and used at once, a key or a secret found in no other file, the kit's door |
| `agent-self.test.ts` | the agent's first instructions, its manual (`pp --skill`), a restart and a change of model it runs on itself |
| `telegram.test.ts` | the Telegram channel, its owner's commands included (the menu, the buttons and their taps, and what a guest, a forward or an owner off the guest list gets), and the agent's questions shown to the owner |
| `contracts.test.ts` | the behaviours of pi and Herdr Core the core relies on; run it first after updating either |
| `fresh-install.manual.ts` | not in `npm test`: an empty home, the real installer in a real terminal, `pp setup` answered key by key; it downloads Node.js and Herdr Core |

## Following pi and Herdr Core

Pi-Personal follows pi: a new version is adopted once the tests pass with it.

1. Change the version of `@earendil-works/pi-coding-agent` in `package.json`, then `npm install`.
2. `node --test test/contracts.test.ts` first: it says which of pi's behaviours changed.
3. The whole suite, on Linux and macOS.

A new Herdr Core is checked the same way (`contracts.test.ts`, then everything), and the versions tested are listed in the README.

## Making a version

1. Everything in the change list is done and tested; `npm test` passes on Linux and on macOS.
2. `test/fresh-install.manual.ts` passes on both.
3. A person goes through the whole path by hand, on a real machine: install, the guide, the first meeting, `pp`, a channel, a restart.
4. The version in `package.json` (and the root entries of `package-lock.json`), and "Project status" in the README (what was tested, with which versions).
5. The maintainer publishes it. `pp update` brings it to everyone.
