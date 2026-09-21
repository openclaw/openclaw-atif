import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("release version guard", () => {
  it.each([
    ["0.1.2", "0.0.0", true],
    ["0.1.10", "0.1.9", true],
    ["1.0.0", "0.99.99", true],
    ["0.1.2", "0.1.2", false],
    ["0.1.2", "0.1.3", false],
    ["0.1.2", "1.0.0", false],
    ["0.1.2", "", false],
    ["0.1.2", "null", false],
    ["0.1.2", "0.1.1-beta.1", false],
    ["0.1.2-beta.1", "0.1.1", false],
    ["0.1.2", "01.0.0", false],
    ["9007199254740992.0.0", "0.1.1", false],
  ])("checks %s against latest %s", (candidate, latest, allowed) => {
    const result = spawnSync(
      process.execPath,
      ["scripts/check-release-version.mjs", candidate, latest],
      { encoding: "utf8" },
    );
    expect(result.status === 0).toBe(allowed);
  });
});
