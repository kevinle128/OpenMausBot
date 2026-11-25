#!/usr/bin/env node
// omb: the command line an agent machine uses to reach the Vault of an OpenMausBot server.
// One file, no dependencies, Node 20 or later.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, chmodSync, closeSync, constants as fsConstants, createReadStream, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, hostname, constants as osConstants } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
export const EXIT = { done: 0, invalid: 2, missing: 3, exists: 4, unreachable: 5, refused: 6, pending: 8, limited: 9 };
const KNOWN_EXIT = new Set(Object.values(EXIT));
const KEYCHAIN_SERVICE = "omb-cli";
const MAX_POST_BYTES = 64 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export class CliError extends Error {
  constructor(exitCode, message, errorCode = "") {
    super(message);
    this.exitCode = exitCode;
    this.errorCode = errorCode;
  }
}

const invalid = (message) => new CliError(EXIT.invalid, message, "invalid_request");
const isControl = (code) => code < 32 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
const hasControl = (text) => [...String(text)].some((char) => isControl(char.codePointAt(0)));
const clean = (text, max = 600) => [...String(text ?? "")].slice(0, max).map((char) => (isControl(char.codePointAt(0)) ? " " : char)).join("");

// Arguments

const GLOBAL_FLAGS = { json: "bool", quiet: "bool", verbose: "bool", yes: "bool", "no-interactive": "bool", help: "bool" };
const SHORT = { q: "quiet", V: "verbose", y: "yes", h: "help" };
const SPECS = {
  pair: { server: "value", label: "value", "token-stdin": "bool" },
  status: {},
  fetch: { method: "value", header: "repeat", data: "value", inject: "value", purpose: "value", project: "value", session: "value", include: "bool" },
  run: { env: "repeat", purpose: "value", project: "value", session: "value" },
  request: { purpose: "value", project: "value", session: "value", exec: "value", env: "value" },
  list: {}, describe: {}, get: { reveal: "bool" }, grants: {},
  audit: { secret: "value", since: "value", decision: "value", source: "value", limit: "value", cursor: "value" },
};
const SKILL_SPECS = { list: {}, install: { harness: "repeat", all: "bool" } };
const PERSON_ONLY = ["set", "rotate", "delete", "grant", "revoke", "approve"];

/** `--flag value`, `--flag=value`, repeatable flags in arrays, `--` ends the flags. Unknown flags are exit 2. */
export function parseArgs(tokens, spec) {
  const kinds = { ...GLOBAL_FLAGS, ...spec };
  const flags = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    let name;
    let inline;
    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      inline = eq < 0 ? undefined : token.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(token) && SHORT[token[1]]) {
      name = SHORT[token[1]];
    } else if (token.startsWith("-") && token !== "-") {
      throw invalid(`unknown flag ${clean(token, 40)}`);
    } else {
      positionals.push(token);
      continue;
    }
    const kind = kinds[name];
    if (!kind) throw invalid(`unknown flag --${name}`);
    if (kind === "bool") {
      if (inline !== undefined) throw invalid(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const value = inline ?? tokens[++i];
    if (value === undefined) throw invalid(`--${name} needs a value`);
    if (kind === "repeat") (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, positionals };
}

// Which server may be talked to: https anywhere, plain http only on a private network.

export function isPrivateHost(host) {
  const name = String(host).trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!name) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)?.slice(1).map(Number);
  if (v4) {
    if (v4.some((octet) => octet > 255)) return false;
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (/^\d+(\.\d+){0,3}$/.test(name)) return false;
  if (name.includes(":")) return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
  if (name === "localhost" || [".localhost", ".ts.net", ".local", ".home.arpa"].some((suffix) => name.endsWith(suffix))) return true;
  return !name.includes(".") && /^[a-z0-9-]+$/.test(name);
}

export function allowedServerOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isPrivateHost(url.hostname));
  } catch {
    return false;
  }
}

const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** A 12-character pairing code (typed loosely) or the long `omb_pair_` credential; null for anything else. */
export function readPairingCode(raw) {
  const value = String(raw ?? "").trim();
  if (/^omb_pair_[A-Za-z0-9_-]{43}$/.test(value)) return value;
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/0/g, "O").replace(/1/g, "I");
  if (code.length !== 12 || [...code].some((symbol) => !PAIRING_ALPHABET.includes(symbol))) return null;
  return code.match(/.{4}/g).join("-");
}

/** `{ origin, secret }` from a link such as https://host/pair#code=XXXX-XXXX-XXXX, or a bare code with `--server`. */
export function readPairingTarget(input, serverFlag) {
  const text = String(input ?? "").trim();
  if (!text) throw invalid("give the pairing link or code from OpenMausBot: omb pair <link-or-code> [--server URL]");
  if (text.startsWith("omb_sess_")) throw invalid("that is a token, not a pairing code; pipe it in with omb pair --token-stdin --server URL");
  let origin = null;
  let secret = readPairingCode(text);
  if (secret === null) {
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw invalid("that is not a pairing link or code");
    }
    if (!["", "/", "/pair", "/pair/"].includes(url.pathname)) throw invalid("that is not a pairing link: it should end in /pair#code=...");
    const carried = /(?:^|[#&])code=([^&]*)/.exec(url.hash)?.[1] ?? url.searchParams.get("code") ?? "";
    let decoded = carried;
    try { decoded = decodeURIComponent(carried); } catch { /* keep the raw text; the reader below refuses it */ }
    secret = readPairingCode(decoded);
    if (secret === null) throw invalid("the link carries no usable pairing code");
    origin = url.origin;
  }
  if (serverFlag !== undefined) origin = checkedOrigin(serverFlag);
  if (origin === null) throw invalid("a code alone does not name a server: add --server URL");
  return { origin: checkedOrigin(origin), secret };
}

export function checkedOrigin(input) {
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(input)) ? String(input) : `https://${input}`);
  } catch {
    throw invalid(`${clean(input, 80)} is not a server address`);
  }
  if (!["", "/"].includes(url.pathname) || url.search || url.hash) throw invalid("the server address is the origin only, like https://maus.example.com");
  if (!allowedServerOrigin(url.origin)) throw invalid(`${url.origin} is not allowed: use https, or http on a private network such as the tailnet`);
  return url.origin;
}

// Where the server address and the token live.

export function configDir(env, home) {
  return env.OMB_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "omb");
}

function writeAtomic(path, text, mode, dirMode = 0o700) {
  mkdirSync(dirname(path), { recursive: true, mode: dirMode });
  const temp = `${path}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  try {
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

const keychainOn = (d) => d.platform === "darwin" && d.env.OMB_TOKEN_STORE !== "file";

/** The token never goes on a command line: `security -i` reads the command from stdin. */
async function keychainSet(d, account, token) {
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(token) || !/^[A-Za-z0-9.:/[\]_-]+$/.test(account)) throw new Error("token or address has characters the keychain command cannot carry safely");
  await d.security(["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${token}\n`);
  const back = (await d.security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])).trim();
  if (back !== token) throw new Error("the keychain did not keep the token");
}

async function saveCredentials(d, origin, token, session) {
  const dir = configDir(d.env, d.home);
  let store = "file";
  if (keychainOn(d)) {
    try {
      await keychainSet(d, origin, token);
      store = "keychain";
    } catch (error) {
      d.stderr.write(`omb: the macOS keychain is not available (${clean(error?.code ?? "error", 60)}); keeping the token in a file only you can read\n`);
    }
  }
  if (store === "file") writeAtomic(join(dir, "token"), `${token}\n`, 0o600);
  else rmSync(join(dir, "token"), { force: true });
  const config = { schema_version: 1, server: origin, scope: "secrets", store, sessionId: session?.id ?? null, expiresAt: session?.expiresAt ?? null, pairedAt: new Date().toISOString() };
  writeAtomic(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, 0o600);
  return config;
}

async function loadCredentials(d) {
  const dir = configDir(d.env, d.home);
  let config;
  try {
    config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    throw new CliError(EXIT.unreachable, "this machine is not paired with an OpenMausBot server. Ask the person for a pairing link, then run: omb pair <link>", "store_unavailable");
  }
  if (typeof config?.server !== "string" || !allowedServerOrigin(config.server)) throw new CliError(EXIT.unreachable, `${join(dir, "config.json")} does not hold a usable server address: pair again`, "store_unavailable");
  let token = "";
  try {
    token = config.store === "keychain"
      ? (await d.security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", config.server, "-w"])).trim()
      : readFileSync(join(dir, "token"), "utf8").trim();
  } catch { /* reported below */ }
  if (!token) throw new CliError(EXIT.unreachable, "the stored token cannot be read: pair again with omb pair <link>", "store_unavailable");
  return { server: config.server, token, config };
}

// The server: envelope and failure mapping.

function interpret(status, json) {
  if (json && typeof json === "object" && json.schema_version === 1 && typeof json.error === "string" && Number.isInteger(json.exit_code)) {
    throw new CliError(KNOWN_EXIT.has(json.exit_code) ? json.exit_code : EXIT.unreachable, clean(json.error), clean(json.error_code, 60));
  }
  if (status === 401) throw new CliError(EXIT.unreachable, "the token ended or was revoked: pair again with omb pair <link>", "store_unavailable");
  if (status === 403) throw new CliError(EXIT.refused, clean(json?.error) || "refused by the server", "blocked");
  if (status < 200 || status >= 300) throw new CliError(EXIT.unreachable, `the server answered HTTP ${status} without a result`, "store_unavailable");
  if (!json || json.schema_version !== 1 || !("data" in json)) throw new CliError(EXIT.unreachable, "the server's answer is not an omb envelope", "store_unavailable");
  return json;
}

/** No redirects, no retries: a repeated POST could spend a single-release grant or trip the rate limit. */
async function call(d, creds, method, path, body, timeoutMs = 30_000) {
  const headers = { authorization: `Bearer ${creds.token}`, accept: "application/json" };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_POST_BYTES) throw invalid("the request is larger than the server accepts (64 KiB)");
    headers["content-type"] = "application/json";
  }
  let response;
  let text;
  try {
    response = await d.fetch(`${creds.server}${path}`, { method, headers, body: payload, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    text = await response.text();
  } catch (error) {
    const reason = clean(error?.cause?.code ?? error?.name ?? "error", 60);
    throw new CliError(EXIT.unreachable, `cannot reach ${creds.server} (${reason}). Nothing was released and no program was started`, "store_unavailable");
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: interpret decides */ }
  return interpret(response.status, json);
}

const WORDS = {
  [EXIT.refused]: " This is settled: do not retry. Continue without it.",
  [EXIT.limited]: " Do not retry. Tell the person that this secret is unavailable for now.",
};

function pendingText(refs, serverText) {
  const list = refs.join(", ");
  const notices = refs.map((ref) => `"already approved omb secrets: ${ref}"`).join(" or ");
  return `approval pending for ${list}.${serverText ? ` ${serverText}` : ""}\n`
    + "A card is waiting in OpenMausBot. Do not retry in a loop and do not try to approve it yourself.\n"
    + `Wait for the notice ${notices}, then run the same command again. If no notice comes, tell the person that omb secrets ${list} needs an answer in OpenMausBot.`;
}

// Who is asking: the agent binary above this process, found by walking the parent chain.

const RUNTIMES = /^(node|nodejs|bun|deno|python\d*(\.\d+)*)$/i;
// Cursor CLI 2026.11: its launcher starts the bundled Node with `exec -a "$0"`, so `ps` shows that Node under the launcher's name.
// Such a process counts only through the script it hosts, never through the launcher or the bundled Node.
const RENAMED_RUNTIMES = /^(cursor-agent|agent)$/;
const MAX_WALK = 40;

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function procfsDescribe(procRoot, pid) {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    let path = null;
    try { path = readlinkSync(join(procRoot, String(pid), "exe")).replace(/ \(deleted\)$/, ""); } catch { /* kernel threads and other users' processes */ }
    return { ppid, path, args: async () => readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean) };
  } catch {
    return null;
  }
}

async function psDescribe(ps, pid) {
  let line;
  try {
    line = await ps(["-o", "ppid=,comm=", "-p", String(pid)]);
  } catch {
    return null;
  }
  const found = /^\s*(\d+)\s+(.+?)\s*$/s.exec(line);
  if (!found) return null;
  return { ppid: Number(found[1]), path: found[2], args: async () => (await ps(["-ww", "-o", "args=", "-p", String(pid)])).trim().split(/\s+/) };
}

async function matchAgent(path, args) {
  const base = basename(path ?? "").replace(/\.exe$/i, "");
  if (!RENAMED_RUNTIMES.test(base)) {
    const named = AGENTS.find((agent) => agent.bin.test(base) || agent.path?.test(path ?? ""));
    if (named) return { agent: named.name, target: path };
    if (!RUNTIMES.test(base)) return null;
  }
  const argv = await args().catch(() => []);
  // Only the runtime's entrypoint counts, never the arguments it passes on to its script.
  const script = argv.slice(1).find((token) => !token.startsWith("-"));
  // The agent's own script is what is hashed: a new Node release must not end its grants, and two Node tools must not share one.
  if (!script || !script.startsWith("/") || !isFile(script)) return null;
  const hosted = AGENTS.find((agent) => agent.path?.test(script) || agent.bin.test(basename(script).replace(/\.(?:c|m)?js$/, "")));
  return hosted ? { agent: hosted.name, target: script } : null;
}

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** `{ name, fingerprint, path }` of the nearest agent above `startPid`, or null. The fingerprint is `sha256:<hex>` of its file. */
export async function findAgent({ platform, ps, procRoot = "/proc", startPid, hashFile = sha256File }) {
  if (platform === "win32") return null;
  const useProc = platform === "linux";
  const seen = new Set();
  let pid = startPid;
  for (let depth = 0; depth < MAX_WALK && Number.isInteger(pid) && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const info = useProc ? procfsDescribe(procRoot, pid) : await psDescribe(ps, pid);
    if (!info) return null;
    const hit = info.path ? await matchAgent(info.path, info.args) : null;
    if (hit?.target) {
      let real = hit.target;
      try { real = realpathSync(hit.target); } catch { /* an unreadable path fails the hash below */ }
      try {
        return { name: hit.agent, fingerprint: await hashFile(real), path: real };
      } catch {
        return null;
      }
    }
    pid = info.ppid;
  }
  return null;
}

async function needIdentity(ctx) {
  const { d } = ctx;
  const found = await findAgent({ platform: d.platform, ps: d.ps, procRoot: d.procRoot, startPid: d.ppid });
  if (!found) {
    throw new CliError(EXIT.refused, `no known agent (${AGENTS.map((agent) => agent.name).join(", ")}) was found above this process, so this command cannot say who is asking. Run it from an agent session`, "blocked");
  }
  return found;
}

function askerFields(ctx, identity, flags) {
  const { env } = ctx.d;
  const purpose = flags.purpose;
  const project = flags.project;
  if (purpose !== undefined && purpose.length > 200) throw invalid("--purpose is at most 200 characters");
  if (project !== undefined && (project.length === 0 || project.length > 512)) throw invalid("--project is 1 to 512 characters");
  const fields = { fingerprint: identity.fingerprint, agentLabel: identity.name, cwd: env.PASEO_AGENT_CWD || ctx.d.cwd() };
  if (env.PASEO_AGENT_ID) fields.agentId = env.PASEO_AGENT_ID;
  if (purpose !== undefined) fields.purpose = purpose;
  if (project !== undefined) fields.project = project;
  if (flags.session !== undefined) fields.session = flags.session;
  return fields;
}

const checkRef = (ref) => {
  if (!ref || !REF.test(ref)) throw invalid(`${clean(ref, 40) || "(nothing)"} is not a secret name: letters, digits, _ . - and at most 128 characters, starting with a letter or digit`);
  return ref;
};

// Programs `run` and `request --exec` may pin.

const SHELLS = ["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "csh", "tcsh", "fish", "pwsh", "powershell", "cmd", "rbash", "busybox", "toybox"];
const LAUNCHERS = [
  "env", "sudo", "doas", "su", "runuser", "xargs", "nohup", "nice", "ionice", "timeout", "time", "exec", "command", "builtin", "setsid", "stdbuf",
  "chroot", "strace", "ltrace", "watch", "script", "screen", "tmux", "nsenter", "unshare", "flock", "taskset", "chrt", "numactl", "parallel",
  "arch", "caffeinate", "open", "osascript", "sg", "newgrp", "eval",
];
const REFUSED_PROGRAMS = new Set([...SHELLS, ...LAUNCHERS]);

const REFUSED_VARS = [
  /^(?:LD_|DYLD_)/i,
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TERM|LANG|LANGUAGE|PWD|OLDPWD|IFS|TZ)$/i, /^LC_/i,
  /^NODE_(?:OPTIONS|PATH|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED|REPL_|PENDING_DEPRECATION|ICU_DATA|V8_COVERAGE)/i, /^npm_config_(?:registry|prefix|userconfig|globalconfig|script_shell|node_options|cache)$/i,
  /^PYTHON(?:PATH|HOME|STARTUP|USERBASE|EXECUTABLE|BREAKPOINT|INSPECT)$/i, /^(?:RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|PERL5OPT|PERL5LIB|PERLLIB)$/i,
  /^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JAVA_HOME|CLASSPATH|GOFLAGS|GOPROXY|GOROOT|CARGO_HOME|RUSTC_WRAPPER)$/i,
  /^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE)$/i, /^BASH_FUNC_/i,
  /^(?:http|https|all|ftp|no|socks[45]?)_proxy$/i, /^(?:SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|CURL_HOME)$/i,
  /^GIT_(?:SSH|SSH_COMMAND|EXEC_PATH|ASKPASS|PROXY_COMMAND|CONFIG_COUNT|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|TEMPLATE_DIR)$/i,
  /^[A-Z0-9_]*_ENDPOINT_URL(?:_[A-Z0-9_]+)?$/i,
];
const KEPT_ENV = /^(?:HOME|USER|LOGNAME|LANG|LANGUAGE|TERM|TMPDIR|TZ|COLORTERM|NO_COLOR|LC_[A-Z_]+)$/;
const CHILD_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(delimiter);

export function checkEnvVar(name) {
  if (!VAR_NAME.test(name)) throw invalid(`${clean(name, 40)} is not an environment variable name`);
  if (REFUSED_VARS.some((rule) => rule.test(name))) throw invalid(`${name} steers a loader, a runtime or a network endpoint: it cannot carry a secret`);
  return name;
}

function locate(name, env, cwd) {
  const candidates = name.includes("/") ? [resolve(cwd, name)] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(resolve(cwd, dir), name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* try the next directory */ }
  }
  throw invalid(`program ${clean(name, 80)} was not found or cannot be run`);
}

function shebangInterpreter(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(160);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, size).toString("latin1").split("\n")[0];
    const found = /^#!\s*(\S+)/.exec(line);
    return found ? basename(found[1]).toLowerCase() : null;
  } finally {
    closeSync(fd);
  }
}

/** The program as the grant names it: path with symbolic links followed, and the hash of its content. Shells and launchers are refused. */
export async function pinProgram(name, env, cwd) {
  const found = locate(name, env, cwd);
  const real = realpathSync(found);
  for (const candidate of [basename(name), basename(real)]) {
    if (REFUSED_PROGRAMS.has(candidate.toLowerCase().replace(/\.exe$/, ""))) throw invalid(`${candidate} is a shell or a launcher: name the program itself, not what starts programs`);
  }
  const interpreter = shebangInterpreter(real);
  if (interpreter && REFUSED_PROGRAMS.has(interpreter)) throw invalid(`${basename(real)} starts through ${interpreter} (its #! line): name the real interpreter, like /usr/bin/python3 script.py`);
  return { path: real, hash: await sha256File(real) };
}

// Scrubbing: every form of a value in a program's output becomes [omb:REF]. Works on bytes, holds back only a tail
// that could still grow into a match, and releases it with the next output or at the end.

const UNRESERVED = /[A-Za-z0-9\-._~]/;

export function valueForms(value) {
  const raw = Buffer.from(String(value), "utf8");
  if (raw.length === 0) return [];
  const strict = [...raw].map((byte) => (UNRESERVED.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
  const percent = [encodeURIComponent(String(value)), strict];
  const texts = [
    raw.toString("base64").replace(/=+$/, ""), raw.toString("base64url"), raw.toString("hex"), raw.toString("hex").toUpperCase(),
    ...percent.flatMap((form) => [form, form.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()), form.replace(/%20/g, "+"), form.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()).replace(/%20/g, "+")]),
  ];
  const seen = new Set();
  const forms = [];
  for (const bytes of [raw, ...texts.map((text) => Buffer.from(text, "latin1"))]) {
    const key = bytes.toString("hex");
    if (bytes.length > 0 && !seen.has(key)) {
      seen.add(key);
      forms.push(bytes);
    }
  }
  return forms;
}

export function createScrubber(secrets) {
  const forms = [];
  const seen = new Set();
  for (const { ref, value } of secrets) {
    const label = Buffer.from(`[omb:${ref}]`);
    for (const bytes of valueForms(value)) {
      const key = bytes.toString("hex");
      if (!seen.has(key)) {
        seen.add(key);
        forms.push({ bytes, label });
      }
    }
  }
  forms.sort((a, b) => b.bytes.length - a.bytes.length);
  const longest = forms[0]?.bytes.length ?? 0;
  let held = Buffer.alloc(0);

  const partialStart = (buf, from) => {
    for (let at = Math.max(from, buf.length - (longest - 1)); at < buf.length; at++) {
      const rest = buf.length - at;
      for (const form of forms) if (form.bytes.length > rest && form.bytes.compare(buf, at, buf.length, 0, rest) === 0) return at;
    }
    return -1;
  };

  function scrub(buf, final) {
    const out = [];
    let pos = 0;
    for (;;) {
      let match = null;
      for (const form of forms) {
        const at = buf.indexOf(form.bytes, pos);
        if (at >= 0 && (!match || at < match.at)) match = { at, form };
      }
      const partial = final ? -1 : partialStart(buf, pos);
      if (match && (partial < 0 || match.at < partial)) {
        out.push(buf.subarray(pos, match.at), match.form.label);
        pos = match.at + match.form.bytes.length;
        continue;
      }
      if (partial >= 0) {
        out.push(buf.subarray(pos, partial));
        held = Buffer.from(buf.subarray(partial));
      } else {
        out.push(buf.subarray(pos));
        held = Buffer.alloc(0);
      }
      return Buffer.concat(out);
    }
  }

  return {
    push: (chunk) => scrub(Buffer.concat([held, chunk]), false),
    end: () => {
      const rest = scrub(held, true);
      held = Buffer.alloc(0);
      return rest;
    },
  };
}

// Output

function emit(ctx, kind, data, lines) {
  const { d } = ctx;
  if (ctx.json) d.stdout.write(`${JSON.stringify({ schema_version: 1, kind, data })}\n`);
  else if (!ctx.quiet) d.stdout.write(`${lines.join("\n")}\n`);
}

function profileLines(row) {
  const profile = row.profile && typeof row.profile === "object" ? row.profile : {};
  const lines = [];
  for (const [key, value] of Object.entries(profile)) lines.push(`  ${key}: ${clean(Array.isArray(value) ? value.join(", ") : value)}`);
  return lines;
}

function rowLine(row) {
  const notes = [row.hint ? `hint ${clean(row.hint, 40)}` : `no hint (${clean(row.hintReason, 40) || "none"})`, row.needsRotation ? "needs rotation" : null].filter(Boolean);
  return `${clean(row.ref, 130)}  ${notes.join(", ")}${row.profile?.description ? `  ${clean(row.profile.description, 120)}` : ""}`;
}

const secretsError = (command, message) => new CliError(EXIT.refused, `${command === "this" ? "this command" : command} is done by the person in the OpenMausBot app (the Vault settings), not from the command line. ${message}`, "blocked");

async function readStream(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw invalid("input from stdin is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Commands

async function cmdPair(ctx, parsed) {
  const { d } = ctx;
  const { flags, positionals } = parsed;
  const label = clean(flags.label ?? `omb ${hostname()}`, 80) || "omb";
  let origin;
  let token;
  let session = null;
  if (flags["token-stdin"]) {
    if (positionals.length > 0) throw invalid("--token-stdin takes no link or code");
    if (flags.server === undefined) throw invalid("--token-stdin needs --server URL");
    if (d.stdinIsTTY) throw invalid("pipe the token in: openmausbot token create NAME --scope secrets --out F, then omb pair --token-stdin --server URL < F");
    origin = checkedOrigin(flags.server);
    token = (await readStream(d.stdin, 4096)).toString("utf8").trim();
    if (!/^[A-Za-z0-9._~+/=-]{8,512}$/.test(token)) throw invalid("stdin does not hold a token");
    const creds = { server: origin, token };
    await call(d, creds, "GET", "/api/secrets/list", undefined, 15_000);
    let strong = false;
    try {
      await call(d, creds, "GET", "/api/secrets/admin/grants", undefined, 15_000);
      strong = true;
    } catch (error) {
      if (!(error instanceof CliError) || error.exitCode !== EXIT.refused) throw error;
    }
    if (strong) throw new CliError(EXIT.refused, "this token can also use the admin routes. An agent machine takes a token with the secrets scope only: make one with openmausbot token create NAME --scope secrets", "blocked");
  } else {
    if (positionals.length !== 1) throw invalid("give the pairing link or code from OpenMausBot: omb pair <link-or-code> [--server URL]");
    const target = readPairingTarget(positionals[0], flags.server);
    origin = target.origin;
    const creds = { server: origin, token: "" };
    let response;
    let text;
    try {
      response = await d.fetch(`${origin}/api/auth/pair`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code: target.secret, label }),
      });
      text = await response.text();
    } catch (error) {
      throw new CliError(EXIT.unreachable, `cannot reach ${creds.server} (${clean(error?.cause?.code ?? error?.name, 60)}). Nothing was stored`, "store_unavailable");
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (response.status !== 200 || typeof json?.token !== "string") {
      throw new CliError(EXIT.unreachable, `the pairing code was not accepted${typeof json?.error === "string" ? `: ${clean(json.error)}` : ` (HTTP ${response.status})`}. A code works once and runs out: ask for a new one`, "store_unavailable");
    }
    token = json.token;
    session = json.session ?? null;
    const scopes = session?.scopes;
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== "secrets") {
      // A server that does not know the scope opens its default one: end that session instead of keeping it.
      // Logout ends the caller's own session for a client scope; an admin-only session needs the sessions route.
      const end = (method, route) => d.fetch(`${origin}${route}`, { method, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${token}` } })
        .then((answer) => answer.ok, () => false);
      let ended = await end("POST", "/api/auth/logout");
      if (!ended && typeof session?.id === "string") ended = await end("DELETE", `/api/auth/sessions/${encodeURIComponent(session.id)}`);
      const fate = ended ? "so it was ended" : "and it could not be ended: end it in OpenMausBot";
      throw new CliError(EXIT.refused, `the pairing code did not open a secrets-only session, ${fate}, and nothing was stored. Ask for a code made with the secrets scope (openmausbot token create NAME --scope secrets) and update OpenMausBot on the server`, "blocked");
    }
  }
  const saved = await saveCredentials(d, origin, token, session);
  const until = typeof saved.expiresAt === "number" ? new Date(saved.expiresAt).toISOString().slice(0, 10) : "the date the server set";
  emit(ctx, "pair", { server: origin, scope: "secrets", store: saved.store, expiresAt: saved.expiresAt }, [
    `Paired with ${origin} (secrets scope, until ${until}). The token is kept in ${saved.store === "keychain" ? "the macOS keychain" : join(configDir(d.env, d.home), "token")}.`,
    "Check it with: omb status",
  ]);
  return EXIT.done;
}

async function cmdStatus(ctx, { positionals }) {
  if (positionals.length > 0) throw invalid("usage: omb status");
  const { d } = ctx;
  const creds = await loadCredentials(d);
  let reachable = false;
  let accepted = false;
  let problem = null;
  try {
    await call(d, creds, "GET", "/api/secrets/list", undefined, 10_000);
    reachable = true;
    accepted = true;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    problem = error.message;
    reachable = !error.message.startsWith("cannot reach ");
  }
  const agent = await findAgent({ platform: d.platform, ps: d.ps, procRoot: d.procRoot, startPid: d.ppid });
  const data = {
    server: creds.server, scope: creds.config.scope ?? "secrets", store: creds.config.store, expiresAt: creds.config.expiresAt ?? null,
    reachable, tokenAccepted: accepted, problem, agent: agent ? { label: agent.name, fingerprint: agent.fingerprint } : null,
  };
  emit(ctx, "status", data, [
    `server: ${data.server}`,
    `scope: ${data.scope}`,
    `token: kept in ${data.store}${typeof data.expiresAt === "number" ? `, until ${new Date(data.expiresAt).toISOString().slice(0, 10)}` : ""}`,
    `reachable: ${reachable ? "yes" : "no"}${accepted ? ", token accepted" : problem ? ` (${problem})` : ""}`,
    `agent: ${agent ? `${agent.name} ${agent.fingerprint.slice(0, 19)}...` : "none found above this process"}`,
  ]);
  return accepted ? EXIT.done : EXIT.unreachable;
}

function parseHeaders(list) {
  const headers = {};
  for (const item of list ?? []) {
    const at = item.indexOf(":");
    const name = at > 0 ? item.slice(0, at).trim() : "";
    const value = at > 0 ? item.slice(at + 1).trim() : "";
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw invalid(`--header needs Name: value, got ${clean(item, 40)}`);
    if (hasControl(value)) throw invalid(`the value of header ${name} holds a control character`);
    if (Object.keys(headers).some((one) => one.toLowerCase() === name.toLowerCase())) throw invalid(`header ${name} is given twice`);
    headers[name] = value;
  }
  return headers;
}

function parseInject(text) {
  if (text === undefined) return undefined;
  if (text === "bearer" || text === "basic-password") return { as: text };
  const found = /^(header|query):(.+)$/.exec(text);
  if (!found) throw invalid("--inject is bearer, header:NAME, query:NAME or basic-password");
  const name = found[2];
  if (found[1] === "header" ? !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) : /[\s&=#%]/.test(name) || hasControl(name)) throw invalid(`${clean(name, 40)} is not a usable ${found[1]} name`);
  return { as: found[1], name };
}

function checkFetchUrl(text) {
  let url;
  try { url = new URL(text); } catch { throw invalid("the URL cannot be read: give a full https:// address"); }
  if (url.username || url.password) throw invalid("the URL must not carry a user name or password");
  const local = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw invalid("only https is allowed (http only to localhost)");
  return url.href;
}

async function cmdFetch(ctx, { flags, positionals }) {
  const { d } = ctx;
  if (positionals.length !== 2) throw invalid("usage: omb secrets fetch <ref> <url> [--method M] [--header 'Name: value'] [--data @file|-] [--inject bearer|header:NAME|query:NAME|basic-password] [--purpose P] [--project X] [--include] [--json]");
  const ref = checkRef(positionals[0]);
  ctx.refs = [ref];
  const url = checkFetchUrl(positionals[1]);
  const method = (flags.method ?? "GET").toUpperCase();
  if (!/^[A-Z]{3,10}$/.test(method)) throw invalid(`${clean(method, 20)} is not an HTTP method`);
  const headers = parseHeaders(flags.header);
  const inject = parseInject(flags.inject);
  const collides = inject?.as === "header" ? inject.name.toLowerCase() : inject?.as === "query" ? null : "authorization";
  if (collides && Object.keys(headers).some((name) => name.toLowerCase() === collides)) throw invalid(`the ${collides} header is where the secret goes: remove --header ${collides}`);
  let body;
  if (flags.data !== undefined) {
    if (flags.data === "-") body = await readStream(d.stdin, MAX_POST_BYTES);
    else if (flags.data.startsWith("@")) {
      try { body = readFileSync(flags.data.slice(1)); } catch (error) { throw invalid(`--data file cannot be read (${error?.code ?? "error"})`); }
    } else body = Buffer.from(flags.data, "utf8");
  }
  const identity = await needIdentity(ctx);
  const creds = await loadCredentials(d);
  const request = { ref, url, method, ...askerFields(ctx, identity, flags) };
  if (Object.keys(headers).length > 0) request.headers = headers;
  if (body !== undefined) request.body = body.toString("base64");
  if (inject) request.inject = inject;
  const envelope = await call(d, creds, "POST", "/api/secrets/fetch", request, 90_000);
  const data = envelope.data;
  if (!data || !Number.isInteger(data.status) || typeof data.body !== "string" || (data.headers !== undefined && typeof data.headers !== "object")) {
    throw new CliError(EXIT.unreachable, "the server's fetch answer has an unexpected shape", "store_unavailable");
  }
  if (ctx.json) {
    d.stdout.write(`${JSON.stringify({ schema_version: 1, kind: "secrets.fetch", data: { status: data.status, headers: data.headers ?? {}, body: data.body, truncated: data.truncated === true } })}\n`);
  } else {
    if (flags.include) {
      const lines = Object.entries(data.headers ?? {}).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((one) => `${clean(name, 80)}: ${clean(one, 2000)}`));
      d.stdout.write(`HTTP ${data.status}\n${lines.join("\n")}${lines.length ? "\n" : ""}\n`);
    }
    d.stdout.write(Buffer.from(data.body, "base64"));
    if (data.truncated === true) d.stderr.write("secrets fetch: the response was cut at the size limit\n");
    if (data.status >= 400 && !ctx.quiet) d.stderr.write(`secrets fetch: the other side answered HTTP ${data.status}\n`);
  }
  return EXIT.done;
}

function parseEnvSpecs(list) {
  if (!list || list.length === 0) throw invalid("name at least one --env VAR=REF");
  if (list.length > 16) throw invalid("at most 16 --env pairs");
  const specs = [];
  for (const item of list) {
    const at = item.indexOf("=");
    if (at < 1) throw invalid(`--env needs VAR=REF, got ${clean(item, 40)}`);
    const name = checkEnvVar(item.slice(0, at));
    if (specs.some((one) => one.var === name)) throw invalid(`${name} is named twice`);
    specs.push({ var: name, ref: checkRef(item.slice(at + 1)) });
  }
  return specs;
}

function childEnv(d, granted) {
  const env = { PATH: CHILD_PATH };
  for (const [name, value] of Object.entries(d.env)) if (KEPT_ENV.test(name) && typeof value === "string") env[name] = value;
  for (const { var: name, value } of granted) env[name] = value;
  return env;
}

function relay(stream, sink, scrubber) {
  return new Promise((done) => {
    stream.on("data", (chunk) => {
      const out = scrubber.push(chunk);
      if (out.length > 0 && sink.write(out) === false) {
        stream.pause();
        sink.once("drain", () => stream.resume());
      }
    });
    stream.on("end", () => {
      const out = scrubber.end();
      if (out.length > 0) sink.write(out);
      done();
    });
    stream.on("error", done);
  });
}

async function cmdRun(ctx, { flags, positionals }) {
  const { d } = ctx;
  const [program, ...args] = positionals;
  if (!program) throw invalid("name the program after --: omb secrets run --env VAR=REF -- <program> [args]");
  const specs = parseEnvSpecs(flags.env);
  ctx.refs = [...new Set(specs.map((one) => one.ref))];
  const identity = await needIdentity(ctx);
  const pinned = await pinProgram(program, d.env, d.cwd());
  const creds = await loadCredentials(d);
  const envelope = await call(d, creds, "POST", "/api/secrets/run-check", {
    ...askerFields(ctx, identity, flags), scopes: specs.map((one) => ({ var: one.var, ref: one.ref, program: { path: pinned.path, hash: pinned.hash } })),
  });
  const values = Array.isArray(envelope.data?.values) ? envelope.data.values : [];
  const granted = specs.map((spec) => {
    const found = values.find((one) => one?.var === spec.var && one?.ref === spec.ref);
    if (typeof found?.value !== "string" || found.value.length === 0) throw new CliError(EXIT.unreachable, `the server did not release a value for ${spec.var}. The program was not started`, "store_unavailable");
    return { var: spec.var, ref: spec.ref, value: found.value };
  });
  if (await sha256File(pinned.path) !== pinned.hash) throw new CliError(EXIT.refused, `${pinned.path} changed after the check. The program was not started`, "blocked");
  // Node quotes an invalid environment value in its own error, so a value it cannot carry is refused without that message.
  if (granted.some(({ value }) => value.includes("\0"))) throw new CliError(EXIT.unreachable, "a released value holds a character an environment cannot carry. The program was not started", "store_unavailable");
  let child;
  try {
    child = spawn(pinned.path, args, { argv0: basename(program), env: childEnv(d, granted), cwd: d.cwd(), stdio: ["inherit", "pipe", "pipe"], shell: false, windowsHide: true });
  } catch (error) {
    throw new CliError(EXIT.unreachable, `${pinned.path} did not start (${clean(error?.code ?? "error", 60)})`, "store_unavailable");
  }
  const forwards = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const handler = () => { try { child.kill(signal); } catch { /* already gone */ } };
    d.proc.on(signal, handler);
    return [signal, handler];
  });
  const secrets = granted.map(({ ref, value }) => ({ ref, value }));
  const relays = Promise.all([relay(child.stdout, d.stdout, createScrubber(secrets)), relay(child.stderr, d.stderr, createScrubber(secrets))]);
  const outcome = await new Promise((done) => {
    child.once("error", (error) => done({ failed: error }));
    child.once("close", (code, signal) => done({ code, signal }));
  });
  for (const [signal, handler] of forwards) d.proc.off(signal, handler);
  if (outcome.failed) throw new CliError(EXIT.unreachable, `${pinned.path} did not start (${clean(outcome.failed.code ?? "error", 60)})`, "store_unavailable");
  await relays;
  if (typeof outcome.code === "number") return outcome.code;
  return 128 + (osConstants.signals[outcome.signal] ?? 1);
}

async function cmdRequest(ctx, { flags, positionals }) {
  const { d } = ctx;
  if (positionals.length !== 1) throw invalid("usage: omb secrets request <ref> [--purpose P] [--project X] [--exec PROGRAM --env VAR]");
  const ref = checkRef(positionals[0]);
  ctx.refs = [ref];
  if ((flags.exec === undefined) !== (flags.env === undefined)) throw invalid("--exec and --env go together");
  const body = {};
  if (flags.exec !== undefined) {
    body.env = checkEnvVar(flags.env);
    const pinned = await pinProgram(flags.exec, d.env, d.cwd());
    body.exec = { path: pinned.path, hash: pinned.hash };
  }
  const identity = await needIdentity(ctx);
  const creds = await loadCredentials(d);
  const envelope = await call(d, creds, "POST", "/api/secrets/request", { ref, ...askerFields(ctx, identity, flags), ...body });
  const status = envelope.data?.status;
  if (!["covered", "pending", "granted"].includes(status)) throw new CliError(EXIT.unreachable, "the server's request answer has an unexpected shape", "store_unavailable");
  const lines = {
    covered: [`${ref} is already covered: nothing to wait for.`],
    pending: pendingText([ref], "").split("\n"),
    granted: [`OpenMausBot approved ${ref} at once.`, `Wait for the notice "already approved omb secrets: ${ref}", then run the command that needs it.`],
  }[status];
  emit(ctx, "secrets.request", envelope.data, lines);
  return EXIT.done;
}

async function cmdList(ctx, { positionals }) {
  if (positionals.length > 0) throw invalid("usage: omb secrets list");
  const creds = await loadCredentials(ctx.d);
  const { data } = await call(ctx.d, creds, "GET", "/api/secrets/list");
  if (!Array.isArray(data)) throw new CliError(EXIT.unreachable, "the server's list has an unexpected shape", "store_unavailable");
  emit(ctx, "secrets.list", data, data.length ? data.map(rowLine) : ["The Vault holds no secret this token may see."]);
  return EXIT.done;
}

async function cmdDescribe(ctx, { positionals }, kind) {
  if (positionals.length !== 1) throw invalid(`usage: omb secrets ${kind} <ref>`);
  const ref = checkRef(positionals[0]);
  const creds = await loadCredentials(ctx.d);
  const { data } = await call(ctx.d, creds, "GET", `/api/secrets/${kind}/${encodeURIComponent(ref)}`);
  if (!data || typeof data.ref !== "string") throw new CliError(EXIT.unreachable, `the server's ${kind} answer has an unexpected shape`, "store_unavailable");
  const lines = [rowLine(data), ...profileLines(data)];
  if (data.notice) lines.push(clean(data.notice, 400));
  emit(ctx, `secrets.${kind}`, data, lines);
  return EXIT.done;
}

async function cmdReveal(ctx, { positionals }) {
  if (positionals.length !== 1) throw invalid("usage: omb secrets get <ref> --reveal");
  const ref = checkRef(positionals[0]);
  const { d } = ctx;
  if (!d.stdinIsTTY || !d.stdoutIsTTY) {
    throw new CliError(EXIT.refused, "revealing a secret requires an interactive terminal (run it yourself, not through a pipe or agent)", "refused");
  }
  const agent = await findAgent({ platform: d.platform, startPid: d.ppid, ps: d.ps, procRoot: d.procRoot });
  if (agent) throw new CliError(EXIT.refused, "A value is shown to a person at a terminal, never to an agent.", "refused");
  const creds = await loadCredentials(d);
  let envelope;
  try {
    envelope = await call(d, creds, "POST", "/api/secrets/admin/reveal", { ref });
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.refused) {
      throw new CliError(EXIT.refused, "this machine's token cannot reveal secrets (needs scope 'admin'). Pair with an admin token or copy the secret in OpenMausBot → Settings → Vault.", "refused");
    }
    throw error;
  }
  const data = envelope.data;
  if (!data || typeof data.value !== "string") throw new CliError(EXIT.unreachable, "the server's reveal answer has an unexpected shape", "store_unavailable");
  if (ctx.json) d.stdout.write(`${JSON.stringify({ schema_version: 1, kind: "secrets.get", data })}\n`);
  else d.stdout.write(`${data.value}\n`);
  return EXIT.done;
}

async function cmdGrants(ctx, { positionals }) {
  if (positionals.length > 0) throw invalid("usage: omb secrets grants");
  const identity = await needIdentity(ctx);
  const creds = await loadCredentials(ctx.d);
  const { data } = await call(ctx.d, creds, "GET", `/api/secrets/grants?${new URLSearchParams({ fingerprint: identity.fingerprint })}`);
  if (!Array.isArray(data)) throw new CliError(EXIT.unreachable, "the server's grants have an unexpected shape", "store_unavailable");
  const line = (grant) => [clean(grant.ref, 130), grant.state, `project ${clean(grant.project, 60)}`, `purpose "${clean(grant.purpose, 60)}"`, grant.exec ? `exec ${clean(grant.exec.path, 200)} ${clean(grant.exec.env, 60)}` : null,
    grant.once ? "once" : grant.expiresAt ? `until ${clean(grant.expiresAt, 40)}` : "no end", grant.allowHosts?.length ? `hosts ${grant.allowHosts.map((host) => clean(host, 80)).join(",")}` : null].filter(Boolean).join("  ");
  emit(ctx, "secrets.grants", data, data.length ? data.map(line) : ["No live grant for this agent."]);
  return EXIT.done;
}

async function cmdAudit(ctx, { flags, positionals }) {
  if (positionals.length > 0) throw invalid("usage: omb secrets audit [--secret REF] [--since 24h] [--decision D] [--source S] [--limit N] [--cursor C]");
  const identity = await needIdentity(ctx);
  const query = new URLSearchParams({ fingerprint: identity.fingerprint });
  if (flags.secret !== undefined) query.set("ref", checkRef(flags.secret));
  if (flags.since !== undefined) {
    if (!/^\d{1,5}[mhdw]$/.test(flags.since)) throw invalid("--since is like 90m, 24h, 7d or 2w");
    query.set("since", flags.since);
  }
  if (flags.decision !== undefined) {
    if (!["allow", "deny", "block", "check"].includes(flags.decision)) throw invalid("--decision is allow, deny, block or check");
    query.set("decision", flags.decision);
  }
  if (flags.source !== undefined) {
    if (!["adapter", "cli", "desktop"].includes(flags.source)) throw invalid("--source is adapter, cli or desktop");
    query.set("source", flags.source);
  }
  if (flags.limit !== undefined) {
    if (!/^\d+$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > 500) throw invalid("--limit is 1 to 500");
    query.set("limit", flags.limit);
  }
  if (flags.cursor !== undefined) query.set("cursor", clean(flags.cursor, 200));
  const creds = await loadCredentials(ctx.d);
  const { data } = await call(ctx.d, creds, "GET", `/api/secrets/audit?${query}`);
  if (!data || !Array.isArray(data.entries)) throw new CliError(EXIT.unreachable, "the server's audit has an unexpected shape", "store_unavailable");
  const lines = data.entries.map((row) => [clean(row.at, 30), clean(row.decision, 10), clean(row.ref, 130), `"${clean(row.purpose, 60)}"`, clean(row.errorCode, 30), clean(row.context, 120)].filter(Boolean).join("  "));
  if (data.hasMore && data.nextCursor) lines.push(`more: --cursor ${clean(data.nextCursor, 200)}`);
  emit(ctx, "secrets.audit", data, lines.length ? lines : ["No audit rows match."]);
  return EXIT.done;
}

// Skills and the Claude Code guard hook

/** The omb-vault skill as it is installed. skills/omb-vault/SKILL.md holds the same text. */
export const SKILL_TEXT = `---
name: omb-vault
description: "Use API keys, tokens and other secrets from the OpenMausBot (OMB) Vault through the \`omb secrets\` command, without ever seeing or printing a value. Use when a task needs a credential: an API call with a key, a deploy or a tool that reads a token from its environment, or a .env value."
when_to_use: "Invoke when a task calls an API that needs a key, runs a program that needs a token, meets a .env file, or the person mentions a secret, key, token, password or the Vault."
keywords: [secrets, vault, credentials, api-key, token, dotenv, env-file, omb, openmausbot]
---

# omb-vault: use secrets from the OpenMausBot Vault

The person keeps secrets in the Vault of their OpenMausBot (OMB) server. You never hold a value. You ask OMB to use it for you, in one of two ways:

| You need | Command | Where the value goes |
|---|---|---|
| An HTTPS request with the secret in it | \`omb secrets fetch REF URL [options]\` | OMB puts it into the request and gives you the answer with the value struck out. It never reaches your machine. |
| A program that reads the secret from its environment | \`omb secrets run --env VAR=REF -- /abs/path/program [args]\` | Only into that one program's environment. Its output comes back with the value struck out. |

There is no third way. Never put a secret into a command line, a file, a prompt, a URL you print, or a \`\${secret:...}\`-style placeholder: those are refused.

## Before you start

1. \`omb status\` shows whether this machine is paired with an OMB server. If \`omb\` is missing or not paired, stop and tell the person: "Pair this computer in OpenMausBot: Settings → Vault → Install skill for harnesses." Do not try to pair it yourself.
2. \`omb secrets list\` shows the names (refs) you may ask for. \`omb secrets describe REF\` shows a ref's profile, including the hosts \`fetch\` may reach. Neither shows a value.
3. If the ref you need is not there, ask the person to add it in OpenMausBot (Settings → Vault), and for \`fetch\`, to list the API's host under "Allowed hosts". Do not invent a ref name.

## fetch: call an API with the secret

\`\`\`sh
omb secrets fetch GITHUB_TOKEN https://api.github.com/user --purpose "read the GitHub user"
omb secrets fetch OPENAI_API_KEY https://api.openai.com/v1/models --inject bearer --purpose "list models"
omb secrets fetch SENTRY_TOKEN https://sentry.io/api/0/projects/ --inject header:Authorization --include
omb secrets fetch API_KEY https://api.example.com/v1/items --method POST \\
  --header 'Content-Type: application/json' --data @payload.json --purpose "create an item"
\`\`\`

- \`--inject\` is \`bearer\` (default), \`header:NAME\`, \`query:NAME\` or \`basic-password\`. Do not also send the header you inject.
- Only \`https\` (plain \`http\` only to localhost), no redirects followed, 60 s timeout, body cut at 10 MiB, request body at most about 48 KB.
- Exit 0 means OMB made the call, whatever status the API answered; read the body. Exit 6 with "host not allowed" means the person must add the host to the ref in OMB.

## run: give the secret to one program

\`\`\`sh
omb secrets run --env GH_TOKEN=GITHUB_TOKEN --purpose "list PRs" -- /opt/homebrew/bin/gh pr list
omb secrets run --env PGPASSWORD=DB_PASSWORD --purpose "back up the db" -- /usr/bin/pg_dump -h db.local app
\`\`\`

- Give the program by absolute path. A shell (\`sh\`, \`bash\`, \`zsh\`), a launcher (\`env\`, \`sudo\`, \`xargs\`, \`nohup\`, \`timeout\`) or a script whose \`#!\` line is \`/usr/bin/env ...\` is refused. For a script, run its interpreter: \`-- /usr/bin/python3 script.py\`.
- Variables that steer a loader, runtime or proxy (\`PATH\`, \`HOME\`, \`LD_*\`, \`DYLD_*\`, \`NODE_OPTIONS\`, proxy and CA variables) cannot carry a secret.
- The program gets a clean environment with only the system basics and the granted variables. Its output is relayed with the value struck out.
- The approval covers that program's exact content. After the program is upgraded, the next call needs a new approval.

## Approval (exit 8)

The first call for a ref, purpose and agent files a request. OMB either approves it at once, and the same call then goes through, or shows the person a card. In the second case \`omb\` exits 8 and prints what to wait for.

- Do not retry in a loop, and never try to approve, grant or reveal a secret yourself: those commands are the person's and exit 6.
- Wait for the notice \`already approved omb secrets: REF\`, then run the same command once more.
- Keep \`--purpose\` short and the same each time for the same job: a new purpose is a new approval.

## Exit codes

| Exit | Meaning | What you do |
|---|---|---|
| 0 | Done (\`run\`: the program's own status) | Go on |
| 2 | Wrong arguments, ref, variable or program | Fix the command |
| 3 | No such secret | Ask the person to add it in OMB |
| 5 | Server, token store or program not available, or the pairing ended | Tell the person; nothing was released |
| 6 | Refused (host not allowed, unknown agent, person-only command) | Do not retry; tell the person why |
| 8 | Approval pending | Wait for the notice, then run the same command once |
| 9 | Rate limited | Stop and tell the person |

## .env files

Do not copy a value out of a \`.env\` file into a command, a message or another file. If a task needs a value from a \`.env\` file regularly, suggest that the person moves it into the OMB Vault, then use \`fetch\` or \`run\`.

## Never

- Print, log, echo, write or summarize a secret value, even part of one.
- Use \`omb secrets get --reveal\`, \`grant\`, \`approve\`, \`set\`, \`rotate\` or \`delete\`: the person does these in OpenMausBot.
- Pass a secret on a command line, in a URL you print, or through a shell.
`;

const SKILL_NAME = "omb-vault";
const HOOK_COMMAND_END = "hook claude-pretooluse";
const OWN_HOOK = /omb(?:\.mjs)?" hook claude-pretooluse$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A harness reads personal skills from `<base>/<sub>`. `env` names the variable that moves `base`; only an absolute value counts.
 * `agent` is how the parent-process walk knows the harness: `bin` is the name of its file, `path` a path of its file or of the script a runtime hosts.
 */
export const HARNESSES = [
  { id: "claudeAgent", label: "Claude", base: ".claude", env: "CLAUDE_CONFIG_DIR", agent: { name: "claude", bin: /^claude(-code)?$/, path: /\/claude\/versions\/[^/]+$|\/@anthropic-ai\/claude-code\// } },
  { id: "codex", label: "Codex", base: ".agents", agent: { name: "codex", bin: /^codex$/, path: /\/@openai\/codex\// } },
  { id: "opencodeGo", label: "OpenCode", base: ".config/opencode", agent: { name: "opencode", bin: /^\.?opencode$/, path: /\/opencode-ai\/|\/opencode\/bin\// } },
  { id: "piAgent", label: "pi", base: ".pi/agent", env: "PI_CODING_AGENT_DIR", agent: { name: "pi", bin: /^pi$/, path: /(?<!@oh-my-pi)\/pi-coding-agent\// } },
  { id: "geminiAgent", label: "Gemini", base: ".gemini", agent: { name: "gemini", bin: /^gemini$/, path: /\/@google\/gemini-cli\// } },
  { id: "antigravityAgent", label: "Google Gemini (Antigravity)", base: ".gemini/config", agent: { name: "antigravity", bin: /^(agy|agy_acp_server\.par|localharness_external)$/ } },
  { id: "cursorAgent", label: "Cursor", base: ".cursor", agent: { name: "cursor", bin: /^cursor-agent$/, path: /\/cursor-agent\/versions\/[^/]+\/index\.js$/ } },
  { id: "copilotAgent", label: "GitHub Copilot", base: ".copilot", env: "COPILOT_HOME", agent: { name: "copilot", bin: /^copilot$/, path: /\/@github\/copilot\// } },
  { id: "grokAgent", label: "Grok", base: ".grok", agent: { name: "grok", bin: /^grok$/, path: /\/\.grok\/downloads\/grok-[^/]+$/ } },
  { id: "qwenAgent", label: "Qwen", base: ".qwen", env: "QWEN_HOME", agent: { name: "qwen", bin: /^qwen$/ } },
  { id: "kimiAgent", label: "Kimi", base: ".kimi-code", env: "KIMI_CODE_HOME", agent: { name: "kimi", bin: /^kimi$/ } },
  { id: "kiroAgent", label: "Kiro", base: ".kiro", agent: { name: "kiro", bin: /^kiro-cli$/ } },
  { id: "droidAgent", label: "Droid", base: ".factory", agent: { name: "droid", bin: /^droid$/ } },
  { id: "clineAgent", label: "Cline", base: ".cline", env: "CLINE_DIR", agent: { name: "cline", bin: /^cline$/, path: /\/node_modules\/cline\// } },
  { id: "devinAgent", label: "Devin", base: ".agents", agent: { name: "devin", bin: /^devin$/ } },
  { id: "hermesAgent", label: "Hermes", base: ".hermes", env: "HERMES_HOME", agent: { name: "hermes", bin: /^hermes$/ } },
  { id: "ompAgent", label: "OMP", base: ".omp/agent", agent: { name: "omp", bin: /^omp$/, path: /\/@oh-my-pi\/pi-coding-agent\// } },
  { id: "mistralVibeAgent", label: "Mistral (Vibe)", base: ".vibe", env: "VIBE_HOME", agent: { name: "vibe", bin: /^vibe(-acp)?$/ } },
  { id: "deepseekAgent", label: "DeepSeek Harness", base: null, reason: "DeepSeek documents no literal skill folder" },
  { id: "commandCodeAgent", label: "Command Code", base: ".commandcode", agent: { name: "command-code", bin: /^command-code$/, path: /\/node_modules\/command-code\// } },
  { id: "museCode", label: "Muse Code", base: ".config", env: "XDG_CONFIG_HOME", sub: "muse/skills", agent: { name: "muse", bin: /^muse$/ } },
].map((harness) => ({ ...harness, recognised: harness.base !== null && harness.agent !== undefined }));

const AGENTS = HARNESSES.flatMap((harness) => (harness.recognised ? [harness.agent] : []));

function harnessBase(harness, env, home) {
  const moved = harness.env ? env[harness.env] : undefined;
  return typeof moved === "string" && isAbsolute(moved) ? moved : join(home, harness.base);
}

function skillFolder(harness, env, home) {
  return harness.base === null ? null : join(harnessBase(harness, env, home), harness.sub ?? "skills");
}

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
};

/** What the folder holds now: missing, same, different, or refused when the skill folder or file is a link or the wrong kind. */
function inspectSkill(folder) {
  try {
    const dir = join(folder, SKILL_NAME);
    const dirStat = lstatOrNull(dir);
    if (dirStat === null) return { state: "missing" };
    if (dirStat.isSymbolicLink()) return { state: "refused", reason: `${dir} is a symbolic link: omb does not write through it` };
    if (!dirStat.isDirectory()) return { state: "refused", reason: `${dir} is not a folder` };
    const file = join(dir, "SKILL.md");
    const fileStat = lstatOrNull(file);
    if (fileStat === null) return { state: "missing" };
    if (fileStat.isSymbolicLink()) return { state: "refused", reason: `${file} is a symbolic link: omb does not write through it` };
    if (!fileStat.isFile()) return { state: "refused", reason: `${file} is not a file` };
    return { state: readFileSync(file, "utf8") === SKILL_TEXT ? "same" : "different" };
  } catch (error) {
    return { state: "failed", reason: `cannot read ${clean(folder, 200)} (${clean(error?.code ?? "error", 40)})` };
  }
}

function installSkill(folder) {
  const seen = inspectSkill(folder);
  if (seen.state === "same") return { status: "unchanged" };
  if (seen.state === "refused" || seen.state === "failed") return { status: seen.state, note: seen.reason };
  try {
    writeAtomic(join(folder, SKILL_NAME, "SKILL.md"), SKILL_TEXT, 0o644, 0o755);
  } catch (error) {
    return { status: "failed", note: `cannot write ${clean(folder, 200)} (${clean(error?.code ?? "error", 40)})` };
  }
  return { status: seen.state === "missing" ? "installed" : "updated" };
}

const hookCommand = (d) => `"${d.nodePath}" "${d.selfPath}" ${HOOK_COMMAND_END}`;

/** Adds the omb guard to `hooks.PreToolUse` of the Claude settings file: one entry, its path brought up to date, every other key kept. */
function registerClaudeHook(d) {
  const claude = HARNESSES.find((harness) => harness.id === "claudeAgent");
  const settingsPath = join(harnessBase(claude, d.env, d.home), "settings.json");
  const command = hookCommand(d);
  if ([d.nodePath, d.selfPath].some((path) => /["$`\\\n\r]/.test(path))) return { state: "untouched", note: "the path of node or omb has a character a hook command cannot quote, so the hook was not added" };
  let target = settingsPath;
  let settings = {};
  let mode = 0o600;
  try {
    if (lstatOrNull(settingsPath) !== null) {
      target = realpathSync(settingsPath);
      mode = statSync(target).mode & 0o777;
      settings = JSON.parse(readFileSync(target, "utf8"));
    }
  } catch (error) {
    const why = error instanceof SyntaxError ? "is not valid JSON" : `cannot be read (${clean(error?.code ?? "error", 40)})`;
    return { state: "untouched", note: `${settingsPath} ${why}, so the hook was not added` };
  }
  const hooks = settings?.hooks ?? {};
  const listed = hooks?.PreToolUse ?? [];
  if (!isObject(settings) || !isObject(hooks) || !Array.isArray(listed)) return { state: "untouched", note: `${settingsPath} has hooks in a shape omb does not edit, so the hook was not added` };
  let found = 0;
  let changed = false;
  const trimmed = new Set();
  for (const entry of listed) {
    if (!isObject(entry) || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter((hook) => {
      if (!isObject(hook) || typeof hook.command !== "string" || !OWN_HOOK.test(hook.command)) return true;
      if (++found > 1) {
        changed = true;
        trimmed.add(entry);
        return false;
      }
      if (hook.command !== command) {
        hook.command = command;
        changed = true;
      }
      return true;
    });
  }
  const kept = listed.filter((entry) => !(trimmed.has(entry) && entry.hooks.length === 0));
  if (found === 0) {
    kept.push({ matcher: "*", hooks: [{ type: "command", command }] });
    changed = true;
  }
  if (!changed) return { state: "unchanged", note: `the guard hook is already in ${settingsPath}` };
  settings.hooks = { ...hooks, PreToolUse: kept };
  try {
    writeAtomic(target, `${JSON.stringify(settings, null, 2)}\n`, mode);
  } catch (error) {
    return { state: "failed", note: `cannot write ${settingsPath} (${clean(error?.code ?? "error", 40)}), so the hook was not added` };
  }
  return { state: found === 0 ? "registered" : "updated", note: `the guard hook ${found === 0 ? "was added to" : "was updated in"} ${settingsPath}` };
}

function skillRow(harness, d, result) {
  const notes = [result.note, harness.reason].filter(Boolean);
  const row = { harness: harness.id, label: harness.label, folder: skillFolder(harness, d.env, d.home), status: result.status, recognised: harness.recognised };
  if (notes.length > 0) row.note = notes.join(". ");
  return row;
}

const rowText = (row) => `${row.harness}  ${row.status}  ${row.folder ?? "-"}${row.note ? `  (${clean(row.note, 300)})` : ""}`;

function cmdSkillList(ctx, { positionals }) {
  if (positionals.length > 0) throw invalid("usage: omb skill list [--json]");
  const { d } = ctx;
  const rows = HARNESSES.map((harness) => {
    const folder = skillFolder(harness, d.env, d.home);
    if (folder === null) return skillRow(harness, d, { status: "unsupported" });
    const seen = inspectSkill(folder);
    const status = { missing: "missing", same: "installed", different: "outdated" }[seen.state] ?? seen.state;
    return skillRow(harness, d, { status, note: seen.reason });
  });
  emit(ctx, "skill.list", { rows }, rows.map(rowText));
  return EXIT.done;
}

function cmdSkillInstall(ctx, { flags, positionals }) {
  if (positionals.length > 0 || (flags.all === true) === (flags.harness !== undefined)) throw invalid("usage: omb skill install (--harness ID[,ID...] | --all) [--json]");
  const { d } = ctx;
  let chosen = HARNESSES;
  if (flags.harness !== undefined) {
    const ids = flags.harness.flatMap((item) => item.split(",").map((id) => id.trim()));
    const unknown = ids.filter((id) => !HARNESSES.some((harness) => harness.id === id));
    if (unknown.length > 0) throw invalid(`unknown harness ${unknown.map((id) => clean(id, 40) || "(empty)").join(", ")}. Known: ${HARNESSES.map((harness) => harness.id).join(", ")}`);
    chosen = HARNESSES.filter((harness) => ids.includes(harness.id));
  }
  const written = new Map();
  const rows = chosen.map((harness) => {
    const folder = skillFolder(harness, d.env, d.home);
    if (folder === null) return skillRow(harness, d, { status: "skipped" });
    if (!written.has(folder)) written.set(folder, installSkill(folder));
    return skillRow(harness, d, written.get(folder));
  });
  let hookFailed = false;
  const claudeRow = rows.find((row) => row.harness === "claudeAgent");
  if (claudeRow) {
    const hook = registerClaudeHook(d);
    hookFailed = hook.state === "failed";
    claudeRow.note = [claudeRow.note, hook.note].filter(Boolean).join(". ");
  }
  emit(ctx, "skill.install", { rows }, rows.map(rowText));
  if (hookFailed || rows.some((row) => row.status === "failed")) return EXIT.unreachable;
  return rows.some((row) => row.status === "refused") ? EXIT.refused : EXIT.done;
}

/** Built in parts, so that this file never holds a whole placeholder. */
const PLACEHOLDER = new RegExp(["\\$\\{", "secret:", "\\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,127})", "[^}\\r\\n{]{0,128}\\}"].join(""), "g");

function findPlaceholders(value, refs, depth = 0) {
  if (depth > 64 || refs.size >= 10) return;
  if (typeof value === "string") {
    for (const found of value.matchAll(PLACEHOLDER)) {
      if (refs.add(found[1]).size >= 10) return;
    }
  } else if (Array.isArray(value)) {
    for (const item of value) findPlaceholders(item, refs, depth + 1);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      findPlaceholders(key, refs, depth + 1);
      findPlaceholders(item, refs, depth + 1);
    }
  }
}

/** Claude Code PreToolUse hook: denies a tool call whose input holds a secret placeholder. When the input cannot be read, the call goes on. */
async function cmdHookClaude(ctx) {
  const { d } = ctx;
  if (d.stdinIsTTY) return EXIT.done;
  let input;
  try {
    input = JSON.parse((await readStream(d.stdin, 16 * 1024 * 1024)).toString("utf8"));
  } catch {
    return EXIT.done;
  }
  if (!isObject(input) || (input.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse")) return EXIT.done;
  const refs = new Set();
  findPlaceholders(input.tool_input, refs);
  if (refs.size === 0) return EXIT.done;
  const reason = "Secret placeholders are not replaced here, and a secret value must not be written into a command, a file or a request. "
    + "To call an API with a secret, run: omb secrets fetch REF URL. To give a program a secret in its environment, run: omb secrets run --env VAR=REF -- /abs/path/program. "
    + `See the omb-vault skill. Names found: ${[...refs].join(", ")}.`;
  d.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })}\n`);
  return EXIT.done;
}

const HELP = `omb ${VERSION}: use the OpenMausBot Vault from an agent machine

  omb pair <link-or-code> [--server URL]        pair this machine (a link ends in /pair#code=...)
  omb pair --token-stdin --server URL           pair with a token from: openmausbot token create NAME --scope secrets
  omb status                                    server, scope, reachability (never the token)

  omb secrets fetch <ref> <url> [--method M] [--header 'Name: value'] [--data @file|-]
                    [--inject bearer|header:NAME|query:NAME|basic-password]
                    [--purpose P] [--project X] [--include] [--json]
  omb secrets run --env VAR=REF [--env ...] [--purpose P] [--project X] -- <program> [args]
  omb secrets request <ref> [--purpose P] [--project X] [--exec PROGRAM --env VAR]
  omb secrets list | describe <ref> | get <ref> [--reveal] | grants | audit [--secret REF] [--since 24h] [--limit N]

  omb skill list [--json]                       where the omb-vault skill is or is not installed, per agent harness
  omb skill install (--harness ID[,ID...] | --all) [--json]
                                                write the omb-vault skill into the harness skill folders; for claudeAgent
                                                also add the guard hook to settings.json
  omb hook claude-pretooluse                    Claude Code PreToolUse hook (reads stdin): denies secret placeholders

set, rotate, delete, grant, revoke and approve are done by the person in the OpenMausBot app.
get --reveal is for a person at an interactive terminal with an admin token (never for an agent).
Exit codes: 0 done, 2 invalid, 3 no such secret, 4 exists, 5 server or store unreachable, 6 refused,
8 approval pending, 9 rate limited. skill install: 5 a write failed, 6 a skill folder is a symbolic link. Flags: --json, -q/--quiet.
`;

export async function main(argv, overrides = {}) {
  const d = {
    env: process.env, platform: process.platform, home: process.env.HOME || homedir(), cwd: () => process.cwd(), ppid: process.ppid, procRoot: "/proc",
    nodePath: process.execPath, selfPath: fileURLToPath(import.meta.url),
    stdin: process.stdin, stdinIsTTY: process.stdin.isTTY === true, stdout: process.stdout, stdoutIsTTY: process.stdout.isTTY === true, stderr: process.stderr, proc: process,
    fetch: (...args) => globalThis.fetch(...args),
    ps: (args) => new Promise((done, fail) => execFile("ps", args, { encoding: "utf8", timeout: 5000 }, (error, out) => (error ? fail(error) : done(out)))),
    security: (args, input) => new Promise((done, fail) => {
      const child = execFile("/usr/bin/security", args, { encoding: "utf8", timeout: 15_000 }, (error, out) => (error ? fail(error) : done(out)));
      if (input !== undefined) child.stdin.end(input);
    }),
    ...overrides,
  };
  const [head, ...rest] = argv;
  const ctx = { d, json: false, quiet: false, command: "omb", refs: [] };
  try {
    if (head === undefined || head === "help" || head === "-h" || head === "--help") {
      d.stdout.write(HELP);
      return EXIT.done;
    }
    if (head === "--version" || head === "version") {
      d.stdout.write(`${VERSION}\n`);
      return EXIT.done;
    }
    if (head === "pair" || head === "status") {
      ctx.command = head;
      const parsed = parseArgs(rest, SPECS[head]);
      ctx.json = parsed.flags.json === true;
      ctx.quiet = parsed.flags.quiet === true;
      if (parsed.flags.help) {
        d.stdout.write(HELP);
        return EXIT.done;
      }
      return await (head === "pair" ? cmdPair(ctx, parsed) : cmdStatus(ctx, parsed));
    }
    if (head === "hook") {
      ctx.command = "hook";
      if (rest.length !== 1 || rest[0] !== "claude-pretooluse") throw invalid("usage: omb hook claude-pretooluse");
      return await cmdHookClaude(ctx);
    }
    if (head === "skill") {
      const [sub, ...tokens] = rest;
      ctx.command = `skill ${sub ?? ""}`.trim();
      ctx.json = tokens.includes("--json");
      ctx.quiet = tokens.includes("-q") || tokens.includes("--quiet");
      if (sub === undefined || sub === "help" || sub === "-h" || sub === "--help") {
        d.stdout.write(HELP);
        return EXIT.done;
      }
      if (!Object.hasOwn(SKILL_SPECS, sub)) throw invalid(`unknown command omb skill ${clean(sub, 40)}. Try: omb help`);
      const parsed = parseArgs(tokens, SKILL_SPECS[sub]);
      ctx.json = parsed.flags.json === true;
      ctx.quiet = parsed.flags.quiet === true;
      if (parsed.flags.help) {
        d.stdout.write(HELP);
        return EXIT.done;
      }
      return sub === "list" ? cmdSkillList(ctx, parsed) : cmdSkillInstall(ctx, parsed);
    }
    if (head !== "secrets") throw invalid(`unknown command ${clean(head, 40)}. Try: omb help`);
    const [name, ...tokens] = rest;
    ctx.command = `secrets ${name ?? ""}`.trim();
    if (name === undefined || name === "help" || name === "-h" || name === "--help") {
      d.stdout.write(HELP);
      return EXIT.done;
    }
    ctx.json = tokens.includes("--json");
    ctx.quiet = tokens.includes("-q") || tokens.includes("--quiet");
    if (PERSON_ONLY.includes(name)) throw secretsError("this", "Ask the person to do it there; an agent token cannot.");
    if (!SPECS[name] || name === "pair" || name === "status") throw invalid(`unknown command omb secrets ${clean(name, 40)}. Try: omb help`);
    let toParse = tokens;
    let program = [];
    if (name === "run") {
      const split = tokens.indexOf("--");
      if (split < 0) throw invalid("put the program after --: omb secrets run --env VAR=REF -- <program> [args]");
      toParse = tokens.slice(0, split);
      program = tokens.slice(split + 1);
    }
    const parsed = parseArgs(toParse, SPECS[name]);
    ctx.json = parsed.flags.json === true;
    ctx.quiet = parsed.flags.quiet === true;
    if (parsed.flags.help) {
      d.stdout.write(HELP);
      return EXIT.done;
    }
    if (name === "run") parsed.positionals = program;
    switch (name) {
      case "fetch": return await cmdFetch(ctx, parsed);
      case "run": return await cmdRun(ctx, parsed);
      case "request": return await cmdRequest(ctx, parsed);
      case "list": return await cmdList(ctx, parsed);
      case "describe": return await cmdDescribe(ctx, parsed, "describe");
      case "get": return parsed.flags.reveal ? await cmdReveal(ctx, parsed) : await cmdDescribe(ctx, parsed, "get");
      case "grants": return await cmdGrants(ctx, parsed);
      default: return await cmdAudit(ctx, parsed);
    }
  } catch (error) {
    return report(ctx, error);
  }
}

function report(ctx, error) {
  const { d } = ctx;
  const failure = error instanceof CliError ? error : new CliError(EXIT.unreachable, `unexpected failure (${clean(error?.code ?? error?.name ?? "error", 60)})`, "store_unavailable");
  let message = failure.message;
  if (failure.exitCode === EXIT.pending && ctx.refs.length > 0) message = pendingText(ctx.refs, failure.message);
  else if (WORDS[failure.exitCode]) message += WORDS[failure.exitCode];
  if (ctx.json) d.stdout.write(`${JSON.stringify({ schema_version: 1, error: message, error_code: failure.errorCode, exit_code: failure.exitCode })}\n`);
  else d.stderr.write(`omb${ctx.command === "omb" ? "" : ` ${ctx.command}`}: ${message}\n`);
  return failure.exitCode;
}

function flushAndExit(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

if (process.argv[1]) {
  let self = process.argv[1];
  try { self = realpathSync(self); } catch { /* compared as given */ }
  if (import.meta.url === pathToFileURL(self).href) main(process.argv.slice(2)).then(flushAndExit, (error) => {
    process.stderr.write(`omb: unexpected failure (${clean(error?.code ?? error?.name ?? "error", 60)})\n`);
    flushAndExit(EXIT.unreachable);
  });
}
