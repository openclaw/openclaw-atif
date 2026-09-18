#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const [output, fixture] = process.argv.slice(2);
const raw = await readFile(join(output, "trajectory.json"));
const trajectory = JSON.parse(raw);
const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8"));
const events = (await readFile(join(fixture, "root/events.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(receipt.status, "complete");
assert.deepEqual(receipt.diagnostics, []);
assert.equal(createHash("sha256").update(raw).digest("hex"), receipt.output.trajectorySha256);
assert.deepEqual(
  trajectory.extra.openclaw.runtime.events,
  events.filter((event) => event.source === "runtime" && event.type !== "context.compiled"),
);
assert.equal(trajectory.extra.openclaw.runtime.event_type_counts["provider.prompt.observed"], 3);
assert.equal(trajectory.steps.length, 4);
assert.equal(receipt.familyMetrics.promptTokens, 15);
assert.equal(receipt.familyMetrics.completionTokens, 7);
assert.equal(receipt.familyMetrics.cachedTokens, 3);
assert.equal(receipt.familyMetrics.costUsd, 0.003);
for (const name of ["trajectory.json", "receipt.json"])
  assert.equal((await stat(join(output, name))).mode & 0o777, 0o600);
console.log(
  "Installed CLI retained all three provider prompt observations with unchanged steps and metrics.",
);
