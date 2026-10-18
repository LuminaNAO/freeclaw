import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";

// reasoning-display ARCH §3: schema + docs for reasoningDefault.

describe("reasoningDefault config", () => {
  it.each(["on", "off", "stream"] as const)(
    "accepts agents.defaults.reasoningDefault %s",
    (level) => {
      const res = validateConfigObject({ agents: { defaults: { reasoningDefault: level } } });
      expect(res.ok).toBe(true);
    },
  );

  it("accepts a per-agent reasoningDefault", () => {
    const res = validateConfigObject({
      agents: { list: [{ id: "main", reasoningDefault: "off" }] },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown reasoningDefault values", () => {
    expect(validateConfigObject({ agents: { defaults: { reasoningDefault: "auto" } } }).ok).toBe(
      false,
    );
    expect(
      validateConfigObject({ agents: { list: [{ id: "main", reasoningDefault: true }] } }).ok,
    ).toBe(false);
  });

  it("documents both keys with label and help naming every level", () => {
    for (const key of ["agents.defaults.reasoningDefault", "agents.list[].reasoningDefault"]) {
      expect(FIELD_LABELS[key], key).toBeDefined();
      const help = FIELD_HELP[key];
      expect(help, key).toBeDefined();
      for (const token of ['"on"', '"off"', '"stream"']) {
        expect(help.includes(token), `${key} help names ${token}`).toBe(true);
      }
    }
    expect(FIELD_HELP["agents.defaults.reasoningDefault"]).toMatch(/messaging channels/);
  });
});
