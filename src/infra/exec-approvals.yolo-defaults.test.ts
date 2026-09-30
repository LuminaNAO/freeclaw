import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXEC_ASK,
  DEFAULT_EXEC_SECURITY,
  FRESH_INSTALL_EXEC_ASK,
  FRESH_INSTALL_EXEC_SECURITY,
  requiresExecApproval,
  resolveExecApprovalsFromFile,
} from "./exec-approvals.js";

const emptyFile = { version: 1 as const };

/**
 * CONTESTED SPEC POINT — flagged for the orchestrator, not resolved here.
 *
 * The task says: "Fresh installs default exec to security=full, ask=off (YOLO). Existing configs
 * that explicitly set other values keep them."
 *
 * Two readings:
 *   (A) fresh-install seeding (SHIPPED): onboarding writes full/off for a genuinely new install;
 *       a config that never set the keys keeps the legacy fallback (allowlist/on-miss).
 *   (B) runtime default: unset => full/off for everyone, at runtime.
 *
 * Build implemented (A) per the pre-audit point that globally changing runtime fallbacks would
 * silently loosen exec policy for every existing install. (A) is the safer reading and is what
 * these tests pin. If the orchestrator picks (B), the "legacy fallback" tests below MUST be
 * flipped deliberately — they are written to fail loudly, not to be quietly reinterpreted.
 */

describe("runcap: fresh install gets YOLO exec (security=full, ask=off)", () => {
  it("seeds full/off for a fresh install", () => {
    expect(FRESH_INSTALL_EXEC_SECURITY).toBe("full");
    expect(FRESH_INSTALL_EXEC_ASK).toBe("off");
  });

  it("does not require approval under the fresh-install defaults", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: emptyFile,
      overrides: {
        security: FRESH_INSTALL_EXEC_SECURITY,
        ask: FRESH_INSTALL_EXEC_ASK,
      },
    });
    expect(resolved.defaults.security).toBe("full");
    expect(resolved.defaults.ask).toBe("off");

    // The reported failure mode: a command missed the allowlist and the agent was stuck asking
    // for approval on a channel that cannot approve.
    expect(
      requiresExecApproval({
        ask: resolved.agent.ask,
        security: resolved.agent.security,
        analysisOk: false,
        allowlistSatisfied: false,
      }),
    ).toBe(false);
  });
});

describe("runcap: existing explicit exec config is preserved", () => {
  it("keeps an explicit allowlist default in the approvals file", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: { version: 1, defaults: { security: "allowlist", ask: "on-miss" } },
    });
    expect(resolved.defaults.security).toBe("allowlist");
    expect(resolved.defaults.ask).toBe("on-miss");
  });

  it("keeps an explicit deny default in the approvals file", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: { version: 1, defaults: { security: "deny" } },
    });
    expect(resolved.defaults.security).toBe("deny");
  });

  it("keeps explicit full/off when the user chose YOLO themselves", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: { version: 1, defaults: { security: "full", ask: "off" } },
    });
    expect(resolved.defaults.security).toBe("full");
    expect(resolved.defaults.ask).toBe("off");
  });

  it("keeps a stricter per-agent override over any default", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: { version: 1, agents: { main: { security: "allowlist", ask: "always" } } },
      agentId: "main",
    });
    expect(resolved.agent.security).toBe("allowlist");
    expect(resolved.agent.ask).toBe("always");
  });

  it("keeps an explicit caller override over the fallback", () => {
    const resolved = resolveExecApprovalsFromFile({
      file: emptyFile,
      overrides: { security: "allowlist", ask: "on-miss" },
    });
    expect(resolved.defaults.security).toBe("allowlist");
    expect(resolved.defaults.ask).toBe("on-miss");
  });

  it("still requires approval in preserved allowlist mode on an allowlist miss", () => {
    // YOLO-by-default must not weaken a config that opted into allowlisting.
    expect(
      requiresExecApproval({
        ask: "on-miss",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: false,
      }),
    ).toBe(true);
  });

  it("keeps allowlist mode available (ask=always still asks)", () => {
    expect(
      requiresExecApproval({
        ask: "always",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: true,
      }),
    ).toBe(true);
  });
});

describe("runcap: legacy fallback for configs that never set exec policy", () => {
  it("keeps the pre-existing allowlist/on-miss fallback (reading A)", () => {
    // Under reading (B) these would be full/off. Flipping them is the orchestrator's call.
    expect(DEFAULT_EXEC_SECURITY).toBe("allowlist");
    expect(DEFAULT_EXEC_ASK).toBe("on-miss");

    const resolved = resolveExecApprovalsFromFile({ file: emptyFile });
    expect(resolved.defaults.security).toBe("deny");
    expect(resolved.defaults.ask).toBe("on-miss");
  });
});
