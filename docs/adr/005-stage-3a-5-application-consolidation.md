# ADR 005: Stage 3A.5 application consolidation

**Status:** Accepted

## Decision

1. `RepositoryState`, signed events, and projections are authoritative operational state.
2. Legacy `AppData` and seed fixtures remain compatibility-only migration inputs because installed prototype data must be preserved.
3. React obtains data through `DistributedAppController.project()` as `ArgusAppProjection`.
4. UI commands call one controller method, which authorizes, validates, signs, persists, projects, and queues the event.
5. Inventory is flat: each entity is one item-and-variant SKU, with all operational metadata in that projection.
6. Bundle lines map via explicit inventory IDs. Initial mapping may use exact label equality only; an unmapped label is never guessed.
7. Cadets use generated opaque repository IDs. Old IDs are only inputs to the one-time reference translation.
8. Still Needed is projected by cadet and inventory IDs; availability and readiness are derived.
9. Activity is a read model over stored signed events, with sync and audit states shown separately.
10. UI settings use a dedicated namespaced settings abstraction backed by device local storage.
11. Preferences never enter or mutate Supply operational data.
12. A non-mutating integrity inspector flags quantity, duplication, version, and orphan-reference errors.
13. Migrated gender is explicitly marked for review because the legacy schema did not contain it.
14. Before Stage 3B, a full bundle mapping editor and issue/return commands that update current property must be implemented; the current UI truthfully labels those workflows Coming Later.

## Consequences

Seed data cannot overwrite repository projections after initialization, cross-client events can appear after projection reload, and business actions cannot produce a legacy/distributed dual write. Schema version 4 supplies safe metadata defaults while preserving the existing IndexedDB object store and its upgrade safety behavior.
