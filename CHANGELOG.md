# Changelog

## Unreleased

- Add receipt accounting coverage by node, model, and observed assistant message,
  preserving missing values versus zero independently of capture completeness.
- Retain a relocatable, checksum-verified conversion graph with public source
  bundles, including capture diagnostics and stability for offline replay.

## 0.1.2 — 2026-09-21

- Prepare the first functional `@openclaw/openclaw-atif` release from the OpenClaw
  organization while retaining the `openclaw-atif` CLI command.
- Add CodeQL analysis and publish the exact smoke-tested npm tarball with provenance
  and registry integrity verification.
- Stop the owned OpenClaw process group on POSIX cancellation, timeout, or output
  overflow, and wait for inherited pipes to close before removing private staging.
- Omit unobserved LLM call counts instead of treating every assistant transcript
  entry, including local delivery mirrors, as a model call.
- Add repository ownership, contribution and security guidance, issue and pull
  request templates, dependency-update configuration, and the canonical autoreview skill.
- Update checkout to v7.0.1 in CI, CodeQL analysis, and publishing.
- Resume interrupted legacy journal adoption when both marker names identify the same verified file.
- Preserve implicit empty legacy agent rosters for OpenClaw's main-agent migration.
- Recover verified v0.1.1 transactions created with trailing-slash destinations without touching ambiguous backups.
- Confine legacy migration and subsequent capture to a private config and environment,
  parse JSON5 selectors, validate public migration reports, and require targeted migration support.
- Serialize file and directory writers through a canonical destination lock, preserve recovery
  state during contention, and prevent no-force file commits from replacing concurrent output.
- Preserve own `__proto__` JSON keys through bundle loading, tool arguments, validation, and serialization.
- Update TypeScript to 6.0.3, retaining the compiler API used by lint and mutation checks.
- Align agent-only reasoning effort and zero-call dispatch validation with the pinned Harbor schema.
- Update Zod to 4.6.5 while preserving minute-precision timestamps in the public ATIF validator.
- Preserve media references with mixed-case HTTP, HTTPS, and data URI schemes.
- Accept contained paths whose components begin with two dots without allowing parent traversal.
- Reject capture cycles back to the selected root for every relationship kind.
- Skip non-file PATH entries when resolving the OpenClaw executable.
- Refresh Node.js declarations to 24.13.6 while retaining the supported Node.js 24 API boundary.
- Preserve cancellation during OpenClaw capability probing instead of reporting missing export support.
- Read bundle and media files through one bounded descriptor lifecycle, rejecting leaf replacement and detected file mutations
  and enforcing the bundle's aggregate byte limit before each read.
- Stop Harbor validation when fixture discovery fails, including after partial results.
- Update setup-python to v7.0.0 for CI and publishing validation with Python 3.12.
- Encode real-OpenClaw smoke fixture paths safely as JSON.
- Serialize npm publication and reject stale release versions before they can move `latest` backwards.
- Update setup-node to v7.0.0 in CI and publishing while retaining the Node.js 24 runtime.
- Preserve leading and trailing whitespace in CLI paths, including forced output replacement.
- Report invalid CLI arguments as concise errors with exit code 1 and no leaked signal listeners.
- Refresh Biome, ESLint, typescript-eslint, and slophammer development validation tools.

## 0.1.1 — 2026-09-18

- Preserve provider prompt observations from OpenClaw public trajectory bundles.

This tag predates the move to `@openclaw/openclaw-atif`; it is retained unchanged.
