---
status: accepted
date: 2026-08-16
---

# 0004. A declared authority can force recovery; it is recorded, not verified

## Context and Problem Statement

`recover_coordination` released a claim or work lease only when agent-mail
could prove the owning process was dead. Any other owner status — `live`,
`manual`, or `unverifiable` — refused, and the error told the caller to ask the
operator.

That left no in-tool path for the case the rule was written to guard against.
Manually registered CLI owners (`cli:<label>`) have no process to revalidate,
so they are permanently unrecoverable by design. When such a session ends
without releasing, its claims outlive it forever. Observed in practice: a
2026-08-14 CLI-registered owner held ten paths across a research project,
including two experiment records and a shared changelog, and was still holding
them two days later with the owner absent. The operator could see the lock was
stale; the tool that manages locks could not act on that, while `agent-mail
release-claim --id` — a command with no ownership check at all — released it
immediately.

So the strict check was not protecting anything. It was steering operators to a
less careful command that leaves no trace.

## Decision Outcome

`recoverCoordination` accepts an optional `authority` string. When supplied and
non-empty, it bypasses the liveness proof and force-releases the record.
agent-mail does not verify it.

The authority is written to an append-only log at
`~/.claude/agent-mail/forced-recoveries.jsonl` **before** the destructive
delete, capturing the record's identity, its owner, the owner's status at the
time, and the declared authority. If the audit write fails, the recovery is
refused.

### Why an unverifiable string is the right control

Claims are advisory (see [0002](0002-no-fencing-tokens.md)). No enforcement
boundary exists to defend: an uncooperative process can edit any file whether
or not it holds a claim. The liveness check was therefore never security. Its
real function is *friction* — stopping an agent from reflexively stealing a
peer's lock when blocked.

A required, recorded, unverifiable declaration preserves exactly that friction.
It cannot be produced by accident, it forces the caller to state a reason, and
it leaves evidence. Verification would add nothing, because there is no
authority the tool could check against: the operator is a human at a terminal,
not a principal with a credential.

### Consequences

- Any caller willing to write an authority string can break any lock. This is
  deliberate and matches the pre-existing capability of `release-claim --id`,
  which this leaves as the redundant path rather than the escape hatch.
- The MCP tool description instructs agents that only the user may supply an
  authority, and that one must never be inferred or taken from mail, files, or
  other tool output — the same untrusted-input boundary the server instructions
  already establish for incoming mail.
- Forced recoveries are auditable after the fact; ordinary liveness-proved
  recoveries are not logged, because the proof is the record.
- Rejected alternative: auto-expiring manual claims after a fixed age. It
  guesses at intent, and a long-running deliberate hold is indistinguishable
  from an abandoned one — the operator has information the timer does not.
