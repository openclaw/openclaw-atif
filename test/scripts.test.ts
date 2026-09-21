import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("validation scripts", () => {
  it("rejects partial Harbor fixture discovery before preparing the validator", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-script-find-"));
    try {
      await writeFile(
        join(root, "find"),
        '#!/bin/sh\nprintf "%s\\n" fixtures/golden/legacy-jsonl/trajectory.json\nexit 9\n',
        { mode: 0o700 },
      );
      await writeFile(join(root, "git"), "#!/bin/sh\nexit 37\n", { mode: 0o700 });
      const result = spawnSync("/bin/bash", ["scripts/validate-harbor.sh"], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}`, HARBOR_SOURCE: root },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(9);
      expect(result.stdout).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes smoke fixture paths containing quotes, backslashes, and newlines", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-script-"));
    const fixture = join(root, 'fixture "\\\nspace');
    const bin = join(root, "bin");
    await mkdir(bin);
    try {
      await writeFile(join(bin, "mktemp"), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_ROOT"\n', {
        mode: 0o700,
      });
      await writeFile(
        join(bin, "npm"),
        `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const root = process.env.FIXTURE_ROOT;
const session = join(root, "agents/main/sessions/synthetic-session.jsonl");
const events = readFileSync(session, "utf8").trim().split("\\n").map(JSON.parse);
assert.equal(events.length, 3);
assert.equal(events[0].cwd, join(root, "workspace"));
const listing = JSON.parse(readFileSync(join(root, "agents/main/sessions/sessions.json")));
assert.equal(listing["agent:main:main"].sessionFile, session);
const config = JSON.parse(readFileSync(join(root, "openclaw.json")));
assert.equal(config.agents.defaults.workspace, join(root, "workspace"));
process.exit(37);
`,
        { mode: 0o700 },
      );
      const result = spawnSync("/bin/bash", ["scripts/smoke-openclaw.sh"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, FIXTURE_ROOT: fixture },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(37);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
