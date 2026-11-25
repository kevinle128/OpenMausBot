export declare const VERSION: string;
export declare const EXIT: Readonly<Record<"done" | "invalid" | "missing" | "exists" | "unreachable" | "refused" | "pending" | "limited", number>>;
export declare class CliError extends Error {
  exitCode: number;
  errorCode: string;
  constructor(exitCode: number, message: string, errorCode?: string);
}
export interface Writable {
  write(chunk: string | Uint8Array): boolean | void;
  once?(event: string, listener: () => void): unknown;
}
export interface Deps {
  env: Record<string, string | undefined>;
  platform: string;
  home: string;
  cwd: () => string;
  ppid: number;
  procRoot: string;
  nodePath: string;
  selfPath: string;
  stdin: AsyncIterable<Uint8Array>;
  stdinIsTTY: boolean;
  stdout: Writable;
  stdoutIsTTY: boolean;
  stderr: Writable;
  proc: { on(signal: string, handler: () => void): unknown; off(signal: string, handler: () => void): unknown };
  fetch: typeof fetch;
  ps: (args: string[]) => Promise<string>;
  security: (args: string[], input?: string) => Promise<string>;
}
export interface Harness {
  id: string;
  label: string;
  recognised: boolean;
  base: string | null;
  env?: string;
  sub?: string;
  reason?: string;
  /** How the parent-process walk names this harness: `bin` tests the file name, `path` the file path or a hosted script path. Absent for a harness omb cannot name. */
  agent?: { name: string; bin: RegExp; path?: RegExp };
}
export declare const HARNESSES: readonly Harness[];
export declare const SKILL_TEXT: string;
export declare function main(argv: string[], overrides?: Partial<Deps>): Promise<number>;
export declare function parseArgs(tokens: string[], spec: Record<string, "bool" | "value" | "repeat">): { flags: Record<string, any>; positionals: string[] };
export declare function isPrivateHost(host: string): boolean;
export declare function allowedServerOrigin(origin: string): boolean;
export declare function readPairingCode(raw: string): string | null;
export declare function readPairingTarget(input: string, serverFlag?: string): { origin: string; secret: string };
export declare function checkedOrigin(input: string): string;
export declare function configDir(env: Record<string, string | undefined>, home: string): string;
export declare function sha256File(path: string): Promise<string>;
export declare function findAgent(options: {
  platform: string;
  ps: (args: string[]) => Promise<string>;
  procRoot?: string;
  startPid: number;
  hashFile?: (path: string) => Promise<string>;
}): Promise<{ name: string; fingerprint: string; path: string } | null>;
export declare function checkEnvVar(name: string): string;
export declare function pinProgram(name: string, env: Record<string, string | undefined>, cwd: string): Promise<{ path: string; hash: string }>;
export declare function valueForms(value: string): Buffer[];
export declare function createScrubber(secrets: Array<{ ref: string; value: string }>): { push(chunk: Buffer): Buffer; end(): Buffer };
