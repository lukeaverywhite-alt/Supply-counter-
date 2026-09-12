# Stage 3A.5 — Application Consolidation

## Problem and authority

The prototype previously initialized React with mutable `AppData`, then overlaid only distributed inventory quantities. Several actions wrote a legacy audit/data object and separately invoked the distributed controller. `RepositoryState`, signed events, and their projections are now the sole operational authority. `ArgusAppProjection` is the UI boundary and includes inventory, cadets, bundles, Still Needed, conflicts, events, sync summary, and integrity diagnostics.

`AppData`, its local-storage key, and `seedData` remain only for safe, one-time legacy migration and tests. Hydration completes before operational UI is rendered. Commands execute through `DistributedAppController`, and a complete projection is reloaded after success.

## Domain consolidation

Inventory uses a flat SKU model: one `InventoryProjection` is one item-and-variant combination. Category, variant, NIIN, on-hand, issued, threshold, count increment, active state, version, and applied event IDs live together. Migration preserves the legacy metadata. Inventory create/update and submitted counts are signed events; a count draft is deliberately local and is not inventory.

Cadets use opaque repository IDs. Detail selection stores the selected cadet ID and derives property totals and readiness from `currentProperty` and projected requirements. Legacy gender was unavailable, so migrated profiles receive an explicit review warning rather than pretending the default is verified.

Bundle detail reads the immutable current stored version and exposes history. Factory lines are mapped only by exact labels to existing inventory IDs. Similar labels are never guessed. Each bundle reports fully, partially, or unmapped status and renders unconfigured lines explicitly.

Still Needed joins cadets and inventory by ID. Availability compares remaining quantity with current stock; it is never persisted as a stale boolean. Activity is derived from stored signed events and keeps private-sync status separate from BSV audit delivery.

## Preferences and integrity

Appearance, density, motion, text size, and default navigation are stored under the separate `argus.preferences.v1` local-storage namespace. They never enter the operational repository. Reduced motion is exposed as a document preference for current and future presentation code.

The integrity inspector reports negative quantities, duplicate event/application IDs, orphaned current property and Still Needed references, missing or duplicate bundle versions, and duplicate factory seeds. Diagnostics display findings and never silently delete or repair data.

## Migration and remaining compatibility

Repository schema 4 expands inventory metadata using an explicit, idempotent in-record migration. The IndexedDB upgrade retains store-existence guards plus blocked/version-change handling. Legacy source is marked only after a successful transaction and is not deleted. Compatibility domain helpers remain for migration and historical tests, but production React does not mutate them.

## Stage 3B readiness

Stage 3B can add issue/return against one repository, opaque cadet IDs, canonical stock variants, current property, authoritative requirements, and explicit bundle mappings. Stage 3A.5 intentionally leaves Issue and Return controls disabled and labelled Coming Later.
