# omb: the command line for agent machines

`omb` lets an agent on any machine use the secrets in the Vault of an OpenMausBot server, without the agent ever holding the Vault. It is one file, `bin/omb.mjs`, for Node 20 or later, with no dependencies. The server side is described in [omb-secrets-api.md](omb-secrets-api.md); this page is for the person who installs `omb` and for the agent that runs it.

An agent has two ways to use a secret:

| Way | Command | What happens to the value |
|---|---|---|
| Through OpenMausBot | `omb secrets fetch` | OpenMausBot puts the value into an HTTPS request to a host the person allowed, and returns the answer with the value struck out. The value never leaves the OpenMausBot server. |
| In one program | `omb secrets run` | The value goes into the environment of one pinned program (path and content hash), started without a shell, and is struck out of its output. |

There is no command that prints a value. The person sets, rotates, grants and approves in the OpenMausBot app.

## Install

Copy the file to a folder on the `PATH` and make it run:

```sh
install -m 755 bin/omb.mjs ~/.local/bin/omb
omb help
```

From a checkout, `node bin/omb.mjs` runs it without installing. macOS and Linux are supported. On Windows `omb` cannot name the agent above it, so every command that needs it exits 6.

## Pair this machine

Pairing gives the machine a token with the `secrets` scope only. That token reaches the agent routes of the secrets API and no other route of the server.

```sh
omb pair 'https://maus.example.com/pair#code=ABCD-EFGH-JKLM'
omb pair ABCD-EFGH-JKLM --server https://maus.example.com
openmausbot token create "Laptop agents" --scope secrets --expires 90d --out secrets-token   # on the server
omb pair --token-stdin --server https://maus.example.com < secrets-token
```

- The first two forms use a pairing code that was made with the `secrets` scope. After the exchange `omb` checks that the session has exactly that scope. If it does not (an older server drops a scope it does not know), `omb` ends the session at once, stores nothing and exits 6.
- `--token-stdin` takes a token made on the server. `omb` checks that the token works on the agent routes and that it is refused on the admin routes. A token that also reaches the admin routes is refused with exit 6, because an agent machine must not hold it.
- The server address is an origin: `https` anywhere, or `http` on a private network (loopback, RFC 1918, Tailscale `100.64.0.0/10` and `*.ts.net`, `*.local`, single-label names).
- On macOS the token goes into the login keychain (service `omb-cli`, account is the server address). It is handed to `security -i` on stdin, so it is never on a command line. When the keychain cannot be used (for example no login session), `omb` says so on stderr and keeps the token in `~/.config/omb/token`, mode 0600. On other systems it always uses that file. The server address, scope, store and end date are in `~/.config/omb/config.json`, also 0600.
- `OMB_CONFIG_DIR` moves that folder. `OMB_TOKEN_STORE=file` forces the file even on macOS.

`omb status` shows the server, the scope, where the token is kept, its end date, whether the server answers, whether the token is accepted, and the agent it found above the process. It never shows the token.

A token ends on its date and never renews. Pair again with a new code or token. `openmausbot token list` and `openmausbot token revoke ID` on the server list and end tokens.

## Who is asking

`fetch`, `run`, `request`, `grants` and `audit` walk the parent process chain (`ps -o ppid=,comm=` on macOS, `/proc` on Linux) up to a known agent: `claude`, `codex`, `opencode` or `pi`, as a native binary or hosted by `node`, `bun` or `deno` (found from the script path in its arguments). The fingerprint is `sha256:<hex>` of that agent's file: the binary itself, or for a hosted agent its script, so a new Node release does not end grants and two Node tools do not share one. With no agent above the process the command exits 6 and sends nothing.

`omb` sends the fingerprint, the agent label, `PASEO_AGENT_ID`, and `PASEO_AGENT_CWD` (or the working folder). The server treats the fingerprint as part of a grant's key and the rest as attribution. The token is the real boundary.

`list`, `describe` and `get` need only the token, so a person can run them in a terminal. `--project` is sent only when given; without it the server uses the shared `default` project.

## Commands

All commands take `--json` (one envelope on stdout, errors included) and `-q/--quiet`. `--purpose` is at most 200 characters; an empty purpose is a literal, never a wildcard.

| Command | What it does |
|---|---|
| `omb pair <link-or-code> [--server URL]`, `omb pair --token-stdin --server URL` | Pair this machine. |
| `omb status` | Show the pairing and whether the server answers. |
| `omb secrets fetch <ref> <url> [options]` | Call a URL with the secret injected and print the response body. |
| `omb secrets run --env VAR=REF ... [--purpose P] [--project X] -- <program> [args]` | Run one program with the values in the named variables. |
| `omb secrets request <ref> [--purpose P] [--project X] [--exec PROGRAM --env VAR]` | File a request ahead of the call that needs it. Never returns a value. |
| `omb secrets list`, `describe <ref>`, `get <ref>` | Names, profile and a hint (public prefix and last four characters). Never a value. |
| `omb secrets grants`, `omb secrets audit [--secret REF] [--since 24h] [--decision allow\|deny\|block\|check] [--source adapter\|cli\|desktop] [--limit N] [--cursor C]` | The rows of this agent's fingerprint only. |

`set`, `rotate`, `delete`, `grant`, `revoke`, `approve` and `get --reveal` print that they are done by the person in the OpenMausBot app and exit 6. A ref matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`.

### fetch

```sh
omb secrets fetch API_KEY https://api.example.com/v1/items \
  --method POST --header 'Content-Type: application/json' --data @payload.json \
  --inject bearer --purpose sync --include
```

| Option | Meaning |
|---|---|
| `--method M` | Default `GET`. |
| `--header 'Name: value'` | Repeatable. A header that would collide with the injection is refused: `Authorization` for `bearer` and `basic-password`, the named header for `header:NAME`. |
| `--data @file`, `--data -`, `--data TEXT` | Request body. The whole request must stay under 64 KiB, so a body is at most about 48 KB. |
| `--inject` | `bearer` (default, `Authorization: Bearer`), `header:NAME`, `query:NAME` or `basic-password`. |
| `--include` | Print `HTTP <status>` and the response headers before the body. |

The URL must be `https` (`http` only to localhost) and carry no user name or password. The ref's profile must list the host in `allowedHosts`; otherwise the server refuses with exit 6. Redirects are not followed, the timeout is 60 seconds and the body is cut at 10 MiB. The body goes to stdout as bytes, and the exit code is 0 when OpenMausBot made the call, whatever the other side answered; stderr names a status of 400 or more and a cut body. With `--json`, `data` is `{status, headers, body (base64), truncated}`. The server has already replaced every form of the value in headers and body with `[omb:REF]`.

### run

```sh
omb secrets run --env API_TOKEN=API_KEY --purpose deploy -- /usr/local/bin/deploy --prod
```

1. Each `VAR=REF` is checked: a variable that steers a loader, a runtime or a network endpoint is refused (exit 2): `LD_*`, `DYLD_*`, `PATH`, `HOME`, `NODE_OPTIONS`, `PYTHONPATH`, `RUBYOPT`, the proxy and CA-bundle variables, `*_ENDPOINT_URL`, `BASH_ENV` and similar.
2. The program is found, its symbolic links are followed, and its content is hashed. Shells (`sh`, `bash`, `zsh`, ...) and launchers (`env`, `sudo`, `xargs`, `nohup`, `timeout`, ...) are refused, by name and by the `#!` line of a script (`#!/usr/bin/env python3` is a launcher: run `/usr/bin/python3 script.py` instead). Arguments are not part of the scope.
3. `omb` asks the server (`run-check`) with the path and hash. Nothing is started unless every variable is covered and the answer holds a value for each. After the answer the program is hashed again; if it changed, nothing starts and the exit code is 6.
4. The program starts directly, with no shell, and a rebuilt environment: `HOME USER LOGNAME LANG LC_* TERM TMPDIR TZ COLORTERM NO_COLOR`, a fixed system `PATH`, and the granted variables. Nothing else of the caller's environment reaches it. Standard input is passed through.
5. Output is relayed with every form of each value (raw, base64, base64url, URL-encoded, hex) replaced by `[omb:REF]`, also when a value is split across reads. Only a tail that could still become a value is held back, until more output or the exit.
6. `SIGINT`, `SIGTERM` and `SIGHUP` go to the program; `omb` does not kill it. `omb` returns the exit code of the program (128 plus the signal number when a signal ended it). A program that cannot start is exit 5.

Every upgrade of the program changes its hash and needs a new approval.

## Waiting for approval (exit 8)

When no grant covers the call, the server files a request and answers exit 8. A card is waiting in OpenMausBot, or OpenMausBot approved the ref at once. `omb` prints:

```text
approval pending for API_KEY. <the server's sentence>
A card is waiting in OpenMausBot (or OpenMausBot approved it at once). Do not retry in a loop and do not try to approve it yourself.
Wait for the notice "already approved omb secrets: API_KEY", then run the same command again. ...
```

The agent waits for that notice, then runs the same command once more. Retrying in a loop trips the rate limit (12 uncovered requests a minute per fingerprint, then 5 minutes: exit 9). `omb` never retries a request by itself.

## Exit codes and envelope

| Exit | Meaning |
|---|---|
| 0 | Done, or for `run` the program's own status |
| 2 | Invalid arguments, ref, variable, program or request |
| 3 | No such secret |
| 4 | Exists |
| 5 | The server, the token store or the ledger is not available, the token ended (pair again), or the program did not start. Nothing was released |
| 6 | Refused: a block, an unknown agent, a host not allowed, a token that is too strong, a person-only command. Settled: do not retry |
| 8 | Approval pending |
| 9 | Rate limited. Do not retry |

With `--json`, success is `{"schema_version":1,"kind":"secrets.<command>","data":...}` and failure is `{"schema_version":1,"error":"...","error_code":"...","exit_code":N}` on stdout. Without it, a failure is one `omb <command>: message` on stderr. Text that came from the server is shown with control characters removed. A refusal by the gate before an envelope (HTTP 401, 403, 5xx, a network error) is mapped to 5, 6 and 5.

`omb` fails closed: when the server cannot be reached it exits 5, never starts a program without its values, and keeps no local copy of a value.
