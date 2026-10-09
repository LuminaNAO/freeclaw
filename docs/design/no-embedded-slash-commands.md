# No embedded slash commands — ARCH

Source of truth for when chat text is treated as a command. Owned by the operator; engineers do not edit it.
Architecture-driven: no separate spec; each commit names the section it implements. A real conflict is raised
as `BLOCKED`.

## 1. Problem

Today a `/word` anywhere inside a normal chat message can act:

- **Inline shortcuts** (`/status`, `/help`, `/commands`, `/whoami`, `/id`) run when they appear anywhere in a
  message ("hey /status"), are stripped, and the rest goes to the model.
- **Inline directives** (`/think`, `/fast`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`,
  `/queue`) are stripped from the middle of a message and applied as one-turn hints.
  A user quoting, pasting or casually mentioning a command gets it executed and removed from their message.

## 2. Rule

1. A message is a command or directive message **only if its first non-whitespace character is `/`**. Then it is
   handled exactly as today (standalone commands, directive-only messages, `/cmd args`).
2. In every other message, `/word` tokens are plain text: nothing is executed, nothing is stripped, the model
   sees the message unchanged. This removes inline shortcuts and inline directive hints entirely.
3. A message that starts with a command or directive keeps today's behaviour for that leading command (e.g.
   `/think high explain X` still sets the hint for that turn and sends the rest). Only the **leading** run of
   directives is parsed; a directive-looking token after ordinary text is plain text.
4. Nothing else changes: authorization rules, skill commands, the `!` bash shortcut, native command menus, and
   command-only fast paths are untouched.
5. No config flag: this is the behaviour.
6. Docs (`docs/tools/slash-commands.md` and any page describing inline shortcuts/hints) are updated to match.

## 3. Acceptance

1. Unit: `hey /status` -> no status reply, model receives `hey /status` unchanged. Same for `/help`, `/commands`,
   `/whoami`, `/id` mid-message.
2. Unit: `please use /model opus for this` -> no model change, text unchanged. `/think high do X` at the start ->
   hint applied, model receives `do X`.
3. Unit: standalone `/status`, `/help`, directive-only `/think high` -> unchanged behaviour.
4. Live, throwaway gateway with no channels via the gateway chat path: send `ok /status thanks` -> a normal model
   reply (no status card); send `/status` -> status card.
5. Full test suite: no new failures versus clean origin/supermaster; tests that asserted inline behaviour are
   updated to assert the new rule (list them).
