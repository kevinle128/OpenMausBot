import type { DueTimerOptions, startDueTimer } from "../../due-timer.ts";

/** A due timer that runs only when a test calls it: the test reads `next()` and calls `run()` by hand. */
export function manualTimer(): { startTimer: typeof startDueTimer; options(): DueTimerOptions; pokes(): number; stopped(): boolean } {
  let captured: DueTimerOptions | null = null;
  let pokes = 0;
  let stopped = false;
  return {
    startTimer: ((options: DueTimerOptions) => {
      captured = options;
      return { poke() { pokes += 1; }, stop() { stopped = true; } };
    }) as typeof startDueTimer,
    options: () => captured as DueTimerOptions,
    pokes: () => pokes,
    stopped: () => stopped,
  };
}
