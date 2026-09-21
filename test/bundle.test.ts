import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadOpenClawBundle } from "../src/openclaw/bundle-v1.js";
import { childEvents, writeBundle } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
afterEach(() => vi.restoreAllMocks());

async function standardBundle(root: string, name = "bundle") {
  return writeBundle({
    root,
    name,
    sessionId: "session",
    sessionKey: "agent:main:main",
    events: childEvents("session"),
  });
}

describe("loadOpenClawBundle", () => {
  it("rejects a file replaced between inspection and open", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-race-"));
    try {
      const directory = await standardBundle(root);
      const external = join(root, "external.json");
      await writeFile(external, "private");
      const actualOpen = fs.open;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        await rm(join(directory, "manifest.json"));
        await symlink(external, join(directory, "manifest.json"));
        return actualOpen(...args);
      });
      await expect(loadOpenClawBundle(directory)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects growth after open and closes the descriptor", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-growth-"));
    try {
      const directory = await standardBundle(root);
      const actualOpen = fs.open;
      let opened: fs.FileHandle | undefined;
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        opened = await actualOpen(...args);
        await fs.appendFile(join(directory, "manifest.json"), "extra");
        return opened;
      });
      await expect(loadOpenClawBundle(directory)).rejects.toThrow("changed while reading");
      expect(opened?.fd).toBe(-1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects aggregate overflow before opening the next file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-limit-"));
    try {
      const directory = await standardBundle(root);
      const maxBytes = (await fs.stat(join(directory, "manifest.json"))).size;
      const open = vi.spyOn(fs, "open");
      await expect(loadOpenClawBundle(directory, { maxBytes })).rejects.toThrow("size limit");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads and validates a public bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const bundle = await loadOpenClawBundle(await standardBundle(root));
    expect(bundle.manifest.sessionId).toBe("session");
    expect(bundle.events).toHaveLength(3);
    expect(bundle.sourceHashes["events.jsonl"]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects manifest count mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const directory = await standardBundle(root);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.eventCount = 99;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadOpenClawBundle(directory)).rejects.toThrow("event counts");
  });

  it("rejects symlinked required files", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const directory = await standardBundle(root);
    const external = join(root, "external.json");
    await writeFile(external, "{}\n");
    await rm(join(directory, "session-branch.json"));
    await symlink(external, join(directory, "session-branch.json"));
    await expect(loadOpenClawBundle(directory)).rejects.toThrow("non-symlink");
  });

  it("rejects unknown bundle schema versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const directory = await standardBundle(root);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.schemaVersion = 2;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadOpenClawBundle(directory)).rejects.toThrow();
  });

  it("rejects noncontiguous sequences and session mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const events = childEvents("session");
    if (events[1]) events[1].seq = 9;
    const sequence = await writeBundle({
      root,
      name: "sequence",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events,
    });
    await expect(loadOpenClawBundle(sequence)).rejects.toThrow("sequence");

    const mismatchEvents = childEvents("session");
    if (mismatchEvents[1]) mismatchEvents[1].sessionId = "other";
    const mismatch = await writeBundle({
      root,
      name: "mismatch",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events: mismatchEvents,
    });
    await expect(loadOpenClawBundle(mismatch)).rejects.toThrow("sessionId mismatch");
  });

  it("rejects trace and session-key identity mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const traceEvents = childEvents("session");
    if (traceEvents[0]) traceEvents[0].traceId = "other-trace";
    const traceMismatch = await writeBundle({
      root,
      name: "trace-mismatch",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events: traceEvents,
    });
    await expect(loadOpenClawBundle(traceMismatch)).rejects.toThrow("traceId mismatch");

    const keyEvents = childEvents("session");
    if (keyEvents[0]) keyEvents[0].sessionKey = "agent:main:other";
    const keyMismatch = await writeBundle({
      root,
      name: "key-mismatch",
      sessionId: "session",
      sessionKey: "agent:main:main",
      events: keyEvents,
    });
    await expect(loadOpenClawBundle(keyMismatch)).rejects.toThrow("sessionKey mismatch");
  });

  it("rejects session-branch identities that contradict the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const sessionMismatch = await standardBundle(root, "session-mismatch");
    await writeFile(
      join(sessionMismatch, "session-branch.json"),
      JSON.stringify({ header: { id: "other-session" }, leafId: "leaf-1", entries: [] }),
    );
    await expect(loadOpenClawBundle(sessionMismatch)).rejects.toThrow("session identity");

    const leafMismatch = await standardBundle(root, "leaf-mismatch");
    await writeFile(
      join(leafMismatch, "session-branch.json"),
      JSON.stringify({ header: { id: "session" }, leafId: "other-leaf", entries: [] }),
    );
    await expect(loadOpenClawBundle(leafMismatch)).rejects.toThrow("leaf identity");
  });

  it("rejects malformed rows and file limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const directory = await standardBundle(root);
    await writeFile(join(directory, "events.jsonl"), "not-json\n");
    await expect(loadOpenClawBundle(directory)).rejects.toThrow("row 1");

    const limited = await standardBundle(root, "limited");
    await expect(loadOpenClawBundle(limited, { maxBytes: 2 })).rejects.toThrow("size limit");
    await expect(loadOpenClawBundle(limited, { maxEvents: 1 })).rejects.toThrow("event limit");
  });

  it("loads declared supplemental JSON and text files", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-bundle-"));
    const directory = await standardBundle(root);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.supplementalFiles = ["metadata.json"];
    manifest.contents = [
      { path: "system-prompt.txt", mediaType: "text/plain", bytes: 6 },
      { path: "tools.json", mediaType: "application/json", bytes: 17 },
    ];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(directory, "metadata.json"), '{"version":"test"}');
    await writeFile(join(directory, "system-prompt.txt"), "system");
    await writeFile(join(directory, "tools.json"), '[{"name":"tool"}]');
    const bundle = await loadOpenClawBundle(directory);
    expect(bundle.supplemental.get("metadata.json")).toEqual({ version: "test" });
    expect(bundle.supplemental.get("system-prompt.txt")).toBe("system");
    expect(bundle.supplemental.get("tools.json")).toEqual([{ name: "tool" }]);
    expect(bundle.sourceHashes["system-prompt.txt"]).toMatch(/^[a-f0-9]{64}$/u);
    expect(bundle.sourceHashes["tools.json"]).toMatch(/^[a-f0-9]{64}$/u);
  });
});
