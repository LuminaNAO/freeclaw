// ARCH §6.4 (no committed art), §6.6 (hygiene) and the structural rules of §4.1/§5.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const EXT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(EXT, "..", "..");

// Every file this extension ships: tracked plus new (untracked, not ignored).
function shipped(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "."],
    { cwd: EXT },
  ).toString();
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(EXT, f)));
}
const read = (f: string) => fs.readFileSync(path.join(EXT, f), "utf8");
const code = () => shipped().filter((f) => f.endsWith(".ts"));
// The operator-owned design doc describes, it does not ship data; this gate file names
// the patterns it forbids, so it is not scanned for them.
const SELF = "src/hygiene.test.ts";
const scanned = () => shipped().filter((f) => f !== "ARCH.md" && f !== SELF);

describe("no committed art (ARCH §6.4)", () => {
  it("the extension contains no image files", () => {
    const images = shipped().filter((f) =>
      /\.(svg|png|jpe?g|webp|gif|bmp|ico|avif|tiff?)$/i.test(f),
    );
    expect(images).toEqual([]);
    // Nothing that sniffs as an image either, whatever its name.
    const sniffed = shipped().filter((f) => {
      const b = fs.readFileSync(path.join(EXT, f));
      return (
        b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
        (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
        b.subarray(0, 4).toString("latin1") === "RIFF" ||
        b.subarray(0, 4).toString("latin1") === "GIF8"
      );
    });
    expect(sniffed).toEqual([]);
  });

  it("no embedded base64 images or data URIs with payloads", () => {
    const hits: string[] = [];
    for (const f of scanned()) {
      const t = read(f);
      for (const m of t.matchAll(/data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]{16,})/g)) {
        hits.push(`${f}: ${m[0].slice(0, 40)}`);
      }
      // PNG / JPEG / GIF / WebP magic in base64.
      for (const m of t.matchAll(/(iVBORw0KGgo|\/9j\/4|R0lGOD|UklGR)[A-Za-z0-9+/]{20,}/g)) {
        hits.push(`${f}: ${m[0].slice(0, 40)}`);
      }
      // Any long base64 run at all.
      for (const m of t.matchAll(/[A-Za-z0-9+/]{120,}={0,2}/g)) {
        hits.push(`${f}: long base64 ${m[0].slice(0, 20)}…`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no SVG path data or point lists longer than the parametric primitives", () => {
    const hits: string[] = [];
    for (const f of scanned()) {
      const t = read(f);
      // Literal path data: d="..." with real coordinates (computed paths use ${…}).
      for (const m of t.matchAll(/\bd=["'`]([^"'`$]{24,})["'`]/g)) {
        hits.push(`${f}: path data ${m[1]!.slice(0, 30)}`);
      }
      for (const m of t.matchAll(/\bpoints=["'`]([^"'`$]{24,})["'`]/g)) {
        hits.push(`${f}: points ${m[1]!.slice(0, 30)}`);
      }
      // Coordinate soup: a long run of numbers that only drawn art would contain.
      for (const m of t.matchAll(/(?:-?\d+(?:\.\d+)?[ ,]+){24,}/g)) {
        hits.push(`${f}: coordinate list ${m[0].slice(0, 30)}`);
      }
      // A literal <svg> document in a string with an embedded drawing.
      if (/<svg[^`]*<path d="[MmLlCcQqAa]\s*\d/.test(t)) {
        hits.push(`${f}: literal svg drawing`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the base generator uses geometric primitives only and no imported art", () => {
    const motif = read("src/core/motif.ts");
    expect(motif).not.toMatch(/readFile|import\s.*\.svg|<image|href=/);
    const tags = new Set([...motif.matchAll(/<([a-zA-Z]+)[\s>]/g)].map((m) => m[1]));
    expect([...tags].toSorted()).toEqual(
      [
        "circle",
        "defs",
        "g",
        "linearGradient",
        "path",
        "polygon",
        "rect",
        "stop",
        "svg",
      ].toSorted(),
    );
  });

  it("the standalone repo's art inputs and tools are not carried over", () => {
    // Names built indirectly so this file does not match itself.
    const dropped = [
      "extract" + "-bases",
      "import" + "-legacy",
      "art" + "Dir",
      "glyphs" + ".json",
      "registry" + ".json",
      "badge-state" + ".json",
    ];
    const re = new RegExp(dropped.map((d) => d.replace(/[.]/g, "\\.")).join("|"));
    expect(shipped().filter((f) => re.test(f) || /legacy\.ts$|\/base\//.test(f))).toEqual([]);
    for (const f of code().filter((x) => x !== SELF)) {
      expect(read(f), f).not.toMatch(re);
    }
  });
});

describe("hygiene (ARCH §6.6)", () => {
  const RULES: Array<[RegExp, string]> = [
    [/\/home\/[a-z]/i, "home directory path"],
    [/\/Users\/[A-Za-z]/, "home directory path"],
    [/\/mnt\/|\/media\/[a-z]/, "host mount path"],
    [/\+(?!1000000)\d{10,14}\b/, "phone number that is not a +1000000xxxx placeholder"],
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!127\.0\.0\.1)(?<!10\.1\.2\.3)/, "IP address"],
    [/\b(?:sk-|ghp_|xox[bp]-)[A-Za-z0-9]{10,}/, "secret-looking token"],
    [/[\w.+-]+@[\w-]+\.[\w.-]+/, "e-mail address"],
  ];

  it("no host paths, real numbers, IPs, e-mail addresses or secrets in shipped files", () => {
    const hits: string[] = [];
    for (const f of scanned()) {
      const t = read(f);
      for (const [re, what] of RULES) {
        const m = re.exec(t);
        if (m) {
          hits.push(`${f}: ${what}: ${m[0]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("URLs point only at loopback or placeholder hosts", () => {
    const bad: string[] = [];
    for (const f of scanned()) {
      for (const m of read(f).matchAll(/https?:\/\/([^\s/"'`)<>]+)/g)) {
        const host = m[1]!.replace(/:(\d+|\$\{[^}]*\})$/, "");
        if (
          !/^(127\.0\.0\.1|localhost|www\.w3\.org|\[?::1\]?|10\.1\.2\.3)$/.test(host) &&
          !host.endsWith(".invalid") &&
          !host.startsWith("${")
        ) {
          bad.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("every id-shaped string is an obvious placeholder", () => {
    const bad: string[] = [];
    for (const f of scanned()) {
      const t = read(f);
      for (const m of t.matchAll(/\b[A-Za-z0-9+/]{43}=/g)) {
        if (!/^(Fake|RkFLRUZB)|x{6,}|([a-z])\2{5,}/i.test(m[0])) {
          bad.push(`${f}: ${m[0]}`);
        }
      }
      for (const m of t.matchAll(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      )) {
        if (!/^00000000-0000-(0000|4000)-(0000|8000)-00000000000\d$/.test(m[0])) {
          bad.push(`${f}: ${m[0]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("commits on this branch since the operator ARCH use the org identity and carry no trailers", () => {
    let log = "";
    try {
      const base = execFileSync(
        "git",
        ["log", "--format=%H", "--grep=^model-badge: extension ARCH", "-n", "1"],
        { cwd: REPO },
      )
        .toString()
        .trim();
      if (!base) {
        return;
      }
      log = execFileSync(
        "git",
        ["log", "--format=%h%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e", `${base}~1..HEAD`],
        { cwd: REPO },
      ).toString();
    } catch {
      return; // not a git checkout (e.g. a packed install)
    }
    const org = ["Lumina Nao <luminanao", "duck.com>"].join("@");
    for (const entry of log.split("\x1e").filter((s) => s.trim())) {
      const [sha, author, committer, body] = entry.trim().split("\x1f");
      expect(author, `${sha} author`).toBe(org);
      expect(committer, `${sha} committer`).toBe(org);
      expect(body, `${sha} trailer`).not.toMatch(
        /^(co-authored-by|generated (with|by)|signed-off-by)\b/im,
      );
    }
  });
});

describe("structure (ARCH §4.1, §5)", () => {
  it("the core imports no provider and nothing channel-specific", () => {
    for (const f of code().filter((x) => x.startsWith("src/core/"))) {
      const t = read(f);
      expect(t, f).not.toMatch(/from\s+["'][^"']*providers\//);
      expect(t, f).not.toMatch(/plugin-sdk\/(signal|telegram|discord|slack|msteams)/);
      expect(t, f).not.toMatch(/["'](updateGroup|updateProfile|listGroups)["']/);
    }
  });

  it("only the engine calls provider.apply; only the Signal provider issues Signal write RPCs", () => {
    const appliers = code().filter(
      (f) =>
        !f.endsWith(".test.ts") && !f.includes("test-helpers") && /provider\.apply\(/.test(read(f)),
    );
    expect(appliers).toEqual(["src/core/engine.ts"]);
    const writers = code().filter(
      (f) =>
        !f.endsWith(".test.ts") &&
        !f.includes("test-helpers") &&
        /["'](updateGroup|updateProfile)["']/.test(read(f)),
    );
    expect(writers).toEqual(["src/providers/signal/provider.ts"]);
  });

  it("the Signal provider uses freeclaw's own Signal client and session-key parser", () => {
    const idx = read("src/providers/signal/index.ts");
    expect(idx).toMatch(/signalRpcRequest/);
    expect(idx).toMatch(/resolveSignalAccount/);
    expect(idx).toMatch(/parseAgentSessionKey/);
    const prov = read("src/providers/signal/provider.ts");
    expect(prov).not.toMatch(/\bfetch\(|node:http|node:net/);
    expect(prov).not.toMatch(/httpPort|8080/);
  });

  it("commands and the tool never reach a provider's write path", () => {
    for (const f of ["src/commands.ts", "src/tool.ts", "index.ts"]) {
      const t = read(f).replace(/\/\/.*$/gm, "");
      expect(t, f).not.toMatch(/\.apply\(|updateGroup|updateProfile|signalRpcRequest|fetch\(/);
    }
  });

  it("the layout follows extensions/swarm: manifest, package, index.ts, src/", () => {
    for (const f of [
      "openclaw.plugin.json",
      "package.json",
      "index.ts",
      "README.md",
      "src/core/engine.ts",
      "src/providers/signal/provider.ts",
    ]) {
      expect(fs.existsSync(path.join(EXT, f)), f).toBe(true);
    }
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.openclaw.extensions).toEqual(["./index.ts"]);
  });
});
