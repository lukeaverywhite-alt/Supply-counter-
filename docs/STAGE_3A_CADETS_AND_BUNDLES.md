# Stage 3A — cadets, bundles, and Still Needed

## Authoritative models

Cadets are opaque-ID projections of authorized `CADET_CREATED` and `CADET_UPDATED` signed events. A record contains name, explicit Male/Female gender, NS1–NS4 level, active state, optional category-specific sizes, current property, timestamps, version, and applied-event IDs. Deactivation is an update: it never deletes property or history.

Bundles are first-class projections. Each immutable version records its bundle ID, display name, gender and purpose applicability, ordered required/optional lines, sizing behavior, quantity, active state, timestamp, actor, prior version, and source event. A missing `itemId` means “not configured”; it never implies inventory exists. The seven factory versions exactly implement the product specification, are inserted only when their stable bundle ID is absent, and never overwrite an edited bundle.

Still Needed requirements retain item/label, optional size and bundle, needed and fulfilled quantities, lifecycle status, timestamps, source, version, and applied-event IDs. Stock availability is calculated against the current inventory projection. Stock does not fulfill a requirement. Readiness is `READY` only when no open or partially fulfilled requirement remains; its percentage is derived, never stored.

## Events, authorization, and offline behavior

The replica signs, validates, persists, projects, and queues cadet, bundle, and Still Needed events through the Stage 2.5 repository/outbox. `cadets.manage` gates cadet and requirement mutations; `bundles.manage` gates bundle mutations. Supply Officer and Master have these permissions, while Supply Assistant remains read-only. Inbound events are signature-, protocol-, organization-, permission-, and payload-validated. Duplicate event IDs are ignored.

Offline changes project immediately and remain in the durable outbox. Pulling the same event is idempotent. Two updates from the same base cadet or bundle version retain both signed events and create an open conflict; neither timestamp nor arrival order silently rewrites the accepted version.

## Migration and privacy

Repository schema 3 adds cadet, bundle, and Still Needed projections without removing inventory, events, outbox, or conflicts. Legacy cadets receive new opaque IDs, and recognizable legacy requirements are linked through an in-memory migration map. Migration writes only after full validation; the legacy source and marker remain untouched on failure.

Cadet payloads belong only in encrypted private history. Public audit data continues to be allow-listed and may contain opaque event/entity references and hashes, but never name, gender, NS level, sizes, property, or requirement details. No key, mainnet adapter, or production transaction is added.

## Known limitations

The existing issue/return prototype is intentionally not replaced in Stage 3A. Automatic requirement fulfillment, historical bundle attachment to an issue, full conflict-resolution UI, production private-history transport, and the final bundle editor/issue review experience remain for Stage 3B or later. The current command-center panel exposes the factory catalogue and explicitly disables issuing from a bundle.
