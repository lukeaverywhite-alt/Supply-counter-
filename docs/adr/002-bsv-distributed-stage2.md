# ADR 002: BSV distributed Stage 2

- **Status:** Accepted as a proof boundary
- **Date:** 2026-09-11

## Decision

1. **BSV replaces:** a mutable centralized audit assertion with public, privacy-safe integrity commitments and potentially supplies transaction-based discovery/validation through overlays.
2. **BSV does not replace:** local queries, private storage, encryption/key distribution, authorization evaluation, conflict policy, notifications, offline state, or guaranteed payload availability.
3. **Conventional database:** A.R.G.U.S. can avoid one conventional shared CRUD database, but cannot avoid durable shared services. Clients use local IndexedDB replicas while multiple providers must retain/discover encrypted signed history.
4. **Overlay:** likely useful and probably requires an A.R.G.U.S.-specific topic manager/lookup service; production suitability is unproven.
5. **Always-online infrastructure:** at least one discovery/relay and encrypted-history provider for online convergence, plus broadcaster/header/proof sources for BSV anchoring. Multiple independent instances are preferable.
6. **Private payload location:** encrypted objects on local replicas and redundant authorized providers, never the public commitment.
7. **Sharing:** proposed wallet-authenticated delivery of epoch encryption keys; not implemented in Stage 2.
8. **New-device recovery:** download an authenticated snapshot/history, obtain permitted epoch keys, verify, deduplicate, replay, and compare commitments/checkpoints.
9. **Offline:** validate/sign/apply locally and atomically queue; retry the identical event after reconnect.
10. **Duplicates:** globally unique event IDs and an applied-event set make receipt idempotent.
11. **Conflict detection:** entity base versions plus domain invariants; concurrent consumption that would make stock negative creates a conflict.
12. **Conflict resolution:** permission-gated append-only `CONFLICT_RESOLVED`; originals remain.
13. **Authorization:** Root-signed canonical credentials with explicit role-bounded permissions; every authoritative domain action is checked.
14. **Revocation:** signed revocation effective at an ordered timestamp rejects new actions while retaining valid history.
15. **Delegated Master:** Root signs a MASTER credential for an independent identity; chain validation allows delegation and revocation without key sharing.
16. **Multiple providers:** can improve availability and remove a single endpoint if each retains history and results are cryptographically verified/deduplicated. This is not automatic.
17. **Mainnet prevention:** configuration rejects `mainnet`, the network type excludes it from providers, CI forces MOCK, and there is no production wallet/broadcaster.
18. **Unproven:** production crypto/key custody, authenticated encrypted payload replication, overlay deployment and peer synchronization, ARC/testnet round trip, SPV/header trust, trusted event time, general concurrent operations, provider failover, snapshots/backups, and long-horizon restoration.

## Technical conclusion — Option B

A.R.G.U.S. can mostly avoid a conventional centralized database, but still needs replaceable always-online discovery/relay and encrypted-history storage components. The proof does not establish that public BSV or overlays alone make private operational data available or recoverable.
