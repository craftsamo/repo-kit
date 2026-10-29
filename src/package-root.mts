import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The root of the repo-kit package itself. Source files sit in src/ and
 * built ones in dist/, both one level below it, so the same path works from
 * either. The repository a command works on is a different directory; see
 * repository-root.mts.
 */
export const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** A file or directory shipped in the package's assets/ directory. */
export function assetPath(...segments: string[]): string {
  return path.join(packageRoot, "assets", ...segments);
}

export function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}
