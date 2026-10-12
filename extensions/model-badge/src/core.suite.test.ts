// The core behaviour suite, ported from the certified standalone replays (incidents I*,
// closed events C*, queue/limits Q*, writer W*) plus the fold-in lifecycle (ARCH §3,
// §6.3). It runs unchanged against the Signal provider and a fake second provider
// (ARCH §6.5). Every test runs with no gateway events other than the engine's start.
import { describe, expect, it } from "vitest";
import { createLease } from "./core/lease.js";
import { createWorld, IDS, MODELS, type WorldOpts } from "./test-helpers/world.js";

const { a: A, b: B, c: C } = IDS;

for (const backend of ["signal", "fakechat"] as const) {
  describe(`core suite on the ${backend} provider`, () => {
    const world = (o: WorldOpts = {}) => createWorld({ backend, ...o });
    async function started(o: WorldOpts = {}) {
      const w = await world(o);
      const e = await w.startEngine();
      await w.settle();
      return { w, e };
    }

    // ---------------- incidents ----------------

    it("I1: a stale entry.model is never used; unpinned targets show the default model", async () => {
      const { w, e } = await started({ defaultModel: "prov/k-model" });
      expect(w.sends()).toHaveLength(2);
      for (const s of w.sends()) {
        expect(w.letterOf(s)).toBe("KL");
      }
      for (const a of Object.values(w.applied())) {
        expect(a.model).toBe("prov/k-model");
      }
      await e.stop();
    });

    it("I2: same-mark swaps, A→B→A inside the debounce window → 0 writes", async () => {
      const { w, e } = await started();
      const base = w.sends().length;
      w.pin(A, "prov/opus-a");
      await w.settle();
      expect(w.sends()).toHaveLength(base + 1);
      w.pin(A, "prov/opus-b"); // same mark (O)
      await w.settle();
      expect(w.sends()).toHaveLength(base + 1);
      w.pin(A, "prov/k-model");
      await w.clock.advance(500);
      w.pin(A, "prov/opus-a");
      await w.settle();
      expect(w.sends()).toHaveLength(base + 1);
      await e.stop();
    });

    it("I3: a store change with no events at all repaints within watch + debounce", async () => {
      const { w, e } = await started();
      const before = w.sends().length;
      w.pin(B, "prov/k-model");
      await w.clock.advance(3000 + 1500 + 100);
      expect(w.sends()).toHaveLength(before + 1);
      expect(w.letterOf(w.sends().at(-1))).toBe("KL");
      expect(e.status().health.watcherMisses).toBeUndefined();
      await e.stop();
    });

    it("I4: no edit permission from the listing → parked with 0 sends; stays parked", async () => {
      const { w, e } = await started({
        targetOpts: { [A]: { edit: "ONLY_ADMINS", admin: false } },
      });
      expect(w.targetSends(A)).toHaveLength(0);
      expect(w.targetSends(B)).toHaveLength(1);
      expect(e.status().parked[w.tk(A)].reason).toBe("permission");
      for (let i = 0; i < 3; i++) {
        await e.runPass("periodic");
      }
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(w.targetSends(A)).toHaveLength(0);
      expect(e.status().parked[w.tk(A)].reason).toBe("permission");
      await e.stop();
    });

    it("I4b: a 'not allowed' answer parks as permission; a desired change re-arms it", async () => {
      const { w, e } = await started();
      w.backend.push("not-allowed");
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(e.status().parked[w.tk(A)].reason).toBe("permission");
      const n = w.sends().length;
      for (let i = 0; i < 3; i++) {
        await e.runPass("periodic");
      }
      await w.settle();
      expect(w.sends()).toHaveLength(n);
      w.pin(A, "prov/opus-a");
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      await e.stop();
    });

    it("I5: a rate limit in a bulk pass pauses the whole queue; the limited send counts; order kept", async () => {
      const ids = Array.from(
        { length: 30 },
        (_, i) => `FakeBulk${String(i).padStart(2, "0")}xxxxxxxxxxxxxxxxxxxxxxxxxxxxx=`,
      );
      const w = await world({ targets: ids });
      w.backend.push(null, null, "rate-limited");
      const e = await w.startEngine();
      await w.clock.advance(2000 * 2 + 10);
      expect(w.sends()).toHaveLength(3);
      const pausedUntil = e.status().queue.pausedUntil as number;
      expect(pausedUntil).toBeGreaterThanOrEqual(w.clock.now() + 29_000);
      await w.clock.advance(pausedUntil - w.clock.now() - 1);
      expect(w.sends()).toHaveLength(3);
      await w.settle(120_000);
      expect(w.sends().map((s) => s.target)).toEqual(ids);
      expect(Object.keys(e.status().parked)).toHaveLength(0);
      const gaps = w
        .sends()
        .slice(1)
        .map((s, i) => s.at - w.sends()[i]!.at);
      expect(gaps.every((g) => g >= 2000)).toBe(true);
      await e.stop();
    });

    it("I6: changes while stopped → the startup pass repaints exactly the changed target", async () => {
      const { w, e } = await started();
      await e.stop();
      const n = w.sends().length;
      w.pin(A, "prov/k-model");
      w.setModels({ prov: ["fable-model", "k-model"] });
      const e2 = await w.startEngine();
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      expect(w.sends().at(-1)!.target).toBe(A);
      await e2.stop();
    });

    // ---------------- lifecycle (ARCH §3, §6.3) ----------------

    it("turn on: generates every live target × every mark + '?', then paints, paced", async () => {
      const { w, e } = await started();
      // marks: F, O (opus-a/b share), KL, auto for plain-new, ? → 5 per target.
      expect(e.status().cache.required).toBe(10);
      expect(w.assets()).toHaveLength(10);
      expect(w.sends()).toHaveLength(2);
      await e.stop();
    });

    it("C1/§3.2: a model added with an existing mark → 0 renders, 0 applies", async () => {
      const { w, e } = await started();
      const renders = w.renderCalls();
      const n = w.sends().length;
      w.setModels({ prov: MODELS, other: ["opus-b"] });
      await w.settle();
      expect(w.renderCalls()).toBe(renders);
      expect(w.sends()).toHaveLength(n);
      await e.stop();
    });

    it("C2/§3.2: a model added with a new mark → generated for every live target, no repaint", async () => {
      const { w, e } = await started();
      const renders = w.renderCalls();
      const n = w.sends().length;
      w.setModels({ prov: [...MODELS, "zeta-new"] });
      await w.settle();
      expect(w.renderCalls() - renders).toBe(2);
      expect(w.sends()).toHaveLength(n);
      await e.stop();
    });

    it("C3/§3.2: a removed model → pinned target shows '?'; its assets pruned after the grace", async () => {
      const { w, e } = await started({ timing: { pruneGraceMs: 3_600_000 } });
      w.pin(A, "prov/k-model");
      await w.settle();
      const kHash = w.applied()[w.tk(A)]!.hash;
      const n = w.sends().length;
      w.setModels({ prov: ["fable-model", "opus-a", "opus-b", "plain-new"] });
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      expect(w.letterOf(w.sends().at(-1))).toBe("?");
      expect(e.status().notices.unavailableModels["prov/k-model"]).toBeTruthy();
      const kAssetOfB = w.assets().length;
      await e.rebuild("young");
      expect(w.fs.exists(`${w.paths.stateDir}/assets/${kHash}.png`)).toBe(true);
      expect(w.assets()).toHaveLength(kAssetOfB);
      await w.clock.advance(3_600_001);
      await e.rebuild("old");
      expect(w.fs.exists(`${w.paths.stateDir}/assets/${kHash}.png`)).toBe(false);
      expect(w.assets()).toHaveLength(e.status().cache.required as number);
      await e.stop();
    });

    it("C4: models.json rewritten with identical content → 0 renders, 0 applies", async () => {
      const { w, e } = await started();
      const renders = w.renderCalls();
      const n = w.sends().length;
      await w.clock.advance(10);
      w.fs.put(w.paths.modelsJson, w.fs.files.get(w.paths.modelsJson)!.data);
      await w.settle();
      expect(w.renderCalls()).toBe(renders);
      expect(w.sends()).toHaveLength(n);
      await e.stop();
    });

    it("C5/§3.3: target added → its base and marks generated, then painted once", async () => {
      const { w, e } = await started();
      const renders = w.renderCalls();
      w.addTarget(C);
      await w.settle();
      expect(w.targetSends(C)).toHaveLength(1);
      expect(w.letterOf(w.targetSends(C)[0])).toBe("F");
      expect(w.renderCalls() - renders).toBe(5);
      await e.stop();
    });

    it("C5b: a target the provider lists but the store has never seen is picked up by the periodic pass", async () => {
      const { w, e } = await started();
      w.addTarget(C, {}, false);
      await e.runPass("periodic");
      await w.settle();
      expect(w.targetSends(C)).toHaveLength(1);
      await e.stop();
    });

    it("C6/§3.3: target removed → its record and its assets are gone, 0 RPCs", async () => {
      const { w, e } = await started();
      const bHash = w.applied()[w.tk(B)]!.hash;
      w.backend.dropTarget(B);
      const n = w.sends().length;
      await e.runPass("periodic");
      await w.settle();
      expect(w.sends()).toHaveLength(n);
      expect(w.applied()[w.tk(B)]).toBeUndefined();
      expect(e.status().parked[w.tk(B)]).toBeUndefined();
      expect(w.fs.exists(`${w.paths.stateDir}/assets/${bHash}.png`)).toBe(false);
      expect(w.assets()).toHaveLength(5);
      await e.stop();
    });

    it("C7: a badge rule edit → 1 apply per target whose model uses it, nothing else", async () => {
      const { w, e } = await started();
      w.pin(A, "prov/k-model");
      await w.settle();
      const n = w.sends().length;
      const badges = (w.pluginConfig().badges as Array<Record<string, unknown>>).map((b) =>
        b.letter === "KL" ? { ...b, color: "#2E6BD6" } : b,
      );
      w.setPlugin({ badges });
      await w.clock.advance(3000 + 1500 + 100);
      expect(w.sends()).toHaveLength(n + 1);
      expect(w.sends().at(-1)!.target).toBe(A);
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      await e.stop();
    });

    it("C7b: a target override (motif) repaints exactly that target", async () => {
      const { w, e } = await started();
      const n = w.sends().length;
      const current = e.view()!.imageWant({ kind: "group", idLower: A.toLowerCase() }).target
        .params.motif;
      const motif = current === "waves" ? "rings" : "waves";
      w.setPlugin({ targets: { [A.toLowerCase()]: { motif } } });
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      expect(w.sends().at(-1)!.target).toBe(A);
      await e.stop();
    });

    it("C7c: an unrelated gateway config edit → 0 renders, 0 applies", async () => {
      const { w, e } = await started();
      const renders = w.renderCalls();
      const n = w.sends().length;
      w.setGatewayExtra({ unrelated: { key: 1 } });
      await w.settle();
      expect(w.renderCalls()).toBe(renders);
      expect(w.sends()).toHaveLength(n);
      await e.stop();
    });

    it("C7d: the default model changes → only unpinned targets repaint", async () => {
      const { w, e } = await started();
      w.pin(B, "prov/opus-a");
      await w.settle();
      const n = w.sends().length;
      w.setDefault("prov/k-model");
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      expect(w.sends().at(-1)!.target).toBe(A);
      await e.stop();
    });

    it("C7e: an unparseable gateway config keeps the last good inputs, sends nothing, recovers", async () => {
      const { w, e } = await started();
      const n = w.sends().length;
      const good = w.fs.files.get(w.paths.gatewayConfig)!.data;
      w.fs.put(w.paths.gatewayConfig, "{ not json");
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(String(e.status().health.gatewayConfig)).toMatch(/unreadable/);
      // The swap itself is still honoured from the store with the last good config.
      expect(w.sends()).toHaveLength(n + 1);
      w.fs.put(w.paths.gatewayConfig, good);
      await w.settle();
      expect(e.status().health.gatewayConfig).toBeUndefined();
      await e.stop();
    });

    it("C7f: an invalid plugin config blocks sends (fail-safe) until fixed", async () => {
      const { w, e } = await started();
      const n = w.sends().length;
      w.setPlugin({ badges: [{ pattern: "x", letter: "TOO-LONG", color: "red" }] });
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(String(e.status().health.pluginConfig)).toMatch(/unreadable/);
      expect(w.sends()).toHaveLength(n);
      w.setPlugin({
        badges: w.pluginConfig().badges ? (await import("./test-helpers/world.js")).BADGES : [],
      });
      await w.settle();
      expect(e.status().health.pluginConfig).toBeUndefined();
      expect(w.sends()).toHaveLength(n + 1);
      await e.stop();
    });

    it("C8: a failed render keeps the old avatar for that target only; retried at the next rebuild", async () => {
      let fail = true;
      const w = await world();
      const e = await w.startEngine({
        failRender: (svg) => fail && svg.includes('data-mark="KL"'),
      });
      await w.settle();
      const n = w.sends().length;
      w.pin(A, "prov/k-model");
      w.pin(B, "prov/opus-a");
      await w.settle();
      expect(w.targetSends(A)).toHaveLength(1);
      expect(w.sends()).toHaveLength(n + 1);
      expect(e.status().waiting[w.tk(A)].reason).toBe("waiting-for-asset");
      fail = false;
      await e.rebuild("retry");
      await e.runPass("periodic");
      await w.settle();
      expect(w.targetSends(A)).toHaveLength(2);
      await e.stop();
    });

    it("§3.4 turn off: after stop nothing is written or sent, and nothing is repainted back", async () => {
      const { w, e } = await started();
      await e.stop();
      const n = w.sends().length;
      const files = w.fs.files.size;
      w.pin(A, "prov/k-model");
      w.setModels({ prov: [...MODELS, "zeta-new"] });
      await w.settle(3_600_000);
      expect(w.sends()).toHaveLength(n);
      expect(w.fs.files.size).toBe(files + 0);
      expect(e.status().role).toBe("stopped");
    });

    it("§3.4 purge removes the cache and state and stops the writer", async () => {
      const { w, e } = await started();
      expect(w.assets().length).toBeGreaterThan(0);
      await e.purge();
      expect(w.fs.list(w.paths.stateDir)).toEqual([]);
      const n = w.sends().length;
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(w.sends()).toHaveLength(n);
    });

    // ---------------- queue and limits ----------------

    it("Q1: captcha — pause ≥ hint and ≥ 1 h, token never stored, one probe, doubling, operator release", async () => {
      const { w, e } = await started();
      w.backend.push({ captcha: 7200 });
      w.pin(A, "prov/k-model");
      w.pin(B, "prov/k-model");
      await w.clock.advance(5000);
      const st = e.status();
      expect(st.queue.pauseReason).toBe("captcha");
      expect((st.queue.pausedUntil as number) - w.clock.now()).toBeGreaterThanOrEqual(
        7_200_000 - 5000,
      );
      const raw = w.fs.files.get(`${w.paths.stateDir}/status.json`)!.data.toString();
      expect(raw).not.toContain("00000000-0000-0000-0000-000000000000");
      expect(w.log.text()).not.toContain("00000000-0000-0000-0000-000000000000");
      const n = w.sends().length;
      await w.clock.advance(7_100_000);
      expect(w.sends()).toHaveLength(n);
      w.backend.push({ captcha: 60 });
      await w.clock.advance(200_000);
      expect(w.sends()).toHaveLength(n + 1);
      expect(e.status().triggers.captchaProbe.count).toBe(1);
      const second = (e.status().queue.pausedUntil as number) - w.clock.now();
      expect(second).toBeGreaterThanOrEqual(4 * 3_600_000 - 200_000);
      expect(second).toBeLessThanOrEqual(4 * 3_600_000);
      await e.reconcileNow();
      await w.settle();
      expect(e.status().queue.pauseReason).toBeNull();
      await e.stop();
    });

    it("Q1c: captcha doubling is capped at 24 h; a >24 h hint lengthens only that pause", async () => {
      const { w, e } = await started();
      const pauses: number[] = [];
      for (let i = 0; i < 7; i++) {
        w.backend.push({ captcha: i === 3 ? 48 * 3600 : 10 });
        w.pin(A, i % 2 ? "prov/opus-a" : "prov/k-model");
        if (i === 0) {
          await w.clock.advance(5000);
        } else {
          await w.clock.advance((e.status().queue.pausedUntil as number) - w.clock.now() + 1);
        }
        pauses.push(
          Math.round(((e.status().queue.pausedUntil as number) - w.clock.now()) / 3_600_000),
        );
      }
      expect(pauses).toEqual([1, 2, 4, 48, 24, 24, 24]);
      await e.stop();
    });

    it("Q2: a 2 h provider-side outage parks nothing; every target repaints once after recovery", async () => {
      const ids = Array.from(
        { length: 10 },
        (_, i) => `FakeOut${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=`,
      );
      const w = await world({ targets: ids });
      let outage = true;
      w.backend.always(() => (outage ? "io" : "ok"));
      const e = await w.startEngine();
      await w.clock.advance(2 * 3_600_000);
      expect(Object.keys(e.status().parked)).toHaveLength(0);
      expect(e.status().health.providerIo).toBeTruthy();
      outage = false;
      await w.settle(3_600_000);
      expect(ids.filter((id) => w.applied()[w.tk(id)])).toHaveLength(10);
      await e.stop();
    });

    it("Q3: one target failing while others succeed is parked as error after the threshold", async () => {
      const { w, e } = await started({
        limits: { ioErrorParkThreshold: 3 },
        timing: { rateLimitBaseMs: 1000 },
      });
      w.backend.always((s) => (s.target === A ? "io" : "ok"));
      w.pin(A, "prov/k-model");
      for (let i = 0; i < 6; i++) {
        w.pin(B, i % 2 ? "prov/opus-a" : "prov/k-model");
        await w.clock.advance(20_000);
      }
      await w.settle();
      expect(e.status().parked[w.tk(A)]?.reason).toBe("error");
      expect(e.status().parked[w.tk(B)]).toBeUndefined();
      await e.stop();
    });

    it("Q4: defensive fallbacks (uncommitted limit, Retry-After) re-queue at the head, not applied", async () => {
      const { w, e } = await started();
      w.backend.push("fallback-5");
      w.pin(A, "prov/k-model");
      await w.clock.advance(5000);
      expect(e.status().queue.pauseReason).toBe("rate-limit");
      expect(e.status().queue.length).toBe(1);
      expect(w.applied()[w.tk(A)]!.model).not.toBe("prov/k-model");
      await w.settle(120_000);
      w.backend.push({ http429: 120_000 });
      w.pin(B, "prov/k-model");
      await w.clock.advance(5000);
      expect((e.status().queue.pausedUntil as number) - w.clock.now()).toBeGreaterThanOrEqual(
        115_000,
      );
      expect(w.applied()[w.tk(B)]!.model).not.toBe("prov/k-model");
      await w.settle(300_000);
      expect(w.applied()[w.tk(B)]!.model).toBe("prov/k-model");
      await e.stop();
    });

    it("Q5: rate-limit backoff grows on consecutive limits and resets after a clean send", async () => {
      const { w, e } = await started();
      const pauses: number[] = [];
      for (let i = 0; i < 3; i++) {
        w.backend.push("rate-limited");
        w.pin(A, i % 2 ? "prov/opus-a" : "prov/k-model");
        await w.clock.advance(5000);
        pauses.push((e.status().queue.pausedUntil as number) - w.clock.now());
        await w.settle(1_000_000);
      }
      expect(pauses[1]!).toBeGreaterThan(pauses[0]! * 1.5);
      expect(pauses[2]!).toBeGreaterThan(pauses[1]! * 1.5);
      w.pin(A, "prov/fable-model");
      await w.settle();
      expect(e.status().queue.consecutive).toBe(0);
      await e.stop();
    });

    it("Q6: an unrecognised error is retried with backoff and parked after maxAttempts", async () => {
      const { w, e } = await started({ limits: { maxAttempts: 3 } });
      w.backend.push("odd", "odd", "odd", "odd", "odd");
      w.pin(A, "prov/k-model");
      await w.settle(3_600_000);
      expect(w.targetSends(A)).toHaveLength(1 + 3);
      expect(e.status().parked[w.tk(A)].reason).toBe("error");
      await e.stop();
    });

    it("Q7: not-found removes the target at once; listed again → painted", async () => {
      const { w, e } = await started();
      w.backend.push("not-found");
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(w.applied()[w.tk(A)]).toBeUndefined();
      expect(e.status().parked[w.tk(A)]).toBeUndefined();
      expect(e.knownTargets()).not.toContain(w.tk(A));
      const n = w.targetSends(A).length;
      await e.runPass("periodic");
      await w.settle();
      expect(w.targetSends(A)).toHaveLength(n + 1);
      expect(w.applied()[w.tk(A)]!.model).toBe("prov/k-model");
      await e.stop();
    });

    it("Q8: daemon unreachable pauses the queue globally and never parks", async () => {
      const { w, e } = await started();
      w.backend.setDown(true);
      w.pin(A, "prov/k-model");
      w.pin(B, "prov/k-model");
      await w.clock.advance(600_000);
      expect(Object.keys(e.status().parked)).toHaveLength(0);
      expect(String(e.status().health.daemon)).toMatch(/^unreachable/);
      w.backend.setDown(false);
      await w.settle(3_600_000);
      expect(w.applied()[w.tk(A)]!.model).toBe("prov/k-model");
      expect(w.applied()[w.tk(B)]!.model).toBe("prov/k-model");
      expect(e.status().health.daemon).toBeUndefined();
      await e.stop();
    });

    it("Q9: an asset the daemon cannot read is a config error, not per-target; clears on success", async () => {
      const { w, e } = await started();
      w.backend.push("avatar-unreadable");
      w.pin(A, "prov/k-model");
      await w.clock.advance(5000);
      expect(String(e.status().health.config)).toMatch(/must be readable by the daemon/);
      expect(e.status().queue.pauseReason).toBe("config");
      expect(Object.keys(e.status().parked)).toHaveLength(0);
      await w.settle(700_000);
      expect(w.applied()[w.tk(A)]!.model).toBe("prov/k-model");
      expect(e.status().health.config).toBeUndefined();
      await e.stop();
    });

    it("Q10: the profile target uses the same queue and pacing; target events never touch it", async () => {
      const { w, e } = await started({ profile: true });
      const prof = () => w.sends().filter((s) => s.kind === "profile");
      expect(prof()).toHaveLength(1);
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(prof()).toHaveLength(1);
      w.pin("profile", "prov/opus-a", w.backend.profileSessionKey);
      await w.settle();
      expect(prof()).toHaveLength(2);
      const all = w.sends();
      expect(all.slice(1).every((s, i) => s.at - all[i]!.at >= 2000)).toBe(true);
      await e.stop();
    });

    it("Q11: profile I/O failures pause and never park", async () => {
      const { w, e } = await started({ profile: true, limits: { ioErrorParkThreshold: 2 } });
      w.backend.always((s) => (s.kind === "profile" ? "profile-io" : "ok"));
      w.pin("profile", "prov/opus-a", w.backend.profileSessionKey);
      for (let i = 0; i < 6; i++) {
        w.pin(A, i % 2 ? "prov/k-model" : "prov/fable-model");
        await w.clock.advance(300_000);
      }
      expect(e.status().parked["profile:profile"]).toBeUndefined();
      w.backend.always(() => "ok");
      await w.settle(3_600_000);
      expect(w.applied()["profile:profile"]!.model).toBe("prov/opus-a");
      await e.stop();
    });

    // ---------------- writer ----------------

    it("W3: a second process is standby and sends nothing; takes over after the lease goes stale", async () => {
      const { w, e } = await started();
      const e2 = await w.startEngine({ instanceId: "second" });
      expect(e2.status().role).toBe("standby");
      expect(e2.status().health.duplicateGateway).toBeTruthy();
      const n = w.sends().length;
      await e.stop({ releaseLease: false });
      w.pin(A, "prov/k-model");
      await w.clock.advance(60_000);
      expect(w.sends()).toHaveLength(n);
      await w.clock.advance(200_000);
      expect(e2.status().role).toBe("writer");
      await w.settle();
      expect(w.sends()).toHaveLength(n + 1);
      await e2.stop();
    });

    it("W3b: a takeover reloads state from disk and repaints nothing already correct", async () => {
      const w = await world({ targets: [A, B, C] });
      const a = await w.startEngine({ instanceId: "A" });
      const b = await w.startEngine({ instanceId: "B" });
      expect(b.status().role).toBe("standby");
      await w.settle();
      expect(Object.keys(w.applied())).toHaveLength(3);
      w.backend.push("not-allowed");
      w.pin(C, "prov/k-model");
      await w.settle();
      expect(w.status().parked[w.tk(C)].reason).toBe("permission");
      const n = w.sends().length;
      await a.stop({ releaseLease: false });
      await w.clock.advance(200_000);
      expect(b.status().role).toBe("writer");
      await w.settle();
      expect(w.sends()).toHaveLength(n);
      expect(b.status().parked[w.tk(C)].reason).toBe("permission");
      await b.stop();
    });

    it("W4: crash after the send, before the applied write → exactly one duplicate paint", async () => {
      const { w, e } = await started();
      const n = w.sends().length;
      let crash = true;
      w.fs.faults.failWriteAtomic = (p) => crash && p.endsWith("applied.json");
      w.pin(A, "prov/k-model");
      await w.settle();
      await e.stop();
      expect(w.sends()).toHaveLength(n + 1);
      crash = false;
      const e2 = await w.startEngine({ instanceId: "restart" });
      await w.settle();
      expect(w.sends()).toHaveLength(n + 2);
      await w.settle();
      expect(w.sends()).toHaveLength(n + 2);
      await e2.stop();
    });

    it("W6: the in-flight asset survives a crash and the startup prune; 0 re-renders", async () => {
      const { w, e } = await started({ timing: { pruneGraceMs: 0 } });
      let crash = true;
      w.fs.faults.failWriteAtomic = (p) => crash && p.endsWith("applied.json");
      w.pin(A, "prov/k-model");
      await w.settle();
      await e.stop();
      const inflight = w.status().inflight[w.tk(A)];
      expect(inflight).toBeTruthy();
      crash = false;
      w.setModels({ prov: ["fable-model", "opus-a"] }); // k-model leaves the required set
      w.pin(A, "prov/fable-model");
      const before = w.renderCalls();
      const e2 = await w.startEngine({ instanceId: "restart" });
      expect(w.fs.exists(`${w.paths.stateDir}/assets/${inflight.hash}.png`)).toBe(true);
      await w.settle();
      const reRendered = w.renderers
        .at(-1)!
        .calls.filter((c) => c.svg.includes('data-mark="KL"')).length;
      expect(reRendered).toBe(0);
      expect(w.renderCalls()).toBeGreaterThanOrEqual(before);
      expect(w.status().inflight[w.tk(A)]).toBeUndefined();
      await e2.stop();
    });

    it("W7: the lease is exclusive — two acquirers race, exactly one wins", async () => {
      const w = await world();
      const mk = (id: string) =>
        createLease({
          fs: w.fs,
          stateDir: w.paths.stateDir,
          clock: w.clock,
          ttlMs: 120_000,
          instanceId: id,
          host: "h",
          isAlive: () => true,
        });
      const [x, y] = await Promise.all([mk("a").acquire(), mk("b").acquire()]);
      expect([x.held, y.held].filter(Boolean)).toHaveLength(1);
    });

    it("W8: a lease taken mid-run makes the old writer stop sending immediately", async () => {
      const { w, e } = await started();
      const before = w.sends().length;
      w.fs.putJson(`${w.paths.stateDir}/writer.lease`, {
        instanceId: "usurper",
        pid: 1,
        host: "other-host",
        heartbeatAt: w.clock.now(),
      });
      w.pin(A, "prov/k-model");
      await w.clock.advance(10_000);
      expect(w.sends()).toHaveLength(before);
      expect(e.status().role).toBe("standby");
      await e.stop();
    });

    it("W9: applied.json is rewritten only when it changes", async () => {
      const { w, e } = await started();
      const p = `${w.paths.stateDir}/applied.json`;
      const before = w.fs.files.get(p)!.mtimeMs;
      await w.clock.advance(10);
      for (let i = 0; i < 3; i++) {
        await e.runPass("periodic");
      }
      await w.settle();
      expect(w.fs.files.get(p)!.mtimeMs).toBe(before);
      w.pin(A, "prov/k-model");
      await w.settle();
      expect(w.fs.files.get(p)!.mtimeMs).toBeGreaterThan(before);
      await e.stop();
    });

    it("W10: a renderer-less host reports renderer-missing and stays idle without crashing", async () => {
      const w = await world();
      const e = await w.startEngine({ renderer: null });
      await w.settle();
      expect(e.status().role).toBe("idle");
      expect(String(e.status().health.renderer)).toMatch(/renderer-missing/);
      expect(w.sends()).toHaveLength(0);
      await e.stop();
    });

    it("invariants: the engine writes only under its state dir and sends only cached PNG paths", async () => {
      const w = await world({ targets: [A, B, C] });
      const writes: string[] = [];
      for (const op of ["unlink", "writeFile", "writeAtomic", "rename", "rmrf"] as const) {
        const orig = w.fs[op].bind(w.fs) as (...a: unknown[]) => Promise<void>;
        (w.fs as unknown as Record<string, unknown>)[op] = async (...a: unknown[]) => {
          writes.push(String(a[op === "rename" ? 1 : 0]));
          return orig(...a);
        };
      }
      const e = await w.startEngine();
      await w.settle();
      w.pin(A, "prov/k-model");
      w.setModels({ prov: [...MODELS, "zeta-new"] });
      await w.settle();
      w.backend.dropTarget(C);
      await e.runPass("periodic");
      await w.settle();
      expect(writes.filter((p) => !p.startsWith(`${w.paths.rootDir}/`))).toEqual([]);
      for (const s of w.sends()) {
        expect(s.avatar.startsWith(`${w.paths.stateDir}/assets/`)).toBe(true);
        expect(s.avatar.endsWith(".png")).toBe(true);
        // Assets of the removed target are pruned with it (§3.3); every other sent asset stays.
        expect(w.fs.exists(s.avatar)).toBe(s.target !== C);
        expect(s.target).not.toBe(s.target.toLowerCase());
      }
      await e.stop();
    });
  });
}
