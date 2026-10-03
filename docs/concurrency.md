# Many phones at once: request budget and shared wifi

Every device talks to the BSV testnet through WhatsOnChain (WoC). WoC allows about **3 requests per second per IP address**
without an API key. Phones on the same wifi share one address, so for them the limit is shared too. This page states what one
device costs, what a whole unit costs, and what the chain client does when WoC says "slow down".

The numbers below are measured, not guessed: `src/unit/manyDevices.test.ts` runs 20 devices (one Master and 19 Supply
Officers) on one in-memory chain and asserts them. If the code changes and a number moves, that test fails and this page needs
the new figure. `src/unit/cadetScale.test.ts` does the same for 250 cadet phones (below).

## What one device costs

| What the device does | Requests to the chain API |
|---|---|
| A sync with nothing new anywhere (the steady state) | **2** per scan: 1 confirmed-history page, 1 mempool-history list |
| A sync that publishes one command | **5**: 1 broadcast and 2 scans (the scan runs again after the publish) |
| Reading a transaction another device published | **1** per transaction, once (the hex is fetched, then the transaction is remembered) |
| Anything else in steady state (coin lookups, block height) | 0 |

So the per-device budget is **2 requests per scan at steady state**, plus 1 request for every new transaction from someone else.
A scan with no new transactions never fetches a transaction. A busy minute is dominated by the third row, not the first.

Measured with the 20-device test: 100 commands (5 per device, issues and returns, spread over 10 cadets) went out in 100
transactions; every one of the 19 other devices fetched each of them exactly once (1,900 fetches), and all the scans came to
about 390 more requests. That is **about 24 requests per command for a 20-device unit** (19 fetches plus about 2 scans per device
shared out), and it grows with the number of devices because every device reads every transaction.

A single phone is never the problem: the client spaces its own requests 350 ms apart (at most about 2.9 a second from one device).

## Cadence

* **Staff devices** scan every **15 s** (`ChainTransport.start`, default `intervalMs`), and again at once when the app comes to
  the front or the phone comes back online, or when a command is queued.
* **Cadet devices** read **one address, their own channel**, and nothing else: once when the cadet opens the app, again when the
  tab becomes visible, on **Refresh**, and then every **25 minutes** (`CADET_POLL_MS`, `src/cadet/CadetPoller.ts`). One poll is one
  scan of that address (`readCadetChannel`): the newest gear record and the notices both come out of it. A notice to all cadets is
  not read from a shared address; staff seal one copy into each cadet's own channel (below), so a phone never reads the unit's
  shared notices address. (A notice sent to all cadets before this change sits at that shared address and is not shown.)

## The shared-wifi math (one IP, about 3 requests per second)

20 staff and 250 cadets on the same wifi, nothing being issued:

| Group | Calculation | Requests per second |
|---|---|---|
| 20 staff at 15 s | 20 × 2 ÷ 15 | 2.67 |
| 250 cadets at 25 min | 250 × 2 ÷ 1500 | 0.33 |
| **Total, idle** | | **3.0** (at the limit, about 100 %) |

So on one shared address the cadences **just fit, and no more**: there is no room left, and an issue day (every staff phone fetching
every new transaction, below) still goes over it, so it still needs the 429 backoff described further down. The 0.33 counts the two
requests of a scan. A phone does not remember the transactions it has already read, so each poll also fetches every transaction
already at the cadet's address (1 each): a cadet with a gear record and one notice costs 4 requests a poll (measured in
`src/unit/notices.test.ts`), not 2, and the figure grows with the cadet's records. Other ways to make room, each by itself:

* Put the 20 staff phones on mobile data: each phone then has its own address and its own 3 per second. Only the 250 cadets
  share the wifi (0.33 per second, far inside the limit).
* Let staff scan only every 30 seconds (20 × 2 ÷ 30 = 1.33 per second).
* Use a WoC API key (the client already accepts extra headers) for a higher limit.

### 250 cadet phones, measured (`src/unit/cadetScale.test.ts`)

One Master, 250 cadets, 250 phones, one in-memory chain. The test publishes every cadet's record, sends one notice to all and one
note to cadet 17, then makes every phone poll once. What a **cadet poll** costs, per phone, as asserted:

| What | Requests |
|---|---|
| The scan of the phone's one address (confirmed history, mempool list) | **2** |
| One fetch for each transaction at that address (its record, the notice to all, its redemption if it came through the chain, a note to it) | **2 to 4** |
| **One poll** | **4 to 6** (4 for a phone with a record and a notice, 6 at most, for cadet 17 with all four) |
| Anything outside the phone's own address | **0** |

So the cadet's share of the shared-wifi table is **250 phones × 1 address × 1 poll per 25 minutes**: 0.33 requests a second for the
two scan requests alone, and about **0.67 a second** with the 2 fetches of a phone that has a record and a notice (250 × 4 ÷ 1500;
1.0 if every phone had 4 fetches), since no phone remembers what it has read. Each phone reads exactly its own record and the notices
sealed in its own channel; the same test opens every other cadet's newest record with every phone's key (62,250 attempts) and none
opens. A unit key rotation with 250 cadets present is one record whose grants are only the staff: cadets are outside the rotation.

Activity makes it worse, not better. Every transaction costs every reading device one fetch. With all 270 devices reading
everything, one new transaction costs 269 fetches, so a shared 3 per second allows only about 3 ÷ 269 ≈ 0.011 transactions per
second (**about 40 transactions an hour**) even with no polling at all. With the 20 staff alone on the address it is
19 fetches per transaction: after the 2.67 per second of polling, the 0.33 per second left allows about one transaction a minute.
During a busy issue day a shared address will be rate-limited, so the client has to cope with it (below).

Levers outside this page's scope: scan less often when a scan was limited, let a cadet phone remember the transactions it has read,
mobile data or a key for staff.

## Several records in one transaction

A transaction carries up to **25 records** (`MAX_RECORDS_PER_TX`) and up to 90 KB of them. Staff devices already batch:

* Issue and return events (and every other synced command) queued together go out up to 25 to a transaction
  (`ChainTransport.publishOnce`, `src/unit/transport.ts`).
* **Cadet records** published by a staff device (`CadetPublisher`, `src/unit/cadetPublisher.ts`) batch the same way, one anchor
  output in the transaction for each cadet's address so each cadet's address lists it: `publishAllCadetRecords` and any drain of the
  queue (a rollover, an import), and **a notice to all cadets**, which is one sealed record per cadet in that cadet's own channel.
* Still one record to a transaction: a note to **one** cadet, and a single cadet's record published on its own.

What a notice to all or a publish-all of 250 cadets costs:

| What | Cost |
|---|---|
| The staff device publishes 250 records | **10 transactions** of 25 records (250 anchor satoshis and the network fee: measured **354 satoshis** for one notice to 250 cadets on `FakeChain`) |
| The 250 cadet phones read it | **250 fetches of one transaction each**, one more request in each phone's next poll (it fetches only what is at its own address), spread over the 25 minutes, so about 0.17 per second |
| Staff devices reading the 10 transactions | 10 fetches per staff device, once: the same as any other new transactions |

A failed batch does not send the records already delivered again: the notice stays queued with the addresses it has reached, and
a retry sends only the rest.


## When WoC answers 429

`src/chain/woc.ts` (`WhatsOnChainApi.get`) retries a limited read instead of failing the scan:

* The wait starts at 500 ms and doubles each time, up to 8 s, and **random jitter of up to the same amount is added** to every wait
  (so a wait is between 1× and 2× its base). Without jitter, phones that were limited together would come back together and
  be limited again.
* A 429 is retried up to **6 attempts** (5 waits: about 0.5, 1, 2, 4 and 8 s before jitter). Other server errors and rejected
  requests are retried up to 3 attempts, as before.
* If it still fails, the scan fails and the transport tries again on its next tick. Nothing is lost: queued records stay queued,
  a transaction already broadcast is not sent again, and a missed scan does not make the device think its transaction was lost
  (that needs three successful scans that do not see it, over at least a minute).
* Broadcasts are never retried by the client: re-sending after an unclear answer is the wallet's decision.

One limit to know about: WoC's 429 reply carries no CORS header, so **a browser sees a failed request, not a 429**. The client
cannot tell the two apart and applies the 3-attempt limit with the same doubling and jitter. The 6-attempt patience applies where
the status is visible (a key, or a proxy that adds the header).
