import { describe, expect, it } from "vitest";
import {
  collectReleasePackageMetadataErrors,
  collectReleaseTagErrors,
  parseReleaseVersion,
  utcCalendarDayDistance,
} from "../scripts/openclaw-npm-release-check.ts";

describe("parseReleaseVersion", () => {
  it("parses integer product releases through npm-compatible SemVer", () => {
    expect(parseReleaseVersion("2.0.0")).toMatchObject({
      version: "2.0.0",
      channel: "stable",
      scheme: "integer",
      major: 2,
    });
  });

  it("parses integer product beta releases through npm-compatible SemVer", () => {
    expect(parseReleaseVersion("3.0.0-beta.2")).toMatchObject({
      version: "3.0.0-beta.2",
      channel: "beta",
      scheme: "integer",
      major: 3,
      betaNumber: 2,
    });
  });

  it("parses stable CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.10")).toMatchObject({
      version: "2026.3.10",
      channel: "stable",
      year: 2026,
      month: 3,
      day: 10,
    });
  });

  it("parses beta CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.10-beta.2")).toMatchObject({
      version: "2026.3.10-beta.2",
      channel: "beta",
      year: 2026,
      month: 3,
      day: 10,
      betaNumber: 2,
    });
  });

  it("rejects legacy and malformed release formats", () => {
    expect(parseReleaseVersion("2026.3.10-1")).toBeNull();
    expect(parseReleaseVersion("2026.03.09")).toBeNull();
    expect(parseReleaseVersion("v2026.3.10")).toBeNull();
    expect(parseReleaseVersion("2026.2.30")).toBeNull();
    expect(parseReleaseVersion("2.0.0-beta2")).toBeNull();
  });
});

describe("utcCalendarDayDistance", () => {
  it("compares UTC calendar days rather than wall-clock hours", () => {
    const left = new Date("2026-03-09T23:59:59Z");
    const right = new Date("2026-03-11T00:00:01Z");
    expect(utcCalendarDayDistance(left, right)).toBe(2);
  });
});

describe("collectReleaseTagErrors", () => {
  it("accepts integer product tags for npm-compatible major versions", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2.0.0",
        releaseTag: "v2",
        now: new Date("2026-06-28T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("accepts integer product beta tags for npm-compatible major beta versions", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "3.0.0-beta.1",
        releaseTag: "v3-beta.1",
        now: new Date("2026-06-28T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects SemVer-shaped tags for integer product releases", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2.0.0",
        releaseTag: "v2.0.0",
        now: new Date("2026-06-28T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("expected v2"));
  });

  it("accepts versions within the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10",
        now: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects versions outside the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10",
        now: new Date("2026-03-13T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("must be within 2 days"));
  });

  it("rejects tags that do not match the current release format", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10-1",
        now: new Date("2026-03-10T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("must match vN, vN-beta.N"));
  });
});

describe("collectReleasePackageMetadataErrors", () => {
  it("validates the expected npm package metadata", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
        peerDependencies: { "node-llama-cpp": "3.16.2" },
        peerDependenciesMeta: { "node-llama-cpp": { optional: true } },
      }),
    ).toEqual([]);
  });

  it("requires node-llama-cpp to stay an optional peer", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
        peerDependencies: { "node-llama-cpp": "3.16.2" },
      }),
    ).toContain('package.json peerDependenciesMeta["node-llama-cpp"].optional must be true.');
  });
});
