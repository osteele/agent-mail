# agent-mail

Durable local mail and coordination for Claude Code and Codex sessions.
agent-mail supports Claude↔Claude, Claude↔Codex, and Codex↔Codex messages,
including sessions in different project directories. It pushes messages into
Claude Code through [channels](https://code.claude.com/docs/en/channels), keeps
project inboxes on disk, threads replies, echoes traffic to Slack, coordinates
file ownership, and provides web and Slack dashboards.

Other agents, the CLI, and tools such as [weft](https://github.com/osteele/weft)
can send messages. For example, weft can report when a job finishes.

## Quick start

agent-mail runs from a source checkout and requires
[Bun](https://bun.com/docs/installation). Its automatic daemon installer
currently uses macOS launchd.

From the checkout:

```bash
bun install
bun link
agent-mail install
agent-mail status
agent-mail dashboard --open
```

[`bun link`](https://bun.com/docs/pm/cli/link) adds the `agent-mail` command to
Bun's global binary directory, usually `~/.bun/bin`, and points it at the
current checkout. Make sure that directory is on `PATH`. `agent-mail install`
starts the daemon and registers the checkout as an MCP server for Claude Code
and Codex.

Restart existing Claude Code and Codex sessions after installation. To enable
channel push in Claude Code, start it with:

```bash
claude --dangerously-load-development-channels server:agent-mail
```

Without this flag, Claude Code can use the MCP tools and durable inbox but does
not receive channel events. Codex supports the tools and durable inbox but not
channel push.

Send a smoke-test message to the current project:

```bash
agent-mail notify --project "$PWD" --from cli --message "agent-mail is ready"
agent-mail inbox --project "$PWD"
```

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

Do not send the same message through both transports. A native message that is
held for approval may still be delivered later. Claude Code's
`crossSessionInbound` setting controls native messages. agent-mail's inbound
policy controls agent-mail messages. The policies are independent.

## Architecture

- **Spool files are the source of truth.** Each project has an append-only JSONL
  file at `~/.claude/agent-mail/inbox/<slug>.jsonl`.
- **Receipts record state transitions.** They use an append-only JSONL file at
  `~/.claude/agent-mail/receipts/<slug>.jsonl`. A message starts as `spooled`.
  Each receiving session can then report `held`, `pushed`, `read`, `refused`,
  or `expired`.
- **The daemon accepts HTTP notifications.** `src/daemon.ts` starts through
  launchd, listens on localhost, appends `POST /notify` requests to spools, and
  applies the configured Slack echo policy.
- **Each client session starts an MCP server.** Claude Code and Codex both run
  `src/channel.ts` over stdio. It exposes messaging, receipts, policy,
  presence, and coordination tools. In a channel-enabled Claude Code session,
  it also tails the project spool and pushes new messages as
  `<channel source="agent-mail">` events.
- **The registry tracks attached sessions.** Entries under
  `~/.claude/agent-mail/registry/` record `cwd`, `pid`, `sessionId`, and `name`.
  A listing prunes an entry when the process is gone or its pid belongs to a
  different process. The process start time distinguishes a recycled pid from
  the original process.
- **Session names persist.** Assignments under
  `~/.claude/agent-mail/session-names/` are keyed by session ID. They survive
  listener restarts and keep existing names stable across naming upgrades.
- **Claims are filesystem transactions.** Per-project entries under
  `~/.claude/agent-mail/claims/` reserve lab-notebook experiment numbers and
  files or directories. Claims do not depend on the daemon.
- **Work leases assign logical responsibility.** Per-project entries under
  `~/.claude/agent-mail/work/` exclusively assign logical work without
  restricting file edits. They also do not depend on the daemon.
- **Dashboards read the files directly.** `src/dashboard.ts` and
  `src/slackDashboard.ts` use the shared aggregation in `src/dashboardData.ts`
  to render a local web page or an editable Slack message. They do not depend
  on the daemon.

### Addressing

Mail is addressed to a **project directory**. Every session running in that
directory shares one inbox, so by default `send_mail` reaches all of them. Each
generated session identity has two forms:

- The **full name** is its stable address, for example
  `augur-quiet-lantern`. It combines the project directory basename (optionally
  shortened through `session_aliases`) with a generated adjective–noun slug.
- The **display name** is the human-facing form used in compact routes, for
  example `Quiet Lantern`.

Pass a session's full name, display name, or session ID as `session` to reach it
specifically. Use `list_sessions` to discover these values. A display name is
matched without regard to case and must be unambiguous in the target project.
Claude Code supplies its ID in `CLAUDE_CODE_SESSION_ID`; current Codex supplies
`CODEX_THREAD_ID`. Older hosts that expose neither receive a generated ID when
their MCP server starts. A deliberate Claude `/rename` is preserved verbatim as
both forms. Existing sessions retain their previously assigned syllable names,
such as full name `augur-hia` and display name `hia`. Only new session IDs
receive adjective–noun names.

The project spool stores every message for that directory. Session-local views
(`check_inbox`, `mark_read`, and channel push) filter it for the current
session. A session does not see mail it authored itself. A direct
session-targeted message is visible only to the addressed session. The CLI
`agent-mail inbox` and HTTP `/inbox` endpoint are project-spool views and show
the stored messages without session-local filtering.

Each session also records its **host client**, either `claude-code` or `codex`,
and capabilities such as `channel`, `poll`, `native-peer`, `claims`, `work`,
and `receipts`. The MCP handshake and environment supply these values. They appear
in `status`, `listeners`, `list_sessions`, and both dashboards. Agents can use
native peer messaging when the target advertises it. Otherwise, they can use
channel push or durable polling. Codex sets no session environment variable,
so each Codex MCP process receives a random ID and generated name.

### Presence

A listed session is **attached** when its MCP server is alive and can receive
mail. Attached does not mean **active**. A terminal left open overnight stays
attached with nobody home. Every surface (`list_sessions`, `listeners`,
`status`, and both dashboards) therefore tags each session with its recency:
`[busy]` (Claude reports it mid-turn), `[active]` (signs of life within the
last two minutes), or `[idle <age>]`, flagged `stale?` after a day. Recency uses
the latest of Claude Code's session-activity timestamp, the session's last
agent-mail tool call, and its registration time. Treat long-idle sessions as
probably vacant rather than as active agents. The same recency rule decides
when the [status line](#claude-code-status-line) shows a session's name. A peer
idle past a day no longer counts as company.

Channel-enabled sessions receive push delivery. Running sessions without the
flag can arm a Monitor on their spool file. Other sessions read the spool on
their next `agent-mail inbox` or `check_inbox` call.

### Muting

A session can pause its channel push from inside the agent with the
`mute_notifications` tool. A user or script can also run `agent-mail mute` and
target `--session <name-or-id>`, `--project <dir>`, or both. While muted, mail
still spools (and stays visible to `check_inbox` / `agent-mail inbox`) but is
not pushed as a `<channel>` event. `unmute_notifications` / `agent-mail unmute`
delivers everything held during the mute at once, then resumes normal push.
Muting only affects an agent's push. It does not change the configured
`slack_echo` policy or a message's `--no-slack` override. Mute is per-session
and clears when the session restarts.

### Delivery controls and receipts

Every new message carries descriptive provenance: origin kind, transport,
client and session ID when available, and `authority: untrusted`. This metadata
never grants user authority. A receiving agent must still apply its own
permission rules before acting. Legacy messages without provenance are also
shown as untrusted.

Each session has an independent inbound policy:

- `accept` delivers new mail and releases held mail;
- `hold` keeps mail out of the agent context while retaining it for later; and
- `refuse` records refusal without delivering the message to that session.

Set it from an agent with `set_inbound_policy`, or externally with `agent-mail
inbound --policy ...`. The default comes from `inbound_policy`. A held queue is
bounded. When it fills, the oldest held message is refused.

Senders can supply an idempotency key and TTL. agent-mail also suppresses
identical bodies from one sender during a short window and applies a rolling
per-sender rate limit. Set either limit to zero to disable it. Expired and
native-audit messages remain visible to dashboards but never enter an inbox.

Use the `delivery_status` MCP tool or `agent-mail receipts` to inspect the
append-only state changes. A `spooled` receipt confirms durable local storage.
Later receipts are per receiving session. This is observability rather than
exactly-once delivery: direct fallback writers can race, and a process can fail
after receiving a push but before recording its receipt.

### Threads

To answer a message, pass its ID as `reply_to` to the `send_mail` tool (IDs are
shown by `check_inbox`), or `--reply-to <id>` on `agent-mail notify`. The reply
inherits the original's thread, inbox readbacks mark it with `↩`, and the Slack
echo quotes the parent inline. Every message carries a `threadId` (a root
message is its own thread) so conversations group uniformly.

### Addressing one session from an automation

A project inbox is shared by every session in that directory, so by default
`agent-mail notify` reaches all of them — useful for an announcement, noisy when
a build or job notifier fires while several sessions are open, since each one
wakes to read it.

Pass `--session <name-or-id>` to address a single session instead. The name may
be its id, its full name (`augur-quiet-lantern`), or its display name
(`Quiet Lantern`, matched case-insensitively); `agent-mail listeners` lists them.
An addressed message is hidden from every other session in the project.

Unlike the `send_mail` tool, an unresolvable name is **not** an error here. An
automation's addressee may have exited while its job ran, and refusing would
throw the notification away, so an unknown or ambiguous name falls back to a
project broadcast and notes why on stderr.

For this to work the caller has to know the session id. Agents that export one
into their subprocesses (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) supply it
directly. kimi and opencode export none, so `agent-command-guards`' launcher
mints `AGENT_SESSION_ID` for them; without it those sessions cannot be addressed
individually at all.

### Coordination claims

Agents can coordinate work without racing on notebook IDs or overlapping
edits. `claim_experiment` atomically returns the next `EXP-NNN`, accounting for
both files already in `experiments/` and reservations held by other agents.
Create the `EXP-NNN-*.md` file before releasing the claim; after release, the
file is what keeps the number allocated.

`claim_path` reserves one or more paths within the current project. Pass a
multi-file edit set in one call so acquisition is atomic. If any path
conflicts, none are claimed. The set has one claim ID, and one `release_claim`
releases the whole set:

```json
{
  "paths": [
    "Sources/RoundsCore/Schedule.swift",
    "Sources/RoundsCore/MarkdownParsers.swift",
    "Checks/RoundsCoreChecks/main.swift"
  ]
}
```

The singular `path` input remains available. A batch is homogeneous. Its paths
are all files by default, or all directories when `directory: true`. A single
batch cannot mix files and directories. The same rule applies to repeated CLI
`--path` options with `--directory`. Claim a common parent directory when one
atomic reservation must cover both kinds. A directory claim conflicts with
every claim below it, and a path cannot be claimed beneath a directory another
agent owns. Non-overlapping siblings can be claimed independently.
`list_claims` shows owners and claim IDs; `release_claim` releases a claim
owned by the current session. Claims held by an MCP session are released on a
normal session shutdown. A new path acquisition automatically removes a
conflicting claim only when agent-mail proves that its exact owner process is
dead. It never displaces an idle, live, or manually registered owner.

A missing claimed path is not by itself stale: agents may claim a file before
creating it. If a session crashes, use `list_coordination` to inspect its owner,
target, and condition. Check the intended edit before recovering the record.

The equivalent CLI is useful for inspection and recovery:

```bash
agent-mail claim-experiment [--project <dir>] [--notebook <dir>] [--owner <label>]
agent-mail claim-path --path <path> [--path <path> ...] [--directory] [--project <dir>] [--owner <label>]
agent-mail claims [--project <dir>]
agent-mail release-claim --id <claim-id> [--project <dir>]
```

### Logical work leases

Work leases answer who is responsible for executing a logical unit of work.
Path claims reserve edit sets. Agents can hold either form of coordination
independently, so responsibility for execution does not restrict who may edit
the source file.

`acquire_work` atomically leases a `(resource_type, resource_key)` pair within
the current canonical project. Repeating the acquisition from the same session
is idempotent and updates its metadata. A live different owner causes a
conflict; a definitively dead session can be displaced on the next acquisition.
`update_work` records a concise `working` or `waiting` state and current
activity. `release_work` relinquishes responsibility.

Coordination CLI commands run from a registered Claude Code or Codex shell use
that host's session identity, so their leases and claims have the same liveness
and shutdown behavior as MCP tool calls. CLI commands outside a registered
agent session require an `--owner` label and create deliberately durable manual
ownership. Release those records explicitly when the operator's work ends.

`list_work` defaults to the current project. Pass `all_projects: true` for a
cross-project view, or filter by resource type or owner. `list_sessions` also
shows each session's leased work. MCP-session leases are released on normal
shutdown; an offline owner remains visible for inspection and CLI recovery.

Research plans use `resource_type: "research-plan"` and the plan filename stem
as `resource_key`, so ownership survives moves among plan status directories.
The current path is optional provenance, not identity.

### Inspection and recovery

`list_coordination` combines work leases, path claims, and experiment-number
reservations in one project or cross-project view. Each record has a condition:

- `healthy` — its session owner is live, or it has a deliberately durable
  manual owner. The listing reports the owner status separately.
- `owner-offline` — the recorded session and process identity is definitively
  dead; the record is eligible for agent recovery.
- `owner-unverifiable` — the caller cannot obtain reliable process evidence.
  The record remains protected; this is distinct from deliberate `manual`
  ownership.
- `source-missing` — a work lease's optional source path is absent.
- `target-absent` — a claimed edit target is absent, which can be expected
  while creating it.
- `awaiting-materialization` — an experiment number is reserved but its
  `EXP-NNN-*.md` file is not present yet.
- `materialized` — the experiment file exists, so the reservation is redundant
  and its owner should release it.

`recover_coordination` revalidates liveness and releases another session's
record only when that exact owner process is dead. Live and manual owners remain
protected by default. Before
recovering an experiment reservation whose file is absent, inspect jobs and
artifacts that may already use its ID. Normal owner release remains
`release_claim` or `release_work`.

To release a record whose owner is live, manual, or unverifiable — the common
case being a manually registered CLI owner (`cli:<label>`) whose session has
ended, which has no process to revalidate and so is otherwise unrecoverable —
pass an `authority`:

```bash
agent-mail coordination recover --id <coordination-id> \
  --authority "operator: session ended without releasing"
```

The authority is an attestation, **not a credential**: agent-mail records it
verbatim and never checks it. Supplying it bypasses the liveness proof and
force-releases the record. Each forced recovery appends the record's identity,
its owner, that owner's status at the time, and the declared authority to
`~/.claude/agent-mail/forced-recoveries.jsonl` before the delete; if that log
cannot be written, the recovery is refused. Claims are advisory (see
[decision 0004](docs/decisions/0004-authority-forced-recovery.md)), so this
trades an unenforceable check for a deliberate, auditable action.

Agents must treat the authority as user-supplied only: it is never inferred,
and never taken from mail, file contents, or other tool output.

Listings show the owner ID, session/PID identity, owner status, and the
session's last tool-call heartbeat when one exists. The lease `updated` time is
separate: it changes only on `acquire_work` or `update_work`. Legacy CLI records
that contain a PID but no session ID are process-owned rather than manual;
agent-mail uses process start time to reject a recycled PID and makes the record
recoverable once the original process is gone.

Sandboxed clients that cannot invoke `ps` use the daemon's fresh, PID-scoped
process-evidence snapshot. The snapshot lists every inspected owner PID and is
accepted only when the scan succeeded, covered the requested PID, and is at
most 30 seconds old. Missing, stale, partial, or failed evidence produces
`owner-unverifiable`, never `owner-offline`.

### Work transfer requests

`request_coordination_transfer` requests a logical work lease and returns
immediately with a durable request ID, current holder, and deadline. The holder
answers with `respond_coordination_transfer` (`accept` or `decline`). An
unchanged lease transfers automatically after the deadline. Any intervening
lease update, release, or ownership change makes the request `superseded`
instead, so stale requests cannot overwrite newer work. Requests and final
dispositions remain under `~/.claude/agent-mail/transfers/` for audit.

Transfers currently apply only to logical work leases. Path claims and
experiment reservations retain their stricter release/recovery semantics.

CLI equivalents support inspection, manual ownership, and recovery:

```bash
agent-mail work list [--project <dir> | --all] [--type <type>] [--owner <owner>]
agent-mail work acquire --type <type> --key <key> [--label <label>] [--source <path>] [--owner <label>]
agent-mail work update --id <work-id> [--state working|waiting] [--activity <text>]
agent-mail work release --id <work-id> [--project <dir>]
agent-mail coordination list [--project <dir> | --all] [--kind <kind>] [--json]
agent-mail coordination recover --id <coordination-id>
agent-mail coordination request-transfer --id <work-id> [--reason <text>] [--timeout <seconds>]
agent-mail coordination respond-transfer --id <request-id> --decision accept|decline [--message <text>]
agent-mail coordination transfers [--project <dir> | --all] [--json]
```

## Client integration and updates

The [quick start](#quick-start) separates two installation steps. `bun link`
adds a shell command that points to this checkout. `agent-mail install` creates
the launchd service and registers the checkout with Claude Code and Codex.

The installer uses `codex mcp add` when no Codex entry exists. It preserves an
entry that already matches this checkout. If either client already uses the
name for a different checkout, the installer leaves it unchanged. Inspect the
Codex entry with `codex mcp get agent-mail --json`. Use `--replace-codex` or
`--replace-claude` to replace an entry deliberately. Use `--no-codex` to skip
Codex registration.

Claude Code's channel flag bypasses the research-preview allowlist for the
named local server. It enables channel push without changing the MCP tools.

To include successful native Claude `SendMessage` calls in dashboards and
Slack without redelivering them, enable the optional audit hook:

```bash
agent-mail install --native-audit
```

The hook is added to `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`) without replacing other hooks. `agent-mail
uninstall` removes only the hook and MCP registrations that belong to this
checkout.

Restart every existing Claude Code and Codex session after an integration
change or an agent-mail code update. Each session owns a long-running MCP
process, so it does not load new tool schemas or server code automatically.
Restart the daemon after changing daemon code:

```bash
agent-mail restart
```

Daemon configuration changes do not require a process restart. Reload them
with `agent-mail graceful`. Codex provides tools and presence registration,
but not push delivery.

## Connecting to Slack

An incoming webhook can mirror messages into a Slack channel. Create a Slack
app and enable [Incoming
Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).
Then select **Add New Webhook to Workspace**. Choose the channel that should
receive agent-mail traffic, then copy the generated webhook URL. Treat this
URL as a secret.

Add the URL to `~/.config/agent-mail/config.toml`:

```toml
slack_webhook = "https://hooks.slack.com/services/..."
slack_echo = "all"
```

`AGENT_MAIL_SLACK_WEBHOOK` can supply the URL instead. agent-mail also falls
back to `SLACK_WEBHOOK` in `~/.config/weft/config` when neither setting is
present. Reload the daemon and send a test message:

```bash
agent-mail graceful
agent-mail notify --project "$PWD" --from cli --message "Slack connection test"
```

The webhook is enough for per-message echoes. The editable Slack dashboard
also uses the Web API. Add the [`chat:write`
scope](https://docs.slack.dev/reference/scopes/chat.write/) to the Slack app,
reinstall the app in the workspace, and invite its bot to the target channel.
Copy the Bot User OAuth Token and the channel ID into the same config file:

```toml
slack_bot_token = "xoxb-..."
slack_channel = "C0123ABCD"
```

Environment-variable equivalents are `AGENT_MAIL_SLACK_BOT_TOKEN` and
`AGENT_MAIL_SLACK_CHANNEL`. Post or refresh the dashboard with:

```bash
agent-mail slack-dashboard
```

Example:

```text
Quiet Lantern (Claude, project: augur)
          |
          | send_mail to Silver Otter
          | "Can you verify the latency table?"
          v
 +--------------------+        Slack #agent-mail
 | agent-mail spool   |------> [12:14] augur: Quiet Lantern -> Silver Otter
 +--------------------+        "Can you verify the latency table?"
          |
          | durable inbox
          v
Silver Otter (Codex, project: augur)
          |
          | check_inbox; reply_to=msg-104
          | "Row 21 still uses milliseconds."
          v
 +--------------------+        Slack #agent-mail
 | agent-mail spool   |------> [12:17] augur: Silver Otter -> Quiet Lantern
 +--------------------+        "Row 21 still uses milliseconds."
          |
          | channel push
          v
Quiet Lantern receives the reply
```

## CLI

```bash
agent-mail notify --project <dir> --message <text> [--from <label>] [--reply-to <id>] \
  [--session <name-or-id>] [--idempotency-key <key>] [--ttl <seconds>] [--no-slack]
                                      # --session addresses one session; see below
agent-mail inbox [--project <dir>] [--limit N] [--unread]
agent-mail mark-read [--project <dir>] (--id <message-id> | --all)
agent-mail receipts [--project <dir>] [--id <message-id>] [--limit N]
agent-mail listeners [--project <dir>] [--json] [--no-sync]
                                      # attached sessions + idle times
agent-mail state [--project <dir>] [--no-sync] [--json]
                                      # stable non-mutating aggregate state
agent-mail status-line [--project <dir>] [--session <id>] [--debug]  # see below
agent-mail mute|unmute (--session <name-or-id> | --project <dir>)  # pause/resume push
agent-mail inbound --policy accept|hold|refuse \
  (--session <name-or-id> | --project <dir>)
agent-mail claim-experiment [--project <dir>] [--notebook <dir>] [--owner <label>]
agent-mail claim-path --path <path> [--path <path> ...] [--directory] [--project <dir>] [--owner <label>]
agent-mail claims [--project <dir>]
agent-mail release-claim --id <claim-id> [--project <dir>]
agent-mail work list [--project <dir> | --all] [--type <type>] [--owner <owner>]
agent-mail work acquire --type <type> --key <key> [--label <label>] [--source <path>] [--owner <label>]
agent-mail work update --id <work-id> [--state working|waiting] [--activity <text>]
agent-mail work release --id <work-id> [--project <dir>]
agent-mail coordination list [--project <dir> | --all] [--kind <kind>] [--json]
agent-mail coordination recover --id <coordination-id>
agent-mail coordination request-transfer --id <work-id> [--reason <text>] [--timeout <seconds>]
agent-mail coordination respond-transfer --id <request-id> --decision accept|decline [--message <text>]
agent-mail coordination transfers [--project <dir> | --all] [--json]
agent-mail dashboard [--port N] [--open] [--no-tui]   # web dashboard
agent-mail slack-dashboard [--watch <seconds>]        # editable Slack dashboard
agent-mail start|stop|restart|status  # daemon (launchd-aware)
agent-mail graceful                   # SIGHUP: reload config
agent-mail logs [-f]
agent-mail install [--native-audit] [--no-codex] [--replace-claude] [--replace-codex]
agent-mail uninstall
```

## Dashboards

The installed daemon continuously serves a read-only dashboard at its base URL
(`http://127.0.0.1:8377/` by default). It shows live sessions, unified
coordination health, sender→recipient traffic, hourly volume, and a flight log,
polling every two seconds. `agent-mail status` prints the configured URL.

`agent-mail dashboard` reports that persistent URL; pass `--open` to open it.
When the daemon is down it automatically starts the previous direct-filesystem
fallback on the daemon port plus one. An explicit `--port N` always starts the
fallback. Its terminal controls remain `o` to open and `q` to quit; use
`--no-tui` for a plain long-running server. Both forms read the filesystem
source of truth. Recovery remains available through MCP and the CLI.

`agent-mail slack-dashboard` posts the same summary as a single Slack message
and edits it in place on each run (`--watch <seconds>` to refresh on a timer).
This needs a Slack **bot token** (the incoming webhook used for per-message
echoes can't edit messages). See [Connecting to Slack](#connecting-to-slack).

## Claude Code status line

`agent-mail status-line` prints this session's display name when another live,
non-stale session shares the project. It prints nothing when the session has no
live peers because the name would not disambiguate it.

It reads Claude Code's [statusLine](https://code.claude.com/docs/en/statusline)
JSON payload on stdin, taking the session ID and project directory from it. Add
it to your status line script:

```bash
#!/bin/bash
# Claude Code closes stdin when it is done, so `cat` returns. The tty check
# keeps a manual invocation from blocking.
input=""
[ -t 0 ] || input=$(cat)

cwd=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')

# Forward the payload already captured because stdin was consumed above.
session=""
if [ -n "$input" ] && command -v agent-mail >/dev/null 2>&1; then
    session=$(printf '%s' "$input" | agent-mail status-line 2>/dev/null)
    [ -n "$session" ] && session=" $session"
fi

printf '%s%s\n' "${cwd/#$HOME/\~}" "$session"
```

```
~/code/agent-tools/agent-mail                  # alone
~/code/agent-tools/agent-mail Quiet Lantern    # sharing with another agent
```

Then point `statusLine` at it in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" } }
```

### Status line behavior

- **Guard on `command -v agent-mail`.** The script runs for every project on
  the machine, including ones where agent-mail isn't installed.
- **Redirect stderr.** Anything the command writes to stderr would otherwise
  land in the prompt. `--debug` reports the resolved project, session ID, and
  each peer's recency tag there.
- **Put it last.** The name appears and disappears as peers come and go.
  Trailing placement keeps the rest of the line from shifting sideways.
- **The exit code is always 0.** This includes errors, so `$(...)` stays safe
  under `set -e`. Empty output means "nothing to show."
- Claude Code cancels a status line command when the next update arrives. A
  canceled script drops the whole line, so the script must finish well within
  the 300 ms debounce. `status-line` reads the daemon's presence snapshot (see
  below) and costs about 40 ms. Most of that time is process startup. With the
  daemon stopped, it uses a project-scoped scan that costs about 50 ms.

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

For a normalized cross-surface view, use
`agent-mail state --no-sync --json` (optionally `--project <dir>`) or
`GET /api/v1/state?project=<dir>`. Schema version 1 includes normalized
presence with process identity and freshness, coordination entries with owner
status and conditions, transfer requests, recent canonical message IDs and read
state, routes, counts, logs, and source provenance. Both interfaces are
read-only: they do not scan processes, prune registrations, or mutate claims
or leases. The CLI without `--no-sync` asks the daemon first and falls back to
the same filesystem-snapshot reader. Consumers must inspect the `freshness`
fields rather than treating an old snapshot as negative liveness evidence.

Schema-v1 top-level fields are `schemaVersion`, `generatedAt`, `source`,
`freshness`, `totals`, `presence`, `coordination`, `transfers`, `messages`,
`routes`, `log`, `volume`, and the compatibility `work` projection. `messages`
contains the newest 60 records in newest-first order; totals, routes, and volume
are computed from the full spool history. Additive fields may appear within
version 1; removing or changing the meaning of a field requires a new schema
version and endpoint.

For poll-only sessions, `lastSeen` means only that some agent-mail tool ran; it
does not imply that the inbox was checked. `lastInboxPoll` is stamped only by
`check_inbox`, including an empty check, so automation can distinguish recent
polling from unrelated activity. It still predicts only that the session may
poll again. For a message already sent, `agent-mail receipts --id <message-id>`
distinguishes `pushed` (channel delivery or an inbox pull) from `read` (an
explicit mark-read); neither status proves that the recipient completed the
requested work.

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
project base in full names (e.g. `augur-quiet-lantern` instead of
`llm-performance-models-quiet-lantern`) across `listeners`, `list_sessions`,
and both dashboards. Display names such as `Quiet Lantern` omit the project
base. Also settable via
`AGENT_MAIL_SESSION_ALIASES`. Changes are picked up on daemon `graceful`
(SIGHUP) and by each new CLI/dashboard invocation.

The `notify --no-slack` flag suppresses the mirror for that message only. The
message is still appended to the project inbox, and other messages continue to
use the configured `slack_echo` policy. Per-message echoes use display names in
compact routes. A project broadcast shows up to three currently attached
display names and `+N`; this list is a live snapshot rather than a delivery
boundary. Deliberate Claude `/rename` names are kept verbatim.

## HTTP API (127.0.0.1 only)

| Endpoint | Description |
|---|---|
| `GET /` | persistent read-only web dashboard |
| `GET /api/v1/state?project=<path>` | schema-v1 non-mutating aggregate state; project is optional |
| `GET /api/state` | compatibility alias for `/api/v1/state` |
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
