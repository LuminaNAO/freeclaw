import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { listStack, writeStackFile } from "../../infra/session-stack.js";

const order: string[] = [];
vi.mock("../daemon-cli.js", () => ({
  runDaemonStop: vi.fn(async () => {
    order.push(`stop:${listStack().length}`);
  }),
}));
const findPids = vi.hoisted(() => vi.fn((): number[] => []));
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: findPids,
}));
const logs: string[] = [];
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { log: (line: string) => logs.push(line), error: vi.fn(), exit: vi.fn() },
}));

const { formatStackLines, runGatewayStackDrop } = await import("./stack.js");

describe("gateway stack commands (§7)", () => {
  it("shows per session: file count, oldest age and the first 80 characters of the oldest prompt", () => {
    writeStackFile({
      sessionKey: "agent:main:a",
      source: "agent",
      payload: { params: { message: `first ${"x".repeat(100)}` }, client: null },
    });
    writeStackFile({
      sessionKey: "agent:main:a",
      source: "inbound",
      payload: { ctx: { Body: "second" } },
    });
    const [line] = formatStackLines(Date.now() + 5_000);
    expect(line).toContain("agent:main:a");
    expect(line).toContain("files=2");
    expect(line).toMatch(/oldest=\ds/);
    expect(line).toContain(JSON.stringify(`first ${"x".repeat(100)}`.slice(0, 80)));
  });

  it("drop --yes stops the gateway first, then deletes every file and reports per session", async () => {
    const files = [
      writeStackFile({ sessionKey: "agent:main:b", source: "inbound", payload: { ctx: {} } }),
    ];
    const before = listStack().length;
    await runGatewayStackDrop({ yes: true });
    expect(order).toEqual([`stop:${before}`]);
    expect(files.every((f) => !fs.existsSync(f))).toBe(true);
    expect(listStack()).toEqual([]);
    expect(logs).toContain("agent:main:b  dropped=1");
  });

  it("with an unknown port owner, still runs the stop and drops only once the port is free (ARCH gateway-process-title-discovery §2.2)", async () => {
    order.length = 0;
    findPids.mockClear();
    findPids
      .mockImplementationOnce(() => {
        throw new Error("cannot determine which process owns gateway port 1; refusing");
      })
      .mockImplementationOnce(() => [4242])
      .mockImplementationOnce(() => []);
    const file = writeStackFile({
      sessionKey: "agent:main:c",
      source: "inbound",
      payload: { ctx: {} },
    });
    await runGatewayStackDrop({ yes: true });
    expect(order).toEqual(["stop:1"]);
    expect(findPids).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(file)).toBe(false);
  });
});
