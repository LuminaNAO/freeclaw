import { describe, expect, it } from "vitest";
import {
  buildConfigSchema,
  describeConfigPathNotFound,
  lookupConfigSchema,
  suggestConfigSchemaPaths,
} from "./schema.js";

// ARCH config-path-hints §3.
describe("config path hints", () => {
  const baseSchema = buildConfigSchema();

  it("suggests the full path for a leaf that lives under a parent", () => {
    expect(lookupConfigSchema(baseSchema, "instanceName")).toBeNull();
    const res = describeConfigPathNotFound(baseSchema, "instanceName");
    expect(res.suggestions[0]).toBe("gateway.instanceName");
    expect(res.message).toBe('no config path "instanceName"; did you mean: gateway.instanceName');
  });

  it("suggests the intended path for a typo", () => {
    expect(lookupConfigSchema(baseSchema, "gateway.instancName")).toBeNull();
    expect(suggestConfigSchemaPaths(baseSchema, "gateway.instancName")[0]).toBe(
      "gateway.instanceName",
    );
  });

  it("matches leaves case-insensitively", () => {
    expect(lookupConfigSchema(baseSchema, "gateway.instancename")).toBeNull();
    expect(suggestConfigSchemaPaths(baseSchema, "gateway.instancename")[0]).toBe(
      "gateway.instanceName",
    );
    expect(suggestConfigSchemaPaths(baseSchema, "INSTANCENAME")[0]).toBe("gateway.instanceName");
  });

  it("returns no suggestions and the bare message when nothing is close", () => {
    const res = describeConfigPathNotFound(baseSchema, "zzqqxxyy.wwvvuu");
    expect(res.suggestions).toEqual([]);
    expect(res.message).toBe('no config path "zzqqxxyy.wwvvuu"');
    expect(res.message).not.toContain("does not exist");
  });

  it("suggests keys contributed by plugin schemas", () => {
    const withPlugin = buildConfigSchema({
      plugins: [
        {
          id: "hint-probe",
          configSchema: {
            type: "object",
            properties: { quuxWidgetMode: { type: "string" } },
          },
        },
      ],
    });
    expect(suggestConfigSchemaPaths(baseSchema, "quuxWidgetMode")).toEqual([]);
    expect(suggestConfigSchemaPaths(withPlugin, "quuxWidgetMode")).toEqual([
      "plugins.entries.hint-probe.config.quuxWidgetMode",
    ]);
  });

  it("ranks exact-leaf matches before close matches, caps at 5, and is deterministic", () => {
    const first = suggestConfigSchemaPaths(baseSchema, "tokn.token");
    expect(first.length).toBe(5);
    const isExactLeaf = (path: string) => path.split(".").at(-1)?.toLowerCase() === "token";
    const firstClose = first.findIndex((path) => !isExactLeaf(path));
    expect(firstClose === -1 ? first.length : firstClose).toBeGreaterThan(0);
    if (firstClose !== -1) {
      expect(first.slice(firstClose).some(isExactLeaf)).toBe(false);
    }
    expect(suggestConfigSchemaPaths(baseSchema, "tokn.token")).toEqual(first);

    const mixed = suggestConfigSchemaPaths(baseSchema, "gateway.auth.tokn");
    expect(mixed[0]).toBe("gateway.auth.token");
    expect(mixed.length).toBeLessThanOrEqual(5);
  });

  it("only suggests paths the lookup itself resolves", () => {
    for (const path of suggestConfigSchemaPaths(baseSchema, "agents.list.0.identty")) {
      expect(lookupConfigSchema(baseSchema, path)).not.toBeNull();
    }
    expect(suggestConfigSchemaPaths(baseSchema, "agents.list.0.identty")).toContain(
      "agents.list.*.identity",
    );
  });

  it("does not reflect or suggest for blocked prototype segments", () => {
    const res = describeConfigPathNotFound(baseSchema, "constructor");
    expect(res.suggestions).toEqual([]);
    expect(res.message).not.toContain("constructor");
  });
});
