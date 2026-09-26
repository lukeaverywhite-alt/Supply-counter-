# Identity and key architecture

A.R.G.U.S. deliberately has **three unrelated key types**. No universal master key exists and the authority cannot decrypt user passwords or impersonate an actor.

1. The **organization authority key** grants and revokes signed credential chains. It is controlled by the master administrator, is never an everyday spending key, is never stored unencrypted in browser storage, and cannot be derived from a user's password. Losing it requires the documented governance/re-enrollment process; it does not reveal any user key.
2. A **per-user application signing key** is generated independently for each approved user/device enrollment. It signs every data-changing inventory, cadet, bundle, issue, return, count, delete, restore, settings, and synchronization event. The private key is wrapped using authenticated encryption under a deliberately expensive password-derived key. Events retain the actor public identity and authority credential chain, so revocation does not erase attribution. Replacement means a new key and credential, not wallet rotation.
3. The **organization testnet wallet key** performs only BSV testnet spending and audit publication. It is encrypted independently and accessed through a narrow wallet service; ordinary users never receive its WIF. Its password, recovery package, and key are unrelated to application passwords and signing keys. Mainnet is rejected at configuration and provider boundaries.

An approved operation therefore requires authentication, unlocking that user's application credential, validation of a currently active authority credential, a role capability check, and a signature from the actual user's application key. Wallet publication additionally records the requesting actor; wallet possession never grants application authority.

## Enrollment and revocation

The authority signs a canonical credential binding a unique public identity to role, permissions, issue time, and optional expiry. Duplicate enrollment creates a separate device identity and must be explicitly approved rather than overwriting an existing identity. Revocation is prospective: retained old databases remain useful historical evidence, but relays and receiving replicas reject new events at or after the effective revocation. Event IDs are idempotency keys and base versions expose concurrent edits.

## Key custody invariants

- Browser storage may contain only ciphertext, public identities, credential chains, salts, nonces, and non-secret metadata.
- Passwords and decrypted private keys exist only for the unlock operation/session and are never logged, synchronized, or persisted.
- Authority recovery, user credential replacement, and wallet recovery are separate procedures.
- Every historical event keeps its actor, signature, and credential reference even after a user or record is deleted.
