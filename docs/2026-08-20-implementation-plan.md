---
title: "OpenClaw ATIF implementation plan"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-08-20"
---

# OpenClaw ATIF implementation plan

## Goal

Update the existing TypeScript library and CLI to emit Harbor ATIF-v1.8 and retain supported image and audio media. This is the package upgrade selected on September 17, 2026. Making Harbor call the package is a later task.

OpenClaw owns access to legacy JSONL and current SQLite storage. This package continues to consume only documented session-list JSON and `openclaw-trajectory` schema-v1 bundles.

The canonical requirements are the [export contract](2026-08-20-export-contract.md), [mapping specification](2026-08-20-openclaw-to-atif.md), and [compatibility rules](2026-08-20-compatibility.md). Preserve the existing library and CLI as one shared conversion path.

## Runtime event follow-up

The September 18, 2026 follow-up fixes partial exports caused by `provider.prompt.observed` in published OpenClaw 2026.9.3. Use one shared event policy for normalization and mapping. Keep observed provider-prompt metadata in each trajectory's ordered runtime event list without adding dialogue steps or changing metrics. Retain unknown and malformed events, but keep their partial-output diagnostics. Replace `terminal_events` with the general `events` field in the existing output contract; do not add a compatibility reader or a second converter.

Add a synthetic public-bundle fixture based on the exact released source contract. Cover metadata identity and order, multiple runs and child sessions, mismatches, additional fields, malformed observations, unknown events, truncation, deterministic bytes, complete/partial CLI exits, and installed-package behavior. Run the repository checks and the requested legacy implementation review before delivery. A new npm release requires separate approval. After that release, Harbor must pin it and repeat the isolated Luna trial; this package-only change does not claim a live-model pass.

The original ATIF 1.8 plan and its task boundaries are recorded below.

## Architecture

1. Probe an explicit official `openclaw` executable and its public commands.
2. Resolve an exact root session key or a unique concrete session ID.
3. List all sessions and export the root through `openclaw sessions export-trajectory`.
4. Discover descendants from typed listing lineage and exact structured `sessions_spawn` results.
5. Export descendants breadth-first with fixed limits.
6. List sessions again and retry the full capture when relevant facts changed.
7. Normalize bundles into one storage-neutral `SessionFamilySnapshot`.
8. Convert the snapshot into one recursive ATIF-v1.8 trajectory and retain eligible media under the output's `media/` directory.
9. Validate and write `trajectory.json`, `receipt.json`, and retained media through one owner-only atomic transaction.

The CLI also converts already captured bundles without running OpenClaw.

## Compatibility

Keep OpenClaw trajectory bundle schema v1 and replace the existing ATIF-v1.7 output with ATIF-v1.8. Update the schema, receipts, fixtures, and documentation in place. Do not add a parallel converter or an ATIF-v1.7 compatibility mode.

OpenClaw 2026.7.1-2 provides the public export over legacy JSONL. OpenClaw 2026.8.1-beta.2 and current releases provide it over SQLite. Older archives can use an explicit migration-on-copy path with a caller-selected official OpenClaw executable. The copy uses targeted session migration commands when available and a documented non-interactive repair plus public-list verification otherwise. The original state is never modified.

Unknown bundle or ATIF versions fail closed.

## Media upgrade

Add ATIF-v1.8 audio content and source validation alongside supported image content. Apply the same mapping to user messages, assistant messages, and tool results. Preserve declared media types and locations, normalize supported aliases, and retain observed audio duration when valid.

Bring the media-retention behavior from [Harbor PR #2327](https://github.com/harbor-framework/harbor/pull/2327), inspected at commit `01a6558ca1626d985c984e826c3b9d48034919e2`, into this package. Use Harbor's converter and tests as read-only references and preserve any required license notices if code is copied.

Resolve local media within its own session bundle. Preserve containment, symlink, regular-file, size, and file-count checks. Copy eligible files into the atomic output transaction, name them by content, and reuse retained files for repeated references. Output must remain usable after temporary source cleanup. The export contract sets the limits and path rules.

Preserve supported external references without downloading media. Missing, unsafe, unsupported, over-limit, or failed copies must produce stable receipt diagnostics and a partial export. Keep the package's existing rule against invented placeholder content.

Keep exact child-generation and relationship checks, stable before-and-after capture checks, observed context events, cache-write accounting, per-session metrics, the separately scoped family aggregate, and deterministic receipts. The media port must not replace these rules with Harbor's different conversion behavior.

## Identity and lineage

A `sessionKey` is a logical routing identity. A `sessionId` is one concrete transcript generation. A `leafId` identifies the exported active branch.

A trajectory ID is a domain-separated hash of the bundle schema, session key, session ID, leaf ID, ATIF version, and export profile.

Typed listing fields can prove that a child exists and identify its parent. Only an exact structured `sessions_spawn` result tied to a tool call can create an ATIF subagent reference. Listing-only children remain embedded but unresolved, and the receipt marks the family partial.

Native subagents and ACP children are separate relationship kinds. Forks, visible sessions, cron runs, adopted sessions, and rotations are not relabeled as subagents.

## Truthful mapping

The mapper preserves observed user and assistant content, reasoning, model data, tool calls and results, timestamps, usage, cost, errors, fallback events, compaction, branch summaries, labels, and custom events when the public bundle provides them.

Tool calls and results pair only by exact call ID. Orphan results use no source call ID and produce a warning.

The mapper does not invent placeholder messages, timestamps, retries, rewards, copied-context ranges, continuation edges, hidden reasoning, or external-harness internals.

Each trajectory reports only its own metrics. The receipt reports a separately scoped, deduplicated family aggregate.

## Completeness

A complete export requires stable before-and-after listings, all required bundles, valid schemas, resolved required relationships, retained or valid external media references, and successful ATIF validation. Media omissions must make the export partial.

A partial export is valid ATIF with explicit omissions. It exits with status 2. Strict mode rejects partial output.

The receipt records source versions, hashes, selected leaves, redaction, warnings, omissions, unresolved relationships, metric scopes, validator results, and the output hash.

## Security and durability

OpenClaw bundles are already best-effort redacted support artifacts. This package records that boundary and can apply an additional named deterministic transform.

Temporary and output directories use mode `0700`. Files, including retained media, use mode `0600`. Subprocesses never use a shell. Final output uses same-filesystem staging, fsync, and atomic replacement. Include media in the existing transaction validation and hashes. Identical output is an idempotent success. Different output requires an explicit force option.

Captured bundles and migration copies are removed unless the caller explicitly retains source bundles. Final media references must remain usable after that cleanup.

## Verification

Use synthetic fixtures for automated checks. Keep coverage for legacy and SQLite exports, native and ACP descendants, compaction, rotations, forks, missing spawn results, active changes, malformed bundles, interruption, permissions, and deterministic output.

Add coverage for mixed and media-only content, audio aliases and duration, valid and invalid source/type combinations, missing and unsupported media, escape paths, symlinks, non-regular files, repeated references, size and file-count limits, copy failures, and deterministic retained files. Exercise both the library and installed CLI. Remove temporary input bundles and confirm that the resulting trajectories and local media references still load.

Update the golden artifacts and validate them locally and through Harbor's Pydantic trajectory model, `TrajectoryValidator`, and consumer loader. Pin the conformance check to an immutable upstream Harbor revision with ATIF-v1.8 support, as specified in the compatibility document.

Run `npm run check`, `npm run slophammer`, `npm run validate:harbor`, and `npm run smoke:cli`. Keep `npm run mutate` available and follow the repository's mutation-check requirements. Preserve the existing package, type, lint, coverage, audit, and installed-CLI checks.

Review the pushed task head against `main` with `pi-reviewer --base main`, address actionable findings and PR comments, and verify CI. Report exact verification commands and their outcomes. Distinguish unit and fixture checks, installed-CLI checks, real OpenClaw runs, and live-model runs, and state any untested limits.

## Boundaries

Only this package and its task-related documentation, fixtures, and tests change. Keep it a standalone library and CLI. Do not modify OpenClaw, Harbor, harbor-hf, or the ATIF specification. Do not add a native plugin, daemon, database, telemetry service, upload path, direct JSONL reader, or direct SQLite reader.

Do not weaken the existing correctness checks to match Harbor's converter. Do not fetch remote media or copy unrelated sandbox files.

Finish with a tested, reviewed pull request ready for a maintainer decision. Do not merge, publish an npm or GitHub release, deploy, or transfer the repository in this task. Package version `0.1.0` does not establish that a release exists. Harbor integration and any move into the OpenClaw organization remain separate work.
