# Blockchain audit transaction coordinator

## Boundary and flow

```text
signed domain event
  -> privacy-safe signed audit commitment
  -> durable audit outbox job
  -> leased transaction coordinator
  -> externally controlled wallet/signing boundary
  -> BSV TESTNET provider
```

BSV is audit-only. Operational inventory commits before and independently of audit delivery. An unavailable blockchain leaves a retryable audit job and must not make issue/return unavailable. Mock transaction IDs remain visibly `MOCK`; the unconfigured TESTNET adapter fails closed. MAINNET remains disabled.

One logical job exists per `(organizationId,eventId)`. Enqueue retries return that job only when canonical content and hash match. A worker atomically claims an eligible job, records its owner and expiring lease, reserves an input where a non-mock executor requires one, and persists a signed candidate transaction and candidate TXID **before** broadcast.

If broadcast succeeds but its response is lost, the candidate remains durable. A retry first asks the provider for that TXID. It does not build a replacement merely because the request failed. Confirmed/proof-verified states can be reconciled through the same lookup path.

## UTXO reservations

UTXOs are `AVAILABLE`, `RESERVED`, or `SPENT`. Reservation is an atomic repository mutation containing the job identity and an expiry. A live reservation cannot be stolen; an expired reservation can be reclaimed. Candidate-bearing jobs intentionally retain their reservation until transaction existence is reconciled, since the input may already be spent.

The browser model tests state transitions but is **not** a distributed wallet database. A funded shared wallet requires these same atomic claim/reservation rules in a trusted backend datastore and secure signer. Raw spending keys and shared access tokens must never be bundled in React or exposed through `VITE_*` variables.

## Failure recovery

- Browser/worker crash: durable jobs survive; expired leases can be reclaimed.
- Build/sign failure before a candidate exists: job becomes retryable and its reservation is released.
- Lost broadcast response: preserve candidate raw transaction/TXID, query by TXID, and rebroadcast only the same candidate when lookup is unknown.
- Relay/network outage: operational events and audit jobs stay local and retry later.
- Provider permanent rejection: an integration can classify the job `PERMANENT_FAILURE`; the current generic coordinator conservatively treats provider exceptions as retryable until a real TESTNET provider supplies error classification.

## Deployment requirement

Before funding TESTNET, move coordination to a shared trusted worker backed by transactional storage, implement authoritative atomic UTXO selection, add provider-specific signing/build states and confirmation polling, and run failure-injection tests against the actual broadcaster. Do not fund a browser-only shared wallet.
