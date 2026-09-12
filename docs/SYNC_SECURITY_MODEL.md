# Shared synchronization security model

## Trust boundary

The relay sees opaque organization/event identifiers, epoch ID, public signer reference, nonce, ciphertext/hash, protocol metadata, arrival time, and sequence. It cannot see decrypted cadet names, gender, NS level, sizes, property, readiness, inventory semantics, or transaction details. Server compromise exposes traffic metadata and ciphertext, not automatically plaintext.

Bearer organization membership limits stream access and uses constant-time token-hash comparison. It is transport authorization only: every client must still verify envelope hash/signature, authenticated decryption, event schema/organization/protocol, event signature, actor credential/revocation, idempotency, base version, and domain invariants before projection. Unknown protocols fail closed. A malicious relay may omit, duplicate, reorder, corrupt, or equivocate; clients quarantine invalid input and treat the same event ID with a different hash as an integrity incident.

Enrollment secrets and organization epoch keys are sensitive local enrollment material. Never commit, log, email casually, or compile them through `VITE_*`. Each user keeps an independent signing identity; never copy the Root private key. An authorized administrator grants epoch keys to credentialed members. On revocation, revoke relay token access where feasible, reject later actor events client-side, rotate to a new epoch, and distribute that future key only to remaining members. Revocation cannot erase historic keys already possessed; historic access follows the grant policy at enrollment.

The included relay uses a shared organization bearer token as a pragmatic small-organization first deployment. A stolen token permits ciphertext read/write attempts until rotated, although forged domain events still fail client verification. Per-member challenge credentials, durable distributed rate limiting, external secret management, independent provider comparison, signed checkpoints, and automated token revocation are remaining hardening work.

BSV is separate: privacy-safe commitments, authorization/integrity proofs, and future discovery research only. It is not private payload transport or recovery storage. Mainnet remains disabled; no wallet, funds, or real transaction is introduced by Stage 3C.
