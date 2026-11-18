# The guide

Everything about using Pi-Personal day to day: installing, the guide `pp setup` and what it does, talking to your agent, channels, starting at login, updating, where things live, backups, uninstalling. The [README](../README.md) is the short version; [concepts.md](concepts.md) explains how it works.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/emiwltz/pi-personal/main/install.sh | sh
```

The installer, in order:

1. checks the machine: Linux or macOS, on x86_64 or arm64, with `curl` and `tar`;
2. downloads Pi-Personal (no git needed);
3. uses your Node.js if it is 22.19 or newer; otherwise it downloads an official Node.js LTS build, checks it against nodejs.org's checksums, and keeps it inside Pi-Personal's own folder (nothing is installed for the whole system);
4. installs Pi-Personal and its own pinned copy of pi into `~/.local/share/pi-personal`, and the `pp` command into `~/.local/bin`;
5. if `pp` is not found first on your `PATH`, offers to put `~/.local/bin` first, in your shell's startup file (macOS ships an unrelated `/usr/bin/pp`; the same command is also installed as `pi-personal`);
6. runs `pp setup`.

Options, as environment variables: `PI_PERSONAL_INSTALL_DIR` and `PI_PERSONAL_BIN_DIR` (where), `PI_PERSONAL_REF` (a branch or tag to install), `PI_PERSONAL_SOURCE` (a local folder or `.tar.gz` instead of downloading), `PI_PERSONAL_NO_SETUP=1` (skip the guide).

From a copy of the source instead: `git clone https://github.com/emiwltz/pi-personal.git && cd pi-personal && ./install.sh`.

You do not need pi installed: Pi-Personal pins its own copy, separate from any pi you already have, which keeps working as before.

## `pp setup`

Five steps, about four minutes; each one is drawn with a line in the margin, from its title (◆) to what it settled (◇). The first time on a machine, the guide opens on a two-second drawing (a burst of stars that becomes the mark); any key skips it, `PI_PERSONAL_MOTION=never` turns every animation off (`always` plays it each time), and nothing moves outside a terminal. Colours follow your terminal's background, light or dark (the guide asks the terminal once; when it does not say, colours that read on both); `PI_PERSONAL_THEME=light` or `dark` decides instead. Run it again at any time: on a machine where everything is set up, it opens on a menu instead (talk to it from your phone, its model or the provider, coming back by itself, or the whole guide again). Pi-Personal adds only what is its own (Herdr Core, the agent, its channels); the model and the sign-in are pi's.

1. **This machine.** Says what it finds. Herdr Core (the `hc` command) already there is used as it is (checked recent enough, and started); without one, it offers to install it with Herdr's own installer (into `~/.local/bin`). On Linux, it tells you if logging out would stop your programs, and the one command that prevents it.
2. **A model.** pi's own list of providers, here: choose one, then pi's own sign-in runs in this terminal (`pi auth login`): with your account (a subscription: a browser opens, or pi shows a link and a code) or with an API key (paste it, then Enter). The sign-in is stored in Pi-Personal's own pi settings, shared by all your agents; your own pi is not touched. The model is pi's own choice for that provider, which you can change from pi's list. For anything else, pi's own screen is one choice away (`/login`, `/model`, `/quit`). Already connected, the guide asks whether to keep it; with an agent already made, it only says what is connected (each agent keeps its own model).
3. **Your agent.** A name (`main` by default) and the model of step 2, written in its `pi-personal.json`: an agent keeps its model when pi's default changes later. It creates `~/pi-personal/<name>`, says the rule of the game (the agent is pi, with everything your account can do: no sandbox; it lives in the background), starts it in Herdr Core, and the agent says hello: its first real request. If the provider refuses the key or the sign-in, the guide says so and runs pi's sign-in again.
4. **Reach it.** Each channel that ships with Pi-Personal (today: Telegram), now or later: for Telegram, a bot's token (paste the token, or BotFather's whole message; it is checked with Telegram before it is stored), then you write to the bot and type y to let yourself in (only someone writing at that moment is offered, with their Telegram id). Another channel is a small program you add ([write a channel](write-a-channel.md)).
5. **Stay alive.** The login service, which brings your agent back by itself if it stops (checked at login and every 5 minutes, while Herdr Core runs).

It ends on what to do first: `pp`, where Enter opens your agent.

**The first meeting.** A new agent's instructions (`AGENTS.md`) have a section "First meeting": in its hello, the agent says who it is, how you reach it and what you can still set, then asks what to call you and what you do. It writes what it learns in "About my person", at the end of the same file, and keeps it up to date. Edit or empty that section as you like.

**Settings, by asking.** You can ask your agent to change its own settings (a channel, its model, its extensions, its instructions). It reads its manual first (`pp --skill`, the same text as [for-agents.md](for-agents.md)), and its rules: it does this for its owner only (you, from this machine, or the person who said "that is me" in the Telegram setup: their messages are marked `From: the owner,` by the channel, which no one else can imitate); it never takes a secret in a conversation (tokens and keys are typed in a terminal: `pp setup`, `pp login`); it says what it will change and waits for your yes. A restart it runs on itself happens in a terminal of its own in Herdr Core, so it comes back; what it said is in `pp log`.

`pp login` opens pi's screen again, for `/login` (and `/model`), at any time; `pp login <provider> [--api-key]` is pi's command-line sign-in.

## Talk to it

```sh
pp                               # how your agent is doing; Enter opens it, ctrl+\ comes back
pp chat                          # a conversation here; Ctrl+D to leave
pp send "Summarize my notes" --wait   # one message; prints the answer
pp attach                        # straight to its own screen; ctrl+\ to leave
```

With one agent, commands need no name; with several, name it: `pp chat work`.

`pp` in a terminal is a small full screen (your terminal comes back as it was when you leave): your agent and how it is (a star beside its name when it is alive; amber when it waits for you, red when it cannot start), what Enter does, `s` for the full status, `q` to leave. With several agents, a card each, chosen with the arrows. Enter on an agent that is not running starts it (and Herdr Core if needed) and opens it. In a script, `pp` prints the same in plain text, with the next thing to do.

The agent's own screen is pi itself, with everything pi offers; typed messages and messages from channels coexist. `ctrl+\` leaves it, and the agent keeps running. There, Ctrl+C and Ctrl+D do not quit pi, and Ctrl+Z does not freeze it: Pi-Personal turns them off in its own pi settings (`keybindings.json` in its private area, written once; change it as you like, it stays yours). Escape still stops what pi is doing. If you quit pi with `/quit`, Pi-Personal starts it again; to stop the agent, use `pp stop`.

Its instructions are in `~/pi-personal/<name>/AGENTS.md`: edit them like any file. Its settings, in `pi-personal.json` next to them:

```json
{
  "model": "anthropic/claude-opus-5-5",
  "channels": { "telegram": { "enabled": true } }
}
```

After changing the model or the extensions: `pp restart`.

## Channels

A channel is a small program, next to the agent, that connects it to a messaging service. Pi-Personal ships **Telegram** (set up by `pp setup`, or by hand: [channels/telegram/README.md](../channels/telegram/README.md)). Any other service is a program you write, or someone else wrote, in any language: [write-a-channel.md](write-a-channel.md).

| | |
|---|---|
| `pp channel add\|remove [agent] <channel>` | turn a channel on or off (`remove` also deletes its settings; `"enabled": false` keeps them) |
| `pp channel [agent] telegram who` | who wrote to the bot without being allowed |
| `pp channel [agent] telegram allow <id>` | let them talk to your agent |
| `pp channel [agent] telegram owner [<id>]` | who the owner is there (set by the setup: the person who said "that is me"); with an id on the guest list, make them the owner |

## Extensions

Your agent is pi: it loads pi's extensions from its folder's `.pi/extensions/`, and pi packages, skills, prompt templates and MCP servers the way pi does ([concepts.md](concepts.md#extensions)). `pp ext check` says whether pi loads them; `pp pi <args>` runs Pi-Personal's own pi with the settings all agents share (to install a package, for example). An extension that breaks pi's loading puts the agent in safe mode (running without its extensions) instead of stopping it; `pp` and `pp status` say which and why.

## Start, stop, and start at login

| | |
|---|---|
| `pp start` / `pp stop` / `pp restart` | the agent and its channels; a stopped agent stays stopped until you start it |
| `pp stop --all` | every agent, then Herdr Core itself, unless it also runs programs of yours |
| `pp start --all` | every agent again |

**After a restart of the machine.** With the login service, your agent comes back by itself when Herdr Core may be started by it: always when Pi-Personal installed Herdr Core (nothing else of yours runs there), and when you said yes to it in `pp setup` (step 5, or "Coming back by itself" in its menu) for a Herdr Core of your own. Otherwise run `pp start` (or `pp start --all`) once; your agents come back, conversations included.

`pp service install` (also offered by `pp setup`) installs a systemd user timer on Linux, a launchd agent on macOS. At login and every 5 minutes it runs `pp up --if-running`, which starts every agent and channel that should run and touches nothing else. If Herdr Core is not running, it starts it only when it may (above; the permission is the file `start-herdr-core-at-boot` in the private area): Herdr Core then runs with the environment the service was installed with (your `PATH` of that moment). Otherwise it waits for the next round. `pp service status` and `pp service uninstall` do what they say.

**A machine nobody logs in to** (a Raspberry Pi, a server). On Linux, your programs stop when you log out, and user timers run only while you are logged in, unless you run `sudo loginctl enable-linger $USER` once (`pp setup` tells you when it is needed). After a reboot, agents come back at the first round after Herdr Core is running again: the service starts it itself when it may (above), once per start of the machine, and only if an agent should run; otherwise any `hc` or `pp start` starts it, from your own environment. A Herdr Core started by the service runs with the environment the service was installed with, and every terminal in it too. A Herdr Core you stop on purpose stays stopped until the next start of the machine.

## When something is wrong

- `pp` says what is wrong and the next thing to do.
- `pp status` gives the details: state, last error, last restart and why, safe mode, each channel.
- `pp log` is the keeper's log: every start, exit and restart, and why.
- `pp doctor` checks the installation and every agent, by topic (this machine, Herdr Core, coming back by itself, each agent), one line each: `ok`, `note`, or `FAIL` with what to do.
- "… refused the credentials": the provider does not accept the key or the sign-in (wrong, revoked or expired). `pp login` enters new ones; a running agent uses them from its next message, no restart needed.
- `pp follow` prints everything the agent says and does, as it happens.

The agent comes back by itself after a crash, and continues the work that was cut off. After repeated failures it stops trying, says why, and tries again every hour; `pp restart` tries now.

## Update

```sh
pp update
```

It runs the installer again (the newest Pi-Personal, with the pi version it was tested with), then restarts the agents that were running; their conversations continue. `pp --version` shows what you have.

## Where things live

| | Visible folder | Private area |
|---|---|---|
| Where | `~/pi-personal/<name>` (or the folder given to `pp init`) | Linux: `~/.local/state/pi-personal` (or `$XDG_STATE_HOME/pi-personal`). macOS: `~/Library/Application Support/Pi-Personal`. `PI_PERSONAL_HOME` overrides it. |
| Holds | `AGENTS.md`, `pi-personal.json`, and pi's `.pi/` (extensions, skills, settings) if you add some | Secrets, pi's sign-ins (`pi/`), conversations, the port, channel state (guest lists), received files, logs |
| Rule | Never holds a secret. Safe to share, sync or put under git. It is code: pi runs the extensions in it. | Readable by your user only (mode 0700). |

Copy a visible folder to another machine and run `pp init <name> <folder> --model <provider/id>` there: you get the same agent, without its secrets and its conversation history.

**Growth.** Each agent's event log (`events.jsonl` in its port) only grows, by about a kilobyte per message; to start a new one, stop the agent and move the file aside ([port.md](port.md)). At each start, the keeper's log is rotated past 5 MB and receipts older than 30 days are removed. The conversation itself (`sessions/`) is pi's: pi compacts what the model sees, but the file keeps everything and only grows (about 60 MB after 470 long replies; a restart still takes 3 seconds).

**Backup.** Stop the agent (`pp stop`), copy its visible folder and the private area, start it again. To restore, put both back in place and `pp start`: the conversation, the secrets and the guest lists come back with them.

## By hand, without the guide

```sh
pp login                                          # pi's screen: /login, then /quit (or: pp login <provider> [--api-key])
pp models                                         # the ids you can use
pp init main --model <provider>/<model-id>        # creates ~/pi-personal/main
pp start main
```

## Uninstall

```sh
pp uninstall           # stop everything, remove the service and the installed code
pp uninstall --purge   # the same, and delete the private area (conversations, secrets, guest lists)
```

Your agents' visible folders are never touched. The `PATH` line the installer added to your shell's startup file is removed. Herdr Core is left installed and running (it is Herdr's; `hc server stop` stops it), and so is the Node.js of your machine (a Node.js the installer downloaded lived in Pi-Personal's folder, and goes with it).

## Every command

`pp help` lists them, in three groups: everyday, manage, advanced. `init`, `status`, `start`, `up`, `stop`, `restart`, `send`, `follow`, `ext check`, `update` and `doctor` print JSON with `--json`.
