# Shared counting milestone — 2026-09-26

## Baseline and repair record

Baseline: branch `work`, HEAD `18ead73`; no default-branch ref or remote was configured in this checkout. The required runtime is Node 24 or newer (`package.json`); the available Node 20 runtime can build but cannot start jsdom/Vitest 5 workers. The supply-manual PDFs were present, but no inventory-policy interpretation was needed for this event/transport milestone.

| Verified baseline | Defect/gap | Affected code | Repair and evidence |
|---|---|---|---|
| IndexedDB transactions atomically stored projections, events, and outbox rows. | Normal controller constructed mock identity and sync implementations. | `distributed/appIntegration.ts` | Controller accepts an enrolled identity, authorization graph, provider, and organization; mock construction occurs only when the explicit dependency bundle is omitted for demo/tests. |
| First-class sessions already summed independent assignment contributions and used an accepted-event cutoff. | The screen had no background synchronization and remote dependencies could abort an entire pull. | `App.tsx`, `distributed/replica.ts` | Normal app starts a cleanup-safe poll/reconnect scheduler. Pull replay uses dependency passes, quarantines poison records, and continues valid history. |
| AES-GCM private envelopes contained signed operational events. | BSV adapter stored only audit commitments and was unconfigured. | `blockchain/EncryptedEventTestnet.ts` | Added a fail-closed BRC-100 `createAction` adapter that places the complete authenticated ciphertext envelope in a testnet data output and retrieves it through an injected overlay. |
| Legacy migration was repeatable per device. | Cadet and need IDs were random on each device. | `distributed/appIntegration.ts` | Legacy IDs are now deterministic from source IDs. Existing migrated IDs are not rewritten. |
| Test suite covered 3 + 3, retry, out-of-order, correction, recount, late work, persistence, and one-time reconciliation. | No encrypted on-chain codec/ambiguous retry contract test. | `blockchain/encryptedEventTestnet.test.ts` | Added full-envelope round-trip, event-ID retry lookup, mainnet rejection, and incomplete-history signaling tests. |

## Counting rules

Assignments describe non-overlapping physical areas. A contribution is an immutable, bounded whole-number observation. Contributions from distinct assignments commute and event IDs—not actor, timestamp, or quantity—deduplicate them. A recount explicitly supersedes observations in one assignment. Corrections retain the original and deterministically select one correction; duplicate event IDs with different bytes are rejected. Submission freezes an explicit accepted-event-ID set. Offline observations absent from that set remain visible as late work and block reconciliation until review/reopen policy is applied. Cancellation never deletes history.

Reconciliation sets the stock position exactly once; it never adds a count to stock. Inventory versions captured at session creation detect issue/return movement, including delayed offline movement, and force conflict review. Device timestamps are used for display and authority validity only, never to prove causal order. A revoked credential cannot authorize an event timestamp at or after revocation; deployments must bound offline credential lifetime because a dishonest device can backdate and already-decrypted data cannot be retracted.

## Two-user runbook

1. An organization root creates separate user/device signing keys and signs role credentials. Do **not** copy the root key or put keys/tokens in `VITE_*` values.
2. Provision the same organization ID, authority credentials/revocations, historical encryption grants, relay/overlay configuration, and canonical genesis/import history to A, B, and recovery client C.
3. Inject each client's own `ArgusIdentityProvider`, `AuthorizationService`, `EventSyncProvider`, repository, and organization ID into `DistributedAppController`. Omission selects local demo mode and must not be called operational enrollment.
4. Create one session with two non-overlapping assignments (for example Shelf A and Shelf B). Sync B, then take both clients offline if testing recovery.
5. A contributes 3 to Shelf A and B contributes 3 to Shelf B. Reconnect. Automatic synchronization or **Sync now** produces a shared total of 6; retries do not change it.
6. For recovery, enroll C for every required encryption epoch, enumerate overlay history until `complete: true`, verify transaction/network/inclusion evidence, decode and authenticate each envelope, verify event signatures/authority/dependencies, and replay. A page with `complete: false` is not proof of complete history.

## Testnet boundary and external prerequisites

The adapter follows the BRC-100 `createAction` shape reviewed from the official `bsv-blockchain/ts-sdk` source on 2026-09-26 and keeps ARC/broadcast responsibility behind the wallet. Required external components are an explicitly testnet-selected funded BRC-100 wallet and an application overlay that indexes **spent and unspent** A.R.G.U.S. outputs by stable event ID and organization, returns raw locking scripts, and reports completeness and inclusion data. No endpoint, wallet, funding, header verifier, or credentials are bundled.

The public output contains protocol/envelope metadata, organization ID, event ID, epoch, sender public identity, nonce, ciphertext hash, signature, and permanent ciphertext. Sensitive payload fields remain inside AES-256-GCM ciphertext, but ciphertext permanence and metadata leakage remain. Merkle-proof presence is labeled but not cryptographically verified by this milestone; actor authorization, application validity, and enumeration completeness are separate replay checks.

## Acceptance status

| Requirement | Status | Evidence / limitation |
|---|---|---|
| A 3 + B 3 = 6; retry/order/correction/recount/isolation/offline/late/reconcile | Passed locally in domain tests | `distributed/countSessions.test.ts`; separate repositories and identities, in-memory transport. |
| Actual signatures and receive-time authorization | Passed locally | Web Crypto signature test and replica authorization tests. Browser key custody remains an enrollment boundary. |
| Durable encrypted relay preparation/retry and HTTP exchange | Passed locally | Private-sync and HTTP integration suites; relay receipt is not blockchain confirmation. |
| Normal runtime composition and automatic refresh | Implemented; browser test not run here | Injected dependencies and cleanup-safe polling/reconnect bridge. Existing count-session setup UI remains limited. |
| Full ciphertext BSV preparation/retrieval contract | Passed locally at deterministic adapter level | Data-output codec and wallet/overlay contract tests. |
| Actual BSV testnet TX and third-client chain rebuild | **Blocked** | No funded authorized testnet wallet, overlay, or header/proof service was supplied. Exact next action: provide those injected services, publish fictional fixtures, record the real TXID, then replay all complete pages on fresh client C. |
| Physical phones, reorg/stale-block proof verification, production custody/retention | Not run / unresolved | Requires external devices, infrastructure, policy approval, and threat review. Mainnet remains fail-closed. |

## Remaining limitations

This is not a production-security claim. The adapter does not fabricate a provider, verify a Merkle path, or equate transaction inclusion with actor authority. Current development epoch export is not production key custody. Public ciphertext is permanent even after key rotation. Production student-data retention, metadata exposure, lost-device response, overlay omission detection, and key escrow require explicit organizational decisions.
