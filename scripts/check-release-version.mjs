#!/usr/bin/env node

function stableVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? ""))
    throw new Error(`Expected a stable version, received ${String(value)}`);
  const parts = value.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Version component exceeds safe range");
  return parts;
}

const candidate = stableVersion(process.argv[2]);
const latest = stableVersion(process.argv[3]);
const difference = candidate.map((part, index) => part - latest[index]).find((part) => part !== 0);
if (difference === undefined || difference < 0)
  throw new Error("Release version must be newer than npm latest");
