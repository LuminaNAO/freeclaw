import { describe, expect, it } from "vitest";
import { loadRuntimeSourceFilesForGuardrails } from "../test-utils/runtime-source-guardrail-scan.js";

// The Control UI is off by default (opt-in). Readers must go through
// isControlUiEnabled(cfg); a scattered `?? true` / `!== false` fallback would
// silently turn it back on for configs that omit the key.
const DEFAULT_ON_FALLBACK = /controlUi\??\.enabled\s*(?:\?\?\s*true\b|!==?\s*false\b)/u;

describe("Control UI default-off source guard", () => {
  it("has no default-on fallbacks for controlUi.enabled in non-test source", async () => {
    const files = await loadRuntimeSourceFilesForGuardrails(process.cwd());
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = file.source.split(/\r?\n/u);
      // Also catch fallbacks split across lines (e.g. `?.enabled ??\n true`).
      if (!DEFAULT_ON_FALLBACK.test(file.source.replace(/\s+/gu, " "))) {
        continue;
      }
      lines.forEach((_, index) => {
        const window = lines
          .slice(index, index + 2)
          .join(" ")
          .replace(/\s+/gu, " ");
        if (DEFAULT_ON_FALLBACK.test(window)) {
          offenders.push(`${file.relativePath}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the forbidden forms", () => {
    expect(DEFAULT_ON_FALLBACK.test("cfg.gateway?.controlUi?.enabled ?? true")).toBe(true);
    expect(DEFAULT_ON_FALLBACK.test("cfg.gateway?.controlUi?.enabled !== false")).toBe(true);
    expect(DEFAULT_ON_FALLBACK.test("cfg.gateway.controlUi.enabled ?? true")).toBe(true);
    expect(DEFAULT_ON_FALLBACK.test("cfg.gateway?.controlUi?.enabled === true")).toBe(false);
    expect(DEFAULT_ON_FALLBACK.test("isControlUiEnabled(cfg)")).toBe(false);
  });
});
