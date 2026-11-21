// omb runs its command line when it is the entry file of a process, so it is loaded by file path and never bundled.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { copyOmb, findNode, loadOmb, ombInstallPath, runOmb } from "../../electron/omb-install.mjs";
import type { SkillRow } from "../../shared/omb-skill.ts";
import { EXIT, SecretsError } from "./types.ts";

export interface SkillInstaller {
  list(): Promise<SkillRow[]>;
  install(harnesses: string[]): Promise<{ rows: SkillRow[]; command: string }>;
}

type Environment = Record<string, string | undefined>;

export interface SkillInstallerOptions {
  /** The server's environment: which folders agents use, and the PATH that finds node. */
  environment?: Environment;
  home?: string;
  /** Where omb.mjs is; by default beside the server bundle, or in the source tree. */
  source?: string;
  load?: typeof loadOmb;
}

const here = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

function ombSource(): string | null {
  const candidates = [here("./bin/omb.mjs"), here("../../bin/omb.mjs")];
  return candidates.find((file) => existsSync(file)) ?? null;
}

export function createSkillInstaller(options: SkillInstallerOptions = {}): SkillInstaller {
  const environment = options.environment ?? (process.env as Environment);
  const home = options.home ?? environment.HOME ?? homedir();
  const load = options.load ?? loadOmb;
  const run = async (argv: string[]) => {
    const source = options.source ?? ombSource();
    if (source === null || !existsSync(source)) throw new SecretsError(EXIT.unavailable, "not_available", "this server does not carry the omb command, so it cannot install the skill");
    const omb = await load(source);
    return { source, result: await runOmb(omb, argv, { env: environment, home, nodePath: findNode(environment.PATH).path, selfPath: ombInstallPath(home) }) };
  };
  const rowsOf = (data: { rows?: unknown } | null): SkillRow[] | null => (Array.isArray(data?.rows) ? data.rows as SkillRow[] : null);
  return {
    async list() {
      const { result } = await run(["skill", "list"]);
      return rowsOf(result.data) ?? [];
    },
    async install(harnesses) {
      const { source } = await run(["skill", "list"]);
      let command: string;
      try { command = copyOmb({ source, home }).path; } catch { throw new SecretsError(EXIT.unavailable, "store_unavailable", "the omb command could not be written on this server"); }
      const { result } = await run(["skill", "install", "--harness", harnesses.join(",")]);
      const rows = rowsOf(result.data);
      if (rows !== null) return { rows, command };
      const invalid = result.code === EXIT.invalid;
      throw new SecretsError(invalid ? EXIT.invalid : EXIT.unavailable, invalid ? "invalid_request" : "store_unavailable", result.error ?? "the skill could not be installed");
    },
  };
}
