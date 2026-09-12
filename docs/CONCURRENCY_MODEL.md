# A.R.G.U.S. concurrency model

## Layers, not one mutex

A.R.G.U.S. uses complementary protections:

1. **In-process single flight** prevents duplicate sync and blockchain runners in one JavaScript runtime.
2. **Web Locks** are a best-effort browser-profile optimization for blockchain workers when supported.
3. **Atomic IndexedDB transactions** are the local source of truth. Every repository callback reads, migrates, mutates, validates, and writes in one `readwrite` transaction. Callbacks must be synchronous because awaiting can allow IndexedDB to auto-close a transaction.
4. **Optimistic versions and identities** provide semantic correctness. A mutation applies only against its expected entity `baseVersion`; stale signed events are retained and represented as idempotent conflict records. `(organizationId,eventId)` and supply `transactionId` are uniqueness boundaries. Reusing an identity with different canonical content is a collision, never a retry.
5. **Shared transactional infrastructure** is required between devices. Browser locks and browser IndexedDB do not coordinate independent devices.

Inventory issue/return validation and all projection changes occur in the repository callback. Multi-line mutations therefore either apply completely or record a conflict without applying any line. Commit-time invariants reject negative inventory, invalid property quantities, over-fulfilled requirements, and duplicate critical identities.

Private synchronization snapshots work to perform network I/O, but each acknowledgement removes only its own outbox row in a fresh atomic transaction. New rows created during network I/O remain queued. The randomly nonced encrypted envelope is persisted before its first publish and reused after a lost acknowledgement; retrying therefore cannot create a ciphertext collision for the same event identity. A page cursor advances in the same transaction as per-event application and quarantine recording. Invalid or colliding remote events are quarantined without partially mutating the projection or permanently blocking later relay events. Duplicate encrypted identities with different content are rejected.

## Recovery and remaining boundary

IndexedDB preserves queued sync and audit work across reloads. Leases, rather than permanent locks, let another worker recover expired blockchain claims. A production multi-device deployment still needs a trusted shared coordinator and transactional database; local repository guarantees are browser-profile guarantees only.

The JSON relay is intentionally a single-process development service. It assigns unique sequences and persists each accepted event via temporary-file rename before acknowledging it. It validates loaded state and fails closed on corruption. It is not horizontally scalable: use SQLite for one durable server or PostgreSQL (with unique constraints and transactional sequence allocation) for multiple instances.
