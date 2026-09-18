import { z } from "zod";
import type { TrajectoryEvent } from "./bundle-v1.js";

type RuntimeEventRule = {
  kind: "context" | "metadata";
  data?: z.ZodType;
};

// OpenClaw 2026.9.3 (1391f7c), ResponsesPromptObservation. Keep additional
// public fields intact; validation must not replace the original event data.
const promptObservationSchema = z
  .object({
    egress: z.enum([
      "responses-sdk",
      "responses-websocket",
      "native-codex-websocket",
      "native-codex-sse",
    ]),
    payloadVariant: z.enum([
      "initial",
      "reasoning-stripped",
      "compaction-stripped",
      "continuation-rejected",
    ]),
    promptSource: z.enum(["instructions", "input.developer", "input.system", "missing"]),
    expectedChars: z.number().int().nonnegative(),
    observedChars: z.number().int().nonnegative(),
    matchesAssembledPrompt: z.boolean(),
  })
  .loose();

const runtimeEventRules = new Map<string, RuntimeEventRule>([
  ["session.started", { kind: "metadata" }],
  ["trace.metadata", { kind: "metadata" }],
  ["context.compiled", { kind: "context" }],
  ["prompt.submitted", { kind: "metadata" }],
  ["provider.prompt.observed", { kind: "metadata", data: promptObservationSchema }],
  ["model.fallback_step", { kind: "context" }],
  ["model.completed", { kind: "metadata" }],
  ["trace.artifacts", { kind: "metadata" }],
  ["session.ended", { kind: "metadata" }],
]);

/** One policy for completeness and mapping. Unknown/invalid events stay metadata. */
export function classifyRuntimeEvent(
  event: TrajectoryEvent,
): "context" | "metadata" | "unknown" | "invalid" {
  const rule = event.source === "runtime" ? runtimeEventRules.get(event.type) : undefined;
  if (!rule) return "unknown";
  if (rule.data && !rule.data.safeParse(event.data).success) return "invalid";
  return rule.kind;
}
