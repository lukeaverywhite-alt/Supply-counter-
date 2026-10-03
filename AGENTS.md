# AGENTS.md — working on A.R.G.U.S.

A.R.G.U.S. is the NJROTC Supply app. It is a **shared, encrypted supply ledger on the BSV testnet chain with no
server and no database**. Every person has their own keys on their own device; every change is a signed event,
encrypted and written to BSV testnet; every device rebuilds the same state from those records.

Read these before changing anything:

1. `docs/HANDOFF.md`: current state, how the pieces fit, what to build next. **Start here.**
2. `Docs/Master specification plan`: the product spec (the source of truth for features).
3. `docs/SPEC_COMPLIANCE.md`: where each spec section is implemented and tested, and what is still open.
4. `docs/BSV_SHARED_LEDGER.md`: the chain / encryption / key design.

## Commands (Node **24** is required: `package.json` engines `>=24`, `.nvmrc` = 24)

```bash
npm ci
npm run dev                 # app on http://localhost:5173/  (see "Modes" below)
npm run lint && npm run lint:css
npm test                    # full Vitest suite (jsdom); must stay green
npm run build               # tsc -b && vite build
npm run test:deploy         # smoke test of the built site under /argus/
ARGUS_TESTNET_DRY_RUN=1 npm run test:testnet   # full 3-device scenario on the in-memory chain
npm run test:testnet        # LIVE BSV testnet (needs outbound HTTPS to api.whatsonchain.com + a funded key; see HANDOFF)
```

If the machine's default Node is older than 24, run tools through Node 24, e.g.
`npx -y node@24 ./node_modules/vitest/vitest.mjs run`, `npx -y node@24 ./node_modules/typescript/bin/tsc -b`,
`npx -y node@24 ./node_modules/eslint/bin/eslint.js . --max-warnings=0`.

CI (`.github/workflows/ci.yml`) runs lint, CSS checks, tests with coverage, build and the deploy smoke test on every PR;
a push to `main` also **deploys GitHub Pages**. Before opening a PR, run the same commands locally.

## Modes

* `VITE_ARGUS_BLOCKCHAIN_MODE=mock-development`: single-device demo with a mock identity, no chain, data kept in the
  `argus-demo` IndexedDB. Fastest way to click around. Development only: it is refused in production builds.
* `embedded-testnet` (default, see `.env.example`): the real app. Onboarding (create a unit / join with a ticket / restore a unit), per-device
  wallet, records published to BSV testnet via WhatsOnChain. Works offline and catches up later.
* Mainnet does not exist in this build and must never be added without the §31 review (see spec).

## Hard rules

* **Testnet only.** Never add mainnet keys, addresses or endpoints. Never let an environment variable enable spending.
* **Never commit or print private keys, WIFs, passphrases or recovery files.** Keys never go in `VITE_*` variables.
  The live-test key lives outside the repo at `~/.config/argus/testnet-keys.json`.
* **Privacy boundary (spec §26).** Nothing identifying (cadet names, sizes, quantities, notes, member names) may appear
  outside AES-GCM ciphertext: not on chain, not in logs, not in plaintext storage. Cadets are shown by opaque cadet ID
  (`C-XXXX`); names are optional, encrypted, and only revealed on request.
* **Keep the fold deterministic.** Shared state is folded from events in `(Lamport clock, eventId)` order and must be
  byte-identical on every device, whatever order events arrive in. No `Date.now()`, randomness, device settings or
  sync status inside `applyEvent`. Derive conflict IDs only from already-folded events.
* **Never silently discard or rewrite history.** Corrections are new events; impossible outcomes become visible
  conflicts, never negative stock.
* **Every change needs tests**, in the existing Vitest + React Testing Library style, next to the code (`*.test.ts(x)`).
  Bug fixes get a regression test that fails without the fix. Never skip, disable or loosen a test to get green.
* Match the surrounding code style (dense one-line handlers in `replica.ts`, functional React components, plain-language
  UI text; users should never need blockchain vocabulary).

## Where things live

| Area | Files |
|---|---|
| Event types, projections | `src/distributed/types.ts` |
| Deterministic fold + commands | `src/distributed/replica.ts` (`ArgusReplica`) |
| App-facing API + projection | `src/distributed/appIntegration.ts` (`DistributedAppController`, `ArgusAppProjection`) |
| Per-record sync status | `src/distributed/delivery.ts` |
| Roles / credentials / revocations | `src/auth/authorization.ts` (`ROLE_PERMISSIONS`) |
| Device vault, ticket secrets, key rotation, recovery file | `src/unit/vault.ts` |
| Device runtime (wires everything, key reconcile, admit/revoke/changeRole) | `src/unit/runtime.ts` |
| Encrypted envelopes / local encrypted ledger / chain transport | `src/unit/envelope.ts`, `ledgerStore.ts`, `syncProvider.ts`, `transport.ts` |
| Ticket issue and redeem | `src/unit/runtime.ts` (issue, cancel), `src/unit/ticketRedemption.ts` (redeem), `src/identity/ticketCode.ts` |
| Onboarding screens, Tickets, Members & Wallet panels | `src/unit/screens/` |
| BSV testnet client, wallet, in-memory test chain | `src/chain/` (`woc.ts`, `wallet.ts`, `fakeChain.ts`) |
| Readiness, alerts, event/AMI/End-of-Year engines, inventory status | `src/stage3/` |
| Catalog, bundles, sizes, cadet codes | `src/stage3/domain.ts`, `src/stage3/sizes.ts` |
| Screens | `src/features/*` (dashboard, inventory, count, cadets, calendar, activity, conflicts, corrections, needs, admin, bundles) |
| Issue / Return workflow | `src/components/SupplyWorkflow.tsx` |
| App shell, tabs, Command Center panels, Settings | `src/App.tsx`, `src/settings.ts` |
| Device notifications (no server) | `src/notifications/`, `public/sw.js` |

## Adding a new shared event type (checklist)

1. Add it to `DistributedEventType` in `types.ts` (and any projection type/field).
2. `PERMISSION_FOR` entry in `replica.ts`, a command method that validates input and `commit()`s, and an `applyEvent`
   case that validates the payload again (events from other devices are untrusted) and is idempotent.
3. New projection state: default it in `src/storage/repository.ts` (`empty()` + `migrateRepositoryState`, bump
   `REPOSITORY_SCHEMA_VERSION`) and reset it in `rebuildOnce()`.
4. Controller wrapper in `appIntegration.ts`; describe it in `src/features/activity/activityModel.ts` (the switch is
   exhaustive, so TypeScript will tell you).
5. Tests: the command, rejection of bad payloads/permissions, and **convergence**: two replicas receiving the same
   events in different orders end byte-identical (see `src/distributed/convergence.test.ts`).
