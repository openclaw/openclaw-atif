import { z } from "zod";
import { isPlainRecord } from "../json.js";
import { OPENCLAW_BUNDLE_SCHEMA, OPENCLAW_BUNDLE_VERSION } from "../version.js";

export const trajectoryEventSchema = z
  .object({
    traceSchema: z.literal(OPENCLAW_BUNDLE_SCHEMA),
    schemaVersion: z.literal(OPENCLAW_BUNDLE_VERSION),
    traceId: z.string().min(1),
    source: z.enum(["runtime", "transcript", "export"]),
    type: z.string().min(1),
    ts: z.string(),
    seq: z.number().int().positive(),
    sourceSeq: z.number().int().positive().optional(),
    sessionId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    workspaceDir: z.string().optional(),
    provider: z.string().optional(),
    modelId: z.string().optional(),
    modelApi: z.string().nullable().optional(),
    entryId: z.string().optional(),
    parentEntryId: z.string().nullable().optional(),
    data: z.custom<Record<string, unknown>>(isPlainRecord).optional(),
  })
  .loose();

export type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;

const bundleWarningSchema = z
  .object({
    source: z.enum(["session", "runtime"]),
    code: z.string().min(1),
    count: z.number().int().positive(),
    rows: z.array(z.number().int().positive()),
    message: z.string(),
  })
  .loose();

const bundleContentSchema = z
  .object({
    path: z.string().min(1),
    mediaType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const bundleManifestSchema = z
  .object({
    traceSchema: z.literal(OPENCLAW_BUNDLE_SCHEMA),
    schemaVersion: z.literal(OPENCLAW_BUNDLE_VERSION),
    generatedAt: z.string(),
    traceId: z.string().min(1),
    sessionId: z.string().min(1),
    sessionKey: z.string().min(1).optional(),
    workspaceDir: z.string(),
    leafId: z.string().nullable(),
    eventCount: z.number().int().nonnegative(),
    runtimeEventCount: z.number().int().nonnegative(),
    transcriptEventCount: z.number().int().nonnegative(),
    sourceFiles: z.object({ session: z.string(), runtime: z.string().optional() }).strict(),
    contents: z.array(bundleContentSchema).optional(),
    supplementalFiles: z.array(z.string()).optional(),
    warnings: z.array(bundleWarningSchema).optional(),
  })
  .loose();

export type BundleManifest = z.infer<typeof bundleManifestSchema>;

export interface OpenClawBundleV1 {
  directory: string;
  manifest: BundleManifest;
  observedSessionKey?: string;
  events: TrajectoryEvent[];
  sessionBranch: Record<string, unknown>;
  supplemental: ReadonlyMap<string, unknown>;
  sourceHashes: Readonly<Record<string, string>>;
}

export const sessionListingRowSchema = z
  .object({
    key: z.string().min(1),
    sessionId: z.string().min(1).nullish(),
    agentId: z.string().nullish(),
    updatedAt: z.number().nullish(),
    lastActivityAt: z.number().nullish(),
    status: z.string().nullish(),
    kind: z.string().nullish(),
    sessionKind: z.string().nullish(),
    parentSessionKey: z.string().nullish(),
    spawnedBy: z.string().nullish(),
    forkSourceSessionId: z.string().nullish(),
    forkSourceEntryId: z.string().nullish(),
    forkSource: z.unknown().optional(),
    forkedFromParent: z.boolean().nullish(),
    archivedAt: z.number().nullish(),
    agentHarnessId: z.string().nullish(),
    acpOwned: z.boolean().nullish(),
    acpRuntime: z.unknown().optional(),
    model: z.string().nullish(),
    modelProvider: z.string().nullish(),
  })
  .loose();

export type SessionListingRow = z.infer<typeof sessionListingRowSchema>;

export const sessionListingSchema = z
  .object({
    sessions: z.array(sessionListingRowSchema),
    count: z.number().int().nonnegative().optional(),
    totalCount: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
    limitApplied: z.union([z.number(), z.string(), z.null()]).optional(),
  })
  .loose();

export type SessionListing = z.infer<typeof sessionListingSchema>;
