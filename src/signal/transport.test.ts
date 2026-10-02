import { describe, expect, it } from "vitest";
import type { SignalAccountConfig } from "../config/types.signal.js";
import {
  formatSignalUnixEndpoint,
  parseSignalUnixEndpoint,
  resolveSignalTransport,
  SignalTransportConfigError,
} from "./transport.js";

const r = (cfg: SignalAccountConfig, platform: NodeJS.Platform = "linux") =>
  resolveSignalTransport(cfg, platform);

describe("resolveSignalTransport precedence", () => {
  it("defaults to socket (the default flip)", () => {
    expect(r({})).toMatchObject({ kind: "socket", ignoredHttpKeys: false });
  });

  it("does not treat persisted httpHost/httpPort as HTTP intent", () => {
    expect(r({ httpPort: 56123 })).toMatchObject({ kind: "socket", ignoredHttpKeys: true });
    expect(r({ httpHost: "127.0.0.1" })).toMatchObject({ kind: "socket", ignoredHttpKeys: true });
  });

  it("honors explicit transport", () => {
    expect(r({ transport: "http", httpPort: 56123 })).toEqual({ kind: "http" });
    expect(r({ transport: "socket" })).toMatchObject({ kind: "socket" });
  });

  it("keeps inherently-HTTP setups on HTTP", () => {
    expect(r({ httpUrl: "http://127.0.0.1:8080" })).toEqual({ kind: "http" });
    expect(r({ httpEndpointFile: "/run/x.json" })).toEqual({ kind: "http" });
    expect(r({ archiveRaw: true })).toEqual({ kind: "http" });
    expect(r({ archiveRaw: { enabled: true } })).toEqual({ kind: "http" });
  });

  it("treats a disabled archiveRaw as absent", () => {
    expect(r({ archiveRaw: false })).toMatchObject({ kind: "socket" });
    expect(r({ archiveRaw: { enabled: false } })).toMatchObject({ kind: "socket" });
  });

  it("selects socket from socketPath, including with autoStart:false (external daemon)", () => {
    expect(r({ socketPath: "/run/user/1001/x.sock" })).toMatchObject({
      kind: "socket",
      socketPath: "/run/user/1001/x.sock",
    });
    expect(r({ socketPath: "/run/user/1001/x.sock", autoStart: false })).toMatchObject({
      kind: "socket",
    });
  });

  it("keeps a self-managed legacy daemon (autoStart:false, no socketPath) on HTTP", () => {
    expect(r({ autoStart: false, httpPort: 8080 })).toEqual({ kind: "http" });
  });

  it("stays HTTP on win32 unless socket is explicit", () => {
    expect(r({}, "win32")).toEqual({ kind: "http" });
    expect(r({ transport: "socket" }, "win32")).toMatchObject({ kind: "socket" });
  });

  it("expands ~/ and rejects relative socket paths", () => {
    const resolved = r({ socketPath: "~/sig.sock" });
    expect(resolved.kind === "socket" && resolved.socketPath?.endsWith("/sig.sock")).toBe(true);
    expect(() => r({ socketPath: "rel/sig.sock" })).toThrow(SignalTransportConfigError);
  });

  it.each([
    [{ transport: "socket", httpUrl: "http://x" }],
    [{ transport: "socket", httpEndpointFile: "/x.json" }],
    [{ transport: "socket", archiveRaw: true }],
    [{ transport: "http", socketPath: "/x.sock" }],
    [{ transport: "http", socketGroup: "sig" }],
    [{ socketPath: "/x.sock", httpUrl: "http://x" }],
    [{ socketGroup: "sig", archiveRaw: true }],
    [{ socketPath: "/x.sock", httpEndpointFile: "/x.json" }],
  ] as Array<[SignalAccountConfig]>)("rejects conflict %j instead of downgrading", (cfg) => {
    expect(() => r(cfg)).toThrow(SignalTransportConfigError);
  });
});

describe("unix endpoint", () => {
  it("round-trips and requires an absolute path", () => {
    expect(parseSignalUnixEndpoint(formatSignalUnixEndpoint("/a/b.sock"))).toBe("/a/b.sock");
    expect(parseSignalUnixEndpoint("http://127.0.0.1:1")).toBeUndefined();
    expect(() => parseSignalUnixEndpoint("unix:rel.sock")).toThrow(/absolute/);
    expect(() => parseSignalUnixEndpoint("unix:")).toThrow(/absolute/);
  });
});
