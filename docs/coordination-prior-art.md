# Coordination claims: design evaluation and prior art

An evaluation of agent-mail's coordination mechanism (path claims, work
leases, experiment-number claims, and lease transfers) against established
locking and lease designs. Written 2026-08-15 from a review of `claims.ts`,
`work.ts`, `transfers.ts`, and `coordination.ts`. Decisions that came out of
this review are recorded in [decisions/](decisions/README.md); this note is
the reference material behind them.

## The taxonomy

The mechanism separates three concerns that most prior art muddles:

- **Path claims** express *edit exclusion*: which files or directories an
  agent intends to modify. They never imply responsibility for any task.
- **Work leases** express *execution responsibility*: which agent owns a
  logical unit of work (such as running a research plan). They never block
  file edits.
- **Experiment claims** express *identifier allocation*: reserving the next
  `EXP-NNN` number ahead of creating its file.

This separation is the design's distinctive strength. WebDAV has only locks;
Kubernetes has only leases; most systems that need both conflate them. Keeping
the three claim types orthogonal is what lets a work lease survive a status
directory move (the resource key is a stable filename stem, not a path) and
lets a path claim be released the moment an edit lands without touching
anyone's notion of who is responsible for the plan.

All three are **advisory**: they coordinate cooperating agents rather than
enforcing anything at the filesystem layer. That choice matches Chubby, Git
LFS locking, and SVN locking, all of which chose advisory semantics for
cooperating clients. Its limits are accepted in
[decision 0002](decisions/0002-no-fencing-tokens.md).

## Path claims and WebDAV locking

The conflict rule — exact path match conflicts; a directory claim conflicts
with any descendant; any claim conflicts with a claimed ancestor directory —
is exactly the exclusive lock with `Depth: infinity` from WebDAV
(RFC 4918 §7). Claiming a path that does not exist yet corresponds to WebDAV's
"lock-null resource." Git LFS file locking and `svn lock` are the same idea in
coarser form: path + owner + timestamp, advisory, with force-unlock as a
separate deliberate act. Three independent systems converging on this shape is
good validation of the semantics.

Two places where this design differs from the standards, both deliberately:

- **No shared (read) locks.** WebDAV, `flock`, and databases distinguish
  shared from exclusive locks. Here reads are never gated, so an advisory
  *edit* claim is inherently exclusive and the shared variant would have no
  use.
- **Atomic multi-path groups.** One acquisition claims an entire edit set and
  one claim id releases it; validation and conflict detection complete before
  the single grouped record is published, so failure leaves no partial claims.
  WebDAV has no equivalent (its locks are per-resource). The compatibility
  projection — a multi-path group presents to pre-group readers as a
  project-wide directory claim, over-blocking rather than silently violating
  the group — has no standard analogue either; it is a conservative-degradation
  idea worth keeping.

**Scaling note.** Conflict detection scans every live claim's targets against
every requested target. Databases solve the ancestor-check cost with
*intention locks* (multiple-granularity locking, Gray et al. 1975): a marker
on each ancestor node makes hierarchy conflicts O(depth) instead of
O(claims × targets). Irrelevant at current claim counts; this is the named
escape hatch if per-project claim volume ever grows by orders of magnitude.

## Work leases, Kubernetes Lease, and liveness vs. TTL

`WorkLease` is structurally a Kubernetes `coordination.k8s.io/Lease`:
`owner` ≈ `holderIdentity`, `createdAt` ≈ `acquireTime`, `updatedAt` ≈
`renewTime`. The deliberate difference is how a dead holder is detected.
Leases in the literature (Gray & Cheriton 1989) and in Kubernetes are
**time-bounded**: the holder must renew before a TTL, and expiry is the sole
recovery path. agent-mail instead uses **liveness verification**: owner
identity captures `pid` + `procStart` (plus session/instance ids), and
recovery requires proving the exact recorded process is dead.

For a single machine — where the process table is directly inspectable — the
liveness approach is the better trade. There is no false expiry under a
slow-but-live holder (the classic TTL failure mode), no heartbeat traffic, and
no tuning of a lease duration against worst-case pauses. The cost is that it
cannot extend to anything that cannot be `ps`-inspected: remote sessions,
containers, another machine. That boundary is accepted in
[decision 0001](decisions/0001-single-machine-coordination-identity.md); if it
ever moves, TTL + renewal is the standard fallback and the schema already
carries the fields it would need.

The `pid` + `procStart` identity itself is the established fix for pid
recycling — the same composite that Emacs `.#file` lockfiles
(`user@host.pid:boottime`) and modern pidfile conventions use. Legacy records
that stored only a pid are handled by comparing process start time against
record creation time, which proves a same-pid process is a replacement; when
either timestamp cannot be read, the owner is reported `unverifiable` rather
than `offline`, keeping recovery fail-safe.

Kubernetes has one field worth copying if the transfer audit trail ever wants
it: `leaseTransitions`, a counter of ownership changes.

## Experiment claims and sequence allocation

The experiment claim is a sequence allocator with a reserve-then-materialize
protocol: the next number is `max(existing EXP-* files, live reservations) + 1`,
and the caller must create the experiment file *before* releasing the
reservation. That ordering obligation is the mechanism's weakest point — it is
a convention that correctness depends on, enforced only by documentation. A
claim released without materializing lets the max fall back and the number be
reallocated.

Two standard alternatives, either of which would remove the obligation:

- **Allocate by creating** (the Maildir / `mktemp` move): make allocation and
  materialization the same atomic act by `O_EXCL`-creating the `EXP-NNN.md`
  file (or a stub) as the reservation itself. This deletes the claim type, the
  release-ordering rule, and the reuse hazard, at the cost of stub files on
  abandonment.
- **Never reuse** (the database-sequence convention): Postgres sequences are
  non-transactional and gaps are normal. A persisted per-notebook high-water
  mark makes released-without-materializing burn the number instead of
  recycling it.

Neither is adopted; this section records that the current design sits between
two named conventions and which obligation that position carries.

## Transfers and optimistic concurrency

The transfer protocol captures `expectedOwner` + `expectedUpdatedAt` at
request time and settles with a compare-and-swap against them — optimistic
concurrency in the style of etcd's `mod_revision`, Kubernetes
`resourceVersion`, or HTTP `If-Match`. A lease that changed after the request
settles as `superseded` rather than transferring, and timeout-defaults-to-
transfer gives a consensual handoff path that never requires breaking a live
owner's lease. (The CAS token is moving from the raw `updatedAt` timestamp to
a monotonic revision counter, per the standard practice of those systems —
timestamp equality has millisecond-resolution ABA.)

SVN's vocabulary maps cleanly onto the two recovery paths and is useful
shorthand: *breaking* a lock (removing a dead owner's — `recover_coordination`,
which requires proof of death) versus *stealing* a lock (taking over a live
owner's — the transfer request, made consensual with a deadline).

## Crash-consistency conventions the implementation matches

- **Publish-before-delete replacement.** When an acquisition replaces stale
  records, the new record is written before the stale ones are unlinked, so an
  interruption can over-block (two records) but never leave the resource
  unowned. This is standard write-ahead-intent ordering.
- **Temp-file + rename writes.** Records are written with `wx` to a temporary
  name and renamed into place, the universal atomic-publish idiom.
- **mkdir mutex.** The short per-project lock serializing mutations is the
  portable dotlock convention (mkdir is atomic where `O_EXCL` historically was
  not). The mail-spool refinement of recording owner identity inside the lock,
  and the break-stale race fix (atomic rename-then-remove, per liblockfile /
  `proper-lockfile`), came out of this review as implementation work. One
  invariant to keep in mind: the holder never refreshes the lock's mtime, so
  the critical section must stay well under the 30-second staleness threshold
  — true today because mutations are tiny synchronous transactions.

## Verdict

The mechanism independently re-derives the load-bearing parts of WebDAV
locking, Kubernetes leases, and the lockfile identity conventions, and its
three-way taxonomy is cleaner than any single piece of prior art it resembles.
The invariants around canonical project paths, publish-before-delete ordering,
and dead-owner-only recovery are the right instincts and match how the mature
systems behave. Where the design departs from a standard, the departure is
either justified by the single-machine setting (liveness over TTL) or recorded
as an accepted trade-off in the decision log.
