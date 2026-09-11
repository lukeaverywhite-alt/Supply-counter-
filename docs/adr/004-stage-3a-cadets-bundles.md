# ADR 004: Stage 3A cadets, bundles, and readiness

**Status:** Accepted

1. **Cadet authority:** validated projections rebuilt from signed cadet events in the durable replica.
2. **Bundle authority:** validated projections whose current pointer selects an immutable version history.
3. **History:** every update appends a version with actor, time, prior version, lines, and event ID; old versions are never edited.
4. **Factory seed:** seven stable-ID version-1 presets are installed during replica initialization.
5. **Seed idempotency:** insertion checks stable bundle ID; startup never replaces or duplicates an existing bundle.
6. **Still Needed:** lifecycle-preserving, versioned requirements projected from explicit signed events.
7. **Readiness:** derived from non-cancelled requirements; any OPEN or PARTIALLY_FULFILLED requirement means INCOMPLETE.
8. **Cadet sync:** permission check → validation → signature → repository projection/outbox → provider replicas.
9. **Bundle sync:** the same path, with `baseVersion` preserving causal intent.
10. **Concurrency:** incompatible same-base changes retain both events and create an explicit conflict; there is no timestamp winner.
11. **Private synchronization:** authorized encrypted envelopes may contain complete cadet and readiness payloads needed to replay projections.
12. **Public BSV:** only protocol/version, opaque organization/event/entity references, type, hash, timestamp, and public signer reference; never cadet PII or operational details.
13. **Stage 3B:** transactional bundle/individual issue, per-line size and stock review, return confirmation, requirement fulfillment, and issue-to-bundle-version references.
14. **Stage 4:** full readiness dashboard, alerts, weighted readiness, and animated command-center visualization.

This decision extends rather than replaces the Stage 2.5 event store, authorization, signing, outbox, private-envelope, conflict, and provider boundaries.
