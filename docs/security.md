# Security and trust

Pi-personal gives an AI agent your user account and a way to reach it from your phone. Read this page before you allow anyone on a channel.

## There is no sandbox

The agent is pi, running as you. Its tools read and write files and run commands with your user's permissions, on the whole machine, not only in its folder. Pi-personal adds no permission prompts, no command rules and no approval flow. Anyone who can send the agent a message can ask it to do anything you can do.

If you want limits, they come from outside: a separate user account, a container, a virtual machine, or a pi extension that asks before risky commands (in-agent extensions are covered below).

Content the agent reads (web pages, files, attachments, messages) can also try to steer it. Pi-personal does nothing about that.

## The port is a trust boundary

Each agent's [port](port.md) is a folder in Pi-personal's private area. Anyone who can write a file into its `inbox/` drives the agent. It is protected only by file permissions:

- the private area and the port folder are mode `0700`: only your user can read or write what is inside;
- Pi-personal adds no authentication on top.

This is the same boundary as Herdr Core's own socket: any program running as your user can already run commands through Herdr Core, or type into the agent's terminal. Anything running as you is trusted, and `pp send` from a cron job or a script is the intended way to wake an agent.

## Channels own authorization

The core does not decide who may talk to an agent. Each channel does.

The Telegram channel denies by default: it obeys only the numeric Telegram user ids on its guest list. With an empty list it obeys nobody. A message from anyone else never reaches the port; the channel records who wrote (`pp channel <agent> telegram who`) and never adds anyone by itself. Allow only people you would hand a terminal on your machine. Guests share the agent and its memory: the Telegram channel starts each message with who wrote it (`From:`, with their Telegram id) and the agent is told to keep each person's words to themselves, but nothing enforces it. Pi-personal has no budget: set a spending limit at your model provider. It also sends only to chats on the guest list, even when a program asks for another one with `pp send --conversation telegram:<chat>`.

The guest list lives in the channel's private state (`agents/<agent>/channels/telegram/allow.json`), not in the agent's folder: the folder is the agent's working directory, which it edits all day, and it may be shared or published. Nothing in the folder can add a guest: an `allow` list written in `pi-personal.json` is ignored. (The agent runs as you and could still reach the private area; keeping the list out of its folder keeps it out of its everyday work.) If the list cannot be read, the channel decides nothing: it confirms no incoming message and sends nothing until it can read it again.

A channel you write or install yourself is responsible for its own authorization.

## Secrets live only in the private area

- `pp secret set <agent> <key>` stores a secret as `secrets/<key>` in the agent's private area, mode `0600`. It reads the value from standard input and never prints it.
- Model sign-ins are pi's: `pp login <provider>` runs `pi auth login`, which stores them in pi's `auth.json` inside the private area (`pi/`).
- Nothing Pi-personal writes in the visible folder is a secret. The test suite checks that the Telegram token appears nowhere but its secret file.
- Every channel of an agent can read all of that agent's secrets (`PI_PERSONAL_SECRETS`).
- The agent itself can read the private area: it runs as you. Pi-personal cannot stop it from copying a secret somewhere if it decides to.

## Extensions are code you chose to run

- **In-agent extensions** run inside pi, with your permissions and access to the whole conversation.
- **Side programs** (channels) run with your permissions and get the agent's port and secrets.
- **Skills and instructions** are text, but they can tell the model to run programs.

Pi-personal has no marketplace, no review, no signature check and no sandbox for extensions. Read an extension before you enable it.

**The agent's folder is code.** pi runs the extensions it finds in the folder (`.pi/extensions/`, packages and MCP servers in `.pi/`), and Pi-personal starts pi there. Treat a folder like a repository you would run `npm install` in: only use one you trust.

**Pi-personal trusts the agent's own folder in pi.** Pi-personal's own pi configuration (`pi/settings.json` in the private area, not your `~/.pi`) sets `defaultProjectTrust` to `always`, so pi never stops at startup to ask whether to trust the agent's folder. pi therefore loads the folder's project configuration (`.pi/`) and skills without asking. Copying someone else's agent folder means trusting everything in it.

## No telemetry

Pi-personal sends nothing about you anywhere. It starts pi with `PI_TELEMETRY=0` and with pi's version check off (`PI_SKIP_VERSION_CHECK=1`; Pi-personal pins pi and updates it itself).

What does go over the network:

- pi, to your model provider (and whatever the agent itself decides to reach);
- the Telegram channel, to `api.telegram.org` (or the `apiBase` you set);
- the installer and `pp update`: GitHub (Pi-personal's source), npm (pi), and nodejs.org only when the machine has no recent enough Node.js (the download is checked against nodejs.org's published checksums);
- `pp setup`, on your yes: Herdr's own installer, from `releases.herdr.dev`, when Herdr Core is missing (it checks its own download).

Every download goes over HTTPS and is saved whole before it runs: a connection cut half-way runs nothing.

## What can go wrong

| What | What it means | What to do |
|---|---|---|
| **Your bot token leaks** | Someone can read the messages sent to your bot and send messages as your bot, for example to trick you. They can also take incoming messages before your channel sees them. They cannot command the agent: the guest list checks the Telegram account that sent each message, and the token does not change that. | In @BotFather, `/revoke` the token and get a new one; `pp secret set <agent> telegram-token`; `pp restart <agent>`. |
| **A guest you allowed** (or someone who took over their Telegram account) | They can make the agent do anything your user can do. | `pp channel <agent> telegram deny <id>`. It applies at once. Check `pp follow <agent>` and the session for what they asked. |
| **A malicious extension, skill or channel** | Full access as your user. | Only enable what you have read. `pp ext check <agent>` shows the extensions in the agent's `.pi/extensions/` and whether they load. |
| **Anyone with your user account** | They can read every secret and conversation, write to the port, and attach to the agent. | Pi-personal cannot protect against this. Protect the account. |
| **You share the visible folder** | It holds instructions, settings and extensions, but no secrets, no guest list and no conversation. | Check anything the agent itself wrote there. |
| **Someone else's folder** | pi runs the extensions in it, as you. | Read it before `pp init <name> <folder>`. |

## Deleting

`pp uninstall --purge` deletes the private area (conversations, secrets, state). It refuses when the private area holds your home folder, does not look like one Pi-personal made, or holds an agent's folder; `pp init` refuses a folder inside the private area, or one that already belongs to another agent. Agents' folders are never deleted.

## What Pi-personal never does to your Herdr Core

Your Herdr Core carries your other work. Pi-personal:

- **never starts it from the login service.** The service runs `pp up --if-running`, which first checks Herdr Core's socket without starting it, and does nothing if Herdr Core is not running. (`pp setup` starts it, and a `pp` command you run by hand calls `hc`, which starts the selected Herdr Core when it is not running: that is Herdr's behaviour, from your own shell.)
- **installs or updates it only on your yes**, in `pp setup`, with Herdr's own installer or `hc update` (running terminals keep running);
- **stops it only when you ask, and only when it runs nothing else**: `pp stop --all` stops your agents, then Herdr Core if no other program of yours runs in it; otherwise it leaves it running and says what else runs. `pp stop` and `pp uninstall` never stop it, and nothing reconfigures it;
- **only touches its own terminals**: those it created, recognised by their labels (`pi-personal.agent`, `pi-personal.home`, and `pi-personal.role` or `pi-personal.channel`). It stops them and removes its own finished ones. It never sends keys, types into, or stops a terminal it did not create.
