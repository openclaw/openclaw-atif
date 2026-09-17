import { describe, expect, it } from "vitest";
import { type AtifTrajectory, validateAtifTrajectory } from "../src/atif/schema.js";

function trajectory(): AtifTrajectory {
  return {
    schema_version: "ATIF-v1.8",
    session_id: "root",
    trajectory_id: "root-id",
    agent: { name: "openclaw", version: "test" },
    steps: [
      {
        step_id: 1,
        source: "agent",
        message: "spawn",
        tool_calls: [{ tool_call_id: "call", function_name: "sessions_spawn", arguments: {} }],
        observation: {
          results: [
            {
              source_call_id: "call",
              subagent_trajectory_ref: [{ trajectory_id: "child-id", session_id: "child" }],
            },
          ],
        },
      },
    ],
    subagent_trajectories: [
      {
        schema_version: "ATIF-v1.8",
        session_id: "child",
        trajectory_id: "child-id",
        agent: { name: "openclaw", version: "test" },
        steps: [{ step_id: 1, source: "user", message: "work" }],
      },
    ],
  };
}

describe("ATIF schema", () => {
  it("accepts recursive ATIF-v1.8 trajectories", () => {
    expect(validateAtifTrajectory(trajectory()).subagent_trajectories).toHaveLength(1);
  });

  it("rejects invalid tool-result references", () => {
    const value = trajectory();
    const result = value.steps[0]?.observation?.results[0];
    if (result) result.source_call_id = "missing";
    expect(() => validateAtifTrajectory(value)).toThrow("Observation");
  });

  it("rejects content parts with missing or contradictory fields", () => {
    for (const part of [
      { type: "text" },
      { type: "image" },
      { type: "text", text: "text", source: { media_type: "image/png", path: "image.png" } },
      { type: "image", text: "text", source: { media_type: "image/png", path: "image.png" } },
      { type: "audio" },
      { type: "audio", source: { media_type: "image/png", path: "audio" } },
      { type: "image", source: { media_type: "audio/wav", path: "image" } },
      { type: "audio", text: "text", source: { media_type: "audio/wav", path: "audio" } },
      ...[-1, Infinity, NaN, "1"].map((duration_sec) => ({
        type: "audio",
        source: { media_type: "audio/wav", path: "a.wav", duration_sec },
      })),
    ]) {
      const value = trajectory() as unknown as Record<string, unknown>;
      const steps = value.steps as Record<string, unknown>[];
      if (steps[0]) steps[0].message = [part];
      expect(() => validateAtifTrajectory(value)).toThrow();
    }
  });

  it.each([
    ["audio/mp3", "audio/mpeg"],
    ["audio/x-m4a", "audio/mp4"],
    ["audio/x-wav", "audio/wav"],
    ["audio/x-aac", "audio/aac"],
    ["audio/x-flac", "audio/flac"],
    ["audio/x-aiff", "audio/aiff"],
    ["audio/ogg", "audio/ogg"],
    ["audio/webm", "audio/webm"],
  ])("normalizes audio %s to %s", (alias, canonical) => {
    const value = trajectory();
    const part = { type: "audio", source: { media_type: alias, path: "audio", duration_sec: 0 } };
    const parsed = validateAtifTrajectory({
      ...value,
      steps: [{ step_id: 1, source: "user", message: [part] }],
    });
    expect(parsed.steps[0]?.message).toEqual([
      { type: "audio", source: { media_type: canonical, path: "audio", duration_sec: 0 } },
    ]);
  });

  it("rejects the superseded output version", () => {
    expect(() =>
      validateAtifTrajectory({ ...trajectory(), schema_version: "ATIF-v1.7" }),
    ).toThrow();
  });

  it("rejects embedded children without trajectory IDs", () => {
    const value = trajectory();
    if (value.subagent_trajectories?.[0]) delete value.subagent_trajectories[0].trajectory_id;
    expect(() => validateAtifTrajectory(value)).toThrow("trajectory_id");
  });
});
