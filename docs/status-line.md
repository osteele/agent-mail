# Status line reference

`agent-mail status-line` reads Claude Code's
[statusLine](https://code.claude.com/docs/en/statusline) JSON payload on stdin
and prints this session's display name. The
[README](../README.md#claude-code-status-line) shows the basic wiring; this
page specifies the `--fields` output and collects advice for the script around
it.

The name prints whether or not anyone else is in the project. It is the
session's address, so it stays up even when there is nobody to be confused
with; a name that came and went as peers appeared would be worse than one that
is simply always there. The command prints nothing only when the payload
carries no session id.

## `--fields`

`--fields` prints one tab-separated line carrying the name, peer count, unread
messages, whether mail reaches this session on its own, and unprocessed weft
jobs this session submitted. A status line can then show all five from a
single invocation, rather than reimplementing agent-mail's registry and spool
semantics in shell:

```
Quiet Lantern\t2\t0\tpush\t3
Quiet Lantern\t2\t3\tpull\t0
Quiet Lantern\t0\t0\tunknown\t
```

Fields are only ever appended. A consuming script splits positionally, so
inserting one would silently mislabel every field after it.

### The push/pull field

The fourth field is `push` when channel push is expected to land, `pull` when it
is not, `unknown` when the session is registered but carries no diagnosis, and
empty when no session is registered to ask about. There are two unrelated ways
to be pulling: a host that is not Claude Code has no channel at all, so every
Codex, kimi, and opencode session is pull-only by construction; and a Claude
Code session can hold a channel it cannot use, because its host was launched
without the flag or under an identity the host will not authorize. They differ
in how you repair them, and `agent-mail status` says which. They do not differ
in what a reader needs to do, which is to check mail rather than wait for it. A
session cannot see any of this about itself: it emits successfully and hears no
complaint.

### The weft-jobs field

The fifth field counts unprocessed weft jobs whose submitter session is this
one. It is read from a snapshot the daemon refreshes every 60 seconds
(`~/.claude/agent-mail/weft-jobs.json`), never by running weft on the read
path: `weft list jobs` takes seconds, and Claude Code drops the whole status
line when the script overruns its budget. The field is empty when no usable
snapshot exists, which covers a stopped daemon, a snapshot older than three
minutes, and a weft that never ran. Empty and `0` are different claims: `0`
says weft was asked and this session has nothing pending.

## Writing the script

- **Guard on `command -v agent-mail`.** The script runs for every project on
  the machine, including ones where agent-mail isn't installed.
- **Redirect stderr.** Anything the command writes to stderr would otherwise
  land in the prompt. `--debug` reports the resolved project, session ID, and
  each peer's recency tag there.
- **Give identity its own row.** A script can print several lines, each of
  which Claude Code renders as its own status row. A single long line is
  truncated from the right in a split pane, taking whatever is last with it, so
  the name and any alarm belong on a short first row and expendable telemetry
  on a second.
- **Size the output with `$COLUMNS`.** Claude Code sets `COLUMNS` and `LINES`
  before each run, and the value tracks the pane the session is actually in
  (v2.1.153+). `tput cols` cannot work: the script's output is captured rather
  than connected to the terminal. `LINES` is the terminal height, not a row
  allowance. Every row taken is a row of transcript lost.
- **The exit code is always 0.** This includes errors, so `$(...)` stays safe
  under `set -e`. Empty output means "nothing to show."
- Claude Code cancels a status line command when the next update arrives. A
  canceled script drops the whole line, so the script must finish well within
  the 300 ms debounce. `status-line` reads the daemon's presence snapshot
  (described in [automation.md](automation.md)), and `--fields` also scans the
  project spool for the unread count; together they cost roughly 100 ms on an
  unloaded machine, most of it process startup. With the daemon stopped, a
  project-scoped process scan replaces the snapshot read. Measure on a quiet
  machine: under heavy load every part of this slows by the same large factor,
  so a figure taken then describes the load rather than the command.
