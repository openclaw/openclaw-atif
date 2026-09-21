/* eslint-disable complexity -- CLI option and outcome dispatch is explicit. */
import { convertOpenClawBundles, type ExportResult, exportOpenClawFamily } from "./exporter.js";
import { PACKAGE_VERSION } from "./version.js";

interface ParsedArgs {
  command: "export" | "convert" | "help" | "version";
  values: Map<string, string>;
  flags: Set<string>;
}

const HELP = `openclaw-atif ${PACKAGE_VERSION}

Export OpenClaw session families as Harbor ATIF-v1.8.

Usage:
  openclaw-atif export (--session-key <key> | --session-id <id>) --output <dir> [options]
  openclaw-atif convert --graph <file> --bundle-root <dir> --output <dir> [options]

Export options:
  --openclaw <path>             OpenClaw executable (default: openclaw)
  --state-dir <path>            OPENCLAW_STATE_DIR for capture
  --profile <id>                Export profile
  --retries <n>                 Full-family capture attempts (default: 3)
  --max-nodes <n>               Family node limit (default: 128)
  --max-depth <n>               Family depth limit (default: 16)
  --timeout-ms <n>              Per-command timeout
  --migrate-copy                Migrate a private copy when source export is unavailable
  --legacy-state-dir <path>     Legacy state copied for migration
  --migration-openclaw <path>   Official migration-capable OpenClaw executable
  --keep-source-bundles         Retain owner-only captured public bundles

Shared options:
  --require-complete            Reject partial output
  --force                       Replace different output
  --json                        Print machine-readable status
  --help                        Show this help
  --version                     Show the package version
`;

const VALUE_OPTIONS = new Set([
  "session-key",
  "session-id",
  "output",
  "openclaw",
  "state-dir",
  "profile",
  "retries",
  "max-nodes",
  "max-depth",
  "timeout-ms",
  "legacy-state-dir",
  "migration-openclaw",
  "graph",
  "bundle-root",
]);
const FLAG_OPTIONS = new Set([
  "require-complete",
  "force",
  "json",
  "migrate-copy",
  "keep-source-bundles",
  "help",
  "version",
]);

export function parseCliArgs(args: readonly string[]): ParsedArgs {
  if (args.includes("--help") || args.length === 0)
    return { command: "help", values: new Map(), flags: new Set() };
  if (args.includes("--version"))
    return { command: "version", values: new Map(), flags: new Set() };
  const rawCommand = args[0];
  if (rawCommand !== "export" && rawCommand !== "convert")
    throw new Error(`Unknown command: ${rawCommand ?? ""}`);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token ?? ""}`);
    const name = token.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
    if (values.has(name)) throw new Error(`Option --${name} was supplied more than once`);
    values.set(name, value);
    index += 1;
  }
  return { command: rawCommand, values, flags };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function boundedInteger(
  values: ReadonlyMap<string, string>,
  key: string,
  minimum: number,
): number | undefined {
  const raw = values.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${key} must be an integer of at least ${String(minimum)}`);
  }
  return value;
}

function printResult(result: ExportResult, json: boolean): void {
  const summary = {
    status: result.status,
    trajectory: result.writes.find((write) => write.path.endsWith("trajectory.json"))?.path,
    receipt: result.writes.find((write) => write.path.endsWith("receipt.json"))?.path,
    trajectorySha256: result.receipt.output.trajectorySha256,
    diagnostics: result.receipt.diagnostics.length,
    sourceBundleRoot: result.sourceBundleRoot,
  };
  if (json) process.stdout.write(`${JSON.stringify(summary)}\n`);
  else {
    process.stdout.write(`Export ${result.status}: ${summary.trajectory ?? "trajectory.json"}\n`);
    if (result.status === "partial")
      process.stdout.write(`Receipt lists ${String(summary.diagnostics)} diagnostic item(s).\n`);
    if (summary.sourceBundleRoot)
      process.stdout.write(`Source bundles: ${summary.sourceBundleRoot}\n`);
  }
}

export function completedExitCode(
  status: "complete" | "partial",
  signalExit: number | undefined,
): number {
  return signalExit ?? (status === "complete" ? 0 : 2);
}

export async function runCli(args: readonly string[]): Promise<number> {
  const controller = new AbortController();
  let signalExit: number | undefined;
  const onInt = () => {
    signalExit = 130;
    controller.abort();
  };
  const onTerm = () => {
    signalExit = 143;
    controller.abort();
  };
  try {
    const parsed = parseCliArgs(args);
    if (parsed.command === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (parsed.command === "version") {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      return 0;
    }
    const output = required(parsed.values, "output");
    process.once("SIGINT", onInt);
    process.once("SIGTERM", onTerm);
    const shared = {
      output,
      requireComplete: parsed.flags.has("require-complete"),
      force: parsed.flags.has("force"),
      signal: controller.signal,
    };
    const result =
      parsed.command === "convert"
        ? await convertOpenClawBundles({
            ...shared,
            graph: required(parsed.values, "graph"),
            bundleRoot: required(parsed.values, "bundle-root"),
          })
        : await exportOpenClawFamily({
            output,
            executable: parsed.values.get("openclaw") ?? "openclaw",
            sessionKey: parsed.values.get("session-key"),
            sessionId: parsed.values.get("session-id"),
            stateDir: parsed.values.get("state-dir"),
            profile: parsed.values.get("profile"),
            retries: boundedInteger(parsed.values, "retries", 1),
            maxNodes: boundedInteger(parsed.values, "max-nodes", 1),
            maxDepth: boundedInteger(parsed.values, "max-depth", 0),
            requireComplete: parsed.flags.has("require-complete"),
            force: parsed.flags.has("force"),
            keepSourceBundles: parsed.flags.has("keep-source-bundles"),
            migrateCopy: parsed.flags.has("migrate-copy"),
            legacyStateDir: parsed.values.get("legacy-state-dir"),
            migrationExecutable: parsed.values.get("migration-openclaw"),
            command: {
              signal: controller.signal,
              timeoutMs: boundedInteger(parsed.values, "timeout-ms", 1),
            },
          });
    const exitCode = completedExitCode(result.status, signalExit);
    if (signalExit) return exitCode;
    printResult(result, parsed.flags.has("json"));
    return exitCode;
  } catch (error) {
    if (signalExit) return signalExit;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}
