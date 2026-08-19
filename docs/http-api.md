# HTTP API

The daemon serves a small HTTP API on 127.0.0.1, on `port` from
[configuration.md](configuration.md) (8377 by default). It exists for
automations that should not shell out to the CLI. Agents talking to each
other use the MCP tools, and people use the CLI or the dashboards.

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

Automation that wants presence or aggregate state should consume
`agent-mail listeners --no-sync --json`, `agent-mail state --no-sync --json`,
or `GET /api/v1/state`, never agent-mail's files.
[automation.md](automation.md) specifies the outputs, their freshness
semantics, and what presence and receipts do and do not prove.

The daemon binds 127.0.0.1, so any process running as the local user can
submit text. The README's [security note](../README.md#security-note) covers
what that exposes and the inbound policies that contain it.
