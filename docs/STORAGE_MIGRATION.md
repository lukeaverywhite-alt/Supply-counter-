# Storage migration

Repository schema version 2 is explicit. Opening IndexedDB migrates older structurally valid replica state and adds independent audit status. Future versions and malformed structures throw while preserving the stored source.

The one-time legacy migration reads `argus.local.v2`, validates AppData version 3, copies inventory into version-zero repository projections, commits, and only then writes `argus.distributed.migration.v1`. Re-running is a no-op. JSON/schema failure does not clear, overwrite or mark the legacy source. LocalStorage remains available for the migration marker and non-operational UI data; it is no longer written by the core inventory UI.
