import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { exportInputs, runReplay, verifyDb } from "../server/pr-orchestrator/replay.ts";

const USAGE = `usage: node --experimental-strip-types scripts/pr-orchestrator-replay.ts
  --events <file.ndjson> [--config <file.json>] [--mode simulated|recorded] [--handlers stub|succeed]
  --db <copy of pr-orchestrator.db> --verify|--export`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      events: { type: "string" }, config: { type: "string" }, mode: { type: "string", default: "simulated" },
      handlers: { type: "string", default: "stub" }, db: { type: "string" }, verify: { type: "boolean" }, export: { type: "boolean" },
    },
  });
  if (values.mode !== "simulated" && values.mode !== "recorded") throw new Error("--mode is simulated or recorded");
  if (values.handlers !== "stub" && values.handlers !== "succeed") throw new Error("--handlers is stub or succeed");
  if (values.db) {
    if (values.events) throw new Error("pass either --events or --db, not both");
    if (Boolean(values.verify) === Boolean(values.export)) throw new Error("--db needs exactly one of --verify or --export");
    if (values.export) {
      process.stdout.write(`${exportInputs(values.db)}\n`);
      return 0;
    }
    const differing = verifyDb(values.db);
    process.stdout.write(`${JSON.stringify({ verified: differing.length === 0, differing })}\n`);
    return differing.length === 0 ? 0 : 1;
  }
  if (!values.events) throw new Error("--events or --db is required");
  const eventsText = readFileSync(values.events, "utf8");
  const configText = values.config ? readFileSync(values.config, "utf8") : undefined;
  const summary = await runReplay({ eventsText, configText, mode: values.mode, handlers: values.handlers });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary.mismatches.length === 0 ? 0 : 1;
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
  process.exitCode = 1;
}

main().then(code => { process.exitCode = code; }, fail);
