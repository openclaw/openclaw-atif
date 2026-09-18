#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"
NODE="${npm_node_execpath:-node}"
NPM="$(command -v npm)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

PACKAGE="$("$NODE" "$NPM" pack --silent --pack-destination "$TEMP_ROOT" | tail -n 1)"
mkdir -p "$TEMP_ROOT/install"
"$NODE" "$NPM" install --silent --omit=dev --ignore-scripts --prefix "$TEMP_ROOT/install" "$TEMP_ROOT/$PACKAGE"
CLI="$TEMP_ROOT/install/node_modules/.bin/openclaw-atif"
"$NODE" "$CLI" --help >/dev/null
"$NODE" "$CLI" --version >/dev/null
"$NODE" "$CLI" convert \
  --graph "$ROOT/fixtures/bundles/legacy-jsonl/graph.json" \
  --bundle-root "$ROOT/fixtures/bundles/legacy-jsonl" \
  --output "$TEMP_ROOT/output" \
  --json >/dev/null
test -f "$TEMP_ROOT/output/trajectory.json"
test -f "$TEMP_ROOT/output/receipt.json"
test "$(file_mode "$TEMP_ROOT/output")" = "700"
test "$(file_mode "$TEMP_ROOT/output/trajectory.json")" = "600"

cp -R "$ROOT/fixtures/bundles/media" "$TEMP_ROOT/input"
"$NODE" "$CLI" convert \
  --graph "$TEMP_ROOT/input/graph.json" \
  --bundle-root "$TEMP_ROOT/input" \
  --output "$TEMP_ROOT/media-output" \
  --require-complete --json >/dev/null
rm -rf "$TEMP_ROOT/input"
"$NODE" "$ROOT/scripts/check-media-output.mjs" "$TEMP_ROOT/media-output"
test "$(file_mode "$TEMP_ROOT/media-output/media")" = "700"

cp -R "$ROOT/fixtures/bundles/provider-prompts" "$TEMP_ROOT/input"
"$NODE" "$CLI" convert \
  --graph "$TEMP_ROOT/input/graph.json" \
  --bundle-root "$TEMP_ROOT/input" \
  --output "$TEMP_ROOT/runtime-output" \
  --require-complete --json >/dev/null
rm -rf "$TEMP_ROOT/input"
"$NODE" "$ROOT/scripts/check-runtime-output.mjs" \
  "$TEMP_ROOT/runtime-output" "$ROOT/fixtures/bundles/provider-prompts"
