# 0003 — How the bridge hands messages to pi

Status: accepted (2026-11-16). *Amended in 0.5 ([0004](0004-what-the-core-carries.md)): the model reads a port message under a header the bridge alone writes (`From:`, `Sent:`); a control message is done at once and never placed in the session; a message told without waking is placed as a `pi-personal.note`, which starts no run and counts for duplicates, never in `openWork`; a file sent with `attach_file` counts as a reply.*

## Decision

1. **A port message goes into pi as a custom message**, `customType: "pi-personal.message"`, with the port id (and the sender's `from`) in its `details`. The model reads custom messages as user messages; pi stores `details` with the entry in the session file. The session therefore says, by itself and exactly, which port messages were taken in.
2. **The bridge keeps its own queue, the port's inbox, and hands a message to pi only at the moment pi reads it:**
   - pi idle: the oldest message starts a run (`sendMessage` with `triggerTurn`); **one port message per run**;
   - pi working: messages wait in the inbox, in the order docs/port.md gives.
3. **"Taken" means stored.** A message is moved to `taken/` and reported `taken` only once its entry is in the session file on disk (and after an `fsync` of that file). Until then it stays in the inbox, so a crash at any point either leaves it in the inbox (handed again) or in the session (recognised by its id at the next start, and moved).
4. **Cut-off work is resumed; stopped work is closed.** The bridge writes `pi-personal.settled` at the end of every run (finished, failed, or aborted by a person), and `pi-personal.stopped` when pi gets a stop signal while the user's `stopped` mark exists (a stop on purpose); it then tells the senders of unanswered messages. What pi writes after `pi-personal.stopped` (the end of an aborted step) belongs to the stopped run. At startup, a branch whose last run, after the last of these marks, does not end on a finished answer was cut off (a crash, a closed terminal, a reboot): the bridge first asks the agent to continue it, with one visible note, then hands what waited. If the user stopped the agent while pi was down, `pp start` leaves a one-shot `was-stopped` mark, and the bridge closes that run instead of resuming it.

## Why

The first design handed port messages as user messages and recognised them by a hash of their text, with a receipt entry written just before. Each failure, reproduced against pi 1.5.2, showed what that cost:

- a message reported `taken` before pi had stored it could be lost by a crash in between;
- any extension that rewrites input made a message repeat forever (its text no longer matched);
- two messages with the same text, or a typed message equal to a port message, swapped identities;
- messages left in pi's own queues could be dropped by Escape or `/compact`, or kept and then placed twice after a retry;
- a slow `message_end` handler in another extension made the bridge hand a message twice.

Carrying the id inside the message removes every matching problem. Handing a message only when pi reads it means pi's queues never hold a port message across an abort, so there is nothing to retry blindly. The only retry left is for a message an idle pi never started a run with (or could not record): after 10 s its sender is told, with an `error` event carrying `retryAt`, and it is tried again 30 s later, then after 1 min, then every 5 minutes, in order.

## Consequences

- Port messages do not go through pi's `input` handlers, prompt templates or slash commands. A message starting with `/` from a phone is text for the model, never a pi command. Extensions that want to see channel messages listen to `message_start` for `pi-personal.message`.
- Text typed in the terminal is still a user message: it is reported as an `input` event, and replies to it carry `refs: []`.
- A reply is linked to the run's port message: **one message per run**, so a reply never goes to two people. Who a reply is for is **read from the session** at the moment of the reply: the message placed after the last mark that closed a run (`pi-personal.settled` at the end of every run, `pi-personal.stopped` for a stop on purpose). Nothing else keeps that state.
- **Every message taken in ends with `settled`**, its last word: after its replies, or carrying the error when there was none (a provider refusal, a run that ends without a reply, a stop on purpose). `error` events are kept for trouble that does not end a run: a message pi did not start a run with, or could not record, is tried again later (`retryAt`). A sender is never left with silence.

## Rejected

- **User messages matched by text** (the first version): see above.
- **Typing into the terminal (`hc send`)**, as a relay that types into the terminal would: a message starting with `/` becomes a pi command, and nothing says when it was taken in.
- **A Pi Durable inbox in front of pi**: two stores, and the guarantee would still end at pi's door (0001).

## Cost of changing

Contained in `core/bridge.ts`. The port protocol does not depend on it.
