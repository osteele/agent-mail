---
status: accepted
date: 2026-08-16
---

# 0003. Automation notifications are addressed to the submitting session

## Context and Problem Statement

`agent-mail notify` had no way to name a recipient, so every automation
notification was a project broadcast. weft's `[notifications] command` fires one
per finished job, which meant one job woke every session attached to that
directory. Two costs: the sessions that did not submit the job are interrupted
for something that is not theirs, and a long-idle session pays a full
uncached-context reload to read one line.

Filtering the notification away was rejected outright — waking the agent that
submitted a job is the point of the feature, including on success. What was
wrong was the fan-out, not the wake.

Addressing needs a session id that the submitting agent's *shell subprocess*
can read, since that is where `weft run` executes:

| Agent | Exports into its shell subprocess |
|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ID` — identical to the agent-mail session id |
| Codex | `CODEX_THREAD_ID` |
| kimi | nothing (`KIMI_SESSION_ID` is read, never set) |
| opencode | nothing (`OPENCODE_PID`; `OPENCODE_WORKSPACE_ID` is per-directory) |

kimi and opencode sessions therefore fell through to a `randomUUID()` minted
inside the channel server, which no sibling subprocess can learn — those
sessions could not be addressed at all, by anything.

A child agent inherits its parent's `CLAUDE_CODE_SESSION_ID` unchanged: a kimi
launched from a Claude session sees the Claude session's id.

## Decision Outcome

Resolve the session id in one place, `sessionIdFromEnv()`, over
`SESSION_ID_ENV_VARS` = `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`,
`AGENT_SESSION_ID`, skipping empty values. `notify --session <name-or-id>` sets
`meta.toSession`, which `messageVisibleToSession` already honours on both the
push and the readback path.

`AGENT_SESSION_ID` is minted by `agent-command-guards`' `agent-launcher`, which
also unsets the native ids before exec'ing kimi or opencode.

Three parts of this look arbitrary and are not:

- **Native ids resolve before `AGENT_SESSION_ID`.** The order matters only when
  both are present, which is the nested case. An agent that mints its own
  per-session id knows more than a launcher wrapping it does.
- **The launcher unsets the native ids, and mints unconditionally.** Without the
  unset, a nested agent answers to its parent's inherited id and its work is
  attributed to one specific wrong session — worse than a broadcast, which at
  least reaches the right session among others. The unset and the resolution
  order are two halves of one rule; neither is safe to remove alone.
- **`notify` broadcasts when `--session` resolves to nothing, where the
  `send_mail` tool refuses.** The two callers differ. An agent calling
  `send_mail` is present to read an error and retry. An automation reporting a
  finished job is not, and its addressee may well have exited while the job ran;
  refusing would discard the notification entirely, which is strictly worse than
  the broadcast this replaces. Ambiguous names degrade the same way.

### Consequences

- A session in an agent that exports no native id and is started outside the
  guard launcher cannot be addressed. It gets a broadcast.
- `AGENT_SESSION_ID` is per-launcher-invocation, not per-session. An opencode
  process hosting several sessions gives them all one id, and a `kimi -r` resume
  gets a new one. Both are coarser than Claude's native id and strictly better
  than the unaddressable UUID they replace.
- The contract spans systems. weft captures the submitter id at `weft run` time
  from the first non-empty of an ordered, configurable env-var list
  (`[notifications] submitter_session_env_vars`, defaulting to
  `SESSION_ID_ENV_VARS`' order — a configured list replaces the defaults, since
  the order is load-bearing), persists it on the job as an opaque string, and
  re-exports it at notify time as `WEFT_JOB_SUBMITTER_SESSION`. weft reads the
  environment only in the process the submitter invoked, never in a shared
  recording path — a daemon started from an agent shell would stamp every job
  with its one inherited session id, the nesting failure the launcher's unset
  exists to prevent, at daemon scale. A failed lookup warns and broadcasts
  rather than dropping the notification.
- Three repos encode the env-var order: `SESSION_ID_ENV_VARS` here, the
  launcher's unset list, and weft's `defaultSubmitterSessionEnvVars`
  (`internal/config/config.go`). A change to one needs matching changes to the
  others.
