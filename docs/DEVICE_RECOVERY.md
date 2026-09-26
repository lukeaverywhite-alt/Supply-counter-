# Device recovery

Device enrollment recovery and organization-wallet recovery are separate. Restoring the wallet never restores or impersonates a user's application signer. A replacement user/device generates a new keypair, receives a new authority credential, and leaves historical actor identities unchanged.

A new device creates or connects an independent wallet identity; a Master signs its credential; the device receives only permitted epoch keys through the future authenticated key-distribution adapter; it downloads encrypted history from one or more providers; validates, decrypts, verifies, deduplicates and replays; then compares signed checkpoints and public BSV commitments.

Stage 2.5 tests the encryption/provider/recovery building blocks with mock identities and complete authorized epoch history. Durable remote history, production credential discovery, key wrapping, retention governance and a full checkpoint implementation remain blockers. Copying a live IndexedDB file or a private signing key is not enrollment.

Wallet recovery files use `.argus-wallet` and a versioned `ARGUS_TESTNET_WALLET_BACKUP` envelope. AES-256-GCM authenticates testnet recovery material; PBKDF2-SHA-256 uses a fresh salt and 600,000 iterations, and every export uses a fresh nonce and backup ID. Visible metadata is authenticated additional data. No plaintext WIF, mnemonic, password, or relay token is written.

Import derives the recovered address and requires the operator to type it. Existing-wallet replacement additionally requires current-backup acknowledgement. Older creation metadata produces a prominent rollback warning requiring explicit acknowledgement. Keys are replaced, never merged. The runtime then reloads state through the same provider. Forgotten recovery passwords cannot be recovered.
