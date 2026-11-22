import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { PaseoTimelineItem } from "../../paseo/connection.ts";
import type { PrRef } from "../types.ts";
import { createAgentBook, REMOVED_KEEP_MAX, REMOVED_KEEP_MS } from "./agent-book.ts";
import { createProvenance, type Created } from "./paseo-provenance.ts";

const T0 = Date.parse("2026-11-22T03:00:00Z");
const PARENT = "paseo.parent-agent-id";
const GH_URL = "https://github.com/acme/widgets/pull/42";
const GL_URL = "https://git.oceanlabs.dev/team/app/-/merge_requests/7";

const shell = (command: string, output: string, exitCode?: number): PaseoTimelineItem =>
  ({ type: "tool_call", name: "Bash", detail: { type: "shell", command, output, ...(exitCode === undefined ? {} : { exitCode }) } });
const created = (url = GH_URL) => shell(`gh pr create --title x`, `${url}\n`, 0);

function setup(timelines: Record<string, PaseoTimelineItem[]> = {}) {
  let clock = T0;
  const now = () => clock;
  const reads: string[] = [];
  const logs: string[] = [];
  const connection = Object.assign(new EventEmitter(), {
    connected: true,
    timelineTail: async (agentId: string): Promise<PaseoTimelineItem[]> => {
      reads.push(agentId);
      const items = timelines[agentId];
      if (!items) throw new Error("no such agent");
      return items;
    },
  });
  const book = createAgentBook(connection as never, now);
  const provenance = createProvenance({ connection: connection as never, book, log: line => logs.push(line), now, gitlabHosts: () => ["git.oceanlabs.dev"], scanDelayMs: 1 });
  const reports: Created[] = [];
  provenance.watch(report => reports.push(report));
  const snapshot = (id: string, over: { status?: string; parent?: string; updatedAt?: number } = {}) => ({
    id, provider: "claude", model: "opus", workspaceId: `ws-${id}`, cwd: `/work/${id}`, status: over.status ?? "idle",
    labels: over.parent ? { [PARENT]: over.parent } : {}, archivedAt: null, updatedAt: new Date(over.updatedAt ?? clock).toISOString(),
  });
  return {
    connection, book, provenance, reports, reads, logs, timelines,
    advance: (ms: number) => { clock += ms; },
    see: (id: string, over?: Parameters<typeof snapshot>[1]) => connection.emit("agentUpdate", snapshot(id, over)),
    /** An agent whose turn runs and then ends. */
    turn: async (id: string, over: { parent?: string } = {}) => {
      connection.emit("agentUpdate", snapshot(id, { ...over, status: "running" }));
      connection.emit("agentUpdate", snapshot(id, { ...over, status: "idle" }));
      await settle();
    },
    syncComplete: async () => { connection.emit("permissionsSynced", { pending: [], complete: true }); await settle(); },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const prRef = (url: string | null): PrRef => ({ key: "k" as never, provider: "github", repo: "acme/widgets", number: 42, url, headSha: null, branch: null, baseRef: null });

describe("PR provenance", () => {
  it("binds a PR that gh pr create printed to the root of the agent chain", async () => {
    const t = setup({ grandchild: [created()] });
    t.see("root");
    t.see("child", { parent: "root" });
    await t.turn("grandchild", { parent: "child" });
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]!.pr).toEqual({ provider: "github", repo: "acme/widgets", number: 42, url: GH_URL });
    expect(t.reports[0]!.owner).toMatchObject({ runtime: "paseo", hostId: "local", agentId: "root", workspaceId: "ws-root", harness: "claude", model: "opus", cwd: "/work/root", boundBy: "provenance" });
  });

  it("binds a merge request that glab mr create printed", async () => {
    const t = setup({ a: [shell("glab mr create --fill", `Creating merge request\n${GL_URL}\n`, 0)] });
    await t.turn("a");
    expect(t.reports.map(report => report.pr)).toEqual([{ provider: "gitlab", repo: "team/app", number: 7, url: GL_URL }]);
  });

  it("binds a PR that gh api POST printed and one that a create tool returned", async () => {
    const t = setup({
      a: [shell("gh api repos/acme/widgets/pulls -f title=x -f head=b -f base=main", `{"html_url":"${GH_URL}"}`, 0)],
      b: [{ type: "tool_call", name: "mcp__github__create_pull_request", detail: { type: "unknown", output: { html_url: "https://github.com/acme/widgets/pull/9" } } }],
    });
    await t.turn("a");
    await t.turn("b");
    expect(t.reports.map(report => report.pr.number)).toEqual([42, 9]);
  });

  it("ignores a PR URL that a command only mentions", async () => {
    const t = setup({ a: [
      shell(`echo ${GH_URL}`, `${GH_URL}\n`, 0),
      shell(`gh pr create --body "see ${GH_URL}"`, "", 0),
      shell("gh api repos/acme/widgets/pulls/42", `{"html_url":"${GH_URL}"}`, 0),
      shell("gh pr view 42 --json url", GH_URL, 0),
    ] });
    await t.turn("a");
    expect(t.reports).toEqual([]);
  });

  it("ignores a create tool that failed or that only had another PR in its input", async () => {
    const tool = (over: Record<string, unknown>, detail: Record<string, unknown>): PaseoTimelineItem =>
      ({ type: "tool_call", name: "create_pull_request", status: "completed", ...over, detail: { type: "unknown", ...detail } });
    const t = setup({ a: [
      tool({ status: "failed" }, { input: {}, output: { html_url: GH_URL } }),
      tool({}, { input: { body: "follow-up to https://github.com/acme/widgets/pull/1" }, output: "validation failed" }),
    ] });
    await t.turn("a");
    expect(t.reports).toEqual([]);
  });

  it("ignores a failed create command", async () => {
    const t = setup({ a: [shell("gh pr create", `a pull request for this branch already exists:\n${GH_URL}\n`, 1)] });
    await t.turn("a");
    expect(t.reports).toEqual([]);
  });

  it("treats a detached child as its own root", async () => {
    const t = setup({ child: [created()] });
    t.see("parent");
    await t.turn("child");
    expect(t.reports[0]!.owner.agentId).toBe("child");
  });

  it("stops at the highest ancestor that is still listed", async () => {
    const t = setup({ grandchild: [created()] });
    t.see("child", { parent: "gone-parent" });
    await t.turn("grandchild", { parent: "child" });
    expect(t.reports[0]!.owner.agentId).toBe("child");
  });

  it("binds the PR of a child that was removed before the scan to its live parent", async () => {
    const t = setup({ child: [created()] });
    t.see("parent");
    t.see("child", { parent: "parent", status: "running" });
    t.connection.emit("agentRemoved", "child");
    await settle();
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]!.owner.agentId).toBe("parent");
  });

  it("binds a removed child's PR to the highest live agent when the chain top is gone too", async () => {
    const t = setup({ child: [created()] });
    t.see("top");
    t.see("middle", { parent: "top" });
    t.see("child", { parent: "middle" });
    t.connection.emit("agentRemoved", "top");
    t.connection.emit("agentRemoved", "child");
    await settle();
    expect(t.reports[0]!.owner.agentId).toBe("middle");
  });

  it("forgets removed agents after six hours and keeps at most five hundred", () => {
    const t = setup();
    t.see("child");
    t.connection.emit("agentRemoved", "child");
    t.advance(REMOVED_KEEP_MS - 1);
    expect(t.book.find("child")).toBeDefined();
    t.advance(2);
    expect(t.book.find("child")).toBeUndefined();
    for (let at = 0; at < REMOVED_KEEP_MAX + 20; at += 1) {
      t.see(`m${at}`);
      t.connection.emit("agentRemoved", `m${at}`);
    }
    expect(t.book.all().length).toBe(REMOVED_KEEP_MAX);
    expect(t.book.find("m0")).toBeUndefined();
  });

  it("finds PRs created while it was disconnected after the next connect", async () => {
    const t = setup({ recent: [created()], old: [created("https://github.com/acme/widgets/pull/5")] });
    t.see("recent", { updatedAt: T0 - 10 * 60_000 });
    t.see("old", { updatedAt: T0 - 3 * 60 * 60_000 });
    await t.syncComplete();
    expect(t.reads).toEqual(["recent"]);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]!.owner).toMatchObject({ agentId: "recent", boundBy: "backfill" });
  });

  it("does not scan after a connect whose list is incomplete", async () => {
    const t = setup({ a: [created()] });
    t.see("a");
    t.connection.emit("permissionsSynced", { pending: [], complete: false });
    await settle();
    expect(t.reads).toEqual([]);
  });

  it("reports each creation once", async () => {
    const t = setup({ a: [created()] });
    await t.turn("a");
    await t.turn("a");
    await t.syncComplete();
    expect(t.reports).toHaveLength(1);
  });

  it("scans once when several updates arrive in a row and logs a timeline that is gone", async () => {
    const t = setup({ a: [] });
    t.see("a", { status: "running" });
    for (let at = 0; at < 3; at += 1) t.see("a", { status: "idle" });
    await settle();
    expect(t.reads).toEqual(["a"]);
    t.see("gone", { status: "running" });
    t.see("gone", { status: "idle" });
    await settle();
    expect(t.logs.filter(line => line.includes("timeline of agent gone"))).toHaveLength(1);
  });

  it("resolves the owner of an unbound PR from recent timelines and remembers a miss", async () => {
    const t = setup({ parent: [], child: [shell("git status", "clean", 0), created()], other: [created("https://github.com/acme/widgets/pull/1")] });
    t.connection.emit("permissionsSynced", { pending: [], complete: true });
    t.see("parent");
    t.see("child", { parent: "parent", updatedAt: T0 - 60_000 });
    t.see("other", { updatedAt: T0 - 120_000 });
    const found = await t.provenance.resolver.resolve(prRef(GH_URL));
    expect(found).toMatchObject({ agentId: "parent", boundBy: "backfill" });

    const missing = prRef("https://github.com/acme/widgets/pull/99");
    expect(await t.provenance.resolver.resolve(missing)).toBe("next");
    const readsAfterMiss = t.reads.length;
    expect(await t.provenance.resolver.resolve(missing)).toBe("next");
    expect(t.reads.length).toBe(readsAfterMiss);
    t.advance(10 * 60_000 + 1);
    await t.provenance.resolver.resolve(missing);
    expect(t.reads.length).toBeGreaterThan(readsAfterMiss);
    expect(await t.provenance.resolver.resolve(prRef(null))).toBe("next");
  });

  it("makes the resolver wait while the daemon is down", async () => {
    const t = setup();
    t.see("a");
    t.connection.emit("permissionsSynced", { pending: [], complete: true });
    t.connection.connected = false;
    await expect(t.provenance.resolver.resolve(prRef(GH_URL))).rejects.toMatchObject({ name: "PortUnavailableError" });
  });

  it("makes the resolver wait until the agent list is complete", async () => {
    const t = setup();
    await expect(t.provenance.resolver.resolve(prRef(GH_URL))).rejects.toMatchObject({ name: "PortUnavailableError" });
  });
});
