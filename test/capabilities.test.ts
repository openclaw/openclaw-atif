import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOpenClaw } from "../src/openclaw/capabilities.js";
import * as processBoundary from "../src/openclaw/process.js";

vi.mock("../src/openclaw/process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/openclaw/process.js")>()),
}));
afterEach(() => vi.restoreAllMocks());

describe("OpenClaw capabilities", () => {
  it.each([false, true])("preserves help cancellation with aborted=%s", async (aborted) => {
    const controller = new AbortController();
    const error = new DOMException("interrupted", "AbortError");
    vi.spyOn(processBoundary, "resolveExecutable").mockResolvedValue({
      path: "openclaw",
      sha256: "digest",
    });
    const run = vi
      .spyOn(processBoundary, "runOpenClaw")
      .mockResolvedValueOnce({ stdout: "test", stderr: "", code: 0 })
      .mockImplementationOnce(() => {
        if (aborted) controller.abort();
        return Promise.reject(error);
      });
    const result = probeOpenClaw("openclaw", { signal: controller.signal });
    if (aborted) await expect(result).rejects.toBe(error);
    else await expect(result).resolves.toMatchObject({ trajectoryExport: false });
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["sessions", "export-trajectory", "--help"],
    ]);
  });
});
