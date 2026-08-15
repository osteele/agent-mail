---
status: accepted
date: 2026-08-15
---

# 0002. Claims stay advisory; no fencing tokens

## Context and Problem Statement

Kleppmann's critique of distributed locking observes that a lock alone cannot
protect a resource from a holder that is paused (GC, suspend, debugger) past
its lease and then resumes: the resource itself must reject stale writes,
which requires a monotonically increasing token issued at each acquisition
(a "fencing token"; Chubby calls these sequencers) and a resource that checks
it.

For agent-mail claims, the protected resources are ordinary files edited by
cooperative agents. The filesystem cannot check a token, and no enforcement
layer sits between an agent and its edits.

## Decision Outcome

Do not add fencing tokens. Claims and work leases are advisory coordination
among cooperating agents, not enforcement; a token no resource can verify
adds schema and protocol weight without adding protection.

### Consequences

- A stale-but-alive owner that ignores the coordination protocol can still
  write; this is inherent to advisory locking and accepted.
- If artifact-level attribution is ever wanted (for example, an experiment
  file recording which claim epoch produced it), the per-lease monotonic
  revision counter introduced for the transfer compare-and-swap can double as
  the token — no new mechanism would be needed, only a convention for writing
  it into artifacts.
