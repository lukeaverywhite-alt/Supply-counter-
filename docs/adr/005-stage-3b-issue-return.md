# ADR 005: Atomic grouped Issue and Return transactions

**Status:** Accepted — Stage 3B

## Decision

Represent each confirmation as one signed `ITEM_ISSUED` or `ITEM_RETURNED` event containing all lines. The event entity ID and payload transaction ID are the same stable opaque UUID. This matches the event repository and gives multi-line operations a natural atomic and idempotent boundary.

Issue lines store inventory ID, label snapshot, optional size, quantity, base inventory version, line ID, optional property ID, and optional requirement reference. Bundle issues store bundle ID, exact version, and an immutable definition snapshot. Return lines reference original current-property IDs. A durable transaction projection groups actor, time, event, cadet, lines, type, and bundle snapshot.

Required unavailable lines become explicit missing lines. Equivalent incomplete-issue requirements merge by cadet/item/variant; optional omissions do not. Later issues fulfill only exact item-and-variant requirements and preserve lifecycle history.

Authorization occurs before signing and on event application. Application validates current inventory/property inside the repository transaction. An invalid line aborts the cloned draft, preventing partial changes. Stock cannot become negative. Stable IDs protect double taps, retry, and duplicate delivery.

Offline events are signed, projected, stored, and queued in one transaction. Reconnect publishes the durable outbox. A stale competing final-unit issue is preserved but quarantined as an open conflict without applying an impossible mutation. Issue requires `inventory.issue`, return `inventory.return`, correction `inventory.adjust`, and reconciliation `conflicts.resolve`.

Full transactions remain private. Public commitments contain only privacy-safe protocol metadata, opaque IDs, hashes, timestamps, opaque organization ID, and signer public reference. Mainnet remains unavailable.

## Consequences

One event avoids half-applied line events and simplifies reconstruction, at the cost of treating a multi-line transaction as the conflict unit. Production overlay transport, hardware-backed custody, correction UI, persisted drafts, richer expected-zero variants, condition/disposition, calendar, and dashboard work remain later stages.
