import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Architecture-driven development (ARCH preamble): ARCH.md is the only design document.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      return d.name === "node_modules" ? [] : sourceFiles(full);
    }
    return /\.(ts|md|json)$/.test(d.name) ? [full] : [];
  });
}

describe("ARCH is the single source of truth", () => {
  it("ships no separate spec", () => {
    expect(fs.existsSync(path.join(root, "SPEC.md"))).toBe(false);
  });

  it("states architecture-driven development in the ARCH preamble", () => {
    const arch = fs.readFileSync(path.join(root, "ARCH.md"), "utf8");
    expect(arch).toContain("Development is architecture-driven: there is no separate spec.");
    expect(arch).not.toContain("SPEC");
  });

  it("cites ARCH sections, never SPEC, in code, tests and README", () => {
    const offenders = sourceFiles(root)
      .filter((f) => f !== fileURLToPath(import.meta.url))
      .filter((f) => /\bSPEC\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
