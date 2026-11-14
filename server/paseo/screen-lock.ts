import { execFile } from "node:child_process";

/** macOS keeps the console lock state in the IORegistry root, which a server with no desktop shell around it can read. */
const LOCKED = /<key>(?:IOConsoleLocked|CGSSessionScreenIsLocked)<\/key>\s*<true\/>/;

export function isMacScreenLocked(registry: string): boolean {
  return LOCKED.test(registry);
}

/** Whether the screen of the computer this server runs on is locked. False on any other system, and when it cannot be read. */
export function readScreenLocked(platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], { timeout: 2_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(!error && isMacScreenLocked(stdout));
    });
  });
}
