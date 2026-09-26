# ADR 009: encrypted chain history and count-session semantics

**Status:** accepted target; count-session domain implemented locally; live testnet path blocked  
**Date:** 2026-09-26

## Decision

A.R.G.U.S. has one signed domain-event history. An action validates against an enrolled
organization authority, signs canonical event bytes, and atomically commits the event,
projection, and durable local outbox. Encryption prepares one authenticated envelope and
retains those exact bytes for every retry. A configured BSV testnet wallet publishes the
encrypted operational envelope itself (not merely its hash or an off-chain URL). A history
index enumerates transaction IDs, including spent transactions. Authorized clients fetch
transactions, validate the intended network and inclusion evidence, verify the event
signature and authority checkpoint, decrypt, validate, deduplicate, and project them.

The following are deliberately separate facts:

1. **saved locally** — the IndexedDB transaction committed;
2. **pending peer delivery** — an optional relay has, or is trying to deliver, ciphertext;
3. **broadcast** — a provider accepted transaction bytes, with an outcome that may still be
   ambiguous after a timeout;
4. **overlay admission** — an index accepted the record under its topic rules;
5. **network confirmation** — trusted testnet headers and a Merkle path establish inclusion;
6. **application acceptance** — signature, authority, organization, schema, dependencies,
   and domain rules passed; and
7. **archival retention** — redundant services/checkpoints are expected to retain history.

A proof of one transaction establishes neither enumeration completeness nor authorization.
Organization enrollment therefore pins a root public identity, organization ID, genesis
transaction, encryption epoch metadata, index topic, and at least two recovery locations.
Clients compare monotonically numbered signed checkpoints and event-set commitments. The
index is a rebuildable cache; an unspent-output-only query is not a history service. Spent
outputs and corrections remain addressable by transaction ID in checkpoint manifests.
Encrypted checkpoint archives are the redundant recovery source; explorers are diagnostic
tools, not archives. Required root and recovery keys and bootstrap metadata are not caches.

No chain can recover encryption keys or events that never left an offline device. Revocation
cannot erase plaintext or old keys already obtained. Public ciphertext is permanent and may
be exposed by a future key compromise. Use of real student data remains a separate privacy
and legal approval gate.

## Counting model

A session captures a movement-aware inventory baseline and non-overlapping assignments.
Contributions are observations, not receipts. Distinct contribution event IDs commute and
duplicate delivery is inert; an ID reused with different signed bytes is rejected. A
correction references and retains its original contribution. If corrections race, the
lexicographically smallest signed event ID wins deterministically and the others remain in
history. A recount explicitly names the observations in that assignment that it supersedes.

Submission freezes an explicit sorted accepted-event set. A delayed observation absent from
that set is `LATE`, remains visible, and blocks reconciliation. Reconciliation replaces each
official on-hand quantity with the accepted physical result exactly once. Any inventory
version change since the baseline creates a movement conflict instead; a connected UI lock
is not treated as protection against offline movement.

Quantities are integers from 0 through 100,000. Rapid UI taps may be locally batched into one
contribution, but its stable identity must be retained through retries. Noncommutative issue,
metadata, closure, and reconciliation operations still require explicit coordination or
conflict resolution rather than timestamp ordering.

## Current implementation boundary

Repository schema 9 and `ArgusReplica` implement the count-session event/projection rules,
durable outbox behavior, cutoff, late-work detection, and exactly-once reconciliation. A
P-256 Web Crypto identity implementation provides actual signatures without exportable
private key material. The existing normal UI composition still defaults to explicitly
development-only mocks, and no funded wallet, ARC endpoint, overlay/index deployment,
organization enrollment service, or testnet credentials are available. Consequently the
live three-device chain reconstruction gate is **BLOCKED / NOT RUN**, not passed.

This decision supersedes any statement in ADR 002/003/007 or the architecture documents
that a hash-only audit anchor or relay-only ciphertext is the final operational store.

