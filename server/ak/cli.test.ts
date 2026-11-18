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
      ["secrets", "approvals", "approve", "--ttl=24h", "--json", "--no-interactive", "--", "3f2a"],
      ["secrets", "approvals", "deny", "--json", "--no-interactive", "--", "3f2a"],
    ]);
  });

  it("reads the real approvals list item: request_id, agent label and requester device", async () => {
    const item = {
      request_id: "bMTgjCYBg7wFZ5W-S8hQlg",
      ref: "API_KEY",
      project: "default",
      agent: "claude",
      fingerprint: "sha256:" + "a".repeat(64),
      purpose: "deploy",
      max_ttl_s: 86400,
      requester: "Pf89RqzJHzGDTaPNBvemIA",
      requester_label: null,
      requester_kind: "human",
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-01T01:00:00Z",
    };
    const [first] = await createAkCli(recorder({ stdout: JSON.stringify({ data: { approvals: [item, { ...item, requester_label: "MacBook" }] } }) }).run).remoteRequests();
    expect(first).toMatchObject({ id: "bMTgjCYBg7wFZ5W-S8hQlg", ref: "API_KEY", agentLabel: "claude", device: "Pf89RqzJHzGDTaPNBvemIA", fingerprint: item.fingerprint, purpose: "deploy", project: "default" });
    expect((await createAkCli(recorder({ stdout: JSON.stringify({ data: { approvals: [{ ...item, requester_label: "MacBook" }] } }) }).run).remoteRequests())[0]?.device).toBe("MacBook");
  });

  it("takes blank, null and fingerprint values in a remote item as missing", async () => {
    const item = { request_id: "bMTgjCYBg7wFZ5W-S8hQlg", ref: "API_KEY", agent: "  ", requester: "Pf89RqzJHzGDTaPNBvemIA", requester_label: "  ", id: null, device: "" };
    const [blank] = await createAkCli(recorder({ stdout: JSON.stringify({ data: { approvals: [item] } }) }).run).remoteRequests();
    expect(blank).toMatchObject({ id: "bMTgjCYBg7wFZ5W-S8hQlg", device: "Pf89RqzJHzGDTaPNBvemIA" });
    expect(blank?.agentLabel).toBeUndefined();
    const fingerprint = "sha256:" + "b".repeat(64);
    const [printed] = await createAkCli(recorder({ stdout: JSON.stringify({ data: { approvals: [{ request_id: "x1", ref: "API_KEY", agent: fingerprint }] } }) }).run).remoteRequests();
    expect(printed?.agentLabel).toBeUndefined();
  });

  it("passes a request id that starts with \"-\" after \"--\", so ak reads it as the id and never as a flag", async () => {
    const { calls, run } = recorder();
    await createAkCli(run).approveRemote({ id: "-x3f2a", ttl: "24h" });
    await createAkCli(run).denyRemote({ id: "--yes" });
    expect(calls.map((call) => call.args)).toEqual([
      ["secrets", "approvals", "approve", "--ttl=24h", "--json", "--no-interactive", "--", "-x3f2a"],
      ["secrets", "approvals", "deny", "--json", "--no-interactive", "--", "--yes"],
    ]);
  });

  it("refuses a request id that is not base64url, without running ak", async () => {
    const { calls, run } = recorder();
    const error = await createAkCli(run).denyRemote({ id: "a/b" }).catch((caught) => caught);
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
