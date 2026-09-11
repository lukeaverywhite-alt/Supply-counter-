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
