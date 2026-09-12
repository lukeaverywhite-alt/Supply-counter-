# Stage 3C.5 stabilization

## Findings and repairs

The application already had a strong signed-event and projection model, but its IndexedDB repository performed unlocked snapshot replacement, the production controller still selected mock synchronization, CSS contained malformed variable substitutions, relay oversize streaming requests could be disconnected without a response, and the service worker returned HTML for failed module requests.

This stabilization pass serializes complete repository read/modify/write cycles with a failure-safe promise queue. Local commands and inbound synchronization therefore share the same commit boundary. The relay validates persisted state before startup, writes through an atomic temporary-file rename, returns structured 413/415/400 responses, validates pagination, and bounds rate-limit bookkeeping. Its JSON file store remains **single-instance development/small-unit infrastructure**, not a production distributed database.

Remote private history continues to use AES-256-GCM envelopes. `DevelopmentPersistentEpochKeyDistribution` adds explicit, local, reload-safe development enrollment. Enrollment export/import is an explicit out-of-band operation; missing or wrong enrollment fails closed. It is not account management, device authorization, recovery, or production key custody, and Stage 4A must replace it with wallet/hardware-backed wrapped keys. Relay tokens only authorize relay access and remain distinct from encryption keys, signing identities, and authority credentials.

The event outbox remains the private-history delivery queue; BSV audit state remains independently represented by each stored event's audit status. Absence from the outbox is not the UI's sole signal: stored events retain explicit local sync status and provider metadata records attempts, success, cursor, and errors. Further provider-specific fan-out delivery records are required before enabling multiple simultaneous private-history destinations.

Factory bundle definitions and immutable versions remain unchanged. Bundle lines use explicit inventory IDs and mapping status is derived as `FULLY_MAPPED`, `PARTIALLY_MAPPED`, or `UNMAPPED`; no fuzzy matching was introduced. Migrated placeholder metadata and cadet review flags remain visible as incomplete information without changing entity identity or history.

The PWA now separates navigation fallback from asset requests, removes stale shell caches, caches successful same-origin assets, and waits for explicit update activation. IndexedDB is never cleared by service-worker updates. Semantic theme tokens remain authoritative, malformed substitutions were repaired, and CI runs a structural CSS check.

## Test evidence and remaining gate

Tests cover memory and IndexedDB concurrent commits, queue recovery after failure, persistent development enrollment, ciphertext-only relay persistence, independent-client decryption, cursor advancement, and duplicate publication. Relay API and deployment tests remain separate commands.

Stage 4A remains blocked: the normal React controller still requires a completed remote-runtime enrollment/configuration UI and authorization distribution for distinct real actors; full browser/PWA visual regression and final-unit two-writer conflict coverage are also not yet present. No production authentication, BSV mainnet, or production secrets were added.
