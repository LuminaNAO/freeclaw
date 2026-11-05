// Focus mode end to end (focus-mode ARCH §3, §5, §6, §7) on the real inbound pipeline
// (dispatch → gate → get-reply → commands / agent runner); only the model run and
// outbound sends are stubbed. Same harness as session-stack.paths.test.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalOutbound } from "../../channels/plugins/outbound/signal.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearAllFocus,
  clearSessionFocus,
  FOCUS_BUSY_NOTICE,
  FOCUS_COMBINED_HEADER,
  type FocusTier,
  listHeldFocusSessions,
  readFocusState,
  registerFocusReplayer,
  sessionFocusTier,
  setSessionFocus,
  takeHeldFocusFiles,
} from "../../infra/focus-mode.js";
import { listStack, writeStackFile } from "../../infra/session-stack.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import type { MsgContext } from "../templating.js";

const pi = vi.hoisted(() => ({
  active: false,
  streaming: false,
  steerAccepted: false,
  steered: [] as string[],
  runs: [] as Array<{ prompt: string }>,
  gates: [] as Array<Promise<void>>,
  endWaiters: [] as Array<(ended: boolean) => void>,
  aborted: 0,
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(() => {
    pi.aborted += 1;
    return true;
  }),
  compactEmbeddedPiSession: vi.fn(),
  queueEmbeddedPiMessage: vi.fn((_sessionId: string, text: string) => {
    if (!pi.steerAccepted) {
      return false;
    }
    pi.steered.push(text);
    return true;
  }),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: () => pi.active,
  isEmbeddedPiRunStreaming: () => pi.streaming,
  waitForEmbeddedPiRunEnd: vi.fn(
    () => new Promise<boolean>((resolve) => pi.endWaiters.push(resolve)),
  ),
  runEmbeddedPiAgent: vi.fn(async (params: { prompt: string }) => {
    pi.runs.push({ prompt: params.prompt });
    const gate = pi.gates.shift();
    if (gate) {
      await gate;
    }
    return {
      payloads: [{ text: `reply ${pi.runs.length}` }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    };
  }),
}));
vi.mock("../../agents/model-catalog.js", () => ({ loadModelCatalog: vi.fn(async () => []) }));
// Keep the test channel registry; the real loader would replace it from config.
vi.mock("../../plugins/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/loader.js")>()),
  loadOpenClawPlugins: vi.fn(() => undefined),
}));
const routed = vi.hoisted(() => [] as Array<{ to: string; text: string }>);
vi.mock("./route-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./route-reply.js")>()),
  routeReply: vi.fn(async (p: { to: string; payload: { text?: string } }) => {
    routed.push({ to: p.to, text: p.payload.text ?? "" });
    return { ok: true };
  }),
}));

const { dispatchInboundMessage } = await import("../dispatch.js");
const { createReplyDispatcher } = await import("./reply-dispatcher.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");
const { resetAllLanes } = await import("../../process/command-queue.js");
const { replayFocusWaiting, replaySessionStack } =
  await import("../../gateway/session-stack-replay.js");

let home: TempHomeEnv;
let sessionKey = "";

beforeEach(async () => {
  home = await createTempHomeEnv("openclaw-stack-paths-");
  await fs.mkdir(path.join(home.home, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "signal",
        plugin: createOutboundTestPlugin({
          id: "signal",
          outbound: signalOutbound,
          label: "Signal",
        }),
        source: "test",
      },
    ]),
  );
  Object.assign(pi, {
    active: false,
    streaming: false,
    steerAccepted: false,
    steered: [],
    runs: [],
    gates: [],
    endWaiters: [],
    aborted: 0,
  });
  routed.length = 0;
  delivered.length = 0;
  sessionKey = `agent:main:focus-${Math.random().toString(36).slice(2)}`;
});

afterEach(async () => {
  // Let detached drains finish before the next test reuses the process-wide queues.
  pi.active = false;
  pi.streaming = false;
  for (const release of pi.gates.splice(0)) {
    void release;
  }
  for (const resolve of pi.endWaiters.splice(0)) {
    resolve(true);
  }
  await settle();
  clearAllFocus();
  takeHeldFocusFiles();
  registerFocusReplayer(undefined);
  resetInboundDedupe();
  resetAllLanes();
  vi.unstubAllEnvs();
  await home.restore();
});

function cfg(queue: Record<string, unknown> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        workspace: path.join(home.home, "ws"),
      },
    },
    channels: { signal: { allowFrom: ["*"] } },
    messages: { queue: { mode: "collect", debounceMs: 0, ...queue } },
    session: { store: path.join(home.home, "sessions.json") },
  } as OpenClawConfig;
}

function signalCtx(
  sid: string,
  body: string,
  to = "signal:+15550001",
  extra: Partial<MsgContext> = {},
): MsgContext {
  return {
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    From: to,
    To: to,
    SessionKey: sessionKey,
    ChatType: "direct",
    SenderId: "+15550001",
    Provider: "signal",
    Surface: "signal",
    MessageSid: sid,
    OriginatingChannel: "signal",
    OriginatingTo: to,
    CommandAuthorized: true,
    ...extra,
  };
}

/** Replies delivered on the inbound surface itself (not routed elsewhere). */
const delivered: string[] = [];

function dispatch(ctx: MsgContext, config: OpenClawConfig) {
  const dispatcher = createReplyDispatcher({
    deliver: async (payload) => {
      delivered.push(payload.text ?? "");
    },
  });
  return dispatchInboundMessage({ ctx, cfg: config, dispatcher });
}

function stackFiles(): string[] {
  return listStack().flatMap((s) => s.entries.map((e) => e.file));
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

const OWNER_CFG_EXTRA = { commands: { ownerAllowFrom: ["+15550009"] } };
const log = { info: vi.fn(), warn: vi.fn() };

function ownerCfg(): OpenClawConfig {
  return { ...cfg(), ...OWNER_CFG_EXTRA } as OpenClawConfig;
}

/** The gateway registers this at start; the tests do it the same way. */
function useGatewayReplayer(): void {
  registerFocusReplayer((allow) => replayFocusWaiting(log as never, allow));
}

function focusOn(key: string, tier: FocusTier = "normal"): void {
  setSessionFocus({ sessionKey: key, tier, by: "op" });
}

describe("focus mode end to end (focus-mode ARCH §6)", () => {
  it("focused: another session's messages are stored, not run; one busy notice only", async () => {
    const config = cfg();
    focusOn("agent:main:main");
    await dispatch(signalCtx("h1", "first"), config);
    await dispatch(signalCtx("h2", "second"), config);
    await settle();
    expect(pi.runs).toEqual([]);
    expect(stackFiles()).toHaveLength(2);
    expect([...delivered, ...routed.map((r) => r.text)]).toEqual([FOCUS_BUSY_NOTICE]);
  });

  it("an operator's /focusmode works in a non-target session while focused; it is not stored", async () => {
    const config = ownerCfg();
    focusOn("agent:main:main");
    useGatewayReplayer();
    const status = createReplyDispatcher({ deliver: async () => {} });
    const sendFinal = vi.spyOn(status, "sendFinalReply");
    await dispatchInboundMessage({
      ctx: signalCtx("op1", "/focusmode", "signal:+15550009", { SenderId: "+15550009" }),
      cfg: config,
      dispatcher: status,
    });
    expect(sendFinal.mock.calls[0]?.[0]?.text).toContain("agent:main:main");
    await dispatch(
      signalCtx("op2", "/focusmode off", "signal:+15550009", { SenderId: "+15550009" }),
      config,
    );
    expect(readFocusState()).toBeUndefined();
    await settle();
    expect(pi.runs).toEqual([]);
    expect(stackFiles()).toEqual([]);
  });

  it("a non-operator's /focusmode is refused while focused; focus stays on", async () => {
    const config = ownerCfg();
    focusOn("agent:main:main");
    await dispatch(signalCtx("np1", "/focusmode off"), config);
    await settle();
    expect(sessionFocusTier(readFocusState(), "agent:main:main")).toBe("normal");
    expect(pi.runs).toEqual([]);
    expect(routed).toEqual([]);
    expect(delivered).toEqual([]);
    expect(stackFiles()).toEqual([]);
  });

  it("off: three waiting prompts → exactly one turn with all three in order, sender and time; files deleted; newest route", async () => {
    const config = ownerCfg();
    focusOn("agent:main:main");
    useGatewayReplayer();
    const t0 = Date.UTC(2026, 9, 17, 10, 0, 0);
    await dispatch(
      signalCtx("w1", "alpha", "signal:+15550001", { SenderName: "Ann", Timestamp: t0 }),
      config,
    );
    await dispatch(
      signalCtx("w2", "bravo", "signal:+15550001", { SenderName: "Ben", Timestamp: t0 + 60_000 }),
      config,
    );
    await dispatch(
      signalCtx("w3", "charlie", "signal:+15550003", {
        SenderName: "Cat",
        Timestamp: t0 + 120_000,
      }),
      config,
    );
    expect(stackFiles()).toHaveLength(3);
    routed.length = 0;

    // The operator ends it from the target session.
    const op = signalCtx("off1", "/focusmode off", "signal:+15550009", {
      SenderId: "+15550009",
      SessionKey: "agent:main:main",
    });
    await dispatch(op, config);
    expect(readFocusState()).toBeUndefined();

    await vi.waitFor(() => expect(pi.runs).toHaveLength(1));
    const prompt = pi.runs[0].prompt;
    expect(prompt).toContain(FOCUS_COMBINED_HEADER);
    const a = prompt.indexOf("alpha");
    const b = prompt.indexOf("bravo");
    const c = prompt.indexOf("charlie");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(prompt).toMatch(/\[Ann, [^\]]*2026-10-17[^\]]*\] alpha/);
    expect(prompt).toMatch(/\[Ben, [^\]]*\] bravo/);
    expect(prompt).toMatch(/\[Cat, [^\]]*\] charlie/);
    await vi.waitFor(() => expect(routed.map((r) => r.to)).toEqual(["signal:+15550003"]));
    await settle();
    expect(pi.runs).toHaveLength(1);
    expect(stackFiles()).toEqual([]);
  });

  it("restart while focused: focus still on after start; non-target files not replayed until off", async () => {
    const config = ownerCfg();
    focusOn("agent:main:main");
    await dispatch(signalCtx("r1", "before restart one"), config);
    await dispatch(signalCtx("r2", "before restart two"), config);
    expect(stackFiles()).toHaveLength(2);

    // "Restart": the process forgets its held set and dedupe; disk is all that is left.
    takeHeldFocusFiles();
    resetInboundDedupe();
    const context = { logGateway: log } as never;
    await replaySessionStack(context);
    await settle();
    expect(sessionFocusTier(readFocusState(), "agent:main:main")).toBe("normal");
    expect(pi.runs).toEqual([]);
    expect(stackFiles()).toHaveLength(2);

    useGatewayReplayer();
    await dispatch(
      signalCtx("roff", "/focusmode off", "signal:+15550009", {
        SenderId: "+15550009",
        SessionKey: "agent:main:main",
      }),
      config,
    );
    await vi.waitFor(() => expect(pi.runs).toHaveLength(1));
    expect(pi.runs[0].prompt).toContain("before restart one");
    expect(pi.runs[0].prompt).toContain("before restart two");
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("the target session's own messages run while focused", async () => {
    const config = cfg();
    focusOn(sessionKey);
    await dispatch(signalCtx("tg1", "for the target"), config);
    await vi.waitFor(() => expect(pi.runs).toHaveLength(1));
    await settle();
    expect([...delivered, ...routed.map((r) => r.text)]).toEqual(["reply 1"]);
    expect(stackFiles()).toEqual([]);
  });
});

describe("focus tiers end to end (focus-mode ARCH §7.2, §7.3, §7.6)", () => {
  const N1 = "agent:main:signal:group:n1";
  const N2 = "agent:main:signal:group:n2";
  const THIRD = "agent:main:signal:direct:+15550003";
  const HYPER = "agent:main:signal:direct:+15550004";

  function to(key: string): string {
    return `signal:${key.split(":").pop()}`;
  }

  function msg(key: string, sid: string, body: string): MsgContext {
    return signalCtx(sid, body, to(key), { SessionKey: key });
  }

  function filesOf(key: string): string[] {
    return listStack()
      .filter((s) => s.sessionKey === key)
      .flatMap((s) => s.entries.map((e) => e.file));
  }

  /** Busy notices sent so far, on the inbound surface or routed. */
  function notices(): number {
    return [...delivered, ...routed.map((r) => r.text)].filter((t) => t === FOCUS_BUSY_NOTICE)
      .length;
  }

  function promptsWith(text: string): string[] {
    return pi.runs.map((r) => r.prompt).filter((p) => p.includes(text));
  }

  it("two normal run, a third waits; hyper on a fourth holds the normal ones; lowering replays them; off replays the third", async () => {
    const config = cfg();
    useGatewayReplayer();
    focusOn(N1);
    focusOn(N2);

    await dispatch(msg(N1, "n1a", "n1 live"), config);
    await dispatch(msg(N2, "n2a", "n2 live"), config);
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    await dispatch(msg(THIRD, "t1", "third one"), config);
    await dispatch(msg(THIRD, "t2", "third two"), config);
    await settle();
    expect(pi.runs).toHaveLength(2);
    expect(filesOf(THIRD)).toHaveLength(2);
    expect(notices()).toBe(1); // one notice for the third, not two

    // Add hyper on a fourth: only the fourth runs; the two normal ones now wait too.
    focusOn(HYPER, "hyper");
    await dispatch(msg(N1, "n1b", "n1 waiting"), config);
    await dispatch(msg(N2, "n2b", "n2 waiting"), config);
    await dispatch(msg(HYPER, "h1", "hyper live"), config);
    await vi.waitFor(() => expect(promptsWith("hyper live")).toHaveLength(1));
    await settle();
    expect(pi.runs).toHaveLength(3);
    expect(filesOf(N1)).toHaveLength(1);
    expect(filesOf(N2)).toHaveLength(1);
    expect(notices()).toBe(3); // one each for the two normal sessions now waiting

    // Remove hyper: the two normal ones get their combined replay; the third still waits.
    const lowered = clearSessionFocus(HYPER);
    expect(lowered.replaying).toBe(2);
    await lowered.done;
    await vi.waitFor(() => expect(pi.runs).toHaveLength(5));
    for (const text of ["n1 waiting", "n2 waiting"]) {
      const [prompt] = promptsWith(text);
      expect(prompt).toContain(FOCUS_COMBINED_HEADER);
    }
    await settle();
    expect(filesOf(N1)).toEqual([]);
    expect(filesOf(N2)).toEqual([]);
    expect(filesOf(THIRD)).toHaveLength(2);
    expect(promptsWith("third one")).toEqual([]);
    expect(listHeldFocusSessions()).toEqual([THIRD]);

    // `/focus off` (all): the third replays, both messages in one combined prompt.
    const off = clearAllFocus();
    expect(off.replaying).toBe(1);
    await off.done;
    await vi.waitFor(() => expect(pi.runs).toHaveLength(6));
    const [third] = promptsWith("third one");
    expect(third).toContain(FOCUS_COMBINED_HEADER);
    expect(third.indexOf("third one")).toBeLessThan(third.indexOf("third two"));
    await settle();
    expect(stackFiles()).toEqual([]);
    expect(pi.runs).toHaveLength(6);
  });

  it("restart while focused at mixed tiers: the state holds and startup replays only allowed sessions", async () => {
    const config = cfg();
    focusOn(N1);
    focusOn(HYPER, "hyper");
    await dispatch(msg(N1, "r1", "n1 before restart"), config);
    await dispatch(msg(THIRD, "r2", "third before restart"), config);
    expect(pi.runs).toEqual([]);
    // A prompt of the hyper session whose turn had not finished when the gateway went down.
    const hyperCtx = msg(HYPER, "r3", "hyper before restart");
    writeStackFile({ sessionKey: HYPER, source: "inbound", payload: { ctx: hyperCtx } });
    expect(filesOf(HYPER)).toHaveLength(1);

    // "Restart": the process forgets its held set, dedupe and lanes; disk is all that is left.
    takeHeldFocusFiles();
    resetInboundDedupe();
    resetAllLanes();
    const state = readFocusState();
    expect(sessionFocusTier(state, N1)).toBe("normal");
    expect(sessionFocusTier(state, HYPER)).toBe("hyper");

    useGatewayReplayer();
    await replaySessionStack({ logGateway: log } as never);
    await vi.waitFor(() => expect(promptsWith("hyper before restart")).toHaveLength(1));
    await settle();
    expect(pi.runs).toHaveLength(1);
    expect(filesOf(HYPER)).toEqual([]);
    expect(filesOf(N1)).toHaveLength(1);
    expect(filesOf(THIRD)).toHaveLength(1);
    expect(listHeldFocusSessions().toSorted()).toEqual([N1, THIRD].toSorted());

    // Lowering releases what is now allowed: N1 only.
    await clearSessionFocus(HYPER).done;
    await vi.waitFor(() => expect(promptsWith("n1 before restart")).toHaveLength(1));
    await settle();
    expect(promptsWith("third before restart")).toEqual([]);
    expect(filesOf(N1)).toEqual([]);

    await clearAllFocus().done;
    await vi.waitFor(() => expect(promptsWith("third before restart")).toHaveLength(1));
    await settle();
    expect(stackFiles()).toEqual([]);
  });
});
