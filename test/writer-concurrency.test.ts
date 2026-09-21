import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAtomicDirectory, writeAtomicFile } from "../src/writer.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
afterEach(() => vi.restoreAllMocks());

const writerUrl = pathToFileURL(resolve("dist/writer.js")).href;
const childProgram = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const [url, destination, mode, pause] = process.argv.slice(1);
if (pause) {
  const open = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".openclaw-atif.lock")) {
      process.send("locked");
      await new Promise((resolve) => process.once("message", resolve));
    }
    return handle;
  };
  syncBuiltinESMExports();
}
const writer = await import(url);
try {
  if (mode === "file") await writer.writeAtomicFile(destination, "owner");
  else await writer.writeAtomicDirectory(destination, new Map([["a.json", "owner"]]));
} catch (error) { console.error(error.message); process.exitCode = 1; }
if (process.connected) process.disconnect();
`;

describe("destination ownership", () => {
  it.each([
    ["file", "file"],
    ["directory", "directory"],
    ["file", "directory"],
    ["directory", "file"],
  ])("serializes separate %s and %s writers across parent aliases", async (ownerMode, mode) => {
    const temporary = await fs.mkdtemp(join(tmpdir(), "openclaw-atif-lock-"));
    const root = await fs.realpath(temporary);
    await fs.mkdir(join(root, "real"));
    await fs.symlink(join(root, "real"), join(root, "alias"));
    const destination = join(root, "real", "output");
    const owner = spawn(
      process.execPath,
      ["--input-type=module", "-e", childProgram, writerUrl, destination, ownerMode, "pause"],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const closed = once(owner, "close");
    try {
      await once(owner, "message");
      const contender = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          childProgram,
          writerUrl,
          `${join(root, "alias", "output")}${mode === "directory" ? "/" : ""}`,
          mode,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(contender.status, contender.stderr).toBe(1);
      expect(contender.stderr).toContain("Output is busy");
      owner.send("continue");
      expect((await closed)[0]).toBe(0);
      const output = ownerMode === "file" ? destination : join(destination, "a.json");
      expect(await fs.readFile(output, "utf8")).toBe("owner");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await closed;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an old lock and recovery journal until explicit owner recovery", async () => {
    const temporary = await fs.mkdtemp(join(tmpdir(), "openclaw-atif-orphan-"));
    const root = await fs.realpath(temporary);
    const destination = join(root, "output");
    const lock = `${destination}.openclaw-atif.lock`;
    const journal = `${destination}.openclaw-atif-transaction.json`;
    const id = "12345678-1234-1234-1234-123456789abc";
    const stage = join(root, `.output.openclaw-atif-${id}.tmp`);
    const backup = join(root, `.output.openclaw-atif-${id}.backup`);
    try {
      await fs.mkdir(backup);
      await fs.writeFile(join(backup, "a.json"), "original");
      await fs.mkdir(stage);
      const transaction = JSON.stringify({
        schema: "openclaw-atif-directory-transaction-v1",
        id,
        destination,
        backup,
        stage,
        files: { "a.json": createHash("sha256").update("original").digest("hex") },
      });
      await fs.writeFile(journal, transaction);
      await fs.writeFile(
        lock,
        JSON.stringify({ token: "orphan", pid: 99999999, startedAt: "2000-01-01" }),
      );
      await expect(
        writeAtomicDirectory(`${destination}/`, new Map([["a.json", "original"]])),
      ).rejects.toThrow("Output is busy");
      expect(await fs.readFile(journal, "utf8")).toBe(transaction);
      expect(await fs.readFile(join(backup, "a.json"), "utf8")).toBe("original");
      await fs.rm(lock);
      await expect(writeAtomicFile(destination, "replacement")).rejects.toThrow(
        "different content",
      );
      expect(await fs.readFile(join(destination, "a.json"), "utf8")).toBe("original");
      const result = await writeAtomicDirectory(
        `${destination}/`,
        new Map([["a.json", "original"]]),
      );
      expect(result[0]?.idempotent).toBe(true);
      await expect(fs.stat(journal)).rejects.toThrow();
      await expect(fs.stat(lock)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an external file created at the no-force commit boundary", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openclaw-atif-link-"));
    const destination = join(root, "output");
    const link = fs.link;
    try {
      vi.spyOn(fs, "link").mockImplementationOnce(async (source, target) => {
        await fs.writeFile(target, "external");
        return link(source, target);
      });
      await expect(writeAtomicFile(destination, "ours")).rejects.toThrow("different content");
      expect(await fs.readFile(destination, "utf8")).toBe("external");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a directory that appears while staging a no-force write", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openclaw-atif-final-check-"));
    const destination = join(root, "output");
    const open = fs.open;
    try {
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith(".tmp/a.json")) {
          await fs.mkdir(destination);
          await fs.writeFile(join(destination, "external"), "preserved");
        }
        return handle;
      });
      await expect(
        writeAtomicDirectory(destination, new Map([["a.json", "ours"]])),
      ).rejects.toThrow("different content");
      expect(await fs.readFile(join(destination, "external"), "utf8")).toBe("preserved");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
