import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readBaseUrlFromEndpointFile,
  resolveArchiveRawSettings,
  waitForEndpointFile,
} from "./archive-supervisor.js";

describe("resolveArchiveRawSettings", () => {
  it("disabled when undefined or false", () => {
    expect(resolveArchiveRawSettings(undefined).enabled).toBe(false);
    expect(resolveArchiveRawSettings(false).enabled).toBe(false);
  });

  it("enabled with defaults when true", () => {
    const r = resolveArchiveRawSettings(true);
    expect(r.enabled).toBe(true);
    expect(r.binary).toBe("signalcli-archive-raw");
    expect(r.endpointFile).toMatch(/\.signal-archive\/endpoint\.json$/);
  });

  it("respects object form overrides", () => {
    const r = resolveArchiveRawSettings({
      binary: "/usr/local/bin/sca",
      endpointFile: "/tmp/ep.json",
      log: "/tmp/raw.log",
      portMin: 41000,
      portMax: 41099,
    });
    expect(r.enabled).toBe(true);
    expect(r.binary).toBe("/usr/local/bin/sca");
    expect(r.endpointFile).toBe("/tmp/ep.json");
    expect(r.log).toBe("/tmp/raw.log");
    expect(r.portMin).toBe(41000);
    expect(r.portMax).toBe(41099);
  });

  it("explicit enabled:false disables", () => {
    expect(resolveArchiveRawSettings({ enabled: false }).enabled).toBe(false);
  });
});

describe("readBaseUrlFromEndpointFile / waitForEndpointFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "freeclaw-archive-sup-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads baseUrl from a present file", () => {
    const path = join(dir, "endpoint.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "http://127.0.0.1:40911" }));
    expect(readBaseUrlFromEndpointFile(path)).toBe("http://127.0.0.1:40911");
  });

  it("waitForEndpointFile times out when file never appears", async () => {
    const path = join(dir, "never.json");
    await expect(waitForEndpointFile({ path, timeoutMs: 200, pollIntervalMs: 50 })).rejects.toThrow(
      /Timed out/,
    );
  });

  it("waitForEndpointFile returns once file appears", async () => {
    const path = join(dir, "soon.json");
    setTimeout(
      () => writeFileSync(path, JSON.stringify({ baseUrl: "http://127.0.0.1:40922" })),
      80,
    );
    const url = await waitForEndpointFile({ path, timeoutMs: 1000, pollIntervalMs: 30 });
    expect(url).toBe("http://127.0.0.1:40922");
  });
});
