import type { Provider } from "../types.ts";

export interface ParsedPrUrl { provider: Provider; repo: string; number: number; url: string }

const GITHUB = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/;
const GITLAB = /^\/([\w./-]+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/;

/**
 * A change request URL as `{ provider, repo, number }`. GitHub means github.com only; GitLab means one of `gitlabHosts`.
 * The repo keeps the case of the URL, and a trailing part (`/files`, `?…`, `#…`) is dropped. Anything else gives null.
 */
export function parsePrUrl(value: string, gitlabHosts: readonly string[]): ParsedPrUrl | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  const host = url.host.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    const match = GITHUB.exec(url.pathname);
    if (!match) return null;
    return finish("github", `${match[1]}/${match[2]}`, match[3]!, host, url);
  }
  if (gitlabHosts.some(allowed => allowed.toLowerCase() === host)) {
    const match = GITLAB.exec(url.pathname);
    if (!match) return null;
    return finish("gitlab", match[1]!, match[2]!, host, url);
  }
  return null;
}

function finish(provider: Provider, repo: string, digits: string, host: string, url: URL): ParsedPrUrl | null {
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const path = provider === "github" ? `${repo}/pull/${number}` : `${repo}/-/merge_requests/${number}`;
  return { provider, repo, number, url: `https://${host === "www.github.com" ? "github.com" : url.host}/${path}` };
}
