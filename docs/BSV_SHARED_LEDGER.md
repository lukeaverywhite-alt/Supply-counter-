# A.R.G.U.S. shared ledger on BSV testnet

Status: **implemented and tested against an in-memory chain; live BSV testnet run pending**
(needs `api.whatsonchain.com` network access and a faucet-funded wallet — see “Live testnet check”).
Supersedes the relay-era documents (`BSV_SHARED_SYNC_IMPLEMENTATION.md`,
`SHARED_COUNTING_MILESTONE.md`, `IMPLEMENTATION_STATUS_2026-09-26.md`) and the demo in
`demo-argus-foundation.md`. Decision record: [ADR 010](adr/010-bsv-shared-ledger.md).

## What the unit gets

* **One shared data pool, no server, no database.** Every change anyone makes — counts, sizes,
  stock receipts, cadets, issues, returns, bundles, conflict resolutions, admissions — is a signed
  event that is encrypted and written to BSV **testnet**. Every device reads the same history back
  from the chain and computes the same numbers.
* **Each person has their own key.** The Master admits people; nobody ever copies a key.
* **Shared, additive counting.** A counts 3 PT Shorts, B counts 3 PT Shorts → every device shows
  **6**. A Supply Officer (or Master) finalizes the count and on-hand becomes 6 everywhere.
* **Cadets by ID.** Cadets are shown as short opaque IDs (e.g. `C-4F7K`). A name is optional; if
  entered it only ever exists encrypted on chain/disk and is shown on screen only when someone taps
  “Show name”.
* **No placeholder data.** A new unit starts with the 25 items named in the master
  specification’s bundles, at **zero** on hand and with **no sizes**. Sizes are added per item from
  presets transcribed from the NJROTC Supply Manual size charts (Tables 2-6 … 2-10) or typed in.

## How it works

```text
UI ──► DistributedAppController ──► ArgusReplica (plaintext, in memory only)
                                        │  signed event (ECDSA P-256, per person)
                                        ▼
                               UnitEventSyncProvider ── seals { event, author credential }
                                        │                with the unit data key (AES-256-GCM)
                                        ▼
                               LedgerStore (IndexedDB, ciphertext only)
                                        │
                                        ▼
                               ChainTransport ──► DeviceWallet (this device’s testnet key)
                                        │            builds: OP_FALSE OP_RETURN "ARGUS" 0x02 'E' <envelope> …
                                        │                    + 1 sat → unit anchor address + change
                                        ▼
                               WhatsOnChain testnet  ◄── every device walks the anchor address
                                                          history (confirmed + mempool) to find
                                                          everyone’s records
```

### Deterministic convergence (why every device shows the same number)

Every event carries a **Lamport clock** (one more than the highest clock its author had seen).
The projection is always *the fold of all known, signature-valid events in (clock, eventId)
order over the genesis catalog*. Events that extend the order are applied incrementally; anything
that arrives “in the past” (an offline device catching up, a reordered chain page) triggers a full
rebuild. Consequently two devices holding the same events hold byte-identical projections — a
property tested with randomized delivery orders (`src/distributed/convergence.test.ts`).

Conflicts are only raised for **physically impossible** outcomes — issuing stock that is not
there, returning property a cadet no longer holds — or genuinely concurrent edits of the same
fields. Two officers issuing from a well-stocked shelf at the same time is not a conflict. Each
conflict is deterministic (every device sees the same one) and is resolved with a signed
`CONFLICT_RESOLVED` event (More → Conflicts).

### Counting rules

* A **shared count** (Count tab) is open until an officer finalizes or cancels it.
* Each person’s “Add my count” is an immutable contribution; contributions **add up** per size.
  People fix their own mistakes with an append-only correction.
* **Finalize** (Supply Officer / Master) freezes exactly the contributions that device has seen and
  replaces on-hand of every counted size with the shared total. Sizes nobody counted are
  unchanged. Contributions that reach the chain after finalization are shown as **LATE** and never
  silently change stock. Stock movements during the count are listed as “verify” warnings.
* **Receive stock** (Inventory → item → size) is additive (+N) and commutes across devices.

### Identity, admission and keys

| Secret (per device, sealed under the passphrase) | Purpose |
|---|---|
| signing key (ECDSA P-256) | signs every event this person creates |
| ECDH key (P-256) | lets the Master hand this device the unit data key |
| wallet key (secp256k1, testnet) | pays the few satoshis each record costs |
| unit data key (AES-256), per key generation | encrypts everything the unit writes |
| authority key (original or recovered Master only) | signs member credentials; the only key that makes or removes Masters |
| recovery key (ECDH P-256, original or recovered Master only) | opens every key generation on behalf of the recovery file |

One PBKDF2-SHA-256 (600k) derivation unlocks them; each secret is separately AES-GCM sealed.
A person joins with a **ticket** (ADR 012, `docs/adr/012-admission-by-invitation-ticket.md`): a Master, or an Instructor
for the cadet roles, names the person and a role, and the app makes a one-week, one-use ticket shown as a QR and a short code.
The ticket is an encrypted record at an address only its code leads to; the new device reads it from the chain with no wallet
of its own, takes the unit keys it carries, and redeems it by spending the ticket's funding output, which the network allows
once. The issuer sees the tickets that are out, with days left, and can cancel one. Nothing in a ticket is useful without its code.

Every envelope carries its author’s Master-signed credential inside the ciphertext, so any member
can verify any other member’s role without a directory server. Revocation is an
`AUTHORITY_REVOKED` event; it forces a re-fold so a revoked member’s later events stop applying.
Credentials and revocations that arrive before the credential they depend on (chain history is not
delivered in causal order) are retried after every pull, so every device converges on the same
answer to “was this person allowed to do this?”.

### Removing someone: the unit key is replaced

Removing a member publishes the revocation and then a `UNIT_KEY_ROTATED` event. The removing
Master creates a new unit data key generation (named `e<n>-<random>` so two Masters rotating at
once never collide), wraps one copy to every remaining active member’s ECDH public key (published
in their admission) and one to the unit recovery key, and announces the list **encrypted under the
previous key**. Every device opens its own copy after the next sync and writes with the newest
generation it holds; concurrent rotations resolve to the same “newest” everywhere (canonical
order). The removed person can decrypt the announcement but none of the copies, so nothing written
afterwards is readable to them. Their earlier work stays in history. Members admitted before
member ECDH keys were recorded are reported as needing re-admission.

### Delegated Masters and role changes (spec §3)

Master authority is delegated without copying any key: the unit authority signs a `MASTER`
credential for a trusted member (by a Master ticket, or later via **Change role**). A delegated Master
makes tickets, re-roles and removes people with its **own** key; its authority-signed credential travels
in the ticket so the new member can verify the chain offline. Only the unit authority
(the original Master device, or one restored from a recovery file) can make or remove a Master.
`ROLE_CHANGED` issues the new credential and revokes the old one in one signed event, so there is
never a moment with two roles or none, and the person’s own device adopts its new role on the next
sync.

### Recovery file

The original Master can download an `ARGUS-RECOVERY-1` file from **Members & access**. It holds the
unit authority key, the recovery key and the unit data keys, encrypted under a separate recovery
passphrase (PBKDF2-SHA-256 600k + AES-256-GCM); only the unit ID is visible outside the
encryption. Exporting registers the recovery key’s public half with the unit
(`RECOVERY_KEY_REGISTERED`), and every later key rotation wraps a copy to it, so the file never
goes stale. **Restore Master from a recovery file** (first screen) sets up a new device with its
own signing, ECDH and wallet keys, self-issues a Master credential with the restored authority,
reads everything (including key generations created after the file), and can then remove the lost
device. Keep the file offline (USB stick or printed) and the passphrase somewhere else.

### What is public on chain

Per record, only: format version, opaque unit ID, key epoch, random event ID, nonce, ciphertext
(`PUBLIC_ENVELOPE_FIELDS`, asserted in tests). Who acted, what they did, when, item names, sizes,
quantities, cadet IDs and names, member names, notes — all inside AES-256-GCM. Observers can still
see: that a unit exists (anchor address), how many records it writes and when, their sizes, and
which testnet wallets paid for them.

### Cost

About 1–3 KB per record at 1 sat/kB (the rate proven on testnet by spell-forge) plus the 1-satoshi
anchor output: roughly **2–5 satoshis per change**. Queued changes are batched (up to 25 per
transaction). 1,000 satoshis covers a few hundred changes; 20,000 covers thousands. Mainnet is impossible in this build.

## Operating it

1. **Master (first person):** open the app → *Create a new unit* → unit name, your name,
   passphrase. Fund the Master wallet: More → Wallet & sync → copy the address → send testnet
   coins from a BSV testnet faucet.
2. **Master or Instructor:** More → Tickets → type the person's name, choose the role → *Make ticket* → show them the QR or send the code (the Master's wallet pays the starter satoshis, default 2,000).
3. **Everyone else:** open the app → *I have a ticket* → scan the QR picture or type the code → *Check ticket* → choose a passphrase → *Join unit*. The Master's phone can be off.
4. A ticket works once and runs out after a week; More → Tickets lists the ones that are out and cancels one.
5. Inventory → pick an item → *Add sizes* (presets or custom) → Count → start a shared count →
   everyone adds their tallies → an officer finalizes.

Status indicators: the top-right pill shows `SYNCHRONIZED`, `N QUEUED`, `SYNCING`, `OFFLINE ·
WORKING LOCALLY`, `NEEDS TESTNET COINS`, or `CONFLICT · ACTION REQUIRED`. Work done offline is
kept (encrypted) and published when the device is back online and funded.

Per-record status (Activity, spec §22/§36) comes from the record's envelope in the local ledger, so
it survives a restart: `QUEUED` (waiting for a wallet transaction — offline or unfunded),
`SYNCING` (transaction built, broadcasting), `SYNCHRONIZED` (the network accepted it), `FAILED`
(the network refused it and the wallet rolled it back; retried), `CONFLICT` (it lost an open
conflict), `LOCAL` (mock mode, this device only). Verification is a separate label: **VERIFIED in
block N** only once the record's transaction is mined; until then it reads *on chain · waiting for
a block* or *not yet on chain*. Audit readiness counts only VERIFIED records. A broadcast that the
network accepted but that never shows up on the anchor history (3 scans over at least a minute) is
queued and published again; so is a record left PUBLISHING after its transaction was withdrawn.

## Live testnet check

```bash
npm run testnet:keys     # once: creates ~/.config/argus/testnet-keys.json (0600, never committed) and prints an address
# fund that address from a BSV testnet faucet (600+ satoshis is enough for one run)
npm run test:testnet     # creates a fresh unit, admits two members, A 3 + B 3 = 6, finalizes, rebuilds a fresh device from chain
```

The run writes `testnet/last-run.json` with the anchor address and every transaction ID
(WhatsOnChain testnet links) as evidence. It needs outbound HTTPS to `api.whatsonchain.com`.

### Live result (2026-09-27)

**Passed on the first live run** against BSV testnet (23:34–23:35 UTC, about 51 s end to end, with no
code change). The Master wallet `mxKM3Zc1ifZQcHHs9RJ6Nsrp4ixpkwggF1` started with 1,000 confirmed
satoshis and finished with 681. Unit `u-32c7dc14f49157f9ab94`, anchor address
[`mfa1zX3eq5SyA3PxWMQdW1WA7dg5HESboS`](https://test.whatsonchain.com/address/mfa1zX3eq5SyA3PxWMQdW1WA7dg5HESboS).
B saw A's count session after 11 s. A, B and C each showed a shared total of 6, then on-hand 6 after
A finalized. A brand-new device rebuilt on-hand 6 and all three members from the chain alone.

The anchor address history holds five unit transactions, all mined in block 1760183:
[`eb8e8d30…`](https://test.whatsonchain.com/tx/eb8e8d3089a33d11e9a23b871a044c180d5de4a40a407af40873d50901437f57),
[`2e989308…`](https://test.whatsonchain.com/tx/2e9893085f189efe6fc1a748b2a14c32b765a9a809db5854c02aafb7c983eb31),
[`52ca8c31…`](https://test.whatsonchain.com/tx/52ca8c31823c481143aaf6865eed8be846ad3094a7b42c4c27fd5088d741c88f),
[`98c1620c…`](https://test.whatsonchain.com/tx/98c1620c576d6bf400ae1018369a77f885b95cbf2579c3874f9ec6ac5a2b4643)
(B's count) and
[`4d28d972…`](https://test.whatsonchain.com/tx/4d28d972fd63a0aaca421939904e3dde53f8e45002ecb199389628483dd2f89a).
The Master's two member top-ups were
[`eec9826c…`](https://test.whatsonchain.com/tx/eec9826ce055ce6b812674535598faa67edd8312669b858a77f0103fd6a1edf2)
and [`16ea8148…`](https://test.whatsonchain.com/tx/16ea814889a83d08b5421666a678f67dffb7d5cb0320f31b669966f094566b0c).
`testnet/last-run.json` from this run lists only the transactions A published itself (four of the
five), because devices did not attach a transaction ID to events that arrived from someone else, so
B's count transaction is missing there. Since fixed: every device now links every change to the
transaction that carried it, whoever published it, and the next live run records all unit
transactions plus the member top-ups (`memberTopUps`).

**API-shape fixes: none were needed.** WhatsOnChain's real answers matched what `src/chain/woc.ts`
parses:
* `/unspent/all` and the `/confirmed/history` and `/unconfirmed/history` endpoints return a
  `{ address, script, result: [...], error: "" }` envelope, and `/unspent/all` items also carry
  `status`.
* The legacy `/unspent` and `/history` endpoints return bare arrays.
* `/tx/{txid}/hex` returns bare hex.
* No `nextPageToken` appeared.
* `/confirmed/history` answers 404 `Not Found` (plain text) for an address with no confirmed
  transactions, and for a `height=` past the last one. The client then falls back to `/history`
  (also 404 on a fresh address) and reads the result as empty.
* A made-up `token=` also answers 404.

These bodies are now pinned verbatim in `src/chain/woc.test.ts` ("real WhatsOnChain testnet
bodies"). Every transaction paid 1 sat/kB, so none needed a fee bump. For example, 2 satoshis for
the 1,534-byte setup transaction and 7 for the 6,038-byte one. The network accepted the
1-satoshi anchor outputs.

## Known limits and open decisions

* **Discovery relies on WhatsOnChain** (a third-party indexer) — it is not our server, but it is a
  dependency. An outage means devices keep working locally and catch up later. Swapping in another
  indexer means implementing `ChainApi` (`src/chain/types.ts`).
* **Removal protects the future, not the past.** Rotation stops a removed member reading anything
  written afterwards; whatever they already decrypted (or could decrypt with older keys) stays
  readable to them.
* **A removed member can still backdate.** They keep older unit keys and could publish events
  claiming a time before their removal (see device-claimed timestamps below). Such events are
  signed with their identity and appear under their name in Activity.
* **Encrypted data on a public chain is permanent.** If a unit key ever leaks, that epoch’s history
  is readable forever. The school/command should approve storing even encrypted, ID-only student
  records this way before real cadet data is entered.
* **Timestamps are device-claimed.** Authorization windows (expiry/revocation) use them; a dishonest
  device could backdate. Keep credential lifetimes bounded.
* **Merkle-proof (SPV) verification is not wired in.** `VERIFIED` means the record's transaction
  was reported mined at a known block height by the chain index (and its signature and role were
  checked by this device); `src/blockchain/spv.ts` is ready for adding chain-inclusion proofs.
* **Passphrases cannot be recovered.** Losing one means erasing the device and being re-admitted;
  unpublished changes on that device are lost. For the Master, the recovery file restores the Master
  role on a new device; without one (or a delegated Master), nobody could admit or remove people.
