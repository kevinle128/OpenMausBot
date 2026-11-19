import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { SecretsError } from "./types.ts";

/** A grants or requests file that exists but cannot be read is never treated as empty: that would drop every block. */
export function readStateFile<S extends z.ZodType>(file: string, schema: S, empty: z.infer<S>): z.infer<S> {
  // Only a file that is not there is empty; any other failure to read it (permissions, I/O) fails closed.
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw new SecretsError(5, "store_unavailable", "the secrets state file could not be read");
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new SecretsError(5, "store_unavailable", "the secrets state file could not be read");
  }
}

export function writeStateFile(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    throw new SecretsError(5, "store_unavailable", "the secrets state file could not be written");
  }
}
