---
status: accepted
date: 2026-08-19
---

# 0005. Windows is unsupported, and stays out of CI

## Context and Problem Statement

Session liveness is read by running `ps` and parsing its `lstart` column
(`PS_EXECUTABLE` in `registry.ts`). That value is what `listLive()` prunes on,
what distinguishes a live owner from a recycled pid, and what
`recover_coordination` needs before it will release another session's lease.
Windows has no `ps` and no drop-in equivalent.

The first CI run added a `windows-latest` row. It failed on CRLF line endings
before reaching any application code, which makes the platform question easy to
misread as a `.gitattributes` problem.

## Decision Outcome

Windows is unsupported. The CI matrix covers macOS and Linux only.

The reason is not that a Windows build would fail. It would run.
`scanProcesses` already returns `reliable: false` when the process inspector is
unavailable, and callers treat that as absence of evidence rather than proof of
death, which is correct. On Windows that state would be permanent, and the
consequences compound quietly: the registry could never prune, so ghost
sessions would accumulate indefinitely; no claim or work lease could ever be
proven stale, so recovery would require an authority override every time; and
the channel-push diagnosis, which reads the host process command line, would
sit at `unknown` forever. Every one of those is a silent degradation of
coordination, which is the part of this system where being quietly wrong is
most expensive.

A green `windows-latest` row would assert a support level that does not exist,
because CI would be exercising the paths that work while the ones that matter
degrade invisibly.

### Consequences

- Nobody should add `windows-latest` back to the matrix as a tidy-up. The
  absence is deliberate, and this record is the reason.
- Linux stays in the matrix and earns its place: `PS_EXECUTABLE` already
  branches for it, and the first run caught two tests that had encoded macOS
  behavior (a registry directory assumed to exist, and `/tmp` assumed to
  resolve to `/private/tmp`).
- Windows remains reachable later. The `reliable: false` seam is already the
  right place for a second backend, so deferring costs nothing structurally.
  Adding support means a process-inspection backend with start-time
  canonicalization, plus path canonicalization for a case-insensitive
  filesystem, where two spellings of one directory would otherwise hash to two
  mailboxes.
- The CRLF failure was never addressed. If Windows is ever supported, a
  `.gitattributes` pinning `eol=lf` is the first thing needed, and it is not
  sufficient.

## Considered Options

### Add `.gitattributes` and let the Windows row go green

Rejected: it fixes the checkout, not the platform. The formatter error is the
first failure, not the only one, and clearing it would produce a passing row
for a configuration whose coordination features do not work.

### Support Windows with coordination degraded

Rejected: the degraded modes are ghost sessions and unrecoverable claims, both
silent. A build that delivers mail while quietly failing to expire anything is
harder to diagnose than one that does not exist, and nobody currently runs
sessions on Windows to justify the cost.

## More Information

- **Builds on**: [0001](0001-single-machine-coordination-identity.md), which
  already ties owner identity to process inspection on one machine.
- **References**: `PS_EXECUTABLE` and `scanProcesses` in `src/registry.ts`;
  `diagnoseChannelPush` in `src/channelIdentity.ts`.
