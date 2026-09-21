import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseFinalJsonObject } from "../src/openclaw/json-output.js";
import { resolveExecutable, runCommand, runOpenClaw } from "../src/openclaw/process.js";

describe("OpenClaw process boundary", () => {
  it("parses the final pretty JSON object after diagnostics", () => {
    expect(parseFinalJsonObject('notice\n{\n  "sessions": []\n}\n')).toEqual({ sessions: [] });
  });

  it("parses large pretty objects without losing the root candidate", () => {
    const sessions = Array.from({ length: 200 }, (_, index) => ({
      key: `session-${String(index)}`,
    }));
    expect(parseFinalJsonObject(`notice\n${JSON.stringify({ sessions }, null, 2)}\n`)).toEqual({
      sessions,
    });
  });

  it("rejects output without a final object", () => {
    expect(() => parseFinalJsonObject("notice only")).toThrow("JSON object");
  });

  it("runs executables without a shell and preserves arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-process-"));
    const script = join(root, "echo.mjs");
    await writeFile(
      script,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n",
    );
    await chmod(script, 0o700);
    const result = await runCommand(script, ["a; echo injected", "$(bad)"]);
    expect(JSON.parse(result.stdout)).toEqual(["a; echo injected", "$(bad)"]);
    expect((await resolveExecutable(script)).sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("bounds output and time", async () => {
    await expect(
      runCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(100))'], {
        maxOutputBytes: 10,
      }),
    ).rejects.toThrow("exceeded");
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 10 }),
    ).rejects.toThrow("timed out");
  });

  it("propagates cancellation and command failures", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
        signal: controller.signal,
      }),
    ).rejects.toThrow("interrupted");
    await expect(
      runOpenClaw(process.execPath, ["-e", 'process.stderr.write("failed"); process.exit(7)']),
    ).rejects.toThrow("failed");
  });

  it("resolves executables through PATH and rejects missing names", async () => {
    expect((await resolveExecutable("node")).path).toContain("node");
    await expect(resolveExecutable("definitely-not-an-openclaw-atif-executable")).rejects.toThrow(
      "not found",
    );
  });

  it("skips directories and non-executable files before a valid PATH candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-path-"));
    const paths = ["directory", "non-executable", "valid"].map((name) => join(root, name));
    try {
      for (const path of paths) await mkdir(path);
      await mkdir(join(paths[0] ?? root, "candidate"));
      await writeFile(join(paths[1] ?? root, "candidate"), "not executable", { mode: 0o600 });
      await symlink(process.execPath, join(paths[2] ?? root, "candidate"));
      vi.stubEnv("PATH", paths.join(delimiter));
      expect((await resolveExecutable("candidate")).path).toBe(
        (await resolveExecutable(process.execPath)).path,
      );
      await expect(resolveExecutable(join(paths[0] ?? root, "candidate"))).rejects.toThrow(
        "not a regular executable",
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
