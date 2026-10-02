# Handoff: state of A.R.G.U.S. and what to do next

As of 2026-09-28. Written for the next team (Codex agents) taking over. `AGENTS.md` has the rules and commands; this
file explains how the system works, what the owner decided, and what is left.

## 1. What exists now

A.R.G.U.S. is the unit's Supply app, and it covers the whole master specification (`docs/SPEC_COMPLIANCE.md`
maps every section to code and tests). Main capabilities:

* **One shared data pool, no server.** Each person's device holds their own signing key, ECDH key and testnet wallet,
  sealed under their passphrase. Every change is a signed event, encrypted with the unit key (AES-256-GCM) and written
  to BSV testnet in an OP_RETURN output next to a 1-sat output to the unit's *anchor address*. Devices discover
  everyone's records by walking that address's history on WhatsOnChain.
* **Proven:** "A counts 3 PT Shorts, B counts 3 → every device shows 6; the officer finalizes; on-hand is 6 everywhere".
  This ran on live BSV testnet on 2026-09-27. It is also covered end-to-end on an in-memory chain in
  `src/unit/runtime.test.ts` and `testnet/shared-count.testnet.ts` (dry run).
* **Supply features:**
  * Inventory: the spec's 25 items start at 0 on hand, with editable sizes from Supply Manual presets. Items can be Count Due or Reconciliation Required, likely duplicates are flagged, and search understands abbreviations and sizes.
  * Counting: shared counts with an approval step.
  * Cadets: shown by opaque ID, with an optional encrypted name.
  * Issue and return: partial issues go to Still Needed; returns record each item's condition.
  * Corrections: size and quantity corrections as new events.
  * Conflicts: resolved with an explicit outcome.
  * Admin: bundle editor, roster import, annual rollover.
  * Dashboard: Home with the readiness tree, real readiness numbers, and alerts that open the exact record.
  * Supply Calendar: NCO, BLT, AMI, Military Ball and End-of-Year, with attendees, bundles and event readiness, plus the AMI dashboard and the End-of-Year review.
  * Activity: shows per-record sync status; VERIFIED means mined in a block.
  * Device notifications: work only while the app is open or in a background tab, since there is no server.
* **Access:**
  * Master, Instructor, Supply Officer and Supply Assistant roles.
  * Admission by a public join code and a device-bound admission QR image (shareable remotely; text fallback retained).
  * Role changes.
  * Delegated Master authority.
  * Removal that gives everyone who remains a new unit key.
  * An encrypted recovery file for the Master role.
* **Quality:** 570+ tests (Vitest, jsdom, React Testing Library, fake-indexeddb). A code review of the engine (17 bugs)
  and a Playwright click-through at phone and desktop width (26 findings) were done; all findings are fixed, each with a
  regression test.

History and design records: `docs/BSV_SHARED_LEDGER.md` (design and live result), `docs/adr/010-bsv-shared-ledger.md`,
`docs/DEVICE_NOTIFICATIONS.md`. Many older files in `docs/` describe superseded stages and carry a "superseded" banner.
Trust the code and the four documents named in `AGENTS.md` over them.

## 2. Decisions the owner already made (do not reopen without asking)

* Cadets are identified by an opaque cadet ID. A name is optional and only ever travels encrypted.
* Every device has its own wallet; the Master tops members up with testnet coins at admission (default 2,000 sats).
* A shared count's total is the **sum** of everyone's contributions; an officer finalizes it and it **replaces** on-hand.
* The catalog ships with the spec's items at 0 on hand and no sizes; the unit adds its real sizes.
* Removing a member automatically replaces the unit key for everyone who remains.
* Master continuity uses a delegated Master **and** an encrypted recovery file.
* Device notifications without a server: they work only while the app is open or in a background tab.
* Testnet first. Mainnet only after the spec §31 reviews, which need people.

## 3. How a change flows (read with the code)

1. A screen calls `DistributedAppController` (`src/distributed/appIntegration.ts`), which calls a command on
   `ArgusReplica` (`src/distributed/replica.ts`).
2. The command checks the author's permission (`authorization.require`), builds a signed event with Lamport
   `clock = local max + 1` and an **author-bound event ID** (`<sha256(author)[0:12]>.<uuid>`, so nobody can publish
   under someone else's ID), preflights that it can be sealed (size), applies it locally, and queues it.
3. `UnitEventSyncProvider` (`src/unit/syncProvider.ts`) seals it into an envelope and stores it, still encrypted, in
   the device's IndexedDB ledger (`src/unit/ledgerStore.ts`).
4. `ChainTransport` (`src/unit/transport.ts`) batches queued envelopes into a transaction via the device wallet
   (`src/chain/wallet.ts`: exactly-once broadcast, fee bump, rollback) and publishes to WhatsOnChain. It polls every
   15 s, on reconnect and when the app returns to the screen, scans the anchor address, validates new envelopes
   (the author's signature and author-bound ID), stores them, and hands them to the provider.
5. The provider decrypts, accepts credentials and revocations (retrying ones whose issuer hasn't arrived yet), and the
   replica folds the events in canonical order. It folds incrementally when events arrive in order and rebuilds from
   the start otherwise. Events that would corrupt state are set aside; impossible outcomes become conflicts.
6. `UnitRuntime` (`src/unit/runtime.ts`) then reconciles the device: it installs new unit key generations granted to
   it, adopts role changes, notices its own removal, and lets the Master introduce itself after the first chain scan.
7. Per-record status (LOCAL / QUEUED / SYNCING / SYNCHRONIZED / CONFLICT / FAILED, plus VERIFIED once mined) is derived
   from the ledger in `src/distributed/delivery.ts`. It is device metadata and never feeds the fold.

Key invariants: see "Hard rules" in `AGENTS.md`. The fold must stay deterministic. Clocks are bounded (≤ 1e11, jump
≤ 100,000). Only applied events move the clock. Authorization respects fold order: once a removal or role change is
folded, the author's later records are held to it.

## 4. Testing toolbox

* `src/chain/fakeChain.ts` (`FakeChain`): an in-memory BSV testnet. It can `fund`, `mine`, fail broadcasts with
  `failNextBroadcasts('accepted' | 'ambiguous' | …)` (undo with `clearInjectedFailures()`), lag the index
  (`unspentLag`), return duplicate unspent entries (`duplicateUnspent`), and make `txHex` report not-found
  (`txHexNotFoundCount`). Use it for any multi-device test.
* Multi-device pattern: see `unitWithMembers()` in `src/unit/runtime.test.ts` and `unit()` in
  `src/unit/keyManagement.test.ts`. Each device gets its own `MemoryLedgerStore`, `MemoryWalletStateStore` and fake
  `storage`; `syncNow()` then `chain.mine()`.
* Replica-only pattern (no chain): `MockSyncProvider` + `MockIdentityProvider`; see `src/distributed/robustness.test.ts`
  and `convergence.test.ts`.
* UI: React Testing Library; mock mode renders `<App controller={new DistributedAppController()} />`; the onboarding
  tests render `<App runtimeOptions={{ api: new FakeChain(), … }} />` (see `src/App.test.tsx`).
* Heavy crypto (PBKDF2 600k) makes vault and onboarding tests slow; keep generous timeouts in those files.

## 5. Live testnet

* The dev container that built this could not reach WhatsOnChain; the live run was done by another agent with network
  access. `npm run testnet:keys` creates `~/.config/argus/testnet-keys.json` (outside the repo, mode 0600) and prints
  the Master address. Fund it from a BSV **testnet** faucet (e.g. https://witnessonchain.com/faucet/tbsv), then run
  `npm run test:testnet`. The run writes `testnet/last-run.json` with every transaction link, and costs about 20 sats in
  fees plus 300 in member top-ups.
* **Needed next:** the 2026-09-27 unit (`u-32c7dc14…`) predates author-bound event IDs, so current code rejects its
  records. Run the live test again to create a fresh unit, and add the result to `docs/BSV_SHARED_LEDGER.md` ("Live
  result"). The existing funded key had 681 sats left after the last run.

## 6. What to build next (priority order)

1. **Live testnet re-run** (section 5), with results documented.
2. **Unit-wide settings set by the Master.** Readiness weights and the Count Due interval are per device today
   (`src/settings.ts`). The owner was asked whether the Master should set them once for the whole unit; confirm with
   them, then add a signed `UNIT_SETTINGS_UPDATED` event (Master-only), fold it, and let the device preference fall back
   to the unit value.
3. **Small follow-ups found during the last pass:**
   * Count category assignments are capped at 150 sizes per count (record size limit); split larger ones.
4. **SPV / Merkle inclusion proofs**, so VERIFIED is independently checkable (`src/blockchain/spv.ts` is a starting point).
5. **Bundle size:** the app ships as one ~850 KB script; code-split the heavy screens and `@bsv/sdk`.
6. **Future, only if the owner wants it:** multi-party approval for sensitive changes, BSV-native identity keys,
   events referencing prior event hashes. Notifications for a fully closed app need a push server; the owner chose
   no server.
7. **Needs people, not code:** school or command approval before real cadet data goes on chain (even encrypted), and
   the §31 mainnet reviews (security, privacy, key management, backup, incident response).

## 7. Gotchas

* Node 24 is required (WebCrypto, `CompressionStream` and the Vite/Vitest versions depend on it).
* Lint errors in `.claude/` or other agent scratch folders come from local tool copies, not the repo; CI lints a clean
  checkout.
* Records over ~60 KB cannot be published; a command that would create one is refused before it touches state (roster
  imports are chunked).
* The `main` branch deploys GitHub Pages on every push; open PRs and let CI pass first.
* Keep user-facing text plain ("Needs testnet coins", "Waiting for a block"), never raw crypto or API errors; show those
  under "Technical details".
