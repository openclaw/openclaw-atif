import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAtomicDirectory, writeAtomicFile } from "../src/writer.js";

async function legacyFixture(phase: "before" | "backup" | "committed") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openclaw-atif-v1-recovery-")));
  const destination = join(root, "output");
  const alias = join(root, "alias");
  await symlink(root, alias);
  const id = "12345678-1234-1234-1234-123456789abc";
  const backup = join(root, `.output.openclaw-atif-${id}.backup`);
  const stage = join(root, `.output.openclaw-atif-${id}.tmp`);
  await mkdir(stage);
  await writeFile(join(stage, "a.json"), "new");
  const old = phase === "before" ? destination : backup;
  await mkdir(old);
  await writeFile(join(old, "a.json"), "old");
  if (phase === "committed") {
    await mkdir(destination);
    await writeFile(join(destination, "a.json"), "new");
  }
  const transaction = JSON.stringify({
    schema: "openclaw-atif-directory-transaction-v1",
    id,
    destination: `${join(alias, "output")}/`,
    backup: join(alias, `.output.openclaw-atif-${id}.backup`),
    stage: join(alias, `.output.openclaw-atif-${id}.tmp`),
    files: { "a.json": createHash("sha256").update("new").digest("hex") },
  });
  const marker = join(old, ".openclaw-atif-transaction.json");
  await writeFile(marker, transaction);
  return { root, destination, backup, stage, marker, transaction };
}

describe("v0.1.1 trailing-slash journal recovery", () => {
  it.each(["before", "backup", "committed"] as const)(
    "recovers the %s crash point",
    async (phase) => {
      const fixture = await legacyFixture(phase);
      try {
        const content = phase === "committed" ? "new" : "old";
        const result = await writeAtomicDirectory(
          `${fixture.destination}/`,
          new Map([["a.json", content]]),
        );
        expect(result[0]?.idempotent).toBe(true);
        expect(await readFile(join(fixture.destination, "a.json"), "utf8")).toBe(content);
        for (const path of [
          fixture.stage,
          fixture.backup,
          `${fixture.destination}.openclaw-atif-transaction.json`,
          join(fixture.destination, ".openclaw-atif-transaction.json"),
        ])
          await expect(stat(path)).rejects.toThrow();
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("recovers a legacy directory before rejecting a file writer", async () => {
    const fixture = await legacyFixture("backup");
    try {
      await expect(writeAtomicFile(fixture.destination, "file")).rejects.toThrow(
        "different content",
      );
      expect(await readFile(join(fixture.destination, "a.json"), "utf8")).toBe("old");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["canonical", "second-legacy", "invalid"])(
    "preserves ambiguous %s journals",
    async (kind) => {
      const fixture = await legacyFixture("before");
      try {
        let other: string;
        if (kind === "second-legacy") {
          await mkdir(fixture.backup);
          other = join(fixture.backup, ".openclaw-atif-transaction.json");
        } else if (kind === "canonical") {
          other = `${fixture.destination}.openclaw-atif-transaction.json`;
        } else other = fixture.marker;
        const content = kind === "invalid" ? "not a journal" : fixture.transaction;
        await writeFile(other, content);
        await expect(
          writeAtomicDirectory(fixture.destination, new Map([["a.json", "new"]]), true),
        ).rejects.toThrow("different content");
        expect(await readFile(other, "utf8")).toBe(content);
        expect(await readFile(join(fixture.destination, "a.json"), "utf8")).toBe("old");
        expect(await readFile(join(fixture.stage, "a.json"), "utf8")).toBe("new");
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("ignores backup lookalikes with unrelated markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-unowned-"));
    const unrelated = join(root, ".output.openclaw-atif-not-a-uuid.backup");
    try {
      await mkdir(unrelated);
      const marker = join(unrelated, ".openclaw-atif-transaction.json");
      await writeFile(marker, "unowned");
      await writeAtomicDirectory(join(root, "output"), new Map([["a.json", "new"]]));
      expect(await readFile(marker, "utf8")).toBe("unowned");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
