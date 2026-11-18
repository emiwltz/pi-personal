# A map of the code

Pi-Personal is TypeScript run directly by Node.js 22 (type stripping: no build step, only syntax Node can erase), with one dependency, pi, pinned in `package.json`. This page says what each file does, and follows a message through them. [concepts.md](concepts.md) explains the ideas; [port.md](port.md) is the protocol.

## The three parts, file by file

| File | Part | What it does |
|---|---|---|
| `core/bridge.ts` | pi | The only piece inside pi: a pi extension. It hands port messages to pi, one per run; reads from pi's session who each reply is for (`openWork`); turns replies, ends of runs, status and typed input into events. |
| `core/runner.ts` | pi, Herdr | Runs in each Pi-Personal terminal of Herdr Core and keeps one program alive there: an agent's pi, or one of its channels. Restarts with backoff, gives up after repeated failures and retries every hour, safe mode (`dryStart`, `startFailure`), the startup watchdog, the lock (`runner.lock`), and `keeper.json`, what it knows. |
| `core/port.ts` | port | The file protocol: validate and submit a message, list and read the inbox, take or reject a file, append events (`append`, and `emitter`, which never throws), read events from a byte offset (`events`, `follow`). |
| `core/control.ts` | Herdr | Start, stop, restart and inspect agents and channels in Herdr Core: `up` (idempotent), `start` (watches until pi is ready), `stop`, `status` (reads `keeper.json`, `last-error.json` and Herdr Core). Finds its terminals by labels, never by guessing. |
| `core/herdr.ts` | Herdr | Finding, installing (Herdr's own installer), updating and starting Herdr Core, and the few `hc` verbs Pi-Personal uses (`run`, `get`, `ls`, `kill`, `rm`), and whether a Herdr Core is running without starting one. |
| `core/agents.ts` | — | An agent on disk: its name, its visible folder (`AGENTS.md`, `pi-personal.json`), its record in the private area; reading and editing settings; the labels and names of its terminals. |
| `core/cli.ts` | — | The `pp` command: argument parsing (an agent's name can be left out when there is one), human and JSON output, `send --wait`, `stop --all`, `update`, and the dispatch to the modules above. |
| `docs/for-agents.md` | — | The agent's own manual (`pp --skill`): the rules (its owner only, no secret in a conversation, say before changing) and where each setting lives. A new agent's `AGENTS.md` (in `core/agents.ts`) points to it, and has the "First meeting" and "About my person" sections. |
| `core/home.ts` | — | `pp` alone: in a terminal, the home screen (the agent and how it is, a card each when there are several; Enter starts it if needed and opens its screen with `hc attach`, ctrl+\\ comes back); in a script, the same in plain text with the next thing to do. Looking never starts Herdr Core. |
| `core/welcome.ts` | — | `pp setup`, the guide in five steps, each drawn with its line in the margin (`ask.margin`): the opening; Herdr Core found, installed or started; a model with pi's own list and sign-in (`pi auth login`), pi's own screen for anything else; the agent, the rule of the game, its start and its hello (the waits drawn as a star being lit, or a light passing over the words); channels; the login service. |
| `core/screen.ts` | — | How it looks, in one place: the palettes for a dark terminal, a light one, and one whose background is unknown (it reads on both), the four levels of text, the mark (a square « Pp »), the opening (a burst of stars that falls back into the mark), the star of an agent that is alive, the waits (a star being lit, a light passing over words). Pure functions that return lines of text; `sense` asks the terminal its background once, `look` decides colour and motion (none outside a terminal), `play` plays a drawing in place. `ask.ts` takes its colours from here. |
| `core/providers.ts` | pi | What pi stored: the providers pi lists models for, the model pi keeps as its default. Opens pi's own screen (`/login`, `/model`), and passes `pp login <provider>` to `pi auth login`. |
| `core/ask.ts` | — | Questions in the terminal, without a dependency: a list that narrows as you type, yes or no, text, a secret; plain lines when there is no terminal (tests). |
| `core/setup.ts` | — | `maintain`: `doctor` by topic, the optional login service (systemd user timer or launchd agent), `uninstall`; and whether the service may start Herdr Core after a restart of the machine (`bootAllowed`, once per boot: `bootStartDue`). |
| `core/paths.ts`, `core/name.ts` | — | Where things live, and the product's names (the core's code takes them from `name.ts`). |
| `channels/local/chat.ts` | channel | `pp chat`: a channel of a few dozen lines, written on the port alone. The worked example of [write-a-channel.md](write-a-channel.md). |
| `channels/telegram/` | channel | The Telegram channel, its own `setup` (run by `pp setup`), and its Markdown-to-HTML formatter. It imports nothing from `core/`. See [its README](../channels/telegram/README.md). |
| `install.sh` | — | The installer (`curl … \| sh`, or from a copy of the source): downloads Pi-Personal, and an official Node.js if the machine has none recent enough; installs pi; writes the `pp` command; offers to fix the `PATH`; runs `pp setup`. |

## A message, from a channel to its answer

1. **A channel submits it.** It writes a file whose name starts with a dot (`inbox/.<id>.tmp`), then links it to `inbox/<id>.json` (`port.submit` does this for the command line). The link is the receipt.
2. **The bridge notices it** (`fs.watch` on the inbox, coalesced, with a one-second `tick` as a fallback) and calls `deliver`. If pi is idle, `ready` lists the inbox (each file read once, cached by its modification time; duplicates and broken files settled on the way) and `hand` gives the oldest message to pi as a custom message, `customType: "pi-personal.message"`, its id in `details`.
3. **pi places it** in the session: `message_start` marks it unconfirmed; once it is in the session file on disk, `confirm` fsyncs the file, moves the message to `taken/` and emits `taken`.
4. **pi works.** At each assistant message, `message_end` reads the open run from the session (`openWork`: the message placed after the last `pi-personal.settled` or `pi-personal.stopped` mark) and emits `message` with that message in `refs`.
5. **The run ends.** `agent_settled` calls `close`: it emits `settled` for the message (with `error` when it got no full answer), then writes the `pi-personal.settled` mark into the session. The bridge then delivers the next message.
6. **The channel reads** `events.jsonl` from its saved byte offset and routes each reply by the prefix of its `conversation`.

If pi dies at any point, the message is either still in the inbox (handed again) or in the session (recognised by its id at the next start). At the next start, `session_start` reads the open run: work cut off by a crash is resumed with one visible note; work stopped on purpose (`pp stop`, which writes `stopped`, read by the bridge's signal handler, or `was-stopped` at the next start) is closed and its sender told.

## Keeping it alive

- `pp start` → `control.start` → `control.up` launches the runner in a Herdr Core terminal (`hc run`, through `/usr/bin/env` so the runner gets the caller's `PATH` and private area), then watches the events for `started` (ready), `safe_mode` or `failed`.
- The runner (`runner.runForever`) takes `runner.lock`, then loops: start pi with the bridge, watch it get ready, and when it ends decide why (a quit, a crash, an extension that breaks loading, pi itself unable to start) and what to do (start again at once, after a backoff, in safe mode, or give up and retry in an hour). It writes what it knows to `keeper.json`.
- `pp status` reads `keeper.json`, `last-error.json` (written by the bridge) and Herdr Core's view of the terminal: never the event history.

## Conventions and tests

How the code is written and tested, and how a version is made: [CONTRIBUTING.md](../CONTRIBUTING.md).
