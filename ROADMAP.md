# Roadmap

Planned and in-progress work. Shipped items are removed from this file (the
git log is the record of what's done).

## Storage evolution

The filesystem store remains suitable at the current scale. Append-only JSONL
spools are easy to inspect and repair, isolate failures by project, support
file-tail delivery, and let every entry point operate when the daemon is down.
Current limits include whole-log inbox and dashboard queries, admission checks
that can race between direct writers, separate message and receipt appends, and
registry updates that rewrite whole JSON documents.

Do not replace the spools wholesale yet. Evolve the storage layer in stages:

- **Storage interface:** isolate message, receipt, read-state, registry, and
  claim operations from their on-disk representations.
- **Filesystem hardening:** make registry updates atomic and safe against
  concurrent field updates; add explicit retention or compaction before log
  growth becomes a problem.
- **Rebuildable SQLite index:** project the JSONL logs into a disposable SQL
  read model keyed by file and byte offset. Use it for dashboards, threads,
  receipts, history, and aggregate queries. JSONL remains authoritative, so the
  index can be deleted and rebuilt without recovery work.
- **Migration criteria:** consider making SQLite authoritative when agent-mail
  needs exact transactional admission, efficient retention, session-specific
  unread state, or handoff and lease state machines. Scan latency or background
  query cost becoming noticeable is also a migration signal.

If SQLite becomes authoritative, use Bun's built-in `bun:sqlite` with one local
database, WAL mode, foreign keys, a busy timeout, short transactions, and
versioned additive migrations. The daemon, CLI, channel servers, and dashboards
must continue opening the store directly; SQLite must not turn the daemon into
a required broker. Keep flexible message metadata as JSON while indexing fields
used for routing and queries. Add export, backup, integrity-check, and legacy
import commands, and retain the old files as a read-only rollback until the
import is validated.

Keep config, PID, and log files outside the database. Leave claims on their
existing project-scoped filesystem transactions until leases or richer workflow
state justify moving them. Decide whether read state belongs to a project or to
each session before defining the SQL schema.

## Native Slack threading

Threads exist in the mail layer (`replyTo`/`threadId` on every message), and the
Slack echo renders a reply's parent inline as quoted context. It does **not**
nest replies under the original Slack message, because that requires posting with
`thread_ts`, which incoming webhooks can't do.

The bot-token plumbing now exists (config `slack_bot_token` / `slack_channel`,
the Web API helper in `slackDashboard.ts`), so the remaining work is small:

- On echo via the Web API (`chat.postMessage`), persist a `threadId → Slack ts`
  mapping (a small JSON map under `~/.claude/agent-mail/`, consistent with the
  filesystem-is-the-bus invariant).
- A reply whose `threadId` is already mapped posts with that `thread_ts`; a new
  thread records the returned `ts`.
- Falls back to the current inline-quote echo when no bot token is configured.

## Presence

The registry already tracks which sessions are live (`cwd`, `pid`, `sessionId`,
`name`) and enriches them with Claude Code session status. Surface it as a
first-class concept rather than only a `send_mail` side effect:

- **`who` / presence query** — a CLI command and an MCP tool answering "who is
  live in project X right now, and what are they doing" (name, status,
  idle/working, last-seen). `list_sessions` is the seed.
- **Liveness in the registry entry** — last-heartbeat timestamp so stale entries
  read as "away" before pid-prune removes them, instead of vanishing abruptly.
- **Delivery hints at send time** — `send_mail` already notes "no session
  listening; spooled"; extend to "1 session live (working), 1 away" so the
  sender knows whether to expect a fast reply.

## Live handoff

Async mail can't express "I'm handing this task to you now, are you taking it."
A handoff is a small state machine layered on the spool:

- **Offer → accept/decline** — a message typed as a handoff carries a task
  reference; the recipient session accepts or declines, and the offerer is
  notified of the transition (not just delivery).
- **Claim/lease** — when several sessions share a directory's inbox, a handoff
  can be claimed by exactly one, so two agents don't both pick it up.
- **Status echo** — handoff transitions echo to Slack as a compact status line
  (offered → accepted by <session> → done), giving a human-readable audit trail
  of which agent owns what.

Depends on **presence** (you can only hand off to a session known to be live)
and reuses **threading** (a handoff and its accept/decline are one thread).

## Visualization

The `dashboard` (web) and `slack-dashboard` commands already cover live
presence, a sender→recipient traffic ranking, a flight log, and 24h volume.
Building on the same `dashboardData` aggregation:

- **Realtime stream** — a `/api/stream` SSE endpoint so the web dashboard
  updates on append instead of polling; edges in a force-directed graph pulse as
  messages fly (the "flight tracker").
- **`agent-mail top`** — a pure-terminal live dashboard (presence + sparkline +
  scrolling flight log) for when a browser isn't wanted.
- **Chord diagram / adjacency matrix** — replace the ranked route list with a
  matrix heatmap (scales past ~12 projects) or a chord diagram.
- **Sankey** — sender → recipient flow with width proportional to volume.
- **Stream graph** — stacked traffic over time banded by source type
  (weft vs. agent↔agent vs. cli).
- **Thread swimlanes** — each `threadId` a lane, messages as beads along time;
  the message→reply gap is visible latency.
- **Reply-latency leaderboard** — median message→reply time per project, derived
  from `replyTo` + timestamps.
- **Transcript reconstruction** — stitch both projects' spools for a `threadId`
  into one ordered, sender-attributed conversation view.
- **Historical replay** — a time scrubber that rebuilds the graph at any past
  moment; click a message to read it.
- **Statusline / menu-bar glyph** — unread count + a tiny traffic sparkline in
  the Claude Code statusline or the macOS menu bar.
