# Configuration

The daemon, the CLI, and the dashboards read
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

The Slack settings are introduced, with their environment-variable
equivalents, in the README's
[Connecting to Slack](../README.md#connecting-to-slack).

`session_aliases` is a comma list of `basename=alias` pairs that shorten the
project base in full names (e.g. `augur-quiet-lantern` instead of
`llm-performance-models-quiet-lantern`) across `listeners`, `list_sessions`,
and both dashboards. Display names such as `Quiet Lantern` omit the project
base, and a deliberate Claude `/rename` is kept verbatim. Also settable via
`AGENT_MAIL_SESSION_ALIASES`. Changes are picked up on daemon `graceful`
(SIGHUP) and by each new CLI/dashboard invocation.

The `notify --no-slack` flag suppresses the Slack mirror for that message
only. The message is still appended to the project inbox, and other messages
continue to use the configured `slack_echo` policy.
