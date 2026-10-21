import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("published package verification", () => {
  it.each([
    ["delayed metadata and provenance", 13, 13, "valid", 0, 27],
    ["metadata never arrives", 120, 0, "valid", 1, 120],
    ["changed package bytes", 0, 0, "changed", 1, 1],
    ["registry authorization failure", 0, 0, "auth", 1, 1],
  ])("handles %s", async (_name, missing, pending, response, exitCode, calls) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-publish-"));
    try {
      const identity = JSON.parse(await readFile("package.json", "utf8")) as {
        name: string;
        version: string;
      };
      const metadata = {
        ...identity,
        dist: { integrity: "synthetic-integrity", shasum: "synthetic-shasum" },
      };
      await writeFile(join(root, "pending.json"), JSON.stringify(metadata));
      await writeFile(
        join(root, "valid.json"),
        JSON.stringify({
          ...metadata,
          dist: { ...metadata.dist, attestations: { provenance: { url: "https://example.test" } } },
        }),
      );
      await writeFile(join(root, "changed.json"), JSON.stringify({ ...metadata, dist: {} }));
      await writeFile(join(root, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(
        join(root, "npm"),
        `#!/bin/sh
case "$*" in *--prefer-online*) ;; *) echo 'Missing fresh metadata request' >&2; exit 2;; esac
case "$*" in *dist-tags.latest*) printf '%s\\n' "$TEST_VERSION"; exit 0;; esac
count=0
if [ -f "$RUNNER_TEMP/count" ]; then count=$(cat "$RUNNER_TEMP/count"); fi
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEMP/count"
if [ "$TEST_RESPONSE" = auth ]; then echo E401 >&2; exit 1; fi
if [ "$count" -le "$TEST_MISSING" ]; then echo E404 >&2; exit 1; fi
if [ "$count" -le "$((TEST_MISSING + TEST_PENDING))" ]; then
  cat "$RUNNER_TEMP/pending.json"
else
  cat "$RUNNER_TEMP/$TEST_RESPONSE.json"
fi
`,
        { mode: 0o700 },
      );
      const result = spawnSync("/bin/bash", ["scripts/verify-release-package.sh"], {
        encoding: "utf8",
        env: {
          PATH: `${root}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: root,
          PACKAGE_INTEGRITY: metadata.dist.integrity,
          PACKAGE_SHASUM: metadata.dist.shasum,
          TEST_VERSION: identity.version,
          TEST_MISSING: String(missing),
          TEST_PENDING: String(pending),
          TEST_RESPONSE: response,
        },
        timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(Number(await readFile(join(root, "count"), "utf8"))).toBe(calls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
