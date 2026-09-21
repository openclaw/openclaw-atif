/* eslint-disable complexity -- Source-format dispatch is intentionally explicit. */
import { isAcpListingRow } from "../capture/relationships.js";
import type { Diagnostic } from "../diagnostics.js";
import {
  asRecord,
  type JsonObject,
  readFiniteNumber,
  readNonBlankString,
  readString,
  toJsonObject,
} from "../json.js";
import type { TrajectoryEvent } from "../models/bundle-v1.js";
import type {
  NormalizedNode,
  RelationshipEvidence,
  SessionFamilySnapshot,
} from "../models/family.js";
import { classifyRuntimeEvent } from "../models/runtime-events.js";
import { compareCodeUnits } from "../ordering.js";
import { ATIF_VERSION } from "../version.js";
import { trajectoryId } from "./identity.js";
import { MediaStore, mediaKind } from "./media.js";
import {
  type AtifAgent,
  type AtifContentPart,
  type AtifFinalMetrics,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
  validateAtifTrajectory,
} from "./schema.js";

export interface MappingResult {
  trajectory: AtifTrajectory;
  diagnostics: Diagnostic[];
  nodeMetrics: ReadonlyMap<string, AtifFinalMetrics>;
  mediaFiles: ReadonlyMap<string, Buffer>;
}

type StepState = {
  steps: AtifStep[];
  ownerByCallId: Map<string, AtifStep>;
  diagnostics: Diagnostic[];
  media: MediaStore;
  modelName?: string;
  reasoningEffort?: string;
};

async function contentParts(
  value: unknown,
  state: StepState,
  node: NormalizedNode,
  eventId?: string,
): Promise<string | AtifContentPart[]> {
  const { diagnostics } = state;
  const nodeKey = node.key;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: AtifContentPart[] = [];
  for (const block of value) {
    const item = asRecord(block);
    const type = readString(item?.type)?.toLowerCase();
    if (!item || !type) {
      diagnostics.push({
        code: "content-block-unsupported",
        message: "A content block without a supported type was omitted",
        nodeKey,
        eventId,
      });
      continue;
    }
    if (type === "text") {
      if (typeof item.text === "string") parts.push({ type: "text", text: item.text });
      else
        diagnostics.push({
          code: "content-block-unsupported",
          message: "A text content block without text was omitted",
          nodeKey,
          eventId,
        });
    }
    const kind = mediaKind(type);
    if (kind) {
      const part = await state.media.part(
        item,
        kind,
        node.bundleDirectory,
        diagnostics,
        nodeKey,
        eventId,
      );
      if (part) parts.push(part);
    }
    if (
      type !== "text" &&
      !kind &&
      !["reasoning", "thinking", "analysis", "toolcall", "tool_call"].includes(type)
    ) {
      diagnostics.push({
        code: "content-block-unsupported",
        message: `The ${type} content block was omitted`,
        nodeKey,
        eventId,
      });
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("");
  return parts;
}

function reasoningContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    const item = asRecord(block);
    const type = readString(item?.type)?.toLowerCase();
    if (!item || !type || !["reasoning", "thinking", "analysis"].includes(type)) continue;
    const text = readString(item.text) ?? readString(item.thinking) ?? readString(item.content);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function metricNumber(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function metricsFromMessage(message: Record<string, unknown>): AtifMetrics | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const input = metricNumber(usage.input);
  const output = metricNumber(usage.output);
  const cacheRead = metricNumber(usage.cacheRead);
  const cacheWrite = metricNumber(usage.cacheWrite);
  const costValue = asRecord(usage.cost)?.total ?? usage.cost;
  const cost = metricNumber(costValue);
  const metrics: AtifMetrics = {};
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined)
    metrics.prompt_tokens = Math.trunc((input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0));
  if (output !== undefined) metrics.completion_tokens = Math.trunc(output);
  if (cacheRead !== undefined) metrics.cached_tokens = Math.trunc(cacheRead);
  if (cost !== undefined) metrics.cost_usd = cost;
  if (cacheWrite !== undefined) metrics.extra = { cache_write_tokens: Math.trunc(cacheWrite) };
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function argumentsFrom(value: unknown): { arguments: JsonObject; extra?: JsonObject } {
  const object = toJsonObject(value);
  if (object) return { arguments: object };
  if (typeof value === "string") {
    try {
      const parsed = toJsonObject(JSON.parse(value) as unknown);
      if (parsed) return { arguments: parsed };
    } catch {
      // Preserve the exact unparsed value below.
    }
    return { arguments: {}, extra: { arguments_status: "unparsed", raw_arguments: value } };
  }
  return { arguments: {}, extra: { arguments_status: "unavailable" } };
}

function callsByAssistantEntry(
  events: readonly TrajectoryEvent[],
  node: NormalizedNode,
  state: StepState,
): Map<string, AtifToolCall[]> {
  const values = new Map<string, AtifToolCall[]>();
  for (const event of events) {
    if (event.type !== "tool.call") continue;
    const owner = readNonBlankString(event.data?.assistantEntryId) ?? event.entryId;
    if (!owner) {
      state.diagnostics.push({
        code: "tool-call-owner-unavailable",
        message: "A tool call has no owning assistant entry",
        nodeKey: node.key,
        eventId: event.entryId,
      });
      continue;
    }
    const id = readNonBlankString(event.data?.toolCallId);
    const name = readNonBlankString(event.data?.name);
    if (!id || !name) {
      state.diagnostics.push({
        code: "tool-call-identity-unavailable",
        message: "A tool call is missing its call ID or function name",
        nodeKey: node.key,
        eventId: event.entryId,
      });
      continue;
    }
    const converted = argumentsFrom(event.data?.arguments);
    const call: AtifToolCall = {
      tool_call_id: id,
      function_name: name,
      arguments: converted.arguments,
    };
    if (converted.extra) call.extra = converted.extra;
    const current = values.get(owner) ?? [];
    current.push(call);
    values.set(owner, current);
  }
  return values;
}

function modelName(message: Record<string, unknown>): string | undefined {
  const model = readNonBlankString(message.model);
  const provider = readNonBlankString(message.provider);
  if (!model) return undefined;
  return provider && !model.includes("/") ? `${provider}/${model}` : model;
}

function timestamp(event: TrajectoryEvent): string | undefined {
  const date = new Date(event.ts);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function pushStep(state: StepState, step: Omit<AtifStep, "step_id">): AtifStep {
  const value: AtifStep = { ...step, step_id: state.steps.length + 1 };
  state.steps.push(value);
  return value;
}

async function messageStep(
  event: TrajectoryEvent,
  node: NormalizedNode,
  state: StepState,
  calls: Map<string, AtifToolCall[]>,
): Promise<void> {
  const message = asRecord(event.data?.message);
  if (!message) {
    state.diagnostics.push({
      code: "message-event-invalid",
      message: "Message event has no message object",
      nodeKey: node.key,
      eventId: event.entryId,
    });
    return;
  }
  if (event.type === "user.message") {
    pushStep(state, {
      source: "user",
      message: await contentParts(message.content, state, node, event.entryId),
      ...(timestamp(event) ? { timestamp: timestamp(event) } : {}),
      extra: { openclaw: { entry_id: event.entryId ?? null, event_type: event.type } },
    });
    return;
  }
  if (event.type !== "assistant.message") return;
  const toolCalls = event.entryId ? calls.get(event.entryId) : undefined;
  const stepModel = modelName(message) ?? state.modelName;
  const reasoningEffort =
    readNonBlankString(message.thinkingLevel) ??
    readNonBlankString(message.reasoningEffort) ??
    state.reasoningEffort;
  const step = pushStep(state, {
    source: "agent",
    message: await contentParts(message.content, state, node, event.entryId),
    ...(timestamp(event) ? { timestamp: timestamp(event) } : {}),
    ...(stepModel ? { model_name: stepModel } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(reasoningContent(message.content)
      ? { reasoning_content: reasoningContent(message.content) }
      : {}),
    ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(metricsFromMessage(message) ? { metrics: metricsFromMessage(message) } : {}),
    // Transcript assistant entries can be local mirrors, not model calls.
    // The public bundle does not establish a per-entry LLM call count.
    extra: {
      openclaw: {
        entry_id: event.entryId ?? null,
        stop_reason: readString(message.stopReason) ?? null,
        error_message: readString(message.errorMessage) ?? null,
      },
    },
  });
  for (const call of toolCalls ?? []) {
    if (state.ownerByCallId.has(call.tool_call_id))
      state.diagnostics.push({
        code: "duplicate-tool-call-id",
        message: "Tool call ID was reused",
        nodeKey: node.key,
        eventId: event.entryId,
      });
    state.ownerByCallId.set(call.tool_call_id, step);
  }
}

async function resultContent(
  message: Record<string, unknown>,
  state: StepState,
  node: NormalizedNode,
  event: TrajectoryEvent,
): Promise<string | AtifContentPart[] | null> {
  const content = await contentParts(message.content, state, node, event.entryId);
  return Array.isArray(content) || content !== "" ? content : null;
}

function spawnResultKey(callId: string, eventId: string): string {
  return `${callId}\u0000${eventId}`;
}

async function resultStep(
  event: TrajectoryEvent,
  node: NormalizedNode,
  state: StepState,
  refsByCall: ReadonlyMap<string, AtifSubagentRefLike[]>,
): Promise<void> {
  const message = asRecord(event.data?.message);
  if (!message) return;
  const callId = readNonBlankString(message.toolCallId) ?? readNonBlankString(message.tool_call_id);
  const owner = callId ? state.ownerByCallId.get(callId) : undefined;
  const result: AtifObservationResult = {
    source_call_id: owner && callId ? callId : null,
    content: await resultContent(message, state, node, event),
    extra: {
      openclaw: {
        entry_id: event.entryId ?? null,
        tool_name: readString(message.toolName) ?? null,
        is_error: message.isError === true,
      },
    },
  };
  const refs =
    callId && event.entryId ? refsByCall.get(spawnResultKey(callId, event.entryId)) : undefined;
  if (refs && refs.length > 0) result.subagent_trajectory_ref = refs;
  if (owner) {
    owner.observation ??= { results: [] };
    owner.observation.results.push(result);
    return;
  }
  state.diagnostics.push({
    code: "orphan-tool-result",
    message: "Tool result has no matching assistant tool call",
    nodeKey: node.key,
    eventId: event.entryId,
  });
  pushStep(state, {
    source: "system",
    message: "",
    ...(timestamp(event) ? { timestamp: timestamp(event) } : {}),
    observation: { results: [result] },
    extra: { openclaw: { event_type: "tool.result", orphan: true } },
  });
}

type AtifSubagentRefLike = {
  trajectory_id?: string;
  session_id?: string;
  trajectory_path?: string;
  extra?: JsonObject;
};

async function contextStep(
  event: TrajectoryEvent,
  node: NormalizedNode,
  state: StepState,
): Promise<void> {
  const data = toJsonObject(event.data) ?? {};
  let message: string | AtifContentPart[] = "";
  if (event.type === "session.compaction" || event.type === "session.branch_summary")
    message = readString(event.data?.summary) ?? "";
  if (event.type === "session.custom_message") {
    message = await contentParts(event.data?.content, state, node, event.entryId);
  }
  if (event.type === "context.compiled") message = readString(event.data?.systemPrompt) ?? "";
  pushStep(state, {
    source: "system",
    message,
    ...(timestamp(event) ? { timestamp: timestamp(event) } : {}),
    extra: { openclaw: { event_type: event.type, entry_id: event.entryId ?? null, data } },
  });
}

function shouldMapSystemEvent(event: TrajectoryEvent): boolean {
  if (event.source === "runtime") return classifyRuntimeEvent(event) === "context";
  return (
    event.source === "transcript" &&
    [
      "session.compaction",
      "session.reset",
      "session.branch_summary",
      "session.custom",
      "session.custom_message",
      "session.thinking_level_change",
      "session.model_change",
      "session.label",
      "session.info",
    ].includes(event.type)
  );
}

function atifToolDefinition(value: unknown): JsonObject | undefined {
  const tool = asRecord(value);
  if (!tool) return undefined;
  const existingFunction = asRecord(tool.function);
  if (tool.type === "function" && readNonBlankString(existingFunction?.name))
    return toJsonObject(tool);
  const name = readNonBlankString(tool.name);
  if (!name) return undefined;
  const description = readString(tool.description);
  const parameters = toJsonObject(tool.parameters) ?? {};
  return {
    type: "function",
    function: {
      name,
      ...(description !== undefined ? { description } : {}),
      parameters,
    },
  };
}

function agentForNode(node: NormalizedNode, version: string): AtifAgent {
  const metadata = node.runtimeEvents.findLast((event) => event.type === "trace.metadata");
  const modelInfo = asRecord(metadata?.data?.model);
  const harness = asRecord(metadata?.data?.harness);
  const model = readNonBlankString(modelInfo?.name) ?? readNonBlankString(node.row.model);
  const provider =
    readNonBlankString(modelInfo?.provider) ?? readNonBlankString(node.row.modelProvider);
  const context = node.runtimeEvents.findLast((event) => event.type === "context.compiled");
  const tools = Array.isArray(context?.data?.tools)
    ? context.data.tools
        .map(atifToolDefinition)
        .filter((item): item is JsonObject => item !== undefined)
    : undefined;
  return {
    name: "openclaw",
    version: readNonBlankString(harness?.version) ?? version,
    ...(model
      ? { model_name: provider && !model.includes("/") ? `${provider}/${model}` : model }
      : {}),
    ...(tools && tools.length > 0 ? { tool_definitions: tools } : {}),
    extra: {
      source_bundle: "openclaw-trajectory-v1",
      source_redacted: true,
      trace_metadata: toJsonObject(metadata?.data) ?? {},
    },
  };
}

function finalMetrics(steps: readonly AtifStep[]): AtifFinalMetrics {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cost = 0;
  let observedPrompt = false;
  let observedCompletion = false;
  let observedCached = false;
  let observedCost = false;
  let unpricedUsage = false;
  for (const step of steps) {
    if (
      step.metrics?.cost_usd === undefined &&
      ((step.metrics?.prompt_tokens ?? 0) > 0 || (step.metrics?.completion_tokens ?? 0) > 0)
    )
      unpricedUsage = true;
    if (step.metrics?.prompt_tokens !== undefined) {
      prompt += step.metrics.prompt_tokens;
      observedPrompt = true;
    }
    if (step.metrics?.completion_tokens !== undefined) {
      completion += step.metrics.completion_tokens;
      observedCompletion = true;
    }
    if (step.metrics?.cached_tokens !== undefined) {
      cached += step.metrics.cached_tokens;
      observedCached = true;
    }
    if (step.metrics?.cost_usd !== undefined) {
      cost += step.metrics.cost_usd;
      observedCost = true;
    }
  }
  return {
    total_steps: steps.length,
    ...(observedPrompt ? { total_prompt_tokens: prompt } : {}),
    ...(observedCompletion ? { total_completion_tokens: completion } : {}),
    ...(observedCached ? { total_cached_tokens: cached } : {}),
    ...(observedCost && !unpricedUsage ? { total_cost_usd: cost } : {}),
    extra: { scope: "own-trajectory-only" },
  };
}

function runtimeProvenance(node: NormalizedNode): JsonObject {
  const counts = new Map<string, number>();
  const events: JsonObject[] = [];
  for (const event of [...node.runtimeEvents].sort((left, right) => left.seq - right.seq)) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
    if (classifyRuntimeEvent(event) !== "context") events.push(toJsonObject(event) ?? {});
  }
  return { event_type_counts: Object.fromEntries(counts), events };
}

async function buildNode(params: {
  family: SessionFamilySnapshot;
  node: NormalizedNode;
  visiting: Set<string>;
  diagnostics: Diagnostic[];
  nodeMetrics: Map<string, AtifFinalMetrics>;
  media: MediaStore;
}): Promise<AtifTrajectory> {
  if (params.visiting.has(params.node.key))
    throw new Error(`Session family contains a cycle at ${params.node.key}`);
  params.visiting.add(params.node.key);
  const childPairs = params.node.childRelationships
    .filter((relationship) => ["native-subagent", "acp-child"].includes(relationship.kind))
    .map((relationship) => ({
      relationship,
      child: params.family.nodes.get(relationship.childKey),
    }))
    .filter(
      (pair): pair is { relationship: RelationshipEvidence; child: NormalizedNode } =>
        pair.child !== undefined,
    )
    .sort((left, right) => compareCodeUnits(left.child.key, right.child.key));
  const children: AtifTrajectory[] = [];
  for (const { child } of childPairs) {
    children.push(await buildNode({ ...params, node: child }));
  }
  const childTrajectoryByKey = new Map(
    childPairs.map((pair, index) => [pair.child.key, children[index]]),
  );
  const refsByCall = new Map<string, AtifSubagentRefLike[]>();
  for (const relationship of params.node.childRelationships) {
    const child = childTrajectoryByKey.get(relationship.childKey);
    if (!relationship.spawn?.eventId || !child?.trajectory_id) continue;
    const key = spawnResultKey(relationship.spawn.toolCallId, relationship.spawn.eventId);
    const refs = refsByCall.get(key) ?? [];
    refs.push({
      trajectory_id: child.trajectory_id,
      session_id: child.session_id,
      extra: { relationship_kind: relationship.kind },
    });
    refsByCall.set(key, refs);
  }
  const agent = agentForNode(params.node, params.family.openclawVersion);
  const state: StepState = {
    steps: [],
    ownerByCallId: new Map(),
    diagnostics: [],
    media: params.media,
  };
  const calls = callsByAssistantEntry(params.node.transcriptEvents, params.node, state);
  const events = [
    ...params.node.runtimeEvents,
    ...params.node.transcriptEvents,
    ...params.node.exportEvents,
  ].sort((left, right) => left.seq - right.seq);
  for (const event of events) {
    if (event.source === "runtime" && event.type === "trace.metadata") {
      const modelInfo = asRecord(event.data?.model);
      const model = readNonBlankString(modelInfo?.name);
      const provider = readNonBlankString(modelInfo?.provider);
      if (model)
        state.modelName = provider && !model.includes("/") ? `${provider}/${model}` : model;
    }
    if (event.source === "transcript" && event.type === "session.model_change") {
      const model = readNonBlankString(event.data?.modelId);
      const provider = readNonBlankString(event.data?.provider);
      if (model)
        state.modelName = provider && !model.includes("/") ? `${provider}/${model}` : model;
    }
    if (event.source === "transcript" && event.type === "session.thinking_level_change") {
      const effort = readNonBlankString(event.data?.thinkingLevel);
      if (effort) state.reasoningEffort = effort;
    }
    if (
      event.source === "transcript" &&
      (event.type === "user.message" || event.type === "assistant.message")
    )
      await messageStep(event, params.node, state, calls);
    else if (event.source === "transcript" && event.type === "tool.result")
      await resultStep(event, params.node, state, refsByCall);
    else if (shouldMapSystemEvent(event)) await contextStep(event, params.node, state);
  }
  if (state.steps.length === 0) {
    pushStep(state, {
      source: "system",
      message: "",
      extra: { openclaw: { empty_session: true } },
    });
    state.diagnostics.push({
      code: "session-has-no-mapped-steps",
      message: "The public bundle had no mappable steps",
      nodeKey: params.node.key,
    });
  }
  params.diagnostics.push(...state.diagnostics);
  params.visiting.delete(params.node.key);
  const metrics = finalMetrics(state.steps);
  params.nodeMetrics.set(params.node.key, metrics);
  const otherRelationships = params.node.childRelationships.filter(
    (relationship) => !["native-subagent", "acp-child"].includes(relationship.kind),
  );
  return {
    schema_version: ATIF_VERSION,
    session_id: params.node.sessionId,
    trajectory_id: trajectoryId({
      sessionKey: params.node.key,
      sessionId: params.node.sessionId,
      leafId: params.node.leafId,
      profile: params.family.profile,
    }),
    agent,
    steps: state.steps,
    final_metrics: metrics,
    extra: {
      openclaw: {
        session_key: params.node.key,
        session_id: params.node.sessionId,
        leaf_id: params.node.leafId,
        source_redacted: true,
        wrapper_only: isAcpListingRow(params.node.row),
        bundle_warning_codes: params.node.bundleWarnings,
        runtime: runtimeProvenance(params.node),
        relationships: otherRelationships.map((relationship) => ({
          child_key: relationship.childKey,
          kind: relationship.kind,
          listing: relationship.listing,
        })),
      },
    },
    ...(children.length > 0 ? { subagent_trajectories: children } : {}),
  };
}

export async function mapFamilyToAtif(family: SessionFamilySnapshot): Promise<MappingResult> {
  const root = family.nodes.get(family.rootKey);
  if (!root) throw new Error("Session family root is missing");
  const diagnostics: Diagnostic[] = [...family.diagnostics];
  const nodeMetrics = new Map<string, AtifFinalMetrics>();
  const media = new MediaStore();
  const trajectory = await buildNode({
    family,
    node: root,
    visiting: new Set(),
    diagnostics,
    nodeMetrics,
    media,
  });
  for (const node of [...family.nodes.values()].sort((a, b) => compareCodeUnits(a.key, b.key))) {
    if (nodeMetrics.has(node.key)) continue;
    await buildNode({
      family,
      node,
      visiting: new Set(),
      diagnostics,
      nodeMetrics,
      media: new MediaStore(),
    });
  }
  validateAtifTrajectory(trajectory);
  return { trajectory, diagnostics, nodeMetrics, mediaFiles: media.files };
}
