import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { readStateFile, writeStateFile } from "./json-file.ts";
import type { ExecScope, SecretScope } from "./types.ts";

export const GRANTS_FILE = "secret-grants.json";

const grantSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  project: z.string(),
  fingerprint: z.string().min(1),
  purpose: z.string(),
  state: z.enum(["allow", "block"]),
  createdAt: z.number(),
  /** `omb`: allowed by OpenMausBot's own rule for a secret kept to the Paseo bot; `card`: the person's answer; `admin`: `grant`. */
  createdBy: z.enum(["omb", "card", "admin"]),
  /** Absent: it never ends. */
  expiresAt: z.number().optional(),
  /** Good for one release; kept beside any standing allow on the same scope. */
  once: z.literal(true).optional(),
  agentLabel: z.string().optional(),
  allowHosts: z.array(z.string()).optional(),
  exec: z.object({ path: z.string().min(1), env: z.string().min(1), hash: z.string().min(1) }).optional(),
});

const fileSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema) });

export type Grant = z.infer<typeof grantSchema>;
export interface NewGrant extends SecretScope {
  state: "allow" | "block";
  createdBy: Grant["createdBy"];
  expiresAt?: number;
  once?: boolean;
  agentLabel?: string;
  allowHosts?: string[];
}

export type GrantMatch = { kind: "block"; grant: Grant } | { kind: "allow"; grant: Grant } | { kind: "none" };

export interface RevokeFilter {
  fingerprint: string;
  all?: boolean;
  ref?: string;
  project?: string;
  purpose?: string;
  /** An exec scope is named by program and variable; whatever hash it was granted with matches. */
  exec?: Pick<ExecScope, "path" | "env">;
}

const sameBase = (grant: Grant, scope: SecretScope): boolean =>
  grant.ref === scope.ref && grant.project === scope.project && grant.fingerprint === scope.fingerprint && grant.purpose === scope.purpose;

const sameExec = (a: ExecScope | undefined, b: ExecScope | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.path === b.path && a.env === b.env && a.hash === b.hash;

/**
 * Who may read which secret. A grant is keyed by ref, project, caller fingerprint and purpose, plus program, variable
 * and program hash for an exec scope. A block outranks every allow on its scope, and an ordinary block also refuses the
 * exec scopes of that ref. A state file that cannot be read fails closed: it is never treated as empty.
 */
export class GrantStore {
  private readonly file: string;
  private readonly now: () => number;
  private rows: Grant[] | null = null;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, GRANTS_FILE);
    this.now = options.now ?? Date.now;
  }

  private load(): Grant[] {
    this.rows ??= readStateFile(this.file, fileSchema, { version: 1 as const, grants: [] }).grants;
    return this.rows;
  }

  private live(grant: Grant): boolean {
    return grant.expiresAt === undefined || grant.expiresAt > this.now();
  }

  private save(next: Grant[]): void {
    const kept = next.filter((grant) => this.live(grant));
    writeStateFile(this.file, { version: 1, grants: kept });
    this.rows = kept;
  }

  match(scope: SecretScope): GrantMatch {
    const rows = this.load().filter((grant) => this.live(grant) && sameBase(grant, scope));
    const block = rows.find((grant) => grant.state === "block" && (grant.exec === undefined || sameExec(grant.exec, scope.exec)));
    if (block) return { kind: "block", grant: block };
    const allows = rows.filter((grant) => grant.state === "allow" && sameExec(grant.exec, scope.exec));
    const grant = allows.find((one) => !one.once) ?? allows[0];
    return grant ? { kind: "allow", grant } : { kind: "none" };
  }

  add(input: NewGrant): Grant {
    const rows = this.load().filter((grant) => this.live(grant));
    const replaced = rows.filter((grant) => sameBase(grant, input) && sameExec(grant.exec, input.exec)
      && grant.state === input.state && Boolean(grant.once) === Boolean(input.once));
    // Allowing again a scope that names hosts never drops them; only a new list replaces it.
    const allowHosts = input.allowHosts ?? (input.state === "allow" ? replaced.find((grant) => grant.allowHosts?.length)?.allowHosts : undefined);
    const grant: Grant = {
      id: randomUUID(), ref: input.ref, project: input.project, fingerprint: input.fingerprint, purpose: input.purpose, state: input.state,
      createdAt: this.now(), createdBy: input.createdBy,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.once ? { once: true as const } : {}),
      ...(input.agentLabel ? { agentLabel: input.agentLabel } : {}),
      ...(allowHosts?.length ? { allowHosts } : {}),
      ...(input.exec ? { exec: { ...input.exec } } : {}),
    };
    this.save([...rows.filter((row) => !replaced.includes(row)), grant]);
    return grant;
  }

  /** A single-release allow is spent by its release. */
  spend(id: string): void {
    this.save(this.load().filter((grant) => grant.id !== id));
  }

  revoke(filter: RevokeFilter): number {
    const rows = this.load();
    const gone = rows.filter((grant) => {
      if (grant.fingerprint !== filter.fingerprint) return false;
      if (filter.all) return true;
      if (grant.ref !== filter.ref || grant.project !== (filter.project ?? "default") || grant.purpose !== (filter.purpose ?? "")) return false;
      return filter.exec ? grant.exec?.path === filter.exec.path && grant.exec.env === filter.exec.env : grant.exec === undefined;
    });
    if (gone.length) this.save(rows.filter((grant) => !gone.includes(grant)));
    return gone.length;
  }

  /** A deleted secret takes its grants with it, so a new secret under the same name starts with none. */
  removeRef(ref: string): number {
    const rows = this.load();
    const gone = rows.filter((grant) => grant.ref === ref);
    if (gone.length) this.save(rows.filter((grant) => grant.ref !== ref));
    return gone.length;
  }

  list(filter: { fingerprint?: string; ref?: string } = {}): Grant[] {
    return this.load().filter((grant) => this.live(grant) && (filter.fingerprint === undefined || grant.fingerprint === filter.fingerprint)
      && (filter.ref === undefined || grant.ref === filter.ref));
  }
}
