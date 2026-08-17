---
status: accepted
date: 2026-08-15
---

# 0001. Coordination owner identity assumes a single machine

## Context and Problem Statement

Claim and work-lease owner identity is `pid` + `procStart` (plus
`sessionId`/`instanceId` where available), and liveness is verified by
inspecting local processes. This is the same pid-recycling fix used by Emacs
lockfiles and modern pidfile conventions, but it is only meaningful on the
machine where the owner process runs.

NFS-aware lockfile conventions (mail-spool dotlock, Emacs `.#file`) record
`user@host` alongside the pid so that a lock created on another machine is
never mistaken for a locally dead owner. Adopting that here would mean adding
a hostname field to `ClaimOwner`/`WorkOwner` and treating a hostname mismatch
as `unverifiable` (never `offline`) in `ownerStatus()`.

## Decision Outcome

Do not record hostname. agent-mail's coordination store
(`~/.claude/agent-mail/`) is designed for a single machine: one daemon, one
process table, local sessions. The extra field would add a code path that is
never exercised in the supported deployment.

### Consequences

- If the coordination store ever lands on a shared or synced filesystem
  (network home directory, file sync), pid + procStart comparisons against
  the local process table become meaningless in the unsafe direction: a live
  owner on another machine looks dead and therefore recoverable.
- Revisit this record before any multi-machine or shared-filesystem
  deployment; the fail-safe design (hostname recorded, mismatch →
  `unverifiable`) is known and cheap to add at that point.
