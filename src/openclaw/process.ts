import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

async function findExecutable(value: string): Promise<string> {
  if (value.includes("/") || value.includes("\\")) return value;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, value);
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  throw new Error(`Executable not found in PATH: ${value}`);
}

export async function resolveExecutable(path: string): Promise<{ path: string; sha256: string }> {
  const resolved = await realpath(await findExecutable(path));
  const details = await stat(resolved);
  if (!details.isFile() || (details.mode & 0o111) === 0)
    throw new Error(`OpenClaw executable is not a regular executable: ${path}`);
  const hash = createHash("sha256").update(await readFile(resolved));
  return { path: resolved, sha256: hash.digest("hex") };
}

export function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (options.signal?.aborted)
    return Promise.reject(new DOMException("OpenClaw command was interrupted", "AbortError"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      // Packaged OpenClaw may respawn its CLI. Own that POSIX process group so
      // cancellation stops every writer before callers remove private staging.
      detached: process.platform !== "win32",
    });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: 0 };
    let failure: Error | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (killError) {
        // A group that exited while cancellation was delivered needs no kill.
        if ((killError as NodeJS.ErrnoException).code !== "ESRCH")
          failure = new AggregateError([error, killError], "OpenClaw command termination failed");
      }
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (failure) return;
      output.bytes += chunk.length;
      if (output.bytes > maxBytes) {
        fail(new Error(`OpenClaw command output exceeded ${String(maxBytes)} bytes`));
        return;
      }
      output[target].push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      collect("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      collect("stderr", chunk);
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      cleanup();
      // Unlike exit, close waits for inherited stdout/stderr handles to close.
      if (failure) {
        reject(failure);
        return;
      }
      if (signal) {
        reject(new Error(`OpenClaw command terminated by ${signal}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        code: code ?? 1,
      });
    });
    const abort = () => {
      fail(new DOMException("OpenClaw command was interrupted", "AbortError"));
    };
    const timer = setTimeout(() => {
      fail(new Error(`OpenClaw command timed out after ${String(timeoutMs)} ms`));
    }, timeoutMs);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runOpenClaw(
  executable: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await runCommand(executable, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
    throw new Error(`OpenClaw command failed: ${detail}`);
  }
  return result;
}
