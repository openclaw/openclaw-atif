/* eslint-disable complexity -- Export and cleanup states must remain explicit. */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapFamilyToAtif } from "./atif/mapper.js";
import { type AtifTrajectory, validateAtifTrajectory } from "./atif/schema.js";
import { captureOpenClawFamily } from "./capture/family.js";
import { loadCapturedFamilyFromGraph } from "./capture/graph.js";
import { type LegacyMigrationReceipt, prepareLegacyMigrationCopy } from "./legacy/migrate-copy.js";
import type { ExportReceipt } from "./models/receipt.js";
import { normalizeFamily } from "./normalize/family.js";
import { probeOpenClaw } from "./openclaw/capabilities.js";
import type { CommandOptions } from "./openclaw/process.js";
import { buildReceipt } from "./receipt.js";
import { stableStringify } from "./stable-json.js";
import { type OutputContent, type WriteResult, writeAtomicDirectory } from "./writer.js";

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(typeof value === "string" ? value : "Unknown export error");
}

export function combineExportErrors(primary: unknown, cleanup: unknown): Error | undefined {
  if (primary && cleanup) {
    const primaryError = errorFromUnknown(primary);
    const cleanupError = errorFromUnknown(cleanup);
    return new AggregateError(
      [primaryError, cleanupError],
      `Export failed: ${primaryError.message}; sensitive staging cleanup also failed: ${cleanupError.message}`,
    );
  }
  if (primary) return errorFromUnknown(primary);
  if (cleanup)
    return new Error(`Sensitive staging cleanup failed: ${errorFromUnknown(cleanup).message}`);
  return undefined;
}

export interface ExportResult {
  status: "complete" | "partial";
  trajectory: AtifTrajectory;
  receipt: ExportReceipt;
  writes: WriteResult[];
  sourceBundleRoot?: string;
}

export interface ExportOptions {
  executable: string;
  output: string;
  sessionKey?: string;
  sessionId?: string;
  stateDir?: string;
  profile?: string;
  retries?: number;
  maxNodes?: number;
  maxDepth?: number;
  requireComplete?: boolean;
  force?: boolean;
  keepSourceBundles?: boolean;
  migrateCopy?: boolean;
  legacyStateDir?: string;
  migrationExecutable?: string;
  command?: CommandOptions;
}

async function commitExport(params: {
  output: string;
  force?: boolean;
  requireComplete?: boolean;
  trajectory: AtifTrajectory;
  receipt: ExportReceipt;
  mediaFiles: ReadonlyMap<string, Buffer>;
  signal?: AbortSignal;
}): Promise<ExportResult> {
  validateAtifTrajectory(params.trajectory);
  if (params.requireComplete && params.receipt.status !== "complete")
    throw new Error("Export is partial and --require-complete was requested");
  const files = new Map<string, OutputContent>([
    ["trajectory.json", stableStringify(params.trajectory)],
    ["receipt.json", stableStringify(params.receipt)],
    ...params.mediaFiles,
  ]);
  const writes = await writeAtomicDirectory(
    params.output,
    files,
    params.force ?? false,
    params.signal,
  );
  return {
    status: params.receipt.status,
    trajectory: params.trajectory,
    receipt: params.receipt,
    writes,
  };
}

export async function exportOpenClawFamily(options: ExportOptions): Promise<ExportResult> {
  const stagingRoot = await mkdtemp(join(tmpdir(), ".openclaw-atif-"));
  await chmod(stagingRoot, 0o700);
  let result: ExportResult | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  let legacyCopyPath: string | undefined;
  try {
    let capability = await probeOpenClaw(options.executable, options.command);
    let executable = capability.executable;
    let stateDir = options.stateDir;
    let command = options.command;
    let legacyMigration: LegacyMigrationReceipt | undefined;
    if (!capability.trajectoryExport) {
      if (!options.migrateCopy || !options.legacyStateDir || !options.migrationExecutable) {
        throw new Error(
          "OpenClaw does not support public trajectory export; use explicit migration-on-copy inputs",
        );
      }
      const migrated = await prepareLegacyMigrationCopy({
        sourceStateDir: options.legacyStateDir,
        stagingRoot,
        executable: options.migrationExecutable,
        command: options.command,
      });
      executable = migrated.capability.executable;
      capability = migrated.capability;
      stateDir = migrated.stateDir;
      command = migrated.command;
      legacyCopyPath = migrated.cleanupRoot;
      legacyMigration = migrated.receipt;
    }
    const captured = await captureOpenClawFamily({
      executable,
      openclawVersion: capability.version,
      openclawExecutableSha256: capability.executableSha256,
      stagingRoot,
      sessionKey: options.sessionKey,
      sessionId: options.sessionId,
      stateDir,
      profile: options.profile,
      retries: options.retries,
      maxNodes: options.maxNodes,
      maxDepth: options.maxDepth,
      command,
    });
    const family = normalizeFamily(captured);
    const mapped = await mapFamilyToAtif(family);
    const receipt = buildReceipt({
      family,
      trajectory: mapped.trajectory,
      diagnostics: mapped.diagnostics,
      nodeMetrics: mapped.nodeMetrics,
      legacyMigration,
    });
    result = await commitExport({
      output: options.output,
      force: options.force,
      requireComplete: options.requireComplete,
      trajectory: mapped.trajectory,
      receipt,
      mediaFiles: mapped.mediaFiles,
      signal: options.command?.signal,
    });
    if (options.keepSourceBundles) result.sourceBundleRoot = stagingRoot;
  } catch (error) {
    primaryError = error;
  }
  if (legacyCopyPath) {
    try {
      await rm(legacyCopyPath, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!options.keepSourceBundles || !result) {
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  const finalError = combineExportErrors(primaryError, cleanupError);
  if (finalError) throw finalError;
  if (!result) throw new Error("OpenClaw export did not produce a result");
  return result;
}

export async function convertOpenClawBundles(options: {
  graph: string;
  bundleRoot: string;
  output: string;
  requireComplete?: boolean;
  force?: boolean;
  signal?: AbortSignal;
}): Promise<ExportResult> {
  const captured = await loadCapturedFamilyFromGraph(options.graph, options.bundleRoot);
  const family = normalizeFamily(captured);
  const mapped = await mapFamilyToAtif(family);
  const receipt = buildReceipt({
    family,
    trajectory: mapped.trajectory,
    diagnostics: mapped.diagnostics,
    nodeMetrics: mapped.nodeMetrics,
  });
  return commitExport({
    output: options.output,
    force: options.force,
    requireComplete: options.requireComplete,
    trajectory: mapped.trajectory,
    receipt,
    mediaFiles: mapped.mediaFiles,
    signal: options.signal,
  });
}
