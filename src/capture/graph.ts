/* eslint-disable complexity -- Graph validation enumerates all contract failures. */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { asRecord, readNonBlankString } from "../json.js";
import type {
  BundleGraphManifest,
  CapturedFamily,
  RelationshipEvidence,
  RelationshipKind,
  SourceNode,
} from "../models/family.js";
import { loadOpenClawBundle } from "../openclaw/bundle-v1.js";
import { stableCompactStringify } from "../stable-json.js";
import { DEFAULT_PROFILE } from "../version.js";
import { extractSpawnEvidence, spawnMatchesBundle } from "./relationships.js";
import { restoreCaptureEvidence } from "./replay.js";

const RELATIONSHIP_KINDS = new Set<RelationshipKind>([
  "native-subagent",
  "acp-child",
  "visible-child",
  "fork",
  "rotation",
  "cron",
  "adopted",
  "unknown-child",
]);

export function parseBundleGraph(value: unknown): BundleGraphManifest {
  const record = asRecord(value);
  if (record?.schema !== "openclaw-atif-bundle-graph-v1")
    throw new Error("Unsupported bundle graph schema");
  const rootKey = readNonBlankString(record.rootKey);
  const openclawVersion = readNonBlankString(record.openclawVersion);
  if (!rootKey || !openclawVersion || !Array.isArray(record.nodes))
    throw new Error("Bundle graph is missing root identity or nodes");
  const nodes = record.nodes.map((value, index) => {
    const node = asRecord(value);
    const sessionKey = readNonBlankString(node?.sessionKey);
    const bundleDir = readNonBlankString(node?.bundleDir);
    const parentKey = readNonBlankString(node?.parentKey);
    const relationshipKind = readNonBlankString(node?.relationshipKind) as
      | RelationshipKind
      | undefined;
    const toolCallId = readNonBlankString(node?.toolCallId);
    if (!sessionKey || !bundleDir) throw new Error(`Bundle graph node ${String(index)} is invalid`);
    if (relationshipKind && !RELATIONSHIP_KINDS.has(relationshipKind))
      throw new Error(`Bundle graph node ${String(index)} has invalid relationshipKind`);
    return {
      sessionKey,
      bundleDir,
      ...(parentKey ? { parentKey } : {}),
      ...(relationshipKind ? { relationshipKind } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    };
  });
  return {
    schema: "openclaw-atif-bundle-graph-v1",
    rootKey,
    openclawVersion,
    profile: readNonBlankString(record.profile),
    nodes,
  };
}

async function resolveBundle(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath)) throw new Error("Bundle graph paths must be relative");
  const realRoot = await realpath(root);
  const candidate = await realpath(join(realRoot, relativePath));
  const location = relative(realRoot, candidate);
  if (location.split(sep).includes("..") || isAbsolute(location))
    throw new Error("Bundle graph path escaped bundle root");
  return candidate;
}

export async function loadCapturedFamilyFromGraph(
  graphPath: string,
  bundleRoot: string,
): Promise<CapturedFamily> {
  const value = JSON.parse(await readFile(graphPath, "utf8")) as unknown;
  const graph = parseBundleGraph(value);
  if (graph.nodes.length === 0 || graph.nodes.length > 128)
    throw new Error("Bundle graph has an invalid node count");
  const nodes = new Map<string, SourceNode>();
  const relationships: RelationshipEvidence[] = [];
  for (const graphNode of graph.nodes) {
    if (nodes.has(graphNode.sessionKey))
      throw new Error(`Duplicate bundle graph session: ${graphNode.sessionKey}`);
    const bundle = await loadOpenClawBundle(await resolveBundle(bundleRoot, graphNode.bundleDir));
    if (bundle.observedSessionKey && bundle.observedSessionKey !== graphNode.sessionKey)
      throw new Error(`Bundle graph key mismatch: ${graphNode.sessionKey}`);
    nodes.set(graphNode.sessionKey, {
      key: graphNode.sessionKey,
      sessionId: bundle.manifest.sessionId,
      row: {
        key: graphNode.sessionKey,
        sessionId: bundle.manifest.sessionId,
        ...(graphNode.relationshipKind ? { kind: graphNode.relationshipKind } : {}),
      },
      bundle,
    });
  }
  if (!nodes.has(graph.rootKey)) throw new Error("Bundle graph root is missing");
  for (const graphNode of graph.nodes) {
    if (!graphNode.parentKey) continue;
    const source = nodes.get(graphNode.sessionKey);
    const parent = nodes.get(graphNode.parentKey);
    if (!source || !parent)
      throw new Error(`Bundle graph parent is missing: ${graphNode.parentKey}`);
    const matchingEvidence = extractSpawnEvidence(parent.bundle.events).filter(
      (item) => item.childSessionKey === graphNode.sessionKey,
    );
    const spawn = graphNode.toolCallId
      ? matchingEvidence.find((item) => item.toolCallId === graphNode.toolCallId)
      : matchingEvidence.length === 1
        ? matchingEvidence[0]
        : undefined;
    if (graphNode.toolCallId && !spawn)
      throw new Error(
        `Bundle graph toolCallId is not proven by the parent bundle: ${graphNode.toolCallId}`,
      );
    const verifiedSpawn = spawn && spawnMatchesBundle(spawn, source.bundle) ? spawn : undefined;
    const relationship: RelationshipEvidence = {
      parentKey: graphNode.parentKey,
      childKey: graphNode.sessionKey,
      kind: graphNode.relationshipKind ?? "unknown-child",
      listing: true,
      ...(verifiedSpawn ? { spawn: verifiedSpawn } : {}),
    };
    source.parentKey = graphNode.parentKey;
    source.relationship = relationship;
    relationships.push(relationship);
  }
  const roots = [...nodes.values()].filter((node) => !node.parentKey);
  if (roots.length !== 1 || roots[0]?.key !== graph.rootKey)
    throw new Error("Bundle graph must have one declared root");
  const childrenByParent = new Map<string, string[]>();
  for (const relationship of relationships) {
    const children = childrenByParent.get(relationship.parentKey) ?? [];
    children.push(relationship.childKey);
    childrenByParent.set(relationship.parentKey, children);
  }
  const reachable = new Set<string>();
  const queue = [graph.rootKey];
  while (queue.length > 0) {
    const key = queue.shift();
    if (!key || reachable.has(key)) continue;
    reachable.add(key);
    queue.push(...(childrenByParent.get(key) ?? []));
  }
  if (reachable.size !== nodes.size)
    throw new Error("Bundle graph contains nodes that are not reachable from the root");
  const hash = createHash("sha256").update(stableCompactStringify(graph)).digest("hex");
  return restoreCaptureEvidence(
    {
      rootKey: graph.rootKey,
      openclawVersion: graph.openclawVersion,
      profile: graph.profile ?? DEFAULT_PROFILE,
      nodes,
      relationships,
      diagnostics: [],
      listingBeforeHash: hash,
      listingAfterHash: hash,
      stable: true,
    },
    asRecord(value)?.capture,
  );
}
