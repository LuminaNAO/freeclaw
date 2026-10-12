// Session prompt stack: every queue path leaves no file once its turn ends
// (docs/design/durable-inbox-stale-replay.md §1.1, §5.1). Real inbound pipeline
// (dispatch → get-reply → agent runner → followup queue → drain); only the model
// run and outbound sends are stubbed.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalOutbound } from "../../channels/plugins/outbound/signal.js";
import type { OpenClawConfig } from "../../config/config.js";
import { listStack } from "../../infra/session-stack.js";
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
const { clearSessionQueues } = await import("./queue.js");
const { getReplyFromConfig } = await import("./get-reply.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");
const { resetAllLanes } = await import("../../process/command-queue.js");

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
  sessionKey = `agent:main:paths-${Math.random().toString(36).slice(2)}`;
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

function signalCtx(sid: string, body: string, to = "signal:+15550001"): MsgContext {
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
  };
}

function dispatch(ctx: MsgContext, config: OpenClawConfig) {
  const dispatcher = createReplyDispatcher({ deliver: async () => {} });
  return dispatchInboundMessage({ ctx, cfg: config, dispatcher });
}

function stackFiles(): string[] {
  return listStack().flatMap((s) => s.entries.map((e) => e.file));
}

function gate(): () => void {
  let release!: () => void;
  pi.gates.push(new Promise<void>((r) => (release = r)));
  return release;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

/** Start turn A and hold it busy; returns a release that ends it. */
async function busyWith(config: OpenClawConfig, sid = "a1"): Promise<() => Promise<void>> {
  const release = gate();
  const run = dispatch(signalCtx(sid, "first"), config);
  await vi.waitFor(() => expect(pi.runs).toHaveLength(1));
  pi.active = true;
  return async () => {
    pi.active = false;
    pi.streaming = false;
    release();
    await run;
  };
}

describe("session prompt stack: every path ends its files (stale replay ARCH §1.1)", () => {
  it("collect: two prompts collected into one turn, reply delivered, no file remains", async () => {
    const config = cfg();
    const endA = await busyWith(config);
    await dispatch(signalCtx("c2", "second"), config);
    await dispatch(signalCtx("c3", "third"), config);
    expect(stackFiles()).toHaveLength(3);
    await endA();
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    expect(pi.runs[1].prompt).toContain("[Queued messages while agent was busy]");
    await vi.waitFor(() => expect(routed.map((r) => r.text)).toEqual(["reply 2"]));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("followup: each queued prompt runs its own turn, no file remains", async () => {
    const config = cfg({ mode: "followup" });
    const endA = await busyWith(config);
    await dispatch(signalCtx("f2", "second"), config);
    await dispatch(signalCtx("f3", "third"), config);
    expect(stackFiles()).toHaveLength(3);
    await endA();
    await vi.waitFor(() => expect(pi.runs).toHaveLength(3));
    await vi.waitFor(() => expect(routed).toHaveLength(2));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("steer: steered into the active run, file goes when that run ends", async () => {
    const config = cfg({ mode: "steer" });
    const endA = await busyWith(config);
    pi.streaming = true;
    pi.steerAccepted = true;
    await dispatch(signalCtx("s2", "steer me"), config);
    expect(pi.steered).toHaveLength(1);
    expect(stackFiles()).toHaveLength(2);
    await endA();
    for (const resolve of pi.endWaiters.splice(0)) {
      resolve(true);
    }
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("steer-backlog: steered and queued, file goes when the backlog turn ends", async () => {
    const config = cfg({ mode: "steer-backlog" });
    const endA = await busyWith(config);
    pi.streaming = true;
    pi.steerAccepted = true;
    await dispatch(signalCtx("sb2", "steer and keep"), config);
    expect(stackFiles()).toHaveLength(2);
    await endA();
    for (const resolve of pi.endWaiters.splice(0)) {
      resolve(true);
    }
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("interrupt: the new prompt runs after aborting the busy one, no file remains", async () => {
    const config = cfg({ mode: "interrupt" });
    const endA = await busyWith(config);
    pi.active = false;
    const b = dispatch(signalCtx("i2", "interrupting"), config);
    await endA();
    await b;
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("queue cap drop (old): the dropped prompt is deleted, the rest end with their turn", async () => {
    const config = cfg({ mode: "followup", cap: 1, drop: "old" });
    const endA = await busyWith(config);
    await dispatch(signalCtx("d2", "dropped"), config);
    await dispatch(signalCtx("d3", "kept"), config);
    expect(stackFiles()).toHaveLength(2);
    await endA();
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("queue cap summarize: the summary turn ends the files it consumed", async () => {
    const config = cfg({ mode: "followup", cap: 1, drop: "summarize" });
    const endA = await busyWith(config);
    await dispatch(signalCtx("y2", "summarised"), config);
    await dispatch(signalCtx("y3", "kept"), config);
    await endA();
    await vi.waitFor(() => expect(pi.runs.length).toBeGreaterThanOrEqual(2));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("/stop: queued prompts are cleared and their files deleted", async () => {
    const config = cfg();
    const endA = await busyWith(config);
    await dispatch(signalCtx("st2", "queued"), config);
    expect(stackFiles()).toHaveLength(2);
    await dispatch(signalCtx("st3", "/stop"), config);
    await endA();
    await settle();
    expect(pi.runs).toHaveLength(1);
    expect(stackFiles()).toEqual([]);
  });

  it("/new and gateway reset: cleared queues delete their files", async () => {
    const config = cfg();
    const endA = await busyWith(config);
    await dispatch(signalCtx("n2", "queued"), config);
    expect(stackFiles()).toHaveLength(2);
    // sessions.reset / /new clear the session's queues the same way.
    clearSessionQueues([sessionKey]);
    await endA();
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("cross-channel collect: each item drained individually, no file remains", async () => {
    const config = cfg();
    const endA = await busyWith(config);
    await dispatch(signalCtx("x2", "from one", "signal:+15550001"), config);
    await dispatch(signalCtx("x3", "from another", "signal:+15550002"), config);
    await endA();
    await vi.waitFor(() => expect(pi.runs).toHaveLength(3));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("collect while a heartbeat turn is busy: no file remains", async () => {
    const config = cfg();
    const release = gate();
    const hb = getReplyFromConfig(
      {
        Body: "heartbeat",
        From: "signal:+15550001",
        To: "signal:+15550001",
        Provider: "heartbeat",
        SessionKey: sessionKey,
      },
      { isHeartbeat: true },
      config,
    );
    await vi.waitFor(() => expect(pi.runs).toHaveLength(1));
    pi.active = true;
    await dispatch(signalCtx("h2", "while heartbeat busy"), config);
    expect(stackFiles()).toHaveLength(1);
    pi.active = false;
    release();
    await hb;
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    await settle();
    expect(stackFiles()).toEqual([]);
  });

  it("queue cleared while its drain runs: a prompt queued after the clear is not orphaned", async () => {
    const config = cfg({ mode: "followup" });
    const endA = await busyWith(config);
    await dispatch(signalCtx("r2", "queued before clear"), config);
    const releaseB = gate();
    await endA();
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    // While the drain runs r2: /stop or reset clears the queue, then a new prompt queues.
    clearSessionQueues([sessionKey]);
    pi.active = true;
    await dispatch(signalCtx("r3", "queued after clear"), config);
    pi.active = false;
    releaseB();
    await vi.waitFor(() => expect(pi.runs).toHaveLength(3));
    await settle();
    expect(stackFiles()).toEqual([]);
  });
});

describe("incident: answered prompt replayed after restart (stale replay ARCH §0, §1.1)", () => {
  // Production: a Signal message arrived while the session was busy, was collected
  // ("[Queued messages while agent was busy]"), answered — and its stack file stayed.
  // The gateway runs the reply pipeline from more than one bundled chunk; the queues
  // and drain callbacks are process-wide, but stack ownership was a module-local
  // WeakMap, so the copy that ran the collect turn saw no files to delete.
  it("collected and answered while another bundled copy drains the queue: no file remains", async () => {
    const config = cfg();
    // Another chunk's copy of the reply pipeline (same source, separate module instance).
    vi.resetModules();
    const other = await import("./get-reply.js");
    const release = gate();
    const busy = other.getReplyFromConfig(
      {
        Body: "system event",
        From: "signal:+15550001",
        To: "signal:+15550001",
        Provider: "heartbeat",
        SessionKey: sessionKey,
      },
      { isHeartbeat: true },
      config,
    );
    await vi.waitFor(() => expect(pi.runs).toHaveLength(1));
    pi.active = true;
    await dispatch(signalCtx("i1", "message while busy"), config);
    expect(stackFiles()).toHaveLength(1);
    pi.active = false;
    release();
    await busy;
    await vi.waitFor(() => expect(pi.runs).toHaveLength(2));
    expect(pi.runs[1].prompt).toContain("[Queued messages while agent was busy]");
    await vi.waitFor(() => expect(routed.map((r) => r.text)).toEqual(["reply 2"]));
    await settle();
    expect(stackFiles()).toEqual([]);
  });
});
