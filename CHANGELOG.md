# Changelog

## Unreleased

- Stop the owned OpenClaw process group on POSIX cancellation, timeout, or output
  overflow, and wait for inherited pipes to close before removing private staging.
- Omit unobserved LLM call counts instead of treating every assistant transcript
  entry, including local delivery mirrors, as a model call.
- Add repository ownership, contribution and security guidance, issue and pull
  request templates, dependency-update configuration, and the canonical autoreview skill.

## 0.1.1 — 2026-09-18

- Preserve provider prompt observations from OpenClaw public trajectory bundles.

This tag predates the move to `@openclaw/openclaw-atif`; it is retained unchanged.
