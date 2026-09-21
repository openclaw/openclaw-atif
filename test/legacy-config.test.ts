import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareMigrationRuntime } from "../src/legacy/config.js";

describe("private migration config", () => {
  it.each(["openclaw.json", "clawdbot.json"])("projects JSON5 selectors from %s", async (name) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-migration-config-"));
    const source = join(root, "source");
    const destination = join(root, "copy");
    await mkdir(source);
    try {
      await writeFile(
        join(source, name),
        `{
        // Only public ownership and store selectors survive.
        agents: { ownership: 'explicit', entries: {
          main: { workspace: '\${OMITTED_WORKSPACE}', agentDir: '/external/agent',
            runtime: { type: 'acp', acp: { agent: 'claude', cwd: '/external/cwd', backend: 'omitted' } } },
        }, defaults: { sessionStore: { agentId: 'main' }, systemAgent: { agentId: 'main' } } },
        acp: { defaultAgent: 'claude', allowedAgents: ['claude'], backend: 'omitted' },
        session: { store: ${JSON.stringify(join(source, "..store/{agentId}/sessions.json"))} },
        env: { OPENCLAW_CONFIG_PATH: '/external/config' },
        plugins: { load: { paths: ['/external/plugin'] } },
      }`,
      );
      await writeFile(join(source, ".env"), "OPENCLAW_CONFIG_PATH=/external/config\n");
      await cp(source, destination, { recursive: true });
      const result = await prepareMigrationRuntime({
        source,
        sourceArgument: source,
        destination,
        stagingRoot: root,
        command: {
          env: {
            PATH: process.env.PATH,
            HOME: "/external/home",
            OPENCLAW_CONFIG_PATH: "/external/config",
            NODE_OPTIONS: "--import=/external/hook",
            USERPROFILE: "/external/user",
          },
        },
      });
      const config: unknown = JSON.parse(await readFile(result.configPath, "utf8"));
      expect(config).toMatchObject({
        agents: {
          ownership: "explicit",
          entries: { main: { runtime: { type: "acp", acp: { agent: "claude" } } } },
          defaults: { sessionStore: { agentId: "main" }, systemAgent: { agentId: "main" } },
        },
        acp: { defaultAgent: "claude", allowedAgents: ["claude"] },
        session: { store: join(destination, "..store/{agentId}/sessions.json") },
        plugins: { enabled: false },
      });
      expect(JSON.stringify(config)).not.toContain("/external");
      expect(JSON.stringify(config)).not.toContain("backend");
      expect(result.command.env?.NODE_OPTIONS).toBeUndefined();
      expect(result.command.env?.OPENCLAW_CONFIG_PATH).toBe(result.configPath);
      expect(result.command.env?.HOME).toBe(result.command.env?.USERPROFILE);
      expect(result.command.env?.HOME).not.toBe("/external/home");
      expect(await readFile(join(destination, ".env"), "utf8")).toBe("");
      expect(await readFile(join(source, ".env"), "utf8")).toContain("/external/config");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { $include: "external.json" },
    { agents: { ownership: "explicit" } },
    { agents: { list: [], entries: {} } },
    { agents: { list: "invalid" } },
    { agents: { list: [] } },
    { agents: { list: [{ id: "../outside" }] } },
    { agents: { list: [{ id: "main" }, { id: "MAIN" }] } },
    {
      agents: {
        list: [
          { id: "one", default: true },
          { id: "two", default: true },
        ],
      },
    },
    { agents: { list: [{ id: "one" }, { id: "two" }] } },
    { agents: { ownership: "explicit", entries: { main: { default: true } } } },
    { agents: { defaults: { sessionStore: { agentId: `\${AGENT}` } } } },
    { acp: { allowedAgents: [`\${AGENT}`] } },
    { session: { store: "relative/sessions.json" } },
    { session: { store: "/outside/sessions.json" } },
  ])("rejects ambiguous or unconfined selectors %j", async (config) => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-atif-invalid-config-"));
    const source = join(root, "source");
    await mkdir(source);
    try {
      await writeFile(join(source, "openclaw.json"), JSON.stringify(config));
      await expect(
        prepareMigrationRuntime({
          source,
          sourceArgument: source,
          destination: source,
          stagingRoot: root,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
