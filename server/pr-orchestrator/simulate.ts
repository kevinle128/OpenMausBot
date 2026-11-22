import { isDeepStrictEqual } from "node:util";
import { schemaIssue } from "../schema.ts";
import type { DueTimerOptions, startDueTimer } from "../due-timer.ts";
import { ACTION_REGISTRY } from "./actions.ts";
import { configVersion, createConfigSchema } from "./config.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";
import { createConnectorRegistry, type ConnectorRegistry } from "./connectors/registry.ts";
import type { OmbEventV1 } from "./contract/omb-event.v1.ts";
import { createOmbEventValidator } from "./contract/validate.ts";
import { createCoreParts, type CoreParts } from "./core.ts";
import type { CommandHandlers } from "./handlers.ts";
import { conformItems } from "./intake.ts";
import type { ConnectorDefinition } from "./ports.ts";
import { describeRoutine } from "./policy.ts";
import type { EvaluationInfo } from "./process-manager.ts";
import { foldAll } from "./projection.ts";
import { openOrchestratorStore, type ReceivedRow } from "./store.ts";
import type {
  CommandAction, CommandPayload, CommandRecord, CoreInput, FactMap, LedgerRow, OmbEvent, OrchestratorConfig, PrKey, PrRecord, Routine, TimerRecord,
} from "./types.ts";

export type SimInput = { at: number; connector: string; event: OmbEventV1 } | { at: number; prKey: PrKey; input: CoreInput };

export interface SimResult { prs: PrRecord[]; ledger: LedgerRow[]; commands: CommandRecord[]; timers: TimerRecord[] }
type Validator = Pick<ReturnType<typeof createOmbEventValidator>, "checkFor">;

interface SimOptions {
  config: OrchestratorConfig;
  /** The connectors that events are checked against; the built-in ones by default. */
  registry?: ConnectorRegistry;
  validator?: Validator;
}

const DEFAULT_MAX_ITERATIONS = 10_000;
const NEVER = 2 ** 50;
const SUBJECT_PREFIX = "subject:";

const defaultRegistry = () => createConnectorRegistry(BUILT_IN_CONNECTORS as readonly ConnectorDefinition[]);

interface Sim {
  parts: CoreParts;
  setNow(at: number): void;
  now(): number;
  /** The next due time of a timer, a command or a pending event; null when nothing is due. */
  dueAt(): number | null;
  runOnce(): Promise<void>;
  applyEvent(connector: string, event: OmbEventV1): void;
}

function createSim(opts: SimOptions & { handlers?: Partial<CommandHandlers>; onEvaluate?: (info: EvaluationInfo) => void }): Sim {
  const registry = opts.registry ?? defaultRegistry();
  const validator = opts.validator ?? createOmbEventValidator();
  const store = openOrchestratorStore(":memory:");
  store.setMeta("last_prune_at", String(NEVER));
  let clock = 0;
  let captured: DueTimerOptions | null = null;
  let counter = 0;
  const version = configVersion(opts.config);
  const parts = createCoreParts({
    store, connectors: registry, config: () => ({ config: opts.config, version, error: null }), now: () => clock, newId: () => `id-${++counter}`,
    handlers: opts.handlers, onEvaluate: opts.onEvaluate, log: () => {},
    startTimer: ((options: DueTimerOptions) => { captured = options; return { poke() {}, stop() {} }; }) as typeof startDueTimer,
  });
  parts.scheduler.start();
  const timer = () => captured as DueTimerOptions;
  return {
    parts,
    setNow: at => { clock = at; },
    now: () => clock,
    dueAt() {
      const next = timer().next();
      return next === null || next >= NEVER ? null : next;
    },
    async runOnce() {
      await timer().run();
      await parts.bus.idle();
    },
    applyEvent(connector, event) {
      const instance = opts.config.connectors[connector];
      const definition = registry.get(instance?.use ?? connector);
      if (!definition) throw new Error(`no connector ${connector}`);
      const { accepted, rejected } = conformItems([event], connector, definition, validator);
      if (rejected.length > 0) throw new Error(`event ${rejected[0]!.id ?? "?"} rejected: ${rejected[0]!.reason}`);
      parts.pm.accept(accepted, clock);
      while (store.receivedByStatus("pending", 1).length > 0) parts.pm.drain();
    },
  };
}

function snapshot(sim: Sim): SimResult & { received: ReceivedRow[] } {
  const { store } = sim.parts;
  const keys = store.ledgerKeys().sort();
  const received = (["pending", "applied", "failed"] as const).flatMap(status => store.receivedByStatus(status, 1_000_000)).sort((a, b) => a.seq - b.seq);
  return {
    prs: store.listPrs({ limit: 1_000_000 }).sort((a, b) => (a.key < b.key ? -1 : 1)),
    ledger: keys.flatMap(key => store.ledger(key)).sort((a, b) => a.seq - b.seq),
    commands: keys.flatMap(key => store.commandsFor(key)),
    timers: keys.flatMap(key => store.timersFor(key)),
    received,
  };
}

function applyExternal(sim: Sim, prKey: PrKey, input: CoreInput): void {
  const { pm } = sim.parts;
  if (input.type === "owner.bound") pm.bindOwner(input.owner, input.pr);
  else if (input.type === "person.answered") pm.answer(prKey, input.decisionId, input.answer);
  else if (input.type === "run.finished") pm.runFinished(prKey, { target: input.target, runRef: input.runRef, outcome: input.outcome });
  else pm.apply(prKey, input);
}

/**
 * A payload without the fields that depend on the run that issued it: ids of other commands, decision ids built from ledger
 * row numbers, and the event text that carries the received row number. A replay on a fresh store gives those other values.
 */
function comparablePayload(payload: CommandPayload): unknown {
  const copy = structuredClone(payload) as Record<string, unknown>;
  if (payload.type === "AskPerson") {
    delete copy.decisionId;
    if (payload.gated) copy.gated = { ...payload.gated, commandId: null };
  }
  const untrusted = copy.untrusted;
  if (typeof untrusted === "object" && untrusted !== null && !Array.isArray(untrusted)) copy.untrusted = { ...untrusted, eventJson: null };
  return copy;
}

function applyRecordedResult(
  sim: Sim, prKey: PrKey, input: Extract<CoreInput, { type: "timer.fired" | "command.finished" }>, decisionIds: Map<string, string>,
): void {
  const { store, pm } = sim.parts;
  const applyAsStored = () => { if (!prKey.startsWith(SUBJECT_PREFIX)) pm.apply(prKey, input); };
  if (input.type === "timer.fired") {
    const timers = store.timersFor(prKey).filter(candidate => candidate.kind === input.kind);
    const armed = timers.find(candidate => candidate.state === "armed");
    if (armed) pm.fireTimer(armed);
    else if (timers.length === 0) applyAsStored();
    return;
  }
  const wanted = comparablePayload(input.payload);
  const twins = store.commandsFor(prKey).filter(candidate => candidate.type === input.command && isDeepStrictEqual(comparablePayload(candidate.payload), wanted));
  const open = twins.find(candidate => candidate.status !== "done");
  if (open) {
    // The replayed AskPerson got a decision id from this store's row numbers; later answers carry the recorded one.
    if (open.payload.type === "AskPerson" && input.payload.type === "AskPerson") decisionIds.set(input.payload.decisionId, open.payload.decisionId);
    pm.finishCommand(open, input.result);
  } else if (twins.length === 0) applyAsStored();
}

/**
 * Recorded mode: applies stored inputs verbatim, in the given order and at their recorded times, with no command bus and no scheduler.
 * The callback also gets the position of the input that is being applied.
 */
export function replayRecorded(input: SimOptions & { inputs: SimInput[]; onEvaluate?: (info: EvaluationInfo, inputIndex: number) => void }): SimResult {
  let index = 0;
  const sim = createSim({ ...input, onEvaluate: info => input.onEvaluate?.(info, index) });
  const decisionIds = new Map<string, string>();
  try {
    input.inputs.forEach((item, position) => {
      index = position;
      sim.setNow(item.at);
      if ("event" in item) sim.applyEvent(item.connector, item.event);
      else if (item.input.type === "timer.fired" || item.input.type === "command.finished") applyRecordedResult(sim, item.prKey, item.input, decisionIds);
      else if (item.input.type === "person.answered") {
        applyExternal(sim, item.prKey, { ...item.input, decisionId: decisionIds.get(item.input.decisionId) ?? item.input.decisionId });
      } else applyExternal(sim, item.prKey, item.input);
    });
    return withoutReceived(snapshot(sim));
  } finally {
    sim.parts.store.close();
  }
}

const withoutReceived = ({ received: _received, ...rest }: SimResult & { received: ReceivedRow[] }): SimResult => rest;

/** Simulated mode: takes external inputs only. Its own scheduler and command bus produce the timers and the command results on a virtual clock. */
export async function simulate(input: SimOptions & { inputs: SimInput[]; handlers?: Partial<CommandHandlers>; maxIterations?: number }): Promise<SimResult & { received: ReceivedRow[] }> {
  const sim = createSim(input);
  try {
    return await runSimulation(sim, input);
  } finally {
    sim.parts.store.close();
  }
}

async function runSimulation(sim: Sim, input: { inputs: SimInput[]; maxIterations?: number }): Promise<SimResult & { received: ReceivedRow[] }> {
  const limit = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const external = input.inputs
    .filter(item => "event" in item || (item.input.type !== "timer.fired" && item.input.type !== "command.finished"))
    .map((item, order) => ({ item, order }))
    .sort((a, b) => a.item.at - b.item.at || a.order - b.order)
    .map(entry => entry.item);
  let iterations = 0;

  /** Runs everything that is due at or before `until` (or all of it when null), moving the clock to each due time. */
  async function advance(until: number | null): Promise<void> {
    for (let due = sim.dueAt(); due !== null && (until === null || due <= until); due = sim.dueAt()) {
      if (++iterations > limit) throw new Error(`the simulation did not settle in ${limit} iterations`);
      sim.setNow(Math.max(sim.now(), due));
      await sim.runOnce();
    }
  }

  if (external.length > 0) sim.setNow(external[0]!.at);
  for (const item of external) {
    await advance(item.at);
    sim.setNow(Math.max(sim.now(), item.at));
    if ("event" in item) sim.applyEvent(item.connector, item.event);
    else applyExternal(sim, item.prKey, item.input);
  }
  await advance(null);
  return snapshot(sim);
}

/** Thrown when a draft routine does not pass the config schema; the message is the schema's own. */
export class InvalidRoutineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRoutineError";
  }
}

export interface RoutineTestResult {
  matched: boolean;
  facts: FactMap | null;
  actions: Array<{ action: string; idemKey: string | null; askFirst: boolean; payload?: CommandPayload; skip?: string }>;
  describe: string;
}

function actionLabel(action: CommandAction | Routine["then"][number]): string {
  if ("do" in action) return action.do;
  return "schedule" in action ? `schedule:${action.schedule}` : `cancel:${action.cancel}`;
}

/** The editor's sentence of a routine; a single chosen connector gives its event titles. */
export function describeRoutineWith(routine: Routine, registry: ConnectorRegistry, config: Pick<OrchestratorConfig, "connectors">): string {
  const describeAction = (action: CommandAction) => ACTION_REGISTRY[action.do].describe(action.params ?? {});
  const describeEventType = (connector: string | null, type: string) => {
    if (connector === null) return null;
    return registry.eventTypes(config.connectors[connector]?.use ?? connector).find(entry => entry.type === type)?.title ?? null;
  };
  return describeRoutine(routine, describeAction, describeEventType);
}

/** The first evaluation of one stored input is what the routine would have decided on it; the ledger of the replay says what each action did. */
export async function testRoutine(input: {
  config: OrchestratorConfig; inputs: SimInput[]; routine: object; inputIndex: number; registry?: ConnectorRegistry; validator?: Validator;
}): Promise<RoutineTestResult> {
  const registry = input.registry ?? defaultRegistry();
  const draftId = (input.routine as { id?: unknown }).id;
  const draft = { ...input.routine, active: true };
  const custom: object[] = [...input.config.routines.custom];
  const at = custom.findIndex(routine => (routine as Routine).id === draftId);
  if (at >= 0) custom[at] = draft;
  else custom.push(draft);
  const checked = createConfigSchema(registry.list() as ConnectorDefinition[]).safeParse({
    ...input.config,
    routines: { ...input.config.routines, custom, deactivate: input.config.routines.deactivate.filter(id => id !== draftId) },
  });
  if (!checked.success) throw new InvalidRoutineError(schemaIssue(checked.error, "the routine is not valid"));
  const config = checked.data;
  const validDraft = config.routines.custom.find(routine => routine.id === draftId) as Routine;

  let first: EvaluationInfo | null = null;
  const result = replayRecorded({
    inputs: input.inputs, config, registry, validator: input.validator,
    onEvaluate: (info, index) => { if (index === input.inputIndex && first === null) first = info; },
  });
  const evaluation = first as EvaluationInfo | null;
  const lines = result.ledger.flatMap(row =>
    row.entry.type === "routine.matched" && row.entry.routineId === validDraft.id && row.entry.triggerSeq === evaluation?.triggerSeq ? row.entry.actions : []);
  const actions = (evaluation?.intents ?? []).filter(intent => intent.routineId === validDraft.id).map(intent => {
    const label = actionLabel(intent.action);
    const line = lines.find(candidate => (intent.idemKey === null ? candidate.action === label : candidate.idemKey === intent.idemKey));
    const command = line?.commandId ? result.commands.find(candidate => candidate.id === line.commandId) : undefined;
    const skip = line === undefined ? "nothing to do" : line.result === "skipped" ? (line.reason ?? "skipped") : undefined;
    return {
      action: label, idemKey: intent.idemKey, askFirst: "do" in intent.action && intent.action.askFirst === true,
      ...(command ? { payload: command.payload } : {}), ...(skip === undefined ? {} : { skip }),
    };
  });
  return {
    matched: evaluation?.matched.includes(validDraft.id) ?? false, facts: evaluation?.facts ?? null, actions,
    describe: describeRoutineWith(validDraft, registry, config),
  };
}

/** Stored ledger rows as simulator inputs. Only the rows that no step derived are inputs. */
export function toSimInputs(rows: LedgerRow[]): SimInput[] {
  return rows.filter(row => row.causationSeq === null).map((row): SimInput => {
    if (row.entry.type === "event.received") return { at: row.at, connector: row.entry.event.connector, event: contractPart(row.entry.event) };
    return { at: row.at, prKey: row.subjectKey, input: row.entry as CoreInput };
  });
}

/** The contract fields of a stored event, without what OMB added. */
export function contractPart(event: OmbEvent): OmbEventV1 {
  const { connector: _connector, key: _key, subjectKey: _subjectKey, rawRef: _rawRef, ...contract } = event;
  return contract;
}

/** Rebuilds a record from a ledger, for a check that the stored projection matches. */
export const refold = (rows: LedgerRow[]): PrRecord | null => {
  const record = foldAll(rows);
  return record === null ? null : (JSON.parse(JSON.stringify(record)) as PrRecord);
};
