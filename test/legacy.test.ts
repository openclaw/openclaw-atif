import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareLegacyMigrationCopy } from "../src/legacy/migrate-copy.js";

async function migrationExecutable(
  root: string,
  unsupported = false,
  failure = "",
): Promise<string> {
  const executable = join(root, "openclaw.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
const failure = ${JSON.stringify(failure)};
appendFileSync(${JSON.stringify(join(root, "calls"))}, a.join(" ") + "\\n");
const state = process.env.OPENCLAW_STATE_DIR;
if (a[0] === "--version") console.log("test");
else if (a[0] === "config") console.log(JSON.stringify({valid:failure !== "invalid-config",path:failure === "wrong-config" ? "/wrong" : process.env.OPENCLAW_CONFIG_PATH}));
else if (a[0] === "doctor" && a.includes("--help")) console.log(${JSON.stringify(unsupported ? "doctor" : "--session-sqlite --session-sqlite-all-agents")});
else if (a[0] === "doctor") console.log(JSON.stringify({
  mode:a[2], targets:[{agentId:"main",storePath:failure === "outside" ? "/outside/store" : state+"/agents/main/sessions/sessions.json",
  sqlitePath:state+(failure === "inconsistent" && a[2] === "dry-run" ? "/changed.sqlite" : "/agents/main/agent/openclaw-agent.sqlite"),issues:[]}],totals:{targets:1,issues:failure === "issues" ? 1 : 0}
}));
else if (a.includes("--help")) console.log("export-trajectory");
else if (a[0] === "sessions") console.log(JSON.stringify({sessions:[]}));
else process.exit(3);
`,
    { mode: 0o700 },
  );
  return executable;
}

describe("legacy migration-on-copy", () => {
  it.each(["invalid-config", "wrong-config", "outside", "issues", "inconsistent"])(
    "rejects %s before import",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "openclaw-atif-preflight-"));
      const source = join(root, "source");
      const staging = join(root, "staging");
      await mkdir(source);
      await mkdir(staging);
      const executable = await migrationExecutable(root, false, failure);
      await expect(
        prepareLegacyMigrationCopy({
          sourceStateDir: source,
          stagingRoot: staging,
          executable,
        }),
      ).rejects.toThrow();
      expect(await readFile(join(root, "calls"), "utf8")).not.toContain("--session-sqlite import");
    },
  );

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
      const executable = await migrationExecutable(root);
      const result = await prepareLegacyMigrationCopy({
        sourceStateDir: source,
        stagingRoot: staging,
        executable,
      });
      expect(result.receipt.commands.map((item) => item.mode)).toEqual([
        "config-validate",
        "inspect",
        "dry-run",
        "import",
        "validate",
        "inspect",
        "sessions-list-verify",
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
        await readFile(result.command.env?.OPENCLAW_CONFIG_PATH ?? "", "utf8"),
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

  it("rejects migration executables without targeted support", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-legacy-"));
    const source = join(root, "source");
    const staging = join(root, "staging");
    await mkdir(source);
    await mkdir(staging);
    await writeFile(join(source, "sessions.json"), "{}\n");
    const executable = await migrationExecutable(root, true);
    await expect(
      prepareLegacyMigrationCopy({
        sourceStateDir: source,
        stagingRoot: staging,
        executable,
      }),
    ).rejects.toThrow("targeted --session-sqlite");
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
