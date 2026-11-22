import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  CommandRecord, CommandResult, LedgerEntry, LedgerRow, PrKey, PrRecord, PrState, SubjectKey, TimerKind, TimerRecord,
} from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS received_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  connector TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  subject_kind TEXT,
  kind TEXT,
  received_at INTEGER NOT NULL,
  occurred_at TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS received_pending ON received_events(seq) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS received_subject ON received_events(subject_key, seq);
CREATE INDEX IF NOT EXISTS received_connector ON received_events(connector, received_at);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL,
  config_version TEXT NOT NULL,
  causation_seq INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_subject ON ledger(subject_key, seq);
CREATE INDEX IF NOT EXISTS ledger_type ON ledger(type, seq);
CREATE TABLE IF NOT EXISTS prs (
  pr_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL,
  state TEXT NOT NULL, head_sha TEXT, owner_agent_id TEXT,
  last_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prs_state ON prs(state);
CREATE INDEX IF NOT EXISTS prs_owner ON prs(owner_agent_id);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL, type TEXT NOT NULL, routine_id TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  approval_id TEXT,
  outcome TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL, result_json TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS commands_due ON commands(next_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS commands_subject ON commands(subject_key, status);
CREATE INDEX IF NOT EXISTS commands_approval ON commands(approval_id) WHERE approval_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  subject_key TEXT NOT NULL, kind TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE,
  due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS timers_due ON timers(due_at) WHERE state = 'armed';
CREATE INDEX IF NOT EXISTS timers_subject ON timers(subject_key, kind, state);
CREATE TABLE IF NOT EXISTS config_versions (version TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connector_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector TEXT NOT NULL, at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS connector_log_at ON connector_log(connector, at);
CREATE TABLE IF NOT EXISTS connector_cursors (connector TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const CONNECTOR_LOG_KEEP_MS = 7 * DAY_MS;
const ENDED_STATES = "('merged', 'closed')";

export type ReceivedStatus = "pending" | "applied" | "failed";
export interface ReceivedRow {
  seq: number; eventId: string; prKey: PrKey | null; kind: string | null; receivedAt: number; occurredAt: string | null;
  status: ReceivedStatus; reason: string | null; json: string;
}
export type ConnectorOutcome = "accepted" | "duplicate" | "rejected" | "bad_signature" | "bad_request" | "error";

export interface OrchestratorStore {
  readonly path: string;
  /** Nested calls become savepoints, as in server/runtime/store.ts. */
  transaction<T>(fn: () => T): T;
  meta(key: string): string | null;
  setMeta(key: string, value: string): void;

  /** INSERT OR IGNORE by event id; returns the ids that were new. A null subject key is stored as an empty string. */
  insertReceived(rows: Array<{
    eventId: string; connector: string; subjectKey: SubjectKey | null; subjectKind: string | null; kind: string | null;
    receivedAt: number; occurredAt: string | null; status: "pending"; reason: null; json: string;
  }>): string[];
  /** Oldest first. */
  receivedByStatus(status: ReceivedStatus, limit: number): ReceivedRow[];
  setReceivedStatus(seq: number, status: ReceivedStatus, reason: string | null): void;
  countReceivedByStatus(): Record<ReceivedStatus, number>;
  lastReceivedAt(): number | null;

  /** Returns the new seq. */
  append(row: Omit<LedgerRow, "seq">): number;
  ledger(subjectKey: SubjectKey, afterSeq?: number): LedgerRow[];
  /** Every subject key with at least one row; prOnly lists the keys of the prs table instead. */
  ledgerKeys(filter?: { prOnly?: boolean }): SubjectKey[];
  /** routine.matched rows of one routine across all subjects, newest first. */
  routineRuns(routineId: string, limit: number): LedgerRow[];

  getPr(prKey: PrKey): PrRecord | null;
  /** Upsert; the indexed columns come from the record. */
  putPr(record: PrRecord): void;
  /** Newest update first. */
  listPrs(filter: { state?: PrState; limit: number }): PrRecord[];
  countPrsByState(): Partial<Record<PrState, number>>;

  /** false when the idempotency key already exists (nothing written). Status is pending, or awaiting_approval with approvalId set. */
  insertCommand(cmd: CommandRecord): boolean;
  /** The awaiting_approval command held by this decision id, or null. */
  commandAwaiting(approvalId: string): CommandRecord | null;
  /** awaiting_approval becomes pending with next_at = now, and the approval id is cleared. */
  releaseCommand(id: string, now: number): void;
  awaitingFor(subjectKey: SubjectKey): CommandRecord[];
  getCommand(id: string): CommandRecord | null;
  /** The command whose succeeded result carries this run ref. */
  commandByRunRef(runRef: string): CommandRecord | null;
  /** Pending commands due at now, one per subject, for subjects with no running command; oldest created first. */
  dueCommands(now: number, limit: number): CommandRecord[];
  nextCommandAt(): number | null;
  /** attempts + 1 */
  markCommandRunning(id: string, now: number): void;
  /** Back to pending. */
  rescheduleCommand(id: string, nextAt: number, error: string, now: number): void;
  finishCommand(id: string, result: CommandResult, now: number): void;
  /** Boot: running becomes pending. Returns the number of rows changed. */
  resetRunningCommands(now: number): number;
  commandsFor(subjectKey: SubjectKey): CommandRecord[];
  countCommands(): Array<{ status: string; outcome: string | null; count: number }>;

  /** false when the idempotency key already exists. */
  insertTimer(timer: TimerRecord): boolean;
  armedTimers(subjectKey: SubjectKey, kind?: TimerKind): TimerRecord[];
  dueTimers(now: number, limit: number): TimerRecord[];
  nextTimerAt(): number | null;
  setTimerState(id: string, state: "fired" | "cancelled"): void;
  timersFor(subjectKey: SubjectKey): TimerRecord[];
  countArmedTimers(): number;

  /** INSERT OR IGNORE by version. */
  saveConfigVersion(version: string, json: string, at: number): void;
  configVersion(version: string): { firstSeenAt: number; json: string } | null;

  /** Records one intake outcome of a connector: a reason, never a body or a header. */
  logConnector(entry: { connector: string; at: number; outcome: ConnectorOutcome; count: number; detail?: string }): void;
  connectorStatus(connector: string, now: number): {
    lastEventAt: number | null; events24h: number; lastError: string | null; lastErrorAt: number | null; signatureFailures24h: number;
  };
  cursor(connector: string): { cursor: string; updatedAt: number } | null;
  saveCursor(connector: string, cursor: string, at: number): void;

  /**
   * Deletes the ledger, commands, timers and prs rows of PRs in merged or closed state whose updated_at is before endedBefore,
   * the ledger rows of other subjects older than endedBefore, received rows older than receivedBefore that are not pending,
   * and connector_log rows older than 7 days. Returns the counts. This is the only delete of ledger rows.
   */
  prune(endedBefore: number, receivedBefore: number, now: number): { prs: number; subjects: number; received: number; connectorLog: number };
  close(): void;
}

type Row = Record<string, unknown>;

const readLedger = (row: Row): LedgerRow => ({
  seq: Number(row.seq), subjectKey: String(row.subject_key), at: Number(row.at), configVersion: String(row.config_version),
  causationSeq: row.causation_seq == null ? null : Number(row.causation_seq),
  entry: JSON.parse(String(row.json)) as LedgerEntry,
});

const readReceived = (row: Row): ReceivedRow => {
  const subject = String(row.subject_key);
  return {
    seq: Number(row.seq), eventId: String(row.event_id),
    prKey: subject === "" || subject.startsWith("subject:") ? null : subject,
    kind: row.kind == null ? null : String(row.kind), receivedAt: Number(row.received_at),
    occurredAt: row.occurred_at == null ? null : String(row.occurred_at),
    status: String(row.status) as ReceivedStatus, reason: row.reason == null ? null : String(row.reason), json: String(row.json),
  };
};

const readCommand = (row: Row): CommandRecord => ({
  id: String(row.id), subjectKey: String(row.subject_key), type: String(row.type) as CommandRecord["type"],
  routineId: String(row.routine_id), idemKey: String(row.idem_key), status: String(row.status) as CommandRecord["status"],
  outcome: row.outcome == null ? null : (String(row.outcome) as CommandResult["outcome"]),
  approvalId: row.approval_id == null ? null : String(row.approval_id),
  attempts: Number(row.attempts), nextAt: Number(row.next_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  payload: JSON.parse(String(row.payload_json)) as CommandRecord["payload"],
  result: row.result_json == null ? null : (JSON.parse(String(row.result_json)) as CommandResult),
  lastError: row.last_error == null ? null : String(row.last_error),
});

const readTimer = (row: Row): TimerRecord => ({
  id: String(row.id), subjectKey: String(row.subject_key), kind: String(row.kind) as TimerKind, idemKey: String(row.idem_key),
  dueAt: Number(row.due_at), createdAt: Number(row.created_at), state: String(row.state) as TimerRecord["state"],
  payload: JSON.parse(String(row.payload_json)) as TimerRecord["payload"],
});

const nullableNumber = (row: Row | undefined, key: string): number | null => (row?.[key] == null ? null : Number(row[key]));

export function openOrchestratorStore(path: string): OrchestratorStore {
  const memory = path === ":memory:";
  if (!memory) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Events and commands are private: owner-only from the first byte, repaired on a file that inherited a loose umask.
    closeSync(openSync(path, "a", 0o600));
    try {
      chmodSync(path, 0o600);
    } catch {}
  }
  const db = new DatabaseSync(path);
  if (!memory) {
    db.exec("PRAGMA journal_mode = WAL");
    // An ack to the hub is final, so a committed row must survive a power loss.
    db.exec("PRAGMA synchronous = FULL");
  }
  db.exec(SCHEMA);

  const q = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),

    insertReceived: db.prepare(`INSERT OR IGNORE INTO received_events
      (event_id, connector, subject_key, subject_kind, kind, received_at, occurred_at, status, reason, json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    receivedByStatus: db.prepare("SELECT * FROM received_events WHERE status = ? ORDER BY seq LIMIT ?"),
    setReceivedStatus: db.prepare("UPDATE received_events SET status = ?, reason = ? WHERE seq = ?"),
    countReceived: db.prepare("SELECT status, COUNT(*) AS count FROM received_events GROUP BY status"),
    lastReceived: db.prepare("SELECT MAX(received_at) AS at FROM received_events"),

    append: db.prepare("INSERT INTO ledger (subject_key, at, type, config_version, causation_seq, json) VALUES (?, ?, ?, ?, ?, ?)"),
    ledger: db.prepare("SELECT * FROM ledger WHERE subject_key = ? AND seq > ? ORDER BY seq"),
    ledgerKeys: db.prepare("SELECT DISTINCT subject_key FROM ledger"),
    prKeys: db.prepare("SELECT pr_key FROM prs"),
    routineRuns: db.prepare(`SELECT * FROM ledger WHERE type = 'routine.matched' AND json_extract(json, '$.routineId') = ?
      ORDER BY seq DESC LIMIT ?`),

    getPr: db.prepare("SELECT json FROM prs WHERE pr_key = ?"),
    putPr: db.prepare(`INSERT INTO prs (pr_key, provider, repo, number, state, head_sha, owner_agent_id, last_seq, updated_at, json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pr_key) DO UPDATE SET provider = excluded.provider, repo = excluded.repo, number = excluded.number,
        state = excluded.state, head_sha = excluded.head_sha, owner_agent_id = excluded.owner_agent_id,
        last_seq = excluded.last_seq, updated_at = excluded.updated_at, json = excluded.json`),
    listPrs: db.prepare("SELECT json FROM prs WHERE (? IS NULL OR state = ?) ORDER BY updated_at DESC, rowid DESC LIMIT ?"),
    countPrs: db.prepare("SELECT state, COUNT(*) AS count FROM prs GROUP BY state"),

    insertCommand: db.prepare(`INSERT OR IGNORE INTO commands (id, subject_key, type, routine_id, idem_key, status, approval_id, outcome,
      attempts, next_at, created_at, updated_at, payload_json, result_json, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    commandAwaiting: db.prepare("SELECT * FROM commands WHERE approval_id = ? AND status = 'awaiting_approval'"),
    releaseCommand: db.prepare(`UPDATE commands SET status = 'pending', next_at = ?, approval_id = NULL, updated_at = ?
      WHERE id = ? AND status = 'awaiting_approval'`),
    awaitingFor: db.prepare("SELECT * FROM commands WHERE subject_key = ? AND status = 'awaiting_approval' ORDER BY created_at, rowid"),
    getCommand: db.prepare("SELECT * FROM commands WHERE id = ?"),
    commandByRunRef: db.prepare(`SELECT * FROM commands WHERE type = 'RunWorkflow' AND outcome = 'succeeded'
      AND json_extract(result_json, '$.detail.runRef') = ? ORDER BY created_at, rowid LIMIT 1`),
    dueCommands: db.prepare(`SELECT * FROM commands c WHERE c.status = 'pending' AND c.next_at <= ?
      AND c.subject_key NOT IN (SELECT subject_key FROM commands WHERE status = 'running')
      AND c.id = (SELECT d.id FROM commands d WHERE d.subject_key = c.subject_key AND d.status = 'pending' AND d.next_at <= ?
        ORDER BY d.created_at, d.rowid LIMIT 1)
      ORDER BY c.created_at, c.rowid LIMIT ?`),
    nextCommandAt: db.prepare("SELECT MIN(next_at) AS at FROM commands WHERE status = 'pending'"),
    markRunning: db.prepare("UPDATE commands SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?"),
    reschedule: db.prepare("UPDATE commands SET status = 'pending', next_at = ?, last_error = ?, updated_at = ? WHERE id = ?"),
    finish: db.prepare(`UPDATE commands SET status = 'done', outcome = ?, result_json = ?,
      last_error = CASE WHEN ? = 'failed' THEN ? ELSE last_error END, updated_at = ? WHERE id = ?`),
    resetRunning: db.prepare("UPDATE commands SET status = 'pending', updated_at = ? WHERE status = 'running'"),
    commandsFor: db.prepare("SELECT * FROM commands WHERE subject_key = ? ORDER BY created_at, rowid"),
    countCommands: db.prepare("SELECT status, outcome, COUNT(*) AS count FROM commands GROUP BY status, outcome"),

    insertTimer: db.prepare(`INSERT OR IGNORE INTO timers (id, subject_key, kind, idem_key, due_at, created_at, state, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    armedTimers: db.prepare("SELECT * FROM timers WHERE subject_key = ? AND state = 'armed' ORDER BY due_at, rowid"),
    armedTimersOfKind: db.prepare("SELECT * FROM timers WHERE subject_key = ? AND kind = ? AND state = 'armed' ORDER BY due_at, rowid"),
    dueTimers: db.prepare("SELECT * FROM timers WHERE state = 'armed' AND due_at <= ? ORDER BY due_at, rowid LIMIT ?"),
    nextTimerAt: db.prepare("SELECT MIN(due_at) AS at FROM timers WHERE state = 'armed'"),
    setTimerState: db.prepare("UPDATE timers SET state = ? WHERE id = ?"),
    timersFor: db.prepare("SELECT * FROM timers WHERE subject_key = ? ORDER BY created_at, rowid"),
    countArmedTimers: db.prepare("SELECT COUNT(*) AS count FROM timers WHERE state = 'armed'"),

    saveConfigVersion: db.prepare("INSERT OR IGNORE INTO config_versions (version, first_seen_at, json) VALUES (?, ?, ?)"),
    configVersion: db.prepare("SELECT first_seen_at, json FROM config_versions WHERE version = ?"),

    logConnector: db.prepare("INSERT INTO connector_log (connector, at, outcome, count, detail) VALUES (?, ?, ?, ?, ?)"),
    lastEvent: db.prepare("SELECT MAX(received_at) AS at FROM received_events WHERE connector = ?"),
    events24h: db.prepare("SELECT COUNT(*) AS count FROM received_events WHERE connector = ? AND received_at >= ?"),
    lastError: db.prepare(`SELECT at, outcome, detail FROM connector_log WHERE connector = ?
      AND outcome NOT IN ('accepted', 'duplicate') ORDER BY at DESC, id DESC LIMIT 1`),
    signatureFailures: db.prepare(`SELECT COALESCE(SUM(count), 0) AS count FROM connector_log
      WHERE connector = ? AND outcome = 'bad_signature' AND at >= ?`),
    cursor: db.prepare("SELECT cursor, updated_at FROM connector_cursors WHERE connector = ?"),
    saveCursor: db.prepare(`INSERT INTO connector_cursors (connector, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(connector) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`),

    // A non-PR subject goes whole, like an ended PR: once its last row is old and no command or timer of it is still open.
    idleSubjectKeys: db.prepare(`SELECT subject_key FROM ledger
      WHERE subject_key NOT IN (SELECT pr_key FROM prs)
        AND subject_key NOT IN (SELECT subject_key FROM commands WHERE status != 'done')
        AND subject_key NOT IN (SELECT subject_key FROM timers WHERE state = 'armed')
      GROUP BY subject_key HAVING MAX(at) < ?`),
    endedKeys: db.prepare(`SELECT pr_key FROM prs WHERE state IN ${ENDED_STATES} AND updated_at < ?`),
    pruneLedgerOf: db.prepare("DELETE FROM ledger WHERE subject_key = ?"),
    pruneCommandsOf: db.prepare("DELETE FROM commands WHERE subject_key = ?"),
    pruneTimersOf: db.prepare("DELETE FROM timers WHERE subject_key = ?"),
    prunePr: db.prepare("DELETE FROM prs WHERE pr_key = ?"),
    pruneReceived: db.prepare("DELETE FROM received_events WHERE status != 'pending' AND received_at < ?"),
    pruneConnectorLog: db.prepare("DELETE FROM connector_log WHERE at < ?"),
  };

  const all = (statement: ReturnType<DatabaseSync["prepare"]>, ...params: SQLInputValue[]): Row[] => statement.all(...params) as Row[];
  const one = (statement: ReturnType<DatabaseSync["prepare"]>, ...params: SQLInputValue[]): Row | undefined =>
    statement.get(...params) as Row | undefined;

  let depth = 0;
  function transaction<T>(fn: () => T): T {
    if (depth > 0) {
      const savepoint = `orchestrator_${depth}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally { depth -= 1; }
    }
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally { depth = 0; }
  }

  return {
    path,
    transaction,
    meta: (key) => {
      const row = one(q.getMeta, key);
      return row ? String(row.value) : null;
    },
    setMeta: (key, value) => { q.setMeta.run(key, value); },

    insertReceived: (rows) => transaction(() => {
      const added: string[] = [];
      for (const r of rows) {
        const result = q.insertReceived.run(r.eventId, r.connector, r.subjectKey ?? "", r.subjectKind, r.kind, r.receivedAt,
          r.occurredAt, r.status, r.reason, r.json);
        if (Number(result.changes) > 0) added.push(r.eventId);
      }
      return added;
    }),
    receivedByStatus: (status, limit) => all(q.receivedByStatus, status, limit).map(readReceived),
    setReceivedStatus: (seq, status, reason) => { q.setReceivedStatus.run(status, reason, seq); },
    countReceivedByStatus: () => {
      const counts: Record<ReceivedStatus, number> = { pending: 0, applied: 0, failed: 0 };
      for (const row of all(q.countReceived)) counts[String(row.status) as ReceivedStatus] = Number(row.count);
      return counts;
    },
    lastReceivedAt: () => nullableNumber(one(q.lastReceived), "at"),

    append: (row) => Number(q.append.run(row.subjectKey, row.at, row.entry.type, row.configVersion, row.causationSeq,
      JSON.stringify(row.entry)).lastInsertRowid),
    ledger: (subjectKey, afterSeq = 0) => all(q.ledger, subjectKey, afterSeq).map(readLedger),
    ledgerKeys: (filter) => (filter?.prOnly
      ? all(q.prKeys).map((row) => String(row.pr_key))
      : all(q.ledgerKeys).map((row) => String(row.subject_key))),
    routineRuns: (routineId, limit) => all(q.routineRuns, routineId, limit).map(readLedger),

    getPr: (key) => {
      const row = one(q.getPr, key);
      return row ? (JSON.parse(String(row.json)) as PrRecord) : null;
    },
    putPr: (r) => {
      q.putPr.run(r.key, r.provider, r.repo, r.number, r.state, r.headSha, r.owner?.agentId ?? null, r.lastSeq, r.updatedAt,
        JSON.stringify(r));
    },
    listPrs: ({ state, limit }) => all(q.listPrs, state ?? null, state ?? null, limit).map((row) => JSON.parse(String(row.json)) as PrRecord),
    countPrsByState: () => {
      const counts: Partial<Record<PrState, number>> = {};
      for (const row of all(q.countPrs)) counts[String(row.state) as PrState] = Number(row.count);
      return counts;
    },

    insertCommand: (cmd) => {
      if (cmd.status !== "pending" && cmd.status !== "awaiting_approval") throw new Error(`a new command is pending or awaiting approval, not ${cmd.status}`);
      if ((cmd.status === "awaiting_approval") !== (cmd.approvalId != null)) throw new Error("approvalId is set exactly when the command awaits approval");
      const result = q.insertCommand.run(cmd.id, cmd.subjectKey, cmd.type, cmd.routineId, cmd.idemKey, cmd.status, cmd.approvalId,
        cmd.outcome, cmd.attempts, cmd.nextAt, cmd.createdAt, cmd.updatedAt, JSON.stringify(cmd.payload),
        cmd.result ? JSON.stringify(cmd.result) : null, cmd.lastError);
      return Number(result.changes) > 0;
    },
    commandAwaiting: (approvalId) => {
      const row = one(q.commandAwaiting, approvalId);
      return row ? readCommand(row) : null;
    },
    releaseCommand: (id, now) => { q.releaseCommand.run(now, now, id); },
    awaitingFor: (subjectKey) => all(q.awaitingFor, subjectKey).map(readCommand),
    getCommand: (id) => {
      const row = one(q.getCommand, id);
      return row ? readCommand(row) : null;
    },
    commandByRunRef: (runRef) => {
      const row = one(q.commandByRunRef, runRef);
      return row ? readCommand(row) : null;
    },
    dueCommands: (now, limit) => all(q.dueCommands, now, now, limit).map(readCommand),
    nextCommandAt: () => nullableNumber(one(q.nextCommandAt), "at"),
    markCommandRunning: (id, now) => { q.markRunning.run(now, id); },
    rescheduleCommand: (id, nextAt, error, now) => { q.reschedule.run(nextAt, error, now, id); },
    finishCommand: (id, result, now) => {
      const reason = result.outcome === "failed" ? result.reason : null;
      q.finish.run(result.outcome, JSON.stringify(result), result.outcome, reason, now, id);
    },
    resetRunningCommands: (now) => Number(q.resetRunning.run(now).changes),
    commandsFor: (subjectKey) => all(q.commandsFor, subjectKey).map(readCommand),
    countCommands: () => all(q.countCommands).map((row) => ({
      status: String(row.status), outcome: row.outcome == null ? null : String(row.outcome), count: Number(row.count),
    })),

    insertTimer: (t) => Number(q.insertTimer.run(t.id, t.subjectKey, t.kind, t.idemKey, t.dueAt, t.createdAt, t.state,
      JSON.stringify(t.payload)).changes) > 0,
    armedTimers: (subjectKey, kind) => (kind === undefined ? all(q.armedTimers, subjectKey) : all(q.armedTimersOfKind, subjectKey, kind)).map(readTimer),
    dueTimers: (now, limit) => all(q.dueTimers, now, limit).map(readTimer),
    nextTimerAt: () => nullableNumber(one(q.nextTimerAt), "at"),
    setTimerState: (id, state) => { q.setTimerState.run(state, id); },
    timersFor: (subjectKey) => all(q.timersFor, subjectKey).map(readTimer),
    countArmedTimers: () => Number(one(q.countArmedTimers)?.count ?? 0),

    saveConfigVersion: (version, json, at) => { q.saveConfigVersion.run(version, at, json); },
    configVersion: (version) => {
      const row = one(q.configVersion, version);
      return row ? { firstSeenAt: Number(row.first_seen_at), json: String(row.json) } : null;
    },

    logConnector: ({ connector, at, outcome, count, detail }) => { q.logConnector.run(connector, at, outcome, count, detail ?? null); },
    connectorStatus: (connector, now) => {
      const since = now - DAY_MS;
      const error = one(q.lastError, connector);
      return {
        lastEventAt: nullableNumber(one(q.lastEvent, connector), "at"),
        events24h: Number(one(q.events24h, connector, since)?.count ?? 0),
        lastError: error ? String(error.detail ?? error.outcome) : null,
        lastErrorAt: error ? Number(error.at) : null,
        signatureFailures24h: Number(one(q.signatureFailures, connector, since)?.count ?? 0),
      };
    },
    cursor: (connector) => {
      const row = one(q.cursor, connector);
      return row ? { cursor: String(row.cursor), updatedAt: Number(row.updated_at) } : null;
    },
    saveCursor: (connector, cursor, at) => { q.saveCursor.run(connector, cursor, at); },

    prune: (endedBefore, receivedBefore, now) => transaction(() => {
      const subjects = all(q.idleSubjectKeys, endedBefore).map((row) => String(row.subject_key));
      const ended = all(q.endedKeys, endedBefore).map((row) => String(row.pr_key));
      for (const key of [...subjects, ...ended]) {
        q.pruneLedgerOf.run(key);
        q.pruneCommandsOf.run(key);
        q.pruneTimersOf.run(key);
      }
      for (const key of ended) q.prunePr.run(key);
      return {
        prs: ended.length,
        subjects: subjects.length,
        received: Number(q.pruneReceived.run(receivedBefore).changes),
        connectorLog: Number(q.pruneConnectorLog.run(now - CONNECTOR_LOG_KEEP_MS).changes),
      };
    }),
    close: () => { db.close(); },
  };
}
