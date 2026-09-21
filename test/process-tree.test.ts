import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/openclaw/process.js";

function stopFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function triggerFixtureStop(
  trigger: "abort" | "overflow" | "none",
  controller: AbortController,
  marker: string,
): Promise<void> {
  if (trigger === "abort") {
    controller.abort();
    return;
  }
  if (trigger === "overflow") await writeFile(marker, "overflow");
}

const stopCases = [
  {
    reason: "abort",
    timeoutMs: 5_000,
    expectedMessage: "interrupted",
    trigger: "abort",
  },
  {
    reason: "timeout",
    timeoutMs: 1_000,
    expectedMessage: "timed out",
    trigger: "none",
  },
  {
    reason: "overflow",
    timeoutMs: 5_000,
    expectedMessage: "exceeded",
    trigger: "overflow",
  },
  {
    reason: "exited-wrapper",
    timeoutMs: 1_000,
    expectedMessage: "timed out",
    trigger: "none",
  },
] as const;

describe.skipIf(process.platform === "win32")("OpenClaw POSIX process ownership", () => {
  it.each(stopCases)(
    "stops inherited-pipe descendants before settling on $reason",
    async ({ reason, timeoutMs, expectedMessage, trigger: stopTrigger }) => {
      const root = await mkdtemp(join(tmpdir(), "openclaw-atif-tree-"));
      const worker = join(root, "worker.mjs");
      const wrapper = join(root, "wrapper.mjs");
      const heartbeat = join(root, "heartbeat");
      const ready = join(root, "ready");
      const trigger = join(root, "overflow");
      await writeFile(
        worker,
        `import { existsSync, writeFileSync } from "node:fs";
const [root] = process.argv.slice(2);
writeFileSync(root + "/worker.pid", String(process.pid));
writeFileSync(root + "/heartbeat", "0");
writeFileSync(root + "/ready", "ready");
let count = 0;
setInterval(() => {
  writeFileSync(root + "/heartbeat", String(++count));
  if (existsSync(root + "/overflow")) process.stdout.write("x".repeat(1024));
}, 10);
`,
      );
      await writeFile(
        wrapper,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [worker, root, mode] = process.argv.slice(2);
writeFileSync(root + "/wrapper.pid", String(process.pid));
const child = spawn(process.execPath, [worker, root], { stdio: "inherit" });
if (mode === "exited-wrapper") { child.unref(); process.exit(0); }
`,
      );
      const controller = new AbortController();
      const result = runCommand(process.execPath, [wrapper, worker, root, reason], {
        signal: controller.signal,
        timeoutMs,
        maxOutputBytes: 32,
      }).catch((error: unknown) => error);
      try {
        await expect
          .poll(
            () =>
              access(ready).then(
                () => true,
                () => false,
              ),
            { timeout: 5_000 },
          )
          .toBe(true);
        await triggerFixtureStop(stopTrigger, controller, trigger);
        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(expectedMessage);
        const stopped = await readFile(heartbeat, "utf8");
        await delay(100);
        expect(await readFile(heartbeat, "utf8")).toBe(stopped);
      } finally {
        // Only these exact fixture processes belong to this test. On a failed
        // assertion, stop them before deleting the directory they write into.
        controller.abort();
        for (const name of ["worker.pid", "wrapper.pid"]) {
          const pid = await readFile(join(root, name), "utf8").catch(() => "");
          if (!pid) continue;
          stopFixtureProcess(Number(pid));
        }
        await result;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not spawn for an already aborted signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-preabort-"));
    const marker = join(root, "spawned");
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(
        runCommand(
          process.execPath,
          ["-e", 'require("node:fs").writeFileSync(process.argv[1], "spawned")', marker],
          { signal: controller.signal },
        ),
      ).rejects.toThrow("interrupted");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
