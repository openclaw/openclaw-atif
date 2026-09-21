/* eslint-disable complexity -- Recursive ATIF cross-field validation is explicit. */
import { z } from "zod";
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import { ATIF_VERSION } from "../version.js";

export type { JsonObject, JsonValue };

export type AtifContentPart = z.infer<typeof contentPartSchema>;

const MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mpga": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-aac": "audio/aac",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
};

function canonicalMediaType(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  return MEDIA_TYPE_ALIASES[normalized] ?? normalized;
}

export interface AtifSubagentRef {
  trajectory_id?: string;
  session_id?: string;
  trajectory_path?: string;
  extra?: JsonObject;
}

export interface AtifObservationResult {
  source_call_id?: string | null;
  content?: string | AtifContentPart[] | null;
  subagent_trajectory_ref?: AtifSubagentRef[];
  extra?: JsonObject;
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: JsonObject;
  extra?: JsonObject;
}

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: JsonObject;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: "system" | "user" | "agent";
  model_name?: string;
  reasoning_effort?: string | number;
  message: string | AtifContentPart[];
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: AtifObservationResult[] };
  metrics?: AtifMetrics;
  is_copied_context?: boolean;
  llm_call_count?: number;
  extra?: JsonObject;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  extra?: JsonObject;
}

export interface AtifAgent {
  name: string;
  version: string;
  model_name?: string;
  tool_definitions?: JsonObject[];
  extra?: JsonObject;
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_VERSION;
  session_id?: string;
  trajectory_id?: string;
  agent: AtifAgent;
  steps: AtifStep[];
  notes?: string;
  final_metrics?: AtifFinalMetrics;
  continued_trajectory_ref?: string;
  extra?: JsonObject;
  subagent_trajectories?: AtifTrajectory[];
}

// Zod records omit __proto__; JSON payloads must validate and retain every own key.
const jsonObjectSchema = z.custom<JsonObject>(isJsonObject);
export const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("image"),
      source: z
        .object({
          media_type: z.preprocess(
            canonicalMediaType,
            z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
          ),
          path: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("audio"),
      source: z
        .object({
          media_type: z.preprocess(
            canonicalMediaType,
            z.enum([
              "audio/wav",
              "audio/mpeg",
              "audio/mp4",
              "audio/aac",
              "audio/ogg",
              "audio/flac",
              "audio/webm",
              "audio/aiff",
            ]),
          ),
          path: z.string().min(1),
          duration_sec: z.number().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
]);
const subagentRefSchema = z
  .object({
    trajectory_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    trajectory_path: z.string().min(1).optional(),
    extra: jsonObjectSchema.optional(),
  })
  .strict()
  .refine((value) => value.trajectory_id !== undefined || value.trajectory_path !== undefined, {
    message: "Subagent reference requires trajectory_id or trajectory_path",
  });
const observationResultSchema = z
  .object({
    source_call_id: z.string().nullable().optional(),
    content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
    subagent_trajectory_ref: z.array(subagentRefSchema).optional(),
    extra: jsonObjectSchema.optional(),
  })
  .strict();
const toolCallSchema = z
  .object({
    tool_call_id: z.string(),
    function_name: z.string(),
    arguments: jsonObjectSchema,
    extra: jsonObjectSchema.optional(),
  })
  .strict();
const metricsSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    cached_tokens: z.number().int().nonnegative().optional(),
    cost_usd: z.number().nonnegative().optional(),
    extra: jsonObjectSchema.optional(),
  })
  .strict();
const stepSchema = z
  .object({
    step_id: z.number().int().positive(),
    // Preserve minute precision accepted by the public validator before Zod 4.6.
    timestamp: z
      .union([z.iso.datetime({ offset: true }), z.iso.datetime({ offset: true, precision: -1 })])
      .optional(),
    source: z.enum(["system", "user", "agent"]),
    model_name: z.string().optional(),
    reasoning_effort: z.union([z.string(), z.number()]).optional(),
    message: z.union([z.string(), z.array(contentPartSchema)]),
    reasoning_content: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    observation: z
      .object({ results: z.array(observationResultSchema) })
      .strict()
      .optional(),
    metrics: metricsSchema.optional(),
    is_copied_context: z.boolean().optional(),
    llm_call_count: z.number().int().nonnegative().optional(),
    extra: jsonObjectSchema.optional(),
  })
  .strict();
const finalMetricsSchema = z
  .object({
    total_prompt_tokens: z.number().int().nonnegative().optional(),
    total_completion_tokens: z.number().int().nonnegative().optional(),
    total_cached_tokens: z.number().int().nonnegative().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    total_steps: z.number().int().nonnegative().optional(),
    extra: jsonObjectSchema.optional(),
  })
  .strict();
const agentSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    model_name: z.string().optional(),
    tool_definitions: z.array(jsonObjectSchema).optional(),
    extra: jsonObjectSchema.optional(),
  })
  .strict();

export const atifTrajectorySchema: z.ZodType<AtifTrajectory> = z.lazy(() =>
  z
    .object({
      schema_version: z.literal(ATIF_VERSION),
      session_id: z.string().optional(),
      trajectory_id: z.string().optional(),
      agent: agentSchema,
      steps: z.array(stepSchema).min(1),
      notes: z.string().optional(),
      final_metrics: finalMetricsSchema.optional(),
      continued_trajectory_ref: z.string().optional(),
      extra: jsonObjectSchema.optional(),
      subagent_trajectories: z.array(atifTrajectorySchema).optional(),
    })
    .strict()
    .superRefine(validateTrajectory),
);

function validateTrajectory(trajectory: AtifTrajectory, context: z.RefinementCtx): void {
  const childIds = new Set<string>();
  for (const [index, child] of (trajectory.subagent_trajectories ?? []).entries()) {
    if (!child.trajectory_id) {
      context.addIssue({
        code: "custom",
        path: ["subagent_trajectories", index, "trajectory_id"],
        message: "Embedded subagent requires trajectory_id",
      });
    } else if (childIds.has(child.trajectory_id)) {
      context.addIssue({
        code: "custom",
        path: ["subagent_trajectories", index, "trajectory_id"],
        message: "Embedded trajectory_id must be unique",
      });
    } else childIds.add(child.trajectory_id);
  }
  for (const [index, step] of trajectory.steps.entries()) {
    if (step.step_id !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "step_id"],
        message: `Expected sequential step_id ${String(index + 1)}`,
      });
    }
    if (
      step.source !== "agent" &&
      (step.model_name !== undefined ||
        step.reasoning_effort !== undefined ||
        step.reasoning_content !== undefined ||
        step.tool_calls !== undefined ||
        step.metrics !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["steps", index],
        message: "Agent-only fields require source agent",
      });
    }
    if (
      step.source === "agent" &&
      step.llm_call_count === 0 &&
      (step.metrics !== undefined || step.reasoning_content !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["steps", index],
        message: "Metrics and reasoning_content must be absent when llm_call_count is 0",
      });
    }
    const callIds = new Set(step.tool_calls?.map((call) => call.tool_call_id) ?? []);
    for (const [resultIndex, result] of (step.observation?.results ?? []).entries()) {
      if (result.source_call_id && !callIds.has(result.source_call_id)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "observation", "results", resultIndex, "source_call_id"],
          message: "Observation must reference a tool call in the same step",
        });
      }
    }
  }
}

export function validateAtifTrajectory(value: unknown): AtifTrajectory {
  return atifTrajectorySchema.parse(value);
}
