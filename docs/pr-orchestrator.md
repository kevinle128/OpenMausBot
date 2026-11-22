# PR orchestrator

The PR orchestrator keeps a ledger of your pull requests and merge requests.
It receives events from the git-event-hub, stores each one, and works out the
state of each PR. Your routines then choose what to do.

It is **off by default**. It starts only when `pr-orchestrator.json` exists in
the data folder and says `"enabled": true`.

## What it does in this release

- It receives events and records them. It keeps an append-only ledger for each PR.
- It runs the state machine and your routines on each event.
- It issues commands through a command bus and records the result of each one.
- **Commands are not performed yet.** Every adapter is a stub. A stub records the
  command as `skipped` ("not installed"). It never records success. Nothing
  merges, messages or runs until real adapters are installed.

Observe mode starts after the hub emits OMB event contract v1
(see [omb-event-contract.md](omb-event-contract.md)). There is no
`wait-for-binding` routine in this release, because nothing waits for an owner
binding. If you find one in a custom config, keep it deactivated.

## The fix model

OMB does not count fix rounds. A fix loop lives inside a workflow.

- A routine maps an event to the action `RunWorkflow`.
- OMB keeps **one active run per PR and workflow**. While a run is active, a new
  CI failure is recorded and starts nothing. After the run finishes (completed
  or failed), the next failure starts a new run.
- The workflow name comes from `workflows.ciFix.workflow` in the config. While
  it is empty, `run-ci-fix-workflow` does nothing.
- The workflow adapter is stubbed. Each run is recorded as `skipped` and the
  guard is freed at once.
- Messages to the owner are best-effort. If no owner session is found, the
  command is `skipped` with "owner not found".

## Routines

A routine says: when this happens, do this. It has a name, a trigger (`when`),
one or more actions (`then`) and an `active` switch.

### Listen to events

`when` narrows what the routine listens to:

| Field | Meaning |
|---|---|
| `providers` | `github`, `gitlab`. Empty: all. |
| `repos` | Globs such as `vtc/3q/**`. Empty: all. |
| `on` | Trigger names, or `"*"` for any input. |
| `all` | Predicates over the event and the PR state (facts). |

Triggers are `pr.opened`, `pr.pushed`, `pr.ci.finished`, `pr.review.finished`,
`pr.comment.created`, `pr.conflict.detected`, `pr.merged`, `pr.closed`, and the
core inputs `owner.bound`, `person.answered`, `timer.fired`, `command.issued`,
`command.finished` and `run.finished`.

A predicate is `{ "fact": "...", "op": "...", "value": ... }`. The operators
are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `truthy` and `falsy`. A fact name
may be `config.<path>` to read the config.

`once` limits how often the routine acts: `per-trigger`, `per-head` or `per-pr`.

### Choose actions

| Action | Params | What it asks for |
|---|---|---|
| `TellOwner` | `template`: `conflict`, `decisionAnswered` or `merged` | A message to the owner session, if it is found. |
| `AskPerson` | `kind`: `decision` or `command_failed` | A card in the Inbox. |
| `Notify` | `kind`: `merged`, `ready_no_auto_merge` or `review_failed` | A notice to the person. |
| `Merge` | none | Merge the PR. |
| `RefreshDetails` | none | Read the forge facts for the head. |
| `RunWorkflow` | `workflow`, `message`, `connection` (optional) | Start a workflow run. One active run per PR and workflow. |
| `Instruct` | `to`: `owner` or `new-agent`; `prompt`; `harness`, `model` (optional) | Send a free-form prompt. |

A param may be `{ "config": "<path>" }`. OMB then reads the value from the
config when it builds the command.

Two more actions are plumbing for timers: `{ "schedule": "<timer>", "afterMinutes": n }`
and `{ "cancel": "<timer>" | "all" }`.

### Ask first

Set `"askFirst": true` on an action to hold its command for your approval. OMB
stores the command as `awaiting_approval` and sends an approval card. `approve`
lets it run. `reject` finishes it as `skipped`. If the head moves or the PR ends
first, the command is finished as `skipped`. No default routine asks first.

### Switch a routine on or off

Set `"active": false` on a routine. To turn off a default routine, add its id to
`routines.deactivate`. A custom routine with the id of a default routine replaces it.

### Default routines

| Id | Sentence |
|---|---|
| `run-ci-fix-workflow` | When CI fails on the head and a fix workflow is set: run it (one active run per PR). |
| `tell-owner-conflict` | When a conflict is found on the head: tell the owner, once per head. |
| `ask-person-review-decision` | When the review needs a person: put a card in the Inbox, once per head. |
| `notify-review-chain-failed` | When the review chain failed: send a notice. The merge stays blocked. |
| `tell-owner-decision` | When you answer a decision card: send the answer to the owner. |
| `refresh-forge-before-merge` | When only the forge facts are missing: read them, once per head. |
| `merge-when-ready` | When the PR is ready, auto-merge is on and it is not quiet hours: merge. |
| `wait-for-merge-window` | When the PR is ready in quiet hours: wait for the end of them. |
| `notify-ready-without-auto-merge` | When the PR is ready and auto-merge is off: send a notice. |
| `after-merge` | When the PR is merged: send a notice, tell the owner, stop the timers. |
| `stop-timers-on-close` | When the PR closes: stop its timers. |
| `ask-person-command-failed` | When a merge or a workflow run failed: put a card in the Inbox. |

`GET /api/pr-orchestrator/routines` returns the exact sentence of each routine.

### Test a routine and read its history

`POST /api/pr-orchestrator/routines/test` is a dry run on a stored event. Send
`{ "routineId": "...", "prKey": "github:acme/widgets#42", "inputSeq": 1 }`, or send
a draft in `routine` in place of `routineId`. The answer is `{ matched, facts, actions }`.
It changes nothing. An invalid draft gives `400` with the schema message.
An unknown routine or PR gives `404`.

`GET /api/pr-orchestrator/routines/<id>/runs` lists the last 20 runs of a routine
with the result of each command.

### Limits

- At most 50 routines.
- The history view shows the last 20 runs of a routine. The ledger keeps every
  run until the retention time.
- A routine acts only on events that arrive after it is in the config.

### A custom example

Tell the owner to fix a failing CI on the 3Q repos, once per head:

```json
{
  "id": "tell-me-when-ci-fails-on-3q",
  "name": "Tell me when CI fails on 3Q",
  "active": true,
  "when": {
    "providers": ["gitlab"],
    "repos": ["vtc/3q/**"],
    "on": ["pr.ci.finished"],
    "all": [{ "fact": "trigger.ci.status", "op": "eq", "value": "failed" }]
  },
  "then": [
    {
      "do": "Instruct",
      "params": {
        "to": "owner",
        "prompt": "CI failed on {{repo}}#{{number}}: {{failedChecks}}. Read {{url}} and fix it."
      },
      "askFirst": false
    }
  ],
  "once": "per-head"
}
```

Put it in `routines.custom`. Text from the PR (CI logs, review text, titles) is
placed in a fenced block, and a fixed line says that it is data and not
instructions. A template cannot turn this off. With the stub runtime, the
`Instruct` command is recorded as `skipped`.

## The intake

The hub sends batches to the webhook listener (the same listener as the Bot API
and the webhooks).

- Path: `POST /events/<connector>`, for example `/events/github-event`.
- Headers: `X-Omb-Timestamp` (Unix seconds) and `X-Omb-Signature`
  (`sha256=` plus the hex HMAC-SHA256 of `<timestamp>.<body>`).
- Body: `{ "v": 1, "events": [ ... ] }`. At most 4 MiB. Keep the hub's `batchSize` at 50 or less.
- The clock may differ by 300 seconds (`toleranceSeconds`).

Answers:

| Status | Meaning |
|---|---|
| `200` | `{ "acked": [ids], "rejected": [{ "id", "reason" }] }`. A repeat of a batch gives the same answer and adds no row. |
| `401` | Bad signature or a timestamp outside the tolerance. Nothing is stored. |
| `404` | The core is off, or this connector is not enabled. |
| `405` | The method is not POST. |
| `413` / `400` | The body is too large or is not a valid batch. |
| `503` | The hub secret is not in the Vault, or the store could not take the batch. |

An event that breaks the contract is **rejected with a reason**, counted and not
stored. The reasons are: the event does not match the envelope or its payload
schema; the type is not one that this connector emits; the subject has the wrong
forge for this connector (a GitLab event sent to GitHub Event); or the item is a
pr-event v1 item, which OMB no longer reads. The latest reasons show in the
connector status.

The HMAC key comes only from the OMB Vault. It is never logged, returned by a
route or sent to a bot.

## The config file

`pr-orchestrator.json` in the data folder (`~/.openmausbot` by default). The
JSON Schema is `server/pr-orchestrator/config.schema.json`, and
`GET /api/pr-orchestrator/config` returns the effective config with its schema.

```jsonc
{
  "enabled": false,
  "connectors": {
    "github-event": { "use": "github-event", "enabled": false, "secretName": "GITHUB_EVENT_HUB_SECRET", "settings": { "toleranceSeconds": 300 } },
    "gitlab-event": { "use": "gitlab-event", "enabled": false, "secretName": "GITLAB_EVENT_HUB_SECRET", "settings": { "toleranceSeconds": 300 } }
  },
  "readiness": {
    "requiredChecks": [],
    "compareBase": true, "requireReview": true, "requireReviewedHead": true, "requireMergeable": true
  },
  "merge": { "auto": true, "method": "squash", "deleteBranch": true, "quietHours": null },
  "workflows": {
    "ciFix": { "workflow": "", "connection": null,
               "message": "CI failed on {{repo}}#{{number}} at {{headSha}}: {{failedChecks}}. {{url}}" }
  },
  "escalation": { "decision": true, "notifier": "inbox", "digestMinutes": 0 },
  "commands": { "maxAttempts": 6, "backoffSeconds": { "initial": 30, "max": 1800 }, "concurrency": 4 },
  "retention": { "endedPrDays": 180, "receivedEventDays": 90 },
  "routines": { "useDefaults": true, "custom": [], "deactivate": [] },
  "overrides": []
}
```

- `quietHours` looks like `{ "start": "22:00", "end": "07:00", "timeZone": "Asia/Saigon" }`.
- `overrides` change settings for some repos. Later entries win. Objects merge,
  arrays replace: `{ "match": { "providers": ["gitlab"], "repos": ["vtc/3q/**"] }, "set": { "merge": { "auto": false } } }`.
- **Live reload.** OMB reads the file again when it changes. No restart is
  needed. An invalid file keeps the last valid config and shows `configError` in
  the status.
- **Versions.** The version of the config is a hash of its effective content.
  Each new version is stored once, and each ledger row carries the version that
  was in force.
- A file added later takes effect on the next request.

To try it, write `{"enabled": true, "connectors": {"github-event": {"use": "github-event", "enabled": true}}}`.

## Vault secrets

Each hub connector has one Vault secret, the key that signs its batches:

| Connector | Secret name |
|---|---|
| GitHub Event | `GITHUB_EVENT_HUB_SECRET` |
| GitLab Event | `GITLAB_EVENT_HUB_SECRET` |

Make a long random value for each. Save it in **Settings → Vault**. Put the same
value in the hub as the `secretEnv` of the sink. Names match without regard to
case or punctuation. Only a team secret counts, not a secret that belongs to one
person. Without the secret, the connector answers `503`.

## Event connectors

A connector brings events into OMB. It is a declaration plus a delivery adapter.
The two built-in ones are **GitHub Event** and **GitLab Event**, fed by the hub.
Each is an instance with its own path, secret and `settings`.

| Connector | Path | Emits |
|---|---|---|
| `github-event` | `/events/github-event` | The eight `pr.*` types, forge `github` only. |
| `gitlab-event` | `/events/gitlab-event` | The eight `pr.*` types, forge `gitlab` only. |

Both are disabled until the `connectors` key enables them.
`GET /api/pr-orchestrator/connectors` lists each instance with its event types,
payload schemas, intake path, `secretPresent` and a 24 hour status
(`lastEventAt`, `events24h`, `lastError`, `signatureFailures24h`).

To add a connector:

1. Write its declaration: id, title, emitted event types, subject rule, settings schema and secret.
2. Write its delivery adapter (inbound HTTP, a subscription or a poll).
3. Test it with the conformance kit (`describeConnectorConformance`).
4. Add one line to `server/pr-orchestrator/connectors/index.ts`.

No core file changes. The event form is defined in [omb-event-contract.md](omb-event-contract.md).
**The hub must emit that contract.** Until it does, both connectors reject every hub event.

## Hub sinks

Use two `omb` sinks in the hub config, one per app. Each has its own URL,
secret and provider filter:

```yaml
sinks:
  - type: omb
    url: https://<mac mini tailnet host>:8451/events/github-event
    secretEnv: OMB_GITHUB_SECRET
    batchSize: 20
    filter:
      providers: [github]
  - type: omb
    url: https://<mac mini tailnet host>:8451/events/gitlab-event
    secretEnv: OMB_GITLAB_SECRET
    batchSize: 20
    filter:
      providers: [gitlab]
```

Check the hub's `defaults.reviewAuthors`. It must list the review bot account.
Without it the hub drops every `review.finished` event and no PR can become ready.

## Admin routes

All routes need the `admin` scope. Any other caller gets `403`. They are read-only,
except the dry-run routine test.

| Route | Gives |
|---|---|
| `GET /api/pr-orchestrator/status` | `{ enabled, configured, configVersion, configError, secretPresent, counts, lastReceivedAt }`. Without a config file: `{ enabled: false, configured: false }`. |
| `GET /api/pr-orchestrator/prs?state=<state>` | Up to 200 PRs, newest first. An unknown `state` gives `400`. |
| `GET /api/pr-orchestrator/pr?key=<key>` | `{ record, ledger, commands, timers }`. The key looks like `github:owner/repo#123`. A bad key gives `400`, an unknown PR gives `404`. |
| `GET /api/pr-orchestrator/config` | The effective config, its version, its error and its schema. |
| `GET /api/pr-orchestrator/connectors` | Each connector instance and its status. |
| `GET /api/pr-orchestrator/routines` | The resolved routines with their sentence and source. |
| `GET /api/pr-orchestrator/routines/<id>/runs` | The last 20 runs of a routine. |
| `POST /api/pr-orchestrator/routines/test` | A dry run of a routine on a stored event. |

Payload fields that come from a PR (titles, CI text, review text) are data. A
client must show them as text.

## Replay

`scripts/pr-orchestrator-replay.ts` runs stored or exported events through the
current routines and prints the result as JSON.

```sh
node --experimental-strip-types scripts/pr-orchestrator-replay.ts --events events.ndjson [--config config.json] [--mode simulated|recorded]
node --experimental-strip-types scripts/pr-orchestrator-replay.ts --db pr-orchestrator-copy.db --verify
node --experimental-strip-types scripts/pr-orchestrator-replay.ts --db pr-orchestrator-copy.db --export > events.ndjson
```

**Work on a copy of `pr-orchestrator.db`. Never point `--db` at the live file.**

## Safety

- It is off by default. Without `pr-orchestrator.json` (and `pr-orchestrator.db`),
  nothing runs, no database is opened and `/events/<connector>` answers `404`.
- A disabled connector answers `404` too. The Bot API and the webhook paths keep working.
- A workspace move pauses the core with the other automations and starts it again after the move.
- To remove the feature, delete the two files. They are harmless if left behind.
