# ADR 008: Stage 3C.5 application stabilization

**Status:** Accepted (development boundary)

## Decision

Serialize each repository instance's whole read/modify/write operation with a failure-safe queue. Preserve signed events, projections, explicit conflicts, and the existing physical IndexedDB database. Treat the event outbox as private-history delivery and audit status as an independent BSV boundary.

Use typed private-history providers and persistent development epoch enrollment. Enrollment is explicit and local; keys never enter projections, relay storage, URLs, logs, or build variables. This is deliberately not Stage 4A production custody or identity enrollment.

Retain exact inventory-ID bundle mapping and immutable bundle versions; never use fuzzy labels. Retain semantic theme tokens. Use navigation-only app-shell fallback, versioned cache cleanup, runtime asset caching, and user-approved service-worker activation.

## Consequences

Concurrent local and remote commits cannot silently replace one another within a repository instance, and failures release the queue. Two independently constructed development clients can share an explicitly transferred enrollment and exchange ciphertext through HTTP. Multi-provider delivery will require provider-specific acknowledgement records before it can be enabled safely. Production accounts, device authorization, durable multi-instance relay storage, and wallet-backed key custody remain Stage 4A work.
