// `omb secrets fetch`: the value goes into one outgoing request on this machine and never into an answer. This file holds what
// needs no Vault or grant: reading the agent's request, injecting the value, sending it, and scrubbing every form of the value
// out of what comes back. Nothing here puts a value, or the URL that carries one, into an error message.
import { EXIT, SecretsError, hasControl } from "./types.ts";

export const FETCH_TIMEOUT_MS = 60_000;
export const FETCH_BODY_MAX = 10 * 1024 * 1024;

const URL_MAX = 8_192;
const HEADER_COUNT_MAX = 50;
const HEADER_VALUE_MAX = 8_192;
const NAME_MAX = 128;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const INJECT_AS = ["bearer", "header", "query", "basic-password"] as const;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Headers the agent cannot set: they steer framing, routing or the encoding of the answer, which must stay readable for scrubbing. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "keep-alive", "proxy-connection", "expect", "accept-encoding"]);
const READABLE_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length"]);
const LATIN1 = /^[^\u{100}-\u{10ffff}]+$/u;
const HEADER_SAFE = /^[ -~ -ÿ]*$/;

export type InjectAs = typeof INJECT_AS[number];

export interface FetchRequest {
  url: URL;
  method: string;
  headers: Array<[string, string]>;
  body?: Buffer;
  inject: { as: InjectAs; name?: string };
}

const invalid = (message: string): SecretsError => new SecretsError(EXIT.invalid, "invalid_request", message);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The lowercase header the injection writes, or null for a query injection. */
export function injectedHeader(inject: FetchRequest["inject"]): string | null {
  if (inject.as === "query") return null;
  return inject.as === "header" ? inject.name!.toLowerCase() : "authorization";
}

/** The request an agent sent, checked. The value is not part of it yet. */
export function parseFetchRequest(body: Record<string, unknown>): FetchRequest {
  if (typeof body.url !== "string" || !body.url || body.url.length > URL_MAX) throw invalid(`url is required and at most ${URL_MAX} characters`);
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    throw invalid("url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalid("url must start with https://");
  if (url.username || url.password) throw invalid("url cannot carry a user name or password; the secret is injected for you");
  url.hash = "";

  const method = body.method === undefined ? "GET" : typeof body.method === "string" ? body.method.toUpperCase() : "";
  if (!METHODS.has(method)) throw invalid(`method must be one of ${[...METHODS].join(", ")}`);

  const headers: Array<[string, string]> = [];
  if (body.headers !== undefined) {
    if (!isObject(body.headers) || Object.keys(body.headers).length > HEADER_COUNT_MAX) throw invalid(`headers must be an object of at most ${HEADER_COUNT_MAX} entries`);
    const seen = new Set<string>();
    for (const [name, value] of Object.entries(body.headers)) {
      const key = name.toLowerCase();
      if (!TOKEN.test(name) || name.length > NAME_MAX) throw invalid("a header name is not valid");
      if (FORBIDDEN_HEADERS.has(key)) throw invalid(`the header ${key} cannot be set`);
      if (seen.has(key)) throw invalid(`the header ${key} is given twice`);
      if (typeof value !== "string" || value.length > HEADER_VALUE_MAX || !HEADER_SAFE.test(value)) throw invalid(`the value of the header ${key} must be printable text of at most ${HEADER_VALUE_MAX} characters`);
      seen.add(key);
      headers.push([name, value]);
    }
  }

  let payload: Buffer | undefined;
  if (body.body !== undefined) {
    if (typeof body.body !== "string" || !BASE64.test(body.body)) throw invalid("body must be base64 text");
    payload = Buffer.from(body.body, "base64");
    if (payload.length && (method === "GET" || method === "HEAD")) throw invalid(`a ${method} request has no body`);
    if (!payload.length) payload = undefined;
  }

  const raw = body.inject === undefined ? { as: "bearer" } : body.inject;
  if (!isObject(raw) || Object.keys(raw).some((key) => key !== "as" && key !== "name")) throw invalid("inject must be { as, name? }");
  if (!INJECT_AS.includes(raw.as as InjectAs)) throw invalid(`inject.as must be one of ${INJECT_AS.join(", ")}`);
  const as = raw.as as InjectAs;
  const name = raw.name;
  if (name !== undefined && (typeof name !== "string" || !name || name.length > NAME_MAX || hasControl(name))) throw invalid("inject.name must be short printable text");
  if (as === "bearer" && name !== undefined) throw invalid("inject.name does not apply to bearer");
  if ((as === "header" || as === "query") && name === undefined) throw invalid(`inject.name is required for ${as}`);
  if (as === "header" && (!TOKEN.test(name!) || FORBIDDEN_HEADERS.has(name!.toLowerCase()))) throw invalid("inject.name is not a header that can carry a secret");
  if (as === "basic-password" && name?.includes(":")) throw invalid("inject.name is the user name of basic authentication and cannot hold a colon");
  const injection = { as, ...(name === undefined ? {} : { name }) };

  const collides = injectedHeader(injection);
  if (collides && headers.some(([header]) => header.toLowerCase() === collides)) throw invalid(`the header ${collides} is written by the injection; remove it from headers`);

  return { url, method, headers, ...(payload ? { body: payload } : {}), inject: injection };
}

/** The host as a grant and a secret name it: a port only when it is not the scheme's own. */
export function hostKey(url: URL): string {
  const host = url.hostname.replace(/\.$/, "");
  return url.port ? `${host}:${url.port}` : host;
}

export function isLoopback(url: URL): boolean {
  const host = url.hostname;
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const urlEncoded = (value: string): string => { const form = new URLSearchParams(); form.set("v", value); return form.toString().slice(2); };

/** The request to send: the value written into the one place the agent chose. A value that cannot be one is refused without being named. */
export function injectSecret(request: FetchRequest, value: string): { url: string; headers: Headers } {
  const headers = new Headers();
  for (const [name, text] of request.headers) headers.set(name, text);
  headers.set("accept-encoding", "identity");
  const url = new URL(request.url);
  const { as, name } = request.inject;
  if (as === "query") {
    url.searchParams.set(name!, value);
  } else if (as === "basic-password") {
    headers.set("authorization", `Basic ${Buffer.from(`${name ?? ""}:${value}`).toString("base64")}`);
  } else {
    // A header value loses its leading and trailing spaces on the wire, so the destination would get another value than the stored one.
    if (!HEADER_SAFE.test(value) || value.endsWith(" ") || (as === "header" && value.startsWith(" "))) {
      throw invalid("the secret cannot be written into a header: it holds a control, non-Latin-1 or boundary space character");
    }
    headers.set(as === "bearer" ? "authorization" : name!, as === "bearer" ? `Bearer ${value}` : value);
  }
  return { url: url.href, headers };
}

const lowerPercent = (text: string): string => text.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());

/** Every form a destination may echo the value in, as the Latin-1 text of its bytes, longest first. The credential of basic authentication is
 * echoed as base64 of `name:value`, so that is covered too. */
export function needlesFor(request: FetchRequest, value: string): string[] {
  const originals = request.inject.as === "basic-password" ? [value, `${request.inject.name ?? ""}:${value}`] : [value];
  const forms = new Set<string>();
  for (const text of originals) {
    const bytes = Buffer.from(text);
    const standard = bytes.toString("base64");
    const url = bytes.toString("base64url");
    const percent = encodeURIComponent(text);
    const form = urlEncoded(text);
    const escaped = JSON.stringify(text).slice(1, -1);
    // A header carries the characters as single bytes, so a destination that echoes one writes the text itself, not its UTF-8 bytes.
    if (LATIN1.test(text)) forms.add(text);
    for (const variant of [text, escaped, standard, standard.replace(/=+$/, ""), url, url.replace(/=+$/, ""), percent, lowerPercent(percent), form, lowerPercent(form), bytes.toString("hex"), bytes.toString("hex").toUpperCase()]) {
      if (variant) forms.add(Buffer.from(variant).toString("latin1"));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

export function scrubText(text: string, needles: readonly string[], replacement: string): string {
  let out = text;
  for (const needle of needles) out = out.split(needle).join(replacement);
  return out;
}

/** The bytes with every form of the value replaced. A body cut at the size cap also loses a trailing piece that starts a form of the value. */
export function scrubBody(body: Buffer, needles: readonly string[], replacement: string, truncated: boolean): Buffer {
  let text = scrubText(body.toString("latin1"), needles, replacement);
  if (truncated) {
    let cut = 0;
    for (const needle of needles) {
      for (let size = Math.min(needle.length - 1, text.length); size > cut; size--) {
        if (text.endsWith(needle.slice(0, size))) { cut = size; break; }
      }
    }
    text = text.slice(0, text.length - cut);
  }
  return Buffer.from(text, "latin1");
}

/** The destination could not be reached or did not answer. Its text is a fixed word or an error code, never the error's own message, which can quote the URL. */
export class UpstreamError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`the destination did not answer (${reason})`);
    this.reason = reason;
  }
}

function reasonOf(error: unknown): string {
  const named = (error as { name?: unknown } | null)?.name;
  if (named === "TimeoutError" || named === "AbortError") return "timeout";
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? code : "network error";
}

export interface Upstream {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
}

/** One request: no redirect followed, a timeout over headers and body, and at most FETCH_BODY_MAX bytes of body read. */
export async function sendUpstream(options: { fetch: typeof fetch; url: string; method: string; headers: Headers; body?: Buffer; timeoutMs: number }): Promise<Upstream> {
  try {
    const response = await options.fetch(options.url, {
      method: options.method, headers: options.headers, redirect: "manual", signal: AbortSignal.timeout(options.timeoutMs),
      ...(options.body ? { body: new Uint8Array(options.body) } : {}),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((text, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = name in headers ? `${headers[name]}, ${text}` : text;
    });
    const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
    if (!READABLE_ENCODINGS.has(encoding)) throw new UpstreamError("unreadable content encoding");
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const reader = response.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (size + chunk.length > FETCH_BODY_MAX) {
        chunks.push(chunk.subarray(0, FETCH_BODY_MAX - size));
        size = FETCH_BODY_MAX;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
    return { status: response.status, headers, body: Buffer.concat(chunks), truncated };
  } catch (error) {
    throw error instanceof UpstreamError ? error : new UpstreamError(reasonOf(error));
  }
}
