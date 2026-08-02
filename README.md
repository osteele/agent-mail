# agent-mail

Local mail bus for Claude Code agents. Push messages into running sessions
(via the Claude Code [channels](https://code.claude.com/docs/en/channels)
research preview), spool them durably when no session is listening, thread
replies into conversations, echo everything to Slack, and visualize the traffic
in a web or Slack dashboard.

Senders: other agents, the CLI, and tools like [weft](../weft) (job-completion
notifications).

## Architecture

- **Spool files are the source of truth**: append-only JSONL per project at
  `~/.claude/agent-mail/inbox/<slug>.jsonl`.
- **Daemon** (`src/daemon.ts`, launchd at boot): localhost HTTP ingress
  (`POST /notify`) that appends to spools and echoes to Slack.
- **Channel server** (`src/channel.ts`): spawned per Claude Code session as an
  MCP server. Tails the session project's spool and pushes new messages into
  the session as `<channel source="agent-mail">` events. Also exposes
  `send_mail`, `list_sessions`, `check_inbox`, `mark_read`, and
  `mute_notifications` / `unmute_notifications` tools, which work even without
  channel push.
- **Registry** (`~/.claude/agent-mail/registry/`): which sessions are
  listening (`cwd`, `pid`, `sessionId`, `name`). Entries are pruned when the
  process is gone *or* when its pid has been recycled by an unrelated process
  (the entry records the process start time at registration and compares it on
  every listing).
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

Each session also records its **host client** — `claude-code` or `codex` —
captured from the MCP handshake and shown in `status`, `list_sessions`, and the
dashboard. Codex sets no session env var, so Codex sessions get a per-process
random id and a generated alias.

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

### Threads

To answer a message, pass its id as `reply_to` to the `send_mail` tool (ids are
shown by `check_inbox`), or `--reply-to <id>` on `agent-mail notify`. The reply
inherits the original's thread, inbox readbacks mark it with `↩`, and the Slack
echo quotes the parent inline. Every message carries a `threadId` (a root
message is its own thread) so conversations group uniformly.

## Setup

```bash
bun install
bun src/cli.ts install   # LaunchAgent (boot start) + ~/.claude.json mcpServers entry
```

To receive **push** events, launch Claude Code with:

```bash
claude --dangerously-load-development-channels server:agent-mail
```

(The flag bypasses the channels research-preview allowlist for this named
local server only; without it, agent-mail is an inert MCP server whose tools
still work.)

## CLI

```bash
agent-mail notify --project <dir> --message <text> [--from <label>] [--reply-to <id>]
agent-mail inbox [--project <dir>] [--limit N] [--unread]
agent-mail mark-read [--project <dir>] (--id <message-id> | --all)
agent-mail listeners                  # attached sessions + idle times
agent-mail mute|unmute (--session <name-or-id> | --project <dir>)  # pause/resume push
agent-mail dashboard [--port N] [--open] [--no-tui]   # web dashboard
agent-mail slack-dashboard [--watch <seconds>]        # editable Slack dashboard
agent-mail start|stop|restart|status  # daemon (launchd-aware)
agent-mail graceful                   # SIGHUP: reload config
agent-mail logs [-f]
agent-mail install|uninstall
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
```

`session_aliases` is a comma list of `basename=alias` pairs that shorten the
project base in session labels (e.g. `augur-lon` instead of
`llm-performance-models-lon`) across `listeners`, `list_sessions`, both
dashboards, and the per-message Slack echo. Also settable via
`AGENT_MAIL_SESSION_ALIASES`. Changes are picked up on daemon `graceful`
(SIGHUP) and by each new CLI/dashboard invocation.

Slack webhook resolution order: `AGENT_MAIL_SLACK_WEBHOOK` env var →
`slack_webhook` in config.toml → `SLACK_WEBHOOK` in `~/.config/weft/config`.

The `slack-dashboard` command additionally needs a bot token and channel
(`slack_bot_token` / `slack_channel`, or `AGENT_MAIL_SLACK_BOT_TOKEN` /
`AGENT_MAIL_SLACK_CHANNEL`). Create a Slack app with the `chat:write` scope,
install it, and invite the bot to the target channel. The per-message echo only
needs the webhook; the editable dashboard needs the token.

## HTTP API (127.0.0.1 only)

| Endpoint | Description |
|---|---|
| `POST /notify` | `{project, message, from?, meta?}` → spool + Slack echo |
| `POST /read` | `{project, ids}` or `{project, all:true}` → mark messages read |
| `GET /health` | liveness + config summary |
| `GET /registry` | live channel-server registrations |
| `GET /inbox?project=<path>&limit=N&unread=1` | read a project's spool |

## Security note

The daemon binds 127.0.0.1: any local process can put text in front of a
listening agent. This is the intended trust model for a personal machine;
don't expose the port.
