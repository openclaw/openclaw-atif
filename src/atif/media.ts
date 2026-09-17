import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../diagnostics.js";
import { asRecord } from "../json.js";
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

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function reference(block: Record<string, unknown>, type: "image" | "audio"): MediaPart {
  const source = asRecord(block.source) ?? asRecord(block[`${type}_url`]) ?? block;
  const mediaType = firstValue(source, ["media_type", "mediaType", "mimeType", "mime_type"]);
  const path = firstValue(source, ["url", "path", "file_path", "filePath"]);
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

async function containedFile(root: string, location: string): Promise<string> {
  const base = resolve(root);
  if ((await realpath(base)) !== base) throw new MediaError("media-unsafe-path");
  const path = resolve(base, location);
  const local = relative(base, path);
  if (!local || local.split(sep).includes("..") || isAbsolute(local))
    throw new MediaError("media-unsafe-path");
  // Check every component, including directory symlinks that point back inside the bundle.
  let current = base;
  for (const component of local.split(sep)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new MediaError("media-unsafe-path");
  }
  if ((await realpath(path)) !== path) throw new MediaError("media-unsafe-path");
  return path;
}

async function boundedRead(handle: FileHandle, size: number): Promise<Buffer> {
  // Read one extra byte so growth cannot be mistaken for a stable source.
  const bytes = Buffer.alloc(size + 1);
  let length = 0;
  while (length < bytes.length) {
    const result = await handle.read(bytes, length, bytes.length - length, length);
    if (result.bytesRead === 0) break;
    length += result.bytesRead;
  }
  if (length !== size) throw new MediaError("media-file-changed");
  return Buffer.from(bytes.subarray(0, length));
}

async function readMedia(root: string, location: string): Promise<Buffer> {
  const path = await containedFile(root, location);
  const before = await lstat(path);
  if (!before.isFile()) throw new MediaError("media-not-regular-file");
  if (before.size > MAX_MEDIA_BYTES) throw new MediaError("media-file-too-large");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameSnapshot(opened, before))
      throw new MediaError("media-file-changed");
    const bytes = await boundedRead(handle, before.size);
    const after = await handle.stat();
    const finalPath = await containedFile(root, location);
    const final = await lstat(finalPath);
    if (!sameSnapshot(after, before) || !sameSnapshot(final, before))
      throw new MediaError("media-file-changed");
    return bytes;
  } finally {
    await handle.close();
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
