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
    expect(calls[0]?.args).toEqual(["secrets", "approve", "DB_PASSWORD", "--state", "ttl", "--ttl", "24h", "--agent", "sha256:abc", "--json", "--no-interactive"]);
  });

  it("lists the inbox whether ak returns an array or an object", async () => {
    expect(await createAkCli(recorder({ stdout: JSON.stringify({ data: [{ ref: "A" }] }) }).run).pendingRequests()).toEqual([{ ref: "A" }]);
    expect(await createAkCli(recorder({ stdout: JSON.stringify({ data: { requests: [{ ref: "B" }] } }) }).run).pendingRequests()).toEqual([{ ref: "B" }]);
  });

  it("gives ak only the environment it needs", () => {
    expect(akEnvironment({ PATH: "/bin", HOME: "/h", AGENTKIT_HOME: "/a", OPENAI_API_KEY: "x", OMB_TOKEN: "y" })).toEqual({ PATH: "/bin", HOME: "/h", AGENTKIT_HOME: "/a" });
  });
});
