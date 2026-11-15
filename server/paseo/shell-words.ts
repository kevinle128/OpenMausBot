/** One word of a command line with its quotes removed. `glob` is true when an unquoted `*`, `?`, `[` or `{` is in it. */
export interface ShellWord {
  text: string;
  glob: boolean;
  /** An unquoted `{`: the shell would multiply this word into several. */
  brace: boolean;
}

const GLOB_CHARS = new Set(["*", "?", "[", "{"]);

/** Splits a command with no shell syntax into words; quotes group words and are removed. Null when a quote is left open. */
export function shellWords(command: string): ShellWord[] | null {
  const out: ShellWord[] = [];
  let current = "";
  let glob = false;
  let brace = false;
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      // Only a space and a tab separate words, as in the shell; any other white space is part of a word.
      if (started) out.push({ text: current, glob, brace });
      current = "";
      glob = false;
      brace = false;
      started = false;
    } else {
      if (GLOB_CHARS.has(char)) glob = true;
      if (char === "{") brace = true;
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push({ text: current, glob, brace });
  return out;
}

/** The words of a command as plain text. */
export function words(command: string): string[] | null {
  return shellWords(command)?.map((word) => word.text) ?? null;
}
