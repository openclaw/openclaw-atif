#!/usr/bin/env bash
set -euo pipefail

HARBOR_COMMIT=74cc6312018c349c6bd2400c89a0ac4983ac1085
PYDANTIC_VERSION=2.12.5
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

if [[ -n "${HARBOR_SOURCE:-}" ]]; then
  HARBOR_ROOT="$HARBOR_SOURCE"
else
  HARBOR_ROOT="$TEMP_ROOT/harbor-$HARBOR_COMMIT"
  git init --quiet "$HARBOR_ROOT"
  git -C "$HARBOR_ROOT" remote add origin https://github.com/harbor-framework/harbor.git
  git -C "$HARBOR_ROOT" fetch --quiet --depth 1 origin "$HARBOR_COMMIT"
  git -C "$HARBOR_ROOT" checkout --quiet FETCH_HEAD
fi

test "$(git -C "$HARBOR_ROOT" rev-parse HEAD)" = "$HARBOR_COMMIT"

python3 -m venv "$TEMP_ROOT/venv"
"$TEMP_ROOT/venv/bin/python" -m pip install --quiet "pydantic==$PYDANTIC_VERSION"
"$TEMP_ROOT/venv/bin/python" -m pip install --quiet --no-deps "$HARBOR_ROOT"
mapfile -t TRAJECTORIES < <(find fixtures/golden -type f -name 'trajectory.json' -print | sort)
"$TEMP_ROOT/venv/bin/python" scripts/validate-harbor.py "$HARBOR_ROOT" "${TRAJECTORIES[@]}"
