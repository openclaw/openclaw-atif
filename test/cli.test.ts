import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { completedExitCode, parseCliArgs, runCli } from "../src/cli.js";
import { childEvents, writeBundle } from "./helpers.js";

describe("CLI", () => {
  it("parses export options", () => {
    const parsed = parseCliArgs([
      "export",
      "--session-key",
      "agent:main:main",
      "--output",
      "out",
      "--json",
    ]);
    expect(parsed.command).toBe("export");
    expect(parsed.values.get("session-key")).toBe("agent:main:main");
    expect(parsed.flags.has("json")).toBe(true);
  });

  it("rejects unknown and duplicate options", () => {
    expect(() => parseCliArgs(["export", "--wat"])).toThrow("Unknown option");
    expect(() => parseCliArgs(["export", "--output", "a", "--output", "b"])).toThrow(
      "more than once",
    );
  });

  it("converts a bundle graph through the installed command contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-cli-"));
    await writeBundle({
      root,
      name: "bundle",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events: childEvents("session"),
    });
    const graph = join(root, "graph.json");
    await writeFile(
      graph,
      JSON.stringify({
        schema: "openclaw-atif-bundle-graph-v1",
        rootKey: "agent:main:main",
        openclawVersion: "test",
        nodes: [{ sessionKey: "agent:main:main", bundleDir: "bundle" }],
      }),
    );
    const output = join(root, "output");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await runCli([
      "convert",
      "--graph",
      graph,
      "--bundle-root",
      root,
      "--output",
      output,
      "--json",
    ]);
    expect(code).toBe(0);
    expect(String(stdout.mock.calls.at(-1)?.[0])).toContain('"status":"complete"');
    stdout.mockRestore();
  });

  it("gives a received signal priority over a completed export status", () => {
    expect(completedExitCode("complete", 130)).toBe(130);
    expect(completedExitCode("partial", 143)).toBe(143);
    expect(completedExitCode("complete", undefined)).toBe(0);
    expect(completedExitCode("partial", undefined)).toBe(2);
  });

  it.each([false, true])("preserves whitespace in paths with force=%s", async (force) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-cli-paths-"));
    try {
      await writeBundle({
        root: join(root, " bundles "),
        name: "bundle",
        sessionId: "session",
        sessionKey: "agent:main:main",
        events: childEvents("session"),
      });
      await writeFile(
        join(root, " graph.json "),
        JSON.stringify({
          schema: "openclaw-atif-bundle-graph-v1",
          rootKey: "agent:main:main",
          openclawVersion: "test",
          nodes: [{ sessionKey: "agent:main:main", bundleDir: "bundle" }],
        }),
      );
      await writeFile(join(root, "graph.json"), "trimmed graph");
      for (const name of ["bundles", "output", ...(force ? [" output "] : [])]) {
        await mkdir(join(root, name));
        await writeFile(join(root, name, "sentinel"), name);
      }
      const result = spawnSync(
        process.execPath,
        [
          resolve("dist/cli-main.js"),
          "convert",
          "--graph",
          " graph.json ",
          "--bundle-root",
          " bundles ",
          "--output",
          " output ",
          "--json",
          ...(force ? ["--force"] : []),
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(root, " output ", "trajectory.json"), "utf8")).toContain(
        "ATIF-v1.8",
      );
      expect(await readFile(join(root, "graph.json"), "utf8")).toBe("trimmed graph");
      for (const name of ["bundles", "output"])
        expect(await readFile(join(root, name, "sentinel"), "utf8")).toBe(name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [["unknown"], "Unknown command: unknown"],
    [["convert", "--wat"], "Unknown option: --wat"],
    [["convert", "--output"], "Option --output requires a value"],
    [["convert", "--output", "a", "--output", "b"], "Option --output was supplied more than once"],
    [["convert"], "--output is required"],
    [["convert", "--output", "out"], "--graph is required"],
  ] as const)(
    "reports invalid input %j without leaking signal listeners",
    async (args, message) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const before = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
      try {
        await expect(runCli(args)).resolves.toBe(1);
        expect(stderr.mock.calls).toEqual([[`${message}\n`]]);
        expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(before);
      } finally {
        stderr.mockRestore();
      }
    },
  );
});
