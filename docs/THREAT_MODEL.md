# Security threat model

| Threat | Required control and residual risk |
| --- | --- |
| Stolen browser storage | User signing and wallet keys are AES-GCM ciphertext with fresh salts/nonces and expensive PBKDF2. Public metadata and traffic patterns remain visible; strong independent passwords are required. |
| Guessed passwords | Minimum strength, expensive KDF, authenticated failure, and local unlock throttling. Offline guessing cannot be eliminated, so operators need high-entropy passwords. |
| Malicious relay | Signed events and encrypted envelopes fail closed on alteration; event IDs deduplicate. A relay can still delay, omit, replay, or analyze traffic, so clients compare checkpoints and surface stalls. |
| Revoked user retaining an old database | Credentials are checked at acceptance time against signed revocations. Offline work may be created but is rejected once synchronized; old valid history remains attributed. |
| Lost device | Revoke its application credential and enroll a fresh unique key. Do not copy a private signing key between devices. |
| Duplicate enrollment | Treat each device key as a distinct, visibly approved credential; never silently replace or merge identities. |
| Recovery-package theft | Wallet backups are authenticated ciphertext with a separate strong password and contain no plaintext secret. Theft still permits offline guessing. |
| Master-authority loss | Use an offline, governed authority recovery procedure and replacement credential issuance. There is intentionally no password-decryption or user-impersonation back door. |
| Testnet wallet compromise | Revoke wallet access, move remaining testnet funds, create a new encrypted wallet, and retain old audit TXIDs. It does not compromise user signing keys. Mainnet remains impossible. |
| Replayed signed events | Stable event IDs, signature verification, organization binding, credential validity, and idempotent append reject duplicates. |
| Concurrent edits | Entity base versions and conflict records prevent last-writer-wins loss; inventory quantities remain variant-specific. |
| Older encrypted backup rollback | Compare creation/version metadata and backup ID with the local vault, warn prominently, and require explicit replacement plus current-wallet backup acknowledgement. |

Security acceptance requires that authorization be enforced in domain/services, not merely hidden controls; neither a successful animation nor an HTTP response without a valid 64-character TXID is success.
