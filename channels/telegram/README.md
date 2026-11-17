# The Telegram channel

A Pi-personal channel: it connects one agent to a Telegram bot, by long polling (no public address needed). Everything Telegram does its own way lives here, never in the core: the guest list, formatting, quoting, "typing...", splitting, Telegram's rates.

## Set it up

`pp setup` offers it, at its last step, and guides you: create a bot with @BotFather, paste its token, write to the bot from your own Telegram account, say yes to let yourself in. The agent then answers that first message. The same, on its own: `pp channel telegram setup`, then `pp channel add telegram`.

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

**Guests share one agent.** Each message reaches the agent with a line naming who wrote it (their Telegram name and id), and the agent's default instructions tell it to answer that person and keep each person's words to themselves. But it is one agent with one memory: what one guest tells it, it knows when another writes, and a guest can ask it about anything it can reach. Allow only people you would hand a terminal on your machine, and set a spending limit at your model provider: Pi-personal has no budget of its own.

To remove someone: `pp channel telegram deny <id>`.

What the Telegram channel does not do: groups (it answers private chats only), buttons, voice transcription, streaming replies. Files you send (photos, documents, voice, audio, video, up to Telegram's 20 MB bot limit) are saved in the private area and their paths given to the agent.

## How it works

`telegram.ts` and its formatter `format.ts`, built on the port alone ([write-a-channel.md](../../docs/write-a-channel.md)): it imports nothing from the core.

- **Deny by default.** Before anything else, the sender's numeric id is checked against the guest list, `$PI_PERSONAL_STATE/allow.json`, re-read at each message. An unlisted sender's message never reaches the port. It is recorded once in `$PI_PERSONAL_STATE/unlisted.jsonl` and logged, so the owner can find their id with `who`. Nobody is ever added automatically. Only private chats are handled. Replies go only to chats on the guest list, even one asked for with `pp send --conversation telegram:<chat>`. Each message starts with `From: <name> (Telegram user <id>, @username) · telegram:<chat>`. If the list cannot be read, nothing is decided: updates stay unconfirmed and replies wait, so nothing is lost.
- **One chat, one conversation.** Each message says `conversation: "telegram:<chat id>"`, so the agent never mixes two people's messages in one reply.
- **Long polling.** `getUpdates` with a 30-second timeout: no public address, works behind a home router. The offset is saved after each update is in the port.
- **"typing...".** From the moment the agent takes a message in until its run settles (at most 10 minutes), the chat shows that the bot is typing.
- **Errors.** When the agent cannot answer (a `settled` event with an `error`: the model refused, the provider failed, the agent was stopped), the sender gets one short note saying so, quoting their message; a message that will be tried again (an `error` event) gets one note too.
- **Attachments.** Photos, documents, voice, audio and video are downloaded into `$PI_PERSONAL_STATE/files` (the channel's private folder) and passed as `attachments` paths. No transcription, no image analysis.
- **Formatting** (`format.ts`). The agent writes Markdown; Telegram shows a small HTML subset. Bold, italics, strikethrough, inline code, code blocks, links, headings and `- item` lists (shown with a bullet) are converted; text that only looks like Markdown keeps its characters (`snake_case`, `__init__.py`, `src/*.ts`, `2 * 3`, URLs with underscores). A code block cut between two pieces of a long reply is closed and opened again. If Telegram refuses a formatted piece, it is sent again as plain text, so a formatting mistake never loses a reply.
- **Quoting.** The first piece of a reply quotes the Telegram message it answers (taken from `from.message`, which the channel put there when it sent the message in).
- **Splitting.** Replies longer than 4,096 characters, counted in UTF-16 units as Telegram counts, are cut at a paragraph, then a line, then a sentence, then a space, never inside a character.
- **Rate limits.** About one message per second per chat and a small gap between any two sends. When Telegram answers 429, it waits the `retry_after` it was given. Network and server errors are retried with backoff up to 60 seconds. Another refusal from Telegram (for example a blocked chat) skips that reply and logs it.
- **Its own commands.** `setup`, `who`, `allow <id>`, `deny <id>` and `check`, run through `pp channel [agent] telegram ...`. `pp doctor` runs its `check`, which prints one line per check, starting with `ok`, `note` or `FAIL`.
- **Fatal errors.** No token: exit 2. Token refused (401): exit 3.
- **`apiBase`.** An optional setting to use another Bot API server; the tests point it at a fake Telegram.
