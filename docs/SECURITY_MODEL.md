# A.R.G.U.S. security and privacy model

## Separate responsibilities

- **Authentication** identifies the current user.
- **Authorization** decides which permissions that user has, such as `inventory.read`, `inventory.issue`, `inventory.return`, `inventory.count`, `inventory.adjust`, `inventory.create`, `calendar.read`, `calendar.write`, `audit.read`, or `admin.manage`.
- **Cryptographic signing** proves that a key approved bytes.
- **Blockchain anchoring** provides an independently checkable record of a commitment.

The current sign-in and roles screens are demonstrations, not enforcement. A future backend must check permissions independently of UI controls.

## Private data stays off-chain

Cadet names, addresses, phone numbers, emails, school IDs, birth dates, roster details, issued-property details, notes, credentials, and account information must remain in access-controlled off-chain storage. Stage 1 builds commitments from an allow-list; issue/return commitments contain only item ID and quantity. Human-readable summaries are local-only.

Identifiers can themselves be identifying. Future designs should use opaque identifiers or salted/keyed commitments where correlation or guessing is a concern, and should complete a privacy review before public anchoring.

## Secrets

Never commit `.env` files, private keys, seed phrases, wallet files, API credentials, or certificates. Never put them in `VITE_*` variables, because browser code and its configuration are readable by users. Never log or display secrets. `localStorage` is appropriate for this fictional prototype's state, not for production keys. A compromised local cache can be altered or deleted; hashes detect changes only when compared with a trusted record.

## Failure and recovery

An unavailable audit provider must not discard an inventory operation. The event remains queued or failed with a clear message and is retried with the same ID. Production recovery needs encrypted shared backups, tested restore procedures, signer/key rotation and revocation, audit reconciliation, dead-letter review, and protection against concurrent workers. Losing a private key can permanently remove signing/spending ability; copying it insecurely can compromise the organization. Key recovery design must precede production.

## Threat controls and remaining work

Stage 1 rejects unsupported modes and mainnet, filters commitment fields, detects altered meaningful event data, verifies mock signatures, and prevents duplicate mock submissions. It does not yet provide trusted authentication, server authorization, secure cryptographic key custody, durable synchronization, runtime schema validation, clock trust, multi-device ordering, or protection against a malicious browser user. These are mandatory production tasks, not guarantees of the prototype.

## Stage 2 review

Stage 2 moves authorization into a domain service and verifies signed events before inbound projection. Event IDs provide replay/idempotency protection and entity base versions detect the demonstrated final-unit conflict. Signed revocation is prospective; old valid history remains. Public commitment allow-list tests cover names, cadet IDs, gender, grade, student IDs, and notes. Target and submitted networks are separate, and provider network mismatch fails closed.

Remaining risks are explicit: mock signatures provide no security; signed client clocks permit backdating without future ordering evidence; encrypted payload distribution and epoch-key rotation are not implemented; the Stage 1 UI still uses its legacy local snapshot while the Stage 2 repository is an isolated proof; general concurrency and transaction schema validation are incomplete; a malicious local runtime can alter unanchored state; and testnet/ARC/SPV were not verified. No private key, seed, credential secret, wallet file, real PII, or mainnet path was added.

## Stage 2.5 review

Inbound encrypted envelopes and signed events now receive runtime structural/protocol checks before use. AES-256-GCM is supplied by Web Crypto; no cipher or KDF was invented. Non-extractable mock epoch keys never enter logs, localStorage or UI. Providers see ciphertext plus correlation metadata and remain capable of omission, replay, corruption and traffic analysis. Multi-provider hash disagreement, AEAD failure, signature failure, unsupported versions, wrong organization and authorization failure reject before projection.

The repository was scanned for key/seed patterns, `VITE_` secrets, mainnet paths and public commitment fields. No real secret, wallet, TXID or mainnet broadcaster exists. Residual risks: mock signatures are forgeable protocol doubles; epoch keys are memory-only; the legacy UI briefly displays its local snapshot while IndexedDB hydrates; encrypted transport is not yet attached to the durable browser outbox; timestamps remain untrusted metadata; remote retention/checkpoints and full concurrency are not production-ready.
