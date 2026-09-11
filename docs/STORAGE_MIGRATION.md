# Storage migration

A.R.G.U.S. has two deliberately separate version numbers:

- `INDEXED_DB_VERSION` controls the browser database's physical structure. Opening a
  higher version runs an IndexedDB version-change transaction.
- `REPOSITORY_SCHEMA_VERSION` identifies the logical payload stored at
  `replica/state`. After IndexedDB opens, `migrateRepositoryState` validates that
  payload, preserves existing records, and supplies fields introduced by newer
  repository schemas.

## Safe IndexedDB upgrades

The version 3 upgrade previously called `createObjectStore('replica')`
unconditionally. An installed version 2 database could already contain that store,
so the call raised `ConstraintError` and aborted the entire version-change
transaction.

The upgrade now checks `objectStoreNames.contains('replica')` before creation. The
store is reused during an upgrade, so the existing `state` value is not deleted or
reseeded. **Never recreate an existing IndexedDB store during an upgrade.** Future
physical changes must be version-gated using `oldVersion`, and every store creation
must also have an existence check. Do not delete the database or a store as a
migration shortcut.

Once the database opens, logical migration adds missing Stage 3A collections
(`cadets`, `bundles`, and `stillNeeded`) and missing event `auditStatus` values. It
does not replace collections that are already present. Malformed state and state
from an unsupported future repository schema produce a clear error; the original
stored value remains untouched.

If another tab holds an older database connection, initialization reports that the
other A.R.G.U.S. tabs must be closed before reloading. Open connections listen for
`versionchange` and close themselves so a later release can upgrade. Open, upgrade,
transaction, and logical-migration failures reject through the application
initialization path rather than being silently reset.

## Legacy localStorage

The one-time legacy migration reads `argus.local.v2`, validates AppData version 3,
and copies inventory and roster requirements only into an empty repository. It
writes `argus.distributed.migration.v1` only after the repository transaction
commits. Re-running is a no-op. JSON/schema failure does not clear, overwrite, or
mark the legacy source, and an existing IndexedDB inventory is never overwritten by
legacy seed data.

## Upgrade verification

Test upgrades against a database at the preceding physical version with a populated
`replica/state`, then reopen it at the current version and confirm inventory,
events, outbox, conflicts, cadets, bundles, and Still Needed projections remain.
Also reopen at the current version to verify startup is idempotent and defaults are
not duplicated.
