# ARCH: Per-agent Signal daemon isolation (unix-socket transport)

Revision 3. Branch `feature/signal-isolation`, base `supermaster` @ 7d1aadd107. Includes the owner ruling of
2026-10-01, which makes socket the default transport, and the ground truth from live R&D: a production deployment
already runs signal-cli in socket mode behind a temporary HTTP shim (§2.6). That shim is what this work replaces.

Revision 3 changes (audit SB1–SB5): §2.1 shared-tmpdir hazard, §5.3 isolation granularity, §7 consumer
enumeration preflight, §8 C5 rewritten as a host-wide relay sweep plus the `ss` requirement, §9 C5 matrix.

Revision 2 changes: §2.6 (new: the shim, the consumed API surface, the live daemon), §5.5 (notification shapes, a
daemon not in manual mode, account filter, delivery parity), §7 (shim cutover runbook), §8 (C4, C5), §9 (transport
parity test), §11 (F6, F7).

## 1. Problem, goal, scope

Today every Signal account runs one `signal-cli daemon --http 127.0.0.1:<port>` (`src/signal/daemon.ts:72`).
That endpoint has no authentication. signal-cli says so itself at startup ("HTTP server has no authentication",
upstream `HttpServerHandler.java:79-81`). On a box with several agents, any local uid can connect to any agent's
port, read its incoming messages through `/api/v1/events`, and send as that agent through `/api/v1/rpc`.

Goal: an agent's Signal identity can be reached only by that agent's uid, plus an optional consumer group that the
operator names explicitly. The boundary is kernel file permissions on a unix socket and its directory. This is the
same pattern the broker uses.

Owner ruling (amends brief item 3). Socket is the default transport:
(a) native unix-socket transport in the Signal channel;
(b) when freeclaw spawns signal-cli, it uses socket mode by default, with a per-agent path and permissions;
(c) HTTP stays supported, but only through explicit config;
(d) the docs say socket is the recommended default;
(e) the migration notes cover the default flip for upgraders.

In scope: `src/signal/**`, Signal config schema and types, Signal docs, a conformance script, and tests.
Out of scope: shared model inference (per the brief), other channels, and the live cutover of any real daemon
(that is owner-side acceptance).

## 2. Survey: signal-cli 0.14.5 daemon transports

Source of truth: upstream tag `v0.14.5` (tag object f8e970cd, commit 6bef205b3f1698ae62e7fc6fe155d14eddb725ac,
`build.gradle.kts:13` `version = "0.14.5"`). All paths are relative to that tree. Statements from `master` docs
that are not in the 0.14.5 source are marked **master-only**.

### 2.1 Flags (`src/main/java/org/asamk/signal/commands/DaemonCommand.java`)

| Flag                                                                                      | Lines | Value / default                                                                                                                    | Listener                                                               |
| ----------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `--socket [PATH]`                                                                         | 59-63 | optional; default `$XDG_RUNTIME_DIR/signal-cli/socket`, or `java.io.tmpdir` when `XDG_RUNTIME_DIR` is unset (`IOUtils.java:75-83`) | AF_UNIX stream, JSON-RPC                                               |
| `--tcp [HOST:PORT]`                                                                       | 64-67 | default `localhost:7583`                                                                                                           | TCP stream, JSON-RPC (no auth)                                         |
| `--http [HOST:PORT]`                                                                      | 68-71 | default `localhost:8080`                                                                                                           | HTTP: `/api/v1/rpc`, `/api/v1/events` (SSE), `/api/v1/check` (no auth) |
| `--dbus`, `--dbus-system`                                                                 | 52-55 | —                                                                                                                                  | D-Bus                                                                  |
| `--receive-mode`                                                                          | 75-78 | `on-start` (default), `on-connection`, `manual` (`ReceiveMode.java`)                                                               | —                                                                      |
| `--no-receive-stdout`, `--ignore-attachments`, `--ignore-stories`, `--send-read-receipts` | 72-93 | flags                                                                                                                              | —                                                                      |

Listener rules (`DaemonCommand.setup`, lines 160-213):

- **No implicit listeners.** Each listener is bound only when its flag is present. With no flag and no inherited
  channel, the daemon refuses to start: "At least one channel parameter is required" (line 212). So
  `daemon --socket P` opens no TCP or HTTP port.
- **Inherited channel.** If stdin (`System.inheritedChannel()`) is a `ServerSocketChannel`, the daemon also serves
  JSON-RPC on it (lines 161-170). This is the systemd socket-activation path (`data/signal-cli-socket.socket`).
  freeclaw spawns with `stdio: ["ignore", …]` (`src/signal/daemon.ts:94`), so stdin is `/dev/null` and nothing
  is inherited.
- **Shared-tmpdir hazard (bare `--socket`).** With `XDG_RUNTIME_DIR` unset, a bare `--socket` resolves to a
  shared, predictable path (`/tmp/signal-cli/socket`). Because `preBind` never tightens a directory that already
  exists (§2.2), another uid that pre-creates `/tmp/signal-cli` controls the socket's parent. freeclaw therefore
  never relies on signal-cli's default path: it always passes an explicit `--socket` in a directory it verified
  (§5.3), and an external `socketPath` under a directory that is other-writable without the sticky bit, or not
  owned by the agent uid, is refused.
- **Global config cannot add listeners.** `/etc/signal-cli/config.json` and the user config
  (`ConfigLoader.java:16-38`) map onto `GlobalConfig` (`GlobalConfig.java:5-17`). That record has no
  socket/tcp/http keys. Its `dbus`/`dbusSystem` keys are defaults for the client-side top-level flags
  (`App.java:78-88`, "Make request via user dbus"), not for the daemon's `--dbus` listener.

### 2.2 Socket bind behavior (`util/IOUtils.java`)

- `bindSocket` (130-144): `preBind` creates the parent directory with mode 0700, but only if it does not exist
  yet (`createPrivateDirectories`, 51-63: it returns early when the path exists and never fixes the mode of an
  existing directory). It then binds and calls `postBind`, which registers `deleteOnExit` on the socket file
  (152-156).
- signal-cli never chmods the socket file. Its mode follows the JVM process umask.
- If a stale socket file is left at the path (for example after a crash, when `deleteOnExit` did not run), the
  bind fails ("Failed to bind socket …", line 141) and the daemon exits. Something else must clean up stale files.
- Per connection, the daemon logs the peer's `SO_PEERCRED` principal (`SocketHandler.java:74`,
  `IOUtils.java:121-128`). It logs it only and never uses it to authorize. **Filesystem permissions are the only
  access control on the socket.**

### 2.3 Socket wire protocol (`jsonrpc/*`, `output/JsonWriterImpl.java`)

- Framing: newline-delimited JSON, both directions. Requests are read with `BufferedReader.readLine`
  (`IOUtils.getLineSupplier`, `SocketHandler.java:132-137`). Each response or notification is one JSON value
  followed by `System.lineSeparator()` (`JsonWriterImpl.java:21-34`).
- Requests on one connection run concurrently (`JsonRpcReader.java`, one virtual thread per message), so
  responses can arrive out of order. They are matched by `id`.
- A request with an `id` always gets a response object with `result` or `error`. A command that writes no output
  returns `result: {}` (`SignalJsonRpcCommandHandler.runCommand`, `Map.of()` fallback). The HTTP endpoint's
  `201 No Content` happens only for id-less notifications (`HttpServerHandler.java:157-161`).
- Error codes: -1 user, -3 IO, -4 untrusted key, -5 rate limit, -6 captcha
  (`SignalJsonRpcCommandHandler.java:10-14`), plus the standard JSON-RPC codes.
- **Receiving.** Each connection gets its own `SignalJsonRpcDispatcherHandler`. If the daemon was started with
  `--receive-mode manual`, a connection is not subscribed automatically (`DaemonCommand.java:285,310` passes
  `noReceiveOnStart = (mode == MANUAL)`; dispatcher lines 64-66 and 80-82). The client calls
  `subscribeReceive`, which returns an integer subscription id, and then gets notifications:
  `{"jsonrpc":"2.0","method":"receive","params":{"subscription":N,"result":{"envelope":{…},"account":"…"}}}`
  (dispatcher lines 152-191; man page `signal-cli-jsonrpc.5.adoc:64-72`). `result` is the same
  `JsonReceiveMessageHandler` object (`account`, `envelope`, optional `exception`) that HTTP SSE serializes into
  `data:` (`HttpServerHandler.java:279-283`).
- Subscribing adds a **strong** receive handler (`m.addReceiveHandler(handler)`, which means `isWeakListener =
false`). That starts the receive thread (`ManagerImpl.java:1389-1398`), exactly as an SSE subscriber does over
  HTTP. When the connection closes, all of its subscriptions are removed (dispatcher `handleConnection` finally
  block). If no handler remains, receiving stops and new messages stay queued on the server.
- `subscribeReceive`, `unsubscribeReceive`, `subscribeCallEvents` and `unsubscribeCallEvents` exist only on
  socket/TCP/stdin connections (dispatcher `getCommand`, lines 222-236). HTTP `/api/v1/rpc` uses
  `Commands::getCommand` (`HttpServerHandler.java:41,49`) and has no subscription commands. It receives through
  SSE instead.

### 2.4 HTTP specifics (for the matrix)

- `/api/v1/events`: SSE. Events have **no `id`** in 0.14.5 (`sendEvent(null, "receive", …)`,
  `HttpServerHandler.java:281`). This is unchanged at v0.14.8 (line 287). The man page statements about event ids,
  `Last-Event-ID` and a 1000-event replay buffer are **master-only** and do not apply to 0.14.5.
- Keep-alive comment every 15 s (`HttpServerHandler.java:214`). `--sse-keepalive-interval` is **master-only**
  (not in the 0.14.5 or 0.14.8 `DaemonCommand`).
- Host-header pinning since 0.14.4. It is disabled when bound to 0.0.0.0 (CHANGELOG 0.14.5 "Changed"). This only
  defends against DNS rebinding. Local processes are not stopped by it.

### 2.5 Capability matrix (0.14.5)

| Capability                                                                                                           | `--http`                              | `--socket`                                                         | Notes                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Any JSON-RPC command (`send`, `sendReaction`, `sendTyping`, `sendReceipt`, `getAttachment`, `version`, group ops, …) | yes, `POST /api/v1/rpc`               | yes, one line per request                                          | Same command table (`Commands.getCommand`)              |
| Batch requests                                                                                                       | yes                                   | yes                                                                |                                                         |
| Receive incoming messages                                                                                            | SSE `GET /api/v1/events`              | `subscribeReceive` notifications on the same connection            | Payload object identical (§2.3)                         |
| Per-account receive filter (multi-account daemon)                                                                    | `?account=` query                     | none; subscribe covers all managers, so filter on `result.account` | freeclaw always spawns single-account (`-a`)            |
| Manual receive mode (no loss before subscriber attaches)                                                             | yes (SSE subscriber starts receiving) | yes (`subscribeReceive` starts receiving)                          | Both strong handlers                                    |
| Liveness/health                                                                                                      | `GET /api/v1/check` (200, no RPC)     | connect + any RPC (for example `version`)                          |                                                         |
| Keep-alive on idle receive stream                                                                                    | 15 s SSE comment                      | none                                                               | AF_UNIX peer death means immediate EOF; no network path |
| Event replay on reconnect                                                                                            | no (0.14.5)                           | no                                                                 | Equal                                                   |
| Call events                                                                                                          | no                                    | `subscribeCallEvents`                                              | Not used by freeclaw                                    |
| Authentication                                                                                                       | none                                  | none; file permissions only                                        |                                                         |
| Reachable by other local uids                                                                                        | yes, any uid                          | only if they can search the directory and write the socket         | **The point of this work**                              |

**What freeclaw uses today** (from `rg 'signalRpcRequest\(' src`): `send`, `sendTyping`, `sendReceipt`,
`sendReaction`, `getAttachment`, `version`, plus the check endpoint and the SSE stream. **Every one of these is
available over the socket. There is no capability gap.** The only differences are mechanical: health check by
RPC instead of `/check`, receive by subscription instead of SSE, and no keep-alive (not needed on AF_UNIX).

### 2.6 Ground truth: the production socket daemon and the temporary shim

**What is running.** A production deployment already runs signal-cli in socket mode. A Node shim re-exposes
`/api/v1/rpc`, `/api/v1/check` and `/api/v1/events` (SSE) on a loopback TCP port, backed by newline JSON-RPC over
the unix socket, and the freeclaw gateway reaches the shim through `httpUrl`. The shim re-adds an unauthenticated
TCP port, so it gives back exactly the exposure this work closes. **It is not the target state. The native
transport removes it.**

**Verified directly** (process table and socket table, read-only, as an unprivileged uid; host-specific values
such as uid, port, account and paths are deliberately left out of this doc):

- Daemon argv: `org.asamk.signal.Main -a <acct> daemon --socket $XDG_RUNTIME_DIR/signal-cli/socket
--no-receive-stdout --receive-mode manual`. That is exactly the argv §5.4 specifies for managed socket mode,
  except for the path. The path is signal-cli's default and is not per-agent; §5.3 uses per-account paths so that
  several accounts under one uid never collide.
- Only the shim process listens on TCP (a loopback port). The daemon itself has one listening AF_UNIX socket and
  no TCP listener, which confirms §2.1 on a real deployment.
- The daemon and the shim are both children of the user's `systemd --user`, **not** of the gateway. So today's
  production daemon is an _external_ socket daemon (§5.6, `autoStart: false`). The gateway-spawned lifecycle in
  brief item 4 applies to managed accounts; the production cutover is the external case (§7).
- The runtime parent directory is 0700 and owned by the agent uid, so the socket itself is already unreachable by
  other uids. The shim's TCP port is the only cross-uid path.
- The production jar is a `0.14.5-SNAPSHOT` build, not the tagged release. Between tags `v0.14.4` and `v0.14.5`
  there are **no** commits touching `jsonrpc/`, `commands/`, `json/`, `output/`, `util/IOUtils.java` or
  `ManagerImpl.java` (`git log v0.14.4..v0.14.5 -- <those paths>` is empty). Any snapshot in that range behaves
  like the 0.14.5 source cited in §2.1–§2.4 on every path this design depends on.

**Not verified.** The shim source (path given in the brief) sits inside another user's 0700 home directory. It is
not readable from the build account, and I did not try to work around that, so its internals are not cited here
(§11 F6). This does not block the design. The shim exists to satisfy freeclaw's HTTP client, so **freeclaw's
client code is the binding definition of the surface the shim provides**. The table below is derived from that
source. Items the shim source could still refine are marked (shim?).

**Consumed API surface.** All of it is in `src/signal/client.ts`; nothing else in freeclaw talks to signal-cli.

| #   | HTTP call freeclaw makes                                                                                                                                                                                   | What freeclaw reads from it                                                                                                                                                                                                                                                                                                                                | Socket equivalent (§5.5)                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `POST {base}/api/v1/rpc`, `Content-Type: application/json`, body is one request `{"jsonrpc":"2.0","method","params","id":<uuid>}` (`client.ts:70-107`)                                                     | `201` returns `undefined`. Otherwise the body must be a JSON object with `result` or `error`; `error` becomes `Signal RPC <code>: <message>`. HTTP status is otherwise ignored.                                                                                                                                                                            | One request line, then the response line with the same `id`. The socket never produces 201: requests with an id always get a response (§2.3). A command with no output returns `result:{}`, and every caller ignores the result of those methods. |
| A2  | Methods: `send` and `sendReaction` (read `result.timestamp`), `sendTyping` and `sendReceipt` (result ignored), `getAttachment` (read `result.data`, base64), `version` (read `result` or `result.version`) | as listed                                                                                                                                                                                                                                                                                                                                                  | Identical command table (§2.5)                                                                                                                                                                                                                    |
| A3  | `GET {base}/api/v1/check` (`client.ts:109-132`)                                                                                                                                                            | only `res.ok`                                                                                                                                                                                                                                                                                                                                              | `version` RPC succeeds                                                                                                                                                                                                                            |
| A4  | `GET {base}/api/v1/events?account=<acct>`, `Accept: text/event-stream` (`client.ts:134-215`)                                                                                                               | SSE parsed line by line: `event:`, `data:` (multiple lines joined with `\n`), `id:`; `:` comments ignored; a blank line ends an event. The event handler uses only `event === "receive"` and `JSON.parse(data)` with `envelope` and optional `exception` (`event-handler.ts:447-465`). `id` is parsed but never used, and no `Last-Event-ID` is ever sent. | Long-lived connection, `subscribeReceive`, then `receive` notifications. `params.result` is the object that SSE `data:` carries, emitted as `{event:"receive", data: JSON.stringify(params.result)}`                                              |
| A5  | Reconnect: on EOF or error, `runSignalSseLoop` retries with backoff (`sse-reconnect.ts`)                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                          | Same loop, unchanged                                                                                                                                                                                                                              |

Behavior the shim must have, which the native transport reproduces:

- The shim must unwrap `params.result` from the subscription notification, because the event handler expects the
  bare `{account, envelope, exception}` object (A4). The native client does this unwrapping itself.
- SSE framing on the wire is `event: receive` / `data: <single-line JSON>` / blank line, matching upstream
  `ServerSentEventSender` (§2.4). (shim?) Whether the shim also sends `id:` lines or keep-alive comments does not
  matter, because freeclaw ignores both.
- (shim?) The shim's connection model toward the socket (one shared connection, or one per request or stream) is
  not observable from freeclaw. The native design picks its own (§5.5).
- (shim?) If the shim answers `/api/v1/check` without touching the daemon, a dead daemon reads as healthy. The
  native check does a real RPC, which is stricter, never weaker.

## 3. Threat model

Attacker: another local, unprivileged uid on the same host, such as another tenant's agent, a compromised tool
process running as a different uid, or a non-agent user. Goal: read another agent's incoming Signal messages or
send as it.

Protected after this change, for socket-mode accounts:

- Other uids cannot connect to the socket. They cannot search the 0700 directory, and even with group access they
  cannot write the 0600 socket.
- No TCP listener exists for the account, so nothing is reachable by port scan or loopback connect.
- No silent fallback to HTTP happens: a socket error is fatal and loud.

Not protected (stated so nobody overclaims):

- root, and anything holding `CAP_DAC_OVERRIDE`/`CAP_SYS_PTRACE`.
- Other processes running as the **same uid**. Every account served by one gateway shares its uid, and so does
  every tool the agent's exec sandbox runs as that uid. Isolation is per uid. Multiple accounts in one gateway are
  not isolated from each other. To isolate agents, run one gateway per uid.
- Members of the optional `socketGroup` (§5.3). That access is granted deliberately.
- The signal-cli data directory (`~/.local/share/signal-cli`, which holds keys). It is protected by its own 0700
  mode, which signal-cli already creates. The conformance check reports its mode but this work does not change it.
- Accounts the operator keeps on HTTP (`transport: "http"`). Those stay exposed by design, and the conformance
  check reports them as non-conforming (§8).
- Namespace/container escapes, kernel bugs, and model inference.

## 4. Decision: native socket transport (option a)

Option (a) is native: freeclaw's Signal client speaks newline-delimited JSON-RPC to the socket directly. Option (b)
is a per-uid shim that translates socket to HTTP. **Decision: (a).**

Why:

1. **The rework is small.** Every consumer already passes an opaque endpoint string (`baseUrl`) into three
   functions in `src/signal/client.ts`: `signalRpcRequest` (:70), `signalCheck` (:109) and `streamSignalEvents`
   (:134). The call sites (`send.ts`, `send-reactions.ts`, `monitor.ts`, `monitor/event-handler.ts`,
   `probe.ts`, `extensions/signal/src/channel.ts:298`) need no change. The endpoint string gets a `unix:` form
   and the three functions dispatch on it. New code is about 250 lines (socket client plus directory helper), and
   no call site is rewritten.
2. **The matrix shows no gap** (§2.5), so there is nothing a shim would add.
3. **A shim recreates the problem.** Its HTTP side would have to listen somewhere. On loopback TCP, every uid can
   reach it again, which is exactly the hole being closed. On a unix socket, the gateway still needs a unix-socket
   HTTP client, so it is the same amount of client work plus an extra process to supervise, restart and audit.
4. One process per account is kept (no new supervisor), so the existing daemon lifecycle (`monitor.ts`
   `createSignalDaemonLifecycle`) applies unchanged.

## 5. Design

### 5.1 Endpoint representation

`ResolvedSignalAccount.baseUrl` stays the single endpoint string, so the type and plugin surfaces do not change.

- HTTP: `http://host:port` (unchanged).
- Socket: `unix:<absolute path>`, for example `unix:/run/user/1001/openclaw-signal/default.sock`.

`client.ts` checks for `unix:` **before** `normalizeBaseUrl`. Today, any string without a scheme gets `http://`
prepended, so without this ordering `unix:/x` would silently become an HTTP URL. Any other scheme except
`http(s)://` and `unix:` is rejected, and a bare `host:port` keeps its legacy `http://` prefixing. A relative
`unix:` path is rejected.

### 5.2 Transport resolution (default flip, fail-safe precedence)

New per-account config keys (top-level or `accounts.<id>`, merged the same way as today):

- `transport?: "socket" | "http"`: explicit choice.
- `socketPath?: string`: absolute path, `~/` expanded. Used for both managed and external socket daemons.
- `socketGroup?: string`: optional consumer group, a name or numeric gid (§5.3).

Resolution runs on the merged account config in the new `resolveSignalTransport()` (`src/signal/transport.ts`),
called from `resolveSignalAccount`. The first rule that matches wins:

1. **Conflicts are a hard config error.** The account fails to start, with the offending keys named. There is
   never a downgrade:
   - `transport: "socket"` together with `httpUrl`, `httpEndpointFile` or `archiveRaw`.
   - `transport: "http"` together with `socketPath` or `socketGroup`.
   - `socketPath` or `socketGroup` together with `httpUrl`, `httpEndpointFile` or `archiveRaw`.
2. `transport` is set, so use it.
3. `httpUrl`, `httpEndpointFile` or `archiveRaw` is set, so use **http**. These are inherently HTTP (an external
   HTTP daemon, or the archive-raw tee proxy, which only speaks HTTP). Not a flip.
4. `socketPath` is set, so use **socket**.
5. `autoStart === false`, so use **http** (legacy external daemon at `httpHost:httpPort`). freeclaw does not
   spawn here, and ruling (b) only covers daemons freeclaw spawns. Without this rule, an upgrader running their own
   HTTP daemon would silently break.
6. Platform `win32`, so use **http** ("when possible": the POSIX permission model below does not apply).
7. Otherwise use **socket**. **This is the default flip.** `httpHost`/`httpPort` on their own do **not** select
   HTTP: freeclaw itself wrote `httpPort` into every existing managed config (`http-port.ts`
   `persistSignalHttpPort`), so its presence says nothing about operator intent. If they are present, the gateway
   logs once: `signal[<id>]: ignoring httpHost/httpPort; socket is the default transport (set
channels.signal.transport="http" to keep HTTP)`.

`autoStart` default: socket mode uses `true` unless set explicitly. HTTP mode keeps today's rule
(`!(httpUrl || httpEndpointFile)`, `monitor.ts:384`).

Every HTTP-mode account whose daemon freeclaw spawns logs a warning at start:
`signal[<id>]: HTTP transport has no authentication; any local user can read and send as this account`.

Schema (`src/config/zod-schema.providers-core.ts`, `SignalAccountSchemaBase`): add `transport` (enum), `socketPath`
(string), `socketGroup` (string), plus a `superRefine` for the conflicts in rule 1 that can be seen within one
object. The runtime check stays authoritative because accounts inherit base keys. **Pre-existing defect found
during the survey:** the strict schema does not list `httpEndpointFile` or `archiveRaw`, although the type
(`types.signal.ts`) and runtime support both. Reproduced: `SignalConfigSchema.safeParse({httpEndpointFile, archiveRaw})`
fails with `Unrecognized keys`. Rule 3 depends on them, so they are added to the schema. Help text and labels go
in `schema.help.ts`/`schema.labels.ts`. The setup/CLI key lists (`channels-cli.ts:35`, `setup-helpers.ts:215`,
`commands/channels/add.ts:233`, `plugin-auto-enable.ts:101`) gain `socketPath` so `channels add --socket-path`
and auto-enable detection work. `deleteAccount` clear-fields (`extensions/signal/src/channel.ts`) gain
`transport`, `socketPath` and `socketGroup`.

### 5.3 Ownership model (S1/S2)

```
agent uid U (one gateway per agent uid)
 └─ openclaw gateway (uid U)
     └─ signal-cli -a <acct> daemon --socket <D>/<acct>.sock --receive-mode manual …   (uid U, child of gateway)
         binds <D>/<acct>.sock

<D>               owner U, mode 0700           (socketGroup G set: owner U, group G, mode 0710)
<D>/<acct>.sock   owner U, mode 0600 (enforced) (socketGroup G set: group G, mode 0660)
```

- **Who spawns and owns:** the gateway process of uid U spawns the daemon as its own child, also uid U. freeclaw
  never switches uid and needs no root.
- **Isolation granularity is the uid, not the account.** The default `<D>` is per uid, and every account served by
  one gateway shares it. Accounts within one uid share a trust domain and are not isolated from each other
  (matching §3). Per-account socket paths only prevent collisions. To isolate two agents, run them under different
  uids.
- **Default directory `<D>`:** `$XDG_RUNTIME_DIR/openclaw-signal`, if `XDG_RUNTIME_DIR` is set, is absolute, is
  owned by U, and has mode `& 0o077 == 0`. Otherwise `<stateDir>/signal-sockets` (`resolveStateDir()`,
  `src/config/paths.ts:60`, normally `~/.openclaw`). File name `<accountId>.sock`. Account ids are already
  restricted to `[a-z0-9_-]{1,64}` (`src/routing/account-id.ts:5`), so there is no path injection.
  `socketPath` overrides the whole path, and its parent directory is subject to the same rules.
- **Why uid A cannot reach uid B's socket.** `connect(2)` on a pathname socket needs search (x) permission on
  every directory in the path, plus write permission on the socket inode. B's `<D>` is 0700 and owned by B, so A
  fails at path resolution with `EACCES`. The socket's own mode is a second, independent barrier.
- **Group mode (fcbr-style, opt-in):** with `socketGroup: G`, the directory becomes 0710 (group can traverse but
  not list) and the socket 0660 with group G. Unprivileged `chgrp` succeeds only if U is a member of G, otherwise
  `EPERM`, which is a hard error, never ignored. Other uids still have no access.

**Directory preparation** (`ensureSignalSocketDir`, `src/signal/socket-dir.ts`). Runs before every spawn and is
idempotent:

1. `mkdir -p` the ancestors (normal umask), then `mkdir` the leaf with mode 0700 (or 0710).
2. `lstat` the leaf. It must be a directory, **not a symlink**, owned by `process.getuid()`. If it is owned by
   anyone else: hard error. If it is ours with looser bits: `chmod` to policy and log (tightening is always safe).
   Then verify again with `lstat` after the chmod.
3. Walk the ancestors. Any ancestor that is **other-writable without the sticky bit** is a hard error, because a
   rename/symlink swap of the path would be possible. Sticky dirs like `/tmp` are allowed, since our leaf is ours
   and only we can rename it.
4. Path length: the UTF-8 length of the socket path must be ≤ 107 bytes on Linux and ≤ 103 on macOS (`sun_path`
   limit minus NUL). Too long is a hard error naming `socketPath` as the fix. It is never truncated.

**umask, the chmod-after-bind window, and replacement:**

- signal-cli binds the socket with the JVM's umask (§2.2), so the socket may briefly be 0755/0775. **That window
  is not exploitable**: the inode sits in a 0700 directory created and verified _before_ spawn, and other uids
  cannot traverse to it. The directory is the security boundary. The socket chmod is defense in depth.
- After the daemon is ready, freeclaw `chmod`s (and with group mode `chown`s the group of) the socket to policy.
  It then verifies with `lstat`: socket type, owner U, exact mode. If verification fails, the daemon is stopped
  and the channel start fails.
- **Stale file handling before spawn.** `lstat` the socket path:
  - missing: proceed.
  - not a socket (regular file, symlink, directory): hard error. freeclaw never deletes non-sockets.
  - a socket: try `connect` with a 500 ms timeout.
    - Connect succeeds: **a live daemon is already serving this path.** Hard error ("another signal-cli is
      serving <path>; refusing to start a second daemon for account <id>"). freeclaw does not attach to a daemon
      it does not supervise.
    - `ECONNREFUSED`/`ENOENT`: stale. `unlink`, then spawn.
      Nobody but U can create entries in `<D>`, so nothing can race between the unlink and the bind.

### 5.4 Daemon spawn args (S3)

`buildDaemonArgs` takes a discriminated listener: `{kind:"socket", path}` or `{kind:"http", host, port}`.

- socket: `[-a acct] daemon --socket <path> --no-receive-stdout --receive-mode manual [--ignore-attachments]
[--ignore-stories] [--send-read-receipts]`
- http: today's args, unchanged.

There is exactly one listener flag, and the type makes it impossible to emit `--http` or `--tcp` in socket mode
(unit-tested by argv inspection). `stdio[0]` stays `"ignore"` (no inherited channel, §2.1). Receive mode stays
`manual` for the reason documented at `monitor.ts` (no loss of messages queued while the channel was down). Over
the socket, receiving starts when the stream connection calls `subscribeReceive` (§2.3).

### 5.5 Socket client (`src/signal/socket-client.ts`)

- `socketRpcRequest(path, method, params, timeoutMs)`: one short-lived connection per request (on AF_UNIX the
  connect cost is negligible, and no state is shared between requests). Write one line
  `{"jsonrpc":"2.0","method",…,"id":uuid}\n`, read lines until the object with our `id` arrives, ignore anything
  else, then close. The envelope check is the same as HTTP: malformed JSON, or neither `result` nor `error`, throws.
  An `error` becomes `Signal RPC <code>: <message>`. A timeout destroys the socket and throws. Line buffer cap:
  64 MiB, so an attachment as base64 fits but a runaway line errors out instead of exhausting memory. The connect
  error is surfaced as is (`EACCES`/`ENOENT`/`ECONNREFUSED`) with the path. **There is no fallback to HTTP**, and
  `client.ts` has no code path that turns a `unix:` endpoint into an HTTP one.
- `socketCheck(path, timeoutMs)`: `version` RPC, returning `{ok, status:null, error}`, the same shape as
  `signalCheck`. It is used by the ready-wait (`monitor.ts:479`) and `probeSignal`.
- `streamSocketEvents({path, account, abortSignal, onEvent})`: open a long-lived connection, send
  `subscribeReceive`, and require an integer result (an error response throws). For each
  `{"method":"receive","params":{"subscription":S,"result":R}}` with S equal to our id, emit
  `{event:"receive", data: JSON.stringify(R)}`. That is the payload the event handler already parses from SSE
  (A4 in §2.6, `event-handler.ts:448-454`), so the handler is unchanged. Other notifications are ignored.
  EOF resolves, and the existing `runSignalSseLoop` reconnects with backoff. Abort destroys the socket. A dead
  daemon closes the socket, which surfaces as immediate EOF, so no keep-alive is needed.
  - **Daemon not in manual mode.** This can only happen with an external daemon; managed ones always run manual.
    Every connection is then auto-subscribed, and its notifications carry the bare object as `params`, with no
    `subscription` key (dispatcher lines 166-167). The stream ignores these unwrapped notifications, so a message
    is never delivered twice (once from the auto-subscription and once from ours). It logs one warning per
    connection: `signal: external daemon is not in --receive-mode manual; messages queued while the gateway was
down can be lost`. Short RPC connections are auto-subscribed too, but they ignore all notifications, and the
    daemon fans every message out to all handlers, including our subscription (`ManagerImpl.java:1422-1424`), so
    nothing is lost.
  - **Account filter** (replaces SSE `?account=`). When the configured `account` is an E.164 number and `R.account`
    is set and different, the event is dropped and a warning is logged once. This only matters for a
    multi-account external daemon, which conformance fails anyway (C3). If the account is configured by UUID, no
    filter is applied, because `R.account` is the self number (`JsonReceiveMessageHandler.java:26`).
  - **Delivery parity.** When the stream connection closes, the daemon drops our subscription. If no strong handler
    is left, receiving stops and new messages queue server-side until the next `subscribeReceive`. That is the
    same as an SSE disconnect (§2.3). A message being written at the instant the connection dies is lost on both
    transports in the same way. I did not verify whether signal-cli acknowledges to the server before dispatching
    to handlers. Either way this is parity with today, not a regression.

`client.ts` dispatch: `signalRpcRequest`, `signalCheck` and `streamSignalEvents` route `unix:` endpoints to these
functions, so the external API is unchanged.

### 5.6 Monitor and lifecycle (D3)

In `monitor.ts` (the branch at :421, which replaces the `TODO(signal)`):

- socket + autoStart: `ensureSignalSocketDir`, then stale handling, then `spawnSignalDaemon({listener:socket})`,
  then the existing ready-wait over `unix:`, then chmod/verify, then the receive loop. `persistSignalHttpPort` is
  **not** called (socket mode never writes ports to config).
- socket + `autoStart:false`: no spawn, connect to `socketPath`. The operator owns that daemon's permissions; the
  conformance check verifies them.
- http: the current code, unchanged, plus the warning from §5.2.

Gateway interaction:

- **Gateway stop/restart:** the abort runs `daemonLifecycle.stop()`, which sends SIGTERM. The JVM exits and
  `deleteOnExit` removes the socket. On the next start the steps above run again.
- **Channel crash / daemon exit:** `server-channels.ts` restarts the account with backoff, up to
  `MAX_RESTART_ATTEMPTS = 10` (:19). Each restart reruns directory checks and stale handling. A crash leaves the
  stale socket, which is unlinked on restart.
- **Gateway SIGKILL:** under the installed systemd unit, `KillMode=control-group` (`src/daemon/systemd-unit.ts:67`)
  kills the JVM too, and the next start finds a stale socket and unlinks it. Without systemd, an orphaned JVM
  keeps serving, and the next start fails loud on the live-socket check rather than running two daemons.
  `scripts/recover-orphaned-processes.sh` already matches `signal-cli`.
- **One daemon per account:** enforced by the live-socket refusal at a fixed path, and backstopped by signal-cli's
  own account-file lock. A second daemon for the same account **blocks** ("Config file is in use by another
  instance, waiting…", `SignalAccount.java:1037-1042`, `SignalAccountFiles.java:109`) rather than failing, so the
  ready-wait times out and reports it. The conformance check catches duplicates on other paths (§8).
- **Config hot reload:** transport keys are under `channels.signal`, a reload prefix of the Signal plugin
  (`extensions/signal/src/channel.ts:127`), which triggers a channel restart (`server-reload-handlers.ts:126-133`:
  stop, then start). Stop finishes before start, so the old daemon is gone
  before the new transport binds. **Both transports never listen at the same time** for one account.

### 5.7 Status surfaces

`describeAccount`/`buildAccountSnapshot` show `baseUrl`, which becomes `unix:/…` for socket accounts. That is
informative and leaks nothing new: the path holds only the account id, which is already in config. `probeSignal`
works through the dispatch. No UI changes are needed beyond the CLI key list (§5.2).

## 6. Docs (ruling d)

`docs/channels/signal.md`:

- New section "Transport (socket default)" covering the default, the paths, the permissions, `socketGroup`,
  `transport: "http"` for back-compat, and the threat model summary.
- Rewrite "External daemon mode" to cover both external socket (`socketPath` + `autoStart: false`) and external
  HTTP (`httpUrl`).
- Remove the "TODO: add UNIX socket transport" line, and change "the gateway reads events via SSE" to cover both
  transports.
- Config reference: `transport`, `socketPath`, `socketGroup`.

New `docs/channels/signal-isolation.md` holds the migration runbook (§7) and the conformance check (§8).
`CHANGELOG.md` gets a Changes entry for the default flip, with the upgrader action. zh-CN docs are generated and
not edited.

## 7. Migration runbook (outline; full text goes in the docs page)

**Upgraders on managed (auto-started) HTTP.** After the upgrade, the gateway restart moves the account to socket
automatically (rule 7). Freeclaw's own send/receive/probe follow the transport, so nothing else needs to change. The
persisted `httpPort` stays in config and is ignored, with a one-time log line. Anything **outside** freeclaw that
used the HTTP port stops working. That includes operator scripts, monitoring, archive tools, relays such as the
temporary shim in §2.6, and third-party plugins or extensions that hold their own `httpUrl`/port for the daemon
instead of going through the Signal runtime surface. That is intended. freeclaw keeps no registry of other consumers
of a daemon, so enumerating them is a manual preflight step (below). Either move those tools to
the socket (same uid or `socketGroup`) or set `transport: "http"` before upgrading.

**Upgraders running their own HTTP daemon** (`httpUrl`, `httpEndpointFile`, `archiveRaw`, or `autoStart:false`):
nothing changes (rules 3 and 5). To migrate: run signal-cli with `--socket <path>` in a 0700 directory owned by the
agent uid, set `socketPath` and `autoStart:false`, and remove `httpUrl`.

**Live cutover, managed account (owner-side):**

1. Preflight: `openclaw channels status --probe` is green. Record the old listener with
   `ss -ltnp | grep -i java` (expect the account's 56xxx port).
   **Enumerate the non-freeclaw consumers of that port before cutover:** run `ss -tnp | grep :<port>` for live
   clients other than the gateway, grep the host's config, plugin, script and unit files for the port and the
   `httpUrl`, and get the operator to confirm the list. Each consumer gets moved to the socket (same uid or
   `socketGroup`), or the account keeps `transport: "http"`.
2. Optionally pin the path: `openclaw config set channels.signal.socketPath <abs path>`. Otherwise the default
   applies.
3. Restart the gateway (the normal restart procedure for the host). Stop kills the HTTP daemon before the socket
   daemon starts (§5.6).
4. Verify: `ss -ltnp` shows **no** signal-cli/java TCP listener. Run `ls -ld <D> <D>/<acct>.sock` (expect
   `drwx------` and `srw-------`, owner = agent uid). `openclaw channels status --probe` is green and reports
   `unix:/…`. Send a test DM in both directions. Run `node scripts/signal-isolation-check.mjs` and expect PASS.
5. Messages sent during the restart window are queued server-side and delivered when `subscribeReceive` attaches
   (manual receive mode, the same guarantee as today).

**Cutover from the temporary shim (the production case, §2.6; owner-side).** The daemon already runs in socket
mode under the user's service manager and stays untouched. Only the gateway's transport and the shim change.

1. Preflight: `openclaw channels status --probe` is green over the shim (`http://127.0.0.1:<shim port>`). Note the
   socket path from the daemon's `--socket` argument, and confirm `ls -ld` on its directory shows `drwx------`
   owned by the agent uid.
2. Configure the native transport for that account: `socketPath: "<daemon socket path>"` and `autoStart: false`,
   and remove `httpUrl`. Keeping `httpUrl` alongside `socketPath` is a config error by design (§5.2 rule 1).
3. Restart the gateway. It connects straight to the socket, and the shim gets no more traffic.
4. Verify: `channels status --probe` is green and shows `unix:/…`. Send a test DM in both directions. Messages sent
   during the restart stay queued, because the daemon runs `--receive-mode manual` and receiving resumes when the
   gateway subscribes.
5. Stop and disable the shim's service. Then `ss -ltnp` shows no listener on the shim port, and
   `node scripts/signal-isolation-check.mjs` passes. While the shim is still running, the check reports it under
   C5 (§8).

Shim cutover rollback: start the shim's service again, restore `httpUrl`, remove `socketPath`, and restart the
gateway. The daemon never gets a second listener and is never restarted, in either direction.

Recommended follow-up, not needed for the cutover: give the daemon a per-agent socket path instead of signal-cli's
default `$XDG_RUNTIME_DIR/signal-cli/socket`. The current path is safe (it sits in the 0700 runtime directory), but
it would collide if a second account ever ran under the same uid. Alternatively, let freeclaw manage the daemon
(drop `autoStart: false`) and disable the external unit. That is the default for new installs.

**Rollback (managed account):** `openclaw config set channels.signal.transport http`, then restart the gateway. The account
returns to managed HTTP. The previously persisted `httpPort` is reused if it is still in the preferred range, else
a new one is picked and persisted (existing logic). The socket file is removed at daemon exit. A stale one is
harmless, and the conformance check flags it.

## 8. Conformance check (S5)

`scripts/signal-isolation-check.mjs`: Node, no dependencies, Linux only (it uses procfs). On other platforms it
exits 2 with a message. It is read-only and never modifies anything. Docs: `docs/channels/signal-isolation.md`.
Requirements, also listed in that doc: Linux procfs, Node 22+, and iproute2 `ss` with `-x -p -H` support, whose
unix output includes the peer inode column (verified on iproute2 7.2.0). With an older or missing `ss`, C5
degrades to UNKNOWN and the run exits 3, never PASS.

**Discovery** (from `--proc <root>`, default `/proc`, injectable for tests). Discovery runs in two phases. Phase 1
finds the daemons and their socket paths. Phase 2 sweeps **every** process for relays (C5):

- A daemon is a process whose `cmdline` runs signal-cli (argv contains `org.asamk.signal.Main`, or the argv0
  basename is `signal-cli`) and has the `daemon` subcommand. Parse `-a/--account/-u/--username`, `--socket[=]`,
  `--tcp`, `--http` and `--config`. The uid comes from `status` (`Uid:` real and effective).
- Listening sockets come from `/proc/<pid>/fd/*` → `socket:[inode]`, joined with `/proc/net/tcp`, `tcp6`
  (state `0A` = LISTEN) and `/proc/net/unix` (flags `00010000` = listening, plus path).

**Assertions per daemon:**

- **C1 no TCP:** no LISTEN inode in tcp/tcp6 belongs to the daemon, **and** argv has no `--tcp`/`--http`.
  Either one means FAIL. Argv is checked separately, so a daemon whose fds cannot be read still fails on argv.
- **C2 socket ownership/mode:** the daemon has at least one listening unix socket with a filesystem path.
  `lstat(path)`: it is a socket, `uid == daemon uid`, `mode & 0o007 == 0`, and `mode & 0o070 == 0` unless
  `--allow-group` (in which case the gid must match the `--group` value when given). The parent directory is
  owned by the daemon uid, not a symlink, has `mode & 0o007 == 0`, and has no group write. So socket modes
  0600/0700 pass, 0660/0770 pass with `--allow-group`, and anything with "other" bits fails. A socket under an
  other-accessible directory fails.
- **C3 one daemon per account:** a daemon without an account (multi-account mode) fails, since it is not per-agent.
  Two daemons with the same account fail. With `--manifest <json>` (`{"agents":[{"uid":1001,"account":"…"}]}`, a
  per-host file the operator writes), each account must be served by exactly one daemon running as the listed uid.
  An account in the manifest with no daemon is **FAIL** (`daemon-missing`) unless `--allow-down`.

- **C4 receive mode (warning only):** a daemon without `--receive-mode manual` in its argv gets a `WARN`
  (`receive-mode-not-manual`). This does not affect isolation, but queued messages can be lost across gateway
  restarts.
- **C5 socket-to-TCP relays (host-wide, independent of argv):**
  1. Build the set of signal-cli socket paths: every listening unix path held by a phase-1 daemon, plus every
     `--socket` path from daemon argv, plus `socketPath` from any `--manifest`, plus signal-cli's default paths
     (`/run/user/*/signal-cli/socket` and `/tmp/signal-cli/socket`) when they exist.
  2. Find every connected unix socket whose peer is one of those listening sockets. `/proc/net/unix` does not
     expose the peer inode, so peers are resolved from `ss -xpH` (iproute2), which prints both the local and the
     peer inode.
  3. Sweep **all** processes in `/proc`, not only signal-cli ones. Any process whose fd table holds both a
     connection from step 2 and a TCP LISTEN inode (`/proc/net/tcp`, `tcp6`, state `0A`) is FAIL (`tcp-relay`).
     It is reported with pid, uid, full argv, the socket path and the TCP listen address, **whatever the binary
     is** (node shim, `socat TCP-LISTEN:… UNIX-CONNECT:…`, a socket-activated bridge, or anything else). A relay
     that spawns per-connection children, such as `socat … fork`, is caught through the parent that holds the
     listener as long as a child is connected. An idle forked relay with no live connection is not visible this
     way. The report says so, and the phase-1 C1 and manifest checks remain the primary guard.
  4. If `ss` is missing or too old, or any process's fds are unreadable (another uid while not root), C5 is
     UNKNOWN for the whole host, never PASS.

**Outcomes and exit codes:** 0 PASS (every daemon passes C1–C3). 1 FAIL (any assertion failed). 3 UNKNOWN: a
check could not be completed, for example `/proc/<pid>/fd` is unreadable (another uid while not root) or there is
nothing to check (no daemons found and no manifest). **UNKNOWN is never PASS.** 2 means a usage/platform error.
For a full-host check, run as root. Run as the agent uid, it checks only that uid's daemons and reports other uids'
daemons as UNKNOWN. Output is a human table, or `--json` with one record per daemon (`pid`, `uid`, `account`,
`checks{c1,c2,c3}`, `reasons[]`). Intentional HTTP accounts are FAIL by design, and the operator sees them listed
with reason `tcp-listener`. That is how "legacy HTTP on purpose" stays visible instead of silent (S3). An
`--allow-http <account>` option records the exception explicitly, and the report shows it as `WAIVED`, not PASS.

## 9. Tests (T1, synthetic only)

No real Signal account, no root, no real signal-cli. They run under `pnpm test`.

- `src/signal/socket-client.test.ts`: a stub `net.Server` on a temp-dir socket speaks newline JSON-RPC.
  Scripted cases: result; error with code; `result:{}`; malformed line; envelope with no result/error;
  out-of-order responses on one connection; interleaved notification before the response; split and coalesced
  chunks; oversize line; slow (timeout); server closes mid-response; ENOENT/ECONNREFUSED/EACCES (a 0000
  directory, skipped when running as root, and reported as skipped). Stream: `subscribeReceive` then N
  notifications map to SSE-shaped events identical to the HTTP fixture; wrong subscription id ignored; account
  filter; error on subscribe throws; EOF resolves; abort ends promptly.
- `src/signal/client.test.ts` (extend): `unix:` dispatch, rejection of relative/unknown schemes, `unix:` never
  turned into `http://`.
- `src/signal/transport.test.ts`: the full precedence table from §5.2, with every conflict pair erroring and
  every flip and non-flip case, on top-level, per-account and inherited merges, and on win32 via an injected
  platform.
- `src/signal/socket-dir.test.ts`: permission matrix on temp dirs. Leaf missing/0700/0755 (tightened)/0777
  (tightened); leaf is a symlink (error); leaf owned by another uid (error, simulated with injected `lstat`
  because chown needs root); other-writable non-sticky ancestor (error); sticky ancestor (ok); path too long
  (error at 108 bytes, ok at 107); stale socket (unlinked); live socket (error); regular file at the path (error,
  left untouched); post-bind chmod 0755→0600 verified; group mode with injected chown/EPERM.
- `src/signal/daemon.test.ts` (new): argv for socket has exactly one listener flag, no `--http`/`--tcp`, and
  includes `--receive-mode manual`; HTTP argv unchanged.
- `src/signal/monitor.socket.test.ts`: a monitor with a fake `cliPath`, a small Node script that binds a stub
  socket daemon at the `--socket` argument and serves JSON-RPC and notifications. End to end: spawn, ready, chmod
  verify, receive one message through the event handler, send a reply, then abort, after which the socket is
  removed. Plus: `persistSignalHttpPort` not called; HTTP config still takes the HTTP path (existing monitor tests
  unchanged).
- `src/config/zod-schema.signal-transport.test.ts`: new keys accepted, same-object conflicts rejected,
  `httpEndpointFile`/`archiveRaw` accepted.
- `src/signal/transport-parity.test.ts`: one scripted fake daemon is served two ways: (1) directly as a socket
  stub, and (2) through a minimal in-test HTTP bridge built from the A1–A4 contract in §2.6 (the shim's role). The
  same freeclaw calls (`signalRpcRequest` for every method in A2, `signalCheck`, `streamSignalEvents`) run against
  the `http://` and `unix:` endpoints and must produce identical results, identical thrown messages for error
  responses, and an identical `onEvent` sequence. This turns "the native transport replaces the shim" into a test
  instead of a claim. A non-manual-mode stub is included (unwrapped notifications ignored, warning emitted).
- `test/signal-isolation-check.test.ts`: C4 and C5 cases use a fake `ss -xpH` output and fixture fd tables. C5
  matrix: shim-shaped relay (node argv) gives FAIL; **relay with no signal-cli in its argv (`socat` argv, a
  different uid, connected to a daemon socket and holding a TCP listener) gives FAIL, with pid, uid and argv in
  the report**; a process connected to the socket without a TCP listener passes; a process with a TCP listener
  not connected to any signal socket passes; a connection to a default-path socket with no phase-1 daemon is
  still evaluated; `ss` missing or unreadable fds give UNKNOWN. C4: non-manual argv gives WARN. The other cases: synthetic `/proc` trees in temp dirs (cmdline/status/fd symlinks/net
  tables) plus real temp socket files with chmod. Cases: clean pass; TCP listener; `--http` in argv with
  unreadable fds; socket 0666; directory 0755; group socket with and without `--allow-group`; owner mismatch
  (via a fixture uid that differs from the file owner); multi-account daemon; duplicate account; manifest
  missing daemon (FAIL) and `--allow-down`; no daemons (UNKNOWN, exit 3); `--allow-http` gives WAIVED; JSON
  output schema.

Tests that need other real uids or chown are simulated through injected `lstat`/`chown`, and are documented as
simulated, never counted as real multi-uid proof.

## 10. Files

New: `src/signal/transport.ts`, `src/signal/socket-client.ts`, `src/signal/socket-dir.ts`, the tests above,
`scripts/signal-isolation-check.mjs`, `docs/channels/signal-isolation.md`.
Changed: `src/signal/client.ts` (dispatch), `src/signal/daemon.ts` (listener union), `src/signal/accounts.ts`
(baseUrl from the transport), `src/signal/monitor.ts` (socket spawn branch), `src/config/types.signal.ts`,
`src/config/zod-schema.providers-core.ts`, `src/config/schema.help.ts`, `src/config/schema.labels.ts`, the CLI and
setup key lists (§5.2), `extensions/signal/src/channel.ts` (clear-fields), `docs/channels/signal.md`,
`CHANGELOG.md`.

## 11. Open decisions (defaults chosen; build proceeds on these unless overruled)

- **F1** Persisted `httpPort`/`httpHost` do not count as HTTP intent (rule 7), so upgraders on managed HTTP flip
  to socket automatically. The alternative, keeping HTTP whenever `httpPort` is present, would leave every
  existing install on HTTP and make the ruling a no-op for upgraders.
- **F2** `archiveRaw` stays HTTP, because the supervisor only speaks HTTP. This is a known exception to the socket
  default. Making it socket-capable would be a change to `signalcli-archive-raw`, outside this repo.
- **F3** On win32 the default stays HTTP (no POSIX permission model).
- **F4** Default directory: `$XDG_RUNTIME_DIR/openclaw-signal` (tmpfs, per-uid 0700, cleared at logout), with
  `<stateDir>/signal-sockets` as the fallback.
- **F5** Conformance treats intentional HTTP as FAIL unless it is explicitly waived with `--allow-http`.
- **F6** The shim source is not readable by the build account (another user's 0700 home). The ARCH derives the
  surface from freeclaw's client, which is what binds the shim, plus the live process table. If you want the
  shim's internals cross-checked (the (shim?) items in §2.6), put a copy somewhere the build account can read.
  Build does not wait on this.
- **F7** The production daemon stays external (`autoStart: false`, its own service unit) for the cutover, so the
  daemon is not restarted. Moving it under gateway management is optional and separate.
