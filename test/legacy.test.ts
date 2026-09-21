import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareLegacyMigrationCopy } from "../src/legacy/migrate-copy.js";

describe("legacy migration-on-copy", () => {
  it.each(["agents", "..store"])(
    "confines store %s without changing source",
    async (storeDirectory) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "openclaw-atif-legacy-"));
      const actualRoot = join(temporaryRoot, "actual");
      const root = join(temporaryRoot, "alias");
      await mkdir(actualRoot);
      await symlink(actualRoot, root);
      const source = join(root, "source");
      const staging = join(root, "staging");
      await mkdir(join(source, "agents", "main", "sessions"), { recursive: true });
      await mkdir(staging);
      const sourceFile = join(source, "agents", "main", "sessions", "sessions.json");
      await writeFile(sourceFile, '{"agent:main:main":{"sessionId":"legacy"}}\n');
      await writeFile(
        join(source, "openclaw.json"),
        JSON.stringify({
          session: { store: join(source, storeDirectory, "{agentId}", "sessions.json") },
        }),
      );
      const executable = join(root, "openclaw.mjs");
      await writeFile(
        executable,
        '#!/usr/bin/env node\nif (process.argv.includes("--help")) console.log("--session-sqlite"); else console.log(JSON.stringify({ok:true,mode:process.argv[3],generatedAt:new Date().toISOString(),stateDir:process.env.OPENCLAW_STATE_DIR,runId:Math.random()}))\n',
      );
      await chmod(executable, 0o700);
      const result = await prepareLegacyMigrationCopy({
        sourceStateDir: source,
        stagingRoot: staging,
        executable,
      });
      expect(result.receipt.commands.map((item) => item.mode)).toEqual([
        "inspect",
        "dry-run",
        "import",
        "validate",
      ]);
      expect(result.receipt.sourceFingerprintBefore).toBe(result.receipt.sourceFingerprintAfter);
      expect(await readFile(sourceFile, "utf8")).toContain("legacy");
      expect(
        await readFile(
          join(result.stateDir, "agents", "main", "sessions", "sessions.json"),
          "utf8",
        ),
      ).toContain("legacy");
      const copiedConfig = JSON.parse(
        await readFile(join(result.stateDir, "openclaw.json"), "utf8"),
      ) as { session: { store: string } };
      expect(copiedConfig.session.store).toBe(
        join(result.stateDir, storeDirectory, "{agentId}", "sessions.json"),
      );
      const secondStaging = join(root, "staging-second");
      await mkdir(secondStaging);
      const repeated = await prepareLegacyMigrationCopy({
        sourceStateDir: source,
        stagingRoot: secondStaging,
        executable,
      });
      expect(repeated.receipt.commands).toEqual(result.receipt.commands);
    },
  );

  it("falls back to non-interactive repair when targeted migration is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-legacy-"));
    const source = join(root, "source");
    const staging = join(root, "staging");
    await mkdir(source);
    await mkdir(staging);
    await writeFile(join(source, "sessions.json"), "{}\n");
    const executable = join(root, "openclaw.mjs");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a[0]==="doctor"&&a.includes("--help")) console.log("doctor help"); else if(a[0]==="sessions") console.log(JSON.stringify({sessions:[]})); else console.log("fixed");\n',
    );
    await chmod(executable, 0o700);
    const result = await prepareLegacyMigrationCopy({
      sourceStateDir: source,
      stagingRoot: staging,
      executable,
    });
    expect(result.receipt.commands.map((item) => item.mode)).toEqual([
      "fix",
      "sessions-list-verify",
    ]);
  });

  it("rejects a configured session store outside the copied state before migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-legacy-"));
    const source = join(root, "source");
    const staging = join(root, "staging");
    await mkdir(source);
    await mkdir(staging);
    await writeFile(
      join(source, "openclaw.json"),
      JSON.stringify({ session: { store: join(root, "original-sessions.json") } }),
    );
    await expect(
      prepareLegacyMigrationCopy({
        sourceStateDir: source,
        stagingRoot: staging,
        executable: process.execPath,
      }),
    ).rejects.toThrow("outside the copied state");
  });

  it("rejects source trees with symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-legacy-"));
    const source = join(root, "source");
    const staging = join(root, "staging");
    await mkdir(source);
    await mkdir(staging);
    const external = join(root, "external");
    await writeFile(external, "secret");
    await symlink(external, join(source, "linked"));
    await expect(
      prepareLegacyMigrationCopy({
        sourceStateDir: source,
        stagingRoot: staging,
        executable: process.execPath,
      }),
    ).rejects.toThrow("symlink");
  });
});
