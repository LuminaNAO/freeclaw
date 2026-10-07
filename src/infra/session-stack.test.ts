import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindStackFiles,
  finishStackFiles,
  listStack,
  resolveStackDir,
  stackFilesOf,
  takeStackFiles,
  writeStackFile,
} from "./session-stack.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-test-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("session prompt stack store (§3)", () => {
  it("writes one 0600 file per prompt in a 0700 session directory", () => {
    const file = writeStackFile({
      sessionKey: "agent:main:main",
      source: "agent",
      payload: { message: "hi" },
      stateDir,
    });
    const dir = path.dirname(file);
    expect(dir).toBe(path.join(resolveStackDir(stateDir), encodeURIComponent("agent:main:main")));
    expect(path.basename(file)).toMatch(/^\d+-\d+\.json$/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      source: "agent",
      payload: { message: "hi" },
    });
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });

  it("lists sessions with files oldest first and the payload byte-identical", () => {
    const payload = { ctx: { Body: 'ü \u2028 \n\t"q"', SenderId: "s1", MessageThreadId: 7 } };
    const files = [1, 2, 3].map((i) =>
      writeStackFile({ sessionKey: "k", source: "inbound", payload: { ...payload, i }, stateDir }),
    );
    const listed = listStack(stateDir);
    expect(listed).toHaveLength(1);
    expect(listed[0].sessionKey).toBe("k");
    expect(listed[0].entries.map((e) => e.file)).toEqual(files);
    expect(listed[0].entries.map((e) => (e.content.payload as { i: number }).i)).toEqual([1, 2, 3]);
    expect(JSON.stringify(listed[0].entries[0].content.payload)).toBe(
      JSON.stringify({ ...payload, i: 1 }),
    );
  });

  it("deletes at turn end whatever the outcome", () => {
    const a = writeStackFile({ sessionKey: "k", source: "agent", payload: 1, stateDir });
    const b = writeStackFile({ sessionKey: "k", source: "agent", payload: 2, stateDir });
    const c = writeStackFile({ sessionKey: "k", source: "agent", payload: 3, stateDir });
    finishStackFiles([a]);
    finishStackFiles([b]);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(listStack(stateDir)[0].entries.map((e) => e.file)).toEqual([c]);
  });

  it("hands files between owners: the previous owner no longer ends them", () => {
    const a = writeStackFile({ sessionKey: "k", source: "inbound", payload: 1, stateDir });
    const owner = {};
    bindStackFiles(owner, [a]);
    expect(stackFilesOf(owner)).toEqual([a]);
    const handed = takeStackFiles(owner);
    finishStackFiles(stackFilesOf(owner));
    expect(fs.existsSync(a)).toBe(true);
    finishStackFiles(handed);
    expect(fs.existsSync(a)).toBe(false);
  });
});
