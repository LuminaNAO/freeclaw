import { describe, expect, it } from "vitest";
import { buildDaemonArgs } from "./daemon.js";

describe("buildDaemonArgs", () => {
  it("socket mode emits exactly one listener flag and never a TCP one", () => {
    const args = buildDaemonArgs({
      cliPath: "signal-cli",
      account: "+15550001111",
      listener: { kind: "socket", path: "/run/user/1001/openclaw-signal/default.sock" },
      receiveMode: "manual",
      ignoreStories: true,
    });
    expect(args).toEqual([
      "-a",
      "+15550001111",
      "daemon",
      "--socket",
      "/run/user/1001/openclaw-signal/default.sock",
      "--no-receive-stdout",
      "--receive-mode",
      "manual",
      "--ignore-stories",
    ]);
    expect(args).not.toContain("--http");
    expect(args).not.toContain("--tcp");
  });

  it("http mode is unchanged", () => {
    expect(
      buildDaemonArgs({
        cliPath: "signal-cli",
        listener: { kind: "http", host: "127.0.0.1", port: 56123 },
        receiveMode: "manual",
      }),
    ).toEqual([
      "daemon",
      "--http",
      "127.0.0.1:56123",
      "--no-receive-stdout",
      "--receive-mode",
      "manual",
    ]);
  });
});
