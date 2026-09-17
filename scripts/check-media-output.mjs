import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
const trajectory = JSON.parse(await readFile(join(root, "trajectory.json"), "utf8"));
const receipt = JSON.parse(await readFile(join(root, "receipt.json"), "utf8"));
assert.equal(trajectory.schema_version, "ATIF-v1.8");
assert.equal(receipt.status, "complete");
const content = trajectory.steps.flatMap((step) => [
  step.message,
  ...(step.observation?.results.map((result) => result.content) ?? []),
]);
const parts = content
  .flatMap((value) => (Array.isArray(value) ? value : []))
  .filter((part) => part.type !== "text");
assert.equal(parts.length, 5);
assert.equal((await readdir(join(root, "media"))).length, 2);
for (const part of parts) {
  const match = /^media\/([0-9a-f]{64})\.(png|wav)$/.exec(part.source.path);
  assert.ok(match);
  const path = join(root, part.source.path);
  const bytes = await readFile(path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), match[1]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
}
console.log(
  `Installed CLI: ATIF 1.8 and ${parts.length} media references verified after input cleanup (${process.version}).`,
);
