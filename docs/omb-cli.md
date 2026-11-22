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

## Install the skill

The `omb-vault` skill tells an agent how to use `omb secrets fetch` and `omb secrets run`. `omb` copies it into the personal skill folder of each agent harness on this machine. These commands need no pairing and no agent above the process.

```sh
omb skill list
omb skill install --harness claudeAgent,codex
omb skill install --all
```

- `omb skill list` shows, for each harness, the folder and one status: `installed`, `outdated` (the text differs), `missing`, `unsupported` or `refused`. `--json` gives `{schema_version, kind: "skill.list", data: {rows}}`. A row has `harness`, `label`, `folder`, `status`, `recognised` and sometimes `note`.
- `omb skill install` writes `<folder>/omb-vault/SKILL.md` and reports `installed`, `updated`, `unchanged` or `skipped` (kind `skill.install`). The file is written to a temporary file and renamed, with mode 0644. Folders are made with mode 0755. A harness id is an OpenMausBot driver kind, such as `claudeAgent`, `codex`, `opencodeGo` or `piAgent`; `omb skill list` shows all of them.
- Harnesses that share a folder, such as `codex` and `devinAgent` with `~/.agents/skills`, are written once and each is reported. DeepSeek documents no literal skill folder, so its row is `skipped`.
- A folder moves when the harness documents a variable for it and the value is an absolute path: `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `COPILOT_HOME`, `QWEN_HOME`, `KIMI_CODE_HOME`, `CLINE_DIR`, `HERMES_HOME`, `VIBE_HOME` and `XDG_CONFIG_HOME` (Muse Code).
- `omb` never writes through a symbolic link at `omb-vault` or `SKILL.md`. That row is `refused` and the exit code is 6.
- Exit codes: 0 when every row is `installed`, `updated`, `unchanged` or `skipped`; 2 for an unknown harness id; 5 when a write fails; 6 when a row is `refused`.

`recognised` is `true` when the parent-process walk in [Who is asking](#who-is-asking) can name that agent. Every harness with a skill folder is recognised. DeepSeek has no skill folder, so it is not.

### From the app

In Settings → Vault, **Install skill for harnesses** opens a list of the harnesses (the rows of `omb skill list`) with a check box on each row and **Select all**. A row shows `installed`, `outdated`, `missing` or `unsupported`, and the reason when a harness is unsupported. One **Install** button does the work, and a second click updates in place. The result of each row shows after it (`installed`, `updated`, `unchanged`, `skipped`, `refused` or `failed`).

- **Desktop app (macOS and Linux):** it installs on the computer where the window is open, because the agents run there, whichever server or home page the main window shows. The page sends harness ids only. The app copies its bundled `omb` to `~/.local/bin/omb` (mode 0755), writes the embedded skill and adds the Claude hook. Main accepts the call from the main window's own page and its verified saved-server and home pages only, and an install also needs a click in the focused window.
  - On the app's own server, it pairs this computer with that server when `omb` is not paired: the window asks the server for a pairing code with the `secrets` scope only, and the app runs `omb pair` in its own process, so the code is on no command line. A pairing with another server stays, and the dialog says so.
  - On another server's page, or while connected to another server, the app does not pair. If `omb status` shows no pairing, the dialog shows the next step with that server's own address: pair in the server's Settings → Vault, or run `omb pair --token-stdin --server ORIGIN < FILE` with a token made by `openmausbot token create NAME --scope secrets --out FILE`.
  - The Claude hook points at `~/.local/bin/omb` and at the `node` found on `PATH`.
- **Desktop app on Windows:** the dialog says the app cannot install there.
- **Plain browser:** the dialog installs on the computer that runs the server, through `GET` and `POST /api/secrets/admin/skill-install` (admin only; body `{ "harnesses": ["codex"] }`). For another computer it shows `omb skill install --harness ...` and, on request, a new `secrets`-scope pairing link for `omb pair`. The link shows once and is not stored. The server bundle ships `bin/omb.mjs` beside `index.js` (desktop app, container image and npm package); a build without it answers 503.
- The button is not shown on a Team Cloud, where the secrets routes answer 503.

### Guard hook for Claude Code

`omb skill install` with `claudeAgent` also adds a `PreToolUse` hook to `settings.json` in the Claude folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`):

```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "\"/abs/node\" \"/abs/omb.mjs\" hook claude-pretooluse" }] }
```

- The entry is added once. A later run brings the paths of an older `omb` entry up to date and keeps every other key and hook. The file is written atomically, and a symbolic link to it is followed.
- A `settings.json` that is not valid JSON, or has `hooks` in an unexpected shape, is not changed. The `claudeAgent` row carries a note.
- `omb hook claude-pretooluse` reads the hook event from stdin. If a string anywhere in `tool_input` holds a secret placeholder (the substitution syntax of some agent tools), it answers with `permissionDecision: "deny"`. The reason names the commands to use, `omb secrets fetch` or `omb secrets run`, and the ref names found, never more of the text. In every other case it prints nothing and exits 0, also when stdin is empty or not JSON.

## Who is asking

`fetch`, `run`, `request`, `grants` and `audit` walk the parent process chain (`ps -o ppid=,comm=` on macOS, `/proc` on Linux) up to a known agent: one of the harnesses of `omb skill list` that has a skill folder (`claude`, `codex`, `opencode`, `pi`, `gemini`, `antigravity`, `cursor`, `copilot`, `grok`, `qwen`, `kimi`, `kiro`, `droid`, `cline`, `devin`, `hermes`, `omp`, `vibe`, `command-code`, `muse`). The agent is a native binary, or a script hosted by `node`, `bun`, `deno` or `python` (found from the script path in its arguments). The Cursor launcher starts its bundled Node under the name `cursor-agent` or `agent`; that process counts only through the `cursor-agent/versions/<version>/index.js` script it hosts. The fingerprint is `sha256:<hex>` of that agent's file: the binary itself, or for a hosted agent its script, so a new Node release does not end grants and two Node tools do not share one. With no agent above the process the command exits 6 and sends nothing.

`omb` sends the fingerprint, the agent label, `PASEO_AGENT_ID`, and `PASEO_AGENT_CWD` (or the working folder). The server treats the fingerprint as part of a grant's key and the rest as attribution. The token is the real boundary.

`list`, `describe` and `get` need only the token, so a person can run them in a terminal. `--project` is sent only when given; without it the server uses the shared `default` project.

## Commands

All commands take `--json` (one envelope on stdout, errors included) and `-q/--quiet`. `--purpose` is at most 200 characters; an empty purpose is a literal, never a wildcard.

| Command | What it does |
|---|---|
| `omb pair <link-or-code> [--server URL]`, `omb pair --token-stdin --server URL` | Pair this machine. |
| `omb status` | Show the pairing and whether the server answers. |
| `omb skill list`, `omb skill install (--harness ID[,ID...] \| --all)` | Show or write the `omb-vault` skill in the skill folders of the agent harnesses. |
| `omb hook claude-pretooluse` | Claude Code `PreToolUse` hook. See [Install the skill](#install-the-skill). |
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

When no grant covers the call, the server files a request. If OpenMausBot approves the ref at once (a ref kept to the Paseo bot or to every bot), the same call goes through: no exit 8, and the agent need not run it again. Otherwise the server answers exit 8 and a card is waiting in OpenMausBot. `omb` prints:

```text
approval pending for API_KEY. <the server's sentence>
A card is waiting in OpenMausBot (or OpenMausBot approved it at once). Do not retry in a loop and do not try to approve it yourself.
Wait for the notice "already approved omb secrets: API_KEY", then run the same command again. ...
```

For an approval by a person, the agent waits for that notice, then runs the same command once more. Retrying in a loop trips the rate limit (12 uncovered requests a minute per fingerprint, then 5 minutes: exit 9). `omb` never retries a request by itself.

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
