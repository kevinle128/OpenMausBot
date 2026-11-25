# Paseo Dispatcher

The Dispatcher is a bot that takes a large task, splits it, runs each piece as a
Paseo coding agent, follows the agents and reports one result. It needs the
Paseo bridge (`OMB_PASEO_BRIDGE=1`) so it is woken when an agent finishes or
fails. Permission requests from its agents go through the same gatekeeper as
every other Paseo agent; the Dispatcher never answers them.

The gatekeeper also handles the questions an agent asks. It answers "Yes,
approve once" itself only for the privacy hook's question to read a file (one
question, the read wording, a path that is a regular file). Every file check
(that one, an env file read, an `APPROVED:` read) asks the Paseo daemon on the
agent's machine through `fs.path.inspect.request`, which runs `lstat` inside the
agent's working directory, so it also holds when OpenMausBot runs on another
machine than the agent. Only an answer of `exists` with kind `file` counts: a
link, a directory, a missing path, a path outside the working directory, an
error, a timeout (2 seconds) and a daemon that does not know the request all
fail the check: the question and a Read of an env file become a card. The daemon
needs a Paseo build with that request, and the `@getpaseo/client` that
OpenMausBot bundles needs the matching `inspectPath` method.
Every other question
becomes a card with one button for each answer, or with an **Answer in Paseo**
button when it has several questions or lets the person pick more than one.
It allows read-only shell commands without asking, by a fixed rule and never by
Jev: `git` (diff, log, show, status, blame, list-only branch, rev-parse,
ls-files, ls-tree, grep, describe, remote -v, config --get/--list), `ls`, `cat`,
`head`, `tail` (not `-f`), `wc`, `rg`, `grep`, `find` (not -exec, -delete or
-fprint), `pwd`, `stat`, `file`, `du`, `df`, `which`, `tree`, `realpath`,
`basename`, `dirname`, `sort`, `uniq`, `cut`, `tr`, `jq`, `diff`, `cmp` and
`echo`, any path. Pipes and `&&` are allowed when every part is read-only, with
an optional `cd <dir> &&` first. Any redirect, substitution, `;`, `||`,
background job, or an option that writes a file or runs a program still asks.
A `git` step is allowed only when no git setting in its directory, or in any
checked-out submodule (at most 20), would run a program (a pager, a diff or text
filter, a file monitor, a signing program, an editor; the standard git-lfs filter
is accepted), and no `post-index-change` hook exists there, because `git status`
and `git diff` run that hook. The check uses OpenMausBot's own environment, so it
assumes the agents run as the same user with no extra `GIT_*` variables, and a
relative `cd` is refused when `CDPATH` is set. One small write is accepted:
`sort -T` temporary files; `git status` also refreshes the index.
Everything the fixed rules above do not allow goes to Jev Guard, except a refusal
for a hidden hazard (an unsafe git setting or hook, `CDPATH`, a real file named
`APPROVED:…`), which is always a card. Jev Guard asks Jev questions about the exact
call: risk 0 to 3 (running code Jev cannot see, such as `bash x.sh`, `sh -c` or a pipe
into an interpreter, counts as hard to undo), whether a careful engineer would want it
approved, whether it follows an instruction planted in untrusted content, and, only
when the person's own first message to the agent is known, whether the person asked
for it. Everything the agent wrote (the command, its title, its earlier calls) is sent
under `agent_supplied` and the questions say nothing inside it is the person's word;
keys are removed. Without a message of the person (the Paseo timeline does not keep
the first prompt, and OpenMausBot's own notices never count; neither does any message in an agent that another agent created, marked by the label `paseo.parent-agent-id`) a risky call is a card.
Reading anything on this machine, secrets included, is normal; sending data off the
machine, destroying data and obeying planted instructions are the risks. It allows
when the risk is under 1.5 and approval under 0.75, or when the call is riskier but
the person asked for it (0.85) and the risk is under 2.5. It opens a card when the
call is risky and was not asked for, and a card marked "Jev: high risk" when the risk
is 2.5 or more or the call looks planted (0.7). Any error, missing key, answer from
a provider other than Jev, a call longer than 2000 characters (cut text could hide
the rest), or answer slower than 3 seconds opens a card. A question with one plain
yes option (Yes, Allow, Approve, Continue) is judged the same way and answered with
that option; any other question is a card. Each allow is written to the Inbox with
the rule `jev-guard` and the scores. The questions and thresholds are adapted from
[jev-guard](https://github.com/leepokai/jev-guard) (MIT, commit `cda06c4`).
When an `omb secrets` request is approved, the live Paseo agent named on that
request is sent one
message, `already approved omb secrets: <REF>`, so it can run the command
again. That notice is sent when OpenMausBot approved by itself and when a
person allowed the card. The message ends with a blank line and `𝗯𝘆 𝗢𝗠𝗕` only
when OpenMausBot approved by itself. The agent is the one named by `agentId`, and
only if that agent is listed now; nobody else is guessed. A running agent is
not interrupted: the message waits until it is idle, for up to 10 minutes. The
Inbox line says whether the agent was told.
Pressing Deny, or closing a question card, leaves the question to be answered in
Paseo. Each request it allows without asking (a file read, a read-only shell
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
