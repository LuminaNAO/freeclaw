import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { FIELD_HELP } from "./schema.help.js";
import { buildConfigSchema, lookupConfigSchema } from "./schema.js";
import { FIELD_LABELS } from "./schema.labels.js";

// no-reply-tool §5.4: agents.defaults.silentReply / agents.list[].silentReply, schema-validated and documented.

describe("silentReply config", () => {
  it.each(["tool", "token"] as const)("accepts agents.defaults.silentReply %s", (mode) => {
    expect(validateConfigObject({ agents: { defaults: { silentReply: mode } } }).ok).toBe(true);
  });

  it("accepts a per-agent silentReply", () => {
    expect(
      validateConfigObject({ agents: { list: [{ id: "main", silentReply: "token" }] } }).ok,
    ).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(validateConfigObject({ agents: { defaults: { silentReply: "off" } } }).ok).toBe(false);
    expect(validateConfigObject({ agents: { list: [{ id: "main", silentReply: true }] } }).ok).toBe(
      false,
    );
  });

  it("documents both keys with label and help naming every mode", () => {
    for (const key of ["agents.defaults.silentReply", "agents.list[].silentReply"]) {
      expect(FIELD_LABELS[key], key).toBeDefined();
      const help = FIELD_HELP[key];
      expect(help, key).toBeDefined();
      for (const token of ['"tool"', '"token"']) {
        expect(help.includes(token), `${key} help names ${token}`).toBe(true);
      }
    }
    expect(FIELD_HELP["agents.defaults.silentReply"]).toMatch(/default/);
  });

  it("appears in the generated config schema with both values", () => {
    const schema = buildConfigSchema();
    type Node = {
      properties?: Record<string, Node>;
      items?: Node;
      anyOf?: Node[];
      const?: unknown;
      enum?: unknown[];
    };
    const root = schema.schema as Node;
    const agents = root.properties?.agents;
    const fields = [
      agents?.properties?.defaults?.properties?.silentReply,
      agents?.properties?.list?.items?.properties?.silentReply,
    ];
    for (const field of fields) {
      expect(field).toBeDefined();
      const values = JSON.stringify(field);
      expect(values).toContain('"tool"');
      expect(values).toContain('"token"');
    }
    for (const path of ["agents.defaults.silentReply", "agents.list.0.silentReply"]) {
      expect(lookupConfigSchema(schema, path), path).not.toBeNull();
      expect(lookupConfigSchema(schema, path)?.hint?.label, path).toBeDefined();
    }
  });
});
