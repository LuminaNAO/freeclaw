// ARCH §4.3, §4.4: the Signal provider. Classifier against the synthetic fixtures; the
// provider's listing, id recovery and write calls; and freeclaw's own Signal client over
// both transports (HTTP and unix socket) against local stubs. No live daemon is used.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseAgentSessionKey, signalRpcRequest } from "openclaw/plugin-sdk/model-badge";
import { afterAll, describe, expect, it } from "vitest";
import * as S from "../../test-helpers/signal-fixtures.js";
import { classify, outcomeFromError, type RpcOutcome } from "./classify.js";
import { resolveSignalEndpoint } from "./index.js";
import {
  createClientRpc,
  createSignalProvider,
  isLoopbackUrl,
  type SignalRpc,
} from "./provider.js";

const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
const g = { kind: "group" as const };

describe("classify (ported, synthetic fixtures)", () => {
  it("maps every fixture to its documented class", () => {
    expect(classify(S.ok(S.updateOk()), g).kind).toBe("ok");
    expect(classify(S.ok(S.updateRateLimited()), g).kind).toBe("ok-rate-limited");
    expect(classify(S.ok(S.updateCaptcha(900)), g)).toEqual({
      kind: "captcha",
      committed: true,
      retryAfterMs: 900_000,
    });
    expect(classify(S.ok(S.errGroupNotFound()), g)).toMatchObject({
      kind: "permanent",
      reason: "not-found",
    });
    expect(classify(S.ok(S.errNotMember()), g)).toMatchObject({ reason: "not-found" });
    expect(classify(S.ok(S.errNotAllowed()), g)).toMatchObject({ reason: "permission" });
    expect(classify(S.ok(S.errIo()), g)).toEqual({ kind: "pause", reason: "provider-io" });
    expect(
      classify(S.ok(S.errAvatarMissing("/c/a.png")), { kind: "group", avatarPath: "/c/a.png" })
        .kind,
    ).toBe("config");
    const prof = { kind: "profile" as const, avatarPath: "/c/p.png" };
    expect(classify(S.ok(S.errProfileAvatarUnreadable("/c/p.png")), prof)).toMatchObject({
      kind: "config",
      source: "avatar",
    });
    expect(classify(S.ok(S.errProfileIo()), prof)).toEqual({
      kind: "pause",
      reason: "provider-io",
      neverPark: true,
    });
    expect(classify(S.ok(S.errRateLimitFallback()), g).kind).toBe("rate-limit-uncommitted");
    expect(classify({ transport: "http", status: 429, retryAfterMs: 5 }, g)).toEqual({
      kind: "rate-limit-uncommitted",
      retryAfterMs: 5,
    });
    expect(classify({ transport: "refused" }, g)).toEqual({ kind: "pause", reason: "daemon-down" });
    expect(classify({ transport: "timeout" }, g)).toEqual({ kind: "pause", reason: "daemon-down" });
    expect(classify({ transport: "http", status: 500 }, g)).toMatchObject({
      reason: "daemon-down",
    });
    expect(classify(S.ok({ error: { code: -1, message: "odd" } }), g).kind).toBe("error");
    expect(classify(S.ok({ result: {} }), g).kind).toBe("ok");
  });

  it("turns freeclaw client errors back into outcomes", () => {
    expect(outcomeFromError(new Error("Signal RPC -1: Group not found: X"))).toEqual({
      transport: "ok",
      body: { error: { code: -1, message: "Group not found: X" } },
    });
    expect(
      outcomeFromError(new Error("Signal RPC -32603: Failed to send message: a\nb")),
    ).toMatchObject({ transport: "ok" });
    expect(outcomeFromError(new Error("Signal RPC returned malformed JSON (status 502)"))).toEqual({
      transport: "http",
      status: 502,
    });
    expect(outcomeFromError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toEqual({
      transport: "timeout",
    });
    expect(
      outcomeFromError(new Error("Signal RPC updateGroup timed out after 5ms (socket)")),
    ).toEqual({ transport: "timeout" });
    expect(outcomeFromError(new Error("Signal socket /x unavailable (ENOENT)"))).toEqual({
      transport: "refused",
    });
    expect(outcomeFromError(new TypeError("fetch failed"))).toEqual({ transport: "refused" });
  });
});

function provider(
  rpc: SignalRpc,
  o: { baseUrl?: string; account?: string | null; profile?: boolean } = {},
) {
  return createSignalProvider({
    config: {
      agentId: "main",
      accountId: null,
      profileSessionKey: o.profile ? "agent:main:signal:direct:+10000000001" : null,
      profileBaseImage: null,
    },
    endpoint: {
      baseUrl: o.baseUrl ?? "http://127.0.0.1:1",
      account: o.account === undefined ? S.ACCOUNT : o.account,
    },
    rpc,
    parseSessionKey: parseAgentSessionKey,
    clock,
  });
}

describe("Signal provider", () => {
  it("canEdit from the listing, case recovery, ambiguity; never sends the lowercased id or a title", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const groups = [
      S.group("MiXeDcAsEiDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="),
      S.group("AdminOnlyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=", {
        edit: "ONLY_ADMINS",
        admin: false,
      }),
      S.group("AdminOnlyMexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=", {
        edit: "ONLY_ADMINS",
        admin: true,
      }),
      S.group("DupIdxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="),
      S.group("dupidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="),
      S.group("Leftxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=", { member: false }),
      {
        ...S.group("NoNumberxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=", { edit: "ONLY_ADMINS" }),
        members: [{ number: null, isAdmin: true }],
      },
    ];
    const p = provider(async (method, params) => {
      calls.push({ method, params });
      return method === "listGroups" ? S.ok(S.listGroups(groups)) : S.ok(S.updateOk());
    });
    const r = await p.listTargets();
    expect(r.ok).toBe(true);
    const by = Object.fromEntries((r.ok ? r.targets : []).map((t) => [t.ref.idLower, t]));
    expect(by["mixedcaseidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="]!.canEdit).toBe(true);
    expect(by["adminonlyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="]!.canEdit).toBe(false);
    expect(by["adminonlymexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="]!.canEdit).toBe(true);
    expect(by["nonumberxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="]!.canEdit).toBe("unknown");
    expect(by["leftxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="]!.member).toBe(false);
    expect(calls[0]!.params.account).toBe(S.ACCOUNT);

    const ref = p.targetForSessionKey(
      "agent:main:signal:group:mixedcaseidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
    )!;
    const res = await p.resolve(ref);
    expect(res).toEqual({ ok: true, realId: "MiXeDcAsEiDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=" });
    const amb = await p.resolve({
      kind: "group",
      idLower: "dupidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
    });
    expect(amb.ok === false && amb.result).toMatchObject({ reason: "ambiguous-id" });
    const miss = await p.resolve({ kind: "group", idLower: "nosuchgroup" }, { minRefreshMs: 0 });
    expect(miss.ok === false && miss.result).toMatchObject({ reason: "not-found" });

    await p.apply(
      { ref, realId: "MiXeDcAsEiDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=" },
      "/abs/asset.png",
    );
    const upd = calls.find((c) => c.method === "updateGroup")!;
    expect(Object.keys(upd.params).toSorted()).toEqual(["account", "avatar", "groupId"]);
    expect(upd.params.groupId).toBe("MiXeDcAsEiDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=");
  });

  it("maps session keys with freeclaw's parser: own agent's Signal groups and the profile only", () => {
    const p = provider(async () => S.ok(S.updateOk()), { profile: true });
    expect(p.targetForSessionKey("agent:main:signal:group:AbC=")).toEqual({
      kind: "group",
      idLower: "abc=",
    });
    expect(p.targetForSessionKey("agent:other:signal:group:abc")).toBeNull();
    expect(p.targetForSessionKey("agent:main:telegram:group:abc")).toBeNull();
    expect(p.targetForSessionKey("agent:main:signal:direct:+10000000003")).toBeNull();
    expect(p.targetForSessionKey("agent:main:signal:direct:+10000000001")).toEqual({
      kind: "profile",
      idLower: "profile",
    });
    expect(p.targetForSessionKey("not-a-key")).toBeNull();
    expect(p.sessionKeyFor({ kind: "group", idLower: "abc=" })).toBe(
      "agent:main:signal:group:abc=",
    );
  });

  it("maps group memory's raw event id ('group:<id>') to the session-key target (ARCH §2c.11)", () => {
    const p = provider(async () => S.ok(S.updateOk()));
    const fromKey = p.targetForSessionKey("agent:main:signal:group:AbC=");
    expect(p.groupRefForEventId!("group:AbC=")).toEqual(fromKey);
    expect(p.groupRefForEventId!("GROUP:AbC=")).toEqual(fromKey);
    expect(p.groupRefForEventId!("AbC=")).toEqual(fromKey);
    expect(p.groupRefForEventId!("group:")).toBeNull();
    expect(p.miskeyedEventIds!({ kind: "group", idLower: "abc=" })).toEqual(["group:abc="]);
  });

  it("profile writes use updateProfile with the account and the avatar only", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const p = provider(
      async (method, params) => (calls.push({ method, params }), S.ok(S.updateOk())),
      { profile: true },
    );
    await p.apply(
      { ref: { kind: "profile", idLower: "profile" }, realId: "profile" },
      "/abs/p.png",
    );
    expect(calls).toEqual([
      { method: "updateProfile", params: { account: S.ACCOUNT, avatar: "/abs/p.png" } },
    ]);
  });

  it("the daemon must be local (loopback or unix socket) and the account must have a number", () => {
    const noop = async (): Promise<RpcOutcome> => S.ok(S.updateOk());
    expect(provider(noop).configError()).toBeNull();
    expect(provider(noop, { baseUrl: "unix:/run/signal/d.sock" }).configError()).toBeNull();
    expect(provider(noop, { baseUrl: "http://signal-daemon.invalid:8080" }).configError()).toMatch(
      /must be local/,
    );
    expect(provider(noop, { account: null }).configError()).toMatch(/no number/);
    expect(isLoopbackUrl("http://[::1]:1") && isLoopbackUrl("http://localhost:2")).toBe(true);
  });

  it("resolves the daemon by account through freeclaw's account resolution, not by position", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+10000000000",
          httpUrl: "http://127.0.0.1:18001",
          accounts: {
            second: { account: "+10000000005", httpUrl: "http://127.0.0.1:18002" },
          },
        },
      },
    };
    expect(resolveSignalEndpoint(cfg, null)).toMatchObject({
      baseUrl: "http://127.0.0.1:18001",
      account: "+10000000000",
    });
    expect(resolveSignalEndpoint(cfg, "second")).toMatchObject({
      baseUrl: "http://127.0.0.1:18002",
      account: "+10000000005",
    });
  });
});

// ---------------- freeclaw's Signal client over both transports ----------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "model-badge-signal-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Reply = (method: string, params: Record<string, unknown>) => unknown;

async function httpStub(reply: Reply) {
  const seen: Array<{ url?: string; body: { method: string; params: Record<string, unknown> } }> =
    [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) {
      body += c;
    }
    const msg = JSON.parse(body);
    seen.push({ url: req.url, body: msg });
    const out = reply(msg.method, msg.params);
    if (typeof out === "number") {
      res.writeHead(out).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ...(out as object), id: msg.id }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function socketStub(reply: Reply) {
  const socketPath = path.join(tmp, `d${Math.random().toString(36).slice(2, 8)}.sock`);
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push({ method: msg.method, params: msg.params });
        sock.write(
          `${JSON.stringify({ ...(reply(msg.method, msg.params) as object), id: msg.id })}\n`,
        );
        nl = buf.indexOf("\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  return {
    url: `unix:${socketPath}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const scripted: Reply = (method, params) => {
  if (method === "listGroups") {
    return S.listGroups([S.group("FakeGroupAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA=")]);
  }
  if (params.groupId === "FakeGroupGonexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=") {
    return S.errGroupNotFound();
  }
  if (params.groupId === "FakeGroupLimitedxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=") {
    return S.updateRateLimited();
  }
  return S.updateOk();
};

for (const transport of ["http", "unix-socket"] as const) {
  describe(`freeclaw Signal client over ${transport}`, () => {
    it("lists, writes and classifies through the real client", async () => {
      const stub = transport === "http" ? await httpStub(scripted) : await socketStub(scripted);
      try {
        const rpc = createClientRpc((m, p, o) => signalRpcRequest(m, p, o), {
          baseUrl: stub.url,
          timeoutMs: 2000,
        });
        const p = provider(rpc, { baseUrl: stub.url });
        expect(p.configError()).toBeNull();
        const list = await p.listTargets();
        expect(list.ok && list.targets.map((t) => t.ref.idLower)).toEqual([
          "fakegroupaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
        ]);
        const ref = {
          kind: "group" as const,
          idLower: "fakegroupaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
        };
        expect(
          await p.apply(
            { ref, realId: "FakeGroupAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA=" },
            "/abs/a.png",
          ),
        ).toEqual({ kind: "ok" });
        expect(
          await p.apply(
            { ref, realId: "FakeGroupLimitedxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=" },
            "/abs/a.png",
          ),
        ).toEqual({ kind: "ok-rate-limited" });
        expect(
          await p.apply(
            { ref, realId: "FakeGroupGonexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=" },
            "/abs/a.png",
          ),
        ).toMatchObject({
          kind: "permanent",
          reason: "not-found",
        });
        const methods =
          transport === "http"
            ? (stub.seen as Array<{ body: { method: string } }>).map((s) => s.body.method)
            : (stub.seen as Array<{ method: string }>).map((s) => s.method);
        expect(methods).toEqual(["listGroups", "updateGroup", "updateGroup", "updateGroup"]);
        if (transport === "http") {
          expect((stub.seen as Array<{ url?: string }>)[0]!.url).toBe("/api/v1/rpc");
        }
      } finally {
        await stub.close();
      }
    });

    it("a daemon that is not there pauses (daemon-down), never throws", async () => {
      const url =
        transport === "http" ? "http://127.0.0.1:9" : `unix:${path.join(tmp, "missing.sock")}`;
      const rpc = createClientRpc((m, p, o) => signalRpcRequest(m, p, o), {
        baseUrl: url,
        timeoutMs: 500,
      });
      const p = provider(rpc, { baseUrl: url });
      const r = await p.apply({ ref: { kind: "group", idLower: "x" }, realId: "X" }, "/abs/a.png");
      expect(r).toEqual({ kind: "pause", reason: "daemon-down" });
      const l = await p.listTargets();
      expect(l.ok).toBe(false);
    });
  });
}

describe("freeclaw Signal client over http: HTTP-level failures", () => {
  it("a 5xx with a non-JSON body pauses", async () => {
    const stub = await httpStub(() => 500);
    try {
      const rpc = createClientRpc((m, p, o) => signalRpcRequest(m, p, o), {
        baseUrl: stub.url,
        timeoutMs: 2000,
      });
      const r = await provider(rpc, { baseUrl: stub.url }).apply(
        { ref: { kind: "group", idLower: "x" }, realId: "X" },
        "/a.png",
      );
      expect(r).toMatchObject({ kind: "pause", reason: "daemon-down" });
    } finally {
      await stub.close();
    }
  });
});
