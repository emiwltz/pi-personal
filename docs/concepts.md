# Concepts

> An agent is one continuous pi session, living in a folder, running inside a Herdr Core terminal, reachable through any messaging channel.

Everything in Pi-Personal's core exists to make that sentence true and keep it true.

```
  phone ── Telegram ── telegram channel ──┐
  you ──── pp send / chat ───────────┤          Herdr Core terminal "pi-personal-main"
  a script, cron, another agent ──────────┤          ┌──────────────────────────────────┐
                                          ▼          │ runner                           │
                              port (plain files) ◄──►│  └─ pi + bridge                  │
                              inbox/  events.jsonl   │     working dir: visible folder  │
                                                     └──────────────────────────────────┘
  you ──── pp attach ─────────────────────────────────────────────▲ (type directly)
```

## Agent

An agent has a name (1 to 10 characters, `a-z`, `0-9`, `-`, starting with a letter) and two places on disk. Several agents can run on one machine; they share only pi's configuration (your model sign-ins and pi settings).

### Visible folder

The folder you chose at `init` (default `~/pi-personal/<name>`). It is the agent's working directory. It holds:

- `AGENTS.md`: the agent's instructions. pi reads this file by name. The default is short and neutral; edit it to change who the agent is.
- `pi-personal.json`: the agent's settings (below).
- `.pi/`: pi's own settings for this agent, if you add some: extensions in `.pi/extensions/<name>/`, packages and MCP servers in `.pi/settings.json` and `.pi/mcp.json`, skills in `.pi/skills/`.

It never holds a secret, so you can share it, sync it or put it under git. **The folder is code:** pi runs what it finds there (`.pi/extensions/`, `extensions/`) with your permissions, so only use a folder you trust, as you would a repository you run `npm install` in. The agent itself can write anything here: it works with your permissions.

`pi-personal.json` fields, all optional:

| Field | Meaning | Takes effect |
|---|---|---|
| `model` | pi's `provider/id`, passed as `--model` (set by `init --model`; `pp models` lists them). | `pp restart` |
| `channels` | `{ "<name>": { ... } }` (`pp channel add`). A channel runs unless it has `"enabled": false`. | at once if the agent runs (`channel add/remove`), else `pp start` |

### Private area

Secrets and machine state, readable by your user only (0700). Linux: `~/.local/state/pi-personal`; macOS: `~/Library/Application Support/Pi-Personal`; or `$PI_PERSONAL_HOME`. Inside:

```
pi/                    pi's configuration for all agents: settings.json, auth.json (sign-ins), models.json   [pi]
agents/<name>/
  agent.json           which visible folder belongs to this agent
  sessions/            pi's conversation log (one continuous session)                              [pi]
  port/                inbox/, taken/, rejected/, events.jsonl, version (docs/port.md)               [port]
  secrets/<key>        secrets for channels, mode 0600                                              [port]
  channels/<channel>/  each channel's own state, its runner.lock and keeper.json                    [port]
                       (Telegram: allow.json, its guest list; state.json; files/ it received)
  runner.lock          which runner runs this agent (one at a time, even across two Herdr Cores)   [Herdr]
  keeper.json          what the runner knows: ready, safe mode, failed, last restart (read by status)
  last-error.json      the agent's last error, until something works again (read by status)
  stopped              present while you keep it stopped (pp stop): up and the login service leave it alone
  was-stopped          left by pp start after a stop: the bridge closes open work instead of resuming it
  log.txt, log.txt.1   the keeper's log (pp log <name>); rotated at 5 MB
```

## Session

Each agent is **one continuous pi session**. The conversation log lives in `sessions/`. Whenever the agent starts and a conversation exists, Pi-Personal starts pi with `--continue`, so a crash, a reboot, `pp restart` or a new version all resume the same conversation.

**One message per run.** The agent works on one message at a time: a message that arrives while it works (from the same person or another) waits its turn ([order](port.md)) and gets its own answer. The agent still knows everything said before: it is one continuous conversation. A reply never goes to someone it was not meant for.

**Never silent.** Every message the agent takes in ends with one `settled` event naming it: after its reply, or carrying the `error` when there was none (a provider that refuses, a run that ends without an answer, a stop on purpose, the owner taking over in the terminal). A channel tells its sender. Text typed in the agent's terminal, and everything answered after it in that run, stays in the terminal.

pi compacts long conversations by itself for the model, but the session file keeps everything and only grows (about 60 MB after 470 long replies; a restart still takes 3 seconds). Pi-Personal does not manage memory.

## Herdr Core terminal

Each agent runs in a terminal of your usual Herdr Core (the one `hc` reaches with your environment), not a private one. Each channel runs in a terminal of its own.

- **Names:** `pi-personal-<agent>` and `pi-personal-<agent>_<channel>`. Herdr allows one live terminal per name, so there is never more than one session per agent.
- **Labels:** `pi-personal.agent=<agent>`, `pi-personal.home=<tag of the private area>`, and `pi-personal.role=agent` or `pi-personal.channel=<channel>`. Pi-Personal finds its own terminals by these labels, never by guessing.
- **One runner at a time.** Each runner holds a lock in the private area. If two Herdr Cores share one private area (two sessions, a test), the second runner waits instead of starting a second pi on the same conversation, and gives up if the agent is stopped meanwhile. Seen from the other core, `pp status` says `running elsewhere` with the runner's pid, `pp send` works, and `pp stop` refuses (stop it from where it runs).
- **`where`:** the label Herdr's desktop app uses to place terminals: `pi-personal / <agent>`, and `pi-personal / <agent> / <channel>` for channels.
- **Status:** pi reports its own status to Herdr Core (idle, working, done, blocked, error). `pp status` shows what Herdr Core shows.
- **The agent uses Herdr too.** The agent's terminal gets your `PATH` (and Herdr Core's `HC_TERMINAL_ID`), so pi can run `hc` itself: open other sessions or helper agents in their own terminals, read what they wrote, organise them in spaces (`hc --skill` explains how). A helper reports back by sending a message to the agent's port (`pp send <agent> "..." --conversation <where the answer should go>`): text typed into the agent's terminal stays in the terminal and reaches no channel. Delegation and workspaces are extensions or skills; the core only makes sure pi can reach Herdr.

Herdr's desktop app is not required.

## Keeper

Herdr Core keeps a terminal alive, but it never reruns a program that ended. The keeper does. It is two small pieces, not a daemon ([decision 0002](decisions/0002-keeper.md)):

**The runner** runs in each Pi-Personal terminal and starts the program there (pi with the bridge, or a channel). When the program ends for any reason other than a stop request (crash, kill, normal exit), the runner starts it again in the same terminal. Its rules:

- wait between quick failures: 0.5, 1, 2, 4, 8 seconds (no wait if the program had been up for more than a minute);
- pi that does not report ready within 2 minutes (an extension that hangs while loading) is stopped and counted as a failed start;
- quitting pi on purpose (`/quit`, Ctrl+D) after it had been up 10 seconds or more is not a failure: it is started again at once;
- after **5 failed starts within 10 minutes**: status `failed` with the reason, on the port, in the log and in `pp status`;
- then **one new attempt per hour** (if that attempt fails too, it is marked `failed` again at once); a program that stays up 10 minutes resets the count;
- `pp restart <name>` tries again at once. Each start reads `pi-personal.json` again, so a fix applies at the next attempt. A `pi-personal.json` that cannot be read is refused by `restart` before it stops anything.

The runner writes what it knows (ready, safe mode, failed, last restart) to `keeper.json` next to its lock; `pp status` reads that file and Herdr Core, never the whole event history.

**`pp up`** makes sure every agent and channel that should run has a live terminal. It creates what is missing and touches nothing else, so running it twice is harmless. `pp start` runs it (then waits until pi reports ready, and says so), and so does the login service every 5 minutes. The service starts Herdr Core itself only when it may (Pi-Personal installed it, or you said yes in `pp setup`), once per start of the machine; otherwise it waits until Herdr Core runs. If the service dies or is updated, agents keep running: they live in Herdr Core, not under the service.

**Stopping.** `pp stop` stops the agent and its channels and remembers it: `up` and the login service leave it stopped until `pp start`. Work it was doing is not resumed at the next start (it was stopped on purpose, even if pi was down at that moment), and whoever was waiting for an answer is told; work cut off by a crash or a reboot is resumed.

**Safe mode.** If pi stops before it reaches the port, the runner starts pi without a model or a session to see whether it loads (asking it for its state, and waiting for the answer; a check that does not answer within 30 seconds, such as an extension stuck in a loop, is killed). If pi names extensions that fail to load, or if it loads without them but not with them, the runner starts pi with **only the bridge**: every extension off, not only the broken ones. A failure the check cannot show (pi loads in the check, then stops in its terminal) is a plain failure, counted and retried, never a guess. You see `SAFE MODE` in `pp status`, which names the failing extensions, and a `safe_mode` event on the port. Messages keep flowing. Safe mode ends:

- by itself, the next time the runner starts pi, if everything loads again;
- or with `pp restart <name>` (if an extension is still broken, the agent goes back into safe mode).

**Blocked.** When the agent waits for a person (a permission or a question), Pi-Personal answers nothing. The port reports `blocked` with the question when pi gives it. Answer it in the terminal with `pp attach`.

## Port

The single way in and out of an agent: a folder of plain files in the private area. A program writes one JSON file into `inbox/` to send a message, and reads `events.jsonl`, which only grows, to see everything the agent says and does. Sending the same identifier twice has the effect of sending it once, nothing accepted is lost across crashes, and a reader resumes from a byte offset without seeing anything twice. It is protected by file permissions only. The full protocol is in [port.md](port.md).

## Bridge

The one piece of Pi-Personal that runs inside pi (`core/bridge.ts`), loaded even in safe mode.

- **In:** it hands each inbox message to pi as a custom message that carries the message's `id` (and `from`) inside pi's own session. The model reads it as a user message. A message counts as taken in, and moves to `taken/`, only once that entry is stored in the session file on disk. After a crash, the bridge reads the session to know what was already taken, so nothing is lost or handled twice.
- **Out:** every assistant text message, errors, the end of each run (`settled`), status changes and text typed in the terminal become events. A reply carries `refs`: the port message it answers. Who a reply is for is read from the session itself: the port messages placed since the run's last reply, after the last mark that closed a run. A reply to something typed in the terminal has `refs: []`.
- **After a crash that cut off work,** it adds one visible note asking the agent to continue where it left off. Not after a stop on purpose.
- **Never fatal.** If the events file cannot be written (a full disk), events wait in memory and are written once it works again; an error inside the bridge is reported as an `error` event, never thrown into pi.

## Channel

A side program that connects a messaging service to the port. It runs in its own terminal, supervised by the keeper like an agent. It decides who may talk to the agent: the core does no authorization. It recognises its own replies by the `refs` on each message event. Everything the service does its own way is the channel's job, never the core's: formatting, splitting, quoting, rates, its own checks ([write-a-channel.md](write-a-channel.md#what-is-the-cores-job-and-what-is-the-channels)). Two ship with Pi-Personal:

- `pp chat`: talk from your shell. It is a channel you run yourself, not one you turn on with `channel add`, and the worked example in [write-a-channel.md](write-a-channel.md).
- `telegram`: long polling, deny by default, one chat per conversation, Markdown shown as Telegram formatting, replies quoting the message they answer, "typing..." while the agent works, errors told to the sender.

## Extensions

Three kinds, by what they can break.

| Kind | What | Where | How to enable | Can it stop the agent? |
|---|---|---|---|---|
| **Text** | `AGENTS.md`, Agent Skills, prompt templates | `AGENTS.md`; skills in `.pi/skills/` or `.agents/skills/` in the visible folder; templates in `.pi/prompts/` (pi's own conventions) | Present = used | No |
| **In-agent** | pi extensions and packages: tools, hooks | where pi finds them: `<folder>/.pi/extensions/<name>/` (for example an `index.ts` with a default export), packages in `.pi/settings.json` | put it there (`pp ext check <agent> <name>` says whether it loads), then `pp restart` | Yes: safe mode protects you |
| **Side program** | Channels, watchers, anything that talks to the port | Anywhere; declared in `pi-personal.json` | `pp channel add <agent> <name> -- <command...>` | No: it runs in its own terminal |

Pi-Personal keeps no list of extensions of its own: pi loads what it finds, as it would without Pi-Personal (extensions in the folder's `.pi/extensions/`, packages declared in pi's settings, MCP servers, skills), plus Pi-Personal's bridge. To turn an extension on, put its folder in `.pi/extensions/`; to turn it off, take it out. `pp ext check <agent>` lists them and says whether pi starts with all of it; `pp ext check <agent> <name>` checks one, without starting the agent. `pp pi <args>` runs Pi-Personal's own pi with its settings, for example to install a package for every agent. Only safe mode turns everything off (pi's `-ne`). Verified by `test/contracts.test.ts` for an extension in `.pi/extensions/`, an MCP server in `.pi/mcp.json` and a local pi package in `.pi/settings.json`; packages from npm or git were not tested (they need the network).

What belongs to one agent, and what all agents share:

| | One agent | All agents of this machine |
|---|---|---|
| Instructions | `AGENTS.md` in its folder | |
| Skills | `.agents/skills/` or `.pi/skills/` in its folder | `~/.agents/skills/` (pi reads it for every agent, as it does for you) |
| MCP servers | `.pi/mcp.json` in its folder | `mcp.json` in Pi-Personal's pi directory (`<private area>/pi/`) |
| pi packages | `.pi/settings.json` in its folder | `settings.json` in Pi-Personal's pi directory |
| Model sign-in | | `auth.json` in Pi-Personal's pi directory (`pp login`) |

Pi-Personal's pi directory is not your own `~/.pi/agent`: what you set up there for yourself (for example with `pi mcp add`) does not reach Pi-Personal's agents. To add something to every agent, run pi's command with `PI_CODING_AGENT_DIR` set to Pi-Personal's pi directory; to add it to one agent, put it in that agent's folder.

## Not in the core, on purpose

The core has opinions only about staying alive, staying visible and carrying messages. It does not include, and will not grow by default:

- a method of working: no coordinator, delegation, plans, tasks or memory system;
- scheduling, reminders or heartbeats (anything that can run `pp send` can wake an agent);
- permission gates, approval flows, or any authorization (channels own that);
- a sandbox, a marketplace, or an update mechanism for third-party extensions;
- a graphical interface or a hosted version;
- channels other than `local` and `telegram`; Windows.

Some of these will come as extensions. An idea joins the core only after it has proven itself as an extension.
