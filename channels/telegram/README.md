# The Telegram channel

A Pi-Personal channel: it connects one agent to a Telegram bot, by long polling (no public address needed). Everything Telegram does its own way lives here, never in the core: the guest list, formatting, quoting, "typing...", splitting, Telegram's rates.

## Set it up

`pp setup` offers it (step 4, "Reach it") and guides you: create a bot with @BotFather, paste its token (checked with Telegram before it is kept), write to the bot from your own Telegram account within 10 minutes, and say yes to let yourself in. That yes also makes you the agent's owner on Telegram: your messages reach it under a line "From: the owner, …", which no one else can get (`pp channel telegram owner` shows or changes it). The agent then answers that first message. The same, on its own: `pp channel telegram setup`, then `pp channel add telegram`.

## By hand, in 5 steps

**1. Create a bot.** In Telegram, open a chat with @BotFather, send `/newbot`, and follow the questions. It gives you a token that looks like `123456:ABC...`.

**2. Store the token** in the agent's private area:

```sh
pp secret set telegram-token
```

Paste the token and press Enter. It is not shown while you paste it, and never again. (You can also pipe it in: `pbpaste | pp secret set telegram-token`.) With several agents, name the agent after the command: `pp secret set main telegram-token`.

**3. Turn the channel on:**

```sh
pp channel add telegram
```

It says `channel telegram added and started` (the agent is running; otherwise it starts with the agent). This adds `"channels": { "telegram": { "enabled": true } }` to `pi-personal.json`.

**4. Write to your bot** from your phone. It does not answer: the Telegram channel obeys nobody until you allow someone. It records who wrote.

**5. Allow yourself.**

```sh
pp channel telegram who
pp channel telegram allow <your numeric id>
```

`who` lists the people who wrote to the bot without being allowed at the time, with their numeric Telegram id (they stay in the list after you allow them), then the ids currently allowed. `allow` adds an id to the channel's guest list, kept in the private area (not in the agent's folder); it applies at once, no restart needed. Write to the bot again: the bot shows "typing..." while the agent works, then answers. The message you sent before being allowed was not passed on. If the agent cannot answer (your provider refuses, for example), the bot says so.

**Guests share one agent.** Each message reaches the agent with a line naming who wrote it (their Telegram name and id), and the agent's default instructions tell it to answer that person and keep each person's words to themselves. But it is one agent with one memory: what one guest tells it, it knows when another writes, and a guest can ask it about anything it can reach. Allow only people you would hand a terminal on your machine, and set a spending limit at your model provider: Pi-Personal has no budget of its own.

To remove someone: `pp channel telegram deny <id>`.

**Commands, for the owner.** From your phone, in your private chat with the bot. Typing `/` shows them as a menu (in the owner's chat only: guests see none):

| Command | What it does |
|---|---|
| `/stop` | stop what the agent is doing now (messages waiting keep their turn) |
| `/new` | a fresh conversation |
| `/model [provider/id]` | its model: alone, the one in use and buttons for the others of its provider; given one, it changes to it |
| `/thinking [level]` | how much it thinks: alone, buttons for off, minimal, low, medium, high, xhigh, max |
| `/status` | how it is doing |
| `/restart` | restart the agent (the channel keeps running) |
| `/login <provider> <key>` | store an API key for a provider (pi's own sign-in with a key; one with an account stays in a terminal) |
| `/secret <name> <value>` | store a secret for the agent's channels |
| `/kit <words>` | the kit's commands, when a kit is installed |
| `/answer_<id>_<n>`, `/answer_<id> <text>` | answer a question of the agent: a question's options are buttons under it, which send these |
| `/help` | this list |

They are obeyed only from the owner, on the guest list, in a message that is not forwarded, and they never reach the agent; from anyone else they are refused in one line. The words of a free answer (`/answer_<id> <text>`) and of `/kit` reach Pi-Personal with their spaces and line breaks reduced to single spaces. Any other text starting with `/` goes to the agent as before. `/login` and `/secret` take the value in the same message: the channel deletes that message from the chat first, even when its form is wrong (and says so if Telegram would not let it), passes the value on standard input, and its answer repeats nothing of it. The value still went through Telegram: for a key you care about, the terminal is better (`pp login <provider>`), and a key sent where it should not have been is revoked.

Each reply to a command starts with a sign (📊 status, 🧠 model, 💭 thinking, ⏹ stop...); trouble starts with ⚠️. A run you stopped is told as "⏹ Stopped before an answer.", not as trouble.

What the Telegram channel does not do: groups (it answers private chats only), voice transcription, streaming replies. Files you send (photos, documents, voice, audio, video, up to Telegram's 20 MB bot limit) are saved in the private area and their paths given to the agent, and removed after 30 days. Files the agent sends you arrive as photos, voice notes, audio, video or documents.

## How it works

`telegram.ts` and its formatter `format.ts`, built on the port alone ([write-a-channel.md](../../docs/write-a-channel.md)): it imports nothing from the core.

- **Deny by default.** Before anything else, the sender's numeric id is checked against the guest list, `$PI_PERSONAL_STATE/allow.json`, re-read at each message. An unlisted sender's message never reaches the port. It is recorded once in `$PI_PERSONAL_STATE/unlisted.jsonl` and logged, so the owner can find their id with `who`. Nobody is ever added automatically. Only private chats are handled. Replies go only to chats on the guest list, even one asked for with `pp send --conversation telegram:<chat>`. Each message says who wrote it with the port's `sender`: the name the person chose, with their `@username` after it when they have one, and the id `Telegram user <id>`. The core writes it for the agent above the text, as `From: "<name> @username" (Telegram user <id>) · telegram:<chat>`, cleaned so that it can never pass for what the core writes; the channel writes no such line itself. The person who said "that is me" during the setup is the **owner** (`$PI_PERSONAL_STATE/owner`; the first one stays): their messages carry `owner: true` and read `From: the owner, "<name>" …`, and the agent changes its own settings for the owner only. `pp channel <agent> telegram owner` shows who it is; `owner <id>` (an id on the guest list) changes it. A forwarded message starts with `(Forwarded: written by "<name>", not by the sender.)`, so that it never reads as the request of whoever passed it on. If the list cannot be read, nothing is decided: updates stay unconfirmed and replies wait, so nothing is lost.
- **One chat, one conversation.** Each message says `conversation: "telegram:<chat id>"`, so the agent never mixes two people's messages in one reply.
- **Long polling.** `getUpdates` with a 30-second timeout: no public address, works behind a home router. The offset is saved after each update is in the port.
- **"typing...".** From the moment the agent takes a message in until its run settles (at most 10 minutes), the chat shows that the bot is typing.
- **Errors.** When the agent cannot answer (a `settled` event with an `error`: the model refused, the provider failed, the agent was stopped), the sender gets one short note saying so, quoting their message; a message that will be tried again (an `error` event) gets one note too.
- **Attachments.** Photos, documents, voice, audio and video are downloaded into `$PI_PERSONAL_STATE/files` (the channel's private folder) and passed as `attachments` paths. No transcription, no image analysis. Files there older than 30 days are removed when the channel starts: the agent copies what it wants to keep.
- **Files the agent sends** (`file` events for one of its chats, on the guest list only) are uploaded by kind, from the file's name: a photo (jpg, jpeg, png, webp), a voice note (ogg, oga), audio (mp3, m4a), video (mp4), a document otherwise, quoting the message they answer. One Telegram refuses as its kind goes again as a document. A file over 50 MB (a bot's limit), gone, or not a regular file when its turn comes is not sent, and the sender is told in one line; a failed upload never holds up what comes after it.
- **Formatting** (`format.ts`). The agent writes Markdown; Telegram shows a small HTML subset. Bold, italics, strikethrough, inline code, code blocks, links, headings and `- item` lists (shown with a bullet) are converted; text that only looks like Markdown keeps its characters (`snake_case`, `__init__.py`, `src/*.ts`, `2 * 3`, URLs with underscores). A code block cut between two pieces of a long reply is closed and opened again. If Telegram refuses a formatted piece, it is sent again as plain text, so a formatting mistake never loses a reply.
- **Quoting.** The first piece of a reply quotes the Telegram message it answers (taken from `from.message`, which the channel put there when it sent the message in).
- **Splitting.** Replies longer than 4,096 characters, counted in UTF-16 units as Telegram counts, are cut at a paragraph, then a line, then a sentence, then a space, never inside a character.
- **Rate limits.** About one message per second per chat and a small gap between any two sends. When Telegram answers 429, it waits the `retry_after` it was given. Network and server errors are retried with backoff up to 60 seconds. Another refusal from Telegram (for example a blocked chat) skips that reply and logs it.
- **The owner's commands** (`/stop`, `/new`...) run Pi-Personal's `pp remote <agent> -- <words>`, given to the channel as `PI_PERSONAL_REMOTE`, with `PI_PERSONAL_REMOTE_ID` set to `tg-<update_id>`, so that a command fetched twice (the channel restarted before it confirmed the update) stops a run once. What it prints is sent back, after the command's sign. A button tapped (a setting's choice, a question's option) carries the same command, obeyed as if the owner had typed it, with the same checks; its buttons are removed at once, so that one choice is made once. The menu is set with `setMyCommands` for the owner's chat, and taken from a former owner's. A command that runs more than two minutes (a kit's, which can be anything) is stopped, so that it never keeps the chat from being read for long; until then the channel reads no further update, so a `/stop` sent meanwhile waits behind a slow `/kit`.
- **The agent's questions** (an extension that asks its owner for an approval or a choice: `question` events) are shown in the owner's private chat, whatever conversation the run belongs to: "❓" and the question, with a button per option (it sends `/answer_<id>_<n>`), or the form for a free answer (`/answer_<id> <your text>`). These are owner's commands, like the ones above: a guest who taps one is refused. When the run is another chat's, the question names that conversation, and that chat is told in one line that the agent waits for its owner (never the question itself). The owner is told when a question closes without them: answered in the agent's terminal or elsewhere, no answer in time, the work it was asked for ended (finished or stopped), or the agent restarted. With no owner set (or the owner off the guest list), only the terminal or the time limit answers.
- **Its own commands.** `setup`, `who`, `allow <id>`, `deny <id>`, `owner [<id>]` and `check`, run through `pp channel [agent] telegram ...`. `pp doctor` runs its `check`, which prints one line per check, starting with `ok`, `note` or `FAIL`.
- **Fatal errors.** No token: exit 2. Token refused (401): exit 3.
- **`apiBase`.** An optional setting to use another Bot API server; the tests point it at a fake Telegram. It is read from `pi-personal.json`, which the agent edits, against the rule in [write-a-channel.md](../../docs/write-a-channel.md#running-under-pi-personal) (a setting that names a server belongs in the channel's private state): an agent talked into changing it would send the bot's token and messages to that server.
