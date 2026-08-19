# Installer behavior

How `agent-mail install` treats existing registrations, and the registration
conflict that can silently disable channel push. The
[README](../README.md#client-integration-and-updates) covers the normal
install and update flow.

## Existing entries

The installer uses `codex mcp add` when no Codex entry exists. It preserves an
entry that already matches this installation. If either client already uses the
name for a different one, the installer leaves it unchanged. Inspect the
Codex entry with `codex mcp get agent-mail --json`. Use `--replace-codex` or
`--replace-claude` to replace an entry deliberately. Use `--no-codex` to skip
Codex registration.

## Plugin versus user-scope registration

A user-scope `mcpServers` entry and the plugin register the same server name,
and when both exist Claude keeps only the user-scope entry. That instance
pushes under the channel identity `server:agent-mail` rather than
`plugin:agent-mail@<marketplace>`, which the host has not authorized, so every
push is discarded without an error while tools and the CLI keep working. The
installer therefore does not write a user-scope entry when the plugin is
enabled in `~/.claude/settings.json`, and removes one that belongs to this
installation. If the entry points somewhere else, the installer reports it and
leaves it in place; remove it with `claude mcp remove agent-mail`. Restart
Claude sessions afterward.

Each session's MCP server log records this at startup when push cannot land,
naming the identity it would push under and the channels the host authorized.
