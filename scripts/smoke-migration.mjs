#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const prefix = resolve(process.argv[2]);
const executable = join(prefix, "node_modules/.bin/openclaw");
const lock = JSON.parse(await readFile(join(prefix, "package-lock.json"), "utf8"));
assert.equal(lock.packages["node_modules/openclaw"].version, "2026.9.5");
assert.equal(
  lock.packages["node_modules/openclaw"].integrity,
  "sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w==",
);

async function snapshot(root) {
  const entries = [];
  async function visit(path, relative = "") {
    const stat = await lstat(path);
    assert.equal(stat.isSymbolicLink(), false);
    entries.push([
      relative,
      stat.mode & 0o777,
      stat.isDirectory()
        ? "directory"
        : createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
    ]);
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name), join(relative, name));
  }
  await visit(root);
  return entries;
}

const root = await mkdtemp(join(tmpdir(), "openclaw-atif-migration-smoke-"));
try {
  const protectedRoot = join(root, "protected");
  const source = join(protectedRoot, "source");
  const external = join(protectedRoot, "external");
  const home = join(external, "home");
  const workspace = join(external, "workspace");
  const agentDir = join(external, "agent");
  const plugin = join(external, "plugin");
  const sessions = join(source, "..stores/main");
  for (const path of [sessions, home, workspace, agentDir, plugin])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const config = join(external, "openclaw.json");
  const log = join(external, "openclaw.log");
  for (const path of [
    join(workspace, "AGENTS.md"),
    join(workspace, "TOOLS.md"),
    join(agentDir, "sentinel"),
    log,
  ])
    await writeFile(path, "preserve exactly\n");
  await writeFile(join(home, ".zshrc"), "source <(openclaw completion --shell zsh)\n");
  await writeFile(
    config,
    JSON.stringify({ session: { store: join(external, "empty/sessions.json") } }),
  );
  const sessionFile = join(sessions, "synthetic-session.jsonl");
  const events = [
    {
      type: "session",
      version: 3,
      id: "synthetic-session",
      timestamp: "2026-08-20T00:00:00.000Z",
      cwd: workspace,
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-08-20T00:00:01.000Z",
      message: { role: "user", content: "Hello", timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-08-20T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  await writeFile(sessionFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await writeFile(
    join(sessions, "sessions.json"),
    JSON.stringify({
      "agent:main:main": { sessionId: "synthetic-session", updatedAt: 2, sessionFile },
    }),
  );
  await writeFile(
    join(source, "openclaw.json"),
    `{
    // This legacy roster and JSON5 syntax must survive selector projection.
    agents: { list: [{ id: 'main', default: true, workspace: ${JSON.stringify(workspace)},
      agentDir: ${JSON.stringify(agentDir)} }], defaults: { workspace: ${JSON.stringify(workspace)} } },
    session: { store: ${JSON.stringify(join(source, "..stores/{agentId}/sessions.json"))} },
    plugins: { load: { paths: [${JSON.stringify(plugin)}] } },
    logging: { file: ${JSON.stringify(log)} },
  }`,
  );
  await writeFile(
    join(source, ".env"),
    `OPENCLAW_CONFIG_PATH=${config}\nOPENCLAW_STATE_DIR=${external}\n`,
  );
  const legacy = join(root, "legacy-capability.mjs");
  await writeFile(
    legacy,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") console.log("synthetic-legacy");
else if (args.join(" ") === "sessions export-trajectory --help") process.exit(1);
else { console.error("Unexpected legacy fixture command"); process.exit(99); }
`,
  );
  await chmod(legacy, 0o700);
  const before = await snapshot(protectedRoot);
  const output = join(root, "output");
  const result = spawnSync(
    process.execPath,
    [
      resolve("dist/cli-main.js"),
      "export",
      "--openclaw",
      legacy,
      "--migrate-copy",
      "--legacy-state-dir",
      source,
      "--migration-openclaw",
      executable,
      "--session-key",
      "agent:main:main",
      "--output",
      output,
      "--timeout-ms",
      "90000",
      "--json",
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_HOME: home,
        ZDOTDIR: home,
        XDG_CONFIG_HOME: home,
        OPENCLAW_CONFIG_PATH: config,
      },
      encoding: "utf8",
      timeout: 360000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8"));
  const trajectory = JSON.parse(await readFile(join(output, "trajectory.json"), "utf8"));
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.root.sessionId, "synthetic-session");
  assert.match(receipt.source.openclawVersion, /2026\.9\.5/);
  assert.equal(
    receipt.legacyMigration.sourceFingerprintBefore,
    receipt.legacyMigration.sourceFingerprintAfter,
  );
  assert.deepEqual(
    receipt.legacyMigration.commands.map((command) => command.mode),
    [
      "config-validate",
      "inspect",
      "dry-run",
      "import",
      "validate",
      "inspect",
      "sessions-list-verify",
    ],
  );
  assert(trajectory.steps.some((step) => step.source === "user" && step.message === "Hello"));
  assert(trajectory.steps.some((step) => step.source === "agent" && step.message === "Hi"));
  assert.deepEqual(await snapshot(protectedRoot), before);
  for (const name of ["trajectory.json", "receipt.json"])
    assert.equal((await lstat(join(output, name))).mode & 0o777, 0o600);
  console.log(
    "Real OpenClaw 2026.9.5 migration and export passed; original fixture trees unchanged.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
