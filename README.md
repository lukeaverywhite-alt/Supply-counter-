# A.R.G.U.S.

**Asset Readiness & Gear Utility System** is a phone-first inventory and uniform-issuance application designed for Bethel Navy NJROTC supply operations.

This repository, [Jonathan-A-White/argus](https://github.com/Jonathan-A-White/argus), is a fork of [lukeaverywhite-alt/Supply-counter-](https://github.com/lukeaverywhite-alt/Supply-counter-), live at <https://jonathan-a-white.github.io/argus/>.

This repository currently contains the first functional front-end prototype. It uses fictional demonstration records only; no uploaded roster names or unverified inventory quantities are included.

## What it does now

- **One shared, encrypted data pool on BSV testnet — no server, no database.** Every change is a signed event, encrypted with the unit key and written to BSV testnet; every device reads everyone's records back from the chain and computes identical state. See [the shared ledger design](docs/BSV_SHARED_LEDGER.md) and try it with [the two-phone demo](docs/demo-shared-count.md).
- **Each person has their own key.** The first device creates the unit and becomes its Master; everyone else joins with a one-use ticket that a Master (or an Instructor, for cadet roles) makes for them, shown as a QR and a short code. No key is ever copied between people.
- **Shared counting:** A counts 3 PT Shorts, B counts 3 PT Shorts → every device shows 6. An officer finalizes the count and on-hand becomes 6 everywhere.
- **Zeroed catalog, real sizes:** a new unit starts with the 25 items from the master specification's bundles at zero on hand and no sizes; staff add sizes from Supply Manual presets (34R, 7 1/4, S–3XL…) or custom labels.
- **Cadets by ID:** cadets are shown as short IDs (e.g. `C-4F7K`); names are optional, encrypted, and revealed only on tap.
- Issue/return with gender-aware bundles and per-line sizes, Still Needed tracking, receive stock, append-only corrections, visible conflict resolution, activity log with signature verification, offline queueing.
- **Home dashboard** with the readiness tree and actionable alerts, a **supply calendar** (NCO, BLT, AMI, Military Ball, End-of-Year templates with preparation tasks), **roster import** by cadet ID and **annual rollover**.
- **Optional device notifications** for critical alerts and deadlines under 24 hours while A.R.G.U.S. is open or in a background tab — generic wording, rate-limited, no server. A fully closed app gets only a best-effort check (installed Chrome/Edge apps). See [device notifications](docs/DEVICE_NOTIFICATIONS.md).

## Cadet role

A cadet can have a phone of their own that shows **what they have and what they still need**, and nothing else. Try it with [the cadets demo](docs/demo-argus-cadets.md); the design is [ADR 013](docs/adr/013-cadet-channels.md).

- **How a cadet joins.** Staff (a Master, Instructor or Supply Officer) open the cadet in **Cadets** and tap **Make phone ticket**. The cadet's phone joins with that one-use ticket (**I have a ticket**) and opens on **My gear**: **Have**, **Still needed**, and **Notices**. A cadet is never a member of the unit.
- **What a cadet phone holds.** Only the keys to that one cadet's own small sealed record (a channel of their own), the cadet's ID and name, and the phone's own device keys. It reads one address, its own channel, when the app opens, when the tab comes back and every 25 minutes (and at once on **Refresh**).
- **What a cadet phone cannot read.** The unit's log, any other cadet's record, any member, any count, any stock: it holds no unit key, so there is nothing to read them with. Losing a cadet's phone exposes that one cadet's record and notices; **Leave this unit** erases it from the phone, and a replaced phone gets a new channel (the code exists; a button for it is not on a screen yet).
- **Where notices go.** Staff with the notices permission send a notice to **all cadets** (**More**, **Notices**) or a note to one cadet (**Message this cadet** in the cadet's drawer). Each reaches a cadet as a sealed record in that cadet's own channel, so one cadet's note is unreadable to every other phone. Staff publish up to 25 records to a transaction, so a notice to 250 cadets is 10 transactions.
- **Later epic: push when the app is closed.** A cadet sees a notice, with a badge, a banner and (if allowed) a device notification, only while A.R.G.U.S. is open. Telling a closed app needs a push server, which A.R.G.U.S. deliberately does not have; whether to add one is a decision for a later epic.
- Proved with a test of 250 cadet phones that each read exactly their own record and no other ([the measured poll](docs/concurrency.md)), and of 20 staff phones writing at once.

## Local development

```bash
npm install
npm run dev                                           # real app: BSV testnet via WhatsOnChain
VITE_ARGUS_BLOCKCHAIN_MODE=mock-development npm run dev   # single-device demo, no network
```

## Checks

```bash
npm test                 # all unit/integration tests (in-memory fake chain; no network)
npm run test:coverage
npm run lint && npm run lint:css
npm run build
npm run test:deploy
npm run testnet:keys     # once: create a testnet key outside the repo and print its address to fund
npm run test:testnet     # LIVE: two admitted members, 3 + 3 = 6 on BSV testnet, fresh-device rebuild
```

## GitHub Pages deployment

The `Verify and deploy A.R.G.U.S.` workflow verifies and publishes the app whenever changes reach the `main` branch. It can also be started manually from the repository's **Actions** tab.

GitHub does not permit a workflow's built-in `GITHUB_TOKEN` to enable Pages on a repository where Pages has never been configured. For the first deployment, either open **Settings → Pages** and set **Source** to **GitHub Actions**, or create a fine-grained personal access token with **Administration: write** and **Pages: write** access to this repository and save it as the repository Actions secret `PAGES_TOKEN`. The workflow uses that secret to enable Pages automatically; after the site exists, its built-in token handles normal deployments.

The workflow then:

1. installs the locked dependencies with `npm ci` on Node.js 24;
2. runs the test and lint suites;
3. creates a production build;
4. serves that build from a simulated repository subdirectory and verifies every deployment asset; and
5. publishes the verified `dist` directory to GitHub Pages.

The build uses relative asset paths so the installed app, manifest, icon, and service worker work from the repository's GitHub Pages subdirectory as well as a future custom domain.

## Product boundary

Testnet only; mainnet is impossible in this build. Live testnet operation depends on WhatsOnChain's public API for discovery and broadcast. SPV inclusion proofs are not built yet. Notifications for a fully closed app would need a push server, which A.R.G.U.S. deliberately does not have ([why](docs/DEVICE_NOTIFICATIONS.md#why-a-closed-app-cannot-be-notified-reliably)). Encrypted records on a public chain are permanent; obtain school/command approval before entering real cadet data. See [known limits](docs/BSV_SHARED_LEDGER.md#known-limits-and-open-decisions) and [ADR 010](docs/adr/010-bsv-shared-ledger.md). For where every section of the master specification stands, see [spec compliance](docs/SPEC_COMPLIANCE.md). Contributors and coding agents: start with [AGENTS.md](AGENTS.md) and [the handoff](docs/HANDOFF.md).
