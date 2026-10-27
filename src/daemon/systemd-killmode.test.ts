import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// signal-daemon-lifecycle ARCH §3.4 / §4: doctor flags a KillMode other than control-group,
// --fix rewrites the unit and runs daemon-reload, drop-ins are reported and never edited.
// systemctl is mocked; only temp files are touched.

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { auditGatewayServiceConfig, auditSystemdKillMode, SERVICE_AUDIT_CODES } =
  await import("./service-audit.js");
const { inspectSystemdKillMode, migrateSystemdKillMode, formatKillModeDropInWarning } =
  await import("./systemd.js");
const { buildSystemdUnit, readSystemdKillMode, rewriteSystemdKillMode } =
  await import("./systemd-unit.js");

const OLD_UNIT = [
  "[Unit]",
  "Description=OpenClaw Gateway",
  "",
  "[Service]",
  "ExecStart=/usr/bin/node /opt/openclaw/dist/index.js gateway",
  "Restart=always",
  "KillMode=process",
  "Environment=PATH=/usr/bin:/bin",
  "",
  "[Install]",
  "WantedBy=default.target",
  "",
].join("\n");

let home: string;
let unitDir: string;
let unitPath: string;
let systemRoot: string;
const env = () => ({ HOME: home });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "killmode-"));
  unitDir = path.join(home, ".config", "systemd", "user");
  unitPath = path.join(unitDir, "openclaw-gateway.service");
  systemRoot = path.join(home, "etc-systemd-user");
  fs.mkdirSync(unitDir, { recursive: true });
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, "", ""));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeDropIn(dir: string, name: string, content: string): string {
  const d = path.join(dir, "openclaw-gateway.service.d");
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("readSystemdKillMode / rewriteSystemdKillMode", () => {
  it("reads only the [Service] section and lets the last assignment win", () => {
    expect(readSystemdKillMode(OLD_UNIT)).toBe("process");
    expect(readSystemdKillMode("[Unit]\nKillMode=none\n")).toBeUndefined();
    expect(readSystemdKillMode("[Service]\nKillMode=process\nKillMode=mixed\n")).toBe("mixed");
    expect(readSystemdKillMode("[Service]\n# KillMode=process\n")).toBeUndefined();
  });

  it("replaces KillMode in place and keeps everything else", () => {
    const out = rewriteSystemdKillMode(OLD_UNIT);
    expect(out).toBe(OLD_UNIT.replace("KillMode=process", "KillMode=control-group"));
  });

  it("adds KillMode to [Service] when missing and collapses duplicates", () => {
    const noKill = OLD_UNIT.replace("KillMode=process\n", "");
    const added = rewriteSystemdKillMode(noKill);
    expect(readSystemdKillMode(added)).toBe("control-group");
    expect(added.indexOf("KillMode=control-group")).toBeLessThan(added.indexOf("[Install]"));
    const dup = rewriteSystemdKillMode("[Service]\nKillMode=process\nX=1\nKillMode=none\n");
    expect(dup.match(/KillMode=/g)).toHaveLength(1);
  });

  it("the generator already writes control-group", () => {
    const unit = buildSystemdUnit({ programArguments: ["/usr/bin/node", "gateway"] });
    expect(readSystemdKillMode(unit)).toBe("control-group");
  });
});

describe("doctor KillMode audit", () => {
  it("flags an installed unit with KillMode=process", async () => {
    fs.writeFileSync(unitPath, OLD_UNIT);
    const audit = await auditGatewayServiceConfig({
      env: env(),
      platform: "linux",
      command: { programArguments: ["/usr/bin/node", "gateway"] },
    });
    const issue = audit.issues.find((i) => i.code === SERVICE_AUDIT_CODES.systemdKillMode);
    expect(issue?.message).toContain("KillMode=process");
    expect(issue?.detail).toBe(unitPath);
  });

  it("accepts control-group and an unset KillMode (systemd default)", async () => {
    for (const unit of [
      OLD_UNIT.replace("KillMode=process", "KillMode=control-group"),
      OLD_UNIT.replace("KillMode=process\n", ""),
    ]) {
      fs.writeFileSync(unitPath, unit);
      const issues: { code: string }[] = [];
      await auditSystemdKillMode(env(), issues as never, { systemUnitRoots: [systemRoot] });
      expect(issues).toEqual([]);
    }
  });

  it("is silent when no unit is installed", async () => {
    const issues: unknown[] = [];
    await auditSystemdKillMode(env(), issues as never, { systemUnitRoots: [systemRoot] });
    expect(issues).toEqual([]);
  });

  it("reports drop-ins that set KillMode, from the user dir and /etc", async () => {
    fs.writeFileSync(unitPath, OLD_UNIT.replace("KillMode=process", "KillMode=control-group"));
    const userDropIn = writeDropIn(unitDir, "50-kill.conf", "[Service]\nKillMode=process\n");
    const etcDropIn = writeDropIn(systemRoot, "10-kill.conf", "[Service]\nKillMode=none\n");
    writeDropIn(unitDir, "60-env.conf", "[Service]\nEnvironment=A=1\n");
    const issues: { code: string; detail?: string }[] = [];
    await auditSystemdKillMode(env(), issues as never, { systemUnitRoots: [systemRoot] });
    expect(issues.map((i) => [i.code, i.detail])).toEqual([
      [SERVICE_AUDIT_CODES.systemdKillModeDropIn, etcDropIn],
      [SERVICE_AUDIT_CODES.systemdKillModeDropIn, userDropIn],
    ]);
    const inspection = await inspectSystemdKillMode(env(), { systemUnitRoots: [systemRoot] });
    expect(inspection.effective).toBe("process");
  });
});

describe("doctor --fix KillMode migration", () => {
  it("rewrites the unit to control-group, keeps a backup and runs daemon-reload", async () => {
    fs.writeFileSync(unitPath, OLD_UNIT);
    const result = await migrateSystemdKillMode(env(), { systemUnitRoots: [systemRoot] });
    expect(result.rewritten).toBe(true);
    expect(fs.readFileSync(unitPath, "utf8")).toBe(
      OLD_UNIT.replace("KillMode=process", "KillMode=control-group"),
    );
    expect(fs.readFileSync(`${unitPath}.bak`, "utf8")).toBe(OLD_UNIT);
    const calls = execFileMock.mock.calls.map((c) => [c[0], c[1]]);
    expect(calls).toEqual([["systemctl", ["--user", "daemon-reload"]]]);
  });

  it("never restarts or stops the service", async () => {
    fs.writeFileSync(unitPath, OLD_UNIT);
    await migrateSystemdKillMode(env(), { systemUnitRoots: [systemRoot] });
    for (const call of execFileMock.mock.calls) {
      expect(call[1]).not.toContain("restart");
      expect(call[1]).not.toContain("stop");
    }
  });

  it("is a no-op for a control-group unit (no write, no reload)", async () => {
    const good = OLD_UNIT.replace("KillMode=process", "KillMode=control-group");
    fs.writeFileSync(unitPath, good);
    const result = await migrateSystemdKillMode(env(), { systemUnitRoots: [systemRoot] });
    expect(result.rewritten).toBe(false);
    expect(fs.existsSync(`${unitPath}.bak`)).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("reports a KillMode drop-in and leaves it untouched", async () => {
    fs.writeFileSync(unitPath, OLD_UNIT);
    const dropInContent = "[Service]\nKillMode=process\n";
    const dropIn = writeDropIn(unitDir, "override.conf", dropInContent);
    const result = await migrateSystemdKillMode(env(), { systemUnitRoots: [systemRoot] });
    expect(result.rewritten).toBe(true);
    expect(fs.readFileSync(dropIn, "utf8")).toBe(dropInContent);
    expect(result.dropInOverrides).toEqual([{ path: dropIn, killMode: "process" }]);
    expect(result.effective).toBe("process");
    expect(formatKillModeDropInWarning(result.dropInOverrides)).toContain(dropIn);
  });

  it("surfaces a failed daemon-reload", async () => {
    fs.writeFileSync(unitPath, OLD_UNIT);
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error("boom"), { code: 1 });
      cb(err, "", "Failed to connect to bus");
    });
    await expect(migrateSystemdKillMode(env(), { systemUnitRoots: [systemRoot] })).rejects.toThrow(
      /daemon-reload failed/,
    );
  });
});
