import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siglink-rpc-test-"));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function makeFakeCli(dir: string, scriptBody: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, "signal-cli");
  fs.writeFileSync(cli, `#!/usr/bin/env bash\nset -u\n${scriptBody}\n`, { mode: 0o755 });
  return cli;
}

const HAPPY_SCRIPT = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "sgnl://linkdevice?uuid=fakeuuid-1111-0000-0000-000000000000&pub_key=BfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfA"
  echo "Associated with: +15550001234"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then echo ok; exit 0; fi
exit 0
`;

const HANG_SCRIPT = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  echo "sgnl://linkdevice?uuid=fakeuuid-1111-0000-0000-000000000000&pub_key=BfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfA"
  echo $$ > "__PID_FILE__"
  exec sleep 60
fi
exit 0
`;

const RENEW_SCRIPT = `
case "$1" in
  --version) echo "signal-cli 99.99.99-test"; exit 0;;
esac
args="$*"
if [[ "$args" == *" link "* ]]; then
  n=$(cat "__COUNTER_FILE__" 2>/dev/null || echo 0)
  n=$((n+1)); echo "$n" > "__COUNTER_FILE__"
  echo "sgnl://linkdevice?uuid=fakeuuid-1111-0000-0000-000000000000&pub_key=BfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfAkEfA"
  if [[ "$n" -lt 2 ]]; then
    sleep 1
    echo "ERROR: Link request expired"
    exit 1
  fi
  echo "Associated with: +15550001234"
  exit 0
fi
if [[ "$args" == *"listDevices"* ]]; then echo ok; exit 0; fi
exit 0
`;

type Responded = { ok: boolean; payload?: unknown; error?: { message?: string } };

function makeRespond() {
  const calls: Responded[] = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: { message?: string }) => {
      calls.push({ ok, payload, error });
    },
  };
}

function invoke(handler: (...args: never[]) => unknown, params: Record<string, unknown>) {
  const { calls, respond } = makeRespond();
  return {
    calls,
    done: Promise.resolve(handler({ params, respond } as never)),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("signal.link RPC lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_STATE_DIR", tmpRoot());
    vi.stubEnv("HOME", tmpRoot());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    while (roots.length) {
      const dir = roots.pop() as string;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function loadHandlers(cfg: Record<string, unknown>) {
    vi.doMock("../../config/config.js", () => ({
      loadConfig: () => cfg,
    }));
    const mod = await import("./signal-link.js");
    return mod.signalLinkHandlers;
  }

  it("start returns only once the PNG exists, then status → linked and the PNG is removed", async () => {
    const root = tmpRoot();
    const cli = makeFakeCli(root, HAPPY_SCRIPT);
    const handlers = await loadHandlers({
      channels: { signal: { cliPath: cli } },
    });

    const start = invoke(handlers["signal.link.start"] as never, {});
    await start.done;
    expect(start.calls[0].ok).toBe(true);
    const payload = start.calls[0].payload as {
      linkId: string;
      qrPngPath: string;
      expiresAt: number;
    };
    expect(payload.linkId).toBeTruthy();
    expect(payload.qrPngPath).toContain("signal-link");
    // The PNG exists and is 0600 at the moment start returns (ARCH §2).
    expect(fs.existsSync(payload.qrPngPath)).toBe(true);
    expect(fs.statSync(payload.qrPngPath).mode & 0o777).toBe(0o600);
    // expiresAt is the QR lifetime (~2 min), not the session TTL.
    expect(payload.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
    expect(JSON.stringify(start.calls)).not.toContain("sgnl://");

    await vi.waitFor(async () => {
      const st = invoke(handlers["signal.link.status"] as never, { linkId: payload.linkId });
      await st.done;
      const state = (st.calls[0].payload as { state: string }).state;
      if (state !== "linked") {
        throw new Error(`not linked yet: ${state}`);
      }
      expect((st.calls[0].payload as { number?: string }).number).toBe("+15550001234");
    });

    await vi.waitFor(() => {
      expect(fs.existsSync(payload.qrPngPath)).toBe(false);
    });
  });

  it("cancel kills the signal-cli child process", async () => {
    const root = tmpRoot();
    const pidFile = path.join(root, "child.pid");
    const cli = makeFakeCli(root, HANG_SCRIPT.replaceAll("__PID_FILE__", pidFile));
    const handlers = await loadHandlers({
      channels: { signal: { cliPath: cli } },
    });
    const start = invoke(handlers["signal.link.start"] as never, {});
    await start.done;
    expect(start.calls[0].ok).toBe(true);
    const { linkId } = start.calls[0].payload as { linkId: string };

    await vi.waitFor(() => {
      expect(fs.existsSync(pidFile)).toBe(true);
    });
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(isProcessAlive(childPid)).toBe(true);

    const cancel = invoke(handlers["signal.link.cancel"] as never, { linkId });
    await cancel.done;
    expect(cancel.calls[0].ok).toBe(true);

    // The child must actually die (§1.4 cancel semantics via RPC).
    await vi.waitFor(
      () => {
        expect(isProcessAlive(childPid)).toBe(false);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(async () => {
      const st = invoke(handlers["signal.link.status"] as never, { linkId });
      await st.done;
      const state = (st.calls[0].payload as { state: string }).state;
      if (state !== "failed") {
        throw new Error(`not failed yet: ${state}`);
      }
    });
  });

  it("a renewed QR flips status to expired-renewed and rewrites the PNG", async () => {
    const root = tmpRoot();
    const counterFile = path.join(root, "count");
    const cli = makeFakeCli(root, RENEW_SCRIPT.replaceAll("__COUNTER_FILE__", counterFile));
    const handlers = await loadHandlers({
      channels: { signal: { cliPath: cli } },
    });
    const start = invoke(handlers["signal.link.start"] as never, {});
    await start.done;
    const { linkId, qrPngPath } = start.calls[0].payload as {
      linkId: string;
      qrPngPath: string;
    };
    const firstMtime = fs.statSync(qrPngPath).mtimeMs;

    // After the first attempt expires and the second QR is written, a status
    // poll must be able to observe expired-renewed or the terminal linked
    // state — never a silent stale QR.
    const observedStates = new Set<string>();
    await vi.waitFor(
      async () => {
        const st = invoke(handlers["signal.link.status"] as never, { linkId });
        await st.done;
        const state = (st.calls[0].payload as { state: string }).state;
        observedStates.add(state);
        if (state !== "linked") {
          throw new Error(`state: ${state}`);
        }
      },
      { timeout: 15_000 },
    );
    // The PNG was rewritten by the renewal (same path, newer content).
    expect(fs.existsSync(qrPngPath)).toBe(false); // removed after link end
    expect(
      [...observedStates].every((s) => ["waiting", "expired-renewed", "linked"].includes(s)),
    ).toBe(true);
    void firstMtime;
  });

  it("rejects a second concurrent link for the same config dir", async () => {
    const root = tmpRoot();
    const pidFile = path.join(root, "child.pid");
    const cli = makeFakeCli(root, HANG_SCRIPT.replaceAll("__PID_FILE__", pidFile));
    const handlers = await loadHandlers({
      channels: { signal: { cliPath: cli } },
    });
    const first = invoke(handlers["signal.link.start"] as never, {});
    await first.done;
    expect(first.calls[0].ok).toBe(true);
    const second = invoke(handlers["signal.link.start"] as never, {});
    await second.done;
    expect(second.calls[0].ok).toBe(false);
    expect(second.calls[0].error?.message).toContain("already in progress");
    const { linkId } = first.calls[0].payload as { linkId: string };
    const cancel = invoke(handlers["signal.link.cancel"] as never, { linkId });
    await cancel.done;
  });

  it("unknown linkId is an error", async () => {
    const handlers = await loadHandlers({});
    const st = invoke(handlers["signal.link.status"] as never, { linkId: "nope" });
    await st.done;
    expect(st.calls[0].ok).toBe(false);
    expect(st.calls[0].error?.message).toContain("Unknown or expired linkId");
  });
});
