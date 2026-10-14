import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "./control-ui-contract.js";
import {
  AUTH_NONE,
  createTestGatewayServer,
  sendRequest,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const UI_MARKER = "<html><body>control-ui-marker</body></html>\n";

async function withControlUiRoot<T>(fn: (rootPath: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-default-off-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), UI_MARKER);
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Resolve the runtime config from a gateway config the same way the gateway does at
 * startup, then build the HTTP server with the resolved `controlUiEnabled`.
 * Requests are dispatched in-process: no socket is bound.
 */
async function requestUiWithConfig(cfg: OpenClawConfig, requestPath: string) {
  const runtime = await resolveGatewayRuntimeConfig({
    cfg: { ...cfg, gateway: { ...cfg.gateway, bind: "loopback", auth: { mode: "none" } } },
    port: 18789,
  });
  return await withControlUiRoot(async (rootPath) => {
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: runtime.controlUiEnabled,
        controlUiBasePath: runtime.controlUiBasePath,
        controlUiRoot: { kind: "resolved", path: rootPath },
      },
    });
    const response = await sendRequest(server, { path: requestPath });
    return { runtime, response };
  });
}

describe("gateway HTTP: Control UI default off", () => {
  it("unset config: runtime has controlUiEnabled=false and GET / returns 404", async () => {
    await withGatewayTempConfig("ui-default-off-unset", async () => {
      const { runtime, response } = await requestUiWithConfig({}, "/");
      expect(runtime.controlUiEnabled).toBe(false);
      expect(response.res.statusCode).toBe(404);
      expect(response.getBody()).toBe("Not Found");
      expect(response.getBody()).not.toContain("control-ui-marker");
    });
  });

  it("unset config: Control UI bootstrap route is not served", async () => {
    await withGatewayTempConfig("ui-default-off-bootstrap", async () => {
      const { response } = await requestUiWithConfig({}, CONTROL_UI_BOOTSTRAP_CONFIG_PATH);
      expect(response.res.statusCode).toBe(404);
    });
  });

  it("explicitly disabled: GET / returns 404", async () => {
    await withGatewayTempConfig("ui-default-off-disabled", async () => {
      const { runtime, response } = await requestUiWithConfig(
        { gateway: { controlUi: { enabled: false } } },
        "/",
      );
      expect(runtime.controlUiEnabled).toBe(false);
      expect(response.res.statusCode).toBe(404);
    });
  });

  it("enabled: true serves the UI root as before", async () => {
    await withGatewayTempConfig("ui-default-off-enabled", async () => {
      const { runtime, response } = await requestUiWithConfig(
        { gateway: { controlUi: { enabled: true } } },
        "/",
      );
      expect(runtime.controlUiEnabled).toBe(true);
      expect(response.res.statusCode).toBe(200);
      expect(response.getBody()).toContain("control-ui-marker");
    });
  });
});
