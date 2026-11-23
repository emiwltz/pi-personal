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
| `model` | pi's `provider/id`, passed as `--model` (set by `init --model`; `pp models` lists them). | `pp model <agent> <provider/id>` writes it and restarts the agent's terminal; edited by hand: `pp restart` |
| `thinking` | pi's thinking level, passed as `--thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` (another value is set aside, and `pp status` says so). Not set: pi keeps the level the conversation last used. | `pp thinking <agent> <level>`, the same way |
| `channels` | `{ "<name>": { ... } }` (`pp channel add`). A channel runs unless it has `"enabled": false`. | at once if the agent runs (`channel add/remove`), else `pp start` |

### Private area

Secrets and machine state, readable by your user only (0700). Linux: `~/.local/state/pi-personal`; macOS: `~/Library/Application Support/Pi-personal`; or `$PI_PERSONAL_HOME`. Inside:

```
pi/                    pi's configuration for all agents: settings.json, auth.json (sign-ins), models.json   [pi]
agents/<name>/
  agent.json           which visible folder belongs to this agent
  sessions/            pi's conversation logs                                                       [pi]
  session              the id of the agent's own session among them: the one it resumes
  port/                inbox/, taken/, rejected/, events.jsonl, version (docs/port.md)               [port]
  secrets/<key>        secrets for channels, mode 0600                                              [port]
  channels/<channel>/  each channel's own state, its runner.lock and keeper.json                    [port]
                       (Telegram: allow.json, its guest list; state.json; files/ it received)
  extensions/          the state of in-agent extensions, each in a subfolder of its own name        [pi]
  runner.lock          which runner runs this agent (one at a time, even across two Herdr Cores)   [Herdr]
  keeper.json          what the runner knows: ready, safe mode, failed, last restart (read by status)
  last-error.json      the agent's last error, until something works again (read by status)
  stopped              present while you keep it stopped (pp stop): up and the login service leave it alone
  was-stopped          left by pp start after a stop: the bridge closes open work instead of resuming it
  log.txt, log.txt.1   the keeper's log (pp log <name>); rotated at 5 MB
```

## Session

Each agent is **one continuous pi session**. The conversation logs live in `sessions/`, and the id of the agent's own session in `session`, beside them: Pi-Personal starts pi with `--session-id <that id>` (pi opens that session, or creates it), so a crash, a reboot, `pp restart` or a new version all resume the same conversation, and a pi started by hand with the agent's environment (its own bash, a helper agent) never becomes the agent, however new its session. A new agent gets its id before its first start. An agent made by 0.4 has no `session` file: it is started once on pi's newest session (`--continue`), and the bridge writes down the id of the session pi opened. The bridge also writes down a session the owner opens in the agent's terminal (`/new`, `/resume`): it is the agent's from then on. pi finds a session by its id only while the agent's folder is where it was: an agent whose folder was moved starts an empty conversation under the same id (the old one stays on disk).

**A fresh conversation**, when the owner wants one: `pp new <agent>`. The agent's terminal restarts (its channels keep running); work in progress is closed as by a stop on purpose, and its sender told; a message pi could not close (it was down) is closed by the command itself, with the error "a new conversation was started before this message was answered". The agent then comes back in a new session, which knows nothing of the old one. The old sessions stay where they are (pi's `/resume` lists them), and an id the port took in the last 30 days is still refused (its file in `taken/`: the new conversation knows no earlier id). `pp model` and `pp thinking` restart the terminal the same way, without closing anything: a run in progress is cut and resumed with the new setting, and answered once. Stopped on purpose, the agent stays stopped: the change applies at its next start. Run by the agent on itself, these commands wait until its answer is done, as `pp restart` does.

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
- **The agent uses Herdr too.** The agent's terminal gets your `PATH` (and Herdr Core's `HC_TERMINAL_ID`), so pi can run `hc` itself: open other sessions or helper agents in their own terminals, read what they wrote, organise them in spaces (`hc --skill` explains how). A helper reports back by sending a message to the agent's port (`pp send <agent> "..." --conversation <where the answer should go>`): text typed into the agent's terminal stays in the terminal and reaches no channel. Herdr Core itself types a note into the agent's terminal, as one block `<hc ...>...</hc>`, when a terminal the agent started ends (unless it was started with `--no-notify`, as the agent's instructions say): the bridge takes a message that is one such block for a program's note, never the owner typing, so it does not take a run away from the person being answered. (Text sent with `hc send` by a plain program arrives as it was written, untagged, and reads as typed.) Delegation and workspaces are extensions or skills; the core only makes sure pi can reach Herdr.

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

**Safe mode.** If pi stops before it reaches the port, the runner starts pi without a model or a session to see whether it loads (asking it for its state, and waiting for the answer; a check that does not answer within 30 seconds, such as an extension stuck in a loop, is killed). If pi names extensions that fail to load, or if it loads without them but not with them and each tried alone shows which fail, the runner starts pi in safe mode: those entries of `.pi/extensions/` off, the others pi turns on by itself on with the bridge (`pi -ne -e <bridge> -e <each one kept>`), once a check shows that they load together; one the owner turned off in pi's settings (`pi config`) stays off. Packages, pi's built-in extensions (MCP, tool search, codemode), the extensions of Pi-Personal's pi directory and the paths under `extensions` in pi's settings are off too: pi offers no way to pick among them from the command line (which is why an in-agent part belongs in `.pi/extensions/`). Before every start in safe mode, it works out again what fails and what stays on. If nothing could be named, if the others do not load without the failing ones, or if pi started with them does not reach the port, the next start is the **bridge alone**, at once and not counted as a failed start, and it stays so until everything loads: whatever the extensions do, the agent stays reachable. A failure the check cannot show (pi loads in the check, then stops in its terminal) is a plain failure, counted and retried, never a guess. You see `SAFE MODE` in `pp status`, which names the failing extensions and what is off, and a `safe_mode` event on the port. Messages keep flowing, and an extension that is off enforces nothing meanwhile (a guard that refuses guests some tools, say): the `started` event lists what is off, so that a channel can serve only its owner until it is back. The tools of the extensions that were off come back with them: pi keeps a tool removed from a conversation off at later starts, so the bridge notes in the session which tools safe mode turned off (`pi-personal.tools-off`) and turns them on again at the first start out of it. Safe mode ends:

- by itself, the next time the runner starts pi, if everything loads again;
- or with `pp restart <name>` (if an extension is still broken, the agent goes back into safe mode).

**Blocked.** When the agent waits for a person (a permission or a question), the port reports `blocked` with the question when pi gives it. A question an extension asked through Pi-Personal (`pi-personal.ask`) waits for its owner in the terminal and on the port at once: `pp answer`, or a channel's own command (Telegram's `/answer_...`), answers it, and the first answer wins. Any other extension's dialog is answered in the terminal only (`pp attach`): Pi-Personal answers nothing there, tells each message held up that the agent waits in its terminal, and `pp interrupt` does not end a run that waits this way.

## Port

The single way in and out of an agent: a folder of plain files in the private area. A program writes one JSON file into `inbox/` to send a message, and reads `events.jsonl`, which only grows, to see everything the agent says and does. Sending the same identifier twice has the effect of sending it once, nothing accepted is lost across crashes, and a reader resumes from a byte offset without seeing anything twice. It is protected by file permissions only. The full protocol is in [port.md](port.md).

## Bridge

The one piece of Pi-Personal that runs inside pi (`core/bridge.ts`), loaded even in safe mode.

- **In:** it hands each inbox message to pi as a custom message that carries the message's `id` (and `from`, `conversation`, `sender`) inside pi's own session. The model reads it as a user message, under a header that the bridge alone writes: `From:`, who wrote it, when its channel said (`the owner` only for the owner), and `Sent:`, when ([port.md](port.md)). Text typed in the terminal has no header. A message counts as taken in, and moves to `taken/`, only once that entry is stored in the session file on disk. After a crash, the bridge reads the session to know what was already taken, so nothing is lost or handled twice.
- **Control:** a port message that carries `control` is for the bridge itself, done the moment it is seen, whatever pi is doing, and never shown to the model nor kept in the session. `interrupt` (`pp interrupt`) asks pi to stop the run in progress, as Escape does in the terminal; the messages that wait keep their turn. `answer` (`pp answer`) answers a question of the agent ([port.md](port.md)).
- **Told without waking:** a port message with `wake: false` (`pp send --no-wake`) starts no run. Its text is said to its conversation the moment it is seen (a reminder is on time), and what the agent should know of it (the text, or a shorter `note`) is stored in the session when pi is idle, as a note the model reads with its next message. A note is never a run's message and never answered ([port.md](port.md#sending-a-message)).
- **Out:** every assistant text message, errors, the end of each run (`settled`), status changes and text typed in the terminal become events. The bridge gives the agent one tool, `attach_file`, to send a file to the person it answers: a `file` event, which counts as a reply; files in the private area are refused (secrets, sign-ins, conversations), except those a channel received and in-agent extensions' own. A reply carries `refs`: the port message it answers. Who a reply is for is read from the session itself: the port messages placed since the run's last reply, after the last mark that closed a run. A reply to something typed in the terminal has `refs: []`.
- **After a crash that cut off work,** it adds one visible note asking the agent to continue where it left off. Not after a stop on purpose.
- **For extensions:** it tells an in-agent extension that asks (`pi-personal.who`, on pi's bus) who the open run is for: its messages, its conversation, its sender, and whether the owner took it over in the terminal; it says each interrupt (`pi-personal.interrupt`), so that an extension stops work of its own and adds a line to the answer; and it asks the owner an extension's question (`pi-personal.ask`), in the terminal and on the port at once, and gives the extension the first answer.
- **Never fatal.** If the events file cannot be written (a full disk), events wait in memory and are written once it works again; an error inside the bridge is reported as an `error` event, never thrown into pi.

## Channel

A side program that connects a messaging service to the port. It runs in its own terminal, supervised by the keeper like an agent. It decides who may talk to the agent, and says who wrote each message and whether that is the owner (`sender`): the core does no authorization, it carries that fact to the agent and to its extensions. It recognises its own replies by the `refs` on each message event. It can pilot the agent for its owner, through one command Pi-Personal gives it (`pp remote <agent> -- <command>`: stop the run, a fresh conversation, the model, the thinking level, the status, a restart of the agent, a key or a secret given on standard input, the kit), so that the terminal stays a window, never an obligation; which person may do it is the channel's decision ([write-a-channel.md](write-a-channel.md#running-under-pi-personal)). Everything the service does its own way is the channel's job, never the core's: formatting, splitting, quoting, rates, its own checks ([write-a-channel.md](write-a-channel.md#what-is-the-cores-job-and-what-is-the-channels)). Two ship with Pi-Personal:

- `pp chat`: talk from your shell, as the owner; the agent's questions about your messages are shown with the command that answers them. It is a channel you run yourself, not one you turn on with `channel add`, and the worked example in [write-a-channel.md](write-a-channel.md).
- `telegram`: long polling, deny by default, one chat per conversation, Markdown shown as Telegram formatting, replies quoting the message they answer, "typing..." while the agent works, errors told to the sender, and the owner's commands (`/stop`, `/new`, `/login`...).

## Extensions

Three kinds, by what they can break.

| Kind | What | Where | How to enable | Can it stop the agent? |
|---|---|---|---|---|
| **Text** | `AGENTS.md`, Agent Skills, prompt templates | `AGENTS.md`; skills in `.pi/skills/` or `.agents/skills/` in the visible folder; templates in `.pi/prompts/` (pi's own conventions) | Present = used | No |
| **In-agent** | pi extensions and packages: tools, hooks | where pi finds them: `<folder>/.pi/extensions/<name>/` (for example an `index.ts` with a default export), packages in `.pi/settings.json` | put it there (`pp ext check <agent> <name>` says whether it loads), then `pp restart` | Yes: safe mode protects you |
| **Side program** | Channels, watchers, anything that talks to the port | Anywhere; declared in `pi-personal.json` | `pp channel add <agent> <name> -- <command...>` | No: it runs in its own terminal |

An in-agent extension is given the port, the agent's name, its secrets folder and a private folder for its own state (`PI_PERSONAL_PORT`, `PI_PERSONAL_AGENT`, `PI_PERSONAL_SECRETS`, `PI_PERSONAL_STATE`), the same in a load check as in a real start, and can ask the bridge who a run is for ([port.md](port.md#room-for-extensions)). A side program gets those of a channel, with the agent's visible folder and the command that pilots the agent (`PI_PERSONAL_REMOTE`) ([write-a-channel.md](write-a-channel.md#running-under-pi-personal)).

**The kit** is a door, not an ability: when an installation holds `kit/kit.ts`, `pp kit [agent] <words...>` (and `/kit` from a channel, through `pp remote`) runs it with the agent's environment: its name, port, secrets, the in-agent extensions' state folder, its visible folder and `PI_PERSONAL_REMOTE`. Otherwise they say that no kit is installed. The core knows no piece of it by name.

Pi-Personal keeps no list of extensions of its own: pi loads what it finds, as it would without Pi-Personal (extensions in the folder's `.pi/extensions/`, packages declared in pi's settings, MCP servers, skills), plus Pi-Personal's bridge. To turn an extension on, put its folder in `.pi/extensions/`; to turn it off, take it out. `pp ext check <agent>` lists them and says whether pi starts with all of it; `pp ext check <agent> <name>` checks one, without starting the agent. `pp pi <args>` runs Pi-Personal's own pi with its settings, for example to install a package for every agent. Only safe mode turns extensions off: the failing entries of `.pi/extensions/`, and every package and built-in extension of pi (pi's `-ne`; [Safe mode](#keeper) above). Verified by `test/contracts.test.ts` for an extension in `.pi/extensions/`, an MCP server in `.pi/mcp.json` and a local pi package in `.pi/settings.json`; packages from npm or git were not tested (they need the network).

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

Some of these will come as extensions. An idea joins the core only after it has proven itself as an extension, or by the owner's decision when every channel and extension needs it from the core. So, in 0.5 ([decision 0004](decisions/0004-what-the-core-carries.md)), the core carries an interrupt, a file out, a question with its answer and a message told without waking; it still decides nothing with them: who may ask, who may answer, what is allowed.
