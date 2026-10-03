# ADR 012: Admission by invitation ticket

**Status:** accepted for implementation, 2026-10-02 (story mw-3evcnk.1 of epic mw-3evcnk). Supersedes ADR 011 once the
ticket screens land (D7).

## Context

Today the **new device goes first**: it makes its identity, ECDH and wallet keys and shows a JOIN code
(`src/unit/vault.ts` `encodeJoinRequest`); the Master's `admitMember` signs a credential for that one device and wraps
one KEY_GRANT per unit key generation to its ECDH key; the Master hands back an ADMIT code or the ADR 011 QR, which the
new device opens with `acceptAdmission`, and posts ADMISSION_CONFIRMED. Two failures Luke hit on 2026-10-02 come
straight from that shape:

* the admission QR cannot be prepared once a unit has two or more key generations: the package passes the QR library's
  2,953-byte limit (`src/unit/admissionQr.ts`);
* a pasted admit code is refused as not valid when a messenger inserts whitespace (`src/identity/codes.ts` regex).

Underneath both is a round trip that needs the Master's phone twice, and codes too long to type. Nothing enforces single
use or expiry. Luke chose the lasting fix: a short, one-use ticket the Master makes first, that the new device redeems on
its own from the chain.

## Decisions (Luke's, recorded verbatim)

Decisions on this rig are Luke's. All of these were given in the Governor's talk `d4826bc0-b12d-47ae-b0a9-5b0d524bf7e5`
on 2026-10-02, with Luke at the keyboard, and are recorded on the map bead mw-jb2p5.5 and the epic mw-3evcnk. Luke's
words are in quotes; the sentence after each is the recorded decision.

* **D0** (turn 6, "two"): straight to the lasting fix, no quick fix (plan 0063 stays held, unfiled).
* **D1** (turn 7, "yes"): each ticket is for one named person, with their role chosen, and works once.
* **D2** (turn 9, "one"): a ticket travels both ways, a QR to scan and a short code to text or read out.
* **D3** (turn 10, "a week sounds good"): a ticket dies on its own after one week.
* **D4** (turn 11, "one"): Instructors may make tickets for cadet roles (SUPPLY_OFFICER, SUPPLY_ASSISTANT); MASTER and
  INSTRUCTOR tickets only a Master makes.
* **D5** (turn 12, "one"): the cadet finishes joining on their own with the ticket, even while the Master's phone is off.
* **D6** (turn 13, "one"): the issuer sees the tickets out and unused, with name, role and days left, and can cancel one.
* **D7** (turn 14, "one"): the ticket REPLACES the old admission QR and the long paste code; every new device joins by
  ticket.

The go-ahead was turn 16, "all right yes execute". The design sketch in the epic is the Mayor's recommendation, not a
decision; this ADR keeps its shape and says where and why it differs (see *Where this differs from the sketch*).

## Summary

A ticket is a 128-bit random secret. From it, anyone holding the code derives a one-use **ticket key** (secp256k1), the
ticket's testnet **address** (that key's P2PKH address) and a **wrapping key** (AES-256-GCM). The issuer funds the
ticket address with the new member's starter satoshis and writes an encrypted **TICKET** record there: a signed
invitation (unit, name, role, expiry, ticket key, the funding outpoint), the unit's keys and the issuer's credential
chain. The new device types or scans the code, reads that record from WhatsOnChain with no wallet, checks it, and
redeems by **spending the funding output** in one transaction that carries an encrypted **TICKET_REDEEMED** record
(signed by the ticket key, binding the device's own keys) and its TICKET_REDEEMED fact for the unit's history. Because
an output can be spent only once, the network itself decides single use: a second redemption, or a redemption racing a
cancellation, is refused as a double spend. Cancelling (and sweeping an expired ticket) is the issuer spending the same
output with a **TICKET_CANCELLED** record.

## The protocol

### Secret size and derivation

* **Secret:** 16 bytes (128 bits) from `crypto.getRandomValues` (`makeTicketSecret`, `src/identity/ticketCode.ts`).
* **Code:** the secret in Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, the one cadet codes use,
  `src/stage3/domain.ts`), 26 data characters (130 bits, the last two always zero), then a 4-character check group, in
  six groups of five joined by hyphens: 35 characters, e.g. `4K7QD-Z2M9X-0B8RT-WC5HN-1EY6P-G3VJA`.
  * Check group: the first character is the weighted sum mod 32 of the 26 data values with odd weights `2i+1`, so
    **every** single changed data character is caught; the other three are 15 bits of
    `SHA-256("ARGUS-TICKET-CHECK-1:" + data characters)`, so random damage passes about once in a million.
  * Reading (`decodeTicketCode`): strip all whitespace and hyphens, fold case, fold O to 0 and I and L to 1. Refusals
    name the fault (`TicketCodeError.fault`): `NOT_A_TICKET_CODE` (empty, more than one character outside the
    alphabet, or far too long: another code, a link, prose), `PART_MISSING` (fewer than 30 characters), and
    `CHARACTER_WRONG` (one character outside the alphabet, one extra character, a failed check group, or nonzero
    spare bits).
  * The QR carries the same text (story 4 may wrap it in the app's own link); the code alone is the whole ticket.
* **Derivation:** HKDF-SHA-256 with IKM = the 16-byte secret and salt = UTF-8 `ARGUS-TICKET-1`:
  * info `ticket-key` gives 32 bytes, read big-endian as the secp256k1 private scalar of the **ticket key**; if it is 0
    or not below the curve order, derive again with info `ticket-key/1`, `ticket-key/2`, ... (odds about 2^-128).
  * info `ticket-wrap` gives the 32-byte AES-256-GCM **wrapping key** for every record at the ticket address.
  * The ticket key's public identity is `k1:` + its 33-byte compressed public key in hex; its signatures are
    `k1sig:` + base64url DER of `PrivateKey.sign(canonical JSON, 'utf8')` from `@bsv/sdk` (SHA-256, low S), verified
    with `PublicKey.verify`.
* **Why 128 bits, and no stretching:** the ticket address is public, so anyone can test guesses offline against it.
  At 128 bits that is hopeless with no key stretching, so derivation is instant on a phone. The sketch's other option
  (80 bits stretched by the existing 600,000-iteration PBKDF2) gives about 100 bits of work, costs a second or two
  of phone time on every redemption, and saves only 10 characters. 128 bits still fits the 40-character limit (35).

### The ticket address

The testnet P2PKH address of the ticket key (`PrivateKey.toAddress('testnet')`): the code alone leads to it, and nobody
without the code can link it to the unit. Every record about one ticket lives there:

| Transaction | Paid by | Spends | Outputs |
|---|---|---|---|
| **F** funding | issuer's wallet | issuer's coins | `satoshis` (default 2,000, `DEFAULT_MEMBER_TOP_UP_SATOSHIS`) to the ticket address: the **funding outpoint**; change |
| **T** ticket | issuer's wallet | issuer's coins | `'T'` TICKET record; 1 sat to the ticket address; change |
| **R** redemption | the funding outpoint itself | F:vout, signed by the ticket key | `'T'` TICKET_REDEEMED record and 1 sat to the ticket address; `'E'` envelope (the TICKET_REDEEMED fact) and 1 sat to the unit anchor; change to the new device's wallet |
| **C** cancel or sweep | the funding outpoint itself | F:vout, signed by the ticket key held by the issuer | `'T'` TICKET_CANCELLED record and 1 sat to the ticket address; change to the issuer's wallet |

F comes before T because the signed invitation inside T names F's outpoint. T may spend F's change unconfirmed. The
1-sat outputs make every transaction about the ticket show up in the address's history whatever the indexer lists.
`'T'` is a new record kind for `src/chain/codec.ts` (today `'E'` and `'G'`), added by story 2. The unused
`keyGrantAnchorAddress` (`src/blockchain/anchor.ts`) is not needed.

### The records and what each carries

Types are in `src/private-sync/types.ts`, structural validators in `src/private-sync/schema.ts`.

**On chain at the ticket address** (`TicketChainRecord`): the `'T'` payload is canonical JSON `{ v: 1, nonce, ct }`
and nothing else (`TICKET_CHAIN_RECORD_FIELDS`). `ct` is AES-256-GCM under the wrapping key, with a 12-byte nonce and
additional data canonical `{ v: 1, address: <ticket address> }`, so a record cannot be replayed at another ticket. The
plaintext is one of three, told apart by `kind`:

* **TICKET** (`TicketPackage`, written once by the issuer in T):
  * `invitation` (`TicketInvitation`, signed by the issuer): `ticketId` (`t-` + 20 hex), `unitId`, `displayName` (the
    named person, D1), `role`, `issuedAt`, `expiresAt` (at most 7 days later, D3, `TICKET_LIFETIME_MS`),
    `ticketPublicKey`, `funding` `{ txid, vout, satoshis }`, `issuedBy`, `signature`;
  * `issuerDisplayName`; `issuerCredentials`, the issuer's credential chain up to the unit authority (empty when
    the authority itself signed);
  * `unit` `{ unitId, unitName, authorityIdentity }`, `currentEpoch`, `epochKeys` (every unit key generation the
    issuer holds, raw base64url);
  * `ticketEcdhPrivateKey`: a random P-256 ECDH private key (JWK) the issuer made for this ticket (see *How members
    admitted by ticket get later rotations*).
* **TICKET_REDEEMED** (`TicketRedemption`, written by the new device in R, signed by the ticket key): `ticketId`,
  `unitId`, `subjectPublicIdentity` (the device's own P-256 signing identity), `ecdhPublicKey`, `walletAddress`,
  `redeemedAt`, `signature`.
* **TICKET_CANCELLED** (`TicketCancellation`, written by the issuer in C, signed by the issuer): `ticketId`,
  `unitId`, `reason` (`CANCELLED` by a person, or `EXPIRED` for a sweep), `cancelledAt`, `issuedBy`, `signature`.

**In the unit's own encrypted history** (event payloads under the unit key; none carries the secret, the code, the
wrapping key or a ticket private key, and the validators copy only known fields):

* **TICKET_ISSUED** (`TicketIssuedFact`, by the issuer after F): `ticketId`, `ticketAddress`, `ticketEcdhPublicKey`,
  `displayName`, `role`, `issuedAt`, `expiresAt`, `funding`. It feeds the open-tickets list (D6) and tells every
  Master which tickets are open.
* **TICKET_CANCELLED** (`TicketCancelledFact`, by the issuer after C is accepted): `ticketId`, `reason`,
  `cancelledAt`, `spendTxid`.
* **TICKET_REDEEMED** (`TicketRedeemedFact`, by the new device, inside R itself): `ticketId`, the signed
  `invitation`, `issuerCredentials`, the signed `redemption`. It is the new member's admission: it makes them a
  member on every device (see the verifier below).

These are additions; no existing event or record shape changes. Story 2 adds the three facts to
`DistributedEventType` following the AGENTS.md checklist.

### Who signs what

| Object | Signed by |
|---|---|
| Invitation, MASTER role | the unit authority key only (as `admitMember` and `AuthorizationService` require today) |
| Invitation, INSTRUCTOR role | the unit authority key, or a delegated Master's own signing key backed by its authority-signed MASTER credential |
| Invitation, SUPPLY_OFFICER or SUPPLY_ASSISTANT | as above, or an Instructor's own signing key backed by its INSTRUCTOR credential (D4) |
| Transactions F and T | the issuer's wallet key |
| Redemption record, and R's input | the ticket key |
| TICKET_REDEEMED fact (an ordinary event) | the new device's own signing key |
| Cancellation record | the issuer, with the same key that signed the invitation |
| C's input | the ticket key, which only the issuer's device kept (sealed in its vault as `ticket:<ticketId>` until the funding outpoint is spent) |
| TICKET_ISSUED and TICKET_CANCELLED facts | the issuer's device signing key, as every event |

The issuer never touches the new member's keys: the member's signing, ECDH and wallet keys are made on their own device
(the master specification, *Root Authority*: "The master authority should not need possession of another user's private key."). The ticket key is a
one-use bearer key belonging to the ticket, not to the member.

D4 needs no new permission. INSTRUCTOR has no `users.authorize` today, and adding one would change existing credentials.
The rule lives in the ticket verifier instead: an INSTRUCTOR credential may sign a cadet-role invitation, nothing else.
An Instructor's unit keys are imported non-extractable (`unlockDevice` makes only a Master's extractable), so story 2
reads the raw keys from the sealed vault secrets (`vaultKey` is in memory while unlocked) when an Instructor issues.

### How a verifier accepts the authority -> ticket -> device chain

Every device folds a TICKET_REDEEMED fact, whose event actor is A, like this (story 3; deterministic, no clock, no
network inside the fold):

1. `parseTicketRedeemedFact` passes: the invitation, redemption and fact name the same ticket and unit, and the
   invitation lives no longer than a week. `A` equals `redemption.subjectPublicIdentity`.
2. **Link 1, authority -> ticket.** The invitation's signature verifies under `invitation.issuedBy`. The issuer may
   issue that role at `invitation.issuedAt`: the unit authority for any role; for INSTRUCTOR and the cadet roles, a
   MASTER credential issued by the authority; for the cadet roles only, an INSTRUCTOR credential whose own chain is
   valid as today. The credential is the one in `issuerCredentials`, checked against the pinned authority like
   `acceptAdmission` does, or one the fold already holds. It must be active at `issuedAt`, with no revocation
   effective at or before `redemption.redeemedAt`, so **removing an issuer kills their open tickets**.
3. **Link 2, ticket -> device.** The redemption's signature verifies under `invitation.ticketPublicKey` (secp256k1),
   and `invitation.issuedAt <= redemption.redeemedAt < invitation.expiresAt`.
4. **Once.** No earlier TICKET_REDEEMED or TICKET_CANCELLED fact for this `ticketId` in fold order. Before the fold
   sees anything, the provider passes on a TICKET_REDEEMED envelope only from a transaction that spends
   `invitation.funding` (see single use). A fact that fails is a visible refused record, never a silent drop.
5. Then the device is an ACTIVE member: credential id `ticketId`, role and permissions `ROLE_PERMISSIONS[role]` from
   the invitation, `displayName` from the invitation, `ecdhPublicKey` and `walletAddress` from the redemption,
   `admittedBy` the issuer, activated at `redeemedAt`. One fact does both what AUTHORITY_GRANTED and
   ADMISSION_CONFIRMED do today: INVITED -> ACTIVE happens at once. Revocation and role change work as today against
   credential id `ticketId` (a MASTER-role member only by the authority).

The new device verifies the same way before it redeems, on the TICKET it decrypted: link 1, expiry, and the funding
outpoint still unspent.

### How single use is decided when two devices redeem one ticket

**By the network.** Redemption R spends the one funding outpoint named in the signed invitation, and a transaction
output can be spent only once. When two devices redeem one ticket, the first R the network accepts wins.
WhatsOnChain answers the second broadcast with `conflict` (`BroadcastOutcome`: input already spent). That device
then reads the spender from the ticket address's history and says, in words, which happened: "This ticket has
already been used" or "This ticket was cancelled". A redemption racing a cancellation, or the issuer's expiry sweep,
is decided the same way.

The unit-history side is tied to the same spend. The TICKET_REDEEMED fact travels in R itself, and providers accept
that fact only from a transaction spending `invitation.funding`. A loser's fact therefore never reaches anyone, and a
code holder cannot publish a fact on its own to claim a ticket someone else redeemed. The fold's first-fact-wins rule
(step 4 above) is only a deterministic backstop.

This is the one place where a provider looks at the inputs of the transaction that carried an envelope. The inputs
are a chain fact, the same for every device reading that transaction, so the fold stays deterministic. It still
needs no clock, no network and no sync status.

Remaining risk: the network's choice is final at the first confirmation. Before that, two miners that first saw
different redemptions could, in principle, mine the one WhatsOnChain did not report. That needs two redemptions
within seconds of each other, which in practice means a leaked code (see below). The device whose R vanishes is told
by the existing lost-transaction check (`LOST_AFTER_SCANS`).

### How expiry is checked without a trusted clock

No single clock is trusted. Four checks overlap:

1. **The redeeming device** refuses when the later of its own clock and the time of the newest block on the chain is
   at or after `expiresAt`. A phone with its clock set back gains nothing, because the chain's time is not its to
   set. A phone clock that runs fast only refuses early. Story 3 adds a block-time read beside
   `ChainApi.tipHeight()`.
2. **Verifiers** check the signed claim `issuedAt <= redeemedAt < expiresAt` (step 3 above), and invitations longer
   than a week are refused structurally. No clock is used in the fold.
3. **The issuer's device sweeps.** When it next runs, it spends the funding outpoint of every expired, unspent ticket
   it issued (transaction C, reason `EXPIRED`). After the sweep the network refuses any redemption whatever anyone's
   clock says, and the starter satoshis go back to the issuer.
4. **Display** ("days left", "expired" in the D6 list) uses the viewer's clock, for display only.

Only someone who holds the code and deliberately ignores check 1 can redeem late, and only until the sweep. That is
the leaked-ticket case below.

### What the new device can do before its REDEEMED record is funded and on chain

R is paid for by the funding output, so **the new device never needs satoshis of its own to join**. Its change from
R becomes its wallet's first coins. "Before it is funded and on chain" therefore means before the network has
accepted R:

1. The device reads code -> address -> TICKET with no wallet and no keys of its own (WhatsOnChain reads are free).
   It verifies link 1, expiry and that the funding outpoint is unspent. Then it shows the unit name, the issuer's
   name, the person's name and the role, and asks to join. If T is not on chain yet (the issuer's wallet is unfunded
   or offline), it says the ticket is not on the network yet and to ask the issuer to open A.R.G.U.S. online.
2. On "Join", it makes its own keys and passphrase vault, reads the unit's history with the ticket's unit keys so its
   fact's Lamport clock follows everything it has seen, and builds and signs R. It persists R's signed bytes before
   broadcasting (the wallet's exactly-once rule) and seals the decrypted TICKET plaintext under its new passphrase,
   so a restart resumes.
3. **Until R is accepted**, the device is PENDING: it shows "Joining…", writes nothing, shows nothing of the unit,
   and does not install the unit keys as its own. An ambiguous broadcast rebroadcasts the same bytes. A `conflict`
   gives the refusal words, and the sealed TICKET plaintext is deleted; nothing ever reached its replica, so nothing
   is discarded from history.
4. **Once R is accepted**, it installs the unit keys, takes the invitation's role, and inserts its own
   TICKET_REDEEMED envelope as delivered from chain. It is ACTIVE on its own, with the Master's phone off (D5).

### How members admitted by ticket get later rotations

* **After the redemption is folded:** the member is ACTIVE with an `ecdhPublicKey`, so every later
  `rotateUnitKey` wraps the new key to them exactly as it does for anyone admitted today (`src/unit/runtime.ts`).
* **Between issue and redemption** (the gap): a rotation made while a ticket is open would leave the redeemed member
  unable to read records under that key generation. The replica refuses a second UNIT_KEY_ROTATED for the same
  generation, so nobody could hand it over later. The ticket therefore has its own random P-256 ECDH keypair: the
  public half is in TICKET_ISSUED (`ticketEcdhPublicKey`), the private half in the TICKET plaintext. A Master
  rotating while tickets are open adds one KEY_GRANT per open ticket, with `granteePublicIdentity` = `ticket:<ticketId>`,
  using the existing `wrapEpochKeyForGrant`. This is the same pattern as the unit recovery key
  (`recoveryGranteeIdentity`). The redeemed device keeps the ticket ECDH key sealed in its vault and opens such grants
  in `installGrantedKeys`, as a restored Master opens grants to the recovery key. Masters stop wrapping to a ticket
  once it is redeemed, cancelled or expired.

## Threat notes

### A leaked ticket before use

Whoever holds the code is the bearer. They can read every record written under the unit keys in the TICKET, and they
can redeem first and become the named member with the named role. Limits:

* The role is fixed by the issuer's signature, so a leaked cadet ticket never makes a Master.
* It works once. The real person's redemption is then refused with "already used", which is the alarm.
* It dies within a week, or at once when the issuer cancels it (C spends the funding output; that is final).
* The issuer revokes the impostor like any member (credential id `ticketId`), which rotates the unit key.

Advice for the screens: show a ticket only to its person, and cancel any ticket that went somewhere unexpected.

### A leaked ticket after use

It cannot be redeemed again. The funding output is spent, the network refuses a second spend, and providers accept a
TICKET_REDEEMED fact only from the transaction that spent it. A code holder cannot oust or duplicate the member, even
with a forged, backdated fact, because the fold never receives one. The code still decrypts the TICKET record, which
stays on chain forever. So it opens the unit keys the issuer held at issue time, and any grants made to the ticket
while it was open. That is history the member could read anyway, but a stranger now can too. The rotation below
bounds it: nothing written after the next rotation is readable with an old code.

### A cancelled ticket

Cancelling is the issuer's device spending the funding output with a signed TICKET_CANCELLED record (C). After that,
every redemption is refused by the network ("This ticket was cancelled"), and the starter satoshis return to the
issuer. A cancellation racing a redemption is decided by which spend the network accepts first: the issuer sees
"already used" or the device sees "cancelled", never both.

Only the issuing device can cancel, because only it kept the ticket key. Another Master can wait out the week, or
revoke the member if the ticket was used. The code of a cancelled ticket still opens the TICKET record, so the
exposure is the same as for a leak after use, and the same rotation applies.

### The ticket secret's exposure to all current epoch keys, and whether a rotation follows a redemption

The TICKET record carries every unit key generation the issuer holds. A code is therefore a permanent key to the
unit's history up to its issue, plus anything granted to the ticket while it was open. Old codes must be treated like
old admission packages: as sensitive as the unit key itself. They can never be un-published.

**Yes, a rotation follows.** When a Master's device sees that the current unit key went into a ticket that is now
closed (redeemed, cancelled or expired), it rotates once, batching every ticket closed since the last rotation. It
uses the existing UNIT_KEY_ROTATED event with reason `MANUAL`, so no event shape changes. This happens at the
Master's next opportunity, not as part of joining (D5). Redeemed members receive the new key like everyone else.
Codes stop opening anything written afterwards. Instructors cannot rotate today, so for an Instructor's ticket this
waits for a Master device.

## Where this differs from the sketch, and why

* **Single use and cancellation are decided by spending one funding output, not by looking for earlier REDEEMED or
  CANCEL records.** Records at an address are only ordered once mined, and anyone with the code can write them. A
  record-based rule would let a leaked-after-use code backdate a REDEEMED record and take the member's place. A spent
  output cannot be spent twice, and the network refuses the loser at once. As a result, the issuer funds the ticket
  (the old top-up moves from the admitting moment to the ticket), and only the issuing device can cancel.
* **The invitation names the funding outpoint**, so funding (F) and the TICKET record (T) are two transactions.
* **The ticket key is secp256k1 via `@bsv/sdk`, not P-256.** WebCrypto cannot turn a secret into a P-256 key
  deterministically: it imports private keys only with their public point, and nothing in the app computes P-256
  points. `@bsv/sdk` is already a dependency, makes a secp256k1 key from 32 bytes, signs, and gives the P2PKH
  address directly, which is the address that must hold and spend the funding output anyway.
* **The unit keys travel raw inside the TICKET ciphertext rather than as KEY_GRANT records.** There is no P-256
  grantee key to wrap them to. Encrypting them under the wrapping key is the same protection.
* **A random ticket ECDH keypair rides in the TICKET** so rotations during the gap reach the ticket (a fact of the
  code: a key generation cannot be re-announced).
* **The TICKET_REDEEMED fact travels inside the redemption transaction**, so the unit's history accepts only the
  redemption that won the output.
* **128-bit secret, no stretching** (see derivation).

## Consequences

* The code is 35 characters, always, whatever the unit's size. The QR is small, so the 2,953-byte failure cannot
  recur. The admit-code whitespace failure cannot recur either, because readers strip all whitespace.
* The Master's phone is needed once, to issue. The new device joins alone (D5) and needs no satoshis of its own.
* Open tickets hold the issuer's satoshis until redeemed, cancelled or swept.
* Stories: **2** issues and cancels (F, T, C, the three facts, the `'T'` record kind, the sealed ticket key, the
  open-tickets list in the replica); **3** redeems and verifies (R, the verifier above, the provider's
  spend-of-funding rule, the expiry checks, the ticket grantee in rotations); **4** builds the screens and removes the
  JOIN code, ADMIT code and admission QR (D7). Until story 4 lands, ADR 011 still describes the shipped admission.
* Code in this story: `src/identity/ticketCode.ts` (secret, code, decode with named faults) and the ticket types and
  validators in `src/private-sync/types.ts` and `schema.ts`.

## Amendments

* **2026-10-02, story mw-3evcnk.2 (issuing).** Four clarifications, none of which changes a protocol shape:
  * The issuer's vault seals the ticket **code** (the 35-character text) as `ticket:<ticketId>`, not the derived ticket key. The key
    is derived from it on demand, and the issuer can show the code again until the ticket is closed. It is dropped once the funding
    output is spent.
  * A ticket cannot be made by a wallet that cannot pay for it. The invitation names the funding outpoint, so transaction F must exist
    before the invitation can be signed, and F needs coins. `issueTicket` therefore refuses with the wallet's own "needs funding" error
    (the starter satoshis plus a 50-satoshi fee reserve) and leaves nothing behind. Once F and T are built they sit in the wallet's
    durable queue together with the TICKET_ISSUED fact in the unit's outbox, and an unreachable network or a wallet that runs dry
    afterwards only delays them (the existing sync banner shows it); nothing is lost.
  * Until story 3 adds the verifier, the unit fold applies a TICKET_REDEEMED fact only to close the ticket in the list (it must agree
    with the ticket as issued and be written by the device it names). It creates no member and checks no signature.
  * Cancelling is `cancelTicket(ticketId, reason)`: the fact TICKET_CANCELLED is written only after the network accepted transaction C,
    as above. With no network the signed C waits in the wallet queue and a second call finishes it; it is never built twice.
