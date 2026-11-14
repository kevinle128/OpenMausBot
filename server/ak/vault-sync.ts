import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { vaultNameKey } from "../../shared/vault.ts";
import { TEAM_READER, type VaultStore } from "../vault-store.ts";
import { AkError, type AkCli } from "./cli.ts";
import { describeAkError, type AkGuard } from "./guard.ts";

export const AK_SYNC_LEDGER_FILE = "ak-synced-refs.json";
const POLL_MS = 1_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const REF_MAX = 128;
// ak refuses a "/", control, bidi, zero-width and line-separator characters in a new ref; a leading "-" would read as a flag.
// Code point ranges: C0/C1 controls, soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and bidi marks,
// line and paragraph separators, word joiner and invisible operators, and the byte order mark.
const REF_FORBIDDEN_RANGES: Array<[number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
];

const forbiddenInRef = (char: string): boolean => {
  const code = char.codePointAt(0)!;
  return char === "/" || REF_FORBIDDEN_RANGES.some(([from, to]) => code >= from && code <= to);
};

export function isAkRef(name: string): boolean {
  return name.length > 0 && name.length <= REF_MAX && name.trim() === name && !name.startsWith("-") && ![...name].some(forbiddenInRef);
}

type VaultPort = Pick<VaultStore, "version" | "listSecrets" | "secret">;

export interface ScopedSecret {
  id: string;
  ref: string;
  updatedAt: number;
}

/** The secrets kept to the Paseo bot: its own choice in the Vault's bot picker, so a secret meant for other bots is never
 * copied to `ak`. A name that is not a valid ref is skipped; of two secrets with one name the newest is used. */
export function paseoScopedSecrets(vault: Pick<VaultStore, "listSecrets">, botId: string, onSkip?: (name: string, why: string) => void): Map<string, ScopedSecret> {
  const byName = new Map<string, ScopedSecret>();
  for (const secret of vault.listSecrets(TEAM_READER)) {
    if (secret.bots === "all" || !secret.bots.includes(botId)) continue;
    if (!isAkRef(secret.name)) {
      onSkip?.(secret.name, "not a valid ak ref");
      continue;
    }
    const key = vaultNameKey(secret.name);
    const seen = byName.get(key);
    if (seen && seen.updatedAt >= secret.updatedAt) {
      onSkip?.(secret.name, "another secret has the same name");
      continue;
    }
    byName.set(key, { id: secret.id, ref: secret.name, updatedAt: secret.updatedAt });
  }
  return new Map([...byName.values()].map((entry) => [entry.ref, entry]));
}

type Ledger = Record<string, { ref: string; updatedAt: number }>;

export interface VaultSync {
  /** Runs one reconcile now (or after the one in flight). Resolves when it is done; never rejects. */
  reconcile(): Promise<void>;
  /** True for a ref OpenMausBot wrote to ak and the Vault still keeps for the Paseo bot. */
  owns(ref: string): boolean;
  stop(): void;
}

export interface VaultSyncDeps {
  vault: VaultPort;
  cli: Pick<AkCli, "list" | "set" | "rotate" | "delete">;
  guard: AkGuard;
  dataDir: string;
  botId: string;
  log(message: string): void;
  now?(): number;
}

/**
 * Keeps `ak secrets` in step with the Vault. Only refs OpenMausBot wrote itself (the ledger holds ref and Vault update
 * time, never a value or a hash of one) are ever rotated or deleted, so a secret the person made in `ak` is left alone.
 * The Vault has no event for a new secret, so its write counter is polled and the in-scope list is diffed against the ledger.
 */
export function startVaultSync(deps: VaultSyncDeps): VaultSync {
  const { vault, cli, guard, log } = deps;
  const ledgerFile = join(deps.dataDir, AK_SYNC_LEDGER_FILE);
  const now = deps.now ?? Date.now;
  let ledger: Ledger = loadLedger(ledgerFile, log);
  let running: Promise<void> | null = null;
  let again = false;
  let doneSignature: string | null = null;
  let seenVersion = -1;
  let retryAt = 0;
  let failures = 0;
  let lastFailure = "";
  const warned = new Set<string>();

  const warnOnce = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    log(message);
  };
  const save = () => writeFileAtomic(ledgerFile, JSON.stringify({ version: 1, refs: ledger }), { mode: 0o600 });
  const scope = () => paseoScopedSecrets(vault, deps.botId, (name, why) => warnOnce(`ak sync: skipped the secret "${name}": ${why}`));
  const signature = (entries: Map<string, ScopedSecret>) => JSON.stringify([...entries.values()].map((entry) => [entry.id, entry.ref, entry.updatedAt]).sort());

  async function pass(): Promise<void> {
    const wanted = scope();
    const sig = signature(wanted);
    if (sig === doneSignature) return;
    const present = new Set((await cli.list()).map((item) => item.ref));
    const byId = new Map([...wanted.values()].map((entry) => [entry.id, entry]));
    let clean = true;

    for (const [id, row] of Object.entries(ledger)) {
      const entry = byId.get(id);
      if (entry && entry.ref === row.ref) continue;
      try {
        if (present.has(row.ref)) await cli.delete(row.ref);
      } catch (error) {
        if (error instanceof AkError && error.kind === "invalid") {
          warnOnce(`ak sync: ak refused to remove "${row.ref}" (${describeAkError(error)}); it is dropped from the list of refs written by OpenMausBot`);
        } else if (!(error instanceof AkError && error.kind === "no-such-ref")) throw error;
      }
      delete ledger[id];
      save();
      log(`ak sync: removed "${row.ref}" from ak`);
    }

    for (const entry of wanted.values()) {
      const secret = vault.secret(entry.id);
      if (!secret) {
        clean = false;
        continue;
      }
      const row = ledger[entry.id];
      try {
        if (row && present.has(entry.ref)) {
          if (row.updatedAt === entry.updatedAt) continue;
          await cli.rotate(entry.ref, secret.value);
          log(`ak sync: updated "${entry.ref}" in ak`);
        } else {
          await cli.set(entry.ref, secret.value);
          log(`ak sync: added "${entry.ref}" to ak`);
        }
        ledger[entry.id] = { ref: entry.ref, updatedAt: entry.updatedAt };
        save();
      } catch (error) {
        if (error instanceof AkError && error.kind === "exists") {
          warnOnce(`ak sync: "${entry.ref}" already exists in ak and was not written by OpenMausBot; it is left alone`);
          continue;
        }
        // `ak` refused this one secret (a ref it does not accept, a value it does not take): the others still go over.
        // It is not retried until the secret changes. Any other failure is about `ak` itself, and ends the pass.
        if (error instanceof AkError && error.kind === "invalid") {
          warnOnce(`ak sync: ak refused "${entry.ref}" (${describeAkError(error)}); it is skipped`);
          continue;
        }
        throw error;
      }
    }
    if (clean) doneSignature = sig;
  }

  async function run(): Promise<void> {
    do {
      again = false;
      if (guard.blocked || now() < retryAt) return;
      try {
        await pass();
        failures = 0;
        lastFailure = "";
      } catch (error) {
        if (guard.report(error)) return;
        failures += 1;
        doneSignature = null;
        retryAt = now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures - 1));
        const message = `ak sync failed: ${describeAkError(error)}`;
        if (message !== lastFailure) log(message);
        lastFailure = message;
      }
    } while (again);
  }

  function reconcile(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  }

  const timer = setInterval(() => {
    if (guard.blocked) return;
    const version = vault.version;
    if (version !== seenVersion) {
      seenVersion = version;
      void reconcile();
    } else if (doneSignature === null && now() >= retryAt) void reconcile();
  }, POLL_MS);
  timer.unref();
  guard.onBlock(() => clearInterval(timer));
  void reconcile();

  return {
    reconcile,
    owns(ref) {
      const entry = paseoScopedSecrets(vault, deps.botId).get(ref);
      return entry !== undefined && ledger[entry.id]?.ref === ref;
    },
    stop: () => clearInterval(timer),
  };
}

function loadLedger(file: string, log: (message: string) => void): Ledger {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { refs?: Ledger };
    const refs = parsed.refs ?? {};
    return Object.fromEntries(Object.entries(refs).filter(([, row]) => typeof row?.ref === "string" && typeof row.updatedAt === "number"));
  } catch {
    log("ak sync: the list of refs written to ak could not be read; secrets already in ak are left alone");
    return {};
  }
}
