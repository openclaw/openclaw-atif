#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const destination = resolve(process.argv[2]);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
for (const metadata of [lock, lock.packages[""]]) {
  if (metadata.name !== pkg.name || metadata.version !== pkg.version)
    throw new Error("Package and lockfile identity differ");
}
mkdirSync(destination, { recursive: true });
// Build/checks have already run. Never rebuild between artifact smoke and publish.
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    encoding: "utf8",
  }),
);
const metadata = {
  PACKAGE_TARBALL: join(destination, packed.filename),
  PACKAGE_INTEGRITY: packed.integrity,
  PACKAGE_SHASUM: packed.shasum,
};
if (process.env.GITHUB_ENV)
  appendFileSync(
    process.env.GITHUB_ENV,
    Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
console.log(JSON.stringify(metadata, null, 2));
