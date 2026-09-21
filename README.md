# OpenClaw ATIF

OpenClaw ATIF is a TypeScript library and CLI for exporting OpenClaw session families as Harbor ATIF trajectories.
It uses OpenClaw's public trajectory bundles, includes linked native and ACP subagents, and reports missing source facts without inventing them.

## Install

Install the CLI from npm:

```bash
npm install --global @openclaw/openclaw-atif
```

For library use, add it to your project:

```bash
npm install @openclaw/openclaw-atif
```

Node.js 24.11 or newer in the Node.js 24 release line is required.

Live OpenClaw capture uses POSIX executables and owner-only filesystem permissions
on Linux, macOS, or WSL. Native Windows capture is not yet qualified: it needs
launcher resolution, process-tree cancellation, and permission verification.
This does not restrict the library's in-memory trajectory mapping APIs.

## Export a session family

Select the root by its exact OpenClaw session key:

```bash
openclaw-atif export \
  --session-key "agent:main:main" \
  --output ./openclaw-trajectory
```

You can also select a unique concrete session ID:

```bash
openclaw-atif export \
  --session-id "<session-id>" \
  --output ./openclaw-trajectory
```

The output directory contains:

```text
trajectory.json
receipt.json
media/          # retained image/audio files, when present
```

`trajectory.json` is ATIF-v1.8. `receipt.json` states whether the export is complete or partial and lists source limits, redaction, unresolved relationships, hashes, and metric scopes.

Supported bundle-local media is copied into `media/` and referenced by relative paths. Keep this directory beside `trajectory.json`. Retention is limited to 64 files per family and 32 MiB per file. Remote references are not downloaded. Missing, unsafe, or unsupported media makes the output partial.

Writers lock the canonical destination, including when reached through a parent
directory alias or a trailing slash. A competing writer fails with the lock path
and owner. A hard crash leaves the lock in place: verify that the named process
has terminated, remove only that exact lock, and retry to recover the transaction.
Locks are never stolen based on age or a PID check. Directory replacement is
serialized between OpenClaw ATIF writers; an unrelated process creating an empty
destination directory during the final rename remains outside that guarantee.

Use `--require-complete` when partial output is not acceptable:

```bash
openclaw-atif export \
  --session-key "agent:main:main" \
  --output ./openclaw-trajectory \
  --require-complete
```

## Convert existing OpenClaw bundles

Use quiescent local bundle directories whose parent directories you control.
File snapshot and symlink checks detect leaf replacement and file mutations;
pathname checks provide no filesystem sandbox against concurrent ancestor changes.

Create a bundle graph that names the root and each captured bundle:

```json
{
  "schema": "openclaw-atif-bundle-graph-v1",
  "rootKey": "agent:main:main",
  "openclawVersion": "<version>",
  "nodes": [
    {
      "sessionKey": "agent:main:main",
      "bundleDir": "root"
    },
    {
      "sessionKey": "agent:main:subagent:child",
      "bundleDir": "child",
      "parentKey": "agent:main:main",
      "relationshipKind": "native-subagent",
      "toolCallId": "spawn-call-id"
    }
  ]
}
```

Then convert it:

```bash
openclaw-atif convert \
  --graph ./graph.json \
  --bundle-root ./bundles \
  --output ./openclaw-trajectory
```

## Legacy JSONL archives

OpenClaw versions with `sessions export-trajectory` own their JSONL or SQLite storage and need no special handling.

For an older archive without that command, use explicit migration-on-copy. This copies the state into private temporary storage, validates a separate JSON5-derived config, runs OpenClaw's targeted session migration commands, verifies the public session listing, exports it, and removes the copy:

```bash
openclaw-atif export \
  --session-key "agent:main:main" \
  --openclaw /path/to/source-era/openclaw \
  --migrate-copy \
  --legacy-state-dir /path/to/legacy-state \
  --migration-openclaw /path/to/current-official-openclaw \
  --output ./openclaw-trajectory
```

The migration executable must support `config validate --json` and targeted
`doctor --session-sqlite` operations with `--session-sqlite-all-agents`. Unsupported
versions fail with an upgrade instruction; broad `doctor --fix` is never used.
Config selectors must be self-contained: resolve includes and environment
substitutions first. The copy uses a private home, working directory, temporary
directory, and config with plugins disabled. Original workspace, agent-directory,
logging, and environment paths are excluded. This preserves the source state;
it is not an operating-system sandbox for the selected OpenClaw executable.

Hosted CI exercises real migration and export with pinned OpenClaw `2026.9.5`,
synthetic legacy data, and unchanged original config/home/workspace sentinels.

## Source and privacy limits

OpenClaw trajectory bundles are redacted support artifacts. They can omit inactive transcript branches, old session generations, removed runtime events, images, secrets, and internal activity from external ACP harnesses.

OpenClaw ATIF keeps these limits in the receipt. It does not upload trajectories or recover removed values.

A child session is linked to a parent tool result only when the public source contains an exact structured `sessions_spawn` relationship. Listing-only descendants can still be included, but the export is marked partial.

## Library

```ts
import { exportOpenClawFamily } from "@openclaw/openclaw-atif";

const result = await exportOpenClawFamily({
  executable: "openclaw",
  sessionKey: "agent:main:main",
  output: "./openclaw-trajectory",
  requireComplete: true,
});

console.log(result.receipt.output.trajectorySha256);
```

## License

[MIT](LICENSE)
