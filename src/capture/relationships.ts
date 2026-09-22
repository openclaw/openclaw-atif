/* eslint-disable complexity -- Relationship evidence parsing is explicit and bounded. */
import { asRecord, readNonBlankString } from "../json.js";
import type { OpenClawBundleV1, SessionListingRow, TrajectoryEvent } from "../models/bundle-v1.js";
import type { RelationshipEvidence, RelationshipKind, SpawnEvidence } from "../models/family.js";
import { compareCodeUnits } from "../ordering.js";

const CHILD_FIELD_NAMES = new Set(["childSessionKey", "sessionKey"]);

function collectStructuredChildKeys(
  value: unknown,
  fieldName?: string,
  found = new Set<string>(),
): Set<string> {
  if (fieldName && CHILD_FIELD_NAMES.has(fieldName)) {
    const candidate = readNonBlankString(value);
    if (candidate) found.add(candidate);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredChildKeys(item, fieldName, found);
    return found;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, item] of Object.entries(record)) collectStructuredChildKeys(item, key, found);
  }
  return found;
}

function collectStructuredRunIds(
  value: unknown,
  fieldName?: string,
  found = new Set<string>(),
): Set<string> {
  if (fieldName === "runId") {
    const candidate = readNonBlankString(value);
    if (candidate) found.add(candidate);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredRunIds(item, fieldName, found);
    return found;
  }
  const record = asRecord(value);
  if (record) {
    for (const [key, item] of Object.entries(record)) collectStructuredRunIds(item, key, found);
  }
  return found;
}

function parseExactJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function toolResultPayload(message: Record<string, unknown>): unknown[] {
  const values: unknown[] = [message, message.details, parseExactJsonText(message.content)];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const record = asRecord(part);
      if (record?.type === "text") values.push(parseExactJsonText(record.text));
    }
  }
  return values;
}

function hasFailureMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFailureMarker);
  const record = asRecord(value);
  if (!record) return false;
  const status = readNonBlankString(record.status)?.toLowerCase();
  if (
    status &&
    ["error", "failed", "failure", "rejected", "cancelled", "aborted", "timeout"].includes(status)
  )
    return true;
  if (record.ok === false || record.success === false || record.isError === true) return true;
  if (
    record.error !== undefined &&
    record.error !== null &&
    record.error !== false &&
    record.error !== ""
  )
    return true;
  return Object.values(record).some(hasFailureMarker);
}

export function extractSpawnEvidence(events: readonly TrajectoryEvent[]): SpawnEvidence[] {
  const calls = new Map<string, { name: string; runtime?: string; visible?: boolean }>();
  for (const event of events) {
    if (event.source === "transcript" && event.type === "tool.call") {
      const id = readNonBlankString(event.data?.toolCallId);
      const name = readNonBlankString(event.data?.name);
      const argumentsRecord = asRecord(parseExactJsonText(event.data?.arguments));
      if (id && name) {
        const runtime = readNonBlankString(argumentsRecord?.runtime);
        const visible =
          typeof argumentsRecord?.visible === "boolean" ? argumentsRecord.visible : undefined;
        calls.set(id, {
          name,
          ...(runtime ? { runtime } : {}),
          ...(visible !== undefined ? { visible } : {}),
        });
      }
    }
  }
  const evidence: SpawnEvidence[] = [];
  for (const event of events) {
    if (event.source !== "transcript" || event.type !== "tool.result") continue;
    const message = asRecord(event.data?.message);
    if (!message) continue;
    const callId =
      readNonBlankString(message.toolCallId) ?? readNonBlankString(message.tool_call_id);
    if (!callId) continue;
    const call = calls.get(callId);
    const resultToolName = readNonBlankString(message.toolName);
    if (call?.name !== "sessions_spawn") continue;
    if (resultToolName && resultToolName !== call.name) continue;
    const payloads = toolResultPayload(message);
    if (payloads.some(hasFailureMarker)) continue;
    const children = new Set<string>();
    const runIds = new Set<string>();
    for (const payload of payloads) {
      collectStructuredChildKeys(payload, undefined, children);
      collectStructuredRunIds(payload, undefined, runIds);
    }
    const runId = runIds.size === 1 ? [...runIds][0] : undefined;
    for (const childSessionKey of children) {
      evidence.push({
        toolCallId: callId,
        childSessionKey,
        eventId: event.entryId,
        ...(runId ? { runId } : {}),
        ...(call.runtime ? { runtime: call.runtime } : {}),
        ...(call.visible !== undefined ? { visible: call.visible } : {}),
      });
    }
  }
  return [
    ...new Map(
      evidence.map((item) => [`${item.toolCallId}\u0000${item.childSessionKey}`, item]),
    ).values(),
  ].sort((left, right) =>
    compareCodeUnits(
      `${left.toolCallId}\u0000${left.childSessionKey}`,
      `${right.toolCallId}\u0000${right.childSessionKey}`,
    ),
  );
}

export function spawnMatchesBundle(spawn: SpawnEvidence, bundle: OpenClawBundleV1): boolean {
  return spawn.runId !== undefined && bundle.events.some((event) => event.runId === spawn.runId);
}

export function isAcpListingRow(row: SessionListingRow): boolean {
  const kind = (row.kind ?? row.sessionKind ?? "").toLowerCase();
  return (
    row.acpOwned === true ||
    row.acpRuntime === true ||
    (typeof row.acpRuntime === "object" && row.acpRuntime !== null) ||
    kind.includes("acp")
  );
}

export function classifyRelationship(
  row: SessionListingRow,
  evidence: { spawn?: SpawnEvidence; listing?: boolean } = {},
): RelationshipKind {
  const kind = (row.kind ?? row.sessionKind ?? "").toLowerCase();
  if (evidence.spawn?.visible === true || kind.includes("visible")) return "visible-child";
  if (evidence.spawn?.runtime === "acp" || (evidence.spawn !== undefined && isAcpListingRow(row)))
    return "acp-child";
  if (evidence.spawn) return "native-subagent";
  if (kind.includes("spawn") && evidence.listing === true)
    return isAcpListingRow(row) ? "acp-child" : "native-subagent";
  if (
    row.forkedFromParent === true ||
    (row.forkSource !== undefined && row.forkSource !== null) ||
    row.forkSourceSessionId ||
    kind.includes("fork")
  )
    return "fork";
  if (isAcpListingRow(row)) return "acp-child";
  if (kind.includes("cron")) return "cron";
  if (kind.includes("adopt")) return "adopted";
  if (kind.includes("subagent")) return "native-subagent";
  return "unknown-child";
}

export function discoverRelationships(params: {
  parent: SessionListingRow;
  rows: readonly SessionListingRow[];
  events: readonly TrajectoryEvent[];
}): RelationshipEvidence[] {
  const spawnByChild = new Map(
    extractSpawnEvidence(params.events).map((item) => [item.childSessionKey, item]),
  );
  const candidateKeys = new Set<string>();
  for (const row of params.rows) {
    if (row.parentSessionKey === params.parent.key || row.spawnedBy === params.parent.key)
      candidateKeys.add(row.key);
  }
  for (const key of spawnByChild.keys()) candidateKeys.add(key);
  const rowByKey = new Map(params.rows.map((row) => [row.key, row]));
  return [...candidateKeys].sort().map((childKey) => {
    const row = rowByKey.get(childKey);
    const listing =
      row !== undefined &&
      (row.parentSessionKey === params.parent.key || row.spawnedBy === params.parent.key);
    const spawn = spawnByChild.get(childKey);
    return {
      parentKey: params.parent.key,
      childKey,
      kind: row ? classifyRelationship(row, { spawn, listing }) : "unknown-child",
      listing,
      spawn,
    } satisfies RelationshipEvidence;
  });
}
