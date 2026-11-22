import { existsSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";
import { dataHome } from "../data-dir.ts";
import { parseJson } from "../schema.ts";
import { parseOrchestratorConfig } from "./config.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";
import type { CommandHandlers } from "./handlers.ts";
import type { ConnectorDefinition } from "./ports.ts";
import { openOrchestratorStore } from "./store.ts";
import { refold, replayRecorded, simulate, toSimInputs, type SimInput, type SimResult } from "./simulate.ts";
import type { CommandResult, CoreInput, LedgerRow, OrchestratorConfig, PrKey } from "./types.ts";

const DB_FILE = "pr-orchestrator.db";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One input per line: `{ connector, event }` for a contract event, or `{ at, prKey, input }` for any other input. */
export function parseNdjsonInputs(text: string): SimInput[] {
  const inputs: SimInput[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `line ${index + 1}`;
    let value: unknown;
    try {
      value = parseJson(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    if (!isRecord(value)) throw new Error(`${where}: not an object`);
    if (typeof value.connector === "string" && isRecord(value.event)) {
      const at = Date.parse(String(value.event.occurredAt));
      if (Number.isNaN(at)) throw new Error(`${where}: event.occurredAt is not a time`);
      inputs.push({ at, connector: value.connector, event: value.event as unknown as Extract<SimInput, { event: unknown }>["event"] });
    } else if (typeof value.at === "number" && typeof value.prKey === "string" && isRecord(value.input) && typeof value.input.type === "string") {
      inputs.push({ at: value.at, prKey: value.prKey, input: value.input as unknown as CoreInput });
    } else throw new Error(`${where}: expected { connector, event } or { at, prKey, input }`);
  });
  return inputs;
}

/** Handlers that report every command as done; RefreshDetails brings forge facts that make the head mergeable. */
function succeedingHandlers(): CommandHandlers {
  const succeeded = async (): Promise<CommandResult> => ({ outcome: "succeeded" });
  return {
    TellOwner: succeeded, AskPerson: succeeded, Merge: succeeded, Notify: succeeded, RunWorkflow: succeeded, RunInstruction: succeeded,
    RefreshDetails: async (command): Promise<CommandResult> => {
      const { payload } = command;
      if (payload.type !== "RefreshDetails") return { outcome: "skipped", reason: "wrong payload" };
      return { outcome: "succeeded", detail: { forge: { headSha: payload.headSha, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] } } };
    },
  };
}

export interface ReplaySummary {
  mode: "recorded" | "simulated";
  inputs: number;
  prs: Array<{ key: PrKey; state: string; headSha: string | null; states: string[] }>;
  commands: Array<{ subject: string; type: string; status: string; outcome: string | null }>;
  timers: Array<{ subject: string; kind: string; state: string }>;
  ledgerEntries: number;
  refused: number;
  /** PR keys whose record differs from a refold of their ledger. */
  mismatches: PrKey[];
}

function configOf(text: string | undefined): OrchestratorConfig {
  const parsed = parseOrchestratorConfig(text ?? "{}", BUILT_IN_CONNECTORS as readonly ConnectorDefinition[]);
  if (!parsed.ok) throw new Error(`config: ${parsed.error}`);
  return parsed.config;
}

export function mismatchesOf(prs: SimResult["prs"], ledger: LedgerRow[]): PrKey[] {
  return prs.filter(pr => !isDeepStrictEqual(refold(ledger.filter(row => row.subjectKey === pr.key)), pr)).map(pr => pr.key);
}

export async function runReplay(opts: { eventsText: string; configText?: string; mode: "recorded" | "simulated"; handlers: "stub" | "succeed" }): Promise<ReplaySummary> {
  const inputs = parseNdjsonInputs(opts.eventsText);
  const config = configOf(opts.configText);
  const result = opts.mode === "recorded"
    ? replayRecorded({ inputs, config })
    : await simulate({ inputs, config, handlers: opts.handlers === "succeed" ? succeedingHandlers() : undefined });
  return {
    mode: opts.mode, inputs: inputs.length,
    prs: result.prs.map(pr => ({
      key: pr.key, state: pr.state, headSha: pr.headSha,
      states: result.ledger.flatMap(row => (row.subjectKey === pr.key && row.entry.type === "state.changed" ? [row.entry.to] : [])),
    })),
    commands: result.commands.map(command => ({ subject: command.subjectKey, type: command.type, status: command.status, outcome: command.outcome })),
    timers: result.timers.map(timer => ({ subject: timer.subjectKey, kind: timer.kind, state: timer.state })),
    ledgerEntries: result.ledger.length,
    refused: result.ledger.filter(row => row.entry.type === "transition.refused").length,
    mismatches: mismatchesOf(result.prs, result.ledger),
  };
}

/** The data folder's database, as the server names it; resolved here so that importing this module has no side effect. */
function liveDbPath(): string {
  return join(process.env.OMB_DATA_DIR || join(dataHome(), ".openmausbot"), DB_FILE);
}

const realOr = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));

function openCopy(dbPath: string) {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  if (realpathSync(dbPath) === realOr(liveDbPath())) throw new Error("this is the live database; work on a copy of it");
  return openOrchestratorStore(dbPath);
}

/** The PR keys whose stored record differs from a refold of their ledger. Works on a copy only. */
export function verifyDb(dbPath: string): PrKey[] {
  const store = openCopy(dbPath);
  try {
    return store.ledgerKeys({ prOnly: true }).filter(key => !isDeepStrictEqual(refold(store.ledger(key)), store.getPr(key)));
  } finally {
    store.close();
  }
}

/** NDJSON of the input rows of every ledger, oldest first, in the format that parseNdjsonInputs reads. Works on a copy only. */
export function exportInputs(dbPath: string): string {
  const store = openCopy(dbPath);
  try {
    const rows = store.ledgerKeys().flatMap(key => store.ledger(key)).sort((a, b) => a.at - b.at || a.seq - b.seq);
    return toSimInputs(rows).map(item => JSON.stringify("event" in item ? { connector: item.connector, event: item.event } : item)).join("\n");
  } finally {
    store.close();
  }
}
