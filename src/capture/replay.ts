import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { sessionListingRowSchema } from "../models/bundle-v1.js";
import type { CapturedFamily } from "../models/family.js";
import { compareCodeUnits } from "../ordering.js";
import { stableCompactStringify, stableStringify } from "../stable-json.js";
import { extractSpawnEvidence } from "./relationships.js";

const diagnostic = z
  .object({
    code: z.string(),
    message: z.string(),
    nodeKey: z.string().optional(),
    eventId: z.string().optional(),
    count: z.number().int().positive().optional(),
  })
  .strict();
const replaySchema = z
  .object({
    schema: z.literal("openclaw-atif-capture-v1"),
    stable: z.boolean(),
    listingBeforeHash: z.string(),
    listingAfterHash: z.string(),
    openclawExecutableSha256: z.string().optional(),
    diagnostics: z.array(diagnostic),
    relationships: z.array(
      z
        .object({
          parentKey: z.string(),
          childKey: z.string(),
          kind: z.enum([
            "native-subagent",
            "acp-child",
            "visible-child",
            "fork",
            "rotation",
            "cron",
            "adopted",
            "unknown-child",
          ]),
          listing: z.boolean(),
          spawn: z
            .object({
              toolCallId: z.string(),
              childSessionKey: z.string(),
              eventId: z.string().optional(),
              runId: z.string().optional(),
              runtime: z.string().optional(),
              visible: z.boolean().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    nodes: z
      .array(
        z
          .object({
            row: sessionListingRowSchema,
            sourceHashes: z.record(z.string(), z.string()),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

/** Retain public capture evidence only, never migration state or private storage. */
export async function writeReplayGraph(family: CapturedFamily, bundleRoot: string): Promise<void> {
  const nodes = [...family.nodes.values()].sort((a, b) => compareCodeUnits(a.key, b.key));
  const graph = {
    schema: "openclaw-atif-bundle-graph-v1",
    rootKey: family.rootKey,
    openclawVersion: family.openclawVersion,
    profile: family.profile,
    nodes: nodes.map((node) => {
      const bundleDir = relative(bundleRoot, node.bundle.directory);
      if (!bundleDir || isAbsolute(bundleDir) || bundleDir.split(sep).includes(".."))
        throw new Error("Replay bundle escaped retained source root");
      return {
        sessionKey: node.key,
        bundleDir,
        ...(node.parentKey ? { parentKey: node.parentKey } : {}),
        ...(node.relationship ? { relationshipKind: node.relationship.kind } : {}),
        ...(node.relationship?.spawn ? { toolCallId: node.relationship.spawn.toolCallId } : {}),
      };
    }),
    capture: {
      schema: "openclaw-atif-capture-v1",
      stable: family.stable,
      listingBeforeHash: family.listingBeforeHash,
      listingAfterHash: family.listingAfterHash,
      ...(family.openclawExecutableSha256
        ? { openclawExecutableSha256: family.openclawExecutableSha256 }
        : {}),
      diagnostics: family.diagnostics,
      relationships: family.relationships,
      nodes: nodes.map((node) => ({ row: node.row, sourceHashes: node.bundle.sourceHashes })),
    },
  };
  await writeFile(join(bundleRoot, "graph.json"), stableStringify(graph), {
    mode: 0o600,
    flag: "wx",
  });
}

type ReplayEvidence = z.infer<typeof replaySchema>;

function restoreRows(family: CapturedFamily, capture: ReplayEvidence): void {
  const seen = new Set<string>();
  for (const item of capture.nodes) {
    const node = family.nodes.get(item.row.key);
    if (!node || seen.has(item.row.key) || item.row.sessionId !== node.sessionId)
      throw new Error("Replay capture node identity mismatch");
    seen.add(item.row.key);
    if (
      stableCompactStringify(item.sourceHashes) !== stableCompactStringify(node.bundle.sourceHashes)
    )
      throw new Error(`Replay source hash mismatch: ${item.row.key}`);
    node.row = item.row;
  }
  if (seen.size !== family.nodes.size) throw new Error("Replay capture node coverage mismatch");
}

function validateRelationships(family: CapturedFamily, capture: ReplayEvidence): void {
  for (const edge of capture.relationships) {
    const parent = family.nodes.get(edge.parentKey);
    if (!parent) throw new Error("Replay relationship parent missing");
    if (
      edge.spawn &&
      !extractSpawnEvidence(parent.bundle.events).some(
        (spawn) => stableCompactStringify(spawn) === stableCompactStringify(edge.spawn),
      )
    )
      throw new Error("Replay spawn is not proven by the parent bundle");
    if (
      family.nodes.has(edge.childKey) &&
      !family.relationships.some(
        (actual) =>
          actual.parentKey === edge.parentKey &&
          actual.childKey === edge.childKey &&
          actual.kind === edge.kind &&
          stableCompactStringify(actual.spawn ?? null) ===
            stableCompactStringify(edge.spawn ?? null),
      )
    )
      throw new Error("Replay relationship contradicts bundle graph");
  }
  if (
    family.relationships.some(
      (actual) =>
        !capture.relationships.some(
          (edge) => actual.parentKey === edge.parentKey && actual.childKey === edge.childKey,
        ),
    )
  )
    throw new Error("Replay relationship coverage mismatch");
}

export function restoreCaptureEvidence(family: CapturedFamily, value: unknown): CapturedFamily {
  if (value === undefined) return family;
  const capture = replaySchema.parse(value);
  restoreRows(family, capture);
  validateRelationships(family, capture);
  return {
    ...family,
    stable: capture.stable,
    listingBeforeHash: capture.listingBeforeHash,
    listingAfterHash: capture.listingAfterHash,
    diagnostics: capture.diagnostics,
    relationships: capture.relationships,
    ...(capture.openclawExecutableSha256
      ? { openclawExecutableSha256: capture.openclawExecutableSha256 }
      : {}),
  };
}
