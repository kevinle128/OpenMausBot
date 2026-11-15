# Paseo Dispatcher

The Dispatcher is a bot that takes a large task, splits it, runs each piece as a
Paseo coding agent, follows the agents and reports one result. It needs the
Paseo bridge (`OMB_PASEO_BRIDGE=1`) so it is woken when an agent finishes or
fails. Permission requests from its agents go through the same gatekeeper as
every other Paseo agent; the Dispatcher never answers them.

The gatekeeper also handles the questions an agent asks. It answers "Yes,
approve once" itself only for the privacy hook's question to read a file (one
question, the read wording, a path that is a regular file). Every other question
becomes a card with one button for each answer, or with an **Answer in Paseo**
button when it has several questions or lets the person pick more than one.
It also allows `ak secrets run` (a single command with known flags whose `--env
VAR=REF` refs are all secrets OpenMausBot keeps for the Paseo bot) and the
matching exec request in the `ak` inbox, for 24 hours and for that program and
variable only. A ref OpenMausBot does not own, and every `ak` write command,
still ask the person; the secret request card's allow button reads "Allow 24h".
It allows read-only shell commands without asking, by a fixed rule and never by
Jev: `git` (diff, log, show, status, blame, list-only branch, rev-parse,
ls-files, ls-tree, grep, describe, remote -v, config --get/--list), `ls`, `cat`,
`head`, `tail` (not `-f`), `wc`, `rg`, `grep`, `find` (not -exec, -delete or
-fprint), `pwd`, `stat`, `file`, `du`, `df`, `which`, `tree`, `realpath`,
`basename`, `dirname`, `sort`, `uniq`, `cut`, `tr`, `jq`, `diff`, `cmp` and
`echo`, any path. Pipes and `&&` are allowed when every part is read-only, with
an optional `cd <dir> &&` first. Any redirect, substitution, `;`, `||`,
background job, or an option that writes a file or runs a program still asks.
When an `ak` secret request is approved, by OpenMausBot or by the person on the
card, the Paseo agent that asked is sent one message, `already approved ak
secrets: <REF>`, so it can run the command again. The agent is the one seen
running `ak secrets` for that ref in the last 10 minutes; with none or several,
nobody is told. A running agent is not interrupted: the message waits until it is
idle, for up to 10 minutes. The Inbox line says whether the agent was told.
Pressing Deny, or closing a question card, leaves the question to be answered in
Paseo. Each request it allows without asking (a file read, a read-only `ak secrets`
command, the hook's read question, a Vault secret request) is written as one
already read line listed in the Inbox, headed "OpenMausBot tự duyệt", with no
notification. The same agent and target within an hour share one line with a
count. The line never holds a secret value or file content. On a server with a
team, the history is not written.

## Set it up (once)

1. **Add the preset.** In **Templates → Import**, choose
   `docs/presets/paseo-dispatcher.json`, then pick **Paseo Dispatcher** under
   **Starting role** when you add a bot. A preset from a file brings its skill
   switched off: open the new bot's Skills and switch on **paseo-dispatch**
   after reading it.
2. **Add the Paseo MCP server by hand.** A preset cannot carry an MCP server,
   and a Paseo server lets a bot start agents that run commands on this
   computer, so OpenMausBot does not add it for you. Open **Plugins → MCP
   servers → Add server** and paste:
   - URL: `http://127.0.0.1:6767/mcp/agents` (the daemon's own port; use the
     host and port of `OMB_PASEO_URL` if you changed it).
   - With a daemon password, one header: `Authorization` with the value
     `Bearer <the daemon password>`. The local credential file is not accepted
     on this endpoint.
   Wait for *Connected*, then under **Bot access** let only the Dispatcher use
   it.
3. Keep `OMB_PASEO_BRIDGE=1` set for OpenMausBot.

## How it works

- The bot learns its own thread id from `list_threads`: the row for the
  conversation it speaks in is marked `yours, this conversation`.
- It creates every agent with the label `omb-dispatcher-thread=<thread id>`.
- When a labelled agent finishes or fails, the bridge starts a run of the
  Dispatcher in that thread with the agent id, title, status, reason and a
  short, secret-scrubbed summary of the agent's last message. If the
  Dispatcher is busy, the run waits for its turn. Agents without the label
  wake nobody.
- Only a bot made from this preset is woken. The bridge reads the package id
  and preset key that OpenMausBot stamps on a bot when a preset is applied, so
  a label that names another bot's thread, or a bot set up by hand without the
  preset, wakes nobody. One thread is woken at most 20 times in 10 minutes;
  later reports in that window are logged once and dropped.
- The number of agents is not limited. The Dispatcher says how many it
  started; watch the computer's load while it works.

Source: `server/paseo/dispatcher-wake.ts`.
