const cache = new Map<string, RegExp>();

function compile(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") { source += ".*"; i++; }
      else source += "[^/]*";
    } else source += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  }
  const regex = new RegExp(`^${source}$`, "is");
  cache.set(pattern, regex);
  return regex;
}

/** `*` matches any run of characters except `/`, `**` any run including `/`, case is ignored, and every other character is literal. */
export function globMatch(pattern: string, text: string): boolean {
  return compile(pattern).test(text);
}

export function anyGlob(patterns: readonly string[], text: string): boolean {
  return patterns.some(pattern => globMatch(pattern, text));
}
