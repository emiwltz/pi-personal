# The guide

Everything about using Pi-personal day to day: installing, the guide `pp setup` and what it does, talking to your agent, channels, starting at login, updating, where things live, backups, uninstalling. The [README](../README.md) is the short version; [concepts.md](concepts.md) explains how it works.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/emiwltz/pi-personal/main/install.sh | sh
```

The installer, in order:

1. checks the machine: Linux or macOS, on x86_64 or arm64, with `curl` and `tar`;
2. downloads Pi-personal (no git needed);
3. uses your Node.js if it is 22.19 or newer; otherwise it downloads an official Node.js LTS build, checks it against nodejs.org's checksums, and keeps it inside Pi-personal's own folder (nothing is installed for the whole system);
4. installs Pi-personal and its own pinned copy of pi into `~/.local/share/pi-personal`, and the `pp` command into `~/.local/bin`;
5. if `pp` is not found first on your `PATH`, offers to put `~/.local/bin` first, in your shell's startup file (macOS ships an unrelated `/usr/bin/pp`; the same command is also installed as `pi-personal`);
6. runs `pp setup`.

Options, as environment variables: `PI_PERSONAL_INSTALL_DIR` and `PI_PERSONAL_BIN_DIR` (where), `PI_PERSONAL_REF` (a branch or tag to install), `PI_PERSONAL_SOURCE` (a local folder or `.tar.gz` instead of downloading), `PI_PERSONAL_NO_SETUP=1` (skip the guide).

From a copy of the source instead: `git clone https://github.com/emiwltz/pi-personal.git && cd pi-personal && ./install.sh`.

You do not need pi installed: Pi-personal pins its own copy, separate from any pi you already have, which keeps working as before.

## `pp setup`

Five steps. Run it again at any time: what is done is kept, and only the optional steps are asked again.

1. **This machine.** Finds Herdr Core (the `hc` command), checks it is recent enough, and starts it. Without Herdr Core, it offers to install it with Herdr's own installer (into `~/.local/bin`). On Linux, it tells you if logging out would stop your programs, and the one command that prevents it.
2. **A model provider.** Exactly the choices pi's own `/login` offers: sign in with an account (a subscription, in your browser) or use an API key, then the provider. Credentials already on the machine are offered first, each on a yes: an API key in an environment variable of this terminal (saved for your agents, since they do not run in this terminal), or an API key in your own pi (copied; your pi is not changed). Account sign-ins are not copied from your own pi: two programs sharing one sign-in can log each other out, so you sign in again.
3. **Your agent.** The model (pi's list for your providers, pi's default first) and a name (`main` by default). It creates `~/pi-personal/<name>`.
4. **Start it.** The agent starts in Herdr Core and says hello. It runs in the background: closing the terminal does not stop it.
5. **Reach it from anywhere.** Each channel that ships with Pi-personal (today: Telegram) offers its own short setup: for Telegram, a bot's token, then you write to the bot and say yes to let yourself in (only someone writing at that moment is offered, with their Telegram id). Then the login service, which brings your agent back by itself if it stops (checked at login and every 5 minutes, while Herdr Core runs).

`pp login` alone offers the same choices as step 2, at any time; `pp login <provider> [--api-key]` goes straight to pi's sign-in.

## Talk to it

```sh
pp                               # how your agent is doing, and what to do next
pp chat                          # a conversation here; Ctrl+D to leave
pp send "Summarize my notes" --wait   # one message; prints the answer
pp attach                        # its own terminal: watch it work, or take over; ctrl+\ to leave
```

With one agent, commands need no name; with several, name it: `pp chat work`.

In the attached terminal you are typing into pi itself, with everything pi offers. Typed messages and messages from channels coexist. If you quit pi there, Pi-personal starts it again; to stop the agent, use `pp stop`.

Its instructions are in `~/pi-personal/<name>/AGENTS.md`: edit them like any file. Its settings, in `pi-personal.json` next to them:

```json
{
  "model": "anthropic/claude-opus-5-5",
  "channels": { "telegram": { "enabled": true } }
}
```

After changing the model or the extensions: `pp restart`.

## Channels

A channel is a small program, next to the agent, that connects it to a messaging service. Pi-personal ships **Telegram** (set up by `pp setup`, or by hand: [channels/telegram/README.md](../channels/telegram/README.md)). Any other service is a program you write, or someone else wrote, in any language: [write-a-channel.md](write-a-channel.md).

| | |
|---|---|
| `pp channel add\|remove [agent] <channel>` | turn a channel on or off (`remove` also deletes its settings; `"enabled": false` keeps them) |
| `pp channel [agent] telegram who` | who wrote to the bot without being allowed |
| `pp channel [agent] telegram allow <id>` | let them talk to your agent |

## Extensions

Your agent is pi: it loads pi's extensions from its folder's `.pi/extensions/`, and pi packages, skills, prompt templates and MCP servers the way pi does ([concepts.md](concepts.md#extensions)). `pp ext check` says whether pi loads them; `pp pi <args>` runs Pi-personal's own pi with the settings all agents share (to install a package, for example). An extension that breaks pi's loading puts the agent in safe mode (running without its extensions) instead of stopping it; `pp` and `pp status` say which and why.

## Start, stop, and start at login

| | |
|---|---|
| `pp start` / `pp stop` / `pp restart` | the agent and its channels; a stopped agent stays stopped until you start it |
| `pp stop --all` | every agent, then Herdr Core itself, unless it also runs programs of yours |
| `pp start --all` | every agent again |

**After a reboot**, run `pp start` (or `pp start --all`) once: Herdr Core is not started for you at boot, and your agents come back with it, conversations included.

`pp service install` (also offered by `pp setup`) installs a systemd user timer on Linux, a launchd agent on macOS. At login and every 5 minutes it runs `pp up --if-running`, which starts every agent and channel that should run and touches nothing else. It never starts Herdr Core itself: if Herdr Core is not running, it waits for the next round. `pp service status` and `pp service uninstall` do what they say.

**A machine nobody logs in to** (a Raspberry Pi, a server). On Linux, your programs stop when you log out, and user timers run only while you are logged in, unless you run `sudo loginctl enable-linger $USER` once (`pp setup` tells you when it is needed). After a reboot, agents come back at the first round after Herdr Core is running again (any `hc` or `pp start` starts it, from your own environment). Pi-personal never starts Herdr Core from the service on purpose: a Herdr Core started by a service would run with the service's bare environment, and every terminal in it too.

## When something is wrong

- `pp` says what is wrong and the next thing to do.
- `pp status` gives the details: state, last error, last restart and why, safe mode, each channel.
- `pp log` is the keeper's log: every start, exit and restart, and why.
- `pp doctor` checks the installation and every agent, one line each: `ok`, `note`, or `FAIL` with what to do.
- `pp follow` prints everything the agent says and does, as it happens.

The agent comes back by itself after a crash, and continues the work that was cut off. After repeated failures it stops trying, says why, and tries again every hour; `pp restart` tries now.

## Update

```sh
pp update
```

It runs the installer again (the newest Pi-personal, with the pi version it was tested with), then restarts the agents that were running; their conversations continue. `pp --version` shows what you have.

## Where things live

| | Visible folder | Private area |
|---|---|---|
| Where | `~/pi-personal/<name>` (or the folder given to `pp init`) | Linux: `~/.local/state/pi-personal` (or `$XDG_STATE_HOME/pi-personal`). macOS: `~/Library/Application Support/Pi-personal`. `PI_PERSONAL_HOME` overrides it. |
| Holds | `AGENTS.md`, `pi-personal.json`, and pi's `.pi/` (extensions, skills, settings) if you add some | Secrets, pi's sign-ins (`pi/`), conversations, the port, channel state (guest lists), received files, logs |
| Rule | Never holds a secret. Safe to share, sync or put under git. It is code: pi runs the extensions in it. | Readable by your user only (mode 0700). |

Copy a visible folder to another machine and run `pp init <name> <folder> --model <provider/id>` there: you get the same agent, without its secrets and its conversation history.

**Growth.** Each agent's event log (`events.jsonl` in its port) only grows, by about a kilobyte per message; to start a new one, stop the agent and move the file aside ([port.md](port.md)). At each start, the keeper's log is rotated past 5 MB and receipts older than 30 days are removed. The conversation itself (`sessions/`) is pi's: pi compacts what the model sees, but the file keeps everything and only grows (about 60 MB after 470 long replies; a restart still takes 3 seconds).

**Backup.** Stop the agent (`pp stop`), copy its visible folder and the private area, start it again. To restore, put both back in place and `pp start`: the conversation, the secrets and the guest lists come back with them.

## By hand, without the guide

```sh
pp login                                          # or: pp login <provider> [--api-key]
pp models                                         # the ids you can use
pp init main --model <provider>/<model-id>        # creates ~/pi-personal/main
pp start main
```

## Uninstall

```sh
pp uninstall           # stop everything, remove the service and the installed code
pp uninstall --purge   # the same, and delete the private area (conversations, secrets, guest lists)
```

Your agents' visible folders are never touched. The `PATH` line the installer added to your shell's startup file is removed. Herdr Core is left installed and running (it is Herdr's; `hc server stop` stops it), and so is the Node.js of your machine (a Node.js the installer downloaded lived in Pi-personal's folder, and goes with it).

## Every command

`pp help` lists them, in three groups: everyday, manage, advanced. `init`, `status`, `start`, `up`, `stop`, `restart`, `send`, `follow`, `ext check`, `update` and `doctor` print JSON with `--json`.
