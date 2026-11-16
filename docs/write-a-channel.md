# Write your own channel

A channel connects a messaging service (mail, Matrix, a web page, a sensor) to an agent. It is an ordinary program, in any language, that reads and writes a few files: the [port](port.md). It does not import anything from Pi-personal. If you can read `port.md`, you can write one in an afternoon.

## What is the core's job, and what is the channel's

The rule: **the core stays the same for every messaging service; everything a service does its own way belongs to its channel.**

| The core (the port) | The channel |
|---|---|
| Takes in a message: an id, plain text, file paths, a conversation (its address), the channel's own `from` | Receives from the service (polling, a socket, a webhook); decides who may talk (guest list, pairing...); turns the service's message into a port message |
| Gives out every reply as plain text (the agent's Markdown, as written), with the messages it answers | Formats it the way the service shows text (Telegram HTML, Slack mrkdwn, Discord Markdown, plain for SMS), splits it to the service's length, quotes or threads it, respects the service's rates |
| Reports errors, status, blocked questions, restarts | Tells the sender about an error; shows the rest, or not, the way that suits the service ("typing...", a note) |
| Knows no service by name | Ships its own commands (`check`, and any others it needs) |

If a channel needs something the port does not give, change the port for every channel, never the core for one service.

This page walks through the smallest channel, `channels/local/chat.ts` (the one behind `pi-personal chat`), then lists what Pi-personal gives a channel it runs for you, and the rules that keep messages from being lost or repeated.

## The worked example: `channels/local/chat.ts`

Open `channels/local/chat.ts` in the repository: a few dozen lines. You can run it by hand:

```sh
pi-personal chat main
```

which is the same as setting `PI_PERSONAL_PORT` to the output of `pi-personal port main` and running the file with Node.

**Setup.** The only input is `PI_PERSONAL_PORT`, the port folder. The channel picks a name for its conversation, `me`, unique to this process. It puts `me` in the `conversation` of every message it sends, and recognises replies by it: the agent answers one conversation at a time, and every reply carries the conversation it answers.

```ts
const port = process.env.PI_PERSONAL_PORT;
const me = `local:${process.pid}-${Date.now()}`;
```

**Sending.** One message is one JSON file in `inbox/`. The file is written under a temporary name starting with a dot (ignored by the agent), then hard-linked to `<id>.json`. The link is atomic and fails if the name exists, so the agent never sees half a file and an id can never be overwritten. Once the link exists, the message is accepted.

```ts
fs.writeFileSync(tmp, JSON.stringify({ id, text, conversation: me }));
fs.linkSync(tmp, path.join(port, "inbox", `${id}.json`));
fs.rmSync(tmp);
```

**Receiving.** `events.jsonl` only grows. The channel keeps its position, the byte offset where it stopped, starting at the current end (it shows only what comes next). On each poll it reads from there, keeps only complete lines (up to the last newline), and handles each event:

- a `message` event whose `refs` include its conversation (`r.conversation === me`) is printed;
- a `settled` event for its conversation that carries an `error` says the agent could not answer, and why (every message ends with one `settled`);
- an `error` event for its conversation says the message will be tried again (`retryAt`);
- a `status` event with `state: "blocked"` tells you the agent waits for a person in its terminal.

If the file is shorter than the offset, the owner replaced it by hand (while the agent was stopped): read the new one from its start.

**Wiring.** Each line you type is sent. The port folder is watched for changes, with a poll every 500 ms as a fallback, because file watching is not reliable everywhere.

That is a complete channel. What it leaves out, because it lives only as long as your terminal session, is what a supervised channel must add: a position saved to disk, identifiers that survive a restart, and `fsync` before the link.

## Running under Pi-personal

Turn the channel on with `pi-personal channel add <agent> <name> -- <command...>`, or declare it in the agent's `pi-personal.json` yourself, under a name of 1 to 9 characters (`a-z`, `0-9`, `-`, starting with a letter):

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

A running agent starts it at once (`channel add` runs `pi-personal up`); otherwise `pi-personal start <agent>` starts it, in its own Herdr Core terminal, `pi-personal-<agent>_mail`. To turn it off, set `"enabled": false` (its settings stay), or `pi-personal channel remove <agent> mail` (its settings go too); either way its terminal is stopped.

Use absolute paths in `command`. The program gets the `PATH` of whoever started the agent (your shell, or the login service, which records your `PATH` when you install it), and its working directory is its state folder.

It receives these environment variables:

| Variable | What it is |
|---|---|
| `PI_PERSONAL_PORT` | The agent's port folder |
| `PI_PERSONAL_STATE` | A private folder for this channel's own state (position, offsets, its guest list). Also the working directory. |
| `PI_PERSONAL_SECRETS` | The agent's secrets folder. A secret stored with `pi-personal secret set <agent> <key>` is the file `$PI_PERSONAL_SECRETS/<key>`. |
| `PI_PERSONAL_SETTINGS` | This channel's object from `pi-personal.json`, as JSON, as it was when the keeper last started the channel |
| `PI_PERSONAL_AGENT` | The agent's name |
| `PI_PERSONAL_CHANNEL` | The channel's name |

**Settings.** Everything in the channel's object besides `command` and `enabled` is yours, and `pi-personal channel add` keeps it (declare your settings before or after adding the channel). `PI_PERSONAL_SETTINGS` is read again each time the keeper starts the channel. Save files received for the agent under `PI_PERSONAL_STATE` (for example `$PI_PERSONAL_STATE/files`) and pass their paths as `attachments`. Keep what decides who may talk to the agent (a guest list) in `PI_PERSONAL_STATE`, not in the agent's folder: the folder is the agent's own working directory, which it edits.

**Secrets.** Read them from `PI_PERSONAL_SECRETS`. Never print them, never write them to the visible folder or to the port.

**Your own commands.** `pi-personal channel <agent> <channel> [args...]` runs your `command` with the extra arguments, exactly as given (options included), and the same environment. Use it for setup commands, like `pi-personal channel main telegram allow <id>`. The channel must be declared in `pi-personal.json` and not disabled (`"enabled": false`) for this to work. If your program answers `check` with one line per check, starting with `ok`, `note` or `FAIL`, `pi-personal channel <agent> <channel> check` runs it; `pi-personal doctor` runs `check` only for the channels that ship with Pi-personal, never a program of your own.

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

**Recognising your own replies.** Name each conversation `<your channel name>:<the service's own id>` (`telegram:4242`, `mail:alice@example.com`): that is its address. Every `message` event carries `refs`, the messages it answers, each with its `id`, its `conversation` and your `from`, unchanged. Route an answer by the prefix of its `conversation`, and keep in `from` only what you need to shape it (the message to quote, a thread to reply in). All the messages a reply answers belong to one conversation. A program can ask for an answer to go to one of your conversations with `pi-personal send <agent> "..." --conversation <your name>:<id>`: such a message has no `from`. Ignore replies whose `refs` are not yours; a reply to something typed in the agent's terminal has `refs: []`. Events about channels (`started`, `restarted`, `failed`, `stopped` with a `channel` field) are not replies.

**Who is speaking.** The agent sees your `text`, then the list of attachments, and nothing else. If several people can reach the agent through your channel, start the text with a line that says who wrote and where, by convention `From: <name> (<an id the person cannot change>) · <conversation>`, then a blank line; the default instructions tell the agent to answer that person and not to pass one person's words to another, and the conversation lets it send something there later.

## The keeper restarts you

Your channel is supervised like an agent:

- when it exits, for any reason, it is started again: after 0.5, 1, 2, 4, 8 seconds;
- after 5 failed starts within 10 minutes it is marked `failed` (`pi-personal status` shows the reason), then tried once an hour; staying up 10 minutes resets the count;
- a crashing channel never affects the agent or the other channels;
- on stop it gets SIGTERM (or SIGHUP when its terminal closes) and has 5 seconds.

So: assume you can be killed at any moment, which the rules above make safe. For a configuration error (a missing token), print one clear line to standard error and exit with a non-zero code; the keeper gives up after 5 tries and `pi-personal status` says so. Your standard output and error go to your Herdr Core terminal (its address is in `pi-personal status <agent>`; read it with `hc read <address>`); the keeper's own start and exit lines go to `pi-personal log <agent>`. After fixing the problem, `pi-personal restart <agent>` starts everything again (the agent's conversation continues).

## A larger example

The Telegram channel has the same structure plus what a real service needs: a guest list, long polling, formatting, quoting, splitting, rates. Its own page explains each: [channels/telegram/README.md](../channels/telegram/README.md).
