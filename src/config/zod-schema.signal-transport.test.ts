import { describe, expect, it } from "vitest";
import { SignalConfigSchema } from "./zod-schema.providers-core.js";

describe("signal transport schema", () => {
  it("accepts the transport keys and the previously missing httpEndpointFile/archiveRaw", () => {
    for (const cfg of [
      {
        transport: "socket",
        socketPath: "/run/user/1001/openclaw-signal/default.sock",
        socketGroup: "sig",
      },
      { transport: "http", httpPort: 56123 },
      { httpEndpointFile: "/run/x.json" },
      { archiveRaw: true },
      {
        archiveRaw: {
          enabled: true,
          binary: "signalcli-archive-raw",
          portMin: 50000,
          portMax: 50100,
        },
      },
    ]) {
      expect(SignalConfigSchema.safeParse(cfg).success).toBe(true);
    }
  });

  it.each([
    [{ transport: "socket", httpUrl: "http://127.0.0.1:8080" }],
    [{ transport: "http", socketPath: "/x.sock" }],
    [{ socketPath: "/x.sock", archiveRaw: true }],
    [{ accounts: { a: { socketGroup: "sig", httpEndpointFile: "/x.json" } } }],
  ])("rejects same-object transport conflict %j", (cfg) => {
    expect(SignalConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it("rejects an unknown transport value", () => {
    expect(SignalConfigSchema.safeParse({ transport: "tcp" }).success).toBe(false);
  });
});
