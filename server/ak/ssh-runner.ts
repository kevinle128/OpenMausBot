import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { AkError, akEnvironment, type AkRunner } from "./cli.ts";

const TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_S = 10;
const SSH_FAILED = 255;
const DEFAULT_KEY = join(homedir(), ".ssh", "omb_laptop_ak");
// user@host, a host name or an address; never something that starts with "-", which ssh would read as an option.
const DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/;

export interface SshAkRunnerOptions {
  host: string;
  /** The private key the laptop's gate accepts. */
  key?: string;
  /** The ssh program; replaced by tests. */
  ssh?: string;
}

/** The ssh destination from `OMB_AK_SSH`, or null when `ak` runs on this device. */
export function remoteAkHost(source: NodeJS.ProcessEnv = process.env): string | null {
  const host = source.OMB_AK_SSH?.trim();
  return host ? host : null;
}

/** The gate on the laptop reads the arguments after `ak` as base64url (no padding) of a JSON array. */
export function encodeGateCommand(args: string[]): string {
  return Buffer.from(JSON.stringify(args), "utf8").toString("base64url");
}

/**
 * Runs every `ak` command on another device over SSH. The key there is forced to a gate that decodes the arguments, allows
 * only `ak secrets` commands, forwards stdin untouched and exits with ak's exit code. Secret values are in no argument:
 * they go on stdin, exactly as with the local runner.
 */
export function sshAkRunner(options: SshAkRunnerOptions): AkRunner {
  const { host } = options;
  const key = options.key ?? DEFAULT_KEY;
  const ssh = options.ssh ?? "ssh";
  const unreachable = (why: string) => new AkError("unavailable", null, `The laptop (${host}) is unreachable over SSH: ${why}`);
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      if (!DESTINATION.test(host)) return reject(new AkError("unavailable", null, "OMB_AK_SSH is not a valid ssh destination"));
      const child = execFile(
        ssh,
        ["-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", `ConnectTimeout=${CONNECT_TIMEOUT_S}`, "--", host, encodeGateCommand(args)],
        { env: akEnvironment(), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) return resolve({ exitCode: 0, stdout, stderr });
          const code = (error as { code?: string | number }).code;
          if (code === SSH_FAILED) return reject(unreachable(stderr.trim().split("\n")[0] || "ssh failed"));
          if (typeof code === "number") return resolve({ exitCode: code, stdout, stderr });
          reject(code === "ENOENT" ? new AkError("unavailable", null, "The ssh program was not found") : unreachable(error.message.split("\n")[0] ?? "ssh could not run"));
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin ?? "");
    });
}

/** The runner for this device: SSH to the laptop when `OMB_AK_SSH` is set, the local `ak` otherwise. */
export function akRunnerFromEnv(source: NodeJS.ProcessEnv = process.env, local: () => AkRunner): AkRunner {
  const host = remoteAkHost(source);
  if (host === null) return local();
  const key = source.OMB_AK_SSH_KEY?.trim();
  return sshAkRunner({ host, ...(key ? { key: key.startsWith("~/") ? join(homedir(), key.slice(2)) : key } : {}) });
}
