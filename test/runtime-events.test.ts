import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertOpenClawBundles } from "../src/exporter.js";
import { type TrajectoryEvent, trajectoryEventSchema } from "../src/models/bundle-v1.js";
import { classifyRuntimeEvent } from "../src/models/runtime-events.js";
import { event, writeBundle } from "./helpers.js";

const source = join(process.cwd(), "fixtures/bundles/provider-prompts");
const sourceEvents = (await readFile(join(source, "root/events.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => trajectoryEventSchema.parse(JSON.parse(line)));
const roots: string[] = [];

function observation(data?: Record<string, unknown>): TrajectoryEvent {
  return event({
    source: "runtime",
    type: "provider.prompt.observed",
    seq: 10,
    sessionId: "prompt-session",
    runId: "run-third",
    data,
  });
}

const validData = {
  egress: "responses-sdk",
  payloadVariant: "initial",
  promptSource: "input.developer",
  expectedChars: 13,
  observedChars: 13,
  matchesAssembledPrompt: true,
};

const toolIdentity = { toolCallId: "call-1", name: "exec" };
const runtimeTools = [
  { ...observation({ ...toolIdentity, args: { command: "printf hello" } }), type: "tool.call" },
  {
    ...observation({ ...toolIdentity, success: true, result: "hello" }),
    type: "tool.result",
    seq: 11,
  },
];

async function fixture(events = sourceEvents) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-atif-runtime-"));
  roots.push(root);
  const bundleRoot = join(root, "input");
  await cp(source, bundleRoot, { recursive: true });
  await writeBundle({
    root: bundleRoot,
    name: "root",
    sessionId: "prompt-session",
    sessionKey: "agent:main:main",
    events,
  });
  return { root, bundleRoot, graph: join(bundleRoot, "graph.json"), output: join(root, "output") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("runtime event policy", () => {
  it.each([
    ["session.started", "metadata"],
    ["trace.metadata", "metadata"],
    ["context.compiled", "context"],
    ["prompt.submitted", "metadata"],
    ["provider.prompt.observed", "metadata"],
    ["model.fallback_step", "context"],
    ["model.completed", "metadata"],
    ["trace.artifacts", "metadata"],
    ["session.ended", "metadata"],
    ["future.event", "unknown"],
    ["constructor", "unknown"],
  ])("classifies %s as %s", (type, kind) => {
    expect(classifyRuntimeEvent({ ...observation(validData), type })).toBe(kind);
  });

  it.each([
    ["responses-sdk", "initial", "instructions"],
    ["responses-websocket", "reasoning-stripped", "input.developer"],
    ["native-codex-websocket", "compaction-stripped", "input.system"],
    ["native-codex-sse", "continuation-rejected", "missing"],
  ])(
    "accepts observed transport and payload variants: %s/%s/%s",
    (egress, payloadVariant, promptSource) => {
      expect(
        classifyRuntimeEvent(observation({ ...validData, egress, payloadVariant, promptSource })),
      ).toBe("metadata");
    },
  );

  it("does not recognize another source by runtime type alone", () => {
    expect(classifyRuntimeEvent({ ...observation(validData), source: "transcript" })).toBe(
      "unknown",
    );
  });
});

describe("runtime event preservation", () => {
  it("preserves ordered metadata and source identity without changing steps or metrics", async () => {
    const added = {
      ...observation({ ...validData, additionalField: { values: [false, 0, "", null] } }),
      sourceSeq: 42,
      provider: "openai",
      modelId: "gpt-5.6-luna",
      modelApi: "openai-responses",
      extensionField: "observed",
    };
    const events = [...sourceEvents, added];
    const f = await fixture(events);
    const result = await convertOpenClawBundles({ ...f, requireComplete: true });
    expect(result.status).toBe("complete");
    expect(result.receipt.diagnostics).toEqual([]);
    const runtime = result.trajectory.extra?.openclaw as Record<string, unknown>;
    expect(runtime.runtime).toEqual({
      event_type_counts: {
        "trace.metadata": 1,
        "context.compiled": 1,
        "provider.prompt.observed": 4,
        "session.ended": 1,
      },
      events: events.filter(
        (item) => item.source === "runtime" && item.type !== "context.compiled",
      ),
    });
    const baseline = await convertOpenClawBundles(
      await fixture(
        sourceEvents
          .filter((item) => item.type !== "provider.prompt.observed")
          .map((item, index) => ({ ...item, seq: index + 1 })),
      ),
    );
    expect(result.trajectory.steps).toEqual(baseline.trajectory.steps);
    expect(result.trajectory.final_metrics).toEqual(baseline.trajectory.final_metrics);
    expect(result.receipt.familyMetrics).toEqual(baseline.receipt.familyMetrics);
    const raw = await readFile(join(f.output, "trajectory.json"));
    await convertOpenClawBundles({ ...f, requireComplete: true });
    expect(await readFile(join(f.output, "trajectory.json"))).toEqual(raw);
  });

  it("retains a prompt mismatch or missing prompt as source evidence, not export failure", async () => {
    const added = observation({
      ...validData,
      promptSource: "missing",
      observedChars: 0,
      matchesAssembledPrompt: false,
    });
    const result = await convertOpenClawBundles({
      ...(await fixture([...sourceEvents, added])),
      requireComplete: true,
    });
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result.trajectory.extra)).toContain('"matchesAssembledPrompt":false');
  });

  it.each([
    undefined,
    {},
    { ...validData, expectedChars: -1 },
    { ...validData, observedChars: 0.5 },
    { ...validData, expectedChars: "13" },
    { ...validData, matchesAssembledPrompt: "true" },
    { ...validData, egress: "new-transport" },
    { ...validData, payloadVariant: "new-variant" },
    { ...validData, promptSource: "new-source" },
  ])("preserves malformed observations and marks the export partial: %j", async (data) => {
    const added = observation(data);
    const f = await fixture([...sourceEvents, added]);
    const result = await convertOpenClawBundles(f);
    expect(result.status).toBe("partial");
    expect(result.receipt.diagnostics.map((item) => item.code)).toEqual(["invalid-runtime-event"]);
    const runtime = result.trajectory.extra?.openclaw as { runtime: { events: unknown[] } };
    expect(runtime.runtime.events).toContainEqual(added);
    await expect(
      convertOpenClawBundles({ ...f, output: join(f.root, "strict"), requireComplete: true }),
    ).rejects.toThrow(/partial|complete/i);
  });

  it.each(["future.event", "assistant.message", "session.model_change"])(
    "retains unknown runtime %s without treating it as a transcript event",
    async (type) => {
      const added = {
        ...observation({
          message: { content: "Not a transcript message" },
          modelId: "not-a-model",
        }),
        type,
      };
      const f = await fixture([...sourceEvents, added]);
      const result = await convertOpenClawBundles(f);
      const baseline = await convertOpenClawBundles(await fixture());
      expect(result.status).toBe("partial");
      expect(result.receipt.diagnostics.map((item) => item.code)).toEqual([
        "unsupported-runtime-event",
      ]);
      expect(result.trajectory.steps).toEqual(baseline.trajectory.steps);
      expect(result.receipt.familyMetrics).toEqual(baseline.receipt.familyMetrics);
      const runtime = result.trajectory.extra?.openclaw as { runtime: { events: unknown[] } };
      expect(runtime.runtime.events).toContainEqual(added);
    },
  );

  it("keeps truncation diagnostics even for a recognized observation", async () => {
    const added = observation({ ...validData, truncated: true, droppedFields: ["extensionField"] });
    const result = await convertOpenClawBundles(await fixture([...sourceEvents, added]));
    expect(result.status).toBe("partial");
    expect(result.receipt.diagnostics.map((item) => item.code)).toEqual(["source-event-truncated"]);
  });

  it("keeps metadata in the owning child rather than the family root", async () => {
    const f = await fixture();
    const child = {
      ...observation(validData),
      seq: 1,
      traceId: "child-session",
      sessionId: "child-session",
      runId: "child-run",
    };
    await writeBundle({
      root: f.bundleRoot,
      name: "child",
      sessionId: "child-session",
      sessionKey: "agent:main:subagent:child",
      events: [child],
    });
    await writeFile(
      f.graph,
      JSON.stringify({
        schema: "openclaw-atif-bundle-graph-v1",
        rootKey: "agent:main:main",
        openclawVersion: "test",
        nodes: [
          { sessionKey: "agent:main:main", bundleDir: "root" },
          {
            sessionKey: "agent:main:subagent:child",
            bundleDir: "child",
            parentKey: "agent:main:main",
            relationshipKind: "native-subagent",
          },
        ],
      }),
    );
    const result = await convertOpenClawBundles(f);
    const runtime = result.trajectory.extra?.openclaw as { runtime: { events: unknown[] } };
    const childRuntime = result.trajectory.subagent_trajectories?.[0]?.extra?.openclaw as {
      runtime: { events: unknown[] };
    };
    expect(runtime.runtime.events).not.toContainEqual(child);
    expect(childRuntime.runtime.events).toContainEqual(child);
  });

  it("enforces complete versus partial exit codes through the compiled CLI", async () => {
    const f = await fixture([...sourceEvents, ...runtimeTools]);
    const args = [
      join(process.cwd(), "dist/cli-main.js"),
      "convert",
      "--graph",
      f.graph,
      "--bundle-root",
      f.bundleRoot,
      "--output",
      f.output,
      "--json",
    ];
    const complete = spawnSync(process.execPath, [...args, "--require-complete"], {
      encoding: "utf8",
    });
    expect(complete.status, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout) as unknown).toMatchObject({ status: "complete" });
    await writeBundle({
      root: f.bundleRoot,
      name: "root",
      sessionId: "prompt-session",
      sessionKey: "agent:main:main",
      events: [...sourceEvents, { ...observation(validData), type: "future.event" }],
    });
    await rm(f.output, { recursive: true });
    const partial = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(partial.status, partial.stderr).toBe(2);
    expect(JSON.parse(partial.stdout) as unknown).toMatchObject({ status: "partial" });
    await rm(f.output, { recursive: true });
    const refused = spawnSync(process.execPath, [...args, "--require-complete"], {
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    await expect(readFile(join(f.output, "trajectory.json"))).rejects.toThrow();
  });
});

describe("runtime tool evidence", () => {
  it("keeps valid tool records without duplicating transcript steps, observations or usage", async () => {
    const transcript = [
      ...sourceEvents,
      event({
        source: "transcript",
        type: "assistant.message",
        seq: 10,
        sessionId: "prompt-session",
        entryId: "tool-assistant",
        data: {
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "exec",
                arguments: { command: "printf hello" },
              },
            ],
            usage: { input: 3, output: 2 },
          },
        },
      }),
      event({
        source: "transcript",
        type: "tool.call",
        seq: 11,
        sessionId: "prompt-session",
        data: {
          ...toolIdentity,
          arguments: { command: "printf hello" },
          assistantEntryId: "tool-assistant",
          blockIndex: 0,
        },
      }),
      event({
        source: "transcript",
        type: "tool.result",
        seq: 12,
        sessionId: "prompt-session",
        entryId: "tool-result",
        data: {
          message: { role: "toolResult", toolCallId: "call-1", toolName: "exec", content: "hello" },
        },
      }),
    ];
    const baseline = await convertOpenClawBundles({
      ...(await fixture(transcript)),
      requireComplete: true,
    });
    const records = runtimeTools.map((item, index) => ({
      ...item,
      seq: transcript.length + index + 1,
    }));
    const f = await fixture([...transcript, ...records]);
    const result = await convertOpenClawBundles({ ...f, requireComplete: true });
    expect(result.status).toBe("complete");
    expect(result.receipt.diagnostics).toEqual([]);
    expect(result.trajectory.steps).toEqual(baseline.trajectory.steps);
    expect(result.trajectory.steps.flatMap((step) => step.tool_calls ?? [])).toHaveLength(1);
    expect(result.trajectory.steps.flatMap((step) => step.observation?.results ?? [])).toHaveLength(
      1,
    );
    expect(result.trajectory.final_metrics).toEqual(baseline.trajectory.final_metrics);
    expect(result.receipt.familyMetrics).toEqual(baseline.receipt.familyMetrics);
    expect(result.trajectory.extra?.openclaw).toMatchObject({
      runtime: {
        event_type_counts: { "tool.call": 1, "tool.result": 1 },
        events: expect.arrayContaining(records) as unknown,
      },
    });
    const bytes = await Promise.all(
      ["trajectory.json", "receipt.json"].map((name) => readFile(join(f.output, name))),
    );
    await convertOpenClawBundles({ ...f, requireComplete: true });
    expect(
      await Promise.all(
        ["trajectory.json", "receipt.json"].map((name) => readFile(join(f.output, name))),
      ),
    ).toEqual(bytes);
  });

  it.each([undefined, null, false, 0, "", [], { content: [{ type: "text", text: "hello" }] }])(
    "preserves opaque payloads and failed executions without inventing transcript facts: %j",
    async (payload) => {
      const records = runtimeTools.map((item) => ({
        ...item,
        data: {
          ...toolIdentity,
          phase: item.type === "tool.call" ? "start" : "result",
          ...(item.type === "tool.call" ? { args: payload } : { success: false, result: payload }),
          additionalField: { values: [false, 0, "", null] },
        },
      }));
      const result = await convertOpenClawBundles({
        ...(await fixture([...sourceEvents, ...records])),
        requireComplete: true,
      });
      const baseline = await convertOpenClawBundles(await fixture());
      expect(result.status).toBe("complete");
      expect(result.trajectory.steps).toEqual(baseline.trajectory.steps);
      expect(result.receipt.familyMetrics).toEqual(baseline.receipt.familyMetrics);
      expect(result.trajectory.extra?.openclaw).toMatchObject({
        runtime: {
          events: expect.arrayContaining(
            JSON.parse(JSON.stringify(records)) as unknown[],
          ) as unknown,
        },
      });
    },
  );

  it.each([
    ["tool.call", undefined],
    ["tool.call", {}],
    ["tool.call", { name: "exec" }],
    ["tool.call", { toolCallId: "call-1" }],
    ["tool.call", { ...toolIdentity, toolCallId: "" }],
    ["tool.call", { ...toolIdentity, toolCallId: 1 }],
    ["tool.call", { ...toolIdentity, name: "" }],
    ["tool.call", { ...toolIdentity, name: false }],
    ["tool.result", undefined],
    ["tool.result", toolIdentity],
    ["tool.result", { ...toolIdentity, success: "true" }],
    ["tool.result", { ...toolIdentity, toolCallId: "", success: true }],
    ["tool.result", { ...toolIdentity, name: "", success: true }],
  ] as const)("retains malformed %s as partial evidence: %j", async (type, data) => {
    const added = { ...observation(data), type };
    const f = await fixture([...sourceEvents, added]);
    const result = await convertOpenClawBundles(f);
    expect(result.status).toBe("partial");
    expect(result.receipt.diagnostics.map((item) => item.code)).toEqual(["invalid-runtime-event"]);
    expect(result.trajectory.extra?.openclaw).toMatchObject({
      runtime: { events: expect.arrayContaining([added]) as unknown },
    });
    await expect(
      convertOpenClawBundles({ ...f, output: join(f.root, "strict"), requireComplete: true }),
    ).rejects.toThrow(/partial|complete/i);
  });

  it.each([true, 1, ["args"], 2])(
    "keeps source truncation diagnostics for supported tool events: %j",
    async (marker) => {
      const records = runtimeTools.map((item) => ({
        ...item,
        data: {
          ...item.data,
          ...(typeof marker === "boolean" || marker === 1
            ? { truncated: marker }
            : { droppedFields: marker }),
        },
      }));
      const result = await convertOpenClawBundles(await fixture([...sourceEvents, ...records]));
      expect(result.status).toBe("partial");
      expect(result.receipt.diagnostics.map((item) => item.code)).toEqual([
        "source-event-truncated",
      ]);
    },
  );
});
