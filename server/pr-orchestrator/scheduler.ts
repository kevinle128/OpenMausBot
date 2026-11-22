import { startDueTimer } from "../due-timer.ts";
import type { CommandBus } from "./command-bus.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { OrchestratorStore } from "./store.ts";
import type { OrchestratorConfig } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMER_BATCH = 100;
const LAST_PRUNE_KEY = "last_prune_at";

export interface SchedulerDeps {
  store: OrchestratorStore;
  pm: ProcessManager;
  bus: CommandBus;
  now(): number;
  config(): OrchestratorConfig;
  /** Tests and the simulator replace the real due timer to drive run and next by hand. */
  startTimer?: typeof startDueTimer;
  /** Called once when this run applied at least one received row. */
  onApplied?(): void;
  log(line: string): void;
}

export interface Scheduler {
  /** Starts the due timer, which runs at once. Nothing runs before this, so a boot repair can come first. */
  start(): void;
  poke(): void;
  stop(): void;
}

/** One due timer for the whole core: it drains received events, fires timers, runs commands and prunes once a day. */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, pm, bus } = deps;

  function nextPrune(): number {
    const last = store.meta(LAST_PRUNE_KEY);
    return last === null ? deps.now() : Number(last) + DAY_MS;
  }

  function next(): number | null {
    const times = [store.nextTimerAt(), store.nextCommandAt(), nextPrune()];
    if (store.receivedByStatus("pending", 1).length > 0) times.push(deps.now());
    return Math.min(...times.filter((time): time is number => time !== null));
  }

  async function run(): Promise<void> {
    const appliedBefore = store.countReceivedByStatus().applied;
    try {
      pm.drain();
    } finally {
      // Rows commit one by one, so a drain that throws midway may still have applied some.
      try {
        if (store.countReceivedByStatus().applied > appliedBefore) deps.onApplied?.();
      } catch (error) {
        deps.log(`pr-orchestrator: an applied-event listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const timer of store.dueTimers(deps.now(), TIMER_BATCH)) {
      try {
        pm.fireTimer(timer);
      } catch (error) {
        deps.log(`pr-orchestrator: timer ${timer.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await bus.runDue();
    const now = deps.now();
    if (nextPrune() <= now) {
      const { retention } = deps.config();
      const removed = store.prune(now - retention.endedPrDays * DAY_MS, now - retention.receivedEventDays * DAY_MS, now);
      store.setMeta(LAST_PRUNE_KEY, String(now));
      if (removed.prs + removed.subjects + removed.received > 0) {
        deps.log(`pr-orchestrator: pruned ${removed.prs} PRs, ${removed.subjects} subjects and ${removed.received} received events`);
      }
    }
  }

  let timer: ReturnType<typeof startDueTimer> | null = null;
  return {
    start() {
      timer ??= (deps.startTimer ?? startDueTimer)({
        run, next, now: deps.now,
        onError: error => deps.log(`pr-orchestrator: scheduler run failed: ${error instanceof Error ? error.message : String(error)}`),
      });
    },
    poke: () => timer?.poke(),
    stop: () => timer?.stop(),
  };
}
