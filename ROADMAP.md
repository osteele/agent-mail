# Roadmap

Planned and in-progress work. Shipped items are removed from this file (the
git log is the record of what's done).

## Native Slack threading

Threads exist in the mail layer (`replyTo`/`threadId` on every message), and the
Slack echo renders a reply's parent inline as quoted context. It does **not**
nest replies under the original Slack message, because that requires posting with
`thread_ts`, which incoming webhooks can't do.

To get true nested threads:

- Add an optional Slack **bot token** + channel id to config (alongside the
  existing webhook; webhook stays the zero-config default).
- On echo via the Web API (`chat.postMessage`), persist a `threadId → Slack ts`
  mapping (a small JSON map under `~/.claude/agent-mail/`, consistent with the
  filesystem-is-the-bus invariant).
- A reply whose `threadId` is already mapped posts with that `thread_ts`; a new
  thread records the returned `ts`.

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

## Visualization (exploratory)

Make the flow of mail between projects legible — historical traffic and a live
view of who's talking to whom. Sketches live in chat for now; promote concrete
directions here once chosen.
