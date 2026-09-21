/* eslint-disable max-lines-per-function -- The mapper edge suite keeps one shared synthetic family helper. */
import { describe, expect, it } from "vitest";
import { mapFamilyToAtif } from "../src/atif/mapper.js";
import { validateAtifTrajectory } from "../src/atif/schema.js";
import { trajectoryEventSchema } from "../src/models/bundle-v1.js";
import type { SessionFamilySnapshot } from "../src/models/family.js";
import { event } from "./helpers.js";

function family(
  events: ReturnType<typeof event>[],
  row: Record<string, unknown> = {},
): SessionFamilySnapshot {
  return {
    rootKey: "agent:main:main",
    openclawVersion: "test-version",
    profile: "openclaw-support-v1",
    nodes: new Map([
      [
        "agent:main:main",
        {
          bundleDirectory: "/missing-bundle",
          key: "agent:main:main",
          sessionId: "session",
          leafId: "leaf",
          row: { key: "agent:main:main", sessionId: "session", ...row },
          transcriptEvents: events.filter((item) => item.source === "transcript"),
          runtimeEvents: events.filter((item) => item.source === "runtime"),
          exportEvents: events.filter((item) => item.source === "export"),
          childRelationships: [],
          bundleWarnings: [],
          sourceHashes: {},
          diagnostics: [],
        },
      ],
    ]),
    relationships: [],
    diagnostics: [],
    stable: true,
    listingBeforeHash: "same",
    listingAfterHash: "same",
  };
}

describe("ATIF mapper edge cases", () => {
  it.each([false, true])(
    "preserves own __proto__ tool arguments with JSON text=%s",
    async (text) => {
      const raw = '{"__proto__":{"kept":true},"nested":{"__proto__":0}}';
      const args: unknown = text ? raw : JSON.parse(raw);
      const events = [
        event({
          seq: 1,
          source: "transcript",
          type: "assistant.message",
          sessionId: "session",
          entryId: "a",
          data: { message: { content: "call" } },
        }),
        event({
          seq: 2,
          source: "transcript",
          type: "tool.call",
          sessionId: "session",
          data: { assistantEntryId: "a", toolCallId: "call", name: "tool", arguments: args },
        }),
      ].map((item) => trajectoryEventSchema.parse(item));
      const result = await mapFamilyToAtif(family(events));
      const mapped = validateAtifTrajectory(result.trajectory).steps[0]?.tool_calls?.[0]?.arguments;
      expect(mapped).toEqual(JSON.parse(raw));
      expect(Object.hasOwn(mapped ?? {}, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(mapped)).toBe(Object.prototype);
    },
  );

  it("maps runtime context and all context-management transcript events", async () => {
    const events = [
      event({
        seq: 1,
        source: "runtime",
        type: "trace.metadata",
        sessionId: "session",
        data: { harness: {}, model: {} },
      }),
      event({
        seq: 2,
        source: "runtime",
        type: "context.compiled",
        sessionId: "session",
        data: { systemPrompt: "system", tools: [{ name: "tool" }] },
      }),
      event({
        seq: 3,
        source: "runtime",
        type: "model.fallback_step",
        sessionId: "session",
        data: { from: "a", to: "b" },
      }),
      event({
        seq: 4,
        source: "transcript",
        type: "session.reset",
        sessionId: "session",
        entryId: "reset",
        data: { reason: "manual" },
      }),
      event({
        seq: 5,
        source: "transcript",
        type: "session.branch_summary",
        sessionId: "session",
        entryId: "summary",
        data: { summary: "summary" },
      }),
      event({
        seq: 6,
        source: "transcript",
        type: "session.custom",
        sessionId: "session",
        entryId: "custom",
        data: { customType: "x", data: { ok: true } },
      }),
      event({
        seq: 7,
        source: "transcript",
        type: "session.custom_message",
        sessionId: "session",
        entryId: "custom-message",
        data: { content: [{ type: "text", text: "custom context" }] },
      }),
      event({
        seq: 8,
        source: "transcript",
        type: "session.thinking_level_change",
        sessionId: "session",
        data: { thinkingLevel: "high" },
      }),
      event({
        seq: 9,
        source: "transcript",
        type: "session.model_change",
        sessionId: "session",
        data: { provider: "p", modelId: "m" },
      }),
      event({
        seq: 10,
        source: "transcript",
        type: "session.label",
        sessionId: "session",
        data: { label: "label" },
      }),
      event({
        seq: 11,
        source: "transcript",
        type: "session.info",
        sessionId: "session",
        data: { name: "name" },
      }),
      event({
        seq: 12,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "assistant-after-settings",
        data: { message: { content: "uses changed settings" } },
      }),
    ];
    const result = await mapFamilyToAtif(
      family(events, { model: "fallback", modelProvider: "provider" }),
    );
    expect(result.trajectory.steps.map((step) => step.extra?.openclaw)).toHaveLength(11);
    expect(result.trajectory.steps[0]?.message).toBe("system");
    expect(result.trajectory.agent.model_name).toBe("provider/fallback");
    expect(result.trajectory.agent.tool_definitions).toEqual([
      { type: "function", function: { name: "tool", parameters: {} } },
    ]);
    const assistant = result.trajectory.steps.at(-1);
    expect(assistant?.model_name).toBe("p/m");
    expect(assistant?.reasoning_effort).toBe("high");
  });

  it("does not backfill earlier steps from later model metadata", async () => {
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "before-model",
        data: { message: { content: "before" } },
      }),
      event({
        seq: 2,
        source: "runtime",
        type: "trace.metadata",
        sessionId: "session",
        data: { model: { provider: "p", name: "new" } },
      }),
      event({
        seq: 3,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "after-model",
        data: { message: { content: "after" } },
      }),
    ];
    const result = await mapFamilyToAtif(family(events));
    expect(result.trajectory.steps[0]?.model_name).toBeUndefined();
    expect(result.trajectory.steps[1]?.model_name).toBe("p/new");
  });

  it("omits media references that would be invalid outside the source bundle", async () => {
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "user.message",
        sessionId: "session",
        entryId: "u",
        data: {
          message: {
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { path: "image.png", media_type: "image/png" } },
              { type: "image", data: "redacted" },
              { type: "audio", source: { path: "audio.wav" } },
            ],
          },
        },
      }),
    ];
    const result = await mapFamilyToAtif(family(events));
    expect(result.trajectory.steps[0]?.message).toBe("look");
    expect(
      result.diagnostics.filter((item) => item.code === "media-source-unsupported"),
    ).toHaveLength(2);
    expect(result.diagnostics.some((item) => item.code === "media-file-unavailable")).toBe(true);
  });

  it("preserves malformed tool arguments as metadata and detects reused call IDs", async () => {
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "a1",
        data: { message: { content: "first" } },
      }),
      event({
        seq: 2,
        source: "transcript",
        type: "tool.call",
        sessionId: "session",
        data: { assistantEntryId: "a1", toolCallId: "same", name: "tool", arguments: "not-json" },
      }),
      event({
        seq: 3,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "a2",
        data: { message: { content: "second" } },
      }),
      event({
        seq: 4,
        source: "transcript",
        type: "tool.call",
        sessionId: "session",
        data: {
          assistantEntryId: "a2",
          toolCallId: "same",
          name: "tool",
          arguments: '{"ok":true}',
        },
      }),
      event({
        seq: 5,
        source: "transcript",
        type: "tool.result",
        sessionId: "session",
        data: { message: { toolCallId: "same", content: "done" } },
      }),
    ];
    const result = await mapFamilyToAtif(family(events));
    expect(result.trajectory.steps[0]?.tool_calls?.[0]?.extra?.arguments_status).toBe("unparsed");
    expect(result.trajectory.steps[1]?.tool_calls?.[0]?.arguments).toEqual({ ok: true });
    expect(result.diagnostics.some((item) => item.code === "duplicate-tool-call-id")).toBe(true);
  });

  it("omits and diagnoses tool calls without source identifiers", async () => {
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "assistant",
        data: { message: { content: "calling" } },
      }),
      event({
        seq: 2,
        source: "transcript",
        type: "tool.call",
        sessionId: "session",
        entryId: "assistant",
        data: { assistantEntryId: "assistant", arguments: {} },
      }),
    ];
    const result = await mapFamilyToAtif(family(events));
    expect(result.trajectory.steps[0]?.tool_calls).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "tool-call-identity-unavailable")).toBe(
      true,
    );
  });

  it("omits malformed metrics and preserves observed zero and cache writes", async () => {
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "assistant.message",
        sessionId: "session",
        entryId: "a",
        data: {
          message: {
            provider: "p",
            model: "m",
            content: "",
            usage: { input: 0, output: -1, cacheRead: 0, cacheWrite: 5, cost: Number.NaN },
          },
        },
      }),
    ];
    const result = await mapFamilyToAtif(family(events));
    expect(result.trajectory.steps[0]?.metrics).toEqual({
      prompt_tokens: 5,
      cached_tokens: 0,
      extra: { cache_write_tokens: 5 },
    });
    expect(result.trajectory.final_metrics?.total_prompt_tokens).toBe(5);
    expect(result.trajectory.final_metrics?.total_completion_tokens).toBeUndefined();
  });

  it("does not duplicate diagnostics already normalized at family scope", async () => {
    const snapshot = family([]);
    const diagnostic = {
      code: "source-warning",
      message: "one source warning",
      nodeKey: "agent:main:main",
    };
    snapshot.diagnostics.push(diagnostic);
    snapshot.nodes.get("agent:main:main")?.diagnostics.push(diagnostic);
    const result = await mapFamilyToAtif(snapshot);
    expect(result.diagnostics.filter((item) => item.code === "source-warning")).toHaveLength(1);
  });

  it("creates an explicit empty structural step for an unmappable bundle", async () => {
    const result = await mapFamilyToAtif(
      family([event({ seq: 1, source: "runtime", type: "session.started", sessionId: "session" })]),
    );
    expect(result.trajectory.steps).toEqual([
      expect.objectContaining({ source: "system", message: "" }),
    ]);
    expect(result.diagnostics.some((item) => item.code === "session-has-no-mapped-steps")).toBe(
      true,
    );
  });
});
