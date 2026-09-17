import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AtifContentPart,
  type AtifTrajectory,
  validateAtifTrajectory,
} from "../src/atif/schema.js";
import { convertOpenClawBundles, exportOpenClawFamily } from "../src/exporter.js";
import { event, writeBundle } from "./helpers.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openclaw-atif-media-export-"));
  roots.push(root);
  const bundleRoot = join(root, "input");
  await cp(join(process.cwd(), "fixtures/bundles/media"), bundleRoot, { recursive: true });
  return { root, bundleRoot, graph: join(bundleRoot, "graph.json"), output: join(root, "output") };
}
function localParts(trajectory: AtifTrajectory): Exclude<AtifContentPart, { type: "text" }>[] {
  return trajectory.steps
    .flatMap((step) => [
      step.message,
      ...(step.observation?.results.map((result) => result.content) ?? []),
    ])
    .flatMap((content) => (Array.isArray(content) ? content : []))
    .filter((part) => part.type !== "text");
}
async function verifyMedia(output: string): Promise<void> {
  const trajectory = validateAtifTrajectory(
    JSON.parse(await readFile(join(output, "trajectory.json"), "utf8")) as unknown,
  );
  expect(trajectory.schema_version).toBe("ATIF-v1.8");
  const parts = localParts(trajectory);
  expect(parts).toHaveLength(5);
  expect(await readdir(join(output, "media"))).toHaveLength(2);
  for (const part of parts) {
    expect(part.source.path).toMatch(/^media\/[0-9a-f]{64}\.(png|wav)$/);
    expect((await readFile(join(output, part.source.path))).length).toBeGreaterThan(0);
    expect((await stat(join(output, part.source.path))).mode & 0o777).toBe(0o600);
  }
  expect((await stat(join(output, "media"))).mode & 0o777).toBe(0o700);
  expect(trajectory.final_metrics?.total_prompt_tokens).toBe(5);
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("media export through public entry points", () => {
  it("keeps library output valid after input cleanup and produces deterministic reruns", async () => {
    const f = await fixture();
    const first = await convertOpenClawBundles(f);
    const second = await convertOpenClawBundles(f);
    expect(first.status).toBe("complete");
    expect(second.writes.every((write) => write.idempotent)).toBe(true);
    expect(first.receipt).toEqual(second.receipt);
    await rm(f.bundleRoot, { recursive: true });
    await verifyMedia(f.output);
  });

  it("retains scalar and nested image locations after input cleanup", async () => {
    const f = await fixture();
    const bytes = await readFile(join(f.bundleRoot, "root", "pixel.png"));
    await writeBundle({
      root: f.bundleRoot,
      name: "root",
      sessionId: "media-session",
      sessionKey: "agent:main:main",
      events: [
        event({
          seq: 1,
          source: "transcript",
          type: "user.message",
          sessionId: "media-session",
          data: {
            message: {
              content: [
                ...["image_url", "input_image"].map((type) => ({
                  type,
                  media_type: "image/png",
                  image_url: "pixel.png",
                })),
                {
                  type: "input_image",
                  input_image: { media_type: "image/png", path: "pixel.png" },
                },
              ],
            },
          },
        }),
        event({
          seq: 2,
          source: "runtime",
          type: "session.ended",
          sessionId: "media-session",
          data: { reason: "completed" },
        }),
      ],
    });
    const result = await convertOpenClawBundles({ ...f, requireComplete: true });
    expect(result.status).toBe("complete");
    expect(result.receipt.diagnostics).toEqual([]);
    expect(await readdir(join(f.output, "media"))).toHaveLength(1);
    const parts = localParts(result.trajectory);
    expect(parts).toHaveLength(3);
    await rm(f.bundleRoot, { recursive: true });
    for (const part of parts) {
      expect(part.type).toBe("image");
      expect(part.source.media_type).toBe("image/png");
      expect(part.source.path).toMatch(/^media\/[0-9a-f]{64}\.png$/);
      expect(await readFile(join(f.output, part.source.path))).toEqual(bytes);
    }
  });

  it("runs the compiled CLI with retained media and no remaining input bundles", async () => {
    const f = await fixture();
    const stdout = execFileSync(
      process.execPath,
      [
        join(process.cwd(), "dist/cli-main.js"),
        "convert",
        "--graph",
        f.graph,
        "--bundle-root",
        f.bundleRoot,
        "--output",
        f.output,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(stdout).toContain('"status":"complete"');
    await rm(f.bundleRoot, { recursive: true });
    await verifyMedia(f.output);
  });

  it("reports unsupported content as partial and refuses it with require-complete", async () => {
    const f = await fixture();
    await writeBundle({
      root: f.bundleRoot,
      name: "root",
      sessionId: "media-session",
      sessionKey: "agent:main:main",
      events: [
        event({
          seq: 1,
          source: "transcript",
          type: "user.message",
          sessionId: "media-session",
          data: {
            message: {
              content: [
                { type: "image", source: { path: "missing.png", media_type: "image/png" } },
                { type: "audio", data: "inline-base64" },
                { type: "text", text: "observed" },
              ],
            },
          },
        }),
      ],
    });
    const args = [
      join(process.cwd(), "dist/cli-main.js"),
      "convert",
      "--graph",
      f.graph,
      "--bundle-root",
      f.bundleRoot,
      "--output",
      f.output,
      "--json",
    ];
    const strict = spawnSync(process.execPath, [...args, "--require-complete"], {
      encoding: "utf8",
    });
    expect(strict.status).toBe(1);
    await expect(access(f.output)).rejects.toBeDefined();
    const partial = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(partial.status).toBe(2);
    const result = await convertOpenClawBundles(f);
    expect(result.status).toBe("partial");
    expect(result.trajectory.steps[0]?.message).toBe("observed");
    expect(result.receipt.diagnostics.map((d) => d.code)).toContain("media-file-unavailable");
    expect(await readdir(f.output)).toEqual(["receipt.json", "trajectory.json"]);
  });

  it("retains media before capture removes its staging bundles using a scripted public-command fixture", async () => {
    const f = await fixture();
    const executable = join(f.root, "openclaw.mjs");
    const log = join(f.root, "bundle-path.txt");
    await writeFile(
      executable,
      `#!${process.execPath}
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("2026.9.4-fixture");
else if (args.includes("--help")) console.log("openclaw sessions export-trajectory");
else if (args.includes("--all-agents")) console.log(JSON.stringify({ sessions: [{ key: "agent:main:main", sessionId: "media-session" }], hasMore: false }));
else {
  const workspace = args[args.indexOf("--workspace") + 1];
  const output = args[args.indexOf("--output") + 1];
  const destination = join(workspace, ".openclaw", "trajectory-exports", output);
  await mkdir(destination, { recursive: true });
  await cp(${JSON.stringify(join(f.bundleRoot, "root"))}, destination, { recursive: true });
  await writeFile(${JSON.stringify(log)}, destination);
  console.log(JSON.stringify({ outputDir: destination, sessionId: "media-session", files: ["manifest.json", "events.jsonl", "session-branch.json"] }));
}
`,
    );
    await chmod(executable, 0o700);
    const result = await exportOpenClawFamily({
      executable,
      sessionKey: "agent:main:main",
      output: f.output,
    });
    expect(result.status).toBe("complete");
    await expect(access(await readFile(log, "utf8"))).rejects.toBeDefined();
    await rm(f.bundleRoot, { recursive: true });
    await verifyMedia(f.output);
  });
});
