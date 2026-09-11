# Stage 2.5 architecture

## Assessment before implementation

Stage 1 lived in React `AppData` loaded/saved under `argus.local.v2`; inventory mutations called synchronous functions in `domain.ts` and appended Stage 1 audit records. Stage 2 lived separately in `ArgusReplica`, with memory/IndexedDB repositories, mock identities/credentials and a mock relay. The main UI never constructed or hydrated a replica. IndexedDB held one atomic replica state but had no explicit state schema. This was the exact integration seam and created competing projections.

Stage 2.5 routes **issue, return, and count submission** from the real drawers through `DistributedAppController` into permission checks, signed events, an IndexedDB repository, its validated inventory projection and outbox. The UI hydrates immediately from legacy data, then switches to the repository projection without waiting for a remote provider. Other prototype flows remain legacy and are explicitly outside this controlled migration.

Risks were malformed legacy data, partial migration, schema drift, UI initialization races, and loss of non-inventory prototype state. The migration is idempotent, copies rather than deletes, marks only after repository commit, and fails visibly without replacing malformed source.

## Authority and queues

For migrated core inventory quantities, the authoritative state is the ordered set of validated signed events plus the repository projection; React is a view. Seed/legacy inventory becomes version-zero genesis. A stored event has independent private `syncStatus` and BSV `auditStatus`. Local success never waits for BSV. The current browser proof uses deterministic mock signatures and mock transport; it is not production authentication.

## Protocol and ordering

Private events carry `ARGUS`, protocol version 1, opaque organization namespace, unique event ID, entity base version, signer and metadata timestamp. Inbound future versions and organization mismatches fail closed. Event ID provides idempotency; base version/invariants, not timestamp, decide projection. General causal ordering remains future work.

## Checkpoint design

A future checkpoint is signed by an identity with `inventory.adjust`, binds organization/protocol, last included event IDs or causal frontier, state hash, creation time and signer. Clients verify authorization/signature/hash, replay later events, and fall back to full replay on any failure. No unvalidated snapshot is trusted in this stage.
