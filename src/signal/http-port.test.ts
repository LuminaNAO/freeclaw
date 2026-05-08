import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { writeConfigFile } = vi.hoisted(() => ({
  writeConfigFile: vi.fn(async (_cfg: OpenClawConfig) => {}),
}));

vi.mock("../config/config.js", () => ({
  writeConfigFile,
}));

import {
  SIGNAL_HTTP_PORT_MAX,
  SIGNAL_HTTP_PORT_MIN,
  persistSignalHttpPort,
  pickSignalHttpPort,
} from "./http-port.js";

describe("signal http port selection", () => {
  afterEach(() => {
    writeConfigFile.mockClear();
  });

  it("picks a free port other than 8080", async () => {
    const port = await pickSignalHttpPort();
    expect(port).not.toBe(8080);
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(SIGNAL_HTTP_PORT_MIN);
    expect(port).toBeLessThanOrEqual(SIGNAL_HTTP_PORT_MAX);
  });

  it("persists a top-level port when no account-specific config exists", async () => {
    await persistSignalHttpPort({
      cfg: {
        channels: {
          signal: {
            enabled: true,
          },
        },
      } as never,
      accountId: "main",
      port: 45_678,
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const persisted = writeConfigFile.mock.calls[0]?.[0] as {
      channels?: { signal?: { httpPort?: number } };
    };
    expect(persisted.channels?.signal?.httpPort).toBe(45_678);
  });

  it("persists the port into the matching account entry when present", async () => {
    await persistSignalHttpPort({
      cfg: {
        channels: {
          signal: {
            enabled: true,
            httpPort: 12_345,
            accounts: {
              main: {
                enabled: true,
              },
            },
          },
        },
      } as never,
      accountId: "main",
      port: 45_679,
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const persisted = writeConfigFile.mock.calls[0]?.[0] as {
      channels?: {
        signal?: {
          httpPort?: number;
          accounts?: Record<string, { httpPort?: number }>;
        };
      };
    };
    expect(persisted.channels?.signal?.httpPort).toBe(12_345);
    expect(persisted.channels?.signal?.accounts?.main?.httpPort).toBe(45_679);
  });
});
