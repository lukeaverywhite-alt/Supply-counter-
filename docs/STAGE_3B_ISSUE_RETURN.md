# Stage 3B — Issue and Return

Stage 3B is integrated into the Stage 3A.5 consolidated architecture. `RepositoryState` remains the only operational authority, `DistributedAppController` returns `ArgusAppProjection`, and React never joins supply operations to legacy `AppData` or performs parallel business writes.

## SKU and bundle rules

One `InventoryProjection` is one stock-keeping variant. Selectors display real variants and store the selected inventory entity ID; the domain derives canonical name and variant from that ID. Client labels or free-text sizes cannot redirect one SKU while recording another. Inactive SKUs are excluded and rejected.

Bundle lines use only explicit `itemId`. Mapping status comes from the Stage 3A.5 `FULLY_MAPPED`, `PARTIALLY_MAPPED`, or `UNMAPPED` projection. Names are never guessed. Current versions resolve by `currentVersion`, not array order, and Issue stores the exact immutable version snapshot.

## Atomic transaction model

One confirmation creates one signed `ITEM_ISSUED` or `ITEM_RETURNED` event whose opaque entity ID is the stable transaction ID. Lines include unique IDs, canonical SKU snapshots, quantities, and base versions. Returns reference original property IDs. Event, outbox, inventory, property, Still Needed, and history commit in one repository transaction.

Validation completes before mutation. Duplicate SKUs are rejected; separate Issues retain separate property provenance. Quantities are whole numbers from 1 through 100, a guardrail against accidental bulk entry. Duplicate delivery is idempotent, while event or transaction IDs reused for different content are rejected.

## Partial Issue and Still Needed

Required mapped out-of-stock and unmapped lines remain missing during review and become `INCOMPLETE_ISSUE` requirements after explicit partial confirmation. Optional omissions do not. Equivalent requirements append to `relatedTransactionIds`, preserving provenance. Fulfillment requires the same cadet, exact SKU, and variant; partial quantities remain `PARTIALLY_FULFILLED`.

## Return, offline, and conflicts

Return shows only selected-cadet property and permits inactive cadets to return gear. Quantities cannot exceed possession. Returns do not create Still Needed.

Offline confirmations persist signed events, projections, transactions, and outbox entries in IndexedDB. Reopen restores them. A stale final-unit Issue quarantines the entire remote transaction. The inventory-keyed conflict identifies cadet and inventory IDs, includes both signed events, leaves stock nonnegative, and requires `conflicts.resolve`.

## Migration, privacy, and limitations

The logical repository schema advances from 4 to 5 and initializes `transactions: []`. Physical IndexedDB remains version 4 because no store or index changed. Existing upgrade guards and source-preserving failures remain. Legacy property references receive unique deterministic `legacy:<cadet>:<index>:...` identifiers.

Full events use private synchronization. Public commitments remain opaque and hash-based, excluding cadet names, gender, NS level, sizes, property, and Still Needed details. Mainnet remains disabled. Production transport/custody, persisted drafts, disposition processing, and correction UI remain later work.
