# ADR 006: Stage 3B atomic supply transactions

**Status:** Accepted

Stage 3A.5's `RepositoryState → ArgusAppProjection → App` boundary remains authoritative. Stage 3B adds no operational `AppData` state.

Each confirmation is one signed transaction event containing all lines. This gives event application a shared atomic unit, stable IDs for retries, and reconstructable grouped history. Bundle Issue stores ID, exact `currentVersion`, and an immutable snapshot.

Inventory entity ID is the SKU authority; canonical label and variant are domain-derived. Bundle mapping is explicit `line.itemId` only. Duplicate line IDs and SKUs are rejected. New Issues create separate property lines so provenance is retained.

Missing required lines create or merge Still Needed records and append `relatedTransactionIds`. Exact SKU/variant issues fulfill them; returns never infer need.

Application validates before mutation. Concurrent final-unit failure quarantines the entire transaction and creates an inventory-keyed conflict containing both signed event IDs. No partial replay or last-write-wins is allowed.

Issue requires `inventory.issue`, return `inventory.return`, correction `inventory.adjust`, and resolution `conflicts.resolve`. Offline events persist with projections and outbox. Private details remain private; public audit stays opaque; mainnet stays disabled.

Logical schema 5 adds in-record fields. IndexedDB stays physical version 4 because no object store or index changed.
