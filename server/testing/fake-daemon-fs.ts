import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PaseoPathInspection } from "../paseo/connection.ts";

const OUTSIDE = "Access outside of workspace is not allowed";
const none = (error: string | null = null): PaseoPathInspection => ({ exists: false, kind: null, size: null, error });
const outside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/** Answers a path inspection the way the Paseo daemon does for a working directory on this disk: `lstat` on the entry itself,
 * and a path that leaves the working directory, by name or through a linked folder, is refused with an error. */
export function inspectOnThisDisk(cwd: string, path: string): Promise<PaseoPathInspection> {
  const target = resolve(cwd, path);
  if (outside(cwd, target)) return Promise.resolve(none(OUTSIDE));
  let entry = target;
  try {
    if (target !== resolve(cwd)) {
      const parent = realpathSync(dirname(target));
      if (outside(realpathSync(cwd), parent)) return Promise.resolve(none(OUTSIDE));
      entry = join(parent, basename(target));
    }
    const stats = lstatSync(entry);
    const kind = stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
    return Promise.resolve({ exists: true, kind, size: stats.size, error: null });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return Promise.resolve(code === "ENOENT" || code === "ENOTDIR" ? none() : none(String(code ?? error)));
  }
}
