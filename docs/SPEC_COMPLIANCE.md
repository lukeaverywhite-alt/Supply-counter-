# Master specification: where each section stands

This maps every section of `Docs/Master specification plan` to the code that implements it and the
tests that prove it. **Done** means built and covered by automated tests. **Partial** and **Future**
say exactly what is missing and why. Decisions the unit owner made that shape the answers:

* Cadets are identified by an opaque cadet ID (e.g. `C-7K2M`); a name is optional and only ever travels encrypted.
* Every device has its own wallet; the Master tops members up with testnet coins.
* A shared count's total is the sum of everyone's contributions; an officer finalizes it and it replaces on-hand.
* The catalog ships with the spec's items at 0 on hand and no sizes; the unit adds its real sizes.
* Removing a member replaces the unit key; Master authority can be delegated; the Master keeps an encrypted recovery file.
* Device notifications work without a server (open app or background tab only).

## Summary

| § | Topic | Status |
|---|---|---|
| 1–2 | Vision, users | Done |
| 3 | Authority and identity | Done (multi-party approval: Future) |
| 4 | Roles and permissions | Done (org-wide settings: Partial) |
| 5 | Dashboard | Done |
| 6 | Cadet records | Done |
| 7 | Inventory model | Done |
| 8–9 | Editable bundles, default presets | Done |
| 10–11 | Issue and return | Done |
| 12 | Corrections | Done |
| 13 | Physical counting | Done |
| 14–19 | Supply calendar, NCO, BLT, AMI, Military Ball, End-of-Year | Done |
| 20 | Alerts (tier 1 and tier 2) | Done (closed-app push: Future, needs a server) |
| 21, 32 | Real-time multi-device | Done within polling limits |
| 22–23 | Offline-first, conflict resolution | Done |
| 24 | Event-sourced state | Done |
| 25–26 | BSV role, privacy boundary | Done (BSV-native identity keys: Future) |
| 27–30 | Storage, provider adapters, environments, visual safety | Done |
| 31 | Mainnet gate | Done as a lock; the review items are Future by design |
| 33–34 | Idempotency, causal structure | Done |
| 35 | Readiness engine | Done |
| 36 | Activity / audit view | Done (Merkle/SPV proof: Future) |
| 37 | UX principles | Done; see the UI fixes in the latest commits |

## Section by section

### §3 Authority and identity
* Each person's own signing, ECDH and wallet keys live only on their device, sealed under their passphrase (`src/unit/vault.ts`). People join by a one-week, one-use ticket (ADR 012); no secret is ever copied between devices.
* Credentials carry subject, role, permissions, issued date, issuer, optional expiry, version; revocations are signed (`src/auth/authorization.ts`).
* **Delegated Master authority** by an authority-signed `MASTER` credential, never by copying a key; only the unit authority makes or removes a Master (`src/unit/runtime.ts`, `changeRole`, `admit`). Tests: `src/unit/keyManagement.test.ts`.
* **Revocation replaces the unit key** for everyone who remains (`UNIT_KEY_ROTATED`). Tests: `keyManagement.test.ts`.
* **Recovery file** restores Master authority on a new device, including key generations made later (`exportRecoveryFile`, `restoreFromRecoveryFile`). Tests: `keyManagement.test.ts`.
* Future: optional multi-party (threshold) approval. The authority is one key today; delegation and revocation leave room for it.

### §4 Roles and permissions
* Master, Instructor, Supply Officer, Supply Assistant with permission sets defined once in `ROLE_PERMISSIONS`; the UI checks the person's signed credential, not scattered role checks (`App.tsx` `can()`).
* Role changes are one signed `ROLE_CHANGED` event; the person's own device adopts the new role on its next sync.
* Activity (audit) is hidden from people without `audit.read`.
* Partial: readiness weights and the Count Due interval are per-device preferences, not unit-wide settings set by the Master. There are no separate `alerts.read` / `alerts.manage` permissions; everyone sees alerts, and acknowledgement is per device.

### §5 Dashboard
* Home is the landing screen with no taskbar; the animated readiness tree's CADETS / STOCK / EVENTS / READINESS nodes are clickable and open Still Needed, Inventory filtered to items needing attention, the Calendar, and a readiness breakdown (`src/features/dashboard/`).
* Date, time, critical alerts, next event with countdown, sync status, audit health, large ISSUE / RETURN / COUNT buttons.
* An AMI card appears as AMI approaches (≤45 days), moves to the top at ≤14 days and escalates at ≤3 days.

### §6 Cadet records
* Opaque cadet ID, optional encrypted name, gender, NS level, active flag, current property with sizes and dates, full issue/return history, still-needed items with Fulfil/Cancel, correction history (`src/features/cadets/`).
* Bundle recommendations use each bundle's own gender and purpose fields, never hard-coded names; overridable.

### §7 Inventory
* Item, category, size, on hand, issued, low-stock threshold, NIIN, count increment, active flag.
* Statuses Healthy, Low, Out of stock, **Count Due** (never counted or older than the interval), **Reconciliation Required** (open conflict, stock moved during a count, late count work) (`src/stage3/inventoryStatus.ts`).
* Likely-duplicate warnings by normalized name, NIIN and word overlap on add and rename (`src/features/inventory/duplicates.ts`); search by name, abbreviation, size (34R, "34 R", 7.5W), category and NIIN (`src/domain.ts`).

### §8–9 Bundles
* Editable, versioned bundle definitions; historical issues keep the bundle version used. The seven presets match §9 exactly (Male SDB: White Dress Shirt optional; no combo cover or gloves).

### §10–11 Issue and return
* Issue: search cadet; see their actual property and still-needed items; choose a bundle or individual items; per-line sizes; add extra lines or drop optional ones; stock check; review; confirm. Shortfalls go to Still Needed (`src/components/SupplyWorkflow.tsx`).
* Return: only what the cadet holds, several lines, quantities, per-line condition (Serviceable / Needs repair / Unserviceable / Lost) and note. Only serviceable returns go back on the shelf.

### §12 Corrections
* Size corrections (`PROPERTY_CORRECTED`, e.g. 34R → 32R) and quantity corrections (`RECORD_CORRECTED`: received, issued, returned quantities) keep the original event, record what was wrong, the new value, the reason, who and when, and the reference to the original. An impossible correction becomes a visible conflict, never negative stock. Activity shows from → to. Tests: `src/distributed/supplyRecords.test.ts`, `specFeatures.test.ts`.

### §13 Physical counting
* Search, count by 1 / 5 / 10 / custom, per-item preferred increment, undo, personal drafts, review, discrepancies, submission, reconciliation, multi-user counting, category assignments.
* Lifecycle Draft → Active → Needs approval → Reconciled / Cancelled: assistants submit for approval; officers approve or send back with a reason. A finalization stands even if a correction the officer had not seen arrives later (it shows as late). Tests: `src/distributed/countApproval.test.ts`, `src/features/count/`.

### §14–19 Supply calendar and events
* NCO, BLT, AMI, Military Ball, End-of-Year and custom events with manually entered date and time, countdown, preparation tasks with deadlines relative to the event, completion tracking, attendees and linked bundles (set-style events, so concurrent edits merge); concurrent edits of the same field raise a visible conflict (`src/features/calendar/`).
* Event readiness: roster (NCO defaults to active NS1 cadets), gender-matched bundles, demand by size ("size unknown" when a cadet has no size), shortages, completed issues, BLT/Military Ball post-event returns (`src/stage3/eventReadiness.ts`).
* AMI readiness: Inventory Count, Cadet Records, Outstanding Corrections, Still Needed, Audit Health, Synchronization Health (`src/stage3/amiReadiness.ts`).
* End-of-Year review: count coverage, discrepancies, return-pending cadets, rollover checklist, "Start annual rollover" (`src/stage3/endOfYear.ts`). The rollover advances only the cadets its author saw.

### §20 Alerts
* Tier 1: cadet incomplete, low / out of stock, overdue return, count discrepancy, reconciliation required, event deadline and event date approaching, task overdue, sync issue, publish failure, unresolved conflict, access changes and expiring credentials, integrity failure, unreadable records. Each opens the exact record; device-local acknowledgement re-alerts when the condition changes.
* Tier 2 (`src/notifications/`, `docs/DEVICE_NOTIFICATIONS.md`): browser notifications while A.R.G.U.S. is open or in a background tab, one per supply event, rate-limited, stopping once opened, acknowledged or resolved. Periodic Background Sync where supported (installed Chromium apps).
* Future, by the no-server decision: notifying a fully closed app needs a push server (Web Push / APNs).

### §21, §32 Real-time multi-device
* Other devices' changes appear without refreshing: the transport polls the chain every 15 s, on reconnect and when the app returns to the screen; your own changes publish immediately. Discovery, validation, duplicate prevention, ordering, replay protection, versioning, retry, reconnect and corruption recovery are covered in `src/unit/` and `src/chain/` tests.
* Limit: "seconds" depends on the 15 s poll and chain/mempool indexing; there is no push channel.

### §22–23 Offline-first and conflicts
* Durable encrypted local ledger (IndexedDB), local validation, signed events, durable outbox. Per-record status LOCAL / QUEUED / SYNCING / SYNCHRONIZED / CONFLICT / FAILED comes from the ledger. VERIFIED means mined in a block (`src/distributed/delivery.ts`, `src/features/activity/`).
* Conflicts show competing events with time and actors, affected inventory, the losing cadet and the impossible state ("would leave −1"). Resolution is a signed event with an outcome, either keep as is or record Still Needed for the losing cadet. Nothing is silently discarded; conflict IDs are the same on every device.

### §24 Event-sourced state
* Every mutation is a signed domain event folded deterministically by Lamport clock and event ID. The spec's events all exist; `COUNT_RECONCILED` is named `COUNT_SESSION_RECONCILED`. Conflicts are derived identically on every device rather than emitted as `CONFLICT_DETECTED` events.

### §25–26 BSV role and privacy boundary
* No application server or database: the unit's history is encrypted records on BSV testnet, discovered through WhatsOnChain (`docs/BSV_SHARED_LEDGER.md`). Only an opaque unit ID, key generation label, random event ID, nonce and ciphertext are public. Everything identifying is AES-256-GCM encrypted, not hashed.
* Future: people sign with WebCrypto P-256 keys; their BSV keys only pay fees. Moving identities onto BSV keys is a later step.

### §27–30 Storage, providers, environments, safety
* IndexedDB behind store interfaces; private keys sealed in the device vault, never ordinary records.
* The chain adapter is `ChainApi` with `FakeChain` (tests, deterministic) and `WhatsOnChainApi` (testnet). Only the wallet builds transactions.
* MOCK in CI, TESTNET with test keys only; every screen, including sign-in, shows "BSV TESTNET · Development Environment · No Production Transactions" (or MOCK BLOCKCHAIN).

### §31 Mainnet gate
* Mainnet keys and addresses are refused in code; no environment variable can enable spending. The listed reviews are deliberately not done: security review, privacy review, key-management design sign-off, backup and incident-response planning. They need people, and must happen before any mainnet work.

### §33–34 Idempotency and causal structure
* Global event IDs, bound to their author so nobody can publish under someone else's ID; replaying an event never repeats its effect. Lamport clocks are bounded, entity versions and conflict markers handle concurrent offline work, and there is no single global previous hash.
* Not done (the spec says "may"): events referencing prior event hashes.

### §35 Readiness engine
* Cadet readiness = fully issued against the NSU and PT bundles that apply to them. Inventory readiness = the sizes bundles need are stocked, above threshold and cover waiting cadets; an empty unit is not "ready". Event readiness combines tasks, stock and people. Audit readiness counts only records verified in a block. Weights are configurable per device.

### §36 Activity / audit view
* Plain-language action, actor, time, affected record, sync status and verification as separate labels, correction relationships, and expandable technical details: audit hash, network, transaction, block. No secrets.
* Future: Merkle / SPV inclusion proofs (`src/blockchain/spv.ts` is ready to wire in).

## Known limits (honest list)
* WhatsOnChain is a third-party dependency for discovery; the app keeps working offline and catches up.
* Record times are claimed by devices. The fold holds a removed member's later records to their removal, but a deliberately modified client can still back-date work to before it.
* Encrypted data on a public chain is permanent. A leaked unit key exposes that key generation's history; the school or command should approve before real cadet data is entered.
* Passphrases cannot be recovered; the Master's recovery file (or a delegated Master) covers loss of the Master device.
* Plaintext on the device: the device record holds its own display name, unit name and wallet address (shown on the unlock screen), and personal count drafts are kept in local storage. The chain shows which wallets paid for records and that the Master topped them up.
