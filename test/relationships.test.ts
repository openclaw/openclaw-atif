import { describe, expect, it } from "vitest";
import { discoverRelationships, extractSpawnEvidence } from "../src/capture/relationships.js";
import { event, rootEvents } from "./helpers.js";

describe("relationship discovery", () => {
  it("combines exact spawn results with listing lineage", () => {
    const parent = { key: "agent:main:main", sessionId: "root" };
    const child = {
      key: "agent:main:subagent:child",
      sessionId: "child",
      parentSessionKey: parent.key,
    };
    const relationships = discoverRelationships({
      parent,
      rows: [parent, child],
      events: rootEvents("root", child.key),
    });
    expect(relationships).toHaveLength(1);
    expect(relationships[0]?.childKey).toBe(child.key);
    expect(relationships[0]?.kind).toBe("native-subagent");
    expect(relationships[0]?.listing).toBe(true);
    expect(relationships[0]?.spawn?.toolCallId).toBe("call-1");
  });

  it("uses observed spawn mode and listing lineage instead of key shape", () => {
    const parent = { key: "agent:main:main", sessionId: "root" };
    const visible = {
      key: "opaque-visible-child",
      sessionId: "visible",
      parentSessionKey: parent.key,
      kind: "spawn-child",
    };
    const visibleEvents = rootEvents("root", visible.key).map((item) =>
      item.type === "tool.call"
        ? { ...item, data: { ...item.data, arguments: { visible: true } } }
        : item,
    );
    expect(
      discoverRelationships({ parent, rows: [parent, visible], events: visibleEvents })[0]?.kind,
    ).toBe("visible-child");

    const native = {
      key: "agent:main:subagent:compacted",
      sessionId: "native",
      spawnedBy: parent.key,
      kind: "spawn-child",
    };
    expect(discoverRelationships({ parent, rows: [parent, native], events: [] })[0]?.kind).toBe(
      "native-subagent",
    );
  });

  it("supports ACP child relationships", () => {
    const parent = { key: "agent:main:main", sessionId: "root" };
    const child = {
      key: "agent:main:acp:child",
      sessionId: "child",
      parentSessionKey: parent.key,
      acpOwned: true,
    };
    const relationships = discoverRelationships({
      parent,
      rows: [parent, child],
      events: rootEvents("root", child.key),
    });
    expect(relationships[0]?.kind).toBe("acp-child");
  });

  it.each([
    [{ visible: true }, "visible-child"],
    [{ runtime: "acp" }, "acp-child"],
  ] as const)("preserves transcript spawn mode beside runtime copies: %j", (args, kind) => {
    const parent = { key: "agent:main:main", sessionId: "root" };
    const child = { key: "opaque-child", sessionId: "child", parentSessionKey: parent.key };
    const transcript = rootEvents("root", child.key).map((item) =>
      item.type === "tool.call" ? { ...item, data: { ...item.data, arguments: args } } : item,
    );
    const runtime = event({
      source: "runtime",
      type: "tool.call",
      seq: 20,
      sessionId: "root",
      data: { toolCallId: "call-1", name: "sessions_spawn", args },
    });
    const events = [...transcript, runtime];
    expect(extractSpawnEvidence(events)).toEqual(extractSpawnEvidence(transcript));
    expect(discoverRelationships({ parent, rows: [parent, child], events })[0]?.kind).toBe(kind);
  });

  it.each(["tool.call", "tool.result", "both"])(
    "does not infer lineage when %s is runtime evidence rather than transcript",
    (type) => {
      const events = rootEvents("root", "agent:main:subagent:phantom").map((item) =>
        (type === "both" && item.type.startsWith("tool.")) || item.type === type
          ? {
              ...item,
              source: "runtime" as const,
              data: {
                ...item.data,
                toolCallId: "call-1",
                name: "sessions_spawn",
                success: false,
              },
            }
          : item,
      );
      expect(extractSpawnEvidence(events)).toEqual([]);
    },
  );

  it("does not create lineage from a failed structured spawn result", () => {
    const events = rootEvents("root", "agent:main:subagent:failed").map((item) =>
      item.type === "tool.result"
        ? {
            ...item,
            data: {
              ...item.data,
              message: {
                toolCallId: "call-1",
                toolName: "sessions_spawn",
                content: JSON.stringify({
                  status: "error",
                  error: "dispatch failed",
                  childSessionKey: "agent:main:subagent:failed",
                }),
              },
            },
          }
        : item,
    );
    expect(extractSpawnEvidence(events)).toEqual([]);
  });

  it("does not accept session-looking free-form prose", () => {
    const events = [
      event({
        seq: 1,
        source: "transcript",
        type: "tool.call",
        sessionId: "root",
        data: { toolCallId: "call", name: "sessions_spawn" },
      }),
      event({
        seq: 2,
        source: "transcript",
        type: "tool.result",
        sessionId: "root",
        data: {
          message: {
            toolCallId: "call",
            toolName: "sessions_spawn",
            content: "Created agent:main:subagent:phantom successfully",
          },
        },
      }),
    ];
    expect(extractSpawnEvidence(events)).toEqual([]);
  });

  it("accepts exact JSON content but not an embedded JSON fragment", () => {
    const exact = [
      event({
        seq: 1,
        source: "transcript",
        type: "tool.call",
        sessionId: "root",
        data: { toolCallId: "call", name: "sessions_spawn" },
      }),
      event({
        seq: 2,
        source: "transcript",
        type: "tool.result",
        sessionId: "root",
        data: {
          message: {
            toolCallId: "call",
            toolName: "sessions_spawn",
            content: JSON.stringify({ childSessionKey: "agent:main:subagent:real" }),
          },
        },
      }),
    ];
    const prose = structuredClone(exact);
    const message = prose[1]?.data?.message as Record<string, unknown>;
    message.content = `result: ${String(message.content)}`;
    expect(extractSpawnEvidence(exact)).toHaveLength(1);
    expect(extractSpawnEvidence(prose)).toEqual([]);
  });
});
