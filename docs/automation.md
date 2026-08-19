# Automation and machine-readable state

How scripts and other programs should read agent-mail's state. Every interface
here is read-only: none of them scan processes, prune registrations, or mutate
claims or leases.

## The presence snapshot

The daemon republishes the pid-verified live registry to
`~/.claude/agent-mail/presence.json` every 10 seconds. This snapshot lets
latency-sensitive readers skip the process scan. It is a presentation cache
with a 30-second TTL, never a routing input.
`send_mail`, `list_sessions`, and both dashboards keep reading the registry
directly. That tick is also what prunes registrations whose process has exited.

Automation should use
`agent-mail listeners --project <dir> --no-sync --json`, not read the snapshot
file directly. The command returns a versioned JSON object with `source`,
`fresh`, `generatedAt`, and raw `sessions` (including `sessionId`, `cwd`,
`client`, `capabilities`, `inboundPolicy`, `muted`, `lastSeen`,
`lastInboxPoll`, and `started`).
`--no-sync` never scans processes, prunes registry entries, or falls back to a
different source. If the daemon snapshot is missing, malformed, or older than
30 seconds, it returns `fresh: false` with an empty `sessions` array. This mode
is suitable for conservative advisory routing; it is not proof of delivery or
attention.

## Aggregate state

For a normalized cross-surface view, use
`agent-mail state --no-sync --json` (optionally `--project <dir>`) or
`GET /api/v1/state?project=<dir>`. Schema version 1 includes normalized
presence with process identity and freshness, coordination entries with owner
status and conditions, transfer requests, recent canonical message IDs and read
state, routes, counts, logs, and source provenance. The CLI without `--no-sync`
asks the daemon first and falls back to the same filesystem-snapshot reader.
Consumers must inspect the `freshness` fields rather than treating an old
snapshot as negative liveness evidence.

Schema-v1 top-level fields are `schemaVersion`, `generatedAt`, `source`,
`freshness`, `totals`, `presence`, `coordination`, `transfers`, `messages`,
`routes`, `log`, `volume`, and the compatibility `work` projection. `messages`
contains the newest 60 records in newest-first order; totals, routes, and volume
are computed from the full spool history. Additive fields may appear within
version 1; removing or changing the meaning of a field requires a new schema
version and endpoint.

## What presence and receipts prove

For poll-only sessions, `lastSeen` means only that some agent-mail tool ran; it
does not imply that the inbox was checked. `lastInboxPoll` is stamped only by
`check_inbox`, including an empty check, so automation can distinguish recent
polling from unrelated activity. It still predicts only that the session may
poll again. For a message already sent, `agent-mail receipts --id <message-id>`
distinguishes `pushed` (channel delivery or an inbox pull) from `read` (an
explicit mark-read); neither status proves that the recipient completed the
requested work.
