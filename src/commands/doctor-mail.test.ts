// docs/design/mail-push.md §7: `openclaw doctor` flags mail connectors in auth-failed, or in
// backoff for more than 15 minutes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { MailConnectorStateFile } from "../mail/state-store.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../terminal/note.js", () => ({ note }));

const { collectMailDoctorFindings, formatMailDoctorFindings, noteMailConnectorHealth } =
  await import("./doctor-mail.js");
const { writeMailConnectorState, resolveMailStatePath } = await import("../mail/state-store.js");

const NOW = 1_800_000_000_000;

function cfg(ids: string[], disabled: string[] = []): OpenClawConfig {
  return {
    mail: {
      connectors: ids.map((id) => ({
        id,
        provider: "fake",
        enabled: !disabled.includes(id),
        attach: [{ agentId: "main", sessionKey: `agent:main:mail:${id}` }],
      })),
    },
  } as OpenClawConfig;
}

function state(id: string, partial: Partial<MailConnectorStateFile>): MailConnectorStateFile {
  return { version: 1, connectorId: id, cursor: null, updatedAt: NOW, ...partial };
}

describe("doctor mail connector check", () => {
  it("flags auth-failed at once and backoff only after 15 minutes", async () => {
    const states: Record<string, MailConnectorStateFile> = {
      locked: state("locked", {
        state: "auth-failed",
        stateSince: NOW - 60_000,
        lastError: { at: NOW, message: "authentication failed 3 times" },
      }),
      flaky: state("flaky", { state: "backoff", stateSince: NOW - 5 * 60_000 }),
      down: state("down", {
        state: "backoff",
        stateSince: NOW - 30_000,
        troubleSince: NOW - 40 * 60_000,
        lastError: { at: NOW, message: "INBOX: connection refused" },
      }),
      fine: state("fine", { state: "idle", stateSince: NOW - 99 * 60_000 }),
      parked: state("parked", { state: "auth-failed", stateSince: NOW - 99 * 60_000 }),
    };
    const findings = await collectMailDoctorFindings({
      cfg: cfg(["locked", "flaky", "down", "fine", "parked", "never-ran"], ["parked"]),
      now: NOW,
      readState: async (id) => states[id] ?? null,
    });
    expect(findings.map((f) => [f.id, f.state])).toEqual([
      ["locked", "auth-failed"],
      ["down", "backoff"],
    ]);
    const lines = formatMailDoctorFindings(findings);
    expect(lines[0]).toContain('mail connector "locked" is auth-failed');
    expect(lines[0]).toContain("openclaw mail connectors restart locked");
    expect(lines[1]).toContain('mail connector "down" has been retrying for 40 min');
    expect(lines[1]).toContain("INBOX: connection refused");
  });

  describe("with state files on disk", () => {
    let dir: string;
    let previous: string | undefined;
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-mail-"));
      previous = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = dir;
      note.mockReset();
    });
    afterEach(async () => {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("notes problems found in <stateDir>/mail/<id>.json", async () => {
      await writeMailConnectorState(
        resolveMailStatePath("work"),
        state("work", { state: "auth-failed", stateSince: Date.now() - 1000 }),
      );
      await noteMailConnectorHealth(cfg(["work"]));
      expect(note).toHaveBeenCalledTimes(1);
      expect(note.mock.calls[0]?.[1]).toBe("Mail connectors");
      expect(String(note.mock.calls[0]?.[0])).toContain('"work" is auth-failed');
    });

    it("stays quiet when all connectors are fine or none are configured", async () => {
      await writeMailConnectorState(
        resolveMailStatePath("work"),
        state("work", { state: "idle", stateSince: Date.now() - 1000 }),
      );
      await noteMailConnectorHealth(cfg(["work"]));
      await noteMailConnectorHealth({});
      expect(note).not.toHaveBeenCalled();
    });
  });
});
