/* eslint-disable complexity -- Metric scope aggregation checks each optional field. */
import { createHash } from "node:crypto";
import { accountingEvidence, type NodeUsageSummary } from "./accounting.js";
import type { AtifFinalMetrics, AtifTrajectory } from "./atif/schema.js";
import { type Diagnostic, deduplicateDiagnostics } from "./diagnostics.js";
import type { LegacyMigrationReceipt } from "./legacy/migrate-copy.js";
import type { SessionFamilySnapshot } from "./models/family.js";
import type { ExportReceipt, MetricTotals } from "./models/receipt.js";
import { compareCodeUnits } from "./ordering.js";
import { stableStringify } from "./stable-json.js";
import { OPENCLAW_BUNDLE_SCHEMA, OPENCLAW_BUNDLE_VERSION } from "./version.js";

const HARBOR_CONFORMANCE_COMMIT = "74cc6312018c349c6bd2400c89a0ac4983ac1085";

function addMetrics(total: MetricTotals, metrics: AtifFinalMetrics): void {
  total.steps += metrics.total_steps ?? 0;
  if (metrics.total_prompt_tokens !== undefined)
    total.promptTokens = (total.promptTokens ?? 0) + metrics.total_prompt_tokens;
  if (metrics.total_completion_tokens !== undefined)
    total.completionTokens = (total.completionTokens ?? 0) + metrics.total_completion_tokens;
  if (metrics.total_cached_tokens !== undefined)
    total.cachedTokens = (total.cachedTokens ?? 0) + metrics.total_cached_tokens;
  if (metrics.total_cost_usd !== undefined)
    total.costUsd = (total.costUsd ?? 0) + metrics.total_cost_usd;
}

export function buildReceipt(params: {
  family: SessionFamilySnapshot;
  trajectory: AtifTrajectory;
  diagnostics: readonly Diagnostic[];
  nodeMetrics: ReadonlyMap<string, AtifFinalMetrics>;
  nodeUsage?: ReadonlyMap<string, NodeUsageSummary>;
  legacyMigration?: LegacyMigrationReceipt;
}): ExportReceipt {
  const root = params.family.nodes.get(params.family.rootKey);
  if (!root || !params.trajectory.trajectory_id)
    throw new Error("Cannot build receipt without root identity");
  const diagnostics = deduplicateDiagnostics(params.diagnostics);
  const familyMetrics: MetricTotals = { steps: 0 };
  for (const metrics of params.nodeMetrics.values()) addMetrics(familyMetrics, metrics);
  const unpricedUsage = [...params.nodeMetrics.values()].some(
    (metrics) =>
      metrics.total_cost_usd === undefined &&
      ((metrics.total_prompt_tokens ?? 0) > 0 || (metrics.total_completion_tokens ?? 0) > 0),
  );
  if (unpricedUsage) delete familyMetrics.costUsd;
  const trajectorySha256 = createHash("sha256")
    .update(stableStringify(params.trajectory))
    .digest("hex");
  return {
    schema: "openclaw-atif-receipt-v1",
    status: diagnostics.length === 0 && params.family.stable ? "complete" : "partial",
    source: {
      openclawVersion: params.family.openclawVersion,
      ...(params.family.openclawExecutableSha256
        ? { openclawExecutableSha256: params.family.openclawExecutableSha256 }
        : {}),
      bundleSchema: OPENCLAW_BUNDLE_SCHEMA,
      bundleSchemaVersion: OPENCLAW_BUNDLE_VERSION,
      redacted: true,
      profile: params.family.profile,
      listingBeforeHash: params.family.listingBeforeHash,
      listingAfterHash: params.family.listingAfterHash,
      stable: params.family.stable,
    },
    root: {
      sessionKey: root.key,
      sessionId: root.sessionId,
      trajectoryId: params.trajectory.trajectory_id,
    },
    nodes: [...params.family.nodes.values()]
      .sort((left, right) => compareCodeUnits(left.key, right.key))
      .map((node) => ({
        sessionKey: node.key,
        sessionId: node.sessionId,
        leafId: node.leafId,
        branchCoverage: "selected-active-leaf",
        generationCoverage: "public-exported-generation",
        sourceHashes: { ...node.sourceHashes },
        diagnostics: node.diagnostics,
      })),
    relationships: params.family.relationships.map((relationship) => ({
      parentKey: relationship.parentKey,
      childKey: relationship.childKey,
      kind: relationship.kind,
      listing: relationship.listing,
      ...(relationship.spawn ? { toolCallId: relationship.spawn.toolCallId } : {}),
      referenceStatus: ["native-subagent", "acp-child"].includes(relationship.kind)
        ? relationship.spawn?.eventId && params.family.nodes.has(relationship.childKey)
          ? "resolved"
          : "unresolved"
        : "not-applicable",
    })),
    familyMetrics,
    ...(params.nodeUsage ? { accounting: accountingEvidence(params.nodeUsage) } : {}),
    diagnostics,
    ...(params.legacyMigration ? { legacyMigration: params.legacyMigration } : {}),
    validation: {
      localAtif: true,
      harbor: "not-run-runtime",
      harborConformanceCommit: HARBOR_CONFORMANCE_COMMIT,
    },
    output: { trajectorySha256 },
  };
}
