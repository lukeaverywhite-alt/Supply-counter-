# BSV shared-sync implementation record (2026-09-26)

## Decision and architecture map

This change deliberately does **not** call the application BSV-backed. The runtime path today is:

```text
UI command -> DistributedAppController -> DistributedReplica -> repository transaction
  -> signed ARGUS domain event + local projection + encrypted relay outbox
  -> EventSyncProvider -> authenticated relay pages -> decrypt/verify/authorize -> replay

EncryptedArgusEnvelope -> EncryptedEventTestnetAdapter -> external BRC-100 TESTNET wallet
  -> encrypted OP_FALSE OP_RETURN transaction
Overlay/index -> cursor page -> decode/validate envelope (not yet connected to runtime)
```

The IndexedDB replica and encrypted relay are the working offline-first transport. The chain adapter is an isolated, tested boundary, but is not composed into `runtime.ts`; no repository event is currently published to BSV by the app. `UnconfiguredTestnetWalletAdapter` fails closed. The new wallet-status boundary is read-only, testnet-only, and exposes public status rather than signing material. A mock provider is deterministic and conspicuously labelled.

### Prioritized defects found

1. **Critical:** chain event lookup converted overlay outage into “not found”, allowing another wallet action after an ambiguous publication. It now fails closed. A found event ID must contain the exact canonical encrypted envelope or publication stops as a collision.
2. **Critical/external:** no deployed authenticated organization index, funded external wallet, production enrollment authority, or key-recovery service is configured. Consequently complete chain discovery and live testnet proof are not demonstrated.
3. **High:** chain retrieval is not wired to `EventSyncProvider`; doing so before durable completeness/checkpoint and authorization semantics would create a partial-history hazard.
4. **High:** development identity and shared enrollment secret are unsuitable for real personnel records.
5. **Medium:** the UI previously described a mock audit target without showing whether a wallet/address actually existed. The status view now says disconnected, mock, or live and never invents an address.

## Protocol and privacy

`EncryptedArgusEnvelope` v1 is the current versioned format. Public fields are protocol/version, opaque organization and event identifiers, event/schema type, opaque actor public identity, timestamp/causal references, encryption epoch, IV, ciphertext and signature. Domain payloads (names, school identifiers, profile/size/contact/note/property details) are ciphertext. Opaque identifiers must be random and must not be hashes of personal values. The schema enforces bounds before decrypt/apply; decrypted events are signature-, organization-, epoch-, authorization-, replay-, and domain-validated. Unknown versions fail closed. Public-chain ciphertext is permanent, and later compromise of an epoch key can expose its history.

The OP_RETURN codec and BRC-100-shaped wallet boundary are maintained A.R.G.U.S. source, not the `spell-forge-bsv` package. The reviewed Spell Forge record scanner's recent-record model and default plaintext payload are not safe or complete for this protocol. No Spell Forge License/Fuel/NFT behavior was imported. Before adopting that package, pin an exact published version/commit, retain its MIT notice, verify its packed exports in Vite/Node, and perform a new dependency review.

## Ownership and coverage

| Record/event/projection | Shared authority | Current synchronized behavior |
| --- | --- | --- |
| Inventory items, quantity, issue/return, cadet property, still-needed | signed immutable domain events | Relay: implemented/tested; BSV runtime: not connected |
| Counts, corrections, reconciliation/conflicts | signed events; reconciliation requires authorized actor | Relay/local replica: implemented; chain: not connected |
| Cadet profiles | signed domain events, encrypted | Relay: partial implemented; privacy approval required |
| Bundle definitions/versions | signed immutable versions | Relay: implemented; editor UI partial |
| Calendar events/tasks | future signed events | Unimplemented; **not synchronized** |
| Shared alerts/acknowledgements | future signed events when operationally shared | Unimplemented; transient alerts local |
| Audit history/conflict resolutions | append-only events | Partial; current domain events retained |
| Identity grants/revokes/role/expiry/key epochs | future enrollment authority events | Development-only; not production-ready |
| Dashboard/readiness/activity | deterministic local projections | Derived locally; reads/renders are never published |
| Theme/layout/accessibility/notification preferences | device owner | Local-only by design |

## Discovery, operations, and recovery contract

A production index must authenticate callers, scope by opaque organization, return stable `(chain-position, txid, output-index)` ordering, opaque durable cursors, bounded pages, completeness and tip/reorg metadata, and exact event-ID lookup. The client must persist each applied page and its next checkpoint atomically, deduplicate by `(organization,eventId)` plus exact envelope bytes, back off on 429/5xx, and visibly mark incomplete/gapped history. An overlay is discovery infrastructure, not truth: operators need redundant transaction storage/index backups and a bounded rescan/rebuild runbook. A fresh device must remain `INCOMPLETE`, never “current”, while a page, epoch, or index is unavailable.

Migration must dual-read the existing relay and future chain transport, deduplicate immutable IDs, record a durable backfill checkpoint and explicit cutover marker, and retain an encrypted export made before cutover. Rollback means disable chain publication and continue relay reads from the saved checkpoint; never delete local events or downgrade the database. Wallet service(s) must serialize spends or coordinate reservations across devices.

## Demonstrated evidence and external gates

Deterministic tests demonstrate envelope encode/decode, mainnet rejection, incomplete-history exposure, ambiguous index failure, exact-envelope collision detection, coordinator candidate persistence/lost-ack retry, relay pagination/restart/idempotency, multi-replica domain convergence, and wallet UI disclosure behavior. Regular CI performs no network calls and uses fictional data.

No real testnet transaction was sent or retrieved in this environment. Live proof requires an adult/unit-admin controlled external BRC-100 testnet wallet, synthetic-data funding, a configured broadcaster, and an operated authenticated overlay/index. Record the real TXID and independent retrieval/confirmation result when that separately authorized test occurs; broadcast is not confirmation, and a supplied Merkle path remains unverified until checked against independently validated headers.

Before NJROTC cadet data: complete privacy/legal and command access review; replace mock identity/shared secret with device credentials and signed role lifecycle; deploy enrollment, epoch-key distribution/rotation/recovery and revocation; deploy/monitor/back up relay and redundant index; finish calendar/alerts/identity domains; complete three-device fresh recovery and adversarial/reorg testing; and obtain an explicit decision accepting permanent encrypted public-chain storage. Previously authorized devices cannot be made to forget keys.
