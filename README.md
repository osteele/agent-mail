# agent-mail

Durable local mail and coordination for Claude Code and Codex sessions.
agent-mail supports Claude↔Claude, Claude↔Codex, and Codex↔Codex messages,
including sessions in different project directories. It pushes messages into
Claude Code through [channels](https://code.claude.com/docs/en/channels), keeps
project inboxes on disk, threads replies, echoes traffic to Slack, coordinates
file ownership, and provides web and Slack dashboards.

Senders: other agents, the CLI, and tools like [weft](../../research-tools/weft) (job-completion
notifications).

## Client and delivery support

Both Claude Code and Codex load the same MCP server and use the same tools and
spools. The receiving client determines how soon a message enters its context:

| Route | Delivery |
|---|---|
| Claude → Claude | Channel push when enabled; otherwise `check_inbox` |
| Claude → Codex | `check_inbox` in the receiving Codex session |
| Codex → Claude | Channel push when enabled; otherwise `check_inbox` |
| Codex → Codex | `check_inbox` in the receiving Codex session |
| CLI, weft, or HTTP → Claude | Channel push when enabled; otherwise the durable inbox |
| CLI, weft, or HTTP → Codex | Durable inbox, read with `check_inbox` |

Codex does not currently support channel push. Its MCP tools still register the
session, send mail, inspect peers, read and mark inbox messages, and manage
claims. Messages remain available in the project spool after delivery.

### Claude Code's native cross-session messaging

[Claude Code 2.1.224 added built-in cross-session
messaging](https://code.claude.com/docs/en/cross-session-messaging) between
running Claude Code sessions with `ListAgents` and `SendMessage`. Use it for a
direct, immediate message to a named Claude session on the same machine. It
requires no agent-mail daemon or channel configuration.

agent-mail covers the cases outside that live Claude-only path:

- either endpoint is Codex;
- the sender is a CLI command, weft job, HTTP client, or other automation;
- the destination is a project inbox or every session in a project;
- the message must survive periods with no receiving session;
- the workflow needs unread state, threads, Slack echo, dashboards, or an audit
  trail; or
- agents need atomic path or experiment-number claims.

The two transports can run together. By default, a native `SendMessage` does
not pass through agent-mail, so it does not appear in the spool, Slack, or
dashboards. Install the optional audit hook with `agent-mail install
--native-audit` to record successful native `SendMessage` calls in the sender's
agent-mail log and Slack echo. Audit records are never delivered through an
agent-mail inbox, which prevents the hook from creating a second delivery or a
message loop. The hook observes all `SendMessage` calls, including subagent and
agent-team messages, and records the destination exactly as Claude supplies it.

Do not send the same message through both transports: a native message that is
held for approval may still be delivered later. Claude Code's
`crossSessionInbound` setting controls native messages; agent-mail's inbound
policy controls agent-mail messages. They are independent.

## Architecture

- **Spool files are the source of truth**: append-only JSONL per project at
  `~/.claude/agent-mail/inbox/<slug>.jsonl`.
- **Receipts**: append-only state transitions at
  `~/.claude/agent-mail/receipts/<slug>.jsonl`. A message is recorded as
  `spooled`, then each receiving session can report `held`, `pushed`, `read`,
  `refused`, or `expired`.
- **Daemon** (`src/daemon.ts`, launchd at boot): localhost HTTP ingress
  (`POST /notify`) that appends to spools and echoes to Slack.
- **Channel server** (`src/channel.ts`): spawned per Claude Code session as an
  MCP server. Tails the session project's spool and pushes new messages into
  the session as `<channel source="agent-mail">` events. Also exposes
  messaging, receipt, policy, presence, and coordination tools, which work even
  without channel push.
- **Registry** (`~/.claude/agent-mail/registry/`): which sessions are
  listening (`cwd`, `pid`, `sessionId`, `name`). Entries are pruned when the
  process is gone *or* when its pid has been recycled by an unrelated process
  (the entry records the process start time at registration and compares it on
  every listing).
- **Claims** (`~/.claude/agent-mail/claims/`): atomic, per-project reservations
  for lab-notebook experiment numbers and files/directories being edited. Like
  the spool and registry, claims work directly through the filesystem and do
  not depend on the daemon.
- **Dashboards** (`src/dashboard.ts`, `src/slackDashboard.ts`): read the spools
  and registry directly (no daemon dependency) via a shared aggregation
  (`src/dashboardData.ts`) and render them as a local web page or an editable
  Slack message.

### Addressing

Mail is addressed to a **project directory**. Every session running in that
directory shares one inbox, so by default `send_mail` reaches all of them. To
reach one specific session, pass its name or id as `session` (discover targets
with `list_sessions`); the others in that directory won't see it. A session is
identified by `CLAUDE_CODE_SESSION_ID` and labelled `<project-base>-<suffix>`:
the project directory basename (optionally shortened via `session_aliases`, see
Configuration) plus a short pronounceable suffix derived from the session id, in
place of Claude Code's `<project>-<hex>` auto-name. A deliberate `/rename` is
shown verbatim instead.

The project spool stores every message for that directory. Session-local views
(`check_inbox`, `mark_read`, and channel push) filter it for the current
session: a session does not see mail it authored itself, and a direct
session-targeted message is visible only to the addressed session. The CLI
`agent-mail inbox` and HTTP `/inbox` endpoint are project-spool views and show
the stored messages without session-local filtering.

Each session also records its **host client** — `claude-code` or `codex` — and
capabilities such as `channel`, `poll`, `native-peer`, `claims`, and `receipts`.
These are captured from the MCP handshake and environment and shown in
`status`, `listeners`, `list_sessions`, and both dashboards. Agents can choose
native peer messaging only when the target advertises it, and otherwise choose
channel push or durable polling. Codex sets no session env var, so Codex
sessions get a per-process random id and a generated alias.

### Presence

A listed session is **attached** (its channel server is alive and mail to it
will be delivered), which is not the same as **active** — a terminal left open
overnight stays attached with nobody home. So every surface (`list_sessions`,
`listeners`, `status`, both dashboards) tags each session with its recency:
`[busy]` (Claude reports it mid-turn), `[active]` (signs of life within the
last two minutes), or `[idle <age>]`, flagged `stale?` after a day. Recency is
the most recent of: Claude Code's own session-activity timestamp, the last
agent-mail tool call the session made, and its registration time. Treat
long-idle sessions as probably vacant rather than as active agents.

Delivery tiers: channel-enabled sessions get push; running sessions without
the flag can arm a Monitor on their spool file; everything else reads the
spool on next check (`agent-mail inbox` or the `check_inbox` tool).

### Muting

A session can pause its channel push — from inside the agent with the
`mute_notifications` tool, or from outside with `agent-mail mute` (targeted by
`--session <name-or-id>` and/or `--project <dir>`). While muted, incoming mail
still spools (and stays visible to `check_inbox` / `agent-mail inbox`) but is
not pushed as a `<channel>` event. `unmute_notifications` / `agent-mail unmute`
delivers everything held during the mute at once, then resumes normal push.
Muting only affects an agent's push; the daemon still spools and Slack-echoes
every message. Mute is per-session and clears when the session restarts.

### Delivery controls and receipts

Every new message carries descriptive provenance: origin kind, transport,
client and session id when available, and `authority: untrusted`. This metadata
never grants user authority. A receiving agent must still apply its own
permission rules before acting. Legacy messages without provenance are also
shown as untrusted.

Each session has an independent inbound policy:

- `accept` delivers new mail and releases held mail;
- `hold` keeps mail out of the agent context while retaining it for later; and
- `refuse` records refusal without delivering the message to that session.

Set it from an agent with `set_inbound_policy`, or externally with `agent-mail
inbound --policy ...`. The default comes from `inbound_policy`. A held queue is
bounded; when it fills, the oldest held message is refused.

Senders can supply an idempotency key and TTL. agent-mail also suppresses
identical bodies from one sender during a short window and applies a rolling
per-sender rate limit. Set either limit to zero to disable it. Expired and
native-audit messages remain visible to dashboards but never enter an inbox.

Use the `delivery_status` MCP tool or `agent-mail receipts` to inspect the
append-only state changes. A `spooled` receipt confirms durable local storage;
later receipts are per receiving session. This is observability rather than
exactly-once delivery: direct fallback writers can race, and a process can fail
after receiving a push but before recording its receipt.

### Threads

To answer a message, pass its id as `reply_to` to the `send_mail` tool (ids are
shown by `check_inbox`), or `--reply-to <id>` on `agent-mail notify`. The reply
inherits the original's thread, inbox readbacks mark it with `↩`, and the Slack
echo quotes the parent inline. Every message carries a `threadId` (a root
message is its own thread) so conversations group uniformly.

### Coordination claims

Agents can coordinate work without racing on notebook IDs or overlapping
edits. `claim_experiment` atomically returns the next `EXP-NNN`, accounting for
both files already in `experiments/` and reservations held by other agents.
Create the `EXP-NNN-*.md` file before releasing the claim; after release, the
file is what keeps the number allocated.

`claim_path` reserves one file or directory within the current project. A
directory claim conflicts with every claim below it, and a path cannot be
claimed beneath a directory another agent owns. Non-overlapping siblings can
be claimed independently. `list_claims` shows owners and claim IDs;
`release_claim` releases a claim owned by the current session. Claims held by
an MCP session are released on a normal session shutdown. If a session crashes,
inspect the claim and release it explicitly with the CLI.

The equivalent CLI is useful for inspection and recovery:

```bash
agent-mail claim-experiment [--project <dir>] [--notebook <dir>]
agent-mail claim-path --path <path> [--directory] [--project <dir>]
agent-mail claims [--project <dir>]
agent-mail release-claim --id <claim-id> [--project <dir>]
```

## Setup

Install dependencies, the daemon, and the Claude Code and Codex MCP entries:

```bash
bun install
bun src/cli.ts install
```

The installer uses `codex mcp add` when no Codex entry exists. It preserves an
entry that already matches this checkout. If either client already uses the
name for a different checkout, the installer leaves it unchanged. Inspect the
Codex entry with `codex mcp get agent-mail --json`, or deliberately replace
entries with `--replace-codex` or `--replace-claude`. Pass `--no-codex` to skip
Codex registration.

To receive **push** events, launch Claude Code with:

```bash
claude --dangerously-load-development-channels server:agent-mail
```

(The flag bypasses the channels research-preview allowlist for this named
local server only; without it, agent-mail is an inert MCP server whose tools
still work.)

To include successful native Claude `SendMessage` calls in dashboards and
Slack without redelivering them, enable the optional audit hook:

```bash
agent-mail install --native-audit
```

The hook is added to `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`) without replacing other hooks. `agent-mail
uninstall` removes only the hook and MCP registrations that belong to this
checkout. Restart existing Claude Code and Codex sessions after changing their
integration. Codex provides tools and presence registration, but not push
delivery.

## CLI

```bash
agent-mail notify --project <dir> --message <text> [--from <label>] [--reply-to <id>] \
  [--idempotency-key <key>] [--ttl <seconds>] [--no-slack]
agent-mail inbox [--project <dir>] [--limit N] [--unread]
agent-mail mark-read [--project <dir>] (--id <message-id> | --all)
agent-mail receipts [--project <dir>] [--id <message-id>] [--limit N]
agent-mail listeners                  # attached sessions + idle times
agent-mail mute|unmute (--session <name-or-id> | --project <dir>)  # pause/resume push
agent-mail inbound --policy accept|hold|refuse \
  (--session <name-or-id> | --project <dir>)
agent-mail claim-experiment [--project <dir>] [--notebook <dir>]
agent-mail claim-path --path <path> [--directory] [--project <dir>]
agent-mail claims [--project <dir>]
agent-mail release-claim --id <claim-id> [--project <dir>]
agent-mail dashboard [--port N] [--open] [--no-tui]   # web dashboard
agent-mail slack-dashboard [--watch <seconds>]        # editable Slack dashboard
agent-mail start|stop|restart|status  # daemon (launchd-aware)
agent-mail graceful                   # SIGHUP: reload config
agent-mail logs [-f]
agent-mail install [--native-audit] [--no-codex] [--replace-claude] [--replace-codex]
agent-mail uninstall
```

## Dashboards

`agent-mail dashboard` serves a local web page (default port = daemon port + 1)
showing live sessions, sender→recipient traffic, hourly volume, and a flight
log, polling every 2 s. In a terminal it stays attached: press `o` to (re)open
it in the browser, `q` to quit. Pass `--open` to open the browser on start, or
`--no-tui` to just serve (for scripts/headless). It reads spools directly, so it
works even when the daemon is down.

`agent-mail slack-dashboard` posts the same summary as a single Slack message
and edits it in place on each run (`--watch <seconds>` to refresh on a timer).
This needs a Slack **bot token** (the incoming webhook used for per-message
echoes can't edit messages) — see Configuration.

## Configuration

`~/.config/agent-mail/config.toml`:

```toml
port = 8377
# slack_webhook = "https://hooks.slack.com/services/..."
# slack_echo = "all"   # or "none"
# slack_bot_token = "xoxb-..."   # for `slack-dashboard` (chat:write scope)
# slack_channel = "C0123ABCD"    # channel the dashboard posts/updates in
# session_aliases = "llm-performance-models=augur, dependency-routing=deproute"
# inbound_policy = "accept"      # accept, hold, or refuse
# duplicate_window_seconds = 10  # 0 disables body deduplication
# message_rate_limit_per_minute = 60  # 0 disables rate limiting
# default_message_ttl_seconds = 0     # 0 means no default expiry
# held_message_limit = 100
```

`session_aliases` is a comma list of `basename=alias` pairs that shorten the
project base in session labels (e.g. `augur-lon` instead of
`llm-performance-models-lon`) across `listeners`, `list_sessions`, both
dashboards, and the per-message Slack echo. Also settable via
`AGENT_MAIL_SESSION_ALIASES`. Changes are picked up on daemon `graceful`
(SIGHUP) and by each new CLI/dashboard invocation.

Slack webhook resolution order: `AGENT_MAIL_SLACK_WEBHOOK` env var →
`slack_webhook` in config.toml → `SLACK_WEBHOOK` in `~/.config/weft/config`.
The `notify --no-slack` flag suppresses the mirror for that message only; the
message is still appended to the project inbox. Other messages continue to use
the configured `slack_echo` policy.

Per-message Slack echoes show compact session routes. A direct message in one
project renders like `llm-performance-models · hia → nia`; a project broadcast
renders as `hia → all` followed by up to three currently attached session names
and `+N`. That recipient list is a live snapshot, not a delivery boundary — the
durable inbox remains available to sessions that attach later. Deliberate
Claude `/rename` names are kept verbatim.

The `slack-dashboard` command additionally needs a bot token and channel
(`slack_bot_token` / `slack_channel`, or `AGENT_MAIL_SLACK_BOT_TOKEN` /
`AGENT_MAIL_SLACK_CHANNEL`). Create a Slack app with the `chat:write` scope,
install it, and invite the bot to the target channel. The per-message echo only
needs the webhook; the editable dashboard needs the token.

## HTTP API (127.0.0.1 only)

| Endpoint | Description |
|---|---|
| `POST /notify` | `{project, message, from?, meta?, idempotencyKey?, ttlSeconds?, slackEcho?}` → guarded spool + optional Slack echo |
| `POST /read` | `{project, ids}` or `{project, all:true}` → mark messages read |
| `GET /health` | liveness + config summary |
| `GET /registry` | live channel-server registrations |
| `GET /inbox?project=<path>&limit=N&unread=1` | read a project's spool |
| `GET /receipts?project=<path>&message=<id>` | read delivery state changes |

## Security note

The daemon binds 127.0.0.1, so any process running as the local user can submit
text. All inbound mail is explicitly marked untrusted and cannot approve
permissions or override the receiving session's rules. Use `hold` or `refuse`
for sessions that should not accept agent-mail automatically, and do not expose
the port.
