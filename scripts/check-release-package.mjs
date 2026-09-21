#!/usr/bin/env node
import { readFileSync } from "node:fs";

const published = JSON.parse(readFileSync(process.argv[2], "utf8"));
const expected = JSON.parse(readFileSync("package.json", "utf8"));

if (published.name !== expected.name || published.version !== expected.version) {
  throw new Error("Published package identity differs");
}
if (
  published.dist?.integrity !== process.env.PACKAGE_INTEGRITY ||
  published.dist?.shasum !== process.env.PACKAGE_SHASUM
) {
  throw new Error("Published bytes differ from the smoke-tested tarball");
}
if (process.argv.includes("--require-provenance") && !published.dist.attestations?.provenance) {
  console.error("Published package provenance is not visible yet");
  process.exitCode = 75;
}
