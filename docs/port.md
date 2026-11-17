# The port, version 1

The port is the only way into and out of a Pi-personal agent. Every channel, script and extension that talks to an agent uses it. It is a folder of plain files: you can read it with `ls` and `cat`, and write a client for it in any language in an afternoon.

```
<port>/
  version           the protocol version, "1"
  inbox/            messages waiting for the agent, one file each
  taken/            messages the agent has taken in
  rejected/         files that were not valid messages, set aside
  events.jsonl      everything the agent says and does, one JSON object per line; it only grows
```

`pp port <agent>` prints the folder. A program started by Pi-personal as a channel receives it in `PI_PERSONAL_PORT`.

**Trust.** Anyone who can write to the port can drive the agent, and the agent can do anything your user account can do. The port is protected only by file permissions: it lives in Pi-personal's private area (mode `0700`), readable by your user alone, the same trust boundary as Herdr Core's own socket. Pi-personal adds no authentication on top. Deciding who may talk to an agent is each channel's job.

## Sending a message

Write one JSON file into `inbox/`, named after the message's identifier:

```json
{
  "id": "tg-271828",
  "text": "Can you check the build?",
  "attachments": ["/home/me/.local/state/pi-personal/agents/main/channels/telegram/files/photo-1.jpg"],
  "from": { "message": 77 },
  "conversation": "telegram:4242"
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Chosen by you. 1 to 128 characters from `A-Z a-z 0-9 . _ -`, not starting with a dot. The file name is `<id>.json`. Sending the same `id` twice has the effect of sending it once. |
| `text` | yes | The message. May be empty if there are attachments. |
| `attachments` | no | Absolute paths of files the agent should look at. They are given to the agent as paths; Pi-personal does not read, convert or delete them. |
| `from` | no | The channel's own data about the message (for example the message to quote in the answer): any JSON object of at most 4 KB. Pi-personal stores it and gives it back, unchanged, on the events that answer this message; it never reads it. It is not an address: `conversation` is. |
| `conversation` | no | Which conversation the message belongs to, and so where its answer goes: a string of up to 200 characters, the same for every message of one conversation, `<channel>:<the service's own id>` (`telegram:4242`, `mail:alice@example.com`). The channel that owns the prefix routes the answers. The agent answers one conversation at a time: a reply never mixes two of them. Messages without it all belong to one shared conversation. |

**Write it atomically**, so the agent never sees half a file:

1. write the JSON to a temporary file whose name starts with a dot, in `inbox/` (for example `inbox/.tg-271828.tmp`), and flush it to disk;
2. create `inbox/<id>.json` from it **exclusively**: a hard link (`link`), which fails if the name exists, then remove the temporary file. A `rename` also works when you have checked that neither `inbox/<id>.json` nor `taken/<id>.json` exists.

Once the file is in `inbox/`, the message is **accepted**: it will reach the agent, whatever crashes. Tell your sender it was received only after this step. The file itself is the receipt of acceptance: there is no `accepted` event, because the writer cannot append it atomically with the link, and an event that could be missing would be a worse receipt than the file.

Files whose name starts with a dot, and anything that is not a regular file, are ignored. A file that does not parse is given a few seconds (it may still be being written), then, if it still is not a valid message (valid JSON, a valid `id` matching its name, a `text`), it is moved to `rejected/` and reported with a `rejected` event. Its `id` stays free: send a corrected message with the same `id` and it is accepted.

**Order.** Messages are given to the agent one at a time, oldest first (modification time, then name). Within one conversation, a message never overtakes an earlier one; a message waiting to be tried again does not hold up the other conversations. The order follows the files' times: a clock set back while messages wait can reorder them. A file dated more than a minute in the future is judged at once (valid, or set aside), never kept waiting as "still being written".

**Withdrawing a message.** Delete `inbox/<id>.json` while it waits. If the agent took it in meanwhile, it runs and ends with its `settled` as usual.

**Duplicates.** If `taken/<id>.json` exists, or the agent's conversation already holds that message, a new file with the same `id` is dropped and reported with a `duplicate` event. Resending after a crash is therefore always safe. Identifiers are remembered for the life of the agent's conversation; files in `taken/` and `rejected/` older than 30 days are removed at each start of the agent.

## Reading what the agent says

`events.jsonl` only grows. Each line is one JSON object with at least `at` (an ISO 8601 time) and `type`. Parse it as JSON; do not rely on the order of its fields.

**Position.** An event's position is the byte offset where its line starts. To follow the agent, read from the offset where you stopped, handle each complete line (one that ends with a newline), and remember the offset after the last line you handled. After a restart, start from there: you will see nothing twice and miss nothing. A new reader starts at the current end of the file, to see only what comes next.

**Keeping it small.** Pi-personal never cuts or moves the file (it grows by about a kilobyte per message). To start a new one, stop the agent (`pp stop`, which stops its channels too) and move `events.jsonl` aside: a reader whose offset is past the end of the file reads the new file from its start.

### Event types

| `type` | Fields | Meaning |
|---|---|---|
| `taken` | `id`, `refs` | The agent took the message in (its run starts). Its file moved to `taken/`. |
| `duplicate` | `id` | A message with an identifier already taken was dropped. |
| `rejected` | `id`, `reason` | A file that is not a valid message was set aside in `rejected/`. |
| `input` | `source`, `text` | Someone typed a message in the agent's terminal (`source: "terminal"`). |
| `message` | `text`, `refs` | One text message from the agent. Every one is reported, not only the last of a run. |
| `error` | `error`, `refs`, and `retryAt` when it will be tried again | Trouble that does not end the message's run: the message was not taken in yet and will be tried again at `retryAt`. `refs` is empty when the trouble concerns no message in particular (the bridge itself). |
| `settled` | `refs`, and `error` when the message got no full reply | The last word of a run: the agent finished with this message and will not continue by itself. `error` says why (the provider refused, the run ended without an answer or was cut short, the agent was stopped on purpose, the owner took over in the terminal); its text is for people, not a contract. A run started by text typed in the terminal settles with `refs: []`. Match a `settled` to your message by its `refs`. |
| `status` | `state`, and `kind`, `question` when blocked | `working`, `idle` or `blocked`. When blocked, `kind` is what pi waits for: `select`, `confirm`, `input`, `editor` or `custom`. |
| `started` | `pid`, `safeMode` | The agent's session is up and reading the port. `safeMode` lists the agent's extensions turned off (safe mode), or is `null`. |
| `restarted` | `reason` | The keeper is starting the agent again, and why. |
| `safe_mode` | `extensions`, `off`, `reason` | `extensions` failed to load, so the agent runs with only Pi-personal's bridge: every extension listed in `off` (and any pi finds by itself) is turned off. Safe mode ends at the next start once they load again. |
| `failed` | `reason`, `retryAt` | The agent failed to start too many times. The keeper will try again at `retryAt`. |
| `stopped` | | The agent was stopped on purpose. |

Events about a channel rather than the agent carry `"channel": "<name>"` (for example a channel that restarted, failed or stopped).

**`refs`** lists the messages a reply answers: `[{ "id": "tg-271828", "from": { ... }, "conversation": "telegram:4242" }]`, with `from` and `conversation` exactly as you sent them. All the messages of one reply belong to one conversation. A channel recognises its own replies by its `from` (or its `conversation`, or its `id`s) and ignores the others. A reply to something typed in the terminal has `refs: []`; whether to forward it anywhere is the channel's choice.

**One message, one run, one last word.** The agent works on one message at a time; a message that arrives meanwhile waits its turn (see Order). Each message ends with a `settled` event naming it: with its replies (`message` events) before it, or with an `error` on it when there was none. Tell the sender: silence is the worst answer.

**`blocked`.** When the agent waits for a person (a permission or a question), the `status` event says `state: "blocked"` with the `kind` and, when the harness gives it, the `question` text. Pi-personal never answers. Messages sent meanwhile wait in `inbox/` and are taken in once the agent can read them.

New event types and fields may appear in later versions of protocol 1. Ignore what you do not know.

## Room for extensions

The port is open to extensions without any change to the core:

- **Names containing a dot belong to extensions**, except those starting with `pi-personal.`, which are the core's. An event whose `type` contains a dot (`telegram.react`, `voice.delta`, `myext.progress`), a folder of the port whose name contains a dot, a field whose name contains a dot: Pi-personal never writes, reads or removes them. Any program may append such an event to `events.jsonl`: one JSON line, written in one `write` to the file opened for appending. Pick a prefix of your own.
- **Inside the agent.** A pi extension (in the agent's `.pi/extensions/`) runs inside the agent's session, with `PI_PERSONAL_PORT` set. Each port message reaches the session as a custom message, `customType: "pi-personal.message"`, with `details: { id, from?, conversation? }`; text typed in the terminal is a user message. With pi's own extension API it can watch a reply as it forms, add a tool, stop a run, and write its own events to the port. A channel and such an extension make a pair: streaming for a voice call, reactions, a "stop" from the phone, a file sent back. The same rule holds there: custom message types and session entries named `<prefix>.<name>` belong to the extension that chose the prefix; `pi-personal.` is the bridge's.

An ability joins the port itself (as a new optional field or event) only once such a pair has proven it, and then only by addition.

## The smallest client

```sh
pp send main "hello"                         # submit, print the id
pp send main "hello" --wait                  # submit, wait, print the answer (exit 1 on an error)
pp send main "the build is green" --conversation telegram:4242   # the answer goes to that Telegram chat
pp follow main                               # print events as they arrive
```

Anything that can run a command can talk to an agent this way: a cron job, a script, another agent.

## Versions

`version` holds `1`. Within version 1, Pi-personal only adds: new event types, new optional fields. A change that would break an existing client gets a new version number and a new folder layout.
