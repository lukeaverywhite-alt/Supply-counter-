# Stage 3C — real encrypted shared synchronization

## Current limitation found

The previous `MockSyncProvider` and mock private-history providers retain events in a JavaScript `Map`. Separate browsers instantiate separate maps, so they cannot discover one another. They remain deterministic test providers, but are explicitly not a shared deployment mode.

Stage 3C adds a real versioned HTTP provider, a narrow relay, durable atomic-file event history, cursor pagination, and a serialized client engine. The relay is transport—not application authority. Clients encrypt, sign, verify, authorize, enforce base versions, project, and conflict. The relay assigns arrival sequence only.

## Envelope and synchronization

The existing `ARGUS_PRIVATE_EVENT` v1 AES-256-GCM envelope is retained. Its authenticated metadata includes opaque organization/event IDs, epoch, signer, algorithm, and nonce. Ciphertext is hash checked and the metadata/hash is sender signed. The relay cannot decrypt it.

The client engine uploads durable outbox events and removes each only after acknowledgement. It pulls bounded pages from its durable provider cursor. A page's verified/decrypted events, quarantine records, and next cursor are committed in one IndexedDB transaction; an apply or persistence failure therefore cannot skip history. Duplicate application remains event-ID based. Invalid envelopes are quarantined without plaintext. One promise mutex serializes startup, interval, reconnect, foreground, manual, and post-mutation triggers.

Remote errors never select mock automatically. Mock means **this device only**. A production UI integration must obtain the opaque organization ID, epoch grants, and bearer enrollment secret from runtime enrollment—not `VITE_*`—before selecting remote mode.

## Recovery, conflicts, and scale

A newly enrolled device starts at cursor `0`, obtains only authorized epoch keys, verifies/decrypts full history, and rebuilds projections. Approximately twelve users can use full replay initially. A signed, authorized, integrity-hashed checkpoint is the next scale step; checkpoints must never bypass event verification.

Relay order is not causal truth. Existing base-version/domain invariants preserve both concurrent events and create explicit conflicts rather than last-write-wins. In the final-unit offline case, the first applicable issue consumes the unit; the incompatible event is retained and produces ACTION REQUIRED without negative inventory.

Local preferences and drafts are never events and do not sync. Confirmed inventory, cadet, bundle, Still Needed, supply transaction, count, conflict, and authorization events are organizational.

## Honest acceptance status

The repository's integration test uses two independent HTTP callers and restarts durable relay instances. It proves network transport, pagination, deduplication, collision detection, organization authentication, persistence, and ciphertext-at-rest privacy. Physical Device A/Device B acceptance still must be performed using the companion plan before Stage 3C is called complete.
