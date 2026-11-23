# Security and trust

Pi-Personal gives an AI agent your user account and a way to reach it from your phone. Read this page before you allow anyone on a channel.

## There is no sandbox

The agent is pi, running as you. Its tools read and write files and run commands with your user's permissions, on the whole machine, not only in its folder. Pi-Personal adds no permission prompts, no command rules and no approval flow of its own: it carries an extension's question to its owner and back (an approval, say), and decides nothing about it. Anyone who can send the agent a message can ask it to do anything you can do.

If you want limits, they come from outside: a separate user account, a container, a virtual machine, or a pi extension that asks before risky commands (in-agent extensions are covered below).

Content the agent reads (web pages, files, attachments, messages) can also try to steer it. Pi-Personal does nothing about that.

## The port is a trust boundary

Each agent's [port](port.md) is a folder in Pi-Personal's private area. Anyone who can write a file into its `inbox/` drives the agent. It is protected only by file permissions:

- the private area and the port folder are mode `0700`: only your user can read or write what is inside;
- Pi-Personal adds no authentication on top.

This is the same boundary as Herdr Core's own socket: any program running as your user can already run commands through Herdr Core, or type into the agent's terminal. Anything running as you is trusted, and `pp send` from a cron job or a script is the intended way to wake an agent. Text a program sends into the agent's terminal (`hc send`) reads as the owner typing: the terminal is the owner's (only Herdr Core's own notes, one `<hc ...>...</hc>` block, are told apart).

## Channels own authorization

The core does not decide who may talk to an agent. Each channel does.

The Telegram channel denies by default: it obeys only the numeric Telegram user ids on its guest list. With an empty list it obeys nobody. A message from anyone else never reaches the port; the channel records who wrote (`pp channel <agent> telegram who`) and never adds anyone by itself. Allow only people you would hand a terminal on your machine. Guests share the agent and its memory: the Telegram channel says who wrote each message (`sender`: their name and their Telegram id, which the agent reads on a `From:` line above the text) and the agent is told to keep each person's words to themselves, but nothing enforces it. Pi-Personal has no budget: set a spending limit at your model provider. It also sends only to chats on the guest list, even when a program asks for another one with `pp send --conversation telegram:<chat>`.

The guest list lives in the channel's private state (`agents/<agent>/channels/telegram/allow.json`), not in the agent's folder: the folder is the agent's working directory, which it edits all day, and it may be shared or published. Nothing in the folder can add a guest: an `allow` list written in `pi-personal.json` is ignored. (The agent runs as you and could still reach the private area; keeping the list out of its folder keeps it out of its everyday work.) If the list cannot be read, the channel decides nothing: it confirms no incoming message and sends nothing until it can read it again.

**The owner.** A channel says who wrote each message, and whether that is the agent's owner (`sender` in the [port](port.md)); the core's bridge, and nobody else, writes it above the text the agent reads. The owner's messages come under `From: the owner, "<name>" (<id>) …`; everyone else's under `From: "<name>" (<id>) …`, the name in quotes and both stripped of quotes, brackets, line ends and characters that cannot be seen, so nobody imitates the mark by choosing a name, and nothing written in a message can: a `From:` line in the text comes below the header. On Telegram, the owner is the person who says "that is me" during the setup, at your terminal (`channels/telegram/owner`, the first one stays); `pp chat`, run on your machine, is the owner too. Deny by default: a message that names no sender (`pp send`, a script, a helper agent) is a program's report to the agent, never its owner's request. The agent's instructions and its manual (`pp --skill`) tell it to change its own settings, channels, guest lists or instructions for its owner only, and never to take a secret in a conversation. This is an instruction to a model, not a lock: a model can be talked into things, and a guest still shares the agent and its powers. Two attacks on a well-known agent in 2026 started exactly there (a crafted message got the agent to change its own configuration). Allow guests accordingly.

**The owner mark is as strong as the private area's file permissions, and no stronger.** Whoever can write a file into the port can write a message that says `"owner": true`, and whoever can make the agent run a command or write a file can make it write one. A pi extension can use the mark (the bridge tells it who a run is for) to refuse guests some tools, but a guest policy that means anything refuses guests every tool that runs commands or writes files; otherwise run the agent in an account or a container of its own. The core still does no authorization: it carries the fact.

**An answer to a question is as strong as the port's file permissions, too.** An extension's question (an approval, a choice) is answered from the terminal or by a control message `answer` in the port, and the core does not check who wrote that message: whoever can write a file into `inbox/` can answer it. A channel passes on only its owner's answer (the Telegram channel obeys `/answer` from its owner only); the core decides nothing about who may.

**Piloting from a channel.** A channel can run a short list of commands for its owner (`pp remote <agent> -- <command>`: stop the run, a new conversation, the model, the thinking level, the status, a restart of the agent, a key, a secret, the kit). The core does not check who asked: the channel does. The Telegram channel obeys these commands only in a private chat, from its owner on its guest list, in a message that is not forwarded; from anyone else they are refused in one line and never passed to the agent.

**Safe mode turns off what fails, and what it guarded.** When an extension fails to load, the agent goes on without it (and without pi's packages and built-in extensions) rather than stop: an extension that is off enforces nothing while messages keep flowing, a guard that refuses guests some tools included. The `started` event on the port says what is off (`safeMode`), so a channel that wants to serve only its owner meanwhile can.

A channel you write or install yourself is responsible for its own authorization.

## Secrets live only in the private area

- `pp secret set <agent> <key>` stores a secret as `secrets/<key>` in the agent's private area, mode `0600`. It asks for the value without showing it (or reads it from standard input in a script) and never prints it.
- Model sign-ins are pi's: `pp login <provider>` runs `pi auth login`, which stores them in pi's `auth.json` inside the private area (`pi/`). From a channel, where there is no terminal, `pp remote <agent> -- login <provider>` runs pi's own API-key sign-in with the key it reads on standard input and stores it the same way (a sign-in with an account stays in a terminal). A key that starts with `!` or holds `$` is refused there: pi runs the first as a shell command and fills the second in from the environment, which is for what you type at your own machine.
- **A secret given from a channel** (Telegram's `/login <provider> <key>` and `/secret <name> <value>`, from the owner only) never reaches the agent or its conversation: the channel passes it to `pp remote` on standard input, never in a command's arguments (they show in the list of processes) nor in an environment variable, and writes it to no port, log or state of its own; its confirmation repeats nothing of it. Telegram's channel deletes that message from the chat before anything else, and says so when it could not. It still crossed the messaging service: Telegram's servers saw it, and so would anyone who reads the chat before it is deleted (another device, a notification). Prefer the terminal for a key you care about; revoke one that was sent where it should not have been. The test suite checks that such a key and such a secret appear in no file but their own (`test/remote.test.ts`, `test/telegram.test.ts`).
- Nothing Pi-Personal writes in the visible folder is a secret. The test suite checks that the Telegram token appears nowhere but its secret file.
- Every channel of an agent can read all of that agent's secrets (`PI_PERSONAL_SECRETS`).
- The agent itself can read the private area: it runs as you. Pi-Personal cannot stop it from copying a secret somewhere if it decides to.
- The agent's tool for sending a file (`attach_file`) refuses a file in the private area, links followed, except what a channel received and in-agent extensions' own files. It is a guard against a slip, not a wall: the agent can copy a file elsewhere first and send the copy.

## Extensions are code you chose to run

- **In-agent extensions** run inside pi, with your permissions and access to the whole conversation; they are told where the agent's port and secrets are.
- **Side programs** (channels) run with your permissions and get the agent's port and secrets.
- **Skills and instructions** are text, but they can tell the model to run programs.

Pi-Personal has no marketplace, no review, no signature check and no sandbox for extensions. Read an extension before you enable it.

**The agent's folder is code.** pi runs the extensions it finds in the folder (`.pi/extensions/`, packages and MCP servers in `.pi/`), and Pi-Personal starts pi there. Treat a folder like a repository you would run `npm install` in: only use one you trust.

**Pi-Personal trusts the agent's own folder in pi.** Pi-Personal's own pi configuration (`pi/settings.json` in the private area, not your `~/.pi`) sets `defaultProjectTrust` to `always`, so pi never stops at startup to ask whether to trust the agent's folder. pi therefore loads the folder's project configuration (`.pi/`) and skills without asking. Copying someone else's agent folder means trusting everything in it.

## No telemetry

Pi-Personal sends nothing about you anywhere. It starts pi with `PI_TELEMETRY=0` and with pi's version check off (`PI_SKIP_VERSION_CHECK=1`; Pi-Personal pins pi and updates it itself).

What does go over the network:

- pi, to your model provider (and whatever the agent itself decides to reach);
- the Telegram channel, to `api.telegram.org` (or the `apiBase` you set);
- the installer and `pp update`: GitHub (Pi-Personal's source), npm (pi), and nodejs.org only when the machine has no recent enough Node.js (the download is checked against nodejs.org's published checksums);
- `pp setup`, on your yes: Herdr's own installer, from `releases.herdr.dev`, when Herdr Core is missing (it checks its own download).

Every download goes over HTTPS and is saved whole before it runs: a connection cut half-way runs nothing.

## What can go wrong

| What | What it means | What to do |
|---|---|---|
| **Your bot token leaks** | Someone can read the messages sent to your bot and send messages as your bot, for example to trick you. They can also take incoming messages before your channel sees them. They cannot command the agent: the guest list checks the Telegram account that sent each message, and the token does not change that. | In @BotFather, `/revoke` the token and get a new one; `pp secret set <agent> telegram-token`; `pp restart <agent>`. |
| **A guest you allowed** (or someone who took over their Telegram account) | They can make the agent do anything your user can do. | `pp channel <agent> telegram deny <id>`. It applies at once. Check `pp follow <agent>` and the session for what they asked. |
| **A malicious extension, skill or channel** | Full access as your user. | Only enable what you have read. `pp ext check <agent>` shows the extensions in the agent's `.pi/extensions/` and whether they load. |
| **Anyone with your user account** | They can read every secret and conversation, write to the port, and attach to the agent. | Pi-Personal cannot protect against this. Protect the account. |
| **You share the visible folder** | It holds instructions, settings and extensions, but no secrets, no guest list and no conversation. | Check anything the agent itself wrote there. |
| **Someone else's folder** | pi runs the extensions in it, as you. | Read it before `pp init <name> <folder>`. |

## Deleting

`pp uninstall --purge` deletes the private area (conversations, secrets, state). It refuses when the private area holds your home folder, does not look like one Pi-Personal made, or holds an agent's folder; `pp init` refuses a folder inside the private area, or one that already belongs to another agent. Agents' folders are never deleted.

## What Pi-Personal never does to your Herdr Core

Your Herdr Core carries your other work. Pi-Personal:

- **starts it from the login service only when it may**: when Pi-Personal installed it, or when you said yes in `pp setup` for a Herdr Core of your own (the file `start-herdr-core-at-boot` in the private area). `pp service uninstall` takes the permission back in both cases. Otherwise the service, `pp up --if-running`, first checks Herdr Core's socket without starting it, and does nothing if Herdr Core is not running. A Herdr Core started by the service runs with the environment the service was installed with. (`pp setup` starts it, and a `pp` command you run by hand calls `hc`, which starts the selected Herdr Core when it is not running: that is Herdr's behaviour, from your own shell.)
- **installs or updates it only on your yes**, in `pp setup`, with Herdr's own installer or `hc update` (running terminals keep running);
- **stops it only when you ask, and only when it runs nothing else**: `pp stop --all` stops your agents, then Herdr Core if no other program of yours runs in it; otherwise it leaves it running and says what else runs. `pp stop` and `pp uninstall` never stop it, and nothing reconfigures it;
- **only touches its own terminals**: those it created, recognised by their labels (`pi-personal.agent`, `pi-personal.home`, and `pi-personal.role` or `pi-personal.channel`). It stops them and removes its own finished ones. It never sends keys, types into, or stops a terminal it did not create.
