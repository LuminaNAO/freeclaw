# Signal link helper — ARCH

Owned by the operator; engineers do not edit it. Architecture-driven: each commit names the section it implements.
A real conflict with the code is `BLOCKED`, not resolved in code.

## 0. Why

Linking signal-cli as a secondary device of a Signal account (QR from signal-cli, scanned by the phone that owns
the number) fails often when agents do it by hand: the wrong signal-cli config dir or user, a running daemon holding
the account store, the link URI scraped wrongly from stdout, the QR expiring while the agent fiddles, no proof the
link worked, and the gateway config not updated. It is also a step of agent provisioning (phase 9 "channels on").
One command must do it end to end, fast, the same way every time.

## 1. Command

`openclaw signal link [--account <accountId>] [--name <device name>] [--number <E.164>] [--png <path>]
[--timeout <s>] [--write-config] [--json]`

1. **Preflight** (fail fast, one clear line each, exit non-zero):
   - signal-cli found (`channels.signal.cliPath` or PATH) and runs; print its version. Java present if needed.
   - the signal-cli config dir that the gateway will use (same resolution as the daemon) is writable by the
     current user.
   - if `--number` is given and that number already has an account in that config dir: say so and stop (offer
     `--relink` to remove only that local account's data first, after a y/N prompt unless `--yes`).
   - no signal-cli process is holding that config dir (a running daemon locks the store): name the pid and stop;
     never kill it. Say "stop the gateway / daemon for this account first".
2. **Link:** spawn `signal-cli [--config <dir>] link -n <name>` (default name: `gateway.instanceName`, else
   `openclaw`). Read stdout until the first line that is a `sgnl://linkdevice?...` URI (strict parse; anything else
   is ignored). Never print, log or write the URI as text.
3. **Show the QR:** render it in the terminal (existing `qrcode-terminal` dependency, already used by `qr-cli`),
   and, if `--png <path>` is given, write a PNG there with mode 0600 (render with an existing dependency; no new
   dependency). Print: "Scan with Signal on the phone for <number or 'the account'>: Settings → Linked devices →
   Link new device. Expires in about 2 minutes."
4. **Wait** for signal-cli to finish (it exits after the phone confirms). Success = exit 0 and a line naming the
   linked number. If the QR expires or signal-cli exits with an expiry error: automatically start a new link
   (new QR, new PNG at the same path) up to 3 times, saying "QR expired, new QR shown". Overall `--timeout`
   (default 600 s) kills the child and exits non-zero. Ctrl-C kills the child cleanly.
5. **Verify:** the account now exists in that config dir (`signal-cli --config <dir> -a <number> listDevices` or
   equivalent read-only call succeeds and shows this device). If `--number` was given, the linked number must equal
   it; otherwise stop with a mismatch error and do not write config.
6. **First sync:** run one bounded `receive` (timeout 10 s) so contacts/groups start syncing; never print message
   content.
7. **Config (`--write-config`):** set `channels.signal.account` (or `channels.signal.accounts.<id>.account`) to the
   linked number through the same validated config writer as `openclaw config set`. Never hand-edit. Print the
   next step: "restart the gateway, then send a test message".
8. **Output:** human lines by default; `--json` prints one object `{ok, number, device, configDir, signalCliVersion,
attempts, configWritten, error?}`. The URI never appears in either.

## 2. Gateway RPC (for agents)

`signal.link.start {account?, name?, number?}` → `{linkId, qrPngPath, expiresAt}`;
`signal.link.status {linkId}` → `{state: waiting|expired-renewed|linked|failed, number?, error?}`;
`signal.link.cancel {linkId}`. Same steps as §1 (preflight, link, verify, optional config write), one link at a
time per config dir. Operator scope only. The PNG lives in the gateway state dir (`signal-link/`, 0700) and is
deleted when the link ends. Agents send the PNG to the human who owns the phone through the normal message path;
the URI text is never returned by the RPC.

## 3. Not in scope

SMS/voice registration of a new number with captcha (path B in docs/channels/signal.md) stays manual for now.

## 4. Tests

- Unit, with a fake signal-cli script on PATH: URI parsing (good line, noise before it, malformed), terminal and
  PNG render called, PNG mode 0600, expiry → auto-renew up to 3 then fail, timeout kills the child, Ctrl-C/cancel
  kills the child, number mismatch refuses config write, existing-account and lock-held preflight stops, `--json`
  shape, URI never in stdout/stderr/logs/json (assert by searching captured output for `sgnl://`).
- RPC: start/status/cancel lifecycle with the fake script; one link per config dir.
- Docs: docs/channels/signal.md path A uses the new command.
