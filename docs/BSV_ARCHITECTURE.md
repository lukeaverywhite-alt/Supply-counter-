# A.R.G.U.S. BSV architecture

## What BSV does—and does not do

The planned role of Bitcoin SV (BSV) is to anchor a small, privacy-safe commitment proving that an important A.R.G.U.S. event existed. It is **not** the inventory database, roster, calendar, search engine, authentication system, or authorization system. Opening screens, searching, filtering, and reading records never create transactions.

The live inventory and private records remain off-chain in an application storage/synchronization layer. Stage 1 still uses the prototype's versioned `localStorage` record. A future shared database will synchronize domain events and materialized application state between authorized devices; an optional index/discovery adapter can locate anchors without making UI queries scan the blockchain.

## Events and commitments

Supported Stage 1 events are item creation, count submission, issue, return, and annual rollover. Each event has a UUID, schema version, timestamp, non-personal actor identity reference, event type, affected entity, allow-listed domain data, and optional previous hash. The local event also has a human-readable summary, but that summary is excluded from the public commitment.

Canonical serialization sorts object keys recursively. SHA-256 turns those canonical bytes into an **event hash**: a fixed-length fingerprint. Identical commitments have identical hashes; meaningful changes have different hashes. A hash is not encryption and does not make guessed personal information safe, so the commitment is allow-listed before hashing.

## Provider boundary

The React UI calls domain operations. Those operations create events, and the audit service hashes/signs them before using `BlockchainProvider`. UI components never construct Bitcoin transactions.

`MockBlockchainProvider` implements submission, status lookup, verification, failure simulation, and event-ID idempotency entirely in memory. Its transaction IDs start with `MOCK_TX_`; nothing is broadcast. A future `BsvTestnetProvider` and a much later, separately reviewed mainnet provider must implement the same contract.

## Signatures, keys, transactions, and TXIDs

A **private key** is a secret used to authorize a cryptographic signature. Anyone who gets it may impersonate its owner or spend controlled funds. It must never enter Git, logs, analytics, localStorage, or browser source. A **public key/public identity** can be shared so others can verify approval without learning the private key.

A blockchain **transaction** is a network record. Its **transaction ID (TXID)** identifies that record. Stage 1 produces only visibly fake mock IDs. The Stage 1 `MockSigner` has no secret and demonstrates interface wiring only; it is not production security. Organizational fee/spending keys must eventually live behind secure wallet/key-management infrastructure outside the frontend.

## Environments

- **MOCK:** default, local-only, deterministic simulation, no BSV and no network request.
- **TESTNET:** development BSV with test-only data, keys, wallet, and coins. The Stage 1 UI can label this configured mode, but no provider is installed and events remain queued. It must not claim submission.
- **MAINNET:** deliberately hard-disabled. Configuration throws `BSV mainnet integration is disabled in this build.` There is no mainnet provider or fallback.

`VITE_ARGUS_BLOCKCHAIN_MODE` is the single mode setting. Anything prefixed `VITE_` is publicly readable in the compiled browser bundle and must never contain a secret.

## Offline queue and idempotency

The inventory operation is saved before audit processing. Events progress through `QUEUED_FOR_AUDIT`, `SUBMITTING`, `CONFIRMED`, or `FAILED`; failed events retain the same event ID for controlled retry. The provider indexes by event ID, so refresh/retry cannot intentionally produce multiple mock records. A future durable shared outbox must provide transactional persistence, backoff, leases, and server-side idempotency.

## Stage 2: verified testnet work

Before adding code, verify current official BSV documentation, maintained TypeScript SDK support, transaction format, fee policy, testnet broadcaster/status API, and wallet/key-management interface. Signing should occur in a secure wallet or backend—not with a spending key bundled into React. Stage 2 should anchor only an event version, event ID/type, hash, timestamp, and signer identity/signature reference as appropriate, then prove an issue/return round trip and altered-data failure. No package was added in Stage 1 because no real transaction is needed and unsupported APIs must not be guessed.

## Mainnet migration gate

Moving from mock to testnet should only replace provider/signer/storage adapters. Mainnet requires a separate production implementation plus organizational approval, security and privacy reviews, explicit enablement, secure key custody, access controls, funding outside source code, backup/recovery drills, monitoring, incident response, and rollback procedures. It must never activate automatically or silently fall back between networks.

## Stage 2 boundary

The configured `targetNetwork` is recorded before submission; `submittedNetwork` is absent until a provider succeeds and must match the target. Stage 2 adds signed private-event/replica abstractions separately from public audit commitments. Its mock sync provider is not a blockchain provider or durable overlay. See `DISTRIBUTED_ARCHITECTURE.md` and ADR 002 for the overlay/private-history conclusion; testnet remains unimplemented rather than simulated.
