import { afterEach, describe, expect, it } from "vitest";
import { stubPorts } from "./adapters/stub.ts";
import { askCardOf, portHandlers } from "./command-handlers.ts";
import { orchestratorConfigSchema, resolveForRepo } from "./config.ts";
import type { CommandContext, OrchestratorPorts } from "./handlers.ts";
import { ForgeNotReadyError, ForgeRefusedError, PortUnavailableError, type ForgePort, type OwnerResolver } from "./ports.ts";
import { DEFAULT_PR_KEY, ev, SHA_A, SHA_B } from "./testing/builders.ts";
import { fakeRuntime, FAKE_OWNER, type FakeRuntime } from "./testing/fake-runtime.ts";
import { makeHarness, type Harness } from "./testing/pm-harness.ts";
import { recordingPorts, type RecordedCall } from "./testing/recording-ports.ts";
import type { CommandPayload, CommandRecord, CommandResult, CommandWait, Owner, PrRecord } from "./types.ts";

let h: Harness;
afterEach(() => h.close());

const handlers = portHandlers();
const ALL_ON: CommandContext["installed"] = { forge: () => true, notifier: true, runtime: true };

interface Setup {
  runtime: FakeRuntime;
  calls: RecordedCall[];
  bound: Owner[];
  ctx: (patch?: Partial<CommandContext>, record?: PrRecord | null) => CommandContext;
  forge: { details?: ForgePort["details"]; merge?: ForgePort["merge"] };
  resolvers: OwnerResolver[];
}

function setup(doc: Record<string, unknown> = {}): Setup {
  h = makeHarness();
  h.send(ev.opened());
  const runtime = fakeRuntime();
  const recording = recordingPorts();
  const state: Setup = { runtime, calls: recording.calls, bound: [], forge: {}, resolvers: [], ctx: () => { throw new Error("unset"); } };
  const forge = (provider: "github" | "gitlab"): ForgePort => ({
    ...recording.ports.forge[provider],
    details: pr => (state.forge.details ?? recording.ports.forge[provider].details)(pr),
    merge: (pr, opts) => (state.forge.merge ?? recording.ports.forge[provider].merge)(pr, opts),
  });
  const ports: OrchestratorPorts = {
    ...stubPorts(), ...recording.ports, runtime: runtime.port, forge: { github: forge("github"), gitlab: forge("gitlab") },
    get resolvers() { return state.resolvers; },
  };
  const config = orchestratorConfigSchema.parse({ enabled: true, ...doc });
  state.ctx = (patch = {}, record = h.record()) => ({
    record, config: resolveForRepo(config, "github", "acme/widgets"), now: h.clock.now(), ports,
    bindOwner: owner => { state.bound.push(owner); }, installed: ALL_ON, subjectLabel: record ? `${record.repo}#${record.number}` : "thread:t1",
    mergeSha: SHA_B, log: line => h.logs.push(line), wait: { portSeconds: 60, forgeSeconds: 30 }, ...patch,
  });
  return state;
}

let counter = 0;
function command(payload: CommandPayload, subjectKey = DEFAULT_PR_KEY): CommandRecord {
  const id = `cmd-${++counter}`;
  return {
    id, subjectKey, type: payload.type, routineId: "test", idemKey: id, status: "running", outcome: null, approvalId: null, attempts: 1, nextAt: 0, createdAt: 0, updatedAt: 0,
    payload, result: null, lastError: null,
  };
}

const tell = (headSha: string | null = SHA_A): CommandPayload => ({ type: "TellOwner", template: "merged", headSha, vars: { repo: "acme/widgets", number: 1, url: "u", mergeSha: SHA_B }, untrusted: {} });
const instruct = (to: "owner" | "new-agent", extra: Partial<Extract<CommandPayload, { type: "RunInstruction" }>> = {}): CommandPayload => ({
  type: "RunInstruction", to, headSha: SHA_A, prompt: "Fix {{repo}}", vars: { repo: "acme/widgets" }, untrusted: {}, harness: null, model: null, ...extra,
});
const ask = (kind: "decision" | "command_failed" | "approve_action", extra: Partial<Extract<CommandPayload, { type: "AskPerson" }>> = {}): CommandPayload =>
  ({ type: "AskPerson", kind, decisionId: "d1", gaps: [], gated: null, about: null, ...extra });
const merge = (head = SHA_A): CommandPayload => ({ type: "Merge", method: "squash", expectedHeadSha: head, deleteBranch: true });
const run = (type: keyof typeof handlers, c: CommandRecord, ctx: CommandContext): Promise<CommandResult | CommandWait> => handlers[type](c, ctx);

describe("command handlers", () => {
  it("records not installed for every port that is switched off, before any other check", async () => {
    const s = setup();
    const off: CommandContext["installed"] = { forge: () => false, notifier: false, runtime: false };
    const ended = { ...h.record(), state: "merged" as const };
    for (const [type, payload] of [
      ["TellOwner", tell(SHA_B)], ["RunInstruction", instruct("owner", { headSha: SHA_B })], ["AskPerson", ask("decision")],
      ["Notify", { type: "Notify", kind: "merged" } as const], ["Merge", merge(SHA_B)], ["RefreshDetails", { type: "RefreshDetails", headSha: SHA_B } as const],
    ] as const) {
      expect(await run(type, command(payload), s.ctx({ installed: off }, ended))).toEqual({ outcome: "skipped", reason: "not installed" });
    }
    expect(s.calls).toEqual([]);
    expect(s.runtime.sent).toEqual([]);
  });

  it("tells the bound owner with a message id that stays the same for the same text", async () => {
    const s = setup();
    const owned = { ...h.record(), owner: FAKE_OWNER };
    const first = command(tell());
    expect(await run("TellOwner", first, s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(await run("TellOwner", first, s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(s.runtime.sent).toHaveLength(2);
    expect(s.runtime.sent[0]?.messageId).toBe(s.runtime.sent[1]?.messageId);
    expect(s.runtime.sent[0]?.messageId).toMatch(new RegExp(`^${first.id}:[0-9a-f]{16}$`));
    expect(s.runtime.sent[0]?.message).toContain(`acme/widgets#1`);
    expect(await run("TellOwner", command(tell()), s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(s.runtime.sent[2]?.messageId).not.toBe(s.runtime.sent[0]?.messageId);
  });

  it("finds the owner through the resolver chain and records the binding", async () => {
    const s = setup();
    const seen: string[] = [];
    s.resolvers = [
      { name: "passes", resolve: async () => { seen.push("passes"); return "next"; } },
      { name: "throws", resolve: async () => { throw new Error("search failed"); } },
      { name: "finds", resolve: async () => { seen.push("finds"); return FAKE_OWNER; } },
      { name: "never", resolve: async () => { seen.push("never"); return "next"; } },
    ];
    expect(await run("TellOwner", command(tell()), s.ctx())).toEqual({ outcome: "succeeded" });
    expect(seen).toEqual(["passes", "finds"]);
    expect(s.bound).toEqual([FAKE_OWNER]);
    expect(s.runtime.sent).toHaveLength(1);
    expect(h.logs.some(line => line.includes("throws") && line.includes("search failed"))).toBe(true);
  });

  it("lets a resolver that cannot reach its port make the command wait", async () => {
    const s = setup();
    s.resolvers = [{ name: "down", resolve: async () => { throw new PortUnavailableError("daemon down"); } }];
    await expect(run("TellOwner", command(tell()), s.ctx())).rejects.toBeInstanceOf(PortUnavailableError);
    expect(s.runtime.sent).toEqual([]);
  });

  it("skips with owner not found when no link knows the PR", async () => {
    const s = setup();
    s.resolvers = [{ name: "none", resolve: async () => "next" }];
    expect(await run("TellOwner", command(tell()), s.ctx())).toEqual({ outcome: "skipped", reason: "owner not found" });
    expect(s.bound).toEqual([]);
  });

  it("sends to a running owner at once and succeeds", async () => {
    const s = setup();
    const owned = { ...h.record(), owner: FAKE_OWNER };
    s.runtime.alive = true;
    expect(await run("TellOwner", command(tell()), s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(s.runtime.sent).toHaveLength(1);
  });

  it("lets an unreachable runtime reach the bus, which makes the command wait", async () => {
    const s = setup();
    const owned = { ...h.record(), owner: FAKE_OWNER };
    const ports = { ...s.ctx().ports, runtime: { ...s.runtime.port, send: async () => { throw new PortUnavailableError("daemon down"); } } };
    await expect(run("TellOwner", command(tell()), s.ctx({ ports }, owned))).rejects.toBeInstanceOf(PortUnavailableError);
  });

  it("skips a message for an owner session that is gone", async () => {
    const s = setup();
    s.runtime.answer = "gone";
    const owned = { ...h.record(), owner: FAKE_OWNER };
    expect(await run("TellOwner", command(tell()), s.ctx({}, owned))).toEqual({ outcome: "skipped", reason: "owner session gone" });
  });

  it("skips a command for an older head", async () => {
    const s = setup();
    const owned = { ...h.record(), owner: FAKE_OWNER };
    expect(await run("TellOwner", command(tell(SHA_B)), s.ctx({}, owned))).toEqual({ outcome: "skipped", reason: "head moved" });
    expect(await run("Merge", command(merge(SHA_B)), s.ctx())).toEqual({ outcome: "skipped", reason: "head moved" });
    expect(s.runtime.sent).toEqual([]);
    expect(s.calls.filter(call => call.method === "merge")).toEqual([]);
  });

  it("skips a command of an ended PR, except the notice and the message to the owner", async () => {
    const s = setup();
    const ended = { ...h.record(), state: "merged" as const, owner: FAKE_OWNER };
    expect(await run("Merge", command(merge()), s.ctx({}, ended))).toEqual({ outcome: "skipped", reason: "PR ended" });
    expect(await run("AskPerson", command(ask("decision")), s.ctx({}, ended))).toEqual({ outcome: "skipped", reason: "PR ended" });
    expect(await run("Notify", command({ type: "Notify", kind: "merged" }), s.ctx({}, ended))).toEqual({ outcome: "succeeded" });
    expect(await run("TellOwner", command(tell()), s.ctx({}, ended))).toEqual({ outcome: "succeeded" });
  });

  it("skips the other notices and owner messages of an ended PR, and the merge ones of a closed PR", async () => {
    const s = setup();
    const merged = { ...h.record(), state: "merged" as const, owner: FAKE_OWNER };
    const closed = { ...h.record(), state: "closed" as const, owner: FAKE_OWNER };
    const conflict: CommandPayload = { ...tell(), template: "conflict" } as CommandPayload;
    expect(await run("TellOwner", command(conflict), s.ctx({}, merged))).toEqual({ outcome: "skipped", reason: "PR ended" });
    expect(await run("Notify", command({ type: "Notify", kind: "ready_no_auto_merge" }), s.ctx({}, merged))).toEqual({ outcome: "skipped", reason: "PR ended" });
    expect(await run("TellOwner", command(tell()), s.ctx({}, closed))).toEqual({ outcome: "skipped", reason: "PR ended" });
    expect(await run("Notify", command({ type: "Notify", kind: "merged" }), s.ctx({}, closed))).toEqual({ outcome: "skipped", reason: "PR ended" });
    expect(s.runtime.sent).toEqual([]);
  });

  it("starts one new agent in the owner's folder, and in the configured folder without an owner", async () => {
    const s = setup({ agents: { newAgent: { cwd: "/work/default", harness: "codex" } } });
    const owned = { ...h.record(), owner: FAKE_OWNER };
    const first = command(instruct("new-agent"));
    expect(await run("RunInstruction", first, s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(await run("RunInstruction", first, s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(s.runtime.spawned).toHaveLength(1);
    expect(s.runtime.spawned[0]).toMatchObject({
      requestId: first.id, cwd: "/work/owner", workspaceId: "ws-1", harness: "codex", model: "opus", brief: "Fix acme/widgets",
      labels: { "omb.command": first.id, "omb.pr": "acme/widgets#1" },
    });
    expect(await run("RunInstruction", command(instruct("new-agent")), s.ctx())).toEqual({ outcome: "succeeded" });
    expect(s.runtime.spawned[1]).toMatchObject({ cwd: "/work/default", workspaceId: null, harness: "codex", model: null });
  });

  it("skips a new agent when no folder or harness is known", async () => {
    const s = setup();
    expect(await run("RunInstruction", command(instruct("new-agent")), s.ctx())).toEqual({ outcome: "skipped", reason: "no place to run a new agent" });
    const withFolder = setup({ agents: { newAgent: { cwd: "/work/default" } } });
    expect(await run("RunInstruction", command(instruct("new-agent")), withFolder.ctx())).toEqual({ outcome: "skipped", reason: "no harness for a new agent" });
    expect(withFolder.runtime.spawned).toEqual([]);
  });

  it("tells the owner for an instruction to the owner", async () => {
    const s = setup();
    const owned = { ...h.record(), owner: FAKE_OWNER };
    expect(await run("RunInstruction", command(instruct("owner")), s.ctx({}, owned))).toEqual({ outcome: "succeeded" });
    expect(s.runtime.sent[0]?.message).toBe("Fix acme/widgets");
  });

  it("opens a decision card with the configured choices and an approval card with approve and reject", async () => {
    const s = setup({ escalation: { decisionChoices: ["Yes", "No"] } });
    const review = ev.reviewFinished({ status: "needs-person", head: SHA_A, reviewedSha: SHA_A });
    h.send(review);
    const result = await run("AskPerson", command(ask("decision")), s.ctx());
    expect(result).toMatchObject({ outcome: "succeeded", detail: { cardId: expect.any(String) } });
    const card = s.calls.find(call => call.method === "card");
    expect(card?.args[0]).toBe("decision");
    expect(card?.args[1]).toMatchObject({ decisionId: "d1", title: "Review needs your decision: acme/widgets#1", subject: { key: DEFAULT_PR_KEY, label: "acme/widgets#1" } });
    expect(card?.args[2]).toEqual([{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }]);

    const approval = askCardOf(command(ask("approve_action", { gated: { commandId: "held", command: "Merge", summary: "Merge acme/widgets#1" } })), s.ctx());
    expect(approval.answers).toEqual([{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }]);
    expect(approval.title).toBe("Approve: Merge acme/widgets#1?");
  });

  it("names the failed command and its reason on a command-failed card", async () => {
    const s = setup();
    const card = askCardOf(command(ask("command_failed", { about: { command: "Merge", reason: "branch protection refused" } })), s.ctx());
    expect(card.title).toBe("MausBot could not run Merge for acme/widgets#1");
    expect(card.body).toContain("branch protection refused");
    expect(card.answers).toEqual([{ id: "understood", label: "Understood" }]);
  });

  it("opens a card for another subject with no PR", async () => {
    const s = setup();
    const subject = command(ask("command_failed"), "subject:hook:thread:t1");
    const done = await run("AskPerson", subject, s.ctx({}, null));
    expect(done.outcome).toBe("succeeded");
    expect(s.calls.find(call => call.method === "card")?.args[1]).toMatchObject({ subject: { key: "subject:hook:thread:t1", pr: null, label: "thread:t1" } });
  });

  it("puts a notice in the Inbox with the merge commit", async () => {
    const s = setup();
    expect(await run("Notify", command({ type: "Notify", kind: "merged" }), s.ctx())).toEqual({ outcome: "succeeded" });
    const notice = s.calls.find(call => call.method === "notice");
    expect(notice?.args[0]).toBe("merged");
    expect(notice?.args[1]).toBe(`Merged acme/widgets#1 as ${SHA_B}. https://example.test/acme/widgets/pull/1`);
  });

  it("counts an already merged PR as merged, a moved head as skipped and a refused merge as a failure", async () => {
    const s = setup();
    s.forge.merge = async () => ({ merged: true, sha: null });
    expect(await run("Merge", command(merge()), s.ctx())).toEqual({ outcome: "succeeded", detail: { merged: true, sha: null } });
    s.forge.merge = async () => ({ merged: false, headMoved: true, reason: "head differs" });
    expect(await run("Merge", command(merge()), s.ctx())).toEqual({ outcome: "skipped", reason: "head moved" });
    s.forge.merge = async () => ({ merged: false, headMoved: false, reason: "protected branch" });
    expect(await run("Merge", command(merge()), s.ctx())).toEqual({ outcome: "failed", reason: "protected branch", retryable: false });
    s.forge.merge = async () => { throw new ForgeRefusedError("the token cannot merge"); };
    expect(await run("Merge", command(merge()), s.ctx())).toEqual({ outcome: "failed", reason: "the token cannot merge", retryable: false });
    s.forge.merge = async () => { throw new Error("socket closed"); };
    await expect(run("Merge", command(merge()), s.ctx())).rejects.toThrow("socket closed");
  });

  it("stores the forge facts of the current head", async () => {
    const s = setup();
    const result = await run("RefreshDetails", command({ type: "RefreshDetails", headSha: SHA_A }), s.ctx());
    expect(result).toMatchObject({ outcome: "succeeded", detail: { forge: { headSha: SHA_A, mergeable: true } } });
  });

  it("waits while the forge has not computed mergeability", async () => {
    const s = setup();
    s.forge.details = async () => { throw new ForgeNotReadyError("mergeability is still computed"); };
    expect(await run("RefreshDetails", command({ type: "RefreshDetails", headSha: SHA_A }), s.ctx()))
      .toEqual({ outcome: "waiting", reason: "mergeability is still computed", retryAfterSeconds: 30 });
    s.forge.details = async () => { throw new ForgeRefusedError("the App is not installed"); };
    expect(await run("RefreshDetails", command({ type: "RefreshDetails", headSha: SHA_A }), s.ctx()))
      .toEqual({ outcome: "failed", reason: "the App is not installed", retryable: false });
  });

  it("skips the forge facts of a head that is no longer the PR head", async () => {
    const s = setup();
    s.forge.details = async () => ({ headSha: SHA_B, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] });
    expect(await run("RefreshDetails", command({ type: "RefreshDetails", headSha: SHA_A }), s.ctx())).toEqual({ outcome: "skipped", reason: "head moved" });
  });

  it("keeps the stub for a workflow run", async () => {
    const s = setup();
    const payload: CommandPayload = { type: "RunWorkflow", guard: "workflow:ci-fix", workflow: "ci-fix", connection: null, headSha: SHA_A, message: "m", vars: {}, untrusted: {} };
    expect(await run("RunWorkflow", command(payload), s.ctx())).toEqual({ outcome: "skipped", reason: "not installed" });
  });
});
