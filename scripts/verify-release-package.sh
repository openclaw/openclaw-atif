#!/usr/bin/env bash
set -euo pipefail
PACKAGE_NAME="$(node -p 'require("./package.json").name')"
PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
PACKAGE_SPEC="$PACKAGE_NAME@$PACKAGE_VERSION"
pending="package metadata"
for attempt in {1..120}; do
  if npm view "$PACKAGE_SPEC" --prefer-online --json >"$RUNNER_TEMP/npm-package.json" 2>"$RUNNER_TEMP/npm-view-error"; then
    set +e
    node scripts/check-release-package.mjs "$RUNNER_TEMP/npm-package.json" --require-provenance
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      LATEST_VERSION="$(npm view "$PACKAGE_NAME" dist-tags.latest --prefer-online)"
      if [[ "$LATEST_VERSION" != "$PACKAGE_VERSION" ]]; then
        echo "npm latest points to $LATEST_VERSION instead of $PACKAGE_VERSION" >&2
        exit 1
      fi
      exit 0
    fi
    if [[ "$status" -ne 75 ]]; then
      exit "$status"
    fi
    pending="provenance metadata"
  elif grep -q "E404" "$RUNNER_TEMP/npm-view-error"; then
    pending="package metadata"
  else
    cat "$RUNNER_TEMP/npm-view-error" >&2
    exit 1
  fi
  if [[ "$attempt" -lt 120 ]]; then
    echo "Waiting for $pending (attempt $attempt/120)"
    sleep 5
  fi
done
echo "$PACKAGE_SPEC did not expose $pending after 120 attempts" >&2
exit 1
