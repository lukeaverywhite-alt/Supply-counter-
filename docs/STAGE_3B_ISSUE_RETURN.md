# Stage 3B — Issue and Return

Stage 3B replaces the former demonstration drawers with a mobile-first signed supply workflow. Operators select an active fictional cadet, choose an immutable active bundle version or multiple individual inventory variants, configure each line independently, review live availability, and explicitly confirm. Returns begin with a cadet and expose only that cadet's current property.

## Transaction and event model

A confirmation creates one `ITEM_ISSUED` or `ITEM_RETURNED` signed event whose opaque entity ID is a stable, globally unique transaction ID. It contains all validated lines, inventory IDs and base versions, cadet ID, quantities, optional variants, and original-property references. Bundle issues embed the exact immutable bundle definition and version. A durable `SupplyTransaction` projection makes grouped history survive reload.

The single-event strategy makes the repository transaction the atomic boundary: event, outbox, inventory, current property, Still Needed lifecycle, and transaction history are written together or not at all. Stable event and transaction IDs make retry and duplicate delivery idempotent.

## Operating rules

* Bundle and individual lines retain independent sizes. Profile values are editable defaults only.
* Required unavailable or unmapped lines may be explicitly carried through a partial issue. Equivalent open `INCOMPLETE_ISSUE` requirements merge by cadet, item, and variant. Optional omitted lines create no requirement.
* An exact item-and-variant issue reduces an open requirement while retaining its lifecycle. A different variant does not fulfill it.
* Quantity is a positive whole number capped at 100. Application re-reads repository projections and rejects stale or insufficient stock. Inactive cadets are rejected in the domain.
* Multi-line and partial returns reference original property IDs and cannot exceed possession. Original issue events remain permanent. Returns never infer or alter Still Needed.

## Offline, conflicts, permissions, and privacy

Offline confirmations update IndexedDB and its durable outbox immediately. Reload reads the same events, transactions, projections, and queue. Publishing and receiving deduplicate by event ID. A competing final-unit issue is retained as a signed event, creates an open conflict, leaves stock non-negative, and requires `conflicts.resolve`.

Issue requires `inventory.issue`, return requires `inventory.return`, correction requires `inventory.adjust`, and reconciliation requires `conflicts.resolve`. These checks occur at the domain boundary and on received events.

Operational payloads remain private. Public audit commitments continue to contain only protocol metadata, opaque IDs, hashes, timestamps, organization references, and signer public references—never names, gender, NS level, sizes, property, or Still Needed detail. Mainnet remains disabled.

## Migration and limitations

Repository/IndexedDB version 4 adds the transaction projection and expanded current-property metadata. Stage 3A arrays, events, conflicts, outbox, cadets, bundles and versions, requirements, and inventory are preserved; legacy property rows receive deterministic references. Object-store creation remains existence-guarded.

The private-sync provider remains a development proof. Inventory variants remain separate inventory entities rather than a central expected-zero variant catalog. A correction editor, persistent drafts, production identity custody, alert delivery, calendar, and dashboard are deferred.
