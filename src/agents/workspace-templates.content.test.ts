import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Default core files ARCH §5: template set, size targets and §2 principle key phrases.
const TEMPLATE_DIR = path.resolve(import.meta.dirname, "../../docs/reference/templates");

const DEFAULT_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "BOOT.md",
] as const;

const DEV_FILES = [
  "AGENTS.dev.md",
  "SOUL.dev.md",
  "IDENTITY.dev.md",
  "USER.dev.md",
  "TOOLS.dev.md",
] as const;

const SIZE_TARGETS: Record<string, number> = {
  "AGENTS.md": 3 * 1024,
  "AGENTS.dev.md": 3 * 1024,
  "SOUL.md": 2 * 1024,
  "SOUL.dev.md": 2 * 1024,
};

// §2 principles, key phrase -> file §4 assigns it to.
const PRINCIPLES: Array<{ phrase: string; file: "SOUL.md" | "AGENTS.md" }> = [
  { phrase: "Trust over hierarchy.", file: "SOUL.md" },
  { phrase: "Truth over sycophancy.", file: "SOUL.md" },
  { phrase: "Evidence over assumption; operator experience over convention.", file: "SOUL.md" },
  { phrase: "Name the gaps.", file: "SOUL.md" },
  { phrase: "Trust is calibrated, not granted.", file: "AGENTS.md" },
  { phrase: "Don't invent gates.", file: "AGENTS.md" },
  { phrase: "Brevity is the service.", file: "SOUL.md" },
  { phrase: "Write it down.", file: "AGENTS.md" },
  { phrase: "Map what you are handed.", file: "AGENTS.md" },
  { phrase: "Private stays private.", file: "SOUL.md" },
];

function read(name: string): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf-8");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// A template set: the default files, with *.dev.md variants swapped in for the dev set.
function templateSet(variant: "default" | "dev"): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of DEFAULT_FILES) {
    const devName = name.replace(/\.md$/, ".dev.md");
    const useDev = variant === "dev" && (DEV_FILES as readonly string[]).includes(devName);
    files[name] = read(useDev ? devName : name);
  }
  return files;
}

describe("default workspace templates", () => {
  it("ships every template file", () => {
    for (const name of [...DEFAULT_FILES, ...DEV_FILES]) {
      expect(fs.existsSync(path.join(TEMPLATE_DIR, name)), name).toBe(true);
    }
  });

  it("keeps AGENTS and SOUL under their size targets", () => {
    for (const [name, limit] of Object.entries(SIZE_TARGETS)) {
      const size = Buffer.byteLength(read(name), "utf-8");
      expect(size, `${name} is ${size} bytes`).toBeLessThanOrEqual(limit);
    }
  });

  for (const variant of ["default", "dev"] as const) {
    it(`states each principle exactly once, in its assigned file (${variant})`, () => {
      const files = templateSet(variant);
      const all = Object.values(files).join("\n");
      for (const { phrase, file } of PRINCIPLES) {
        expect(countOccurrences(all, phrase), phrase).toBe(1);
        expect(files[file], `${phrase} in ${file}`).toContain(phrase);
      }
    });
  }

  it("has no emoji headers or deployment-specific persona", () => {
    for (const name of [...DEFAULT_FILES, ...DEV_FILES]) {
      const content = read(name);
      for (const line of content.split("\n")) {
        if (/^#+\s/.test(line)) {
          expect(line, `${name}: ${line}`).not.toMatch(/\p{Extended_Pictographic}/u);
        }
      }
      expect(content, name).not.toMatch(/C-3PO|C3-PO|Clawd|Clawdributors|Peter|lobster/i);
    }
  });

  it("does not tell the agent to delegate work it can do itself", () => {
    for (const name of [...DEFAULT_FILES, ...DEV_FILES]) {
      expect(read(name), name).not.toMatch(/\bdelegate\b|sub-?agent/i);
    }
  });

  it("keeps the post-compaction sections and heartbeat ack in AGENTS.md", () => {
    for (const name of ["AGENTS.md", "AGENTS.dev.md"]) {
      const content = read(name);
      expect(content).toContain("## Session Startup");
      expect(content).toContain("## Red Lines");
      expect(content).toContain("HEARTBEAT_OK");
    }
  });

  it("keeps IDENTITY.md placeholders recognised by the identity parser", () => {
    const content = read("IDENTITY.md");
    for (const label of ["Name", "Creature", "Vibe", "Emoji", "Avatar"]) {
      expect(content).toContain(`- **${label}:**`);
    }
  });
});
