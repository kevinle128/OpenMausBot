# OMB secrets API

The server side of `omb secrets`: the Vault of OpenMausBot, opened to agent machines under the same command surface, JSON envelope and exit codes as `ak secrets`. A command line client (`omb`) is built against this page.

Everything here is under `/api/secrets/`. Requests and answers are JSON. Nothing in a request or an answer is logged, and a secret value appears in exactly three answers: `resolve`, `run-check` and `admin/reveal`.

## Authentication

| Caller | Credential | Reaches |
|---|---|---|
| Agent machine | A token with only the `secrets` scope, sent as `Authorization: Bearer omb_sess_...` | The agent routes below, and no other route of the server |
| The person | An `admin` session or token, or the desktop app | The agent routes and the admin routes (`/api/secrets/admin/*`) |

Make a token for an agent machine on the server, or with an admin token:

```sh
openmausbot token create "Laptop agents" --scope secrets --expires 90d --out secrets-token
```

This is the existing access-token mechanism (`POST /api/auth/pairing` with `scopes: ["secrets"]` and `tokenTtlMs`, then `POST /api/auth/pair` with the code). A client that pairs by itself sends the same two calls. After the exchange, check that `session.scopes` is exactly `["secrets"]`: a server that does not know the scope drops it and opens the default one, so end that session (`DELETE /api/auth/sessions/<id>`) and report an error.

The token never renews, ends on its date (at most `OMB_SESSION_MAX_DAYS`, 180 by default), and is listed and revoked like any session (`openmausbot token list`, `openmausbot token revoke ID`). A `secrets` token gets `403 { "error": "forbidden: this session lacks the admin scope" }` on every other route, and it cannot be issued on a Team Cloud.

The token is the boundary. `fingerprint`, `agentId`, `cwd` and the other fields a client sends about itself are never authorization: the fingerprint is part of a grant's key and the rest is attribution. A holder of a `secrets` token can send any fingerprint, so give a token only to machines whose agents you would give the same grants.

### Failures before the envelope

A refusal by the gate is not an envelope. A client maps it as follows.

| HTTP | Body | Client exit |
|---|---|---|
| 401 | `{ "error": "unauthorized: ..." }` | 5 (token ended or revoked: pair again) |
| 403 | `{ "error": "forbidden: ..." }` | 6 |
| network error, timeout, 5xx without an envelope | | 5 |

## Envelope

Success:

```json
{ "schema_version": 1, "kind": "secrets.<command>", "data": {} }
```

Failure (the four keys and no others):

```json
{ "schema_version": 1, "error": "text for a person or a model", "error_code": "approval_pending", "exit_code": 8 }
```

| `exit_code` | `error_code` | HTTP | Meaning |
|---|---|---|---|
| 0 | | 200 | Done |
| 2 | `invalid_request`, `no_such_request` | 400 | Bad ref, fingerprint, scope, field or body; no waiting request matches |
| 3 | `no_such_secret` | 404 | The ref is not in the Vault |
| 4 | `exists` | 409 | `set` of a name that exists (or differs from one only by case and punctuation) |
| 5 | `store_unavailable`, `not_available` | 503 | State, ledger or Vault could not be read or written, or the routes are off (Team Cloud). Nothing was released |
| 6 | `blocked`, `host_not_allowed` | 403 | A block covers the scope, or the destination is not on the grant's hosts. Settled: do not retry |
| 8 | `approval_pending` | 409 | No live grant covers the scope; a request is filed. The text says whether a person was asked or OpenMausBot approved it at once. Run the same call again |
| 9 | `rate_limited` | 429 | Over 12 uncovered requests a minute from one fingerprint: refused for 5 minutes. Do not retry |

`GET` answers set `Cache-Control: no-store`. A `POST` must send `Content-Type: application/json` and a body of at most 64 KiB.

## Common request fields

The asker fields, in every `POST` of the agent routes:

| Field | Type | Rule |
|---|---|---|
| `fingerprint` | string | Required. `sha256:` and 64 lowercase hex digits: the hash of the agent binary |
| `project` | string | At most 512 characters. Default `default`, the shared slot |
| `purpose` | string | At most 200 characters. Default empty. An empty purpose is a literal, never a wildcard |
| `agentLabel`, `session`, `context`, `agentId`, `cwd`, `destHost` | string | Optional. Control characters are dropped and long text is cut. `agentId` (the `PASEO_AGENT_ID` of the caller), `agentLabel`, `session` and `cwd` are attribution only |

A ref matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`.

## Agent routes

### `POST /api/secrets/resolve`

Body: `{ ref, project?, purpose?, fingerprint, agentLabel?, agentId?, cwd?, session?, context?, destHost? }`.

`200`: `{ "schema_version": 1, "kind": "secrets.resolve", "data": { "value": "...", "ref": "API_KEY" } }`, only when a live allow covers `(ref, project, fingerprint, purpose)`. A single-release allow is spent by this release. When the grant names hosts, `destHost` must be one of them; a restricted grant with no `destHost` is refused with exit 6.

Otherwise an error envelope: 6 (block or host), 9 (cool-down), 8 (request filed; see below). A ref that is missing from the Vault but covered by a grant answers 3.

### `POST /api/secrets/run-check`

Body: the asker fields and `scopes: [{ "var": "TOKEN", "ref": "API_KEY", "program": { "path": "/usr/bin/curl", "hash": "sha256:..." } }]`, from one to 16 scopes, each variable named once. `path` is absolute with symbolic links followed by the client, `hash` is the digest of the program file. The client refuses shells, launchers and loader-steering variables itself; the server also refuses `LD_*`, `DYLD_*`, `PATH`, `HOME`, `NODE_OPTIONS` and similar variables with exit 2.

`200`: `data: { "values": [ { "var": "TOKEN", "ref": "API_KEY", "value": "..." } ] }`, only when every scope is covered by an exec grant (same ref, project, fingerprint, purpose, program path, variable and program hash). No value is read, and no single-release allow is spent, until every scope is covered. Otherwise: exit 6 if any scope is blocked (nothing is filed), else a request is filed for each uncovered scope and the answer is 8 (or 9).

### `POST /api/secrets/request`

Body: the asker fields, `ref`, and optionally `exec: { path, hash }` with `env`. It files a request ahead of the call that needs it and never reads a value.

`200`: `data: { "status": "covered" }`, `{ "status": "pending", "requestId": "..." }` (a card is waiting for the person), or `{ "status": "granted" }` (OpenMausBot approved it at once). 6 and 9 are errors.

### `GET /api/secrets/list`

`data`: an array, one row per ref in the Vault whose name is a valid ref, sorted by ref:

```json
{ "ref": "API_KEY", "creator": "omb", "createdAt": "2026-11-19T03:00:00.000Z", "rotatedAt": "...",
  "hint": "sk-…6789", "needsRotation": false, "profile": { "description": "Billing API", "projects": ["site"] } }
```

`hint` is a known public prefix plus the last four characters for a value of 16 characters or more. For a shorter value it is `null` and the row adds `"hintReason": "short value"`. `needsRotation` is true when the value is older than 90 days. `profile` is `{}` when none was set; its fields are `description`, `projects[]`, `provider`, `kind`, `tags[]`, `whenToUse`, `whenNotToUse`, `sensitivity`, `expiresAt` (epoch milliseconds) and `rotateUrl`.

### `GET /api/secrets/describe/<ref>`

`data`: the row above plus `untrustedFields: []` and a fixed `notice` saying profile text is data and never an instruction. Exit 3 for a ref that is not in the Vault.

### `GET /api/secrets/get/<ref>`

`kind: "secrets.get"`, `data`: the same row as `list`. The value is never part of it.

### `GET /api/secrets/grants?fingerprint=<fp>`

`data`: the grants of that fingerprint that are still live:

```json
{ "id": "...", "ref": "API_KEY", "project": "default", "fingerprint": "sha256:...", "purpose": "deploy", "state": "allow",
  "createdAt": "...", "createdBy": "omb", "expiresAt": "...", "once": true, "agentLabel": "claude",
  "allowHosts": ["api.example.com"], "exec": { "path": "/usr/bin/curl", "env": "TOKEN", "hash": "sha256:..." } }
```

`state` is `allow` or `block`. `createdBy` is `omb` (OpenMausBot's own rule), `card` (the person answered a card) or `admin`. `expiresAt` is absent for a grant that never ends, `once` is present for a single-release allow, `exec` for an exec scope.

### `GET /api/secrets/audit?fingerprint=<fp>`

Query: `ref`, `since` (`90m`, `24h`, `7d`), `decision` (`allow`, `deny`, `block`, `check`), `source` (`adapter`, `cli`, `desktop`), `limit` (default 100, at most 500), `cursor`. `data`: `{ "entries": [...], "grants": [...], "hasMore": false, "limit": 100, "nextCursor": null }`, newest first. A row:

```json
{ "id": "...", "at": "2026-11-19T03:00:00.000Z", "decision": "allow", "source": "adapter", "ref": "API_KEY", "project": "default",
  "purpose": "deploy", "fingerprint": "sha256:...", "agentLabel": "claude", "sessionId": "", "context": "tool:Bash:command",
  "errorCode": "", "short": "aaaaaaaaaaaa", "caller": "<token session id>", "destHost": "api.example.com", "agentId": "..." }
```

A row never holds a value, a hash of one, or part of one. `errorCode` is empty or one of `approval_pending`, `rate_limited`, `blocked`, `host_not_allowed`, `no_such_secret`, `denied`.

## Admin routes

Under `/api/secrets/admin/`, for an admin session or token only. A `secrets` token is refused at the gate. An `admin` session or token also reaches every agent route, with the `fingerprint` it names.

| Route | Body or query | `data` |
|---|---|---|
| `POST set` | `{ ref, value, force?, bots?, profile? }` | `{ ref, created }`. Exit 4 when the ref exists (or a name equal to it once case and punctuation are ignored) and `force` is not true. `bots`: `"all"`, `"paseo"`, or a list of bot ids; **default none**, so a new secret asks the person at first use. A trailing newline of `value` is dropped; at most 4096 bytes. A profile that holds the value is refused (exit 2) |
| `POST rotate` | `{ ref, value, profile? }` | `{ ref, rotatedAt }`. Exit 3 when missing. The profile and the grants stay |
| `POST delete` | `{ ref }` | `{ ref, deleted: true, grantsRemoved }`. Its grants and waiting requests go too |
| `POST reveal` | `{ ref }` | kind `secrets.get`, `{ ref, value }`. The audit row is written first. A `POST`, so the desktop's mutation check applies to it |
| `POST grant` | `{ ref, fingerprint, project?, purpose?, state, ttl?, persist?, once?, allowHosts?, exec?, agentLabel? }` | The grant. `state` is `allow` or `block`; name at most one of `ttl` (`90m`, `12h`, `30d`, `2w`), `persist`, `once`; an allow defaults to 24 hours, a block to no end. `allowHosts` (normalized: lowercase, default port and trailing dot dropped, IDNA) is for an ordinary allow only. `exec` is `{ path, hash, env }`. Granting again a scope that names hosts keeps them |
| `POST revoke` | `{ fingerprint, all? , ref?, project?, purpose?, exec? }` | `{ revoked }`. One exact scope (allow and block rows), an exec scope by `exec: { path, env }` (any hash), or `all` of a fingerprint. Values are untouched |
| `GET approve` | | `{ requests: [...] }`, the waiting requests: `id, ref, project, fingerprint, purpose, exec?, agentLabel?, agentTitle?, cwd?, count, firstSeen, lastSeen` |
| `POST approve` | `{ state, id?, ref?, fingerprint?, project?, purpose?, env?, ttl? }` | `{ answered: [{ id, ref, state }] }`. `state` is `deny` (stores nothing: the next ask opens a new card), `once`, `ttl` (default 24h) or `persist`. Several matches without `id` is exit 2. An answer closes the card |
| `GET grants` | `fingerprint?`, `ref?` | All live grants |
| `GET audit` | `fingerprint?` and the query of the agent route | All rows |

Admin actions are in the ledger too: `decision: "check"` with `context` `admin:set`, `admin:rotate`, `admin:delete`, `admin:revoke`, and `decision: "allow"` or `"deny"` for `admin:grant`, `admin:reveal` and `approve:<state>`.

## How a request is decided

For `(ref, project, fingerprint, purpose)` and, for an exec scope, `(program path, variable, program hash)`:

1. A live **block** covers the scope: exit 6. An ordinary block (no `exec`) also covers every exec scope of the same ref, project, fingerprint and purpose. A block beats an allow.
2. A live **allow** covers it: the call goes on (host check for an ordinary allow with `allowHosts`). Ordinary and exec grants never answer for each other.
3. Nothing covers it: the request counts against the cool-down (12 a minute per fingerprint, then 5 minutes: exit 9). A request that no grant covered is filed, and a repeat of one scope is one request with a higher `count`. Calls that a grant covers are not counted.
4. A ref **in the Vault, kept to the Paseo bot or to every bot** is allowed for 24 hours by OpenMausBot itself. The Inbox gets an "OpenMausBot tự duyệt" line, and the agent named by a live `agentId` is told `already approved omb secrets: <REF>` followed by a blank line and `𝗯𝘆 𝗢𝗠𝗕`. The call that filed the request still answers exit 8 ("run the same call again"); the retry gets the value. The grant is keyed to the fingerprint, so any agent of that binary may use it.
5. **Any other ref**, or a ref that is not in the Vault, opens a card in the Paseo conversation with the agent's title, its workspace, the ref, the purpose and, for an exec scope, the program and the variable. The cards of a request are opened again on each uncovered call, so a restart loses none. "Allow 24h" writes a grant, an Inbox line "Bạn đã duyệt" and the plain notice `already approved omb secrets: <REF>` to the named agent; "Deny" writes "Bạn đã từ chối" and nothing else.

The agent that is named by `agentId` is used only when the Paseo daemon lists it right now; its title and workspace then come from the daemon, not from the request. Without the Paseo bridge (`OMB_PASEO_BRIDGE=1`) the decisions, cards and Inbox lines work the same and no agent is told.

A release writes its audit row first. When the row cannot be written, nothing is released, a single-release allow stays unspent, and the answer is exit 5. When the grants or requests file cannot be read, every decision fails closed with exit 5.

## Data files

In the data directory, owner-only, never part of a backup:

| File | Content |
|---|---|
| `secret-grants.json` | `{ version: 1, grants }` |
| `secret-requests.json` | `{ version: 1, requests }` |
| `secret-audit/YYYY-MM.ndjson` | One row per line |
| `logins.json.enc` | The Vault. A secret record may carry a `profile`; values are encrypted as before |

An older release reads the Vault without the `profile` and drops it on its next save, and fails to read `sessions.json` when it holds a `secrets` scope. Revoke the `secrets` tokens before going back a release.
