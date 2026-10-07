import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ARCH gateway-process-title-discovery §3.2: a fake /proc with two titled gateways
// (cmdline is just "openclaw-gateway") listening on different ports.
type FakeProc = Record<string, string>;
const files = vi.hoisted(() => ({ current: {} as FakeProc }));

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
}

vi.mock("node:fs", () => {
  const readFileSync = (path: string) => {
    const value = files.current[path];
    if (value === undefined) {
      throw enoent(path);
    }
    return value;
  };
  const readdirSync = (dir: string) => {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const names = new Set<string>();
    for (const key of Object.keys(files.current)) {
      if (key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split("/")[0] ?? "");
      }
    }
    if (names.size === 0) {
      throw enoent(dir);
    }
    return [...names];
  };
  const readlinkSync = readFileSync;
  return { default: { readFileSync, readdirSync, readlinkSync } };
});

const { findVerifiedGatewayListenerPidsOnPortSync } = await import("./gateway-processes.js");

const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function tcpRow(port: number, inode: number, state = "0A"): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: 0100007F:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;
}

const TITLE = "openclaw-gateway\0\0\0\0\0\0\0\0";
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

describe("titled gateway discovery on linux (ARCH §2.1, §2.2)", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    files.current = {
      "/proc/net/tcp": TCP_HEADER + tcpRow(40797, 111) + tcpRow(40798, 222),
      "/proc/net/tcp6": TCP_HEADER,
      "/proc/1001/cmdline": TITLE,
      "/proc/1001/fd/0": "/dev/null",
      "/proc/1001/fd/21": "socket:[111]",
      "/proc/1002/cmdline": TITLE,
      "/proc/1002/fd/21": "socket:[222]",
      "/proc/1002/fd/22": "socket:[999]",
      "/proc/self/fd/0": "/dev/null",
    };
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("returns only the titled gateway listening on the configured port", () => {
    expect(findVerifiedGatewayListenerPidsOnPortSync(40797)).toEqual([1001]);
    expect(findVerifiedGatewayListenerPidsOnPortSync(40798)).toEqual([1002]);
  });

  it("returns nothing when no process listens on the port", () => {
    expect(findVerifiedGatewayListenerPidsOnPortSync(40799)).toEqual([]);
  });

  it("ignores non-LISTEN sockets on the port", () => {
    files.current["/proc/net/tcp"] = TCP_HEADER + tcpRow(40797, 111, "01");
    expect(findVerifiedGatewayListenerPidsOnPortSync(40797)).toEqual([]);
  });

  it("does not return a listener that is not a gateway", () => {
    files.current["/proc/1001/cmdline"] = "python\0-m\0http.server\0";
    expect(findVerifiedGatewayListenerPidsOnPortSync(40797)).toEqual([]);
  });

  it("refuses when the port is listening but its owner is not visible", () => {
    delete files.current["/proc/1001/fd/21"];
    expect(() => findVerifiedGatewayListenerPidsOnPortSync(40797)).toThrow(
      /cannot determine which process owns gateway port 40797.*refusing/,
    );
  });

  it("refuses when /proc/net/tcp cannot be read", () => {
    delete files.current["/proc/net/tcp"];
    delete files.current["/proc/net/tcp6"];
    expect(() => findVerifiedGatewayListenerPidsOnPortSync(40797)).toThrow(/refusing/);
  });
});
