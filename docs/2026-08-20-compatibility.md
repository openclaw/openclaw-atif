---
title: "Compatibility"
author: "Onur Solmaz <2453968+osolmaz@users.noreply.github.com>"
date: "2026-08-20"
---

# Compatibility

## OpenClaw

The first release consumes the documented `openclaw-trajectory` bundle schema v1.

Required compatibility coverage includes:

- OpenClaw 2026.7.1-2 with legacy JSONL storage.
- OpenClaw 2026.8.1-beta.2 with SQLite storage.
- A pinned current OpenClaw release.

The package does not interpret either storage layout. It invokes the OpenClaw version that owns the state and consumes its public bundle.

For an older archive without the export command, migration-on-copy uses a caller-selected official migration-capable OpenClaw executable. It uses the documented session SQLite inspect, dry-run, import, and validate sequence when available. Older command surfaces use documented non-interactive repair followed by a public session-list verification.

Before any migration command runs, a configured absolute `session.store` inside the source tree is rewritten to the corresponding copied path. Relative, unparseable, or external store targets are rejected. Migration commands cannot operate on the original store through copied configuration.

## ATIF and Harbor

The selected package output is ATIF-v1.8. It replaces ATIF-v1.7 output without a second converter or compatibility mode. OpenClaw bundle schema v1 remains unchanged.

ATIF-v1.8 adds audio content and `AudioSource` validation. Harbor merged it in [PR #2605](https://github.com/harbor-framework/harbor/pull/2605), commit `74cc6312018c349c6bd2400c89a0ac4983ac1085`, on August 26, 2026. It first shipped in [Harbor v0.23.0](https://github.com/harbor-framework/harbor/releases/tag/v0.23.0) on September 12, 2026.

Runtime validation stays local. Pin Harbor conformance checks to an immutable upstream revision that includes ATIF-v1.8. Validate the updated fixtures with Harbor's Pydantic trajectory model, `TrajectoryValidator`, and a real consumer load. Include retained media and verify that local references still resolve after source-bundle cleanup.

Adding a new OpenClaw bundle or ATIF version requires updated fixtures and repeated Harbor conformance tests before publication. This task updates the unpublished package and its pull request. It does not authorize a package release.

Report fixture tests, installed-CLI tests, real OpenClaw runs, and live-model runs separately. A scripted fixture or model response does not establish live-model coverage.
