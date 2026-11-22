# OMB event contract v1

OpenMausBot defines the form of an incoming event. Every connector must emit
this form. The core has no per-source mapping code: an event that does not
conform is rejected with a reason, counted and logged, and never stored.

Version 1 may gain optional fields and new event types. Removing or renaming a
field or a type needs version 2. A consumer ignores fields that it does not
know.

The files are in `server/pr-orchestrator/contract/`:

- `omb-event.v1.json`: the JSON Schema (2020-12), the envelope plus one payload
  schema per event type under `$defs.payloads`.
- `omb-event.v1.ts`: the TypeScript types, `CONTRACT_EVENT_TYPES` and
  `payloadSchemaOf`.
- `validate.ts`: `createOmbEventValidator()`, `checkBatch()`.
- `conformance/`: the conformance kit (fixtures, `checkConformance`,
  `describeConnectorConformance`).

## Envelope

| Field | Type | Rule |
|---|---|---|
| `v` | `1` | Required. |
| `id` | string, 1 to 200 characters | Required. Stable across retries of the same fact. It is the dedupe key within its connector. |
| `source.connector` | string, `^[a-z0-9]+(-[a-z0-9]+)*$` | Required. The connector definition id that produced the event, for example `github-event`. |
| `type` | string, `^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$` | Required. A contract event type. |
| `occurredAt` | string, `date-time` | Required. RFC 3339, UTC. |
| `subject` | object | Required. A PR subject or a generic subject. |
| `correlation` | object of strings | Optional join keys, for example `prUrl` and `headSha`. |
| `data` | object | Required. It must match the payload schema of `type`. |

The envelope schema does not branch on `type`. The validator picks the payload
schema by `type`, so a new type is one entry under `$defs.payloads` and one row
in `CONTRACT_EVENT_TYPES`.

### Subjects

- PR subject: `{ "kind": "pr", "forge": "github" | "gitlab", "repo": string, "number": integer >= 1 }`.
  `repo` is `owner/name` on GitHub and the full project path on GitLab.
  `number` is the pull request number or the merge request iid.
- Generic subject: `{ "kind": string, "id": string, "label"?: string }`. `kind`
  is not `pr` and matches `^[a-z][a-z0-9_]*$`. `id` has 1 to 200 characters.

The key of a PR subject is `<forge>:<repo in lower case>#<number>`. The key of
any other subject is `subject:<connector instance>:<kind>:<id>`.

## Event type naming

A type is `<domain>.<object>.<past-tense verb>` in lower case, with dots. The
domain fixes the subject kind: `pr.*` needs a `pr` subject. A new domain is a
contract change, and the contract is extended before the connector follows.

## Event types

Every `pr.*` payload carries the PR common fields `headSha`, `baseRef`,
`branch`, `author` and `url`. Each is a string or null, and each is required.

| Type | Payload fields on top of the common fields |
|---|---|
| `pr.opened` | `title` (string), `draft` (boolean), `reopened` (boolean) |
| `pr.pushed` | `before` (string or null), `after` (string) |
| `pr.ci.finished` | `check`: `source`, `scope` (`workflow`, `suite`, `job`, `status`, `pipeline`), `name`, `status` (`passed`, `failed`, `cancelled`, `skipped`), `url`, `runId?`, `failedJobs` (`{ id, name, url, stage?, conclusion? }[]`, never null) |
| `pr.review.finished` | `review`: `source`, `status` (`success`, `needs-person`, `failed`), `reviewedSha`, `rounds`, `maxRounds`, `items` (`{ round, scope (full, commit), real, fixed, unresolved }[]`), `commenter`, `commentId`, `commentUrl` |
| `pr.comment.created` | `comment`: `id`, `url`, `commenter`, `edited`, `body` (cut to 32768 bytes), `bodyTruncated`, `markerError?` |
| `pr.conflict.detected` | `conflict`: `state` (the raw forge value) |
| `pr.merged` | `merge`: `commitSha` (string or null), `mergedBy` (string or null) |
| `pr.closed` | `closedBy` (string or null) |

## Delivery batch

An inbound HTTP connector delivers `{ "v": 1, "events": [ ... ] }`. A batch
without `v: 1` or without an `events` array is refused as a whole.
`checkBatch()` makes this check. Each item is then validated alone.

## Validation order

For each item, the first failure rejects it with one short reason:

1. The envelope, against `omb-event.v1.json`: `envelope: <path> <message>`.
2. The payload of `type`: `unknown type <type>` or `type <type>: <path> <message>`.
3. The connector's declaration, when the item comes from a connector:
   - `type <type> is not emitted by <connector>`;
   - `source.connector is <x>, expected <connector>`.
4. The subject kind of the domain: `type <type> needs a <kind> subject`.
5. The connector's `subjectRule`: `subject.<field> is <x>, expected <y>`.

`createOmbEventValidator().check()` runs steps 1, 2 and 4. `checkFor()` runs all
five.

## Conformance kit

`conformance/fixtures/valid/<type>.json` holds one complete event for each
type. `conformance/fixtures/invalid/*.json` holds `{ "event", "reason" }` pairs,
and the reason is the exact text that the validator gives. A connector's tests
call `describeConnectorConformance(definition, { samples, deliver? })`. It
checks that every `emits` type exists in the contract and that every sample
passes the connector's declaration. With `deliver`, it also checks that a
delivered batch of the samples is accepted and that each invalid fixture is
rejected with its reason.

The kit imports `vitest`. Import it from test files only.

## Mapping from pr-event v1

The git-event-hub `omb` sink emits this contract directly. The change from its
pr-event v1 items is mechanical:

| pr-event v1 | OMB event contract v1 |
|---|---|
| `v: 1` | `v: 1` |
| `id` (`<provider>:<delivery>:<index>`) | `id` (unchanged) |
| `provider` | `subject.forge`; and `source.connector` is `github-event` or `gitlab-event` |
| `repo`, `number` | `subject.repo`, `subject.number` (`subject.kind` is `pr`) |
| `kind`: `opened`, `pushed`, `ci.finished`, `review.finished`, `comment`, `conflict`, `merged`, `closed` | `type`: `pr.opened`, `pr.pushed`, `pr.ci.finished`, `pr.review.finished`, `pr.comment.created`, `pr.conflict.detected`, `pr.merged`, `pr.closed` |
| `headSha`, `baseRef`, `branch`, `author` | `data.headSha`, `data.baseRef`, `data.branch`, `data.author` |
| `occurredAt` | `occurredAt` |
| `data.url` for `opened`, `pushed`, `conflict`, `merged`, `closed` | `data.url` (the web address of the pull request, or `null`); also `correlation.prUrl` |
| The URL of `ci.finished`, `review.finished`, `comment` | `data.check.url`, `data.review.commentUrl`, `data.comment.url`. For these kinds, `data.url` is the web address of the pull request when it is known, else `null`. Do not put the check, review or comment URL in `data.url`. |
| `headSha` (when not null) | also `correlation.headSha` |
| `opened.title`, `.draft`, `.reopened` | `data.title`, `data.draft`, `data.reopened` |
| `pushed.before`, `.after` | `data.before`, `data.after` |
| `ci.finished.source`, `.scope`, `.name`, `.status`, `.url`, `.runId`, `.failedJobs` | `data.check.source`, `.scope`, `.name`, `.status`, `.url`, `.runId`, `.failedJobs` |
| `review.finished.*` | `data.review.*` (same names) |
| `comment.commentId`, `.url`, `.commenter`, `.edited`, `.body`, `.bodyTruncated`, `.markerError` | `data.comment.id`, `.url`, `.commenter`, `.edited`, `.body`, `.bodyTruncated`, `.markerError` |
| `conflict.state` | `data.conflict.state` |
| `merged.mergeCommitSha`, `.mergedBy` | `data.merge.commitSha`, `data.merge.mergedBy` |
| `closed.closedBy` | `data.closedBy` |

The conformance fixtures for PR events are written in this shape, so the hub can
test against the same files.
