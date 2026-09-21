import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { asRecord } from "../json.js";
import { readStableFile, StableFileError } from "../stable-file.js";
import { type AtifContentPart, contentPartSchema } from "./schema.js";

export const MAX_MEDIA_FILES = 64;
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

type MediaPart = Exclude<AtifContentPart, { type: "text" }>;
const EXTENSIONS: Readonly<Record<MediaPart["source"]["media_type"], string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "audio/aiff": "aiff",
};

class MediaError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function mediaKind(type: string): "image" | "audio" | undefined {
  if (["image", "image_url", "input_image"].includes(type)) return "image";
  return type === "audio" ? "audio" : undefined;
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  return keys.map((key) => record[key]).find((value) => value !== undefined && value !== null);
}

function sourceRecord(
  block: Record<string, unknown>,
  type: "image" | "audio",
): Record<string, unknown> {
  return (
    asRecord(block.source) ??
    asRecord(block[`${type}_url`]) ??
    (type === "image" ? asRecord(block.input_image) : undefined) ??
    block
  );
}

function reference(block: Record<string, unknown>, type: "image" | "audio"): MediaPart {
  const source = sourceRecord(block, type);
  const mediaType = firstValue(source, ["media_type", "mediaType", "mimeType", "mime_type"]);
  const path = firstValue(source, ["url", "path", "file_path", "filePath", `${type}_url`]);
  const duration = source.duration_sec ?? block.duration_sec;
  const parsed = contentPartSchema.safeParse({
    type,
    source: {
      media_type: mediaType,
      path,
      ...(type === "audio" && duration != null ? { duration_sec: duration } : {}),
    },
  });
  if (!parsed.success || parsed.data.type === "text")
    throw new MediaError("media-source-unsupported");
  return parsed.data;
}

function externalReference(path: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  try {
    const url = new URL(path);
    if (/^https?:\/\//.test(path) && url.hostname) return true;
    if (url.protocol === "data:" && /^data:[^,]+,/.test(path)) return true;
  } catch {
    /* Invalid locations are omitted, not interpreted as file names. */
  }
  throw new MediaError("media-location-unsupported");
}

function localPath(root: string, target: string): string | undefined {
  const location = relative(root, target);
  if (!location || location.split(sep).includes("..") || isAbsolute(location)) return undefined;
  return location;
}

async function containedFile(root: string, location: string): Promise<string> {
  const requestedBase = resolve(root);
  if ((await lstat(requestedBase)).isSymbolicLink()) throw new MediaError("media-unsafe-path");
  const base = await realpath(requestedBase);
  const requestedPath = resolve(requestedBase, location);
  const local =
    localPath(requestedBase, requestedPath) ??
    (isAbsolute(location) ? localPath(base, requestedPath) : undefined);
  if (!local) throw new MediaError("media-unsafe-path");
  const path = resolve(base, local);
  // Check every component, including directory symlinks that point back inside the bundle.
  let current = base;
  for (const component of local.split(sep)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new MediaError("media-unsafe-path");
  }
  if ((await realpath(path)) !== path) throw new MediaError("media-unsafe-path");
  return path;
}

async function readMedia(root: string, location: string): Promise<Buffer> {
  try {
    return await readStableFile(() => containedFile(root, location), MAX_MEDIA_BYTES);
  } catch (error) {
    if (error instanceof StableFileError) throw new MediaError(`media-${error.code}`);
    throw error;
  }
}

/** One store per family. Only referenced media is read; no remote content is fetched. */
export class MediaStore {
  readonly files = new Map<string, Buffer>();
  private readonly namesByDigest = new Map<string, string>();

  async part(
    block: Record<string, unknown>,
    type: "image" | "audio",
    bundleDirectory: string,
    diagnostics: Diagnostic[],
    nodeKey: string,
    eventId?: string,
  ): Promise<MediaPart | undefined> {
    try {
      const part = reference(block, type);
      if (externalReference(part.source.path)) return part;
      const bytes = await readMedia(bundleDirectory, part.source.path);
      const digest = createHash("sha256").update(bytes).digest("hex");
      let name = this.namesByDigest.get(digest);
      if (!name) {
        if (this.files.size >= MAX_MEDIA_FILES) throw new MediaError("media-file-limit");
        name = `media/${digest}.${EXTENSIONS[part.source.media_type]}`;
        this.files.set(name, bytes);
        this.namesByDigest.set(digest, name);
      }
      part.source.path = name;
      return part;
    } catch (error) {
      diagnostics.push({
        code: error instanceof MediaError ? error.code : "media-file-unavailable",
        message: `The ${type} source could not be retained and was omitted`,
        nodeKey,
        eventId,
      });
      return undefined;
    }
  }
}
