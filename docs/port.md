# The port, version 1

The port is the only way into and out of a Pi-Personal agent. Every channel, script and extension that talks to an agent uses it. It is a folder of plain files: you can read it with `ls` and `cat`, and write a client for it in any language in an afternoon.

```
<port>/
  version           the protocol version, "1"
  inbox/            messages waiting for the agent, one file each
  taken/            messages the agent has taken in
  rejected/         files that were not valid messages, set aside
  events.jsonl      everything the agent says and does, one JSON object per line; it only grows
```

`pp port <agent>` prints the folder. A program started by Pi-Personal as a channel receives it in `PI_PERSONAL_PORT`.

**Trust.** Anyone who can write to the port can drive the agent, and the agent can do anything your user account can do. The port is protected only by file permissions: it lives in Pi-Personal's private area (mode `0700`), readable by your user alone, the same trust boundary as Herdr Core's own socket. Pi-Personal adds no authentication on top. Deciding who may talk to an agent is each channel's job.

## Sending a message

Write one JSON file into `inbox/`, named after the message's identifier:

```json
{
  "id": "tg-271828",
  "text": "Can you check the build?",
  "attachments": ["/home/me/.local/state/pi-personal/agents/main/channels/telegram/files/photo-1.jpg"],
  "from": { "message": 77 },
  "conversation": "telegram:4242",
  "sender": { "name": "Emi @emi", "id": "Telegram user 4242", "owner": true }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Chosen by you. 1 to 128 characters from `A-Z a-z 0-9 . _ -`, not starting with a dot. The file name is `<id>.json`. Sending the same `id` twice has the effect of sending it once. |
| `text` | yes | The message. May be empty if there are attachments; always empty on a control message. |
| `attachments` | no | Absolute paths of files the agent should look at. They are given to the agent as paths; Pi-Personal does not read, convert or delete them. |
| `from` | no | The channel's own data about the message (for example the message to quote in the answer): any JSON object of at most 4 KB. Pi-Personal stores it and gives it back, unchanged, on the events that answer this message; it never reads it. It is not an address: `conversation` is. |
| `conversation` | no | Which conversation the message belongs to, and so where its answer goes: a string of up to 200 characters, the same for every message of one conversation, `<channel>:<the service's own id>` (`telegram:4242`, `mail:alice@example.com`). The channel that owns the prefix routes the answers. The agent answers one conversation at a time: a reply never mixes two of them. Messages without it all belong to one shared conversation. (`pp send` writes `cli` unless `--conversation` says otherwise.) |
| `sender` | no | Who wrote the message, when a person did: `{ "name"?, "id"?, "owner"? }`. `name` (a string) is whatever that person chose: a display name, a handle, which they can change. `id` (a string) is the service's own stable identifier for that person and nothing else (`Telegram user 4242`). `owner` (a boolean) is `true` only for the agent's owner, as your channel knows it. A message without `sender` comes from a program, or from a channel that names nobody: the agent reads it as a report, never as its owner's request. See "What the agent reads" below. |
| `control` | no | A word for Pi-Personal itself rather than for the agent, at most 32 characters: `interrupt` or `answer`. See "Control messages" below. `text` is then `""`, `attachments` are refused, and `sender` is ignored. |
| `question` | no | With `"control": "answer"`: the id of the question answered (at most 128 characters). |
| `answer` | no | With `"control": "answer"`: the answer, at most 4,000 characters. |
| `wake` | no | `false`: tell without waking the agent. The message starts no run: its text is said to its `conversation` at once, and the agent's conversation keeps it for later. See "Telling without waking" below. A message with `wake: false`, no `conversation` and a `note` of `""` would do nothing, and is refused. |
| `note` | no | With `"wake": false`: what the agent's conversation keeps instead of the text (what the agent should know rather than what the person reads: a line and a path rather than three pages). `""` keeps nothing: the message is then only said. |

**Write it atomically**, so the agent never sees half a file:

1. write the JSON to a temporary file whose name starts with a dot, in `inbox/` (for example `inbox/.tg-271828.tmp`), and flush it to disk;
2. create `inbox/<id>.json` from it **exclusively**: a hard link (`link`), which fails if the name exists, then remove the temporary file. A `rename` also works when you have checked that neither `inbox/<id>.json` nor `taken/<id>.json` exists.

Once the file is in `inbox/`, the message is **accepted**: it will reach the agent, whatever crashes. Tell your sender it was received only after this step. The file itself is the receipt of acceptance: there is no `accepted` event, because the writer cannot append it atomically with the link, and an event that could be missing would be a worse receipt than the file.

**What the agent reads.** Above the message's text, the bridge, and nobody else, writes a header:

```
From: the owner, "Emi @emi" (Telegram user 4242) · telegram:4242
Sent: Saturday 2026-11-21 21:04 UTC+01:00

Can you check the build?
```

`From:` is there only when the message has a `sender`, each part only when present: `the owner` (when `owner` is `true`), the name in quotes, the id in parentheses, the conversation; a sender with nothing to show reads `From: someone`. `Sent:` is always there: when the file entered the inbox, in the agent's own time zone (the agent has no other clock). The name and the id are cleaned before they are printed, and before they are stored beside the message: control characters and line ends become a space, characters that cannot be seen (zero-width, direction marks) are removed, quotes and brackets become spaces, and they are cut to 64 and 100 characters. So nothing a person chose can pass for what the bridge writes, and the agent's rule is simple: a request is its owner's when it was typed in its terminal (no header at all) or when its header starts with `From: the owner`. A `From:` line your channel writes into `text` itself comes below the header, where it is only text someone wrote.

Files whose name starts with a dot, and anything that is not a regular file, are ignored. A file that does not parse is given a few seconds (it may still be being written), then, if it still is not a valid message (valid JSON, a valid `id` matching its name, a `text`, fields of the types above), it is moved to `rejected/` and reported with a `rejected` event. Its `id` stays free: send a corrected message with the same `id` and it is accepted.

**Order.** Messages are given to the agent one at a time, oldest first (modification time, then name); a control message (below) waits for nothing, and neither does a message told without waking. Within one conversation, a message never overtakes an earlier one; a message waiting to be tried again does not hold up the other conversations. The order follows the files' times: a clock set back while messages wait can reorder them. A file dated more than a minute in the future is judged at once (valid, or set aside), never kept waiting as "still being written".

**Withdrawing a message.** Delete `inbox/<id>.json` while it waits. If the agent took it in meanwhile, it runs and ends with its `settled` as usual.

**Control messages.** A message with `control` is done by the bridge as soon as it sees the file, whatever the agent is doing: it never waits behind a run, never reaches the model and is never written into the conversation. It is then moved to `taken/` and gets `taken` and `settled` at once: `settled` carries `result`, a short sentence, when it was done, and `error` when it was not. Its `text` is empty, and it carries no attachments, so that a core older than 0.5, which knows no `control`, sets it aside as invalid (`rejected`) instead of showing it to the agent. A control message is good only now: a file older than 15 seconds when the bridge first sees it (the agent was down or starting) does nothing and is settled with the error "came too late; nothing was done". A word the agent does not know is settled with an error. Duplicates are dropped as for any message, but its identifier is remembered only as long as its file in `taken/` is kept (30 days), not for the life of the conversation: it is never written into it. To be sure that a control message you gave up waiting for never takes effect later, withdraw it (above): `pp interrupt` and `pp answer` do, also when they are stopped with Ctrl+C. A file withdrawn at the very moment the bridge does it is still settled: look for its `settled` a moment after withdrawing.

- `"control": "interrupt"` stops the run in progress (the agent is working, or a message was just handed to it): its `result` is "asked the run to stop", and the run's own `settled` says that it stopped, with its error. When nothing runs, the `result` is "nothing was running". Every question waiting (below) is answered with none (`answered` with `by: "interrupted"`). Messages waiting in `inbox/` are untouched and get their turn. An in-agent extension that started work of its own may add a line to the `result` (see "Room for extensions"). A run waiting in another extension's dialog (`blocked`) does not end this way: answer it in the terminal.
- `"control": "answer"` answers a question of the agent (a `question` event): `"question": "<its id>"`, `"answer": "<text>"`. When the question has `options`, the answer is one of them, by its number from 1 (read first, since every display numbers the options) or its text (case ignored); otherwise it is the text as it is. Its `result` is `answered <id>`. A question that does not wait any more (answered already, timed out, closed by a restart, or never asked) is settled with the error "that question is closed"; an answer that fits no option is settled with an error naming the options, and the question keeps waiting. (`pp answer` typed at the machine finds the question itself when only one waits.)

**Telling without waking.** A message with `"wake": false` starts no run: a reminder, a report the agent should know of, a reply a program wants to give without the model. If it has a `conversation`, its `text` is said there as soon as the bridge sees the file, whatever the agent is doing: a `message` event whose `refs` name the message itself, then a `file` event for each of its `attachments` (checked as the agent's own files are: one that may not be sent gets an `error` event naming it instead). What the agent's conversation keeps of it, its `note` when given, else its text and the paths of its attachments, is stored when the agent is idle, in its turn, without starting a run; the agent reads it with the next message it is given, under one line in parentheses, `(Said to <conversation> without waking you.)` or, without a conversation, `(A note left for you.)`, then the header of any message. It is never a run's message, and the agent's replies never answer it. Then the message gets `taken` and `settled`, and its file moves to `taken/`. While a new agent, or a fresh conversation, has not answered its first message yet, nothing is stored: the message waits in `inbox/` for that part (it holds up no other message, not even one of its own conversation), and is stored once the agent has answered. Until its file has moved, something is still owed: after a crash in between, it is said again (twice rather than lost), and stored once. If the agent cannot record it, an `error` event with `retryAt` says so and it is tried again. A core older than 0.5 knows no `wake`: it gives the message to the agent as any other.

**Questions.** An in-agent extension can ask the agent's owner a question through Pi-Personal (an approval, a choice: see "Room for extensions"). It is shown in the agent's terminal, when it has a screen, and said on the port as a `question` event: `id`, `title` (up to 4,000 characters, line breaks allowed), `options` when the answer is one of them, `until` (when it stops waiting) and `refs` (the open run's messages; empty outside a run). The first answer wins: the one typed in the terminal, or a control message `answer`. After `until` there is none. Then an `answered` event says who answered (`by`: `terminal`, `port`, `timeout`, or `interrupted` for an interrupt or the end of the run it was asked for), and the other side is closed. A `started`, `stopped` or `restarted` event of the agent closes every question asked before it: no `answered` follows. **Answering is the owner's act**, whatever conversation the run belongs to: show a question to the agent's owner only, as your channel knows them, and pass on only their answer. A question for the person the agent is answering is asked by the model itself, in its reply.

**Duplicates.** If `taken/<id>.json` exists, or the agent's conversation already holds that message, a new file with the same `id` is dropped and reported with a `duplicate` event. Resending after a crash is therefore always safe. Identifiers are remembered for the life of the agent's conversation, a message told without waking's too when its conversation kept something (a control message's, and one that kept nothing, 30 days: see above); after a fresh conversation (`pp new`), the identifiers taken before it are remembered by their files in `taken/` only, 30 days; files in `taken/` and `rejected/` older than 30 days are removed at each start of the agent.

## Reading what the agent says

`events.jsonl` only grows. Each line is one JSON object with at least `at` (an ISO 8601 time) and `type`. Parse it as JSON; do not rely on the order of its fields.

**Position.** An event's position is the byte offset where its line starts. To follow the agent, read from the offset where you stopped, handle each complete line (one that ends with a newline), and remember the offset after the last line you handled. After a restart, start from there: you will see nothing twice and miss nothing. A new reader starts at the current end of the file, to see only what comes next.

**Keeping it small.** Pi-Personal never cuts or moves the file (it grows by about a kilobyte per message). To start a new one, stop the agent (`pp stop`, which stops its channels too) and move `events.jsonl` aside: a reader whose offset is past the end of the file reads the new file from its start.

### Event types

| `type` | Fields | Meaning |
|---|---|---|
| `taken` | `id`, `refs` | The agent took the message in (its run starts). Its file moved to `taken/`. For a control message, or one told without waking, there is no run: its `settled` follows at once; the file of one told without waking moves to `taken/` only after its `settled` (until then, its file in `inbox/` is the mark that something is still owed). |
| `duplicate` | `id` | A message with an identifier already taken was dropped. |
| `rejected` | `id`, `reason` | A file that is not a valid message was set aside in `rejected/`. |
| `input` | `source`, `text` | A message was entered in the agent's terminal (`source: "terminal"`): typed by someone, or by Herdr Core, whose notes about a terminal the agent started come as one block `<hc ...>...</hc>`. |
| `message` | `text`, `refs` | One text message from the agent. Every one is reported, not only the last of a run. Its `text` is never empty. A message told without waking is said this way too: its own text, with `refs` naming itself. |
| `file` | `path`, `refs` | The agent sent a file to the person it answers (with the bridge's tool `attach_file`). `path` is the file's absolute real path on the agent's machine: upload it the way your service does, or say where it is. It counts as a reply. Read it when the event comes: the agent may change or remove it later. After a crash between the event and the agent's session, the resumed run may send it again (twice, never lost). |
| `error` | `error`, `refs`, and `retryAt` when it will be tried again | Trouble that does not end the message's run: the message was not taken in yet and will be tried again at `retryAt`. `refs` is empty when the trouble concerns no message in particular (the bridge itself). An `error` without `retryAt` about an attachment of a message told without waking is final: that file is not sent, and only its name is given. |
| `settled` | `refs`, and `error` when the message got no full reply; for a control message, `result` or `error` | The last word of a run: the agent finished with this message and will not continue by itself. `error` says why (the provider refused, the run ended without an answer or was cut short, the agent was stopped on purpose, a new conversation was started (`pp new`), the owner took over in the terminal); its text is for people, not a contract. A run started by text typed in the terminal settles with `refs: []`. Match a `settled` to your message by its `refs`. A control message has no run: its `settled` comes at once, with the `result` (what was done) or the `error`. |
| `status` | `state`, and `kind`, `question` when blocked | `working`, `idle` or `blocked`. When blocked, `kind` is what pi waits for: `select`, `confirm`, `input`, `editor` or `custom`. |
| `question` | `id`, `title`, `options` when the answer is one of them, `until`, `refs` | The agent's owner is asked a question by an in-agent extension. Answer it with a control message `answer`, or let it be. See "Questions" above. |
| `answered` | `id`, `by`, `refs` | The question was answered or closed: `by` is `terminal`, `port`, `timeout` or `interrupted` (the extension that asked got no answer). |
| `started` | `pid`, `safeMode`, `core`, or `pid`, `channel` | The agent's session is up and reading the port. `safeMode` lists the entries of the agent's `.pi/extensions/` turned off (safe mode, when pi's packages and built-in extensions are off too), or is `null`: a channel that wants to serve only its owner while an extension is off can. `core` is the version of Pi-Personal: a `started` without it comes from a core older than 0.5, which knows no `sender`. With `channel`: that channel's program started. |
| `restarted` | `reason` | The keeper is starting the agent again, and why; or a command restarts the agent's terminal to apply a change (`pp new`, `pp model`, `pp thinking`), and its `reason` says which. |
| `safe_mode` | `extensions`, `off`, `reason` | `extensions` failed to load, so the agent runs in safe mode: the entries of `.pi/extensions/` listed in `off` are turned off (those that fail, or all of them when the agent runs with Pi-Personal's bridge alone), the others stay on, and pi's packages and built-in extensions are off. `reason` says why and what it costs: an extension that is off enforces nothing meanwhile. Another `safe_mode` comes when what is off changes. Safe mode ends at the next start once everything loads again. |
| `failed` | `reason`, `retryAt` | The agent failed to start too many times. The keeper will try again at `retryAt`. |
| `stopped` | | The agent was stopped on purpose. |

Events about a channel rather than the agent carry `"channel": "<name>"` (for example a channel that restarted, failed or stopped).

**`refs`** lists the messages a reply answers: `[{ "id": "tg-271828", "from": { ... }, "conversation": "telegram:4242" }]`, with `from` and `conversation` exactly as you sent them. All the messages of one reply belong to one conversation. A channel recognises its own replies by its `from` (or its `conversation`, or its `id`s) and ignores the others. A reply to something typed in the terminal has `refs: []`; whether to forward it anywhere is the channel's choice.

**One message, one run, one last word.** The agent works on one message at a time; a message that arrives meanwhile waits its turn (see Order). Each message ends with a `settled` event naming it: with its replies (`message` and `file` events) before it, or with an `error` on it when there was none. A control message is not a run: its `taken` and `settled` come at once, even while a run goes on. A message told without waking is not a run either: its `message` (and `file`) events come at once, its `taken` and `settled` once its conversation kept it. Tell the sender: silence is the worst answer.

**`blocked`.** When the agent waits for a person in its terminal (a dialog of one of pi's extensions, a permission for example, or a question of Pi-Personal's own), the `status` event says `state: "blocked"` with the `kind` and, when the harness gives it, the `question` text. A question asked through Pi-Personal (a `question` event) can be answered from the port. Another extension's dialog cannot: pi does not say who asked, and Pi-Personal never answers it. While the agent waits only for such a dialog (one is open, and none of Pi-Personal's own questions waits), each message it holds up gets one `error` event naming it, without `retryAt` and without the question's text, which may belong to another conversation: "the agent waits for an answer in its terminal before it can go on" for the run's message, "... before it can read this message" for each message waiting in `inbox/`. They are taken in once the agent can read them.

New event types and fields may appear in later versions of protocol 1. Ignore what you do not know.

## Room for extensions

The port is open to extensions without any change to the core:

- **Names containing a dot belong to extensions**, except those starting with `pi-personal.`, which are the core's. An event whose `type` contains a dot (`telegram.react`, `voice.delta`, `myext.progress`), a folder of the port whose name contains a dot, a field whose name contains a dot: Pi-Personal never writes, reads or removes them. Any program may append such an event to `events.jsonl`: one JSON line, written in one `write` to the file opened for appending. Pick a prefix of your own.
- **Inside the agent.** A pi extension (in the agent's `.pi/extensions/`) runs inside the agent's session. It is given `PI_PERSONAL_PORT` (the port), `PI_PERSONAL_AGENT` (the agent's name), `PI_PERSONAL_SECRETS` (the agent's secrets folder) and `PI_PERSONAL_STATE`, a private folder for the state of in-agent extensions (`agents/<name>/extensions/`, mode `0700`, there before the extension loads; by convention each keeps its files in a subfolder of its own name). A load check (`pp ext check`, safe mode's checks) gives the same values, except a throwaway port. Each port message reaches the session as a custom message, `customType: "pi-personal.message"`, with `details: { id, from?, conversation?, attachments?, sender? }` (`sender` cleaned, as the header shows it); what is kept of a message told without waking is a custom message `pi-personal.note`, with `details: { id, from?, conversation?, sender? }`, which opens no run; text typed in the terminal is a user message. With pi's own extension API it can watch a reply as it forms, add a tool, stop a run, and write its own events to the port. A channel and such an extension make a pair: streaming for a voice call, reactions. The same rule holds there: custom message types and session entries named `<prefix>.<name>` belong to the extension that chose the prefix; `pi-personal.` is the bridge's.

- **Who a run is for.** The one way for an extension to learn it is to ask the bridge, on pi's own bus: `const q = {}; pi.events.emit("pi-personal.who", q);`. When the call returns, `q.run` is `{ refs, conversation?, sender?, typed }` for the open run, or is not set when no run is open. `refs` are the port messages the run answers (empty for a run started in the terminal), `conversation` and `sender` those of its message, and `typed` is `true` once the owner typed in the terminal: the rest of that run is theirs. It answers from `before_agent_start` on, for a run resumed after a crash too, and in safe mode to an extension kept on. A run with no `sender` and not `typed` belongs to a program. This is a fact carried, not a permission: what a guest may do is the extension's decision.
- **A question for the owner.** An extension that needs its owner (an approval, a choice) asks Pi-Personal, on pi's bus: `pi.events.emit("pi-personal.ask", { title, options, timeoutMs, resolve })`. `title` is text of up to 4,000 characters, line breaks allowed (an approval shows what it approves); `options` an optional list of strings (the answer is then one of them; without it, free text); `timeoutMs` how long to wait (5 minutes by default); `resolve(answer)` is called once, with the answer, or `undefined` when none came (the time limit, an interrupt, the end of the run, a restart). Pi-Personal sets `taken: true` on the object before `emit` returns: an extension that finds it unset is not running under Pi-Personal, and uses pi's own dialog or takes the answer as no. The question is shown in the terminal and said on the port ("Questions" above), so that a channel can show it to the owner.
- **An interrupt.** Each interrupt (a control message, `pp interrupt`) is said on pi's bus before the bridge stops the run, and also when no run is in progress: `pi.events.on("pi-personal.interrupt", (e) => { ... })`. An extension that started work of its own (helper sessions, a long download) stops it, and may add one line to the result the sender reads with `e.say("...")`, during the call.

An ability joins the port itself (as a new optional field or event) only once such a pair has proven it, and then only by addition.

## The smallest client

```sh
pp send main "hello"                         # submit, print the id
pp send main "hello" --wait                  # submit, wait, print the answer (exit 1 on an error)
pp send main "the build is green" --conversation telegram:4242   # the answer goes to that Telegram chat
pp send main "Call Bob at 5" --no-wake --conversation telegram:4242   # said there now; the agent is not woken
pp send main "the backup ran" --no-wake      # a note the agent reads with its next message
pp interrupt main                            # stop what it is doing now; prints what was done
pp answer main "yes"                         # answer the question it asks (--question <id> when several wait)
pp follow main                               # print events as they arrive
```

Anything that can run a command can talk to an agent this way: a cron job, a script, another agent.

## Versions

`version` holds `1`. Within version 1, Pi-Personal only adds: new event types, new optional fields. A change that would break an existing client gets a new version number and a new folder layout.
