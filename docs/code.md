# A map of the code

Pi-personal is TypeScript run directly by Node.js 22 (type stripping: no build step, only syntax Node can erase), with one dependency, pi, pinned in `package.json`. This page says what each file does, and follows a message through them. [concepts.md](concepts.md) explains the ideas; [port.md](port.md) is the protocol.

## The three parts, file by file

| File | Part | What it does |
|---|---|---|
| `core/bridge.ts` | pi | The only piece inside pi: a pi extension. It hands port messages to pi, one per run; reads from pi's session who each reply is for (`openWork`); turns replies, ends of runs, status and typed input into events. |
| `core/runner.ts` | pi, Herdr | Runs in each Pi-personal terminal of Herdr Core and keeps one program alive there: an agent's pi, or one of its channels. Restarts with backoff, gives up after repeated failures and retries every hour, safe mode (`dryStart`, `startFailure`), the startup watchdog, the lock (`runner.lock`), and `keeper.json`, what it knows. |
| `core/port.ts` | port | The file protocol: validate and submit a message, list and read the inbox, take or reject a file, append events (`append`, and `emitter`, which never throws), read events from a byte offset (`events`, `follow`). |
| `core/control.ts` | Herdr | Start, stop, restart and inspect agents and channels in Herdr Core: `up` (idempotent), `start` (watches until pi is ready), `stop`, `status` (reads `keeper.json`, `last-error.json` and Herdr Core). Finds its terminals by labels, never by guessing. |
| `core/herdr.ts` | Herdr | The few `hc` verbs Pi-personal uses (`run`, `get`, `ls`, `kill`, `rm`), and whether a Herdr Core is running without starting one. |
| `core/agents.ts` | — | An agent on disk: its name, its visible folder (`AGENTS.md`, `pi-personal.json`), its record in the private area; reading and editing settings; the labels and names of its terminals. |
| `core/cli.ts` | — | The `pi-personal` command: argument parsing, human and JSON output, `send --wait`, and the dispatch to the modules above. |
| `core/setup.ts` | — | `doctor`, the optional login service (systemd user timer or launchd agent), `uninstall`. |
| `core/paths.ts`, `core/name.ts` | — | Where things live, and the product's names (the core's code takes them from `name.ts`). |
| `channels/local/chat.ts` | channel | `pi-personal chat`: a channel of a few dozen lines, written on the port alone. The worked example of [write-a-channel.md](write-a-channel.md). |
| `channels/telegram/` | channel | The Telegram channel and its Markdown-to-HTML formatter. It imports nothing from `core/`. See [its README](../channels/telegram/README.md). |
| `install.sh` | — | Copies the code to `~/.local/share/pi-personal`, installs pi there, writes the `pi-personal` command. |

## A message, from a channel to its answer

1. **A channel submits it.** It writes a file whose name starts with a dot (`inbox/.<id>.tmp`), then links it to `inbox/<id>.json` (`port.submit` does this for the command line). The link is the receipt.
2. **The bridge notices it** (`fs.watch` on the inbox, coalesced, with a one-second `tick` as a fallback) and calls `deliver`. If pi is idle, `ready` lists the inbox (each file read once, cached by its modification time; duplicates and broken files settled on the way) and `hand` gives the oldest message to pi as a custom message, `customType: "pi-personal.message"`, its id in `details`.
3. **pi places it** in the session: `message_start` marks it unconfirmed; once it is in the session file on disk, `confirm` fsyncs the file, moves the message to `taken/` and emits `taken`.
4. **pi works.** At each assistant message, `message_end` reads the open run from the session (`openWork`: the message placed after the last `pi-personal.settled` or `pi-personal.stopped` mark) and emits `message` with that message in `refs`.
5. **The run ends.** `agent_settled` calls `close`: it emits `settled` for the message (with `error` when it got no full answer), then writes the `pi-personal.settled` mark into the session. The bridge then delivers the next message.
6. **The channel reads** `events.jsonl` from its saved byte offset and routes each reply by the prefix of its `conversation`.

If pi dies at any point, the message is either still in the inbox (handed again) or in the session (recognised by its id at the next start). At the next start, `session_start` reads the open run: work cut off by a crash is resumed with one visible note; work stopped on purpose (`pi-personal stop`, which writes `stopped`, read by the bridge's signal handler, or `was-stopped` at the next start) is closed and its sender told.

## Keeping it alive

- `pi-personal start` → `control.start` → `control.up` launches the runner in a Herdr Core terminal (`hc run`, through `/usr/bin/env` so the runner gets the caller's `PATH` and private area), then watches the events for `started` (ready), `safe_mode` or `failed`.
- The runner (`runner.runForever`) takes `runner.lock`, then loops: start pi with the bridge, watch it get ready, and when it ends decide why (a quit, a crash, an extension that breaks loading, pi itself unable to start) and what to do (start again at once, after a backoff, in safe mode, or give up and retry in an hour). It writes what it knows to `keeper.json`.
- `pi-personal status` reads `keeper.json`, `last-error.json` (written by the bridge) and Herdr Core's view of the terminal: never the event history.

## Conventions

- **Nothing that writes an event may kill pi or the runner.** Events go through `port.emitter`, which keeps them in memory while the disk refuses them.
- **One source of truth for each fact.** Who a reply is for is read from pi's session, never kept beside it; what the keeper knows is in `keeper.json`; the stop on purpose is the `stopped` file.
- **The core knows no channel by name.** Channel-specific behaviour lives in `channels/<name>/`; channels import nothing from `core/`.
- **Comments say why.** Each file starts with what it is for; non-obvious lines say what they protect against.

## Tests

`npm test` runs every `test/*.test.ts` with Node's test runner, one file at a time. Most tests are end to end: `test/helpers.ts` (`setup`) starts an isolated Herdr Core (its own session name and runtime folders; its identity is checked against your default core before it is stopped), a private area of its own, and a fake OpenAI-compatible model.

The fake model answers `echo: <text>`, and obeys a few words in the last user message: `tool: <command>` (call bash), `call: <tool> <json>` (call any tool), `long:<n>` (a long answer), `fail: <why>` (a refusal), `silent:` (an empty answer), `flaky:` (refused once, then answered), `interim-fail:` (a sentence and a tool call, then a refusal). `test/fake-telegram.ts` is a fake Bot API.

| File | What it checks |
|---|---|
| `port.test.ts` | the file protocol on its own |
| `first-message.test.ts`, `messages.test.ts` | a first agent; isolation, one message per run, duplicates |
| `conversations.test.ts`, `errors.test.ts` | replies never mixed; errors reach the sender |
| `crash-and-terminal.test.ts`, `keeper.test.ts`, `lifecycle.test.ts` | crashes, the keeper's rules, safe mode, stop and start |
| `durability.test.ts`, `edge-cases.test.ts`, `regressions.test.ts` | full disks, bursts, races, and every defect found so far |
| `settings.test.ts`, `cli.test.ts`, `install.test.ts` | settings, the command line, install and uninstall |
| `telegram.test.ts` | the Telegram channel |
| `contracts.test.ts` | the behaviours of pi and Herdr Core the core relies on; run it first after updating either |

To run one file: `node --test test/messages.test.ts`.
