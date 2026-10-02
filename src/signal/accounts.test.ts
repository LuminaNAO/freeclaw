import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";

function makeCfg(signal: object): OpenClawConfig {
  return { channels: { signal } } as unknown as OpenClawConfig;
}

describe("resolveSignalAccount httpEndpointFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "freeclaw-signal-endpoint-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses baseUrl from the endpoint file", () => {
    const path = join(dir, "endpoint.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "http://127.0.0.1:40947" }));
    const resolved = resolveSignalAccount({
      cfg: makeCfg({ httpEndpointFile: path }),
      accountId: undefined,
    });
    expect(resolved.baseUrl).toBe("http://127.0.0.1:40947");
    expect(resolved.configured).toBe(true);
  });

  it("takes precedence over httpUrl when both are set", () => {
    const path = join(dir, "endpoint.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "http://127.0.0.1:40911" }));
    const resolved = resolveSignalAccount({
      cfg: makeCfg({ httpEndpointFile: path, httpUrl: "http://127.0.0.1:8080" }),
      accountId: undefined,
    });
    expect(resolved.baseUrl).toBe("http://127.0.0.1:40911");
  });

  it("throws a helpful error when the file is missing", () => {
    const path = join(dir, "absent.json");
    expect(() =>
      resolveSignalAccount({
        cfg: makeCfg({ httpEndpointFile: path }),
        accountId: undefined,
      }),
    ).toThrow(/not found/);
  });

  it("throws when the file is not valid JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(() =>
      resolveSignalAccount({
        cfg: makeCfg({ httpEndpointFile: path }),
        accountId: undefined,
      }),
    ).toThrow(/not valid JSON/);
  });

  it("does not eagerly read the endpoint file when archiveRaw is enabled", () => {
    // Supervisor has not yet started, so the file does not exist. Resolution
    // must succeed (monitor.ts re-reads the file post-spawn).
    const path = join(dir, "deferred-endpoint.json");
    const resolved = resolveSignalAccount({
      cfg: makeCfg({ httpEndpointFile: path, archiveRaw: true }),
      accountId: undefined,
    });
    expect(resolved.configured).toBe(true);
    expect(resolved.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:8080$/);
  });

  it("throws when baseUrl is missing", () => {
    const path = join(dir, "missing-baseurl.json");
    writeFileSync(path, JSON.stringify({ host: "127.0.0.1", port: 40947 }));
    expect(() =>
      resolveSignalAccount({
        cfg: makeCfg({ httpEndpointFile: path }),
        accountId: undefined,
      }),
    ).toThrow(/missing a string "baseUrl"/);
  });
});

describe("resolveSignalAccount transport", () => {
  it("defaults to a unix endpoint under the per-uid socket dir, keyed by account id", () => {
    const resolved = resolveSignalAccount({
      cfg: makeCfg({ account: "+15550001111" }),
      accountId: "Work",
    });
    expect(resolved.transport?.kind).toBe("socket");
    expect(resolved.socketPath).toMatch(/\/work\.sock$/);
    expect(resolved.baseUrl).toBe(`unix:${resolved.socketPath}`);
  });

  it("keeps explicit HTTP as an http endpoint", () => {
    const resolved = resolveSignalAccount({
      cfg: makeCfg({ transport: "http", httpPort: 56123 }),
      accountId: undefined,
    });
    expect(resolved.baseUrl).toBe("http://127.0.0.1:56123");
  });

  it("fails closed with no endpoint on a conflict, per account", () => {
    const cfg = makeCfg({
      accounts: {
        bad: { socketPath: "/x/d.sock", httpUrl: "http://127.0.0.1:8080" },
        good: { socketPath: "/x/g.sock" },
      },
    });
    const bad = resolveSignalAccount({ cfg, accountId: "bad" });
    expect(bad.transportError).toMatch(/configure exactly one transport/);
    expect(bad.baseUrl).toBe("");
    expect(resolveSignalAccount({ cfg, accountId: "good" }).baseUrl).toBe("unix:/x/g.sock");
  });

  it("counts transport-only accounts as configured", () => {
    for (const signal of [
      { socketPath: "/x/s.sock" },
      { transport: "socket" },
      { socketGroup: "sig" },
    ]) {
      expect(resolveSignalAccount({ cfg: makeCfg(signal), accountId: undefined }).configured).toBe(
        true,
      );
    }
  });
});
