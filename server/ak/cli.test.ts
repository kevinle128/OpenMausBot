import { describe, expect, it } from "vitest";
import { AkError, akEnvironment, createAkCli, type AkRunResult, type AkRunner } from "./cli.ts";

function recorder(result: Partial<AkRunResult> = {}) {
  const calls: { args: string[]; stdin: string | undefined }[] = [];
  const run: AkRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    return { exitCode: 0, stdout: JSON.stringify({ data: [] }), stderr: "", ...result };
  };
  return { calls, run };
}

describe("ak exit codes become typed errors", () => {
  const cases: [number, string][] = [
    [3, "no-such-ref"],
    [5, "backend"],
    [6, "agent-above-process"],
    [9, "cooldown"],
    [10, "failed"],
    [2, "invalid"],
    [1, "failed"],
  ];
  for (const [exitCode, kind] of cases) {
    it(`exit ${exitCode} is ${kind}`, async () => {
      const { run } = recorder({ exitCode, stdout: JSON.stringify({ error: "refused", exit_code: exitCode }) });
      const error = await createAkCli(run).delete("X").catch((caught) => caught);
      expect(error).toBeInstanceOf(AkError);
      expect(error).toMatchObject({ kind, exitCode, message: "refused" });
    });
  }
});

describe("ak commands", () => {
  it("passes a secret value on stdin only and never in the arguments", async () => {
    const { calls, run } = recorder();
    await createAkCli(run).set("API_KEY", "s3cret-value", { force: true });
    await createAkCli(run).rotate("API_KEY", "s3cret-value-2");
    expect(calls[0]).toEqual({ args: ["secrets", "set", "API_KEY", "--value=-", "--no-push", "--force", "--json", "--no-interactive"], stdin: "s3cret-value" });
    expect(calls[1]?.stdin).toBe("s3cret-value-2");
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("s3cret");
  });

  it("approves one request for a set time", async () => {
    const { calls, run } = recorder();
    await createAkCli(run).approve({ ref: "DB_PASSWORD", ttl: "24h", agent: "sha256:abc" });
    expect(calls[0]?.args).toEqual(["secrets", "approve", "DB_PASSWORD", "--state=ttl", "--ttl=24h", "--agent=sha256:abc", "--json", "--no-interactive"]);
  });

  it("passes every request flag as flag=value, so a value that looks like a flag stays a value", async () => {
    const { calls, run } = recorder();
    const cli = createAkCli(run);
    await cli.approve({ ref: "R", ttl: "24h", agent: "--yes", project: "-p", purpose: "--reveal", env: "" });
    await cli.deny({ ref: "R", purpose: "--state=ttl", env: "--exec" });
    expect(calls[0]?.args).toEqual(["secrets", "approve", "R", "--state=ttl", "--ttl=24h", "--agent=--yes", "--project=-p", "--purpose=--reveal", "--env=", "--json", "--no-interactive"]);
    expect(calls[1]?.args).toEqual(["secrets", "approve", "R", "--state=deny", "--purpose=--state=ttl", "--env=--exec", "--json", "--no-interactive"]);
    for (const call of calls) expect(call.args.filter((arg) => arg.startsWith("-") && !arg.includes("="))).toEqual(["--json", "--no-interactive"]);
  });

  it("grants an exec scope by its program with every value as flag=value", async () => {
    const { calls, run } = recorder();
    await createAkCli(run).grantExec({ ref: "R", ttl: "24h", agent: "sha256:abc", env: "SSHPASS", program: "/usr/bin/true", project: "default", agentLabel: "claude" });
    expect(calls[0]?.args).toEqual(["secrets", "grant", "R", "--agent=sha256:abc", "--exec=/usr/bin/true", "--env=SSHPASS", "--ttl=24h", "--purpose=", "--project=default", "--agent-label=claude", "--json", "--no-interactive"]);
    await createAkCli(run).revokeExec({ ref: "R", agent: "sha256:abc", env: "SSHPASS", program: "/usr/bin/true", project: "default" });
    expect(calls[1]?.args).toEqual(["secrets", "revoke", "R", "--agent=sha256:abc", "--exec=/usr/bin/true", "--env=SSHPASS", "--purpose=", "--project=default", "--json", "--no-interactive"]);
  });

  it("lists the inbox whether ak returns an array or an object", async () => {
    expect(await createAkCli(recorder({ stdout: JSON.stringify({ data: [{ ref: "A" }] }) }).run).pendingRequests()).toEqual([{ ref: "A" }]);
    expect(await createAkCli(recorder({ stdout: JSON.stringify({ data: { requests: [{ ref: "B" }] } }) }).run).pendingRequests()).toEqual([{ ref: "B" }]);
  });

  it("lists, approves and denies requests from other devices through approvals, never secrets approve", async () => {
    const { calls, run } = recorder({ stdout: JSON.stringify({ data: { approvals: [{ id: "3f2a", ref: "A" }] } }) });
    const cli = createAkCli(run);
    expect(await cli.remoteRequests()).toEqual([{ id: "3f2a", ref: "A" }]);
    await cli.approveRemote({ id: "3f2a", ttl: "24h" });
    await cli.denyRemote({ id: "3f2a" });
    expect(calls.map((call) => call.args)).toEqual([
      ["secrets", "approvals", "list", "--json", "--no-interactive"],
      ["secrets", "approvals", "approve", "3f2a", "--ttl=24h", "--json", "--no-interactive"],
      ["secrets", "approvals", "deny", "3f2a", "--json", "--no-interactive"],
    ]);
  });

  it("refuses a request id that would be read as a flag, without running ak", async () => {
    const { calls, run } = recorder();
    const error = await createAkCli(run).denyRemote({ id: "--yes" }).catch((caught) => caught);
    expect(error).toMatchObject({ kind: "invalid" });
    expect(calls).toEqual([]);
  });

  it("reports sync off as its own error kind, from the sync reason in the error envelope", async () => {
    const stdout = JSON.stringify({ schema_version: 1, error: "secrets approvals list: sync is not enabled on this device", error_code: "validation_failed", exit_code: 10, sync: { reason: "not_enabled" } });
    const error = await createAkCli(recorder({ exitCode: 10, stdout }).run).remoteRequests().catch((caught) => caught);
    expect(error).toMatchObject({ kind: "sync-off", exitCode: 10 });
  });

  it("gives ak only the environment it needs", () => {
    expect(akEnvironment({ PATH: "/bin", HOME: "/h", AGENTKIT_HOME: "/a", OPENAI_API_KEY: "x", OMB_TOKEN: "y" })).toEqual({ PATH: "/bin", HOME: "/h", AGENTKIT_HOME: "/a" });
  });
});
