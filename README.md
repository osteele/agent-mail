# agent-mail

Local mail bus for Claude Code agents. Push messages into running sessions
(via the Claude Code [channels](https://code.claude.com/docs/en/channels)
research preview), spool them durably when no session is listening, and echo
everything to Slack.

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
  `send_mail` / `check_inbox` tools, which work even without channel push.
- **Registry** (`~/.claude/agent-mail/registry/`): which sessions are
  listening, pruned by pid liveness.

Delivery tiers: channel-enabled sessions get push; running sessions without
the flag can arm a Monitor on their spool file; everything else reads the
spool on next check (`agent-mail inbox` or the `check_inbox` tool).

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
agent-mail notify --project <dir> --message <text> [--from <label>]
agent-mail inbox [--project <dir>] [--limit N]
agent-mail listeners                  # live sessions
agent-mail start|stop|restart|status  # daemon (launchd-aware)
agent-mail graceful                   # SIGHUP: reload config
agent-mail logs [-f]
agent-mail install|uninstall
```

## Configuration

`~/.config/agent-mail/config.toml`:

```toml
port = 8377
# slack_webhook = "https://hooks.slack.com/services/..."
# slack_echo = "all"   # or "none"
```

Slack webhook resolution order: `AGENT_MAIL_SLACK_WEBHOOK` env var →
`slack_webhook` in config.toml → `SLACK_WEBHOOK` in `~/.config/weft/config`.

## HTTP API (127.0.0.1 only)

| Endpoint | Description |
|---|---|
| `POST /notify` | `{project, message, from?, meta?}` → spool + Slack echo |
| `GET /health` | liveness + config summary |
| `GET /registry` | live channel-server registrations |
| `GET /inbox?project=<path>&limit=N` | read a project's spool |

## Security note

The daemon binds 127.0.0.1: any local process can put text in front of a
listening agent. This is the intended trust model for a personal machine;
don't expose the port.
