import type { Diagnostic } from "../diagnostics.js";
import type { OpenClawBundleV1, SessionListingRow, TrajectoryEvent } from "./bundle-v1.js";

export type RelationshipKind =
  | "native-subagent"
  | "acp-child"
  | "visible-child"
  | "fork"
  | "rotation"
  | "cron"
  | "adopted"
  | "unknown-child";

export interface SpawnEvidence {
  toolCallId: string;
  childSessionKey: string;
  eventId?: string;
  runId?: string;
  runtime?: string;
  visible?: boolean;
}

export interface RelationshipEvidence {
  parentKey: string;
  childKey: string;
  kind: RelationshipKind;
  listing: boolean;
  spawn?: SpawnEvidence;
}

export interface SourceNode {
  key: string;
  sessionId: string;
  row: SessionListingRow;
  bundle: OpenClawBundleV1;
  parentKey?: string;
  relationship?: RelationshipEvidence;
}

export interface CapturedFamily {
  rootKey: string;
  openclawVersion: string;
  openclawExecutableSha256?: string;
  profile: string;
  nodes: ReadonlyMap<string, SourceNode>;
  relationships: RelationshipEvidence[];
  diagnostics: Diagnostic[];
  listingBeforeHash: string;
  listingAfterHash: string;
  stable: boolean;
}

export interface NormalizedNode {
  bundleDirectory: string;
  key: string;
  sessionId: string;
  leafId: string | null;
  row: SessionListingRow;
  transcriptEvents: TrajectoryEvent[];
  runtimeEvents: TrajectoryEvent[];
  exportEvents: TrajectoryEvent[];
  childRelationships: RelationshipEvidence[];
  bundleWarnings: string[];
  sourceHashes: Readonly<Record<string, string>>;
  diagnostics: Diagnostic[];
}

export interface SessionFamilySnapshot {
  rootKey: string;
  openclawVersion: string;
  openclawExecutableSha256?: string;
  profile: string;
  nodes: ReadonlyMap<string, NormalizedNode>;
  relationships: RelationshipEvidence[];
  diagnostics: Diagnostic[];
  stable: boolean;
  listingBeforeHash: string;
  listingAfterHash: string;
}

export interface BundleGraphNode {
  sessionKey: string;
  bundleDir: string;
  parentKey?: string;
  relationshipKind?: RelationshipKind;
  toolCallId?: string;
}

export interface BundleGraphManifest {
  schema: "openclaw-atif-bundle-graph-v1";
  rootKey: string;
  openclawVersion: string;
  profile?: string;
  nodes: BundleGraphNode[];
}
