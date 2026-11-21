/** The hosts a secret may be sent to, written the same way by the server, the CLI and the Settings form. */

export const ALLOWED_HOSTS_MAX = 20;
export const HOST_NAME_MAX = 255;

/** The host a grant or a secret names: lowercase, a default port and one trailing dot dropped, an internationalized name in
 * ASCII, no scheme, path, user or wildcard. Null when the text is none of that. */
export function normalizeHost(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text || text.length > HOST_NAME_MAX || text.includes("/") || text.includes("@") || text.includes("*") || /\s/.test(text)) return null;
  try {
    const url = new URL(`https://${text}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const host = url.hostname.replace(/\.$/, "");
    const port = url.port && url.port !== "443" && url.port !== "80" ? `:${url.port}` : "";
    return host ? `${host}${port}` : null;
  } catch {
    return null;
  }
}

export type AllowedHostsResult = { ok: true; hosts: string[] } | { ok: false; error: string };

/** A list of host names from a person: each normalized, repeats dropped, none empty. */
export function parseAllowedHosts(raw: readonly string[]): AllowedHostsResult {
  if (raw.length > ALLOWED_HOSTS_MAX) return { ok: false, error: `List at most ${ALLOWED_HOSTS_MAX} hosts.` };
  const hosts: string[] = [];
  for (const entry of raw) {
    const host = normalizeHost(entry);
    if (host === null) return { ok: false, error: `"${entry.trim().slice(0, 60)}" is not a host name. Write one host per line, such as api.example.com, with no https:// and no wildcard.` };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { ok: true, hosts };
}
