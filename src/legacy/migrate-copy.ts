/* eslint-disable complexity -- Migration validates public preflight and result contracts before advancing. */
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { asRecord } from "../json.js";
import {
  type OpenClawCapability,
  parseStructuredOutput,
  probeOpenClaw,
} from "../openclaw/capabilities.js";
import { type CommandOptions, runOpenClaw } from "../openclaw/process.js";
import { compareCodeUnits } from "../ordering.js";
import { stableCompactStringify } from "../stable-json.js";
import { isInside, prepareMigrationRuntime } from "./config.js";

export interface LegacyMigrationReceipt {
  sourceFingerprintBefore: string;
  sourceFingerprintAfter: string;
  commands: { mode: string; evidenceSha256: string }[];
}

async function assertNoSymlinks(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink())
      throw new Error(`Legacy migration source contains a symlink: ${relative(root, path)}`);
    if (details.isDirectory()) await assertNoSymlinks(root, path);
  }
}

async function treeFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(current: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative(root, path);
      const details = await lstat(path);
      hash.update(
        `${entry.isDirectory() ? "d" : "f"}\u0000${name}\u0000${String(details.mode & 0o777)}\u0000`,
      );
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(await readFile(path));
      else throw new Error(`Unsupported legacy source entry: ${name}`);
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateMigrationReport(
  output: string,
  mode: string,
  destination: string,
  targets: Map<string, string>,
): void {
  const report = parseStructuredOutput(output);
  const totals = asRecord(report.totals);
  if (
    report.mode !== mode ||
    !Array.isArray(report.targets) ||
    totals?.targets !== report.targets.length ||
    totals.issues !== 0
  )
    throw new Error(`Invalid or failed OpenClaw session migration report: ${mode}`);
  for (const value of report.targets) {
    const target = asRecord(value);
    if (
      typeof target?.agentId !== "string" ||
      !Array.isArray(target.issues) ||
      target.issues.length !== 0
    )
      throw new Error("OpenClaw migration target has missing identity or reported issues");
    for (const key of ["storePath", "sqlitePath"]) {
      const path = target[key];
      if (typeof path !== "string" || !isAbsolute(path) || !isInside(destination, resolve(path)))
        throw new Error("OpenClaw migration target resolves outside the copied state");
    }
    const store = target.storePath as string;
    const sqlite = target.sqlitePath as string;
    const key = `${target.agentId}\0${store}`;
    const prior = targets.get(key);
    if (prior !== undefined && prior !== sqlite)
      throw new Error("OpenClaw migration target changed after preflight");
    targets.set(key, sqlite);
  }
}

export async function prepareLegacyMigrationCopy(params: {
  sourceStateDir: string;
  stagingRoot: string;
  executable: string;
  command?: CommandOptions;
}): Promise<{
  stateDir: string;
  cleanupRoot: string;
  command: CommandOptions;
  capability: OpenClawCapability;
  receipt: LegacyMigrationReceipt;
}> {
  const sourceArgument = resolve(params.sourceStateDir);
  const source = await realpath(sourceArgument);
  const details = await lstat(source);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Legacy source state must be a regular directory");
  await assertNoSymlinks(source);
  const before = await treeFingerprint(source);
  const cleanupRoot = join(params.stagingRoot, "legacy-migration");
  await mkdir(cleanupRoot, { mode: 0o700 });
  const copyPath = join(cleanupRoot, "state");
  await cp(source, copyPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const destination = await realpath(copyPath);
  await chmod(destination, 0o700);
  await assertNoSymlinks(destination);
  const afterCopy = await treeFingerprint(source);
  if (before !== afterCopy)
    throw new Error("Legacy source state changed while creating the migration copy");
  const { command: commandOptions, configPath } = await prepareMigrationRuntime({
    source,
    sourceArgument,
    destination,
    stagingRoot: cleanupRoot,
    command: params.command,
  });
  const capability = await probeOpenClaw(params.executable, commandOptions);
  if (!capability.trajectoryExport)
    throw new Error("Migration OpenClaw executable does not support public trajectory export");
  const commands: LegacyMigrationReceipt["commands"] = [];
  const validated = parseStructuredOutput(
    (await runOpenClaw(capability.executable, ["config", "validate", "--json"], commandOptions))
      .stdout,
  );
  if (validated.valid !== true || validated.path !== configPath)
    throw new Error("OpenClaw did not validate the private migration config");
  commands.push({ mode: "config-validate", evidenceSha256: digest("config-valid") });
  const help = await runOpenClaw(capability.executable, ["doctor", "--help"], commandOptions);
  const helpText = `${help.stdout}\n${help.stderr}`;
  if (!helpText.includes("--session-sqlite") || !helpText.includes("--session-sqlite-all-agents"))
    throw new Error(
      "Migration requires an OpenClaw version with targeted --session-sqlite and --session-sqlite-all-agents support",
    );
  const targets = new Map<string, string>();
  for (const mode of ["inspect", "dry-run", "import", "validate", "inspect"]) {
    const result = await runOpenClaw(
      capability.executable,
      ["doctor", "--session-sqlite", mode, "--session-sqlite-all-agents", "--json"],
      commandOptions,
    );
    validateMigrationReport(result.stdout, mode, destination, targets);
    commands.push({
      mode,
      evidenceSha256: digest(stableCompactStringify({ mode, status: "succeeded" })),
    });
  }
  const listing = parseStructuredOutput(
    (
      await runOpenClaw(
        capability.executable,
        ["sessions", "--all-agents", "--limit", "all", "--json"],
        commandOptions,
      )
    ).stdout,
  );
  if (!Array.isArray(listing.sessions))
    throw new Error("Migrated legacy copy did not produce a public session listing");
  commands.push({
    mode: "sessions-list-verify",
    evidenceSha256: digest(
      stableCompactStringify({
        mode: "sessions-list-verify",
        sessionCount: listing.sessions.length,
      }),
    ),
  });
  const after = await treeFingerprint(source);
  if (before !== after) throw new Error("Legacy source state changed during migration-on-copy");
  return {
    stateDir: destination,
    cleanupRoot,
    command: commandOptions,
    capability,
    receipt: { sourceFingerprintBefore: before, sourceFingerprintAfter: after, commands },
  };
}
