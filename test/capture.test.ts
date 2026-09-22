import { chmod, cp, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureOpenClawFamily } from "../src/capture/family.js";
import { convertOpenClawBundles, exportOpenClawFamily } from "../src/exporter.js";
import { childEvents, rootEvents, writeBundle } from "./helpers.js";

async function fakeOpenClaw(rootParentKind?: string) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-atif-capture-"));
  const bundles = join(root, "bundles");
  await writeBundle({
    root: bundles,
    name: "root",
    sessionId: "root-session",
    sessionKey: "agent:main:main",
    events: rootEvents(),
  });
  await writeBundle({
    root: bundles,
    name: "child",
    sessionId: "child-session",
    sessionKey: "agent:main:subagent:child",
    events: childEvents(),
  });
  const listing = {
    sessions: [
      {
        key: "agent:main:main",
        sessionId: "root-session",
        updatedAt: 1,
        ...(rootParentKind
          ? { parentSessionKey: "agent:main:subagent:child", kind: rootParentKind }
          : {}),
      },
      {
        key: "agent:main:subagent:child",
        sessionId: "child-session",
        updatedAt: 1,
        parentSessionKey: "agent:main:main",
      },
    ],
    hasMore: false,
  };
  const script = join(root, "openclaw.mjs");
  await writeFile(
    script,
    `#!/usr/bin/env node
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2026.8.1-test"); process.exit(0); }
if (args[0] === "config") { console.log(JSON.stringify({ valid: true, path: process.env.OPENCLAW_CONFIG_PATH })); process.exit(0); }
if (args[0] === "doctor" && args.includes("--help")) { console.log("--session-sqlite --session-sqlite-all-agents"); process.exit(0); }
if (args[0] === "doctor") {
  const state = process.env.OPENCLAW_STATE_DIR;
  console.log(JSON.stringify({ mode: args[2], targets: [{ agentId: "main", storePath: join(state, "sessions.json"), sqlitePath: join(state, "openclaw-agent.sqlite"), issues: [] }], totals: { targets: 1, issues: 0 } })); process.exit(0);
}
if (args[0] === "sessions" && args[1] === "export-trajectory" && args.includes("--help")) { console.log("openclaw sessions export-trajectory"); process.exit(0); }
if (args[0] === "sessions" && args.includes("--all-agents")) { console.log(${JSON.stringify(JSON.stringify(listing))}); process.exit(0); }
if (args[0] === "sessions" && args[1] === "export-trajectory") {
  const key = args[args.indexOf("--session-key") + 1];
  const workspace = args[args.indexOf("--workspace") + 1];
  const output = args[args.indexOf("--output") + 1];
  const destination = join(workspace, ".openclaw", "trajectory-exports", output);
  const isChild = key.includes(":subagent:");
  if (isChild && process.env.FAIL_CHILD_COUNTER) {
    await appendFile(process.env.FAIL_CHILD_COUNTER, "attempt\\n");
    if (process.env.FAIL_CHILD_ALWAYS === "1") process.exit(3);
  }
  await mkdir(join(workspace, ".openclaw", "trajectory-exports"), { recursive: true });
  await cp(join(${JSON.stringify(bundles)}, isChild ? "child" : "root"), destination, { recursive: true });
  const manifestPath = join(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.generatedAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest));
  console.log(JSON.stringify({ outputDir: destination, sessionId: isChild ? "child-session" : "root-session", files: ["manifest.json", "events.jsonl", "session-branch.json"] }));
  process.exit(0);
}
process.exit(2);
`,
  );
  await chmod(script, 0o700);
  return { root, bundles, script };
}

describe("captureOpenClawFamily", () => {
  it.each([false, true])(
    "replays relocated retained bundles without upgrading partial capture (%s)",
    async (partial) => {
      const fake = await fakeOpenClaw();
      const original = await exportOpenClawFamily({
        executable: fake.script,
        sessionKey: "agent:main:main",
        output: join(fake.root, "original"),
        keepSourceBundles: true,
        retries: 1,
        command: {
          env: {
            ...process.env,
            ...(partial
              ? { FAIL_CHILD_COUNTER: join(fake.root, "attempts"), FAIL_CHILD_ALWAYS: "1" }
              : {}),
          },
        },
      });
      expect(original.sourceBundleRoot).toBeTruthy();
      const retained = original.sourceBundleRoot;
      if (!retained) throw new Error("Missing retained source bundles");
      expect((await stat(join(retained, "graph.json"))).mode & 0o777).toBe(0o600);
      const moved = join(fake.root, "relocated");
      await cp(retained, moved, { recursive: true });
      const replay = await convertOpenClawBundles({
        graph: join(moved, "graph.json"),
        bundleRoot: moved,
        output: join(fake.root, "replay"),
      });
      expect(replay.trajectory).toEqual(original.trajectory);
      expect(replay.receipt).toEqual(original.receipt);
      expect(replay.status).toBe(partial ? "partial" : "complete");
      const graph = JSON.parse(await readFile(join(moved, "graph.json"), "utf8")) as {
        nodes: { bundleDir: string }[];
      };
      const bundle = graph.nodes[0];
      if (!bundle) throw new Error("missing fixture bundle");
      const path = join(moved, bundle.bundleDir, "session-branch.json");
      await writeFile(path, `${await readFile(path, "utf8")}\n`);
      await expect(
        convertOpenClawBundles({
          graph: join(moved, "graph.json"),
          bundleRoot: moved,
          output: join(fake.root, "tampered"),
        }),
      ).rejects.toThrow("hash mismatch");
    },
  );
  it.each(["visible-child", "unknown-child"])(
    "rejects %s cycles back to the root",
    async (kind) => {
      const fake = await fakeOpenClaw(kind);
      const staging = join(fake.root, "cycle-staging");
      await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
      await expect(
        captureOpenClawFamily({
          executable: fake.script,
          openclawVersion: "test",
          stagingRoot: staging,
          sessionKey: "agent:main:main",
          command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
        }),
      ).rejects.toThrow("cycle back to the root");
    },
  );

  it("captures and reconciles a stable public session family", async () => {
    const fake = await fakeOpenClaw();
    const staging = join(fake.root, "staging");
    await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
    const family = await captureOpenClawFamily({
      executable: fake.script,
      openclawVersion: "2026.8.1-test",
      stagingRoot: staging,
      sessionKey: "agent:main:main",
      command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
    });
    expect(family.stable).toBe(true);
    expect(family.nodes.size).toBe(2);
    expect(family.relationships[0]?.spawn?.toolCallId).toBe("call-1");
  });

  it("retries transient child export races and returns a partial root after the final attempt", async () => {
    const fake = await fakeOpenClaw();
    const staging = join(fake.root, "staging-race");
    const counter = join(fake.root, "child-attempts.txt");
    await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
    const family = await captureOpenClawFamily({
      executable: fake.script,
      openclawVersion: "2026.8.1-test",
      stagingRoot: staging,
      sessionKey: "agent:main:main",
      retries: 3,
      command: {
        env: {
          ...process.env,
          BUNDLE_ROOT: fake.bundles,
          FAIL_CHILD_COUNTER: counter,
          FAIL_CHILD_ALWAYS: "1",
        },
      },
    });
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(3);
    expect(family.nodes.size).toBe(1);
    expect(family.diagnostics.some((item) => item.code === "child-export-unavailable")).toBe(true);
  });

  it("does not embed a replacement child generation when spawn run evidence differs", async () => {
    const fake = await fakeOpenClaw();
    const eventsPath = join(fake.bundles, "child", "events.jsonl");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => ({
        ...(JSON.parse(line) as Record<string, unknown>),
        runId: "replacement-run",
      }));
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const staging = join(fake.root, "staging-generation-mismatch");
    await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
    const family = await captureOpenClawFamily({
      executable: fake.script,
      openclawVersion: "2026.8.1-test",
      stagingRoot: staging,
      sessionKey: "agent:main:main",
      retries: 2,
      command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
    });
    expect(family.nodes.has("agent:main:subagent:child")).toBe(false);
    expect(family.diagnostics.some((item) => item.code === "child-export-unavailable")).toBe(true);
  });

  it("runs the complete public export pipeline", async () => {
    const fake = await fakeOpenClaw();
    const output = join(fake.root, "output");
    const result = await exportOpenClawFamily({
      executable: fake.script,
      sessionKey: "agent:main:main",
      output,
      command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
    });
    expect(result.status).toBe("complete");
    expect(result.receipt.source.openclawVersion).toBe("2026.8.1-test");
    expect(result.receipt.source.openclawExecutableSha256).toMatch(/^[a-f0-9]{64}$/u);
    const repeated = await exportOpenClawFamily({
      executable: fake.script,
      sessionKey: "agent:main:main",
      output,
      command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
    });
    expect(repeated.writes.every((write) => write.idempotent)).toBe(true);
  });

  it("rejects a public bundle whose session key contradicts the selected listing row", async () => {
    const fake = await fakeOpenClaw();
    const manifestPath = join(fake.bundles, "child", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.sessionKey;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const eventsPath = join(fake.bundles, "child", "events.jsonl");
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => ({ ...(JSON.parse(line) as Record<string, unknown>), sessionKey: "other" }));
    await writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const staging = join(fake.root, "staging-key-mismatch");
    await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
    await expect(
      captureOpenClawFamily({
        executable: fake.script,
        openclawVersion: "2026.8.1-test",
        stagingRoot: staging,
        sessionKey: "agent:main:main",
        command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
      }),
    ).rejects.toThrow("sessionKey does not match");
  });

  it("uses explicit migration-on-copy when the source executable lacks export", async () => {
    const fake = await fakeOpenClaw();
    const legacy = join(fake.root, "legacy");
    await (await import("node:fs/promises")).mkdir(legacy);
    await writeFile(join(legacy, "sessions.json"), "{}\n");
    const source = join(fake.root, "old-openclaw.mjs");
    await writeFile(
      source,
      '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("old"); process.exit(0); } process.exit(2);\n',
    );
    await chmod(source, 0o700);
    const result = await exportOpenClawFamily({
      executable: source,
      migrationExecutable: fake.script,
      migrateCopy: true,
      legacyStateDir: legacy,
      sessionKey: "agent:main:main",
      output: join(fake.root, "migrated-output"),
      command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
    });
    expect(result.status).toBe("complete");
    expect(result.receipt.legacyMigration?.commands).toHaveLength(7);
  });

  it("rejects unsupported export without explicit migration inputs", async () => {
    const fake = await fakeOpenClaw();
    const source = join(fake.root, "old-openclaw.mjs");
    await writeFile(
      source,
      '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("old"); process.exit(0); } process.exit(2);\n',
    );
    await chmod(source, 0o700);
    await expect(
      exportOpenClawFamily({
        executable: source,
        sessionKey: "agent:main:main",
        output: join(fake.root, "out"),
      }),
    ).rejects.toThrow("migration-on-copy");
  });

  it("enforces family node and depth limits", async () => {
    const fake = await fakeOpenClaw();
    for (const limits of [{ maxNodes: 1 }, { maxDepth: 0 }]) {
      const staging = join(fake.root, `staging-${Object.keys(limits)[0] ?? "limit"}`);
      await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
      await expect(
        captureOpenClawFamily({
          executable: fake.script,
          openclawVersion: "test",
          stagingRoot: staging,
          sessionId: "root-session",
          ...limits,
          command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
        }),
      ).rejects.toThrow("limit");
    }
  });

  it("requires an exact root selection", async () => {
    const fake = await fakeOpenClaw();
    const staging = join(fake.root, "staging");
    await (await import("node:fs/promises")).mkdir(staging, { mode: 0o700 });
    await expect(
      captureOpenClawFamily({
        executable: fake.script,
        openclawVersion: "test",
        stagingRoot: staging,
        sessionKey: "missing",
        command: { env: { ...process.env, BUNDLE_ROOT: fake.bundles } },
      }),
    ).rejects.toThrow("not found");
  });
});
