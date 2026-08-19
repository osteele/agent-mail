# Dashboards

The installed daemon continuously serves a read-only dashboard at its base URL
(`http://127.0.0.1:8377/` by default). It shows live sessions, unified
coordination health, sender→recipient traffic, hourly volume, and a flight log,
polling every two seconds. `agent-mail status` prints the configured URL.

`agent-mail dashboard` reports that persistent URL; pass `--open` to open it.
When the daemon is down it starts a direct-filesystem fallback server instead;
[cli.md](cli.md) covers the flags. Both forms read the filesystem
source of truth and are read-only: recovering a stale claim or work lease
happens through the CLI or the MCP tools, not the dashboard.

`agent-mail slack-dashboard` posts the same summary as a single Slack message
and edits it in place on each run (`--watch <seconds>` to refresh on a timer).
This needs a Slack **bot token** (the incoming webhook used for per-message
echoes can't edit messages). See the README's
[Connecting to Slack](../README.md#connecting-to-slack).

The daemon binds 127.0.0.1; the README's
[security note](../README.md#security-note) covers what that exposes.
