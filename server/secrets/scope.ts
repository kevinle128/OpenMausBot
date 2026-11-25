import { TEAM_READER, type VaultStore } from "../vault-store.ts";

const REF_MAX = 128;
// A ref refuses "/", control, bidi, zero-width and line-separator characters; a leading "-" would read as a flag.
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

/** A Vault secret name that can be a ref: no slash, leading dash, control or invisible character, and at most 128 characters. */
export function isScopedRef(name: string): boolean {
  return name.length > 0 && name.length <= REF_MAX && name.trim() === name && !name.startsWith("-") && ![...name].some(forbiddenInRef);
}

export interface ScopedSecret {
  id: string;
  ref: string;
  updatedAt: number;
}

/** Every team Vault secret whose name is a valid ref. `bots` is not consulted.
 * Of two secrets with one exact name, the newest `updatedAt` is kept. A name that differs in case or punctuation is its own ref. */
export function paseoScopedSecrets(vault: Pick<VaultStore, "listSecrets">, onSkip?: (name: string, why: string) => void): Map<string, ScopedSecret> {
  const byName = new Map<string, ScopedSecret>();
  for (const secret of vault.listSecrets(TEAM_READER)) {
    if (!isScopedRef(secret.name)) {
      onSkip?.(secret.name, "not a valid ref");
      continue;
    }
    const seen = byName.get(secret.name);
    if (seen) {
      onSkip?.(secret.name, "another secret has the same name");
      if (seen.updatedAt >= secret.updatedAt) continue;
    }
    byName.set(secret.name, { id: secret.id, ref: secret.name, updatedAt: secret.updatedAt });
  }
  return byName;
}
