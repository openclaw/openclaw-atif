/* eslint-disable complexity -- Atomic recovery requires explicit transaction-state checks. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { asRecord } from "./json.js";
import { compareCodeUnits } from "./ordering.js";
import { readStableFile } from "./stable-file.js";

export class OutputConflictError extends Error {
  constructor(readonly path: string) {
    super(`Output already exists with different content: ${path}`);
    this.name = "OutputConflictError";
  }
}

export type OutputContent = string | Uint8Array;

export interface WriteResult {
  path: string;
  sha256: string;
  idempotent: boolean;
}

interface DirectoryTransaction {
  schema: "openclaw-atif-directory-transaction-v1";
  id: string;
  destination: string;
  backup: string;
  stage: string;
  files: Record<string, string>;
}

const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Export was interrupted", "AbortError");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode: 0o700 });
  if (created) await chmod(created, 0o700);
}

async function canonicalDestination(destination: string): Promise<string> {
  if (!destination) throw new Error("Output destination must not be empty");
  const absolute = resolve(destination);
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error("Output destination must not be a filesystem root");
  await ensureDirectory(parent);
  return join(await realpath(parent), basename(absolute));
}

async function readLock(path: string): Promise<string> {
  return (await readStableFile(() => Promise.resolve(path), 4096)).toString("utf8");
}

async function lockConflict(path: string): Promise<Error> {
  let owner = "unknown owner";
  try {
    const value = asRecord(JSON.parse(await readLock(path)) as unknown);
    if (Number.isSafeInteger(value?.pid) && typeof value?.startedAt === "string")
      owner = `PID ${String(value.pid)}, started ${value.startedAt}`;
  } catch {
    // An unreadable lock is contention, never permission to steal ownership.
  }
  return new Error(
    `Output is busy (${owner}); lock: ${path}. After verifying the owner has terminated, remove this exact lock and retry recovery.`,
  );
}

async function withOutputLock<T>(
  destination: string,
  action: (canonical: string) => Promise<T>,
): Promise<T> {
  const canonical = await canonicalDestination(destination);
  const path = `${canonical}.openclaw-atif.lock`;
  const record = JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw await lockConflict(path);
    throw error;
  }
  try {
    await handle.writeFile(record);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const outcome = await action(canonical).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    if ((await readLock(path)) !== record)
      throw new Error(`Output lock ownership changed; preserve the lock for recovery: ${path}`);
    await rm(path);
    await syncDirectory(dirname(canonical));
  } catch (error) {
    if (!outcome.ok)
      throw new AggregateError([outcome.error, error], "Output write and lock release failed");
    throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function writeFreshFile(path: string, content: OutputContent): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function sha256(content: OutputContent): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function writeAtomicFile(
  destination: string,
  content: string,
  force = false,
  signal?: AbortSignal,
): Promise<WriteResult> {
  throwIfAborted(signal);
  return withOutputLock(destination, async (canonical) => ({
    ...(await writeLockedFile(canonical, content, force, signal)),
    path: destination,
  }));
}

async function writeLockedFile(
  destination: string,
  content: string,
  force: boolean,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const parent = dirname(destination);
  await recoverDirectory(destination);
  const digest = sha256(content);
  if (await exists(destination)) {
    const details = await lstat(destination);
    if (!details.isFile() || details.isSymbolicLink()) throw new OutputConflictError(destination);
    const current = await readFile(destination, "utf8");
    if (current === content) {
      await chmod(destination, 0o600);
      return { path: destination, sha256: digest, idempotent: true };
    }
    if (!force) throw new OutputConflictError(destination);
  }

  const temporary = join(parent, `.${basename(destination)}.openclaw-atif-${randomUUID()}.tmp`);
  let committed = false;
  try {
    await writeFreshFile(temporary, content);
    throwIfAborted(signal);
    if (force) {
      if (await exists(destination)) {
        const details = await lstat(destination);
        if (!details.isFile() || details.isSymbolicLink())
          throw new OutputConflictError(destination);
      }
      await rename(temporary, destination);
    } else {
      // A hard link commits without replacing even a non-cooperating writer's file.
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new OutputConflictError(destination);
        throw error;
      }
      await rm(temporary);
    }
    committed = true;
    await syncDirectory(parent);
    return { path: destination, sha256: digest, idempotent: false };
  } finally {
    if (!committed && (await exists(temporary))) await rm(temporary, { force: true });
  }
}

function validOutputName(name: string): boolean {
  if (/^media\/[0-9a-f]{64}\.[a-z0-9]+$/.test(name)) return true;
  return (
    !!name &&
    name !== "." &&
    name !== ".." &&
    name !== "media" &&
    !/[\\/]/.test(name) &&
    !name.includes("\0")
  );
}

function validateOutputNames(files: ReadonlyMap<string, OutputContent>): void {
  for (const name of files.keys()) {
    if (!validOutputName(name)) {
      throw new Error(
        `ATIF output name must be one basename or a content-addressed media path: ${name}`,
      );
    }
  }
}

function fileHashes(files: ReadonlyMap<string, OutputContent>): Record<string, string> {
  return Object.fromEntries([...files].map(([name, content]) => [name, sha256(content)]));
}

async function secureExistingDirectory(
  destination: string,
  files: ReadonlyMap<string, OutputContent>,
): Promise<void> {
  await chmod(destination, 0o700);
  for (const name of files.keys()) await chmod(join(destination, name), 0o600);
  if ([...files.keys()].some((name) => name.startsWith("media/"))) {
    await chmod(join(destination, "media"), 0o700);
    await syncDirectory(join(destination, "media"));
  }
  await syncDirectory(destination);
  await syncDirectory(dirname(destination));
}

async function directoryMatchesHashes(
  destination: string,
  files: Readonly<Record<string, string>>,
): Promise<boolean> {
  if (!(await exists(destination))) return false;
  const destinationDetails = await lstat(destination);
  if (!destinationDetails.isDirectory() || destinationDetails.isSymbolicLink())
    throw new OutputConflictError(destination);
  const names = (await readdir(destination)).sort();
  const expected = [...new Set(Object.keys(files).map((name) => name.split("/")[0]))].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index]))
    return false;
  if (names.includes("media")) {
    const media = join(destination, "media");
    const details = await lstat(media);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new OutputConflictError(media);
    const actualMedia = (await readdir(media)).map((name) => `media/${name}`).sort();
    const expectedMedia = Object.keys(files)
      .filter((name) => name.startsWith("media/"))
      .sort();
    if (
      actualMedia.length !== expectedMedia.length ||
      actualMedia.some((name, i) => name !== expectedMedia[i])
    )
      return false;
  }
  for (const [name, digest] of Object.entries(files)) {
    const path = join(destination, name);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new OutputConflictError(path);
    if (sha256(await readFile(path)) !== digest) return false;
  }
  return true;
}

function transactionPath(destination: string): string {
  return `${destination}.openclaw-atif-transaction.json`;
}

// Every field and path must match before recovery can mutate a backup.
function isDirectoryTransaction(
  value: unknown,
  destination: string,
): value is DirectoryTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== "openclaw-atif-directory-transaction-v1" ||
    typeof record.id !== "string" ||
    !TRANSACTION_ID.test(record.id) ||
    record.destination !== destination ||
    typeof record.backup !== "string" ||
    typeof record.stage !== "string" ||
    !record.files ||
    typeof record.files !== "object" ||
    Array.isArray(record.files) ||
    Object.entries(record.files).some(
      ([name, digest]) =>
        !validOutputName(name) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest),
    )
  ) {
    return false;
  }
  const parent = dirname(destination);
  const prefix = `.${basename(destination)}.openclaw-atif-${record.id}`;
  return (
    dirname(record.backup) === parent &&
    dirname(record.stage) === parent &&
    basename(record.backup) === `${prefix}.backup` &&
    basename(record.stage) === `${prefix}.tmp`
  );
}

async function loadDirectoryTransaction(
  destination: string,
): Promise<DirectoryTransaction | undefined> {
  const path = transactionPath(destination);
  if (!(await exists(path))) return undefined;
  return readDirectoryTransaction(path, destination);
}

async function readDirectoryTransaction(
  path: string,
  destination: string,
  container?: string,
): Promise<DirectoryTransaction> {
  try {
    const content = await readStableFile(async () => {
      if (container) {
        const details = await lstat(container);
        if (
          !details.isDirectory() ||
          details.isSymbolicLink() ||
          (await realpath(container)) !== container
        )
          throw new OutputConflictError(container);
      }
      return path;
    }, 64 * 1024);
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (isDirectoryTransaction(parsed, destination)) return parsed;
    const record = asRecord(parsed);
    if (record) {
      // Older journals may name a parent alias. Resolve existing parents only;
      // the same destination, sibling names, and transaction ID must still match.
      const normalized = { ...record };
      for (const key of ["destination", "backup", "stage"]) {
        const value = record[key];
        if (typeof value !== "string") throw new OutputConflictError(path);
        normalized[key] = join(await realpath(dirname(value)), basename(value));
      }
      if (isDirectoryTransaction(normalized, destination)) return normalized;
    }
  } catch {
    // The path is not a transaction owned by openclaw-atif.
  }
  throw new OutputConflictError(path);
}

async function adoptLegacyDirectoryTransaction(destination: string): Promise<void> {
  const parent = dirname(destination);
  const prefix = `.${basename(destination)}.openclaw-atif-`;
  const containers: { path: string; backup: boolean }[] = [];
  if (await exists(destination)) containers.push({ path: destination, backup: false });
  for (const name of await readdir(parent)) {
    if (!name.startsWith(prefix) || !name.endsWith(".backup")) continue;
    if (TRANSACTION_ID.test(name.slice(prefix.length, -".backup".length)))
      containers.push({ path: join(parent, name), backup: true });
  }
  const candidates: { path: string; container: string; transaction: DirectoryTransaction }[] = [];
  for (const container of containers) {
    const details = await lstat(container.path);
    if (!details.isDirectory() || details.isSymbolicLink()) continue;
    const path = join(container.path, ".openclaw-atif-transaction.json");
    if (!(await exists(path))) continue;
    const transaction = await readDirectoryTransaction(path, destination, container.path);
    if (container.backup && transaction.backup !== container.path)
      throw new OutputConflictError(path);
    candidates.push({ path, container: container.path, transaction });
  }
  if (candidates.length === 0) return;
  const canonical = transactionPath(destination);
  if (candidates.length !== 1 || (await exists(canonical)))
    throw new OutputConflictError(canonical);
  const candidate = candidates[0];
  if (!candidate) return;
  // v0.1.1 stored trailing-slash journals inside the destination (then backup).
  // Adopt without replacement before recovery; ambiguous carriers are never cleaned.
  try {
    await link(candidate.path, canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new OutputConflictError(canonical);
    throw error;
  }
  await syncDirectory(parent);
  const adopted = await readDirectoryTransaction(canonical, destination);
  if (JSON.stringify(adopted) !== JSON.stringify(candidate.transaction))
    throw new OutputConflictError(canonical);
  await rm(candidate.path);
  await syncDirectory(candidate.container);
}

async function recoverDirectory(destination: string): Promise<void> {
  await adoptLegacyDirectoryTransaction(destination);
  const transaction = await loadDirectoryTransaction(destination);
  if (!transaction) return;
  const destinationExists = await exists(destination);
  const backupExists = await exists(transaction.backup);
  if (!destinationExists && backupExists) {
    await rename(transaction.backup, destination);
  } else if (destinationExists && backupExists) {
    if (!(await directoryMatchesHashes(destination, transaction.files))) {
      throw new OutputConflictError(destination);
    }
    await rm(transaction.backup, { recursive: true, force: true });
  }
  if (await exists(transaction.stage)) {
    await rm(transaction.stage, { recursive: true, force: true });
  }
  await rm(transactionPath(destination), { force: true });
  await syncDirectory(dirname(destination));
}

async function beginDirectoryTransaction(
  destination: string,
  stage: string,
  files: ReadonlyMap<string, OutputContent>,
): Promise<DirectoryTransaction> {
  const id = /\.openclaw-atif-([0-9a-f-]{36})\.tmp$/.exec(basename(stage))?.[1];
  if (!id) throw new Error(`Invalid openclaw-atif staging path: ${stage}`);
  const transaction: DirectoryTransaction = {
    schema: "openclaw-atif-directory-transaction-v1",
    id,
    destination,
    backup: join(dirname(destination), `.${basename(destination)}.openclaw-atif-${id}.backup`),
    stage,
    files: fileHashes(files),
  };
  await writeFreshFile(transactionPath(destination), `${JSON.stringify(transaction)}\n`);
  await syncDirectory(dirname(destination));
  return transaction;
}

// The transaction keeps recovery, replacement, and cleanup in one ordered operation.
export async function writeAtomicDirectory(
  destination: string,
  files: ReadonlyMap<string, OutputContent>,
  force = false,
  signal?: AbortSignal,
): Promise<WriteResult[]> {
  throwIfAborted(signal);
  validateOutputNames(files);
  return withOutputLock(destination, async (canonical) =>
    (await writeLockedDirectory(canonical, files, force, signal)).map((write) => ({
      ...write,
      path: join(destination, relative(canonical, write.path)),
    })),
  );
}

async function writeLockedDirectory(
  destination: string,
  files: ReadonlyMap<string, OutputContent>,
  force: boolean,
  signal?: AbortSignal,
): Promise<WriteResult[]> {
  const parent = dirname(destination);
  await recoverDirectory(destination);

  if (await directoryMatchesHashes(destination, fileHashes(files))) {
    await secureExistingDirectory(destination, files);
    return [...files].map(([name, content]) => ({
      path: join(destination, name),
      sha256: sha256(content),
      idempotent: true,
    }));
  }
  if ((await exists(destination)) && !force) throw new OutputConflictError(destination);

  const id = randomUUID();
  const stage = join(parent, `.${basename(destination)}.openclaw-atif-${id}.tmp`);
  let stageCommitted = false;
  let transaction: DirectoryTransaction | undefined;
  await mkdir(stage, { mode: 0o700 });
  try {
    const hasMedia = [...files.keys()].some((name) => name.startsWith("media/"));
    if (hasMedia) await mkdir(join(stage, "media"), { mode: 0o700 });
    for (const [name, content] of [...files].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      await writeFreshFile(join(stage, name), content);
    }
    if (hasMedia) await syncDirectory(join(stage, "media"));
    await syncDirectory(stage);
    throwIfAborted(signal);

    if (await exists(destination)) {
      if (await directoryMatchesHashes(destination, fileHashes(files))) {
        await secureExistingDirectory(destination, files);
        return [...files].map(([name, content]) => ({
          path: join(destination, name),
          sha256: sha256(content),
          idempotent: true,
        }));
      }
      if (!force) throw new OutputConflictError(destination);
      transaction = await beginDirectoryTransaction(destination, stage, files);
      await rename(destination, transaction.backup);
    }
    try {
      await rename(stage, destination);
      stageCommitted = true;
      await syncDirectory(parent);
    } catch (error) {
      if (transaction && !(await exists(destination)) && (await exists(transaction.backup))) {
        await rename(transaction.backup, destination);
      }
      await syncDirectory(parent);
      throw error;
    }
    if (transaction) {
      if (await exists(transaction.backup)) {
        await rm(transaction.backup, { recursive: true, force: true });
      }
      await rm(transactionPath(destination), { force: true });
      await syncDirectory(parent);
    }
    return [...files].map(([name, content]) => ({
      path: join(destination, name),
      sha256: sha256(content),
      idempotent: false,
    }));
  } finally {
    if (!stageCommitted && (await exists(stage))) await rm(stage, { recursive: true, force: true });
    if (transaction && (await exists(transactionPath(destination)))) {
      await recoverDirectory(destination);
    }
  }
}
