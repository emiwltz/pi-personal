# Write your own channel

A channel connects a messaging service (mail, Matrix, a web page, a sensor) to an agent. It is an ordinary program, in any language, that reads and writes a few files: the [port](port.md). It does not import anything from Pi-Personal. If you can read `port.md`, you can write one in an afternoon.

## What is the core's job, and what is the channel's

The rule: **the core stays the same for every messaging service; everything a service does its own way belongs to its channel.**

| The core (the port) | The channel |
|---|---|
| Takes in a message: an id, plain text, file paths, a conversation (its address), who wrote it (`sender`), the channel's own `from` | Receives from the service (polling, a socket, a webhook); decides who may talk (guest list, pairing...); turns the service's message into a port message |
| Gives out every reply as plain text (the agent's Markdown, as written), and each file the agent sends as a path, with the messages it answers | Formats it the way the service shows text (Telegram HTML, Slack mrkdwn, Discord Markdown, plain for SMS), splits it to the service's length, quotes or threads it, respects the service's rates |
| Reports errors, status, blocked questions, restarts | Tells the sender about an error; shows the rest, or not, the way that suits the service ("typing...", a note) |
| Knows no service by name | Ships its own commands (`check`, and any others it needs) |

If a channel needs something the port does not give, change the port for every channel, never the core for one service.

This page walks through the smallest channel, `channels/local/chat.ts` (the one behind `pp chat`), then lists what Pi-Personal gives a channel it runs for you, and the rules that keep messages from being lost or repeated.

## The worked example: `channels/local/chat.ts`

Open `channels/local/chat.ts` in the repository: under a hundred lines. You can run it by hand:

```sh
pp chat main
```

which is the same as setting `PI_PERSONAL_PORT` to the output of `pp port main` and running the file with Node.

**Setup.** The one input it needs is `PI_PERSONAL_PORT`, the port folder (`pp chat` also gives it `PI_PERSONAL_AGENT`, the agent's name, and `PI_PERSONAL_COMMAND`, the installed command's name, `pp` or `pi-personal`, for the command it shows to answer a question). The channel picks a name for its conversation, `me`, unique to this process. It puts `me` in the `conversation` of every message it sends, and recognises replies by it: the agent answers one conversation at a time, and every reply carries the conversation it answers. It also says who writes, with `sender`: whoever runs `pp chat` on the agent's own machine is its owner (`{ owner: true, name: <the login name>, id: "pp chat" }`).

```ts
const port = process.env.PI_PERSONAL_PORT;
const me = `local:${process.pid}-${Date.now()}`;
```

**Sending.** One message is one JSON file in `inbox/`. The file is written under a temporary name starting with a dot (ignored by the agent), then hard-linked to `<id>.json`. The link is atomic and fails if the name exists, so the agent never sees half a file and an id can never be overwritten. Once the link exists, the message is accepted.

```ts
fs.writeFileSync(tmp, JSON.stringify({ id, text, conversation: me, sender }));
fs.linkSync(tmp, path.join(port, "inbox", `${id}.json`));
fs.rmSync(tmp);
```

**Receiving.** `events.jsonl` only grows. The channel keeps its position, the byte offset where it stopped, starting at the current end (it shows only what comes next). On each poll it reads from there, keeps only complete lines (up to the last newline), and handles each event:

- a `message` event whose `refs` include its conversation (`r.conversation === me`) is printed;
- a `file` event for its conversation is a file the agent sent: `[file] <path>` is printed (the file is already on this machine; a channel for a messaging service uploads it, as Telegram does by kind);
- a `settled` event for its conversation that carries an `error` says the agent could not answer, and why (every message ends with one `settled`);
- an `error` event for its conversation says the message will be tried again (`retryAt`);
- a `question` event for its conversation (an in-agent extension asks for an approval or a choice) is shown with the command that answers it (`pp answer`), and the `answered` event that closes it, or a `started`, `stopped` or `restarted` of the agent, says how it closed: whoever runs `pp chat` is the owner, the one person who may answer;
- a `status` event with `state: "blocked"` tells you the agent waits for a person in its terminal (not while one of its own questions waits: it was shown above).

A channel that knows its owner also shows the agent's questions (`question` events, from an in-agent extension that asks for an approval or a choice) to its owner, whatever conversation the run belongs to, and passes on only the owner's answer, with `answer` below. Answering is the owner's act: never show a question to someone else, nor take a guest's answer. Say to the owner when a question closes without them (an `answered` event, or a `started`, `stopped` or `restarted` of the agent, which closes every question asked before it). [port.md](port.md), "Questions".

If the file is shorter than the offset, the owner replaced it by hand (while the agent was stopped): read the new one from its start.

**Wiring.** Each line you type is sent. The port folder is watched for changes, with a poll every 500 ms as a fallback, because file watching is not reliable everywhere.

That is a complete channel. What it leaves out, because it lives only as long as your terminal session, is what a supervised channel must add: a position saved to disk, identifiers that survive a restart, and `fsync` before the link.

## Running under Pi-Personal

Turn the channel on with `pp channel add <agent> <name> -- <command...>`, or declare it in the agent's `pi-personal.json` yourself, under a name of 1 to 9 characters (`a-z`, `0-9`, `-`, starting with a letter):

```json
{
  "channels": {
    "mail": {
      "command": ["/usr/bin/python3", "/home/me/pi-personal-mail/mail.py"],
      "mailbox": "INBOX"
    }
  }
}
```

A running agent starts it at once (`channel add` runs `pp up`); otherwise `pp start <agent>` starts it, in its own Herdr Core terminal, `pi-personal-<agent>_mail`. To turn it off, set `"enabled": false` (its settings stay), or `pp channel remove <agent> mail` (its settings go too); either way its terminal is stopped.

Use absolute paths in `command`. The program gets the environment of the runner: Herdr Core's, with the `PATH` of whoever started the agent (your shell, or the login service, which records your `PATH` when you install it), plus the variables below. Its working directory is its state folder.

It receives these environment variables:

| Variable | What it is |
|---|---|
| `PI_PERSONAL_PORT` | The agent's port folder |
| `PI_PERSONAL_STATE` | A private folder for this channel's own state (position, offsets, its guest list). Also the working directory. |
| `PI_PERSONAL_SECRETS` | The agent's secrets folder. A secret stored with `pp secret set <agent> <key>` is the file `$PI_PERSONAL_SECRETS/<key>`. |
| `PI_PERSONAL_FOLDER` | The agent's visible folder (its working directory, with `AGENTS.md` and `pi-personal.json`) |
| `PI_PERSONAL_SETTINGS` | This channel's object from `pi-personal.json`, as JSON, as it was when the keeper last started the channel |
| `PI_PERSONAL_AGENT` | The agent's name |
| `PI_PERSONAL_CHANNEL` | The channel's name |
| `PI_PERSONAL_REMOTE` | How to pilot the agent for its owner: a JSON array, the command to run with your words appended (`pp remote <agent> --`, below) |

**Settings.** Everything in the channel's object besides `command` and `enabled` is yours, and `pp channel add` keeps it (declare your settings before or after adding the channel). `PI_PERSONAL_SETTINGS` is read again each time the keeper starts the channel. Save files received for the agent in `$PI_PERSONAL_STATE/files/` and pass their paths as `attachments`: it is the one folder of your state the agent's `attach_file` may send from, so keep nothing else there. Keep what decides who may talk to the agent (a guest list) in `PI_PERSONAL_STATE`, not in the agent's folder: the folder is the agent's own working directory, which it edits. For the same reason, a setting that names a server belongs in the channel's private state, never in `pi-personal.json`, which the agent edits: pointed at another server, a channel would hand it its token and its messages.

**Secrets.** Read them from `PI_PERSONAL_SECRETS`. Never print them, never write them to the visible folder or to the port.

**Your own commands.** `pp channel [agent] <channel> [args...]` runs your `command` with the extra arguments, exactly as given (options included), and the same environment. Use it for setup commands, like `pp channel telegram allow <id>`. The channel must be declared in `pi-personal.json` and not disabled (`"enabled": false`) for this to work (a channel that ships with Pi-Personal works before, so that it can set itself up). If your program answers `check` with one line per check, starting with `ok`, `note` or `FAIL`, `pp channel <channel> check` runs it; `pp doctor` runs `check` only for the channels that ship with Pi-Personal, never a program of your own.

**A guided setup.** A channel that ships with Pi-Personal can answer `setup`: an interactive command, in the user's terminal, that asks for what the channel needs (a token, the first person to allow) and exits 0 when the channel can start, 3 when the user skipped it. `pp setup` offers each shipped channel and runs its `setup` before turning it on; the core itself knows no channel by name. Telegram's is the example.

**Piloting the agent.** Your owner may want to stop a run, start a fresh conversation or store a key from their phone. Run the command in `PI_PERSONAL_REMOTE` (a JSON array: run its first element with the others as arguments, then your words, never through a shell) with one of these, and show its output, which is short and plain, for a phone:

| Words | What it does |
|---|---|
| `interrupt` | stop the run in progress (the messages waiting keep their turn) |
| `answer <question id> <text...>` | answer a question of the agent's (a `question` event): an option's text or number, or free text |
| `new` | a fresh conversation |
| `model [provider/id]`, `thinking [level]` | show the setting; given a value, change it (the agent's terminal restarts; your channel keeps running). Without a value, the last line is `choose: ` and what may be chosen, separated by spaces (the thinking levels, or the models pi lists as `provider/id`): enough to draw buttons |
| `status` | how the agent is doing, in a few short lines: its state, its model, each channel, then only what matters now (a question, safe mode, a recent error or restart) |
| `restart` | restart the agent's terminal (your channel keeps running) |
| `login <provider>` | store an API key for a provider: the key on standard input |
| `secret set <name>` | store a secret for the agent's channels: the value on standard input |
| `kit <words...>` | the kit's own commands, when one is installed |
| `help` | the list |

Everything after `--` is taken as it is: a word that looks like an option (`--help`) is a word. `answer` joins the words after the question's id with one space: pass the text as one word to keep its line breaks. Anything else is refused with the list (exit code 2); exit code 1 is a failure, said in one line. For `interrupt` and `answer`, set `PI_PERSONAL_REMOTE_ID` to your own id for the request (Telegram: `tg-<update_id>`): a request you fetch twice is then done once. Which person may pilot the agent is yours to decide: the core does not check. Obey only the owner, as your channel knows them, in a message of their own (not forwarded), and pass nothing of it to the agent.

**A secret from your owner** (a key for `login`, a value for `secret set`) goes around the agent: hand it to the command on standard input, never in an argument (it shows in the list of processes) or an environment variable; never write it to the port, a log or your state; repeat nothing of it in your answer; and delete the message that carried it from the service, where the service allows, before anything else (say so when you could not). Take the value in the same message as the command: a state that waits for "the next message" can turn a key into a message for the model after a restart or a delay. It still crossed the messaging service: [security.md](security.md) says so.

**Authorization is yours.** The core lets anything written to the port through. If your service can be reached by other people, decide who may talk to the agent, and deny by default. See [security.md](security.md).

## Never lose, never repeat

The port guarantees exactly-once from the inbox on. The channel is responsible for the two ends it owns.

**Incoming:**

1. **Derive the id from the source's own id** (Telegram uses `tg-<update_id>`). If you crash and fetch the same message again, you submit the same id, and the port drops the copy. A random id would deliver it twice.
2. **Acknowledge upstream only after the link into `inbox/` succeeded** (or after you deliberately ignored the message). Telegram's offset, an IMAP flag, a queue ack: all come after the link, never before. If you crash in between, you fetch it again, and rule 1 makes that harmless.
3. `fsync` the temporary file before linking it, so an accepted message survives a power loss.
4. Send messages from one conversation one after another; the port keeps the order they were written in.

**Outgoing:**

1. **Save your position to disk** (the byte offset), atomically (write a temporary file, then rename it). On the very first start, begin at the current end of `events.jsonl`, so you do not replay the agent's whole history.
2. **Save the position after sending** each reply. A crash between "sent" and "saved" can send that one reply twice; saving before sending could lose it. The Telegram channel chooses "twice, rarely" over "lost".
3. Handle only complete lines, and skip a line that is not valid JSON instead of stopping.
4. Ignore event types and fields you do not know. New ones may appear.
5. **Tell the sender when `settled` carries an `error`** for one of their messages (and, if you like, when an `error` says it will be tried again). Silence is the worst answer.

**Recognising your own replies.** Name each conversation `<your channel name>:<the service's own id>` (`telegram:4242`, `mail:alice@example.com`): that is its address. Every `message` event carries `refs`, the messages it answers, each with its `id`, its `conversation` and your `from`, unchanged. Route an answer by the prefix of its `conversation`, and keep in `from` only what you need to shape it (the message to quote, a thread to reply in). All the messages a reply answers belong to one conversation. A program can ask for an answer to go to one of your conversations with `pp send <agent> "..." --conversation <your name>:<id>`: such a message has no `from`. A message told without waking (`"wake": false`: a reminder, a program's report) is said to its conversation with a `message` event whose `refs` name that message itself: route it the same way. Ignore replies whose `refs` are not yours; a reply to something typed in the agent's terminal has `refs: []`. Events about channels (`started`, `restarted`, `failed`, `stopped` with a `channel` field) are not replies.

**Who is speaking.** Say who wrote each message with `sender` ([port.md](port.md)): `name`, whatever the person chose (a display name, and a handle after it: both can change); `id`, the service's own stable identifier for that person and nothing else; `owner: true` for the person who owns the agent, as your channel knows it, and for nobody else. The core writes it for the agent, above your text, as a line `From: the owner, "<name>" (<id>) · <conversation>`, then when the message was sent; the default instructions tell the agent to answer that person, not to pass one person's words to another, and to change its settings for its owner only. Do not write that line yourself: a `From:` line inside `text` (the convention before 0.5) comes below the core's header, so the agent reads it as text someone wrote, and your owner as a guest or a program. A message without `sender` reads as a program's report. Whether a core knows `sender` is said by its `started` event (`core`, from 0.5 on); an older core ignores the field.

## The keeper restarts you

Your channel is supervised like an agent:

- when it exits, for any reason, it is started again: at once if it had run for more than a minute, else after 0.5, 1, 2, 4, 8 seconds;
- after 5 failed starts within 10 minutes it is marked `failed` (`pp status` shows the reason), then tried once an hour; staying up 10 minutes resets the count;
- a crashing channel never affects the agent or the other channels;
- on stop it gets SIGTERM (or SIGHUP when its terminal closes); the runner leaves 5 seconds later, and the terminal is then removed with what still runs in it.

So: assume you can be killed at any moment, which the rules above make safe. For a configuration error (a missing token), print one clear line to standard error and exit with a non-zero code; the keeper gives up after 5 tries and `pp status` says so. Your standard output and error go to your Herdr Core terminal (its address is in `pp status <agent>`; read it with `hc read <address>`); the keeper's own start and exit lines go to `pp log <agent>`. After fixing the problem, `pp restart <agent>` starts everything again (the agent's conversation continues).

## A larger example

The Telegram channel has the same structure plus what a real service needs: a guest list, long polling, formatting, quoting, splitting, rates. Its own page explains each: [channels/telegram/README.md](../channels/telegram/README.md).
