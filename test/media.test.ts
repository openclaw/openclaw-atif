import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MEDIA_BYTES, MAX_MEDIA_FILES, MediaStore } from "../src/atif/media.js";
import type { Diagnostic } from "../src/diagnostics.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "openclaw-atif-media-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  await fs.mkdir(bundle);
  const store = new MediaStore();
  const diagnostics: Diagnostic[] = [];
  const part = (block: Record<string, unknown>, type: "image" | "audio" = "image") =>
    store.part(block, type, bundle, diagnostics, "root", "event");
  const image = (path: string) => part({ source: { media_type: "image/png", path } });
  return { root, bundle, store, diagnostics, part, image };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("media retention", () => {
  it("copies binary content by full digest and deduplicates aliases and paths", async () => {
    const f = await fixture();
    const bytes = Buffer.from([0, 255, 128, 13, 10]);
    await fs.writeFile(join(f.bundle, "one.png"), bytes);
    await fs.writeFile(join(f.bundle, "two.png"), bytes);
    const first = await f.image("one.png");
    expect(first?.source.path).toBe(
      `media/${createHash("sha256").update(bytes).digest("hex")}.png`,
    );
    expect(await f.image(join(f.bundle, "two.png"))).toEqual(first);
    expect(f.store.files.size).toBe(1);
    expect([...f.store.files.values()]).toEqual([bytes]);
    expect(f.diagnostics).toEqual([]);
  });

  it.each([
    "https://example.test/p.png",
    "http://example.test/p.png",
    "data:image/png;base64,AA==",
  ])("preserves %s without filesystem access or fetching", async (path) => {
    const f = await fixture();
    const open = vi.spyOn(fs, "open");
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const block of [
      { source: { media_type: "image/png", path } },
      { media_type: "image/png", image_url: path },
      { input_image: { media_type: "image/png", path } },
    ]) {
      expect(await f.part(block)).toEqual({
        type: "image",
        source: { media_type: "image/png", path },
      });
    }
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.store.files.size).toBe(0);
  });

  it("recognizes source field spellings and canonical audio types without inventing duration", async () => {
    const f = await fixture();
    for (const source of [
      { mediaType: "audio/mp3", filePath: "https://example.test/a.mp3" },
      { mimeType: "audio/mpga", file_path: "https://example.test/a.mp3" },
      { mime_type: "audio/x-mpeg", url: "https://example.test/a.mp3" },
    ]) {
      expect(await f.part({ source }, "audio")).toEqual({
        type: "audio",
        source: { media_type: "audio/mpeg", path: "https://example.test/a.mp3" },
      });
    }
    expect(
      await f.part(
        { media_type: "audio/wav", path: "https://example.test/a.wav", duration_sec: 1.5 },
        "audio",
      ),
    ).toEqual({
      type: "audio",
      source: { media_type: "audio/wav", path: "https://example.test/a.wav", duration_sec: 1.5 },
    });
    expect(
      await f.part({ image_url: { mimeType: "image/jpg", url: "https://example.test/a.jpg" } }),
    ).toEqual({
      type: "image",
      source: { media_type: "image/jpeg", path: "https://example.test/a.jpg" },
    });
  });

  it("keeps existing source precedence and limits input_image to images", async () => {
    const f = await fixture();
    const chosen = { media_type: "image/png", path: "https://example.test/chosen.png" };
    const other = { media_type: "image/png", path: "https://example.test/other.png" };
    for (const block of [
      { source: chosen, image_url: other, input_image: other },
      { image_url: chosen, input_image: other },
    ]) {
      expect(await f.part(block)).toEqual({ type: "image", source: chosen });
    }
    expect(
      await f.part({ source: { media_type: "image/png" }, input_image: chosen }),
    ).toBeUndefined();
    expect(await f.part({ input_image: chosen }, "audio")).toBeUndefined();
    expect(f.diagnostics.map((d) => d.code)).toEqual([
      "media-source-unsupported",
      "media-source-unsupported",
    ]);
  });

  it("diagnoses unsupported or incomplete sources without exposing their paths", async () => {
    const f = await fixture();
    for (const block of [
      {},
      { data: "inline" },
      { source: { media_type: "image/png" } },
      { source: { media_type: "audio/wav", path: "hidden-path" } },
      { source: { media_type: "image/svg+xml", path: "hidden-path" } },
      { image_url: "https://example.test/p.png" },
      { media_type: "image/png", image_url: 42 },
      { media_type: "audio/wav", image_url: "https://example.test/p.png" },
      { input_image: { path: "hidden-path" } },
      { input_image: { media_type: "image/png", path: 42 } },
      { input_image: { media_type: "audio/wav", path: "hidden-path" } },
    ])
      expect(await f.part(block)).toBeUndefined();
    for (const path of [
      "file:///hidden-path",
      "ftp://example.test/a",
      "https://",
      "data:broken",
      "http:not-an-absolute-url",
    ])
      expect(await f.image(path)).toBeUndefined();
    expect(f.diagnostics).toHaveLength(16);
    expect(JSON.stringify(f.diagnostics)).not.toContain("hidden-path");
    expect(f.store.files.size).toBe(0);
  });

  it("rejects escapes, directories, and both leaf and parent symlinks", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.root, "private.png"), "private");
    await fs.writeFile(join(f.bundle, "allowed.png"), "allowed");
    await fs.symlink(join(f.root, "private.png"), join(f.bundle, "link.png"));
    await fs.symlink(f.root, join(f.bundle, "outside"));
    await fs.symlink(f.bundle, join(f.bundle, "inside"));
    for (const path of [
      "../private.png",
      join(f.root, "private.png"),
      "link.png",
      "outside/private.png",
      "inside/allowed.png",
      ".",
    ]) {
      expect(await f.image(path)).toBeUndefined();
      expect(await f.part({ input_image: { media_type: "image/png", path } })).toBeUndefined();
    }
    await fs.mkdir(join(f.bundle, "directory"));
    expect(await f.image("directory")).toBeUndefined();
    expect(await f.image("missing.png")).toBeUndefined();
    expect(f.diagnostics.map((d) => d.code)).toEqual([
      ...Array<string>(12).fill("media-unsafe-path"),
      "media-not-regular-file",
      "media-file-unavailable",
    ]);
    expect(f.store.files.size).toBe(0);
  });

  it("rejects a bundle directory replaced by a symlink", async () => {
    const f = await fixture();
    const replacement = join(f.root, "replacement");
    await fs.mkdir(replacement);
    await fs.writeFile(join(replacement, "private.png"), "private");
    await fs.rename(f.bundle, join(f.root, "original"));
    await fs.symlink(replacement, f.bundle);
    expect(await f.image("private.png")).toBeUndefined();
    expect(f.diagnostics[0]?.code).toBe("media-unsafe-path");
    expect(f.store.files.size).toBe(0);
  });

  it("bounds file size before reading, and accepts exactly the limit", async () => {
    const f = await fixture();
    const file = join(f.bundle, "large.png");
    await fs.writeFile(file, "");
    await fs.truncate(file, MAX_MEDIA_BYTES + 1);
    expect(await f.image("large.png")).toBeUndefined();
    expect(f.diagnostics[0]?.code).toBe("media-file-too-large");
    await fs.truncate(file, MAX_MEDIA_BYTES);
    expect(await f.image("large.png")).toBeDefined();
    expect([...f.store.files.values()][0]?.length).toBe(MAX_MEDIA_BYTES);
  });

  it("bounds family file count while allowing repeated content after the limit", async () => {
    const f = await fixture();
    for (let i = 0; i <= MAX_MEDIA_FILES; i++) {
      await fs.writeFile(join(f.bundle, `${String(i)}.png`), String(i));
      const result = await f.image(`${String(i)}.png`);
      expect(result !== undefined).toBe(i < MAX_MEDIA_FILES);
    }
    expect(f.store.files.size).toBe(MAX_MEDIA_FILES);
    expect(f.diagnostics[0]?.code).toBe("media-file-limit");
    expect(await f.image("0.png")).toBeDefined();
    await fs.writeFile(join(f.bundle, "copy.png"), "0");
    expect(await f.image("copy.png")).toBeDefined();
    expect(f.diagnostics).toHaveLength(1);
  });

  it("reports read failures and does not retain a file changed during reading", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.bundle, "a.png"), "original");
    vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("private file path"));
    expect(await f.image("a.png")).toBeUndefined();
    expect(f.diagnostics[0]?.code).toBe("media-file-unavailable");
    vi.restoreAllMocks();
    const actualOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await actualOpen(...args);
      await fs.writeFile(join(f.bundle, "a.png"), "changed");
      return handle;
    });
    expect(await f.image("a.png")).toBeUndefined();
    expect(f.diagnostics[1]?.code).toBe("media-file-changed");
    expect(f.store.files.size).toBe(0);
  });
});
