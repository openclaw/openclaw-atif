---
title: "Export contract"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-08-20"
---

# Export contract

## Commands

`openclaw-atif export` captures a session family through an official OpenClaw executable.

`openclaw-atif convert` converts existing OpenClaw trajectory bundles and a graph manifest.

Both commands call the same normalization, mapping, validation, and writer code.

## Outputs

The output directory contains:

- `trajectory.json`: one recursive ATIF-v1.8 document.
- `receipt.json`: source, completeness, privacy, metric, and validation evidence.
- `media/`: retained image and audio files, when present.

Local media paths in the trajectory are relative to this output directory. For example:

```text
output/
  trajectory.json
  receipt.json
  media/
    <content-hash>.png
    <content-hash>.wav
```

ATIF-v1.8 replaces the package's previous ATIF-v1.7 output in place. The library and CLI keep one conversion path.

Complete output exits 0. Committed partial output exits 2. Fatal failure exits 1. Signal exits follow operating-system conventions.

## Source requirements

A bundle must contain regular, non-symlink files named `manifest.json`, `events.jsonl`, and `session-branch.json`.

The manifest must declare `traceSchema: openclaw-trajectory` and `schemaVersion: 1`. Counts and session identity must match the loaded events. Unknown versions are rejected.

Optional metadata, artifacts, prompts, system prompt, and tools files are loaded only when the manifest lists them.

Receipts hash stable source files directly. OpenClaw regenerates top-level `generatedAt` fields in the manifest, metadata, artifacts, and prompts captures. Receipts use named semantic hashes for those files after they remove only that volatile field. Raw bundle files remain private staging artifacts unless the caller explicitly keeps them.

## Media retention

Retain supported image and audio references in user messages, assistant messages, and tool results. The [mapping specification](2026-08-20-openclaw-to-atif.md#media) defines their ATIF fields and accepted media types.

Resolve a relative local path from the containing session's export bundle. An absolute path is eligible only when it resolves inside that same bundle. Reject symlinks, paths outside the bundle, missing files, and non-regular files. Do not copy configuration, credentials, or unrelated sandbox files.

Copy eligible files into the output's `media/` directory before temporary bundles are removed. Name retained files from their content and reuse an existing retained file for repeated references. Across the whole family, retain at most 64 files, each at most 32 MiB. Referencing a retained file again does not consume another file slot and remains allowed after the limit is reached.

Keep supported `http://`, `https://`, and `data:` locations as references after media-type validation. Do not download remote media. An inline base64 content block without a supported source location remains unsupported.

When media is missing, unsafe, unsupported, above a limit, or cannot be copied, omit that content with a stable receipt diagnostic and mark the export partial. Preserve other observed content without adding a placeholder message or leaving a dangling local path.

## Completeness states

- `complete`: the family was stable and all required facts and references were exported and validated.
- `partial`: valid output exists, but one or more source facts, descendants, references, leaves, generations, or runtime events were unavailable. Explicit OpenClaw truncation or dropped-field markers also cause this state. Capture retries transient session-generation and disappearing-child races before it emits this state.
- `failed`: no final output was committed.

Schema validity does not imply completeness. Runtime events with unknown types or malformed supported payloads remain in trajectory metadata and make the export partial. Preserving unknown data does not prove that its meaning was converted. A valid `provider.prompt.observed` event that reports a prompt mismatch does not by itself make the export partial; completeness describes the export, not whether the source run behaved correctly.

## Privacy

OpenClaw's public bundle is support-redacted and bounded. The package does not recover removed values. It does not upload output.

The default profile is `openclaw-support-v1`. Additional profiles must be deterministic and named in the receipt.

## Writes

Directories use mode `0700` and files use mode `0600`. The trajectory, receipt, and retained media are validated and committed in one atomic output transaction in the destination filesystem. Retained media must participate in the transaction's file validation and hashes. A successful export must remain usable after source bundles and temporary state are removed.

A destination write or sync failure aborts the output transaction. It does not commit a trajectory with missing media. Source media that cannot be read or retained is diagnosed before the transaction and can produce a partial export.

Recovery only touches package-owned transactions whose identity and expected hashes verify. If export and sensitive-staging cleanup both fail, the returned error reports both failures.
