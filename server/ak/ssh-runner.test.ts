import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AkError, createAkCli, type AkRunner } from "./cli.ts";
import { akRunnerFromEnv, encodeGateCommand, remoteAkHost, sshAkRunner } from "./ssh-runner.ts";
import { createAkGuard } from "./guard.ts";
import { startInboxWatcher } from "./inbox-watcher.ts";
import { startVaultSync } from "./vault-sync.ts";

/** A stand-in `ssh` that records its arguments and stdin, prints the given text and exits with the given code. */
function fakeSsh(exit: number, stdout = "", stderr = "") {
  const dir = mkdtempSync(join(tmpdir(), "omb-ssh-"));
  const bin = join(dir, "ssh");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat > "${dir}/stdin"\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${exit}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, args: () => readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n"), stdin: () => readFileSync(join(dir, "stdin"), "utf8") };
}

const decode = (encoded: string): unknown => JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

describe("ssh runner", () => {
  it("sends the arguments as unpadded base64url JSON and forwards stdin", async () => {
    const ssh = fakeSsh(0, '{"data":[]}');
    const run = sshAkRunner({ host: "dale@100.98.220.71", key: "/k/omb", ssh: ssh.bin });
    const args = ["secrets", "set", "REF", "--value=-", "--no-push", "--force", "--json", "--no-interactive"];
    const result = await run(args, "s3cret-value");
    expect(result).toEqual({ exitCode: 0, stdout: '{"data":[]}', stderr: "" });
    const sent = ssh.args();
    expect(sent.slice(0, 9)).toEqual(["-i", "/k/omb", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10", "--"]);
    expect(sent[9]).toBe("dale@100.98.220.71");
    expect(sent[10]).toBe(encodeGateCommand(args));
    expect(sent[10]).not.toMatch(/[=+/]/);
    expect(decode(sent[10]!)).toEqual(args);
    expect(sent.join(" ")).not.toContain("s3cret");
    expect(ssh.stdin()).toBe("s3cret-value");
  });

  it("returns the exit code and stderr of ak, including a refusal by the gate", async () => {
    const ssh = fakeSsh(126, "", "omb-ak-gate: refused: nope");
    const result = await sshAkRunner({ host: "h", ssh: ssh.bin })(["x"], undefined);
    expect(result).toEqual({ exitCode: 126, stdout: "", stderr: "omb-ak-gate: refused: nope" });
    const failed = await createAkCli(sshAkRunner({ host: "h", ssh: ssh.bin })).list().catch((error) => error);
    expect(failed).toMatchObject({ kind: "failed", exitCode: 126, message: "omb-ak-gate: refused: nope" });
  });

  it("keeps the typed errors of ak", async () => {
    const ssh = fakeSsh(3, '{"error":"no such ref","exit_code":3}');
    const failed = await createAkCli(sshAkRunner({ host: "h", ssh: ssh.bin })).delete("X").catch((error) => error);
    expect(failed).toMatchObject({ kind: "no-such-ref", exitCode: 3 });
  });

  it("maps an ssh failure (exit 255) to unavailable and names the laptop", async () => {
    const ssh = fakeSsh(255, "", "ssh: connect to host 100.98.220.71 port 22: Connection refused");
    const failed = await createAkCli(sshAkRunner({ host: "dale@100.98.220.71", ssh: ssh.bin })).list().catch((error) => error);
    expect(failed).toBeInstanceOf(AkError);
    expect(failed).toMatchObject({ kind: "unavailable", exitCode: null });
    expect(failed.message).toContain("The laptop (dale@100.98.220.71) is unreachable");
    expect(failed.message).toContain("Connection refused");
  });

  it("maps a missing ssh program to unavailable", async () => {
    const failed = await sshAkRunner({ host: "h", ssh: "/nonexistent/ssh" })(["x"], undefined).catch((error) => error);
    expect(failed).toMatchObject({ kind: "unavailable" });
  });

  it("refuses a destination that ssh would read as an option", async () => {
    const failed = await sshAkRunner({ host: "-oProxyCommand=x", ssh: "/nonexistent/ssh" })(["x"], undefined).catch((error) => error);
    expect(failed).toMatchObject({ kind: "unavailable", message: "OMB_AK_SSH is not a valid ssh destination" });
  });

  it("is chosen by OMB_AK_SSH and the local runner is used without it", async () => {
    const local: AkRunner = async () => ({ exitCode: 0, stdout: "local", stderr: "" });
    expect(remoteAkHost({})).toBeNull();
    expect(remoteAkHost({ OMB_AK_SSH: " d@h " })).toBe("d@h");
    expect(await akRunnerFromEnv({}, () => local)(["x"], undefined)).toMatchObject({ stdout: "local" });
    expect(await akRunnerFromEnv({ OMB_AK_SSH: "   " }, () => local)(["x"], undefined)).toMatchObject({ stdout: "local" });
    const failed = await akRunnerFromEnv({ OMB_AK_SSH: "-bad" }, () => local)(["x"], undefined).catch((error) => error);
    expect(failed).toBeInstanceOf(AkError);
  });
});

describe("with ak on another device", () => {
  const silent = () => {};

  it("the inbox watcher works from its check cycle with no pending file and nothing local watched", async () => {
    let listed = 0;
    const cli = {
      pendingRequests: async () => {
        listed += 1;
        return [];
      },
      approve: async () => {},
      deny: async () => {},
      grantExec: async () => null,
      revokeExec: async () => {},
      grants: async () => [],
    };
    const watcher = startInboxWatcher({
      cli,
      guard: createAkGuard(silent),
      approvals: { has: () => false, keys: () => [], close: () => {}, open: () => true } as never,
      owns: () => false,
      bot: () => ({ threadId: "t" }) as never,
      notify: silent,
      screenLocked: async () => false,
      log: silent,
      remote: true,
      secretsDir: "/nonexistent/omb-no-such-dir",
      pollMs: 20,
    });
    await new Promise((done) => setTimeout(done, 120));
    watcher.stop();
    expect(listed).toBeGreaterThan(2);
  });

  it("the vault sync copies a secret through the runner", async () => {
    const calls: string[][] = [];
    const run: AkRunner = async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify({ data: [] }), stderr: "" };
    };
    const vault = {
      version: 1,
      listSecrets: () => [{ id: "s1", name: "API_KEY", bots: "all", updatedAt: 1 }] as never,
      secret: () => ({ value: "v" }) as never,
    };
    const dataDir = mkdtempSync(join(tmpdir(), "omb-sync-"));
    const sync = startVaultSync({ vault, cli: createAkCli(run), guard: createAkGuard(silent), dataDir, botId: "paseo", log: silent });
    await sync.reconcile();
    sync.stop();
    expect(calls.some((args) => args[1] === "set" && args[2] === "API_KEY")).toBe(true);
  });
});
