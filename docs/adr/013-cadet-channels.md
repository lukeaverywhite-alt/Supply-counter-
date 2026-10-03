# ADR 013: Cadet channels

**Status:** final, 2026-10-03 (story mw-kmgi38.9 of epic mw-kmgi38). It began as the domain design of story mw-kmgi38.1 and was
amended by every story after it; the amendments below are kept in order, and **"The design as built"** at the end says in one
place what the epic delivered, where a later story changed an earlier one, and what is not built.

## Context

Luke wants a CADET role: every cadet in the unit can see what they have and what they still need to be issued, and nothing
else (epic mw-kmgi38, 2026-10-03). His decisions on that epic (cards on mw-6ww.66):

* **Q1 A, real privacy:** a cadet's phone can only ever read that cadet's own record. Cadets never join the unit log; staff
  phones write each cadet a small sealed record.
* **Q2 A, a ticket per cadet,** issued from the cadet's record the way staff are admitted today (ADR 012).
* **Q3 A, both kinds of notice:** to ALL cadets (one record, sealed to a notices key every cadet's ticket grants) and to ONE
  cadet (sealed to that cadet alone).
* **Q4 A, headroom:** 250 cadets.

Today every unit record is an event envelope (v2) sealed under the unit's epoch key and paid to the unit anchor address
(ADR 010, `src/unit/envelope.ts`, `src/blockchain/anchor.ts`). Whoever holds an epoch key reads the whole unit: every cadet's
name, sizes and gear, every member, every count. A cadet must never hold one. And a key rotation puts every member's grant in
one sealed record (about 100-120 fit), so 250 cadets could never be members anyway.

## Decision

Every cadet gets a **channel**: a key and an address of their own, outside the unit log. The unit has one more channel for
notices to all cadets.

### The channel key and address

* A channel key is 32 random bytes (AES-256), written as 64 lowercase hex characters (`newChannelKey`, `src/unit/envelope.ts`).
  A staff device makes it when it runs the command; the fold never makes randomness.
* The channel address is derived from the key: the first 20 bytes of `sha256("argus-cadet-channel:" || key bytes)`, as a
  testnet P2PKH address (`channelAddress`, `src/blockchain/anchor.ts`). Whoever holds the key can find the records; the address
  alone gives nobody the key; the label keeps it apart from every unit and key-grant anchor. Like those anchors it is a label,
  not a spendable key. Testnet only (`assertTestnetOnly`).

### Recorded in the unit log, which cadets never read

| Event | Payload | Permission | Fold |
|---|---|---|---|
| `CADET_CHANNEL_CREATED` | `{cadetId, channelKey, channelAddress}` | `cadets.admit` | `cadetChannels` gains `{cadetId, channelKey, channelAddress, version: 1, ...}` |
| `CADET_CHANNEL_ROTATED` | `{cadetId, channelKey, channelAddress, reason}` | `cadets.admit` | replaces the key and address, `version + 1` |
| `CADET_NOTICES_KEY_CREATED` | `{key, address}` | `notices.send` | sets `noticesChannel` once per unit |

The commands are `createCadetChannel(cadetId)`, `rotateCadetChannel(cadetId, reason)` and `createNoticesKey()` on
`ArgusReplica` (and `DistributedAppController`). The key travels inside the unit log, which is sealed under the epoch key:
every staff member can read every channel key (staff already read every cadet's record in the clear), and no outsider can.

The fold checks every one again, since events from other devices are untrusted: the author's permission; a key of exactly 64
lowercase hex characters; an address that `channelAddress(key)` reproduces; a cadet the unit has; one channel per cadet and one
notices key per unit (of two made offline, the first in the unit's `(clock, eventId)` order holds, and the second is a
visible rejection on every device); a rotation only of an existing channel, with a reason; and **no key used twice**, by two
cadets or by a cadet and the notices channel, since a shared key would let one phone read the other's records.

### Who may (provisional, Luke's to confirm)

MASTER, INSTRUCTOR and SUPPLY_OFFICER hold the new permissions `cadets.admit` and `notices.send`; SUPPLY_ASSISTANT does not.

The new role **CADET** holds no unit permission (`ROLE_PERMISSIONS.CADET = []`), and a cadet is never a member:

* `AuthorizationService.acceptCredential` refuses any credential with role CADET, so no device ever counts a cadet as a
  member, and no rotation ever wraps a unit key to one;
* `ticketRuleViolation(_, 'CADET')` refuses a staff ticket for a cadet (a staff ticket package carries the epoch keys); the
  ticket schema also refuses a CADET role. The cadet ticket is its own package (mw-kmgi38.2).

### The cadet's record: CadetView

`cadetViewFrom(state, cadetId)` (`src/distributed/cadetView.ts`, also `ArgusReplica.cadetViewFor`) builds it from the fold, so
every staff device holding the same events builds the same record:

```
{ cadetId, cadetCode, fullName, sizes,
  have: [{ itemId, label, size, quantity, issuedAt }],     // current property, in fold order
  stillNeeded: [{ label, size?, quantity }],               // open needs, the quantity still to issue
  version, updatedAt }
```

Nothing else: no gender, NS level, status, return notes, staff names, transaction or event IDs. `cadetCode` is the code staff
see (`cadetLabel`). `size` on a need is the need's own size, or the size of the exact item it names, or absent ("any size").

**version** is the cadet's projection version plus the versions of all of the cadet's Still Needed lines. The cadet's own
version counts every folded change to the cadet (create, profile edit, each issue and return); a Still Needed change does not
touch the cadet, so the record adds the needs' versions: every change a cadet can see raises it, and a phone keeps the
record with the highest version. **updatedAt** is the latest of those changes' times. This is a refinement of the story's
"version equal to the projection's": with the cadet's version alone, a new Still Needed line would not make a newer record.

### Sealing to a channel: envelope v3, record kind 'C'

`sealToChannel({channelId, key, kind, plaintext})` / `openFromChannel(envelope, key, channelId?)` in `src/unit/envelope.ts`:

```
{ v: 3, ch, kind: 'view' | 'notice', z, nonce, ct }
```

* `ch` is the channel's address. There is no unit ID and no epoch in the header: nothing ties a channel record to its unit
  in public. The public fields are exactly `PUBLIC_CHANNEL_ENVELOPE_FIELDS`.
* AES-256-GCM under the channel key, deflated when the runtime can (`z`), 12-byte random nonce, the canonical header
  `{v, ch, kind, z}` as additional data: a record moved to another channel, relabelled or with a changed flag does not open.
* Same cap as a unit record: a serialized envelope over 60 KB is refused ("This record is too large to publish.").
* A record sealed to one cadet's key does not open under another cadet's key, the notices key or any unit epoch key; a v2
  unit envelope does not open under a channel key. v2 unit envelopes are unchanged.

On chain a channel record is an A.R.G.U.S. record of kind **'C'** (`src/chain/codec.ts`), paid to the channel address.
The unit transport reads only kind 'E' at the unit address, so a 'C' record found there (anyone can pay any address) is
skipped, and an 'E' record beside it in the same transaction is still read.

## What a cadet phone holds

Only, from its cadet ticket (mw-kmgi38.2):

* its own channel key and channel address;
* the unit's notices key and notices address;
* its cadet ID and display name, and its own device keys.

It holds **no** epoch key, no unit credential, no key grant and no other cadet's key. It polls two small addresses (one, its own channel, after mw-kmgi38.15) and can
open nothing else: not the unit log, not another cadet's record. Losing the phone exposes that one cadet's record and the
notices; Replace phone rotates the channel (new key, new address), and the old phone reads nothing new.

## Consequences

* Staff can read every channel key, as they can read every cadet's record already. A removed staff member who copied
  channel keys before removal could read those cadets' records until each channel is rotated; a unit key rotation does not
  rotate cadet channels.
* A signed credential carries the permission list it was made with. Credentials made before this change lack
  `cadets.admit` and `notices.send`: the unit creator's own Master device credential (`createMasterDevice`,
  `src/unit/vault.ts`), direct admissions and role changes. Members admitted by ticket (whose permissions follow
  `ROLE_PERMISSIONS` when the fold reads them) and devices set up or restored after this change have them. An existing
  unit's Master needs a fresh credential before it can make channels: done by story mw-kmgi38.11 (below).
* Channel addresses are new addresses on WhatsOnChain: a cadet phone reads two (one after mw-kmgi38.15), never the unit anchor, so 250 cadets add
  250 small readers, not 250 readers of the unit's history.

## Amendments

* **2026-10-03, story mw-kmgi38.2 (the cadet ticket).** A cadet's phone joins by a ticket, as staff do (ADR 012), but the ticket opens
  only the cadet's channel and the notices channel:
  * **The CADET package** (`CadetTicketPackage`, `src/private-sync/types.ts`, validated by `parseCadetTicketPackage`) is the TICKET
    record's variant `kind: 'CADET'` at the ticket address, sealed under the ticket's wrapping key exactly as ADR 012 says:
    `invitation {invitationVersion, ticketId, unitId, role: 'CADET', cadetId, displayName, issuedAt, expiresAt, ticketPublicKey, funding,
    returnAddress}`, `unit {unitId, unitName}`, `channelKey`, `channelAddress`, `noticesKey`, `noticesAddress`. No epoch key, no ticket
    ECDH key, no credential chain, no authority. The invitation is **not signed**: the wrapping key, which only the code gives, is its
    authenticity, the phone has no authority to check a signature against, and nothing the phone writes ever enters the unit's history.
    The phone does check that the ticket key is the code's and that each address is the one its key gives.
  * **Issuing** is `UnitRuntime.issueCadetTicket(cadetId)` (`cadets.admit`; a Supply Assistant is refused before anything is written or
    paid). It makes the cadet's channel and the unit's notices key when there are none, pays F (default `CADET_TICKET_SATOSHIS` = 500)
    and T as for a staff ticket, seals the code in the issuer's vault as `ticket:<ticketId>`, and records **CADET_TICKET_ISSUED**
    `{ticketId, cadetId, ticketAddress, channelAddress, issuedAt, expiresAt, funding}` (permission `cadets.admit`). The fold keeps it in
    `cadetTickets`, apart from staff `tickets`, so no unit key rotation ever wraps a key to a cadet ticket; it requires the cadet and a
    channel, a lifetime of at most a week, and a new ticket ID. `reissueCadetTicket(cadetId)` (Replace phone) rotates the channel with
    reason `Replace phone` and then issues.
  * **Redeeming** is `redeemCadetTicket(code, {passphrase, deviceLabel})` (`src/unit/cadetTicket.ts`). Transaction R spends F with the
    ticket key and carries one `'C'` record, a **CADET_JOINED** `{kind, joinedAt, deviceLabel}` sealed to the cadet's channel under
    the new channel record kind **'joined'**, with 1-satoshi markers to the ticket address and the channel address; the rest of the
    starter satoshis go back to the issuer's wallet (`returnAddress`). The phone needs no coins and gets no wallet. The network decides
    single use as in ADR 012; refusals use the same words (`TICKET_REFUSALS`). R is sealed in the phone's record before it is sent, so an
    unanswered broadcast is PENDING and `resumeCadetRedemption` resends the same bytes.
  * **The phone's record** is a separate vault entry, `argus.cadet.v1` (`src/unit/vault.ts`): PBKDF2 + AES-GCM like the device vault,
    holding a `check` text, the redemption in progress, and then the `CadetDevice` {cadetId, displayName, unit, channelKey,
    channelAddress, noticesKey, noticesAddress, joinedAt}. It has no signing key: nothing the phone writes is signed. Erasing the device
    removes it.
  * **Staff read a cadet's channel on demand**: `UnitRuntime.readCadetChannel(cadetId)` fetches that one address
    (`readChannelRecords`, `src/unit/channelReader.ts`) and returns the records that open and the latest CADET_JOINED;
    `cadetPhoneLine` gives the drawer's line, "Phone: joined <date>" or "No phone yet". After Replace phone the new channel is empty,
    so it reads "No phone yet" until the new phone joins.
  * Consequence: F, T and R are paid from or back to the issuer's wallet, which also pays unit records, so the chain links a ticket's
    address and, through R, the cadet's channel address to that wallet and so to the unit (publishing records to a channel from staff
    wallets, mw-kmgi38.3, would link it anyway). Only addresses are linked: names, codes and gear stay inside ciphertext.
  * Not in this story: cancelling or sweeping an unused cadet ticket (its code stays sealed on the issuer's device for that), and the
    gate telling a staff code from a cadet code (`readTicket` and `readCadetTicket` each refuse the other's code as damaged).
* **2026-10-03, story mw-kmgi38.3 (publishing the cadet's record).** Staff devices keep every cadet's channel current (`CadetPublisher`,
  `src/unit/cadetPublisher.ts`; no screens yet):
  * **What triggers it.** Every event this device itself commits (never one read from the chain, so a record is written by the device
    that made the change, not by every device) that names a cadet in its payload, or is about the cadet or Still Needed line, queues
    that cadet when they have a channel: issue, return, cadet update, Still Needed add/update/cancel/fulfil. Channel and
    ticket events do not (a new channel is filled by `publishAllCadetRecords`). A trailing 2 s debounce folds several changes for one
    cadet into one publish; the record is built from the fold when the timer fires, so it shows the latest state this device knows.
  * **One record, one transaction.** The cadet's CadetView is sealed (`sealToChannel`, kind `'view'`) and paid to the channel address
    by `prepareRecords([{ kind: 'C', ... }])` of the committing device's own wallet. A view whose sealed record is over `MAX_ENVELOPE_BYTES`
    (60 KB) is refused with "The record for <cadet name> is too large to publish" and dropped from the queue, not retried.
  * **Resumable.** The queue (cadet IDs only) is kept in storage under `argus.cadet-publish.v1.<unitId>`. A record the network does
    not take stays queued and is tried again after 30 s, on the next change, on the next `publishAllCadetRecords`, and when the runtime
    opens or starts. A transaction the wallet already built for the same cadet and version (an answer that never came) is finished,
    never built twice.
  * **`publishAllCadetRecords(onProgress?)`** (Master) queues every cadet with a channel and drains one transaction at a time, reporting
    `{done, total, failed}` after each.
  * **Reading.** `readCadetRecord(device, api)` reads the phone's own channel and returns the `view` record with the highest
    `version` (of equal versions the one the chain lists last). Two staff devices publishing for one cadet leave two records; the older
    view can come later on chain, and the reader still keeps the higher version.
* **2026-10-03, story mw-kmgi38.5 (staff send notices).** Staff with `notices.send` (Master, Instructor, Supply Officer) send a notice to every
  cadet or to one cadet (no screens for the cadet's side yet):
  * **NOTICE_SENT** `{noticeId, audience: 'all' | {cadetId}, text, sentBy, sentAt}` (permission `notices.send`) is recorded in the unit log, which
    cadets never read. The command is `sendNotice(audience, text)` on `ArgusReplica` and `DistributedAppController`: text is trimmed, 1-500
    characters (`MAX_NOTICE_LENGTH`); a notice to one cadet needs a cadet who has a channel ("This cadet has no phone yet"). The fold checks
    every payload again (author's permission, `sentBy` is the author, `noticeId` is the entity, the text, the audience, a cadet the unit has, a
    notice ID used once, a valid time) and keeps `notices` (`NoticeProjection`), shown newest first in the app projection. The Activity list
    says "Sent a notice to all cadets" and never shows the text.
  * **The sealed record** is a `'notice'` channel record `{noticeId, text, sentAt, from}` (`from` is the sender's display name), sealed to the
    notices channel (audience all) or to the cadet's channel (one cadet), in one transaction paid to that channel's address by the sending
    device's wallet. A key opens only its own channel's records: the notices key opens no cadet's record and a cadet's key not the notices.
  * **Through the publisher's queue.** `UnitRuntime.sendNotice` makes the notices key when the unit has none (for audience all), records
    NOTICE_SENT, queues the notice ID in the publisher (`argus.cadet-publish.v1.<unitId>.notices`; IDs only, the text is read from the unit
    log when it is published) and drains at once. A record the network does not take stays queued, is finished from the wallet and never
    built twice (correlation `notice:<noticeId>`), and is tried again after 30 s, on the next change and when the runtime opens. The command
    answers `{noticeId, published}`; `published: false` makes the app say the notice is saved and goes out when the network is reachable.
  * **Screens.** More, Notices (labels "Notices", "Notice to all cadets", "Send", "Sent notices"; a role without `notices.send` sees the list and
    no box) and, in the cadet drawer, "Message this cadet" (same text box; "This cadet has no phone yet" when the cadet has no channel).
    Toasts: "Notice sent", "Message sent to <cadet>".
* **2026-10-03, story mw-kmgi38.6 (cadets receive notices).** The cadet's poll (on open, when the tab is visible, every 5 minutes) also reads
  the notices: `readCadetNotices(device, api)` opens the `'notice'` records at the unit's notices address (key `noticesKey`) and at the cadet's
  own channel address (key `channelKey`), newest first, each notice ID once. A note to another cadet is at another address under another key and
  is never read.
  * **On the phone.** The notices it has read, `{noticeId, text, from, sentAt, readAt?}`, are sealed in the cadet vault record under the secret
    name `notices` (same passphrase protection as the rest; `loadCadetNotices`, `saveCadetNotices`), so the read state survives a reload and
    nothing of the text is readable in storage. A notice the phone keeps is never added again, so it is never announced again.
  * **Screens.** A Notices button in the cadet header with an unread badge; a banner at the top of My gear ("1 new notice" / "N new notices",
    tap opens Notices) while any are unread; the Notices screen ("Notices", "New", "No notices yet") newest first. Opening it marks all read.
  * **Device notification.** Each new notice goes once to `DeviceNotifier.notify` (title the unit name, body the text) while the app is open and
    notifications are allowed; Settings says where the permission stands and offers "Allow notifications" when the phone has not been asked.
    No Web Push: nothing is shown while the app is closed.
* **2026-10-03, story mw-kmgi38.15 (the shared-wifi fit; supersedes the shared notices address for reading and writing).** A cadet phone
  reads **one address, its own channel**: `readCadetChannel(device, api)` is one scan that returns the newest record and the notices; the poll
  is on open, when the tab is visible, on Refresh and every **25 minutes** (was 5). A notice to all cadets is **one sealed `'notice'` record
  per cadet in that cadet's own channel** (the shape of a note to one cadet), sent to every cadet who has a channel when it goes out; the
  unit's shared notices address is no longer written (`sendNotice` no longer makes the notices key; the ticket still carries the notices key
  and address, unused) and no longer read. A notice to all published before this change sits at the shared address and is not shown.
  Staff publishes of many records go **up to 25 records (and 90 KB) to a transaction**, with one 1-satoshi anchor output for each channel
  address in the transaction (`DeviceWallet.prepareRecords` takes `alsoAnchorAddresses`): `publishAllCadetRecords`, any drain of the cadet
  queue and a notice to all (250 records: 10 transactions). A note to one cadet and a single record stay one transaction. A notice that
  did not reach everyone stays queued with the addresses it has reached (`argus.cadet-publish.v1.<unitId>.notices.delivered`, addresses
  only) and a retry sends only the rest. Correlation of a notice's record is `notice:<noticeId>:<channelAddress>`.
* **2026-10-03, story mw-kmgi38.12 (a record goes out without waiting for a change).** Making a cadet's channel (issuing the cadet's ticket,
  `CADET_CHANNEL_CREATED`, `CADET_CHANNEL_ROTATED`, `CADET_TICKET_ISSUED`) queues that cadet, so the first record is published at once. Events that
  change cadets without naming one in the payload (annual rollover, roster import, a conflict resolved with new needs, a quantity correction)
  queue every cadet they changed, found by the cadets whose `appliedEventIds` include the event. A change that alters no cadet's record
  (a new cadet with no channel, stock events, calendar, bundles) queues nobody.
* **2026-10-03, story mw-kmgi38.11 (an existing Master gains the cadet permissions).** A credential carries the permission list it was made
  with, so a Master device made before `cadets.admit` and `notices.send` existed re-issues its own credential with the current
  `ROLE_PERMISSIONS` when it opens, and records it (the Activity line "has the current Master permissions"). Only a device holding the unit
  authority (the creator, or a device restored from a recovery file) can sign it, so a delegated Master is brought up to date the next time an
  authority device opens. This closes the "Consequences" item below about existing units.
* **2026-10-03, story mw-kmgi38.13 (the phone ticket from the cadet drawer).** The cadet drawer has a **Phone ticket** section: **Make phone
  ticket** (for `cadets.admit`) calls `issueCadetTicket`, which makes the cadet's channel when there is none, and shows the code and QR
  once, labelled with the cadet ID and never the name; afterwards the drawer says when and by whom the ticket was made. **Message this cadet**
  then sends. A ticket the network did not take is saved and goes out later.
* **2026-10-03, stories mw-kmgi38.7 and mw-kmgi38.8 (proof at scale).** 20 simulated staff phones issuing and returning at once converge to the
  same state (`docs/concurrency.md`), and the chain client backs off with jitter on HTTP 429. 250 cadets with channels each get their record
  and the notice to all published; each of 250 phones reads exactly its own record and its notices and opens no other cadet's (62,250
  cross-reads refused); a unit key rotation with 250 cadets stays one unit record, since cadets are never members (`src/unit/cadetScale.test.ts`).
  The test redeems 50 of the 250 tickets in full and builds the other 200 phones' records directly, to keep the run under 120 s.

## The design as built

* **What the epic delivered.** Per-cadet channels (a key and an address of their own); a ticket per cadet that gives a phone those keys and
  no unit key; staff phones that keep each cadet's record current (one record in one transaction, up to 25 records to a transaction when
  many go at once); cadet mode (**My gear**: **Have** and **Still needed**, **Notices**, **Settings**, **Leave this unit**, no unit screen);
  notices to all cadets and to one cadet, with an unread badge and banner and, while the app is open, a device notification.
* **Where a later story replaced an earlier one.** Notices to all were first one record at a shared notices address read by every cadet
  (mw-kmgi38.5, .6); mw-kmgi38.15 replaced that with one record per cadet channel, so a cadet phone reads one address, and the poll went from
  every 5 minutes to every **25 minutes**, on open, on return to the tab and on **Refresh**. The notices key and address are still in the
  cadet ticket and unused; the notices key is no longer made by `sendNotice` (`issueCadetTicket` still makes it).
* **Privacy as shipped.** A cadet phone holds its own channel key and address, the unit's (unused) notices key and address, its cadet ID
  and name, and no epoch key, credential, key grant or other cadet's key. Everything on chain is AES-GCM ciphertext; only addresses link a
  channel to the issuing staff wallet (see the mw-kmgi38.2 consequence). A removed staff member who copied channel keys can read those
  cadets' records until each channel is rotated.
* **Not built (known, for later).**
  * **A made code cannot be shown a second time.** (Replace phone and the drawer's phone line were later put on the cadet drawer, mw-kmgi38.16:
    **Replace phone** asks once and calls `reissueCadetTicket`; the line is `cadetPhoneLine` over `readCadetChannel`.)
  * **No cancel or sweep of an unused cadet ticket:** its starter satoshis stay at the ticket address, and `reissueCadetTicket` does not
    cancel the previous open ticket (it redeems only into the replaced channel, which staff no longer read).
  * **No Web Push.** A closed app shows nothing, since that needs a push server, which A.R.G.U.S. does not have. If Luke later wants a
    cadet's phone told while the app is closed, it is a decision for a later epic (a push service sees only that a notice exists, never its
    text, but it is a server, which this design avoids).
  * **A cadet phone remembers no transactions.** Each poll fetches every transaction at the cadet's address, so a poll costs 2 requests plus
    one per transaction there; the 0.33 requests a second of `docs/concurrency.md` counts only the scans. Remembering what was read is a
    story of its own.
  * **The last record is kept in memory only,** so a cadet who opens the app offline before the first read sees "Could not reach the
    network", not yesterday's record; the cadet Settings sheet has no Lock; a phone that joins late sees every earlier notice to all as new.
  * `issueCadetTicket` gets slower as the unit log grows (about 0.26 s a ticket at 250 cadets).
