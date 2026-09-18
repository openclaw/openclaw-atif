/* eslint-disable complexity -- Legacy migration selects one of two documented OpenClaw command surfaces. */
import { createHash } from "node:crypto";
import { chmod, cp, lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseStructuredOutput } from "../openclaw/capabilities.js";
import { type CommandOptions, runOpenClaw } from "../openclaw/process.js";
import { compareCodeUnits } from "../ordering.js";
import { stableCompactStringify } from "../stable-json.js";

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

function isInside(root: string, target: string): boolean {
  const location = relative(root, target);
  return location === "" || (!location.startsWith("..") && !isAbsolute(location));
}

async function confineCopiedSessionStore(
  source: string,
  sourceArgument: string,
  destination: string,
): Promise<void> {
  const configPath = join(destination, "openclaw.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("OpenClaw config must be an object");
    config = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error("Legacy migration cannot safely inspect openclaw.json", { cause: error });
  }
  const session = config.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return;
  const sessionConfig = session as Record<string, unknown>;
  if (sessionConfig.store === undefined) return;
  if (typeof sessionConfig.store !== "string" || !isAbsolute(sessionConfig.store)) {
    throw new Error("Legacy session.store must be an absolute path inside the copied state");
  }
  const configuredStore = resolve(sessionConfig.store);
  const sourceRoot = isInside(source, configuredStore)
    ? source
    : isInside(sourceArgument, configuredStore)
      ? sourceArgument
      : undefined;
  if (sourceRoot) {
    sessionConfig.store = join(destination, relative(sourceRoot, configuredStore));
  } else if (!isInside(destination, configuredStore)) {
    throw new Error("Legacy session.store resolves outside the copied state");
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

export async function prepareLegacyMigrationCopy(params: {
  sourceStateDir: string;
  stagingRoot: string;
  executable: string;
  command?: CommandOptions;
}): Promise<{ stateDir: string; receipt: LegacyMigrationReceipt }> {
  const sourceArgument = resolve(params.sourceStateDir);
  const source = await realpath(sourceArgument);
  const details = await lstat(source);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Legacy source state must be a regular directory");
  await assertNoSymlinks(source);
  const before = await treeFingerprint(source);
  const destination = join(params.stagingRoot, "legacy-state-copy");
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
    preserveTimestamps: true,
  });
  await chmod(destination, 0o700);
  await assertNoSymlinks(destination);
  const afterCopy = await treeFingerprint(source);
  if (before !== afterCopy)
    throw new Error("Legacy source state changed while creating the migration copy");
  await confineCopiedSessionStore(source, sourceArgument, destination);
  const commands: LegacyMigrationReceipt["commands"] = [];
  const commandOptions = {
    ...params.command,
    env: { ...(params.command?.env ?? process.env), OPENCLAW_STATE_DIR: destination },
  };
  const help = await runOpenClaw(params.executable, ["doctor", "--help"], commandOptions);
  const targeted = `${help.stdout}\n${help.stderr}`.includes("--session-sqlite");
  const invocations: { mode: string; args: string[] }[] = targeted
    ? ["inspect", "dry-run", "import", "validate"].map((mode) => ({
        mode,
        args: ["doctor", "--session-sqlite", mode, "--session-sqlite-all-agents", "--json"],
      }))
    : [
        { mode: "fix", args: ["doctor", "--fix", "--non-interactive", "--yes"] },
        {
          mode: "sessions-list-verify",
          args: ["sessions", "--all-agents", "--limit", "all", "--json"],
        },
      ];
  for (const invocation of invocations) {
    const result = await runOpenClaw(params.executable, invocation.args, commandOptions);
    let sessionCount: number | undefined;
    if (invocation.mode === "sessions-list-verify") {
      const listing = parseStructuredOutput(result.stdout);
      if (!Array.isArray(listing.sessions)) {
        throw new Error("Migrated legacy copy did not produce a public session listing");
      }
      sessionCount = listing.sessions.length;
    }
    commands.push({
      mode: invocation.mode,
      evidenceSha256: digest(
        stableCompactStringify({
          mode: invocation.mode,
          status: "succeeded",
          ...(sessionCount !== undefined ? { sessionCount } : {}),
        }),
      ),
    });
  }
  const after = await treeFingerprint(source);
  if (before !== after) throw new Error("Legacy source state changed during migration-on-copy");
  return {
    stateDir: destination,
    receipt: { sourceFingerprintBefore: before, sourceFingerprintAfter: after, commands },
  };
}
