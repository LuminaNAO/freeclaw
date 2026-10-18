import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const browserTabMocks = vi.hoisted(() => ({
  closeTrackedBrowserTabsForRun: vi.fn(async (_params: { runId?: string }) => 0),
}));
vi.mock("../../browser/session-tab-registry.js", () => browserTabMocks);

import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";

describe("runEmbeddedPiAgent browser tab cleanup at turn end (ARCH §2.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRunEmbeddedAttempt.mockReset();
  });

  it("closes the turn's browser tabs when the turn ends", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    await runEmbeddedPiAgent({ ...overflowBaseRunParams, runId: "run-tabs-1" });
    expect(browserTabMocks.closeTrackedBrowserTabsForRun).toHaveBeenCalledTimes(1);
    expect(browserTabMocks.closeTrackedBrowserTabsForRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-tabs-1" }),
    );
  });

  it("closes the turn's browser tabs even when the turn throws", async () => {
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(new Error("boom"));
    await expect(
      runEmbeddedPiAgent({ ...overflowBaseRunParams, runId: "run-tabs-2" }),
    ).rejects.toThrow("boom");
    expect(browserTabMocks.closeTrackedBrowserTabsForRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-tabs-2" }),
    );
  });
});
