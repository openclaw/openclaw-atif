---
title: "OpenClaw to ATIF mapping"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-08-20"
---

# OpenClaw to ATIF mapping

## Messages

- `user.message` becomes a user step.
- `assistant.message` becomes an agent step.
- `tool.result` attaches to the agent step with the exact matching tool call ID.
- An unmatched result becomes a system observation with no source call ID and a warning.

Observed empty content remains empty. The mapper does not add explanatory placeholders. Text-only content can remain a string. Mixed text, image, and audio content uses ATIF-v1.8 `ContentPart` entries.

## Media

The low-level `mapFamilyToAtif` function is asynchronous because it reads referenced bundle files. Each normalized node carries its bundle directory for path resolution; this machine-local path is not written to the receipt. Mapping returns `mediaFiles` alongside the trajectory, diagnostics, and node metrics. Use `exportOpenClawFamily` or `convertOpenClawBundles` to commit the trajectory and media together.

An image or audio part must have a supported media type and a source location. Map it to a matching ATIF `ImageSource` or `AudioSource` with `media_type` and `path`. The part's `type` must agree with the source's media type. Media parts cannot carry the text field, and text parts cannot carry a media source.

Supported image types are `image/jpeg`, `image/png`, `image/gif`, and `image/webp`. Normalize `image/jpg` to `image/jpeg`.

Supported audio types are `audio/wav`, `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/ogg`, `audio/flac`, `audio/webm`, and `audio/aiff`. Normalize common aliases to Harbor's canonical audio types, including `audio/mp3` to `audio/mpeg`. Preserve an observed, finite, non-negative `duration_sec` when supplied. Omit duration when it is unknown.

The same mapping applies to user messages, assistant messages, and tool results, including image-only or audio-only content. Recognize supported source shapes, including `image_url` and `input_image`, when they declare both a media type and a location. Do not infer missing media types or invent source locations.

The [export contract](2026-08-20-export-contract.md#media-retention) governs file retention and limits. Copy safe bundle-local files beside the output and rewrite their paths to retained relative paths. Preserve supported external references without fetching them.

For example, a retained audio part can be represented as:

```json
{
  "type": "audio",
  "source": {
    "media_type": "audio/mpeg",
    "path": "media/<content-hash>.mp3"
  }
}
```

Omit unsupported, missing, unsafe, or unretained content with explicit receipt diagnostics and a partial export status. Keep the observed text and other retained parts. This includes unsupported inline base64 blocks, unknown file or future content blocks, and failed copies. Do not substitute explanatory messages for omitted source content.

## Runtime facts

`trace.metadata`, `context.compiled`, `prompt.submitted`, `model.fallback_step`, `model.completed`, `trace.artifacts`, and `session.ended` supply agent configuration, context, outcome, and provenance only when they can be associated by exact source identity. OpenClaw tool descriptions from compiled context are converted to ATIF's OpenAI-style function-definition shape.

Runtime and transcript copies of the same dialogue are not emitted twice.

## Session events

Compaction and branch summaries become system context-management steps. Model and thinking changes affect later agent steps. Labels, reset, session info, and custom events remain typed source metadata or explicit system steps according to whether they affected model context.

Retained tails are not duplicated.

## Tools

Tool calls retain exact IDs, names, and JSON arguments. Results pair only by exact call ID. Malformed arguments remain raw source metadata instead of guessed JSON.

Only an exact successful structured `sessions_spawn` result can attach a `subagent_trajectory_ref` to an observation. Its child run ID must match an event in the exported child generation. Failed, rejected, cancelled, error-marked, ambiguous-generation, or rotated results do not prove concrete lineage. The matching call arguments and typed listing lineage distinguish visible sessions, native subagents, and ACP children; key text alone does not decide the relationship.

## Subagents and other relationships

Native subagents and ACP children can be recursively embedded. Listing-only descendants are embedded without an invented step reference and make the export partial.

Forks, visible sessions, cron runs, adopted sessions, and session rotations remain distinct relationship kinds. A successful `sessions_spawn` child remains a subagent when OpenClaw also marks its copied transcript context as forked; copied context does not replace the delegation relationship.

An ACP child represents the OpenClaw wrapper transcript. It does not claim to contain the external harness's hidden internal trajectory.

## Metrics

Per-step metrics use finite provider-reported values. `prompt_tokens` is the sum of uncached input, cache reads, and cache writes under the OpenClaw usage contract. Cache reads also populate `cached_tokens`, and cache writes remain visible in `extra`.

Each trajectory's final metrics cover only its own steps. The receipt contains a separately scoped family aggregate.

## Unsupported or missing data

Rewards, inferred retry causes, hidden reasoning, token IDs, log probabilities, copied-context ranges, continuation links, inactive leaves, and old generations are omitted unless the public source proves them. Each omission has a stable receipt code.
