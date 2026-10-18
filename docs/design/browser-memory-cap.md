# Browser memory cap — ARCH

Owned by the operator; engineers do not edit it. Each commit names the section it implements.

## 1. Problem (operator, 2026-10-18)

Agents' managed browsers never close tabs. On one box the main agent's browsers held 27.5 GB (86 open tabs in one
instance, renderers of 3.5-4.8 GB each, 9 days old) and a client agent's 6.4 GB; the box was ~7 GB from OOM. Closing
the tabs by hand freed 25 GB. Nothing in freeclaw bounds it.

## 2. Rule

1. **Cap.** Every browser freeclaw launches (the managed `openclaw` profile in `src/browser/chrome.ts`) runs inside a
   memory limit, default **4 GiB** for the whole browser (all its processes). Config
   `browser.memoryLimitMb` (default 4096; `0` = no cap).
2. **How.** On Linux with a systemd user manager: launch the browser via `systemd-run --user --scope -p
MemoryMax=<n>M -p MemorySwapMax=0 --` so the kernel enforces it for the whole process tree. Elsewhere, or when
   `systemd-run` is unavailable: no kernel cap, the watchdog (§3) still runs, and status says the cap is soft.
3. **Tab hygiene.** The browser tool closes tabs it opened when the agent turn that opened them ends, unless the
   agent passed `keep: true`. At most `browser.maxTabs` (default 8) open pages; opening one more closes the oldest
   page the agent did not mark `keep`.
4. **Watchdog.** Every 60 s, if the browser tree's RSS is above 90 % of the cap, close idle tabs oldest first
   (never the one in use by an active tool call) until under 75 %. If still above the cap after that, restart the
   browser (profile and cookies kept on disk; logins survive).
5. **Visibility.** `openclaw status` and `openclaw browser status` show browser RSS, cap, open tab count, and
   whether the cap is kernel-enforced. One log line per watchdog action.
6. **Scope.** Only browsers freeclaw launches. Externally attached browsers (user profile, chrome-relay, a separate
   pinchtab service) are not touched; status reports them as "external, not capped".

## 3. Tests

- Launch path wraps the browser in `systemd-run --scope -p MemoryMax=...` when available, plain spawn otherwise.
- `memoryLimitMb: 0` → no wrapper, no watchdog.
- Tabs opened in a turn are closed at turn end; `keep: true` survives; `maxTabs` evicts the oldest non-kept page.
- Watchdog: fake RSS above 90 % closes idle tabs oldest first, skips the active one; still above cap → restart.
- External browser profiles untouched.
