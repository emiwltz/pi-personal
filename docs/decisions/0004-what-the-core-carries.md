# 0004 — What the core carries in 0.5

Status: accepted (2026-11-23). Amends [0002](0002-keeper.md) (safe mode) and [0003](0003-delivery.md) (what the bridge places in pi's session).

## Decision

By the owner's decision, the core carries what the owner's channels and a kit of about ten extensions need from it and cannot do without it. Each piece is a fact or a door; none decides anything.

1. **Who wrote.** A port message may say who wrote it (`sender`: a name, the service's id, `owner`). The bridge alone writes the header the model reads above a message (`From:` when there is a sender, `Sent:` always); a message without `sender` is a program's report, never the owner's request. An in-agent extension asks the bridge who the open run is for (`pi-personal.who`). Herdr Core's notes typed into the agent's terminal are not the owner typing.
2. **A file out.** The bridge's one tool, `attach_file`, sends a file to the person the run answers (a `file` event); it counts as a reply.
3. **An interrupt.** A control message (`"control": "interrupt"`, `pp interrupt`) stops the run in progress, done the moment it is seen, never queued nor shown to the model; extensions hear of it (`pi-personal.interrupt`).
4. **The agent's own session**, pinned by its id (`--session-id`), and the commands that restart the agent's terminal only: `pp new`, `pp model`, `pp thinking`.
5. **Piloting from a channel.** `pp remote <agent> -- <command>`: a short list of commands for the owner, a key or a secret on standard input only, and the kit's door (`kit/kit.ts`, when one is installed).
6. **A question and its answer.** An extension asks the owner (`pi-personal.ask`); the question is shown in the terminal and said on the port (`question`), and the first answer wins, the terminal's or a control message `answer` (`answered`).
7. **A message told without waking.** `"wake": false`: said to its conversation at once, kept in the agent's conversation as a note (`pi-personal.note`) that starts no run.
8. **Safe mode keeps what works**: the healthy entries of `.pi/extensions/` stay on, and the tools of those that were off come back with them; the bridge alone stays the floor.

Protocol 1 only grew: new optional fields and event types. `started` says the core's version (`core`), so that a channel can tell a core that knows `sender`, `control` and `wake`.

## Why

The terminal must stay a window, never an obligation: the owner stops a run, starts a fresh conversation, changes the model, gives a key or answers an approval from a phone. Each of these needs what only runs inside pi or in its runner: aborting a run, reading from pi's session who a run is for, placing an entry in the session without starting a run, starting pi with chosen extensions. An extension or a channel cannot do them from outside, and two extensions doing them each their own way would disagree. The session is pinned because any pi started with the agent's environment (its own bash, a helper) left a newer session, which `--continue` then took for the agent's. Safe mode with every extension off also turned off the guards the kit relies on.

## What it still refuses to decide

- Who may talk to the agent, ask it, answer its questions or pilot it: the channel's decision. `owner` is a fact the channel carries; the core checks nothing.
- What a guest may do: the extension's decision (it learns who a run is for, and refuses what it wants).
- What a question means (an approval, a choice) and what follows from its answer: the extension's.
- Another extension's own pi dialog: answered in the terminal only, never from the port.
- When to remind anyone: no scheduler; anything that can run `pp send --no-wake` tells on time.

## Cost

The core grew by about 1,150 lines (from 5,216 to about 6,370), most of them in the bridge (`core/bridge.ts`, from 465 to about 990 lines); the two channels by about 280. A read of the whole code for what could go, afterwards, found about 25 lines. The limits that come with it are said where a reader looks for them: the owner mark is as strong as the private area's file permissions ([security.md](../security.md)); an extension that safe mode turned off enforces nothing meanwhile; a run waiting in another extension's dialog does not end on an interrupt ([port.md](../port.md)); an agent whose folder was moved starts an empty conversation under the same session id ([concepts.md](../concepts.md#session)).

## Upgrading from 0.4

What `pp update` does to an agent made by 0.4, read in the code (only what was checked):

- The installer installs 0.5 with the pi it pins, 1.6.0 (0.4 pinned 1.5.2), then the agents that were running are restarted. pi's changelog for 1.6.0 names no change to the session format; a session written by pi 1.5.2 and opened by 1.6.0 was not tested.
- **Its conversation continues and is pinned.** It has sessions and no `session` file: the runner starts it once on pi's newest session of its folder (`--continue`, as 0.4 did), and the bridge writes the id of the session pi opened; from then on it is started with that id (`test/session.test.ts`).
- **Its `AGENTS.md` is its own and is not rewritten** (`pp init` writes one only when it is missing). Its 0.4 wording still reads the owner right (the header's first line is `From: the owner, …`), but it knows nothing of the header, `Sent:`, notes or Herdr Core's notes, and its "First meeting" section takes a message with no `From:` line for the owner's, which in 0.5 is also a program's (`pp send`). Its line on secrets ("a secret is never typed in a conversation") is still the rule. The manual it reads before changing its own settings (`pp --skill`, updated with 0.5) has the 0.5 rules. To take the new wording, copy it from `DEFAULT_AGENTS_MD` in `core/agents.ts`.
- **A channel written for 0.4** that writes its own `From:` line into `text` and no `sender`: that line now comes below the bridge's header, so its messages, its owner's included, read as a program's until it sends `sender` ([write-a-channel.md](../write-a-channel.md)). The Telegram channel that ships with 0.5 sends it.
