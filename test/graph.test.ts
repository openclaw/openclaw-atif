import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCapturedFamilyFromGraph, parseBundleGraph } from "../src/capture/graph.js";
import type { BundleGraphManifest } from "../src/models/family.js";
import { childEvents, rootEvents, writeBundle } from "./helpers.js";

describe("bundle graph", () => {
  it("rejects malformed graph fields", () => {
    expect(() => parseBundleGraph(null)).toThrow("schema");
    expect(() => parseBundleGraph({ schema: "wrong" })).toThrow("schema");
    expect(() => parseBundleGraph({ schema: "openclaw-atif-bundle-graph-v1", nodes: [] })).toThrow(
      "identity",
    );
    expect(() =>
      parseBundleGraph({
        schema: "openclaw-atif-bundle-graph-v1",
        rootKey: "root",
        openclawVersion: "test",
        nodes: [{ sessionKey: "root", bundleDir: "bundle", relationshipKind: "bad" }],
      }),
    ).toThrow("relationshipKind");
  });

  it("rejects absolute and escaping bundle paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-graph-"));
    const outside = await mkdtemp(join(tmpdir(), "openclaw-atif-outside-"));
    await writeBundle({
      root: outside,
      name: "bundle",
      sessionId: "s",
      sessionKey: "root",
      events: childEvents("s"),
    });
    for (const bundleDir of [join(outside, "bundle"), "../outside"]) {
      const graph = join(root, `graph-${bundleDir.includes("/") ? "path" : "relative"}.json`);
      await writeFile(
        graph,
        JSON.stringify({
          schema: "openclaw-atif-bundle-graph-v1",
          rootKey: "root",
          openclawVersion: "test",
          nodes: [{ sessionKey: "root", bundleDir }],
        }),
      );
      await expect(loadCapturedFamilyFromGraph(graph, root)).rejects.toThrow();
    }
  });

  it.each([".", "..bundle"])("accepts contained bundle path %s", async (bundleDir) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-graph-"));
    const bundle = await writeBundle({
      root,
      name: bundleDir === "." ? "bundle" : bundleDir,
      sessionId: "session",
      sessionKey: "root",
      events: childEvents("session"),
    });
    const graphPath = join(bundle, "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify({
        schema: "openclaw-atif-bundle-graph-v1",
        rootKey: "root",
        openclawVersion: "test",
        nodes: [{ sessionKey: "root", bundleDir }],
      }),
    );
    expect(
      (await loadCapturedFamilyFromGraph(graphPath, bundleDir === "." ? bundle : root)).nodes.size,
    ).toBe(1);
  });

  it("derives exact spawn evidence and rejects caller-supplied evidence that is not proven", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-graph-"));
    await writeBundle({
      root,
      name: "root",
      sessionId: "root-session",
      sessionKey: "root",
      events: rootEvents("root-session", "child"),
    });
    await writeBundle({
      root,
      name: "child",
      sessionId: "child-session",
      sessionKey: "child",
      events: childEvents("child-session"),
    });
    const graphPath = join(root, "graph.json");
    const graph: BundleGraphManifest = {
      schema: "openclaw-atif-bundle-graph-v1",
      rootKey: "root",
      openclawVersion: "test",
      nodes: [
        { sessionKey: "root", bundleDir: "root" },
        {
          sessionKey: "child",
          bundleDir: "child",
          parentKey: "root",
          relationshipKind: "native-subagent",
        },
      ],
    };
    await writeFile(graphPath, JSON.stringify(graph));
    const family = await loadCapturedFamilyFromGraph(graphPath, root);
    expect(family.relationships[0]?.spawn?.toolCallId).toBe("call-1");

    const childNode = graph.nodes[1];
    if (!childNode) throw new Error("test graph child is missing");
    graph.nodes[1] = { ...childNode, toolCallId: "bogus" };
    await writeFile(graphPath, JSON.stringify(graph));
    await expect(loadCapturedFamilyFromGraph(graphPath, root)).rejects.toThrow("not proven");
  });

  it("rejects duplicate nodes, missing parents, wrong roots, and disconnected cycles", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-graph-"));
    await writeBundle({
      root,
      name: "bundle",
      sessionId: "s",
      sessionKey: "root",
      events: childEvents("s"),
    });
    await writeBundle({
      root,
      name: "cycle-a",
      sessionId: "cycle-a",
      sessionKey: "cycle-a",
      events: childEvents("cycle-a"),
    });
    await writeBundle({
      root,
      name: "cycle-b",
      sessionId: "cycle-b",
      sessionKey: "cycle-b",
      events: childEvents("cycle-b"),
    });
    const cases = [
      {
        rootKey: "root",
        nodes: [
          { sessionKey: "root", bundleDir: "bundle" },
          { sessionKey: "root", bundleDir: "bundle" },
        ],
      },
      {
        rootKey: "root",
        nodes: [{ sessionKey: "root", bundleDir: "bundle", parentKey: "missing" }],
      },
      { rootKey: "missing", nodes: [{ sessionKey: "root", bundleDir: "bundle" }] },
      {
        rootKey: "root",
        nodes: [
          { sessionKey: "root", bundleDir: "bundle" },
          { sessionKey: "cycle-a", bundleDir: "cycle-a", parentKey: "cycle-b" },
          { sessionKey: "cycle-b", bundleDir: "cycle-b", parentKey: "cycle-a" },
        ],
      },
    ];
    for (const [index, value] of cases.entries()) {
      const graph = join(root, `graph-${String(index)}.json`);
      await writeFile(
        graph,
        JSON.stringify({
          schema: "openclaw-atif-bundle-graph-v1",
          openclawVersion: "test",
          ...value,
        }),
      );
      await expect(loadCapturedFamilyFromGraph(graph, root)).rejects.toThrow();
    }
  });
});
