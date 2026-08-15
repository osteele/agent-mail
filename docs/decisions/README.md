# Decision records

Engineering decisions that constrain agent-mail, with the alternatives that
were rejected and the consequences that follow. The format matches
`../../../cross-agent-review/docs/decisions/`.

A record belongs here when a future reader could reasonably undo the decision
by mistake — because the rule looks arbitrary, looks like an unfinished
feature, or looks like a safe simplification.

Records are immutable once accepted. A change of position is a new record that
names the one it supersedes.

| # | Decision | Adopted |
|---|---|---|
| [0001](0001-single-machine-coordination-identity.md) | Coordination owner identity assumes a single machine | 2026-08-15 |
| [0002](0002-no-fencing-tokens.md) | Claims stay advisory; no fencing tokens | 2026-08-15 |
