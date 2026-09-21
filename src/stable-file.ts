import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";

export class StableFileError extends Error {
  constructor(readonly code: "not-regular-file" | "file-too-large" | "file-changed") {
    super(code);
  }
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

async function boundedRead(handle: FileHandle, size: number): Promise<Buffer> {
  // Read one extra byte so growth cannot be mistaken for a stable source.
  const bytes = Buffer.alloc(size + 1);
  let length = 0;
  while (length < bytes.length) {
    const result = await handle.read(bytes, length, bytes.length - length, length);
    if (result.bytesRead === 0) break;
    length += result.bytesRead;
  }
  if (length !== size) throw new StableFileError("file-changed");
  return Buffer.from(bytes.subarray(0, length));
}

export async function readStableFile(
  containedPath: () => Promise<string>,
  maxBytes: number,
): Promise<Buffer> {
  const path = await containedPath();
  const before = await lstat(path);
  if (!before.isFile()) throw new StableFileError("not-regular-file");
  if (before.size > maxBytes) throw new StableFileError("file-too-large");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameSnapshot(opened, before))
      throw new StableFileError("file-changed");
    const bytes = await boundedRead(handle, before.size);
    const after = await handle.stat();
    // Recheck the caller's containment policy while the descriptor is still owned.
    const finalPath = await containedPath();
    const final = await lstat(finalPath);
    if (!sameSnapshot(after, before) || !sameSnapshot(final, before))
      throw new StableFileError("file-changed");
    return bytes;
  } finally {
    await handle.close();
  }
}
