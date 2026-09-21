import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import JSON5 from "json5";
import { asRecord } from "../json.js";
import type { CommandOptions } from "../openclaw/process.js";

export function isInside(root: string, target: string): boolean {
  const location = relative(root, target);
  return !location.split(sep).includes("..") && !isAbsolute(location);
}

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  if (!result || result.$include !== undefined)
    throw new Error("Legacy migration needs a self-contained object config without includes");
  return result;
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  for (const name of ["openclaw.json", "clawdbot.json"]) {
    try {
      return record(JSON5.parse(await readFile(join(root, name), "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {};
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = source[key];
    const values = Array.isArray(value) ? value : [value];
    if (values.some((item: unknown) => typeof item === "string" && item.includes("${")))
      throw new Error("Resolve legacy config environment substitutions before migration-on-copy");
  }
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
}

function projectAgent(value: unknown): Record<string, unknown> {
  const source = record(value);
  const output = pick(source, ["default"]);
  if (source.runtime !== undefined) {
    const runtime = record(source.runtime);
    output.runtime = {
      ...pick(runtime, ["type"]),
      ...(runtime.acp !== undefined ? { acp: pick(record(runtime.acp), ["agent"]) } : {}),
    };
  }
  return output;
}

function projectAgents(value: unknown, workspace: string): Record<string, unknown> {
  const source = value === undefined ? {} : record(value);
  if (source.list !== undefined && source.entries !== undefined)
    throw new Error(
      "Legacy agents config has both list and entries; select one roster before migration",
    );
  if (source.ownership === "explicit" && source.list === undefined && source.entries === undefined)
    throw new Error("Explicit legacy ownership requires an authored agent roster");
  const ids = new Set<string>();
  let defaults = 0;
  const validate = (id: unknown, entry: unknown) => {
    if (
      typeof id !== "string" ||
      !/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(id) ||
      ids.has(id.toLowerCase())
    )
      throw new Error("Legacy agent roster has an invalid or duplicate ID");
    ids.add(id.toLowerCase());
    const projected = projectAgent(entry);
    if (projected.default === true) defaults += 1;
    return projected;
  };
  const output: Record<string, unknown> = pick(source, ["ownership"]);
  if (source.list !== undefined) {
    if (!Array.isArray(source.list)) throw new Error("Legacy agents.list must be an array");
    output.list = source.list.map((entry: unknown) => {
      const original = record(entry);
      return { id: original.id, ...validate(original.id, original) };
    });
  } else {
    const entries = source.entries === undefined ? { main: {} } : record(source.entries);
    output.entries = Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [id, validate(id, entry)]),
    );
  }
  if (
    ids.size === 0 ||
    defaults > 1 ||
    (defaults > 0 && source.ownership === "explicit") ||
    (ids.size > 1 && defaults === 0 && source.ownership !== "explicit")
  )
    throw new Error("Legacy agent roster has ambiguous ownership or defaults");
  const originalDefaults = source.defaults === undefined ? {} : record(source.defaults);
  output.defaults = {
    workspace,
    ...Object.fromEntries(
      ["sessionStore", "systemAgent"].flatMap((key) =>
        originalDefaults[key] === undefined
          ? []
          : [[key, pick(record(originalDefaults[key]), ["agentId"])]],
      ),
    ),
  };
  return output;
}

export async function prepareMigrationRuntime(params: {
  source: string;
  sourceArgument: string;
  destination: string;
  stagingRoot: string;
  command?: CommandOptions;
}): Promise<{ command: CommandOptions; configPath: string }> {
  const runtimeRoot = join(params.stagingRoot, "legacy-runtime");
  await mkdir(runtimeRoot, { mode: 0o700 });
  const root = await realpath(runtimeRoot);
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const workspace = join(root, "workspace");
  for (const path of [home, temporary, workspace]) await mkdir(path, { mode: 0o700 });
  const xdg = Object.fromEntries(
    ["CONFIG", "DATA", "CACHE", "STATE", "RUNTIME"].map((kind) => [
      `XDG_${kind}${kind === "RUNTIME" ? "_DIR" : "_HOME"}`,
      join(home, kind.toLowerCase()),
    ]),
  );
  for (const path of Object.values(xdg)) await mkdir(path, { mode: 0o700 });
  const original = await readConfig(params.destination);
  const config: Record<string, unknown> = {
    agents: projectAgents(original.agents, workspace),
    plugins: { enabled: false },
    logging: { file: join(root, "openclaw.log") },
  };
  if (original.acp !== undefined)
    config.acp = pick(record(original.acp), ["defaultAgent", "allowedAgents"]);
  if (original.session !== undefined) {
    const session = record(original.session);
    if (session.store !== undefined) {
      if (typeof session.store !== "string" || !isAbsolute(session.store))
        throw new Error("Legacy session.store must be an absolute path inside the copied state");
      const store = resolve(session.store);
      const sourceRoot = [params.source, params.sourceArgument].find((source) =>
        isInside(source, store),
      );
      pick(session, ["store"]);
      if (!sourceRoot) throw new Error("Legacy session.store resolves outside the copied state");
      config.session = { store: join(params.destination, relative(sourceRoot, store)) };
    }
  }
  const configPath = join(root, "openclaw.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // OpenClaw reads state .env itself; copied selectors must not override this isolation.
  await writeFile(join(params.destination, ".env"), "", { mode: 0o600 });
  const originalEnv = params.command?.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE"])
    if (originalEnv[key] !== undefined) env[key] = originalEnv[key];
  Object.assign(env, {
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: params.destination,
    OPENCLAW_CONFIG_PATH: configPath,
    ZDOTDIR: home,
    ...xdg,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    ...(originalEnv.USERPROFILE !== undefined ? { USERPROFILE: home } : {}),
  });
  return { configPath, command: { ...params.command, cwd: root, env } };
}
/* eslint-disable complexity -- Legacy selectors are projected and validated without retaining executable config. */
