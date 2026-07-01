import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function withFakeCli(versionOutput: string): { root: string; cliPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-sh-"));
  const cliPath = path.join(root, "openclaw");
  const escapedOutput = versionOutput.replace(/'/g, "'\\''");
  fs.writeFileSync(
    cliPath,
    `#!/usr/bin/env bash
printf '%s\n' '${escapedOutput}'
`,
    "utf-8",
  );
  fs.chmodSync(cliPath, 0o755);
  return { root, cliPath };
}

function resolveVersionFromInstaller(cliPath: string): string {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  const output = execFileSync(
    "bash",
    [
      "-lc",
      `source "${installerPath}" >/dev/null 2>&1
OPENCLAW_BIN="$FAKE_OPENCLAW_BIN"
resolve_openclaw_version`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        FAKE_OPENCLAW_BIN: cliPath,
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
      },
    },
  );
  return output.trim();
}

function resolveVersionFromInstallerViaStdin(cliPath: string, cwd: string): string {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  const installerSource = fs.readFileSync(installerPath, "utf-8");
  const output = execFileSync("bash", [], {
    cwd,
    encoding: "utf-8",
    input: `${installerSource}
OPENCLAW_BIN="$FAKE_OPENCLAW_BIN"
resolve_openclaw_version
`,
    env: {
      ...process.env,
      FAKE_OPENCLAW_BIN: cliPath,
      OPENCLAW_INSTALL_SH_NO_RUN: "1",
    },
  });
  return output.trim();
}

function resolveOpenClawBinFromInstaller(home: string, pathValue: string): string {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  const output = execFileSync(
    "bash",
    [
      "-lc",
      `source "${installerPath}" >/dev/null 2>&1
resolve_openclaw_bin`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: pathValue,
        PNPM_HOME: "",
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
      },
    },
  );
  return output.trim();
}

function addDirToDetectedShellPath(params: {
  home: string;
  shell: string;
  dir: string;
  displayDir: string;
  secondDir?: string;
  secondDisplayDir?: string;
}): void {
  const installerPath = path.join(process.cwd(), "scripts", "install.sh");
  execFileSync(
    "bash",
    [
      "-lc",
      `source "${installerPath}" >/dev/null 2>&1
add_dir_to_detected_shell_path "$TEST_DIR" "$TEST_DISPLAY_DIR"
if [[ -n "\${TEST_SECOND_DIR:-}" ]]; then
  add_dir_to_detected_shell_path "$TEST_SECOND_DIR" "$TEST_SECOND_DISPLAY_DIR"
fi`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: params.home,
        SHELL: params.shell,
        TEST_DIR: params.dir,
        TEST_DISPLAY_DIR: params.displayDir,
        TEST_SECOND_DIR: params.secondDir ?? "",
        TEST_SECOND_DISPLAY_DIR: params.secondDisplayDir ?? "",
        OPENCLAW_INSTALL_SH_NO_RUN: "1",
      },
    },
  );
}

describe("install.sh version resolution", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "extracts the semantic version from decorated CLI output",
    () => {
      const fixture = withFakeCli("OpenClaw 2026.3.10 (abcdef0)");
      tempRoots.push(fixture.root);

      expect(resolveVersionFromInstaller(fixture.cliPath)).toBe("2026.3.10");
    },
  );

  it.runIf(process.platform !== "win32")(
    "falls back to raw output when no semantic version is present",
    () => {
      const fixture = withFakeCli("OpenClaw dev's build");
      tempRoots.push(fixture.root);

      expect(resolveVersionFromInstaller(fixture.cliPath)).toBe("OpenClaw dev's build");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not source version helpers from cwd when installer runs via stdin",
    () => {
      const fixture = withFakeCli("OpenClaw 2026.3.10 (abcdef0)");
      tempRoots.push(fixture.root);

      const hostileCwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-stdin-"));
      tempRoots.push(hostileCwd);
      const hostileHelper = path.join(
        hostileCwd,
        "docker",
        "install-sh-common",
        "version-parse.sh",
      );
      fs.mkdirSync(path.dirname(hostileHelper), { recursive: true });
      fs.writeFileSync(
        hostileHelper,
        `#!/usr/bin/env bash
extract_openclaw_semver() {
  printf '%s' 'poisoned'
}
`,
        "utf-8",
      );

      expect(resolveVersionFromInstallerViaStdin(fixture.cliPath, hostileCwd)).toBe("2026.3.10");
    },
  );

  it.runIf(process.platform !== "win32")(
    "finds openclaw installed in pnpm's default global bin directory",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-pnpm-home-"));
      tempRoots.push(home);

      const pnpmBin = path.join(home, ".local", "share", "pnpm");
      const openclawBin = path.join(pnpmBin, "openclaw");
      fs.mkdirSync(pnpmBin, { recursive: true });
      fs.writeFileSync(
        openclawBin,
        `#!/usr/bin/env bash
printf 'OpenClaw test\\n'
`,
        "utf-8",
      );
      fs.chmodSync(openclawBin, 0o755);

      expect(resolveOpenClawBinFromInstaller(home, "/usr/bin:/bin")).toBe(openclawBin);
    },
  );

  it.runIf(process.platform !== "win32")("updates the detected zsh rc file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-zsh-home-"));
    tempRoots.push(home);

    addDirToDetectedShellPath({
      home,
      shell: "/usr/bin/zsh",
      dir: path.join(home, ".local", "share", "pnpm"),
      displayDir: "$HOME/.local/share/pnpm",
    });

    const zshrc = fs.readFileSync(path.join(home, ".zshrc"), "utf-8");
    expect(zshrc).toContain("# >>> openclaw >>>");
    expect(zshrc).toContain('__openclaw_bin="\\$HOME/.local/share/pnpm"');
    expect(zshrc).toContain('export PATH="$__openclaw_bin:$PATH"');
    expect(zshrc).toContain("# <<< openclaw <<<");
  });

  it.runIf(process.platform !== "win32")("updates the detected fish config", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-fish-home-"));
    tempRoots.push(home);

    addDirToDetectedShellPath({
      home,
      shell: "/usr/bin/fish",
      dir: path.join(home, ".local", "share", "pnpm"),
      displayDir: "$HOME/.local/share/pnpm",
    });

    expect(fs.readFileSync(path.join(home, ".config", "fish", "config.fish"), "utf-8")).toContain(
      "fish_add_path -m $HOME/.local/share/pnpm",
    );
  });

  it.runIf(process.platform !== "win32")("rewrites one managed shell block", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-block-home-"));
    tempRoots.push(home);
    const zshrc = path.join(home, ".zshrc");
    fs.writeFileSync(
      zshrc,
      [
        "before",
        "# >>> openclaw >>>",
        'export PATH="$HOME/old:$PATH"',
        "# <<< openclaw <<<",
        "after",
        "",
      ].join("\n"),
      "utf-8",
    );

    addDirToDetectedShellPath({
      home,
      shell: "/usr/bin/zsh",
      dir: path.join(home, ".local", "bin"),
      displayDir: "$HOME/.local/bin",
      secondDir: path.join(home, ".local", "share", "pnpm"),
      secondDisplayDir: "$HOME/.local/share/pnpm",
    });

    const content = fs.readFileSync(zshrc, "utf-8");
    expect(content).toContain("before");
    expect(content).toContain("after");
    expect(content).not.toContain("$HOME/old");
    expect((content.match(/# >>> openclaw >>>/g) ?? []).length).toBe(1);
    expect(content).toContain('__openclaw_bin="\\$HOME/.local/bin"');
    expect(content).toContain('__openclaw_bin="\\$HOME/.local/share/pnpm"');
  });
});
