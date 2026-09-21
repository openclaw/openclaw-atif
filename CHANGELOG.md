# Changelog

## Unreleased

- Encode real-OpenClaw smoke fixture paths safely as JSON.
- Serialize npm publication and reject stale release versions before they can move `latest` backwards.
- Preserve leading and trailing whitespace in CLI paths, including forced output replacement.
- Report invalid CLI arguments as concise errors with exit code 1 and no leaked signal listeners.

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

## 0.1.1 — 2026-09-18

- Preserve provider prompt observations from OpenClaw public trajectory bundles.

This tag predates the move to `@openclaw/openclaw-atif`; it is retained unchanged.
