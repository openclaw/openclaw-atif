import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAtifTrajectory } from "../src/atif/schema.js";
import { convertOpenClawBundles } from "../src/exporter.js";

for (const name of ["legacy-jsonl", "sqlite", "media", "provider-prompts"] as const) {
  describe(`golden ${name}`, () => {
    it("is deterministic and schema-valid", async () => {
      const fixture = join(process.cwd(), "fixtures", "bundles", name);
      const expectedRoot = join(process.cwd(), "fixtures", "golden", name);
      const output = join(await mkdtemp(join(tmpdir(), "openclaw-atif-golden-")), name);
      await convertOpenClawBundles({
        graph: join(fixture, "graph.json"),
        bundleRoot: fixture,
        output,
      });
      const actualTrajectory = await readFile(join(output, "trajectory.json"), "utf8");
      const actualReceipt = await readFile(join(output, "receipt.json"), "utf8");
      expect(actualTrajectory).toBe(await readFile(join(expectedRoot, "trajectory.json"), "utf8"));
      expect(actualReceipt).toBe(await readFile(join(expectedRoot, "receipt.json"), "utf8"));
      validateAtifTrajectory(JSON.parse(actualTrajectory) as unknown);
      if (name === "media") {
        const media = await readdir(join(output, "media"));
        expect(media).toEqual(await readdir(join(expectedRoot, "media")));
        for (const file of media)
          expect(await readFile(join(output, "media", file))).toEqual(
            await readFile(join(expectedRoot, "media", file)),
          );
      }
    });
  });
}
