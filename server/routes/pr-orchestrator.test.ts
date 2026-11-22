import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOrchestratorCore, type OrchestratorCore } from "../pr-orchestrator/core.ts";
import { counterIds, DEFAULT_PR_KEY, ev, fakeClock } from "../pr-orchestrator/testing/builders.ts";
import { manualTimer } from "../pr-orchestrator/testing/manual-timer.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createPrOrchestratorRoutes, type PrOrchestratorRouteDeps } from "./pr-orchestrator.ts";

let dir: string;
let core: OrchestratorCore | null;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-routes-"));
  writeFileSync(join(dir, "pr-orchestrator.json"), JSON.stringify({ enabled: true }));
  const clock = fakeClock();
  const timer = manualTimer();
  core = createOrchestratorCore({
    dbPath: join(dir, "pr-orchestrator.db"), configPath: join(dir, "pr-orchestrator.json"),
    now: clock.now, newId: counterIds("c"), startTimer: timer.startTimer,
  });
  core.start();
  core.intake.accept([{ event: ev.opened(), raw: "{}" }], clock.now());
  await timer.options().run();
});
afterEach(async () => {
  await core?.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Answer { status: number; body: any }

async function call(method: string, target: string, options: { scopes?: string[]; body?: unknown; core?: boolean; base?: string; update?: PrOrchestratorRouteDeps["updateConnector"] } = {}): Promise<Answer | "pass"> {
  const handler = createPrOrchestratorRoutes({ core: () => (options.core === false ? null : core), secretPresent: () => false, ...(options.base ? { webhookBase: () => options.base! } : {}), updateConnector: options.update ?? (() => ({ ok: false, reason: "unknown", error: "none" })) });
  const url = new URL(target, "http://localhost");
  let answer: Answer | null = null;
  const result = await handler({
    req: {}, res: {}, url, path: url.pathname, method,
    auth: { kind: "loopback", scopes: options.scopes ?? ["admin"] },
    json: (_res: unknown, status: number, body: unknown) => { answer = { status, body }; },
    readBody: async () => options.body ?? {},
  } as unknown as RouteContext);
  return result === PASS ? "pass" : answer ?? "pass";
}

const inputSeq = () => core!.pr(DEFAULT_PR_KEY)!.ledger.find(row => row.causationSeq === null)!.seq;
const ledgerSize = () => core!.pr(DEFAULT_PR_KEY)!.ledger.length;

const routineOf = (id: string, name: string, when: object, active = true) => ({
  id, name, active, when,
  // oxlint-disable-next-line unicorn/no-thenable -- a routine's action list is named "then" in the config document
  then: [{ do: "TellOwner", params: { template: "merged" } }], once: "per-trigger",
});

describe("PR orchestrator connector routes", () => {
  const patches: Array<[string, unknown]> = [];
  const update: PrOrchestratorRouteDeps["updateConnector"] = (id, patch) => {
    patches.push([id, patch]);
    return id === "github-event" ? { ok: true, version: "v" } : { ok: false, reason: "unknown", error: `${id} is not a configured connector` };
  };
  beforeEach(() => { patches.length = 0; });

  it("refuses connector changes from a caller without the admin scope", async () => {
    expect(await call("PUT", "/api/pr-orchestrator/connectors/github-event", { scopes: ["client"], body: { enabled: true }, update })).toMatchObject({ status: 403 });
    expect(patches).toEqual([]);
  });

  it("lists the routines that use a connector", async () => {
    writeFileSync(join(dir, "pr-orchestrator.json"), JSON.stringify({
      enabled: true,
      routines: { useDefaults: false, custom: [
        routineOf("gitlab-only", "Only GitLab", { connectors: ["gitlab-event"], on: ["pr.pushed"] }),
        routineOf("any-source", "Any source", { on: ["pr.ci.finished"] }, false),
      ] },
    }));
    const answer = await call("GET", "/api/pr-orchestrator/connectors", { base: "http://hooks.example:8787/" });
    const byId = Object.fromEntries((answer as Answer).body.connectors.map((item: any) => [item.id, item]));
    expect(byId["github-event"].usedBy).toEqual([{ routineId: "any-source", name: "Any source", active: false, describe: expect.any(String) }]);
    expect(byId["gitlab-event"].usedBy.map((item: any) => item.routineId)).toEqual(["gitlab-only", "any-source"]);
    expect(byId["github-event"].intakeUrl).toBe("http://hooks.example:8787/events/github-event");
  });

  it("gives no intake URL when the listener address is unknown", async () => {
    const answer = await call("GET", "/api/pr-orchestrator/connectors");
    expect((answer as Answer).body.connectors.every((item: any) => item.intakeUrl === null)).toBe(true);
  });

  it("saves a connector change and answers with the connector as the list shows it", async () => {
    const answer = await call("PUT", "/api/pr-orchestrator/connectors/github-event", { body: { enabled: true, settings: { toleranceSeconds: 60 }, secretName: "MY_SECRET" }, update, base: "http://h:1" });
    expect(answer).toMatchObject({ status: 200, body: { id: "github-event", intakeUrl: "http://h:1/events/github-event", usedBy: expect.any(Array) } });
    expect(patches).toEqual([["github-event", { enabled: true, settings: { toleranceSeconds: 60 }, secretName: "MY_SECRET" }]]);
  });

  it("answers 404 for an unknown connector and 400 for a bad body", async () => {
    expect(await call("PUT", "/api/pr-orchestrator/connectors/nope", { body: { enabled: true }, update })).toMatchObject({ status: 404 });
    for (const body of [[], { enabled: "yes" }, { settings: [] }, { secretName: 3 }, { use: "x" }]) {
      expect(await call("PUT", "/api/pr-orchestrator/connectors/github-event", { body, update })).toMatchObject({ status: 400 });
    }
    expect(await call("GET", "/api/pr-orchestrator/connectors/github-event", { update })).toMatchObject({ status: 405 });
    expect(patches).toEqual([["nope", { enabled: true }]]);
  });

  it("passes the writer's refusal on as 400", async () => {
    const refuse: PrOrchestratorRouteDeps["updateConnector"] = () => ({ ok: false, reason: "invalid", error: "settings.toleranceSeconds is too small" });
    expect(await call("PUT", "/api/pr-orchestrator/connectors/github-event", { body: { settings: { toleranceSeconds: 1 } }, update: refuse })).toMatchObject({ status: 400, body: { error: "settings.toleranceSeconds is too small" } });
  });
});

describe("PR orchestrator routes", () => {
  it("passes on paths that are not its own", async () => {
    expect(await call("GET", "/api/webhooks")).toBe("pass");
    expect(await call("GET", "/api/pr-orchestrator/unknown")).toBe("pass");
  });

  it("refuses a caller without the admin scope", async () => {
    for (const [method, path] of [["GET", "/api/pr-orchestrator/status"], ["GET", "/api/pr-orchestrator/connectors"], ["POST", "/api/pr-orchestrator/routines/test"]] as const) {
      expect(await call(method, path, { scopes: ["client"] })).toMatchObject({ status: 403 });
    }
  });

  it("answers that it is off while there is no core", async () => {
    expect(await call("GET", "/api/pr-orchestrator/status", { core: false })).toEqual({ status: 200, body: { enabled: false, configured: false } });
    expect(await call("GET", "/api/pr-orchestrator/prs", { core: false })).toMatchObject({ status: 404 });
  });

  it("shows the status, the PR list and one PR", async () => {
    expect(await call("GET", "/api/pr-orchestrator/status")).toMatchObject({ status: 200, body: { enabled: true, configured: true } });
    const list = await call("GET", "/api/pr-orchestrator/prs?state=ci_running");
    expect(list).toMatchObject({ status: 200 });
    expect((list as Answer).body.prs.map((pr: { key: string }) => pr.key)).toEqual([DEFAULT_PR_KEY]);
    const one = await call("GET", `/api/pr-orchestrator/pr?key=${encodeURIComponent(DEFAULT_PR_KEY)}`);
    expect((one as Answer).body.ledger.length).toBeGreaterThan(0);
    expect(await call("GET", "/api/pr-orchestrator/pr?key=github%3Aacme%2Fnone%2371")).toMatchObject({ status: 404 });
  });

  it("refuses an unknown state filter and a malformed key", async () => {
    expect(await call("GET", "/api/pr-orchestrator/prs?state=sleeping")).toMatchObject({ status: 400 });
    expect(await call("GET", "/api/pr-orchestrator/pr?key=acme/widgets%231")).toMatchObject({ status: 400 });
    expect(await call("GET", "/api/pr-orchestrator/pr")).toMatchObject({ status: 400 });
    expect(await call("GET", "/api/pr-orchestrator/routines/Bad_Id/runs")).toMatchObject({ status: 400 });
  });

  it("lists the routines, the connectors and the configuration", async () => {
    const routines = await call("GET", "/api/pr-orchestrator/routines");
    expect((routines as Answer).body.routines.length).toBeGreaterThan(0);
    const connectors = await call("GET", "/api/pr-orchestrator/connectors");
    expect((connectors as Answer).body.connectors.map((item: { id: string }) => item.id)).toEqual(["github-event", "gitlab-event"]);
    expect(await call("GET", "/api/pr-orchestrator/config")).toMatchObject({ status: 200, body: { error: null } });
    expect(await call("GET", "/api/pr-orchestrator/routines/run-ci-fix-workflow/runs")).toEqual({ status: 200, body: { runs: [] } });
  });

  it("refuses an invalid draft routine in a test run", async () => {
    const answer = await call("POST", "/api/pr-orchestrator/routines/test", {
      body: { routine: { id: "Not Valid" }, prKey: DEFAULT_PR_KEY, inputSeq: inputSeq() },
    });
    expect(answer).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/pr-orchestrator/routines/test", { body: { prKey: DEFAULT_PR_KEY, inputSeq: 1 } })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/pr-orchestrator/routines/test", { body: { routineId: "x", routine: {}, prKey: DEFAULT_PR_KEY, inputSeq: 1 } })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/pr-orchestrator/routines/test", { body: { routine: null, prKey: DEFAULT_PR_KEY, inputSeq: 1 } })).toMatchObject({ status: 400 });
    expect(await call("POST", "/api/pr-orchestrator/routines/test", { body: { routineId: "x", prKey: "nope", inputSeq: 1 } })).toMatchObject({ status: 400 });
  });

  it("answers 404 to a test run of an unknown routine or PR", async () => {
    expect(await call("POST", "/api/pr-orchestrator/routines/test", { body: { routineId: "no-such-routine", prKey: DEFAULT_PR_KEY, inputSeq: inputSeq() } })).toMatchObject({ status: 404 });
    expect(await call("POST", "/api/pr-orchestrator/routines/test", { body: { routineId: "run-ci-fix-workflow", prKey: "github:acme/none#71", inputSeq: 1 } })).toMatchObject({ status: 404 });
  });

  it("answers a routine test run without changing anything", async () => {
    const before = ledgerSize();
    const answer = await call("POST", "/api/pr-orchestrator/routines/test", { body: { routineId: "run-ci-fix-workflow", prKey: DEFAULT_PR_KEY, inputSeq: inputSeq() } });
    expect(answer).toMatchObject({ status: 200, body: { matched: false } });
    expect(ledgerSize()).toBe(before);
  });
});
