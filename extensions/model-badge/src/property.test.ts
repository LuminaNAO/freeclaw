// Seeded property test (ported from the standalone certification): random model swaps,
// models.json edits, badge-rule and style edits, target churn and provider failures,
// with invariants checked on every write call, then convergence, idempotency and a
// quiet restart. Deterministic per seed; runs on both providers (ARCH §6.5).
import { describe, expect, it } from "vitest";
import { createSteering } from "./core/steering.js";
import { createStyleStore } from "./core/style.js";
import { BADGES, createWorld, IDS, type Outcome } from "./test-helpers/world.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

const MODELS = [
  "prov/fable-model",
  "prov/opus-a",
  "prov/opus-b",
  "prov/k-model",
  "prov/plain-new",
  "prov/ghost",
];
const POOL = [
  IDS.a,
  IDS.b,
  IDS.c,
  "FakeTargetDdddddddddddddddddddddddddddddddddddD=",
  "FakeTargetEeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeE=",
];

async function run(seed: number, backend: "signal" | "fakechat") {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)] as T;
  const w = await createWorld({
    backend,
    targets: [IDS.a, IDS.b, IDS.c],
    timing: { pruneGraceMs: 0 },
  });
  const violations: string[] = [];
  const writes: string[] = [];
  for (const op of ["unlink", "writeFile", "writeAtomic", "rename", "rmrf"] as const) {
    const orig = w.fs[op].bind(w.fs) as (...a: unknown[]) => Promise<void>;
    (w.fs as unknown as Record<string, unknown>)[op] = async (...a: unknown[]) => {
      writes.push(String(a[op === "rename" ? 1 : 0]));
      return orig(...a);
    };
  }
  w.backend.always((s) => {
    if (s.kind === "group" && !w.backend.has(s.target)) {
      if (POOL.some((id) => id.toLowerCase() === s.target)) {
        violations.push(`lowercased id sent: ${s.target}`);
      }
      return "not-found";
    }
    if (!s.avatar.startsWith(`${w.paths.stateDir}/assets/`)) {
      violations.push(`avatar outside the cache: ${s.avatar}`);
    }
    const f = w.fs.files.get(s.avatar);
    if (!f || f.data.length < 33 || f.data.readUInt32BE(16) !== 512) {
      violations.push(`avatar not a 512px PNG on disk: ${s.avatar}`);
    }
    return faults.shift() ?? "ok";
  });
  const faults: Outcome[] = [];

  const e = await w.startEngine();
  await w.settle();
  const steering = createSteering({
    engines: () => [e],
    store: createStyleStore({ fs: w.fs, stateDir: w.paths.rootDir }),
    operators: () => ["+10000000002"],
    allowGroupMembers: () => false,
    configRules: () => [],
    now: () => w.clock.now(),
  });

  const present = new Set([IDS.a, IDS.b, IDS.c]);
  for (let step = 0; step < 60; step++) {
    const op = Math.floor(r() * 12);
    if (op <= 2) {
      w.pin(pick([...present]), pick(MODELS));
    } else if (op === 3) {
      w.unpin(pick([...present]));
    } else if (op === 4) {
      w.setModels({ prov: MODELS.filter(() => r() < 0.6).map((m) => m.split("/")[1]!) });
    } else if (op === 5) {
      w.setDefault(pick(MODELS.slice(0, 5)));
    } else if (op === 6) {
      w.setPlugin({
        badges: BADGES.map((b) =>
          b.letter === "F" ? { ...b, color: pick(["#FFD700", "#FFD701", "#FFD702"]) } : b,
        ),
      });
    } else if (op === 7) {
      await steering.add(
        [
          {
            match: { targetId: pick([...present]).toLowerCase() },
            set: { motif: pick(["rings", "waves", "facets", "dots"]) },
          },
        ],
        {
          senderId: "+10000000002",
        },
      );
    } else if (op === 8) {
      const id = pick(POOL);
      if (!present.has(id)) {
        present.add(id);
        w.addTarget(id);
      }
    } else if (op === 9) {
      const id = pick([...present]);
      if (present.size > 1) {
        present.delete(id);
        w.backend.dropTarget(id);
      }
    } else {
      faults.push(pick<Outcome>(["rate-limited", "io", { captcha: 900 }]));
    }
    await w.clock.advance(Math.floor(r() * 9000));
  }

  faults.length = 0;
  w.backend.setDown(false);
  await e.reconcileNow();
  for (let i = 0; i < 6; i++) {
    await w.settle(900_000);
  }
  await e.runPass("periodic");
  for (let i = 0; i < 4; i++) {
    await w.settle(900_000);
  }

  const failures: string[] = [];
  for (const k of e.knownTargets()) {
    const s = e.targetSummary(k)!;
    if (e.status().parked[k] || "error" in s.desired) {
      continue;
    }
    if (!s.converged) {
      failures.push(`${k}: desired ${s.desired.hash} but showing ${s.applied?.hash ?? "nothing"}`);
    }
  }
  // Generate/prune: every required asset is on disk, and anything else on disk is still
  // referenced by applied.json (an asset a target shows is never pruned).
  const view = e.view()!;
  const requiredSet = new Set(e.refs().flatMap((ref) => view.requiredFor(ref).map((j) => j.hash)));
  const appliedSet = new Set(Object.values(e.applied().targets).map((a) => a.hash));
  const onDisk = new Set(w.assets().map((f) => f.slice(f.lastIndexOf("/") + 1, -4)));
  const missingRequired = [...requiredSet].filter((h) => !onDisk.has(h));
  const unreferenced = [...onDisk].filter((h) => !requiredSet.has(h) && !appliedSet.has(h));

  const before = w.sends().length;
  await e.runPass("periodic");
  await w.settle(900_000);
  const extra = w.sends().length - before;

  await e.stop();
  const e2 = await w.startEngine({ instanceId: "after-restart" });
  const beforeRestart = w.sends().length;
  await w.settle(300_000);
  const restartSends = w.sends().length - beforeRestart;
  await e2.stop();

  const outside = writes.filter((p) => !p.startsWith(`${w.paths.rootDir}/`));
  return { violations, failures, extra, restartSends, outside, missingRequired, unreferenced };
}

for (const backend of ["signal", "fakechat"] as const) {
  describe(`property: random churn and faults (${backend})`, () => {
    for (const seed of [1, 2, 3, 5, 8, 13]) {
      it(`seed ${seed}: invariants hold, converges, idempotent, required assets present, nothing unreferenced, restart-quiet`, async () => {
        const res = await run(seed, backend);
        expect(res.violations).toEqual([]);
        expect(res.outside).toEqual([]);
        expect(res.failures).toEqual([]);
        expect(res.missingRequired).toEqual([]);
        expect(res.unreferenced).toEqual([]);
        expect(res.extra).toBe(0);
        expect(res.restartSends).toBe(0);
      });
    }
  });
}
