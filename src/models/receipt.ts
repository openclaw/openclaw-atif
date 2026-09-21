import type { AccountingEvidence } from "../accounting.js";
import type { Diagnostic } from "../diagnostics.js";

export interface MetricTotals {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  steps: number;
}

export interface ExportReceipt {
  schema: "openclaw-atif-receipt-v1";
  status: "complete" | "partial";
  source: {
    openclawVersion: string;
    openclawExecutableSha256?: string;
    bundleSchema: "openclaw-trajectory";
    bundleSchemaVersion: 1;
    redacted: true;
    profile: string;
    listingBeforeHash: string;
    listingAfterHash: string;
    stable: boolean;
  };
  root: { sessionKey: string; sessionId: string; trajectoryId: string };
  nodes: {
    sessionKey: string;
    sessionId: string;
    leafId: string | null;
    branchCoverage: "selected-active-leaf";
    generationCoverage: "public-exported-generation";
    sourceHashes: Record<string, string>;
    diagnostics: Diagnostic[];
  }[];
  relationships: {
    parentKey: string;
    childKey: string;
    kind: string;
    listing: boolean;
    toolCallId?: string;
    referenceStatus: "resolved" | "unresolved" | "not-applicable";
  }[];
  familyMetrics: MetricTotals;
  accounting?: AccountingEvidence;
  diagnostics: Diagnostic[];
  legacyMigration?: {
    sourceFingerprintBefore: string;
    sourceFingerprintAfter: string;
    commands: { mode: string; evidenceSha256: string }[];
  };
  validation: {
    localAtif: true;
    harbor: "not-run-runtime";
    harborConformanceCommit: string;
  };
  output: { trajectorySha256: string };
}
