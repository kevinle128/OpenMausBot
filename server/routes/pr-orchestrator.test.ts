import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOrchestratorCore, type OrchestratorCore } from "../pr-orchestrator/core.ts";
import { counterIds, DEFAULT_PR_KEY, ev, fakeClock } from "../pr-orchestrator/testing/builders.ts";
import { manualTimer } from "../pr-orchestrator/testing/manual-timer.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createPrOrchestratorRoutes } from "./pr-orchestrator.ts";

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

async function call(method: string, target: string, options: { scopes?: string[]; body?: unknown; core?: boolean } = {}): Promise<Answer | "pass"> {
  const handler = createPrOrchestratorRoutes({ core: () => (options.core === false ? null : core), secretPresent: () => false });
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
