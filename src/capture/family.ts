/* eslint-disable complexity -- Capture lifecycle states are kept in one bounded adapter. */
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { readNonBlankString } from "../json.js";
import type { SessionListing, SessionListingRow } from "../models/bundle-v1.js";
import type { CapturedFamily, RelationshipEvidence, SourceNode } from "../models/family.js";
import { loadOpenClawBundle } from "../openclaw/bundle-v1.js";
import { parseStructuredOutput } from "../openclaw/capabilities.js";
import { type CommandOptions, type CommandResult, runOpenClaw } from "../openclaw/process.js";
import { DEFAULT_PROFILE } from "../version.js";
import {
  type ExportableSessionListingRow,
  listingFingerprint,
  parseSessionListing,
  selectRoot,
} from "./listing.js";
import { discoverRelationships, spawnMatchesBundle } from "./relationships.js";

class CaptureRaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaptureRaceError";
  }
}

export interface CaptureOptions {
  executable: string;
  openclawVersion: string;
  openclawExecutableSha256?: string;
  stagingRoot: string;
  sessionKey?: string;
  sessionId?: string;
  stateDir?: string;
  profile?: string;
  retries?: number;
  maxNodes?: number;
  maxDepth?: number;
  command?: CommandOptions;
}

function commandEnvironment(
  stateDir: string | undefined,
  original = process.env,
): NodeJS.ProcessEnv {
  return stateDir ? { ...original, OPENCLAW_STATE_DIR: stateDir } : { ...original };
}

async function listSessions(options: CaptureOptions): Promise<SessionListing> {
  const result = await runOpenClaw(
    options.executable,
    ["sessions", "--all-agents", "--limit", "all", "--json"],
    { ...options.command, env: commandEnvironment(options.stateDir, options.command?.env) },
  );
  return parseSessionListing(parseStructuredOutput(result.stdout));
}

async function validateBundleDirectory(stagingRoot: string, value: string): Promise<string> {
  const root = await realpath(stagingRoot);
  const candidate = await realpath(isAbsolute(value) ? value : resolve(stagingRoot, value));
  const location = relative(root, candidate);
  if (!location || location.startsWith("..") || isAbsolute(location))
    throw new Error("OpenClaw returned an export directory outside private staging");
  const details = await lstat(candidate);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("OpenClaw returned an invalid export directory");
  return candidate;
}

async function exportNode(
  options: CaptureOptions,
  row: ExportableSessionListingRow,
  sequence: number,
  relationship?: RelationshipEvidence,
): Promise<SourceNode> {
  const outputName = `session-${String(sequence).padStart(4, "0")}`;
  let result: CommandResult;
  try {
    result = await runOpenClaw(
      options.executable,
      [
        "sessions",
        "export-trajectory",
        "--session-key",
        row.key,
        "--workspace",
        options.stagingRoot,
        "--output",
        outputName,
        "--json",
      ],
      { ...options.command, env: commandEnvironment(options.stateDir, options.command?.env) },
    );
  } catch (error) {
    throw new CaptureRaceError(`OpenClaw could not export session ${row.key}`, { cause: error });
  }
  const summary = parseStructuredOutput(result.stdout);
  const outputDir = readNonBlankString(summary.outputDir);
  const sessionId = readNonBlankString(summary.sessionId);
  if (!outputDir || !sessionId)
    throw new CaptureRaceError("OpenClaw export summary is missing outputDir or sessionId");
  if (sessionId !== row.sessionId)
    throw new CaptureRaceError(`OpenClaw exported a different session generation for ${row.key}`);
  const directory = await validateBundleDirectory(options.stagingRoot, outputDir);
  const bundle = await loadOpenClawBundle(directory);
  if (bundle.manifest.sessionId !== row.sessionId)
    throw new CaptureRaceError(`Bundle sessionId does not match listing for ${row.key}`);
  if (bundle.observedSessionKey && bundle.observedSessionKey !== row.key)
    throw new Error(`Bundle sessionKey does not match listing for ${row.key}`);
  if (relationship?.spawn && !spawnMatchesBundle(relationship.spawn, bundle))
    throw new CaptureRaceError(`Child generation evidence does not match ${row.key}`);
  return { key: row.key, sessionId: row.sessionId, row, bundle };
}

function relevantRows(listing: SessionListing, keys: ReadonlySet<string>): SessionListingRow[] {
  return listing.sessions.filter(
    (row) =>
      keys.has(row.key) ||
      (typeof row.parentSessionKey === "string" && keys.has(row.parentSessionKey)) ||
      (typeof row.spawnedBy === "string" && keys.has(row.spawnedBy)),
  );
}

async function captureAttempt(
  options: CaptureOptions,
  allowPartialChildRaces: boolean,
): Promise<CapturedFamily> {
  const before = await listSessions(options);
  const root = selectRoot(before, { sessionKey: options.sessionKey, sessionId: options.sessionId });
  const rowByKey = new Map(before.sessions.map((row) => [row.key, row]));
  const queue: {
    row: ExportableSessionListingRow;
    depth: number;
    parent?: RelationshipEvidence;
  }[] = [{ row: root, depth: 0 }];
  const nodes = new Map<string, SourceNode>();
  const relationships: RelationshipEvidence[] = [];
  const parentByChild = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  let exportSequence = 0;
  const maxNodes = options.maxNodes ?? 128;
  const maxDepth = options.maxDepth ?? 16;
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new Error("Session family maxNodes must be a positive integer");
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error("Session family maxDepth must be a non-negative integer");
  }
  while (queue.length > 0) {
    if (nodes.size >= maxNodes)
      throw new Error(`Session family exceeds node limit ${String(maxNodes)}`);
    const item = queue.shift();
    if (!item || nodes.has(item.row.key)) continue;
    if (item.depth > maxDepth)
      throw new Error(`Session family exceeds depth limit ${String(maxDepth)}`);
    let node: SourceNode;
    exportSequence += 1;
    try {
      node = await exportNode(options, item.row, exportSequence, item.parent);
    } catch (error) {
      if (error instanceof CaptureRaceError && item.parent && allowPartialChildRaces) {
        diagnostics.push({
          code: "child-export-unavailable",
          message: error.message,
          nodeKey: item.parent.parentKey,
        });
        continue;
      }
      throw error;
    }
    if (item.parent) {
      node.parentKey = item.parent.parentKey;
      node.relationship = item.parent;
    }
    nodes.set(node.key, node);
    const discovered = discoverRelationships({
      parent: item.row,
      rows: before.sessions,
      events: node.bundle.events,
    });
    for (const relationship of discovered) {
      if (relationship.childKey === item.row.key)
        throw new Error("Session family contains a self-link");
      if (relationship.childKey === root.key)
        throw new Error("Session family contains a cycle back to the root");
      const priorParent = parentByChild.get(relationship.childKey);
      if (priorParent && priorParent !== relationship.parentKey)
        throw new Error(`Session ${relationship.childKey} has multiple parents`);
      parentByChild.set(relationship.childKey, relationship.parentKey);
      relationships.push(relationship);
      const child = rowByKey.get(relationship.childKey);
      if (!child || typeof child.sessionId !== "string") {
        diagnostics.push({
          code: "child-session-missing",
          message:
            "A structured relationship references a session absent from the public listing or without a concrete session ID",
          nodeKey: item.row.key,
        });
        continue;
      }
      queue.push({
        row: child as ExportableSessionListingRow,
        depth: item.depth + 1,
        parent: relationship,
      });
    }
  }
  const after = await listSessions(options);
  const keys = new Set(nodes.keys());
  const beforeHash = listingFingerprint(relevantRows(before, keys));
  const afterHash = listingFingerprint(relevantRows(after, keys));
  return {
    rootKey: root.key,
    openclawVersion: options.openclawVersion,
    ...(options.openclawExecutableSha256
      ? { openclawExecutableSha256: options.openclawExecutableSha256 }
      : {}),
    profile: options.profile ?? DEFAULT_PROFILE,
    nodes,
    relationships: [
      ...new Map(
        relationships.map((relationship) => [
          `${relationship.parentKey}\u0000${relationship.childKey}`,
          relationship,
        ]),
      ).values(),
    ],
    diagnostics,
    listingBeforeHash: beforeHash,
    listingAfterHash: afterHash,
    stable: beforeHash === afterHash,
  };
}

export async function captureOpenClawFamily(options: CaptureOptions): Promise<CapturedFamily> {
  const retries = options.retries ?? 3;
  if (!Number.isSafeInteger(retries) || retries <= 0) {
    throw new Error("Capture retries must be a positive integer");
  }
  let last: CapturedFamily | undefined;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const attemptRoot = join(options.stagingRoot, `attempt-${String(attempt + 1)}`);
    await mkdir(attemptRoot, { recursive: false, mode: 0o700 });
    await chmod(attemptRoot, 0o700);
    try {
      last = await captureAttempt(
        { ...options, stagingRoot: attemptRoot },
        attempt === retries - 1,
      );
    } catch (error) {
      if (error instanceof CaptureRaceError && attempt < retries - 1) continue;
      throw error;
    }
    if (last.stable) return last;
  }
  if (!last) throw new Error("OpenClaw capture did not run");
  return last;
}
