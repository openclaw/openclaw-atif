/* eslint-disable complexity -- Integration assertions inspect a recursive trajectory. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapFamilyToAtif } from "../src/atif/mapper.js";
import { loadCapturedFamilyFromGraph } from "../src/capture/graph.js";
import { normalizeFamily } from "../src/normalize/family.js";
import { childEvents, event, rootEvents, writeBundle } from "./helpers.js";

async function buildFamily(
  options: {
    listingOnly?: boolean;
    childKey?: string;
    replayedResult?: boolean;
    relationshipKind?: "native-subagent" | "acp-child" | "visible-child";
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-atif-map-"));
  const childKey = options.childKey ?? "agent:main:subagent:child";
  const rootSourceEvents = rootEvents("root-session", childKey).filter(
    (item) => !options.listingOnly || item.type !== "tool.result",
  );
  if (options.replayedResult) {
    rootSourceEvents.push(
      event({
        seq: rootSourceEvents.length + 1,
        source: "transcript",
        type: "tool.result",
        sessionId: "root-session",
        entryId: "replayed-result",
        data: {
          message: {
            toolCallId: "call-1",
            toolName: "sessions_spawn",
            content: JSON.stringify({ status: "error", error: "late replay" }),
          },
        },
      }),
    );
  }
  await writeBundle({
    root,
    name: "root",
    sessionId: "root-session",
    sessionKey: "agent:main:main",
    events: rootSourceEvents.map((item, index) => ({ ...item, seq: index + 1 })),
  });
  await writeBundle({
    root,
    name: "child",
    sessionId: "child-session",
    sessionKey: childKey,
    events: childEvents(),
  });
  const graph = {
    schema: "openclaw-atif-bundle-graph-v1",
    rootKey: "agent:main:main",
    openclawVersion: "2026.8.1",
    nodes: [
      { sessionKey: "agent:main:main", bundleDir: "root" },
      {
        sessionKey: childKey,
        bundleDir: "child",
        parentKey: "agent:main:main",
        relationshipKind:
          options.relationshipKind ??
          (childKey.includes(":acp:") ? "acp-child" : "native-subagent"),
        ...(options.listingOnly ? {} : { toolCallId: "call-1" }),
      },
    ],
  };
  const graphPath = join(root, "graph.json");
  await writeFile(graphPath, JSON.stringify(graph));
  return normalizeFamily(await loadCapturedFamilyFromGraph(graphPath, root));
}

describe("mapFamilyToAtif", () => {
  it("omits unobserved LLM call counts for ordinary and locally mirrored assistants", async () => {
    const family = await buildFamily();
    const root = family.nodes.get(family.rootKey);
    if (!root) throw new Error("fixture root is missing");
    root.transcriptEvents.push(
      event({
        seq: 100,
        source: "transcript",
        type: "assistant.message",
        sessionId: root.sessionId,
        entryId: "delivery-mirror",
        data: {
          message: {
            role: "assistant",
            provider: "openclaw",
            model: "delivery-mirror",
            content: "Delivered locally.",
            usage: { input: 0, output: 0, cost: { total: 0 } },
          },
        },
      }),
    );
    const { trajectory } = await mapFamilyToAtif(family);
    const assistants = trajectory.steps.filter((step) => step.source === "agent");
    expect(assistants).toHaveLength(2);
    expect(assistants.map((step) => step.message)).toContain("Delivered locally.");
    for (const step of assistants) expect(step).not.toHaveProperty("llm_call_count");
    for (const step of trajectory.subagent_trajectories?.[0]?.steps ?? [])
      expect(step).not.toHaveProperty("llm_call_count");
  });

  it("maps a recursive subagent family with deterministic IDs and own metrics", async () => {
    const first = await mapFamilyToAtif(await buildFamily());
    const second = await mapFamilyToAtif(await buildFamily());
    expect(first.trajectory.trajectory_id).toBe(second.trajectory.trajectory_id);
    const child = first.trajectory.subagent_trajectories?.[0];
    expect(child?.session_id).toBe("child-session");
    expect(child?.trajectory_id).not.toBe(first.trajectory.trajectory_id);
    const spawnStep = first.trajectory.steps.find((step) =>
      step.tool_calls?.some((call) => call.tool_call_id === "call-1"),
    );
    expect(spawnStep?.observation?.results[0]?.subagent_trajectory_ref?.[0]?.trajectory_id).toBe(
      child?.trajectory_id,
    );
    expect(first.trajectory.final_metrics?.total_prompt_tokens).toBe(13);
    expect(child?.final_metrics?.total_prompt_tokens).toBe(3);
    expect(first.trajectory.final_metrics?.total_prompt_tokens).not.toBe(15);
  });

  it("reports metrics for captured nodes that ATIF does not recursively embed", async () => {
    const result = await mapFamilyToAtif(await buildFamily({ relationshipKind: "visible-child" }));
    expect(result.trajectory.subagent_trajectories).toBeUndefined();
    expect(result.nodeMetrics.size).toBe(2);
    expect(result.nodeMetrics.get("agent:main:subagent:child")?.total_prompt_tokens).toBe(3);
  });

  it("attaches a subagent reference only to the proven result event", async () => {
    const result = await mapFamilyToAtif(await buildFamily({ replayedResult: true }));
    const results = result.trajectory.steps.flatMap((step) => step.observation?.results ?? []);
    expect(results.filter((item) => item.subagent_trajectory_ref !== undefined)).toHaveLength(1);
    expect(results.at(-1)?.subagent_trajectory_ref).toBeUndefined();
  });

  it("embeds listing-only children without fabricating a tool reference", async () => {
    const result = await mapFamilyToAtif(await buildFamily({ listingOnly: true }));
    const spawnStep = result.trajectory.steps.find((step) => step.tool_calls?.length);
    expect(spawnStep?.observation?.results[0]?.subagent_trajectory_ref).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "subagent-reference-unresolved")).toBe(
      true,
    );
  });

  it("labels ACP children without claiming upstream internals", async () => {
    const result = await mapFamilyToAtif(await buildFamily({ childKey: "agent:main:acp:child" }));
    const reference = result.trajectory.steps
      .flatMap((step) => step.observation?.results ?? [])
      .flatMap((item) => item.subagent_trajectory_ref ?? [])[0];
    expect(reference?.extra?.relationship_kind).toBe("acp-child");
  });

  it("keeps orphan tool results source-less", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-orphan-"));
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "tool.result",
        sessionId: "session",
        entryId: "orphan",
        data: {
          message: {
            role: "toolResult",
            toolCallId: "missing",
            toolName: "read",
            content: "result",
          },
        },
      }),
    ];
    await writeBundle({
      root,
      name: "bundle",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events,
    });
    const graphPath = join(root, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify({
        schema: "openclaw-atif-bundle-graph-v1",
        rootKey: "agent:main:main",
        openclawVersion: "test",
        nodes: [{ sessionKey: "agent:main:main", bundleDir: "bundle" }],
      }),
    );
    const result = await mapFamilyToAtif(
      normalizeFamily(await loadCapturedFamilyFromGraph(graphPath, root)),
    );
    expect(result.trajectory.steps[0]?.observation?.results[0]?.source_call_id).toBeNull();
    expect(result.diagnostics.some((item) => item.code === "orphan-tool-result")).toBe(true);
  });

  it("does not invent prose for empty content", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-empty-"));
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "user.message",
        sessionId: "session",
        entryId: "u",
        data: { message: { role: "user", content: [] } },
      }),
    ];
    await writeBundle({
      root,
      name: "bundle",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events,
    });
    const graphPath = join(root, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify({
        schema: "openclaw-atif-bundle-graph-v1",
        rootKey: "agent:main:main",
        openclawVersion: "test",
        nodes: [{ sessionKey: "agent:main:main", bundleDir: "bundle" }],
      }),
    );
    const result = await mapFamilyToAtif(
      normalizeFamily(await loadCapturedFamilyFromGraph(graphPath, root)),
    );
    expect(result.trajectory.steps[0]?.message).toBe("");
  });
});
