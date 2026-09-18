/* eslint-disable complexity -- Completeness classification enumerates source cases. */
import { createHash } from "node:crypto";
import { type Diagnostic, deduplicateDiagnostics } from "../diagnostics.js";
import type { OpenClawBundleV1 } from "../models/bundle-v1.js";
import type { CapturedFamily, NormalizedNode, SessionFamilySnapshot } from "../models/family.js";
import { classifyRuntimeEvent } from "../models/runtime-events.js";
import { compareCodeUnits } from "../ordering.js";
import { stableCompactStringify } from "../stable-json.js";

const KNOWN_TRANSCRIPT_EVENTS = new Set([
  "user.message",
  "assistant.message",
  "tool.call",
  "tool.result",
  "session.compaction",
  "session.reset",
  "session.branch_summary",
  "session.custom",
  "session.custom_message",
  "session.thinking_level_change",
  "session.model_change",
  "session.label",
  "session.info",
]);
const VOLATILE_GENERATED_FILES = ["metadata.json", "artifacts.json", "prompts.json"] as const;

function semanticHash(value: unknown): string {
  return createHash("sha256").update(stableCompactStringify(value)).digest("hex");
}

function withoutGeneratedAt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([name]) => name !== "generatedAt"),
  );
}

function eventHasTruncationMarker(event: OpenClawBundleV1["events"][number]): boolean {
  const data = event.data;
  if (!data) return false;
  if (data.truncated === true || (typeof data.truncated === "number" && data.truncated > 0))
    return true;
  if (Array.isArray(data.droppedFields)) return data.droppedFields.length > 0;
  return typeof data.droppedFields === "number" && data.droppedFields > 0;
}

function deterministicSourceHashes(bundle: OpenClawBundleV1): Record<string, string> {
  const volatileFiles = new Set<string>(["manifest.json", ...VOLATILE_GENERATED_FILES]);
  const hashes = Object.fromEntries(
    Object.entries(bundle.sourceHashes).filter(([name]) => !volatileFiles.has(name)),
  );
  hashes["manifest.semantic-v1"] = semanticHash(withoutGeneratedAt(bundle.manifest));
  for (const name of VOLATILE_GENERATED_FILES) {
    const value = bundle.supplemental.get(name);
    if (value !== undefined)
      hashes[`${name}#semantic-v1`] = semanticHash(withoutGeneratedAt(value));
  }
  return hashes;
}

export function normalizeFamily(captured: CapturedFamily): SessionFamilySnapshot {
  const relationshipsByParent = new Map<string, typeof captured.relationships>();
  for (const relationship of captured.relationships) {
    const current = relationshipsByParent.get(relationship.parentKey) ?? [];
    current.push(relationship);
    relationshipsByParent.set(relationship.parentKey, current);
  }
  const nodes = new Map<string, NormalizedNode>();
  const familyDiagnostics: Diagnostic[] = [...captured.diagnostics];
  for (const [key, source] of captured.nodes) {
    const diagnostics: Diagnostic[] = [];
    const warningCodes = (source.bundle.manifest.warnings ?? []).map((warning) => warning.code);
    for (const warning of source.bundle.manifest.warnings ?? []) {
      diagnostics.push({
        code: `openclaw-${warning.code}`,
        message: warning.message,
        nodeKey: key,
        count: warning.count,
      });
    }
    if (source.bundle.manifest.runtimeEventCount === 0) {
      diagnostics.push({
        code: "runtime-capture-unavailable",
        message: "The public bundle contains no runtime events",
        nodeKey: key,
      });
    }
    if (source.bundle.events.some((event) => event.ts === "1970-01-01T00:00:00.000Z")) {
      diagnostics.push({
        code: "source-fallback-timestamp",
        message: "OpenClaw supplied an epoch fallback timestamp",
        nodeKey: key,
      });
    }
    for (const event of source.bundle.events) {
      if (eventHasTruncationMarker(event)) {
        diagnostics.push({
          code: "source-event-truncated",
          message: "OpenClaw marked source event fields as truncated or dropped",
          nodeKey: key,
          eventId: event.entryId,
        });
      }
      const runtimeKind = classifyRuntimeEvent(event);
      const known =
        event.source === "transcript"
          ? KNOWN_TRANSCRIPT_EVENTS.has(event.type)
          : event.source === "runtime" && runtimeKind !== "unknown";
      if (runtimeKind === "invalid") {
        diagnostics.push({
          code: "invalid-runtime-event",
          message: `The public bundle contains malformed data for ${event.type}`,
          nodeKey: key,
          eventId: event.entryId,
        });
      }
      if (!known) {
        diagnostics.push({
          code: `unsupported-${event.source}-event`,
          message: `The public bundle contains unsupported event type ${event.type}`,
          nodeKey: key,
          eventId: event.entryId,
        });
      }
    }
    const childRelationships = [...(relationshipsByParent.get(key) ?? [])].sort((left, right) =>
      compareCodeUnits(left.childKey, right.childKey),
    );
    for (const relationship of childRelationships) {
      if (!["native-subagent", "acp-child"].includes(relationship.kind)) {
        diagnostics.push({
          code: "relationship-not-represented-in-atif",
          message: `ATIF-v1.8 has no recursive embedding contract for ${relationship.kind}`,
          nodeKey: key,
        });
      }
      if (!relationship.spawn && ["native-subagent", "acp-child"].includes(relationship.kind)) {
        diagnostics.push({
          code: "subagent-reference-unresolved",
          message:
            "Listing lineage proves a child, but no exact sessions_spawn tool result is available",
          nodeKey: key,
        });
      }
    }
    nodes.set(key, {
      bundleDirectory: source.bundle.directory,
      key,
      sessionId: source.sessionId,
      leafId: source.bundle.manifest.leafId,
      row: source.row,
      transcriptEvents: source.bundle.events.filter((event) => event.source === "transcript"),
      runtimeEvents: source.bundle.events.filter((event) => event.source === "runtime"),
      exportEvents: source.bundle.events.filter((event) => event.source === "export"),
      childRelationships,
      bundleWarnings: warningCodes,
      sourceHashes: deterministicSourceHashes(source.bundle),
      diagnostics: deduplicateDiagnostics(diagnostics),
    });
    familyDiagnostics.push(...diagnostics);
  }
  if (!captured.stable) {
    familyDiagnostics.push({
      code: "family-not-stable",
      message: "The session family changed during capture",
    });
  }
  return {
    rootKey: captured.rootKey,
    openclawVersion: captured.openclawVersion,
    ...(captured.openclawExecutableSha256
      ? { openclawExecutableSha256: captured.openclawExecutableSha256 }
      : {}),
    profile: captured.profile,
    nodes,
    relationships: [...captured.relationships].sort((left, right) =>
      compareCodeUnits(
        `${left.parentKey}\u0000${left.childKey}`,
        `${right.parentKey}\u0000${right.childKey}`,
      ),
    ),
    diagnostics: deduplicateDiagnostics(familyDiagnostics),
    stable: captured.stable,
    listingBeforeHash: captured.listingBeforeHash,
    listingAfterHash: captured.listingAfterHash,
  };
}
