# 0002 — The keeper: a runner in each terminal, and an idempotent `up`

Status: accepted (2026-11-16). After repeated failures the runner tries again once an hour rather than giving up for good: one bad night must not need a person for a week.

## Decision

The keeper is two small pieces, not a daemon:

1. **The runner** runs in each Pi-Personal terminal of Herdr Core (one per agent, one per channel). It starts its program as a child, and when the program ends for any reason other than a stop request, it starts it again in the same terminal. It owns the restart rules:
   - backoff between quick failures; after **5 failed starts within 10 minutes**, the status becomes `failed` with the reason, reported on the port and in the log;
   - then **one new attempt every hour**, each one logged and reported; a program that stays up for 10 minutes resets the count;
   - **safe mode** for agents: when pi fails before reaching the port, the runner starts pi once more without a model, a session or a screen (`pi --no-session --mode rpc`), with everything pi finds by itself in the agent's folder (`.pi/extensions/`, packages, MCP servers), sends it `{"type":"get_state"}` and waits for the answer: an answer is the positive sign that pi got through loading. It reads the extensions pi names as failing (`Failed to load extension "<path>"`). If there are any, or if pi answers without extensions but not with them, it starts pi with only the bridge (`pi -ne -e bridge`) and says which. A check that does not answer within 30 seconds is killed outright (an extension stuck in a loop cannot handle a gentler signal). A missing folder, a missing Node, or a failure the check cannot show is a plain failure, never a reason for safe mode. Before each later start the check runs again; once everything loads, safe mode ends by itself.
   - **a startup watchdog**: pi that does not reach the port within 2 minutes (an extension that hangs while loading) is stopped and counted as a failed start;
   - **a clean exit is not a failure** when pi had reached the port and been up for 10 seconds or more (`/quit`, Ctrl+D in the attached terminal): pi starts again at once, without counting toward the limit;
   - after a crash that cut off work, the bridge (inside pi) adds one visible note asking the agent to continue;
   - each start reads `pi-personal.json` again, so a fix applies at the next attempt;
   - what the runner knows (ready, safe mode, failed, last restart) it writes to `keeper.json` next to its lock, and `pp status` reads that file and Herdr Core only.
2. **`up`** makes sure every agent and channel that should run has a live terminal. It is idempotent: it creates what is missing and touches nothing else. It is run by hand, by `start`, and optionally by a per-user login service (systemd user timer on Linux, launchd agent on macOS) at login and every few minutes. `stop` records that the user wants an agent stopped (the `stopped` file), so `up` leaves it alone; the bridge reads the same file when pi gets the signal, so work stopped on purpose is not resumed at the next start. `restart` is `stop` then `start`; it reads `pi-personal.json` first and stops nothing if the file cannot be read. `stop` returns once the terminals have ended.
3. **One runner per agent, by a lock.** Each runner takes `runner.lock` in the agent's private area (its pid, created exclusively; a lock whose process is gone, or is no longer a Pi-Personal runner, is taken over by moving aside exactly the lock judged stale, so two runners taking over at once cannot both win). A second runner waits, and gives up if the agent is stopped on purpose meanwhile. Seen from another Herdr Core, `up` and `status` report the agent as running elsewhere, `send` works, and `stop` refuses.
4. **Staying up for months.** Nothing the keeper or the bridge writes can kill them: events that cannot be written (a full disk) wait in memory and are written once it works again. `events.jsonl` only grows (about a kilobyte per message); the owner moves it aside while the agent is stopped, and readers whose offset is past the end start the new file from its beginning. At each start it rotates its own log past 5 MB and removes `taken/` and `rejected/` files older than 30 days (the session keeps the ids, so duplicates are still recognised).

## Why

- Herdr Core keeps terminals alive but never reruns a program (read in its source; `test/contracts.test.ts` checks what the runner relies on). Something must. Putting that something inside the terminal means the agent comes back in the same terminal, under the same name, where a person attached to it sees it return.
- Nothing has to "survive its own death": if the keeper service is stopped or upgraded, runners keep running. If a runner itself is killed, Herdr closes the terminal and pi ends with it (verified: no orphan, so never two sessions for one agent); the next `up` starts a fresh terminal.
- Herdr enforces unique terminal names among live terminals, but only within one Herdr Core. Two cores sharing one private area (a second session, a test, a laptop and its remote) would run two pi on one conversation (`test/edge-cases.test.ts` does it). The lock is the guarantee; the names are the convenience.
- The hourly retry keeps a week without intervention possible after a transient failure (a network that came back, a provider outage), without busy loops or silent retries.

## Rejected

- **One long-running keeper per user** watching `hc events` and recreating terminals: more moving parts, a new terminal on every restart, and its own death to handle.
- **`hc run --keep`**: it replaces a lost program with a shell and never reruns it.

## Cost of changing

Small: the runner is one module; replacing it with an external supervisor would not change the port or the agent folder.
