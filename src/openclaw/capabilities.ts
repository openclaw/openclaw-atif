import { parseFinalJsonObject } from "./json-output.js";
import { type CommandOptions, resolveExecutable, runOpenClaw } from "./process.js";

export interface OpenClawCapability {
  executable: string;
  executableSha256: string;
  version: string;
  trajectoryExport: boolean;
}

async function supportsTrajectoryExport(
  executable: string,
  options: CommandOptions,
): Promise<boolean> {
  try {
    const help = await runOpenClaw(
      executable,
      ["sessions", "export-trajectory", "--help"],
      options,
    );
    return `${help.stdout}\n${help.stderr}`.includes("export-trajectory");
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return false;
  }
}

export async function probeOpenClaw(
  executable: string,
  options: CommandOptions = {},
): Promise<OpenClawCapability> {
  const resolved = await resolveExecutable(executable);
  const versionResult = await runOpenClaw(resolved.path, ["--version"], options);
  const version = versionResult.stdout.trim() || versionResult.stderr.trim();
  if (!version) throw new Error("OpenClaw did not report a version");
  const trajectoryExport = await supportsTrajectoryExport(resolved.path, options);
  return {
    executable: resolved.path,
    executableSha256: resolved.sha256,
    version,
    trajectoryExport,
  };
}

export function parseStructuredOutput(output: string): Record<string, unknown> {
  return parseFinalJsonObject(output);
}
