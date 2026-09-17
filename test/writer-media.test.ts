import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputConflictError, type OutputContent, writeAtomicDirectory } from "../src/writer.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];
const bytes = Buffer.from([0, 255, 128, 13, 10]);
const name = `media/${createHash("sha256").update(bytes).digest("hex")}.png`;
const files = new Map<string, OutputContent>([
  ["trajectory.json", "trajectory\n"],
  [name, bytes],
]);
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "openclaw-atif-media-write-"));
  roots.push(root);
  return { root, output: join(root, "out") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("atomic media output", () => {
  it("hashes raw binary bytes and secures media on idempotent reruns", async () => {
    const { output } = await fixture();
    const first = await writeAtomicDirectory(output, files);
    expect(first.find((file) => file.path.endsWith(name))?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(await fs.readFile(join(output, name))).toEqual(bytes);
    await fs.chmod(join(output, "media"), 0o755);
    await fs.chmod(join(output, name), 0o644);
    expect((await writeAtomicDirectory(output, files)).every((file) => file.idempotent)).toBe(true);
    expect((await fs.stat(join(output, "media"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(output, name))).mode & 0o777).toBe(0o600);
    await fs.writeFile(join(output, name), Buffer.from([0, 254, 128, 13, 10]));
    await expect(writeAtomicDirectory(output, files)).rejects.toBeInstanceOf(OutputConflictError);
    await writeAtomicDirectory(output, files, true);
    expect(await fs.readFile(join(output, name))).toEqual(bytes);
  });

  it("rejects symlink media directories and files, even with force", async () => {
    const { root, output } = await fixture();
    await writeAtomicDirectory(output, files);
    const external = join(root, "external");
    await fs.rename(join(output, "media"), external);
    await fs.symlink(external, join(output, "media"));
    await expect(writeAtomicDirectory(output, files, true)).rejects.toBeInstanceOf(
      OutputConflictError,
    );
    await fs.unlink(join(output, "media"));
    await fs.rename(external, join(output, "media"));
    const outside = join(root, "outside.png");
    await fs.rename(join(output, name), outside);
    await fs.symlink(outside, join(output, name));
    await expect(writeAtomicDirectory(output, files, true)).rejects.toBeInstanceOf(
      OutputConflictError,
    );
    expect(await fs.readFile(outside)).toEqual(bytes);
  });

  it.each([
    "media/../private",
    "media/link/image.png",
    "media/not-a-digest.png",
    ".",
    "..",
    "media",
    "media\\escape",
  ])("rejects unsafe output %s", async (path) => {
    const { output } = await fixture();
    await expect(writeAtomicDirectory(output, new Map([[path, bytes]]))).rejects.toThrow(
      "output name",
    );
    await expect(fs.access(output)).rejects.toBeDefined();
  });

  it("keeps the old complete output when a staged media write fails", async () => {
    const { root, output } = await fixture();
    await writeAtomicDirectory(output, new Map([["old.json", "old\n"]]));
    const actualOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(name)) throw new Error("injected media write failure");
      return actualOpen(...args);
    });
    await expect(writeAtomicDirectory(output, files, true)).rejects.toThrow("injected");
    expect(await fs.readFile(join(output, "old.json"), "utf8")).toBe("old\n");
    expect(await fs.readdir(root)).toEqual(["out"]);
  });

  it("verifies media bytes before removing a committed transaction backup", async () => {
    const { root, output } = await fixture();
    await writeAtomicDirectory(output, files);
    const id = "12345678-1234-1234-1234-123456789abc";
    const backup = join(root, `.out.openclaw-atif-${id}.backup`);
    const stage = join(root, `.out.openclaw-atif-${id}.tmp`);
    await fs.mkdir(backup);
    await fs.writeFile(join(backup, "old"), "keep");
    await fs.writeFile(
      `${output}.openclaw-atif-transaction.json`,
      JSON.stringify({
        schema: "openclaw-atif-directory-transaction-v1",
        id,
        destination: output,
        backup,
        stage,
        files: Object.fromEntries(
          [...files].map(([path, content]) => [
            path,
            createHash("sha256").update(content).digest("hex"),
          ]),
        ),
      }),
    );
    await fs.writeFile(join(output, name), "corrupt");
    await expect(writeAtomicDirectory(output, files)).rejects.toBeInstanceOf(OutputConflictError);
    expect(await fs.readFile(join(backup, "old"), "utf8")).toBe("keep");
    await fs.writeFile(join(output, name), bytes);
    await writeAtomicDirectory(output, files);
    await expect(fs.access(backup)).rejects.toBeDefined();
    expect(await fs.readFile(join(output, name))).toEqual(bytes);
  });
});
