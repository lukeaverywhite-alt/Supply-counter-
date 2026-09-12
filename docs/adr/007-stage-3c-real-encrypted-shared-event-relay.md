# ADR 007: Stage 3C — Real Encrypted Shared Event Relay

**Status:** Accepted for real-device acceptance · **Date:** 2026-09-12

Mock maps were insufficient because each physical browser owned a different process. GitHub Pages serves immutable client assets and cannot provide mutable discovery or durable shared state. We chose a separately deployed, versioned HTTPS relay that stores only opaque authenticated-encryption envelopes in an atomic durable file optimized for one small organizational instance.

The relay can see routing and cryptographic metadata, arrival time, and sequence; it cannot decrypt business payloads. Organization streams require an opaque ID plus runtime enrollment bearer token. Client credential/revocation checks remain mandatory because relay membership is not domain authorization. AES-GCM authenticated history uses epoch keys distributed only to credentialed members; revocation rotates future epochs without pretending to revoke already learned historic keys.

Confirmed local events commit to IndexedDB/outbox before transport. Idempotent upload acknowledges identical hashes and rejects event-ID/hash collisions. Bounded cursor pages persist their projection/quarantine and cursor atomically. Relay sequence is recovery order, not business truth: signed base versions and domain invariants defer or conflict concurrent work without last-write-wins. New devices replay authorized encrypted history; signed checkpoints remain future work.

BSV remains limited to privacy-safe audit/authorization/integrity commitments and research. It neither transports nor recovers private events. Mainnet remains disabled.

Remaining risks include shared-token theft, browser enrollment/key custody UX, client wiring of runtime enrollment, physical-device verification, denial/omission by one relay, single-process file-store availability, backup discipline, long-history replay, trusted-time governance, and production per-member challenge authentication.
