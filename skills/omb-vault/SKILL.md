---
name: omb-vault
description: "Use API keys, tokens and other secrets from the OpenMausBot (OMB) Vault through the `omb secrets` command, without ever seeing or printing a value. Use when a task needs a credential: an API call with a key, a deploy or a tool that reads a token from its environment, or a .env value."
when_to_use: "Invoke when a task calls an API that needs a key, runs a program that needs a token, meets a .env file, or the person mentions a secret, key, token, password or the Vault."
keywords: [secrets, vault, credentials, api-key, token, dotenv, env-file, omb, openmausbot]
---

# omb-vault: use secrets from the OpenMausBot Vault

The person keeps secrets in the Vault of their OpenMausBot (OMB) server. You never hold a value. You ask OMB to use it for you, in one of two ways:

| You need | Command | Where the value goes |
|---|---|---|
| An HTTPS request with the secret in it | `omb secrets fetch REF URL [options]` | OMB puts it into the request and gives you the answer with the value struck out. It never reaches your machine. |
| A program that reads the secret from its environment | `omb secrets run --env VAR=REF -- /abs/path/program [args]` | Only into that one program's environment. Its output comes back with the value struck out. |

There is no third way. Never put a secret into a command line, a file, a prompt, a URL you print, or a `${secret:...}`-style placeholder: those are refused.

## Before you start

1. `omb status` shows whether this machine is paired with an OMB server. If `omb` is missing or not paired, stop and tell the person: "Pair this computer in OpenMausBot: Settings → Vault → Install skill for harnesses." Do not try to pair it yourself.
2. `omb secrets list` shows the names (refs) you may ask for. `omb secrets describe REF` shows a ref's profile, including the hosts `fetch` may reach. Neither shows a value.
3. If the ref you need is not there, ask the person to add it in OpenMausBot (Settings → Vault), and for `fetch`, to list the API's host under "Allowed hosts". Do not invent a ref name.

## fetch: call an API with the secret

```sh
omb secrets fetch GITHUB_TOKEN https://api.github.com/user --purpose "read the GitHub user"
omb secrets fetch OPENAI_API_KEY https://api.openai.com/v1/models --inject bearer --purpose "list models"
omb secrets fetch SENTRY_TOKEN https://sentry.io/api/0/projects/ --inject header:Authorization --include
omb secrets fetch API_KEY https://api.example.com/v1/items --method POST \
  --header 'Content-Type: application/json' --data @payload.json --purpose "create an item"
```

- `--inject` is `bearer` (default), `header:NAME`, `query:NAME` or `basic-password`. Do not also send the header you inject.
- Only `https` (plain `http` only to localhost), no redirects followed, 60 s timeout, body cut at 10 MiB, request body at most about 48 KB.
- Exit 0 means OMB made the call, whatever status the API answered; read the body. Exit 6 with "host not allowed" means the person must add the host to the ref in OMB.

## run: give the secret to one program

```sh
omb secrets run --env GH_TOKEN=GITHUB_TOKEN --purpose "list PRs" -- /opt/homebrew/bin/gh pr list
omb secrets run --env PGPASSWORD=DB_PASSWORD --purpose "back up the db" -- /usr/bin/pg_dump -h db.local app
```

- Give the program by absolute path. A shell (`sh`, `bash`, `zsh`), a launcher (`env`, `sudo`, `xargs`, `nohup`, `timeout`) or a script whose `#!` line is `/usr/bin/env ...` is refused. For a script, run its interpreter: `-- /usr/bin/python3 script.py`.
- Variables that steer a loader, runtime or proxy (`PATH`, `HOME`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, proxy and CA variables) cannot carry a secret.
- The program gets a clean environment with only the system basics and the granted variables. Its output is relayed with the value struck out.
- The approval covers that program's exact content. After the program is upgraded, the next call needs a new approval.

## Approval (exit 8)

The first call for a ref, purpose and agent files a request. OMB either approves it at once, and the same call then goes through, or shows the person a card. In the second case `omb` exits 8 and prints what to wait for.

- Do not retry in a loop, and never try to approve, grant or reveal a secret yourself: those commands are the person's and exit 6.
- Wait for the notice `already approved omb secrets: REF`, then run the same command once more.
- Keep `--purpose` short and the same each time for the same job: a new purpose is a new approval.

## Exit codes

| Exit | Meaning | What you do |
|---|---|---|
| 0 | Done (`run`: the program's own status) | Go on |
| 2 | Wrong arguments, ref, variable or program | Fix the command |
| 3 | No such secret | Ask the person to add it in OMB |
| 5 | Server, token store or program not available, or the pairing ended | Tell the person; nothing was released |
| 6 | Refused (host not allowed, unknown agent, person-only command) | Do not retry; tell the person why |
| 8 | Approval pending | Wait for the notice, then run the same command once |
| 9 | Rate limited | Stop and tell the person |

## .env files

Do not copy a value out of a `.env` file into a command, a message or another file. If a task needs a value from a `.env` file regularly, suggest that the person moves it into the OMB Vault, then use `fetch` or `run`.

## Never

- Print, log, echo, write or summarize a secret value, even part of one.
- Use `omb secrets get --reveal`, `grant`, `approve`, `set`, `rotate` or `delete`: the person does these in OpenMausBot.
- Pass a secret on a command line, in a URL you print, or through a shell.
