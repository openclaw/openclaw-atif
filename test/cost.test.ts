import { describe, expect, it } from "vitest";
import { mapFamilyToAtif } from "../src/atif/mapper.js";
import type { NormalizedNode, SessionFamilySnapshot } from "../src/models/family.js";
import { buildReceipt } from "../src/receipt.js";
import { event } from "./helpers.js";

function node(key: string, usages: Record<string, unknown>[]): NormalizedNode {
  return {
    bundleDirectory: "/unused",
    key,
    sessionId: key,
    leafId: null,
    row: { key, sessionId: key },
    transcriptEvents: usages.map((usage, index) =>
      event({
        seq: index + 1,
        source: "transcript",
        type: "assistant.message",
        sessionId: key,
        entryId: `${key}-${String(index)}`,
        data: { message: { role: "assistant", content: "Observed answer", usage } },
      }),
    ),
    runtimeEvents: [],
    exportEvents: [],
    childRelationships: [],
    bundleWarnings: [],
    sourceHashes: {},
    diagnostics: [],
  };
}

async function costs(root: Record<string, unknown>[], child: Record<string, unknown>[] = []) {
  const family: SessionFamilySnapshot = {
    rootKey: "root",
    openclawVersion: "test-version",
    profile: "openclaw-support-v1",
    nodes: new Map([
      ["root", node("root", root)],
      ["child", node("child", child)],
    ]),
    relationships: [],
    diagnostics: [],
    stable: true,
    listingBeforeHash: "same",
    listingAfterHash: "same",
  };
  const mapped = await mapFamilyToAtif(family);
  const receipt = buildReceipt({ family, ...mapped });
  return { mapped, receipt };
}

describe("cost completeness", () => {
  it.each([
    { input: 5 },
    { output: 5 },
    { cacheRead: 5 },
    { cacheWrite: 5 },
    { input: 5, cost: -1 },
    { input: 5, cost: { total: "unknown" } },
  ])("omits a subtotal when a step has unpriced usage: %j", async (unpriced) => {
    const { mapped, receipt } = await costs([{ input: 2, cost: 1 }, unpriced]);
    expect(mapped.trajectory.steps[0]?.metrics?.cost_usd).toBe(1);
    expect(mapped.trajectory.final_metrics?.total_cost_usd).toBeUndefined();
    expect(receipt.familyMetrics.costUsd).toBeUndefined();
  });

  it.each([false, true])("omits family cost for an unpriced node (reverse=%s)", async (reverse) => {
    const known = [{ input: 2, cost: 1 }];
    const unknown = [{ output: 3 }];
    const { mapped, receipt } = await costs(reverse ? unknown : known, reverse ? known : unknown);
    expect(mapped.nodeMetrics.get(reverse ? "child" : "root")?.total_cost_usd).toBe(1);
    expect(receipt.familyMetrics).toEqual({ steps: 2, promptTokens: 2, completionTokens: 3 });
  });

  it("sums fully priced nodes, including explicit zero", async () => {
    const { mapped, receipt } = await costs(
      [{ input: 2, cost: { total: 0 } }],
      [{ output: 3, cost: 1 }],
    );
    expect(mapped.trajectory.final_metrics?.total_cost_usd).toBe(0);
    expect(receipt.familyMetrics.costUsd).toBe(1);
  });

  it("does not turn wholly unknown cost into zero", async () => {
    const { receipt } = await costs([{ input: 2 }], [{ output: 3 }]);
    expect(receipt.familyMetrics.costUsd).toBeUndefined();
  });

  it("does not discard known cost for empty or zero-token observations", async () => {
    const { receipt } = await costs([{ input: 2, cost: 1 }, {}], [{ input: 0, output: 0 }]);
    expect(receipt.familyMetrics.costUsd).toBe(1);
  });
});
