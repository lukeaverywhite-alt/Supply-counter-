# Implementation status — 2026-09-26

Baseline reviewed: branch `work`, commit `65d020342339fcd1ceda02f8b7f096405424e540`,
clean working tree. The repository requires Node 24 or newer. The supplied environment used
Node 20 by default, so checks were run through Node 24 where noted.

## Requirement-to-evidence matrix

| Requirement | Status | Evidence |
| --- | --- | --- |
| A+B contribute 3; order independent; duplicates remain 6 | Implemented/tested | `countSessions.test.ts` shared-provider test |
| append-only correction 3→2; retry remains 5 | Implemented/tested | original observation and correction assertions |
| assignment recount does not double-count | Implemented/tested | superseded observation test |
| different organization/session/variant isolation | Implemented structurally; partial test | organization receive validation and assignment item keys |
| offline outbox survives replica restart | Implemented/tested | shared repository restart test |
| closure handles late offline contribution explicitly | Implemented/tested | late ID remains visible and blocks approval |
| reconciliation replaces physical stock exactly once | Implemented/tested | stock 10 becomes 3; second approval rejected |
| movement-aware baseline | Implemented | inventory version mismatch creates an open conflict |
| actual non-mock signatures | Implemented/tested | distinct non-exportable P-256 Web Crypto keys |
| durable encrypted on-chain payload and discovery | Externally blocked / not implemented | no wallet funding/credentials, ARC endpoint, index deployment, or chosen pinned BSV dependency |
| second/third enrolled client rebuild from testnet | BLOCKED / NOT RUN | depends on enrollment, chain publication, index, recovery keys |
| production student-data use | Deferred gate | requires privacy/legal review; testnet must remain synthetic |
| normal UI enrollment and count administration | Deferred | controller/UI still development composition; domain API is exposed |

## Development operation

1. Install Node 24 or newer.
2. Run `npm ci`.
3. Run `npm test`, `npm run lint`, `npm run build`, `npm run lint:css`, and
   `npm run relay:test`.
4. Run `npm run dev` only when an interactive development server is wanted.

GitHub Pages hosts only static client assets. It does not provide a wallet, transaction
broadcaster, overlay/index, relay, key recovery, or enrollment authority. Do not put wallet,
relay, root, or encryption secrets in `VITE_*` variables.

## Migration and rollback

Schema 9 adds `countSessions` with an empty default. Migration is additive, idempotent, and
does not reinterpret legacy absolute count events. Existing inventory, property, bundles,
events, and outboxes are retained. Before enrolling an organization, export and verify a
backup; older application builds do not understand schema 9 and should not write the upgraded
database. Rollback is therefore restore-from-backup, not a destructive downgrade.

## Next milestone

Implement pinned organization enrollment and encrypted-envelope composition using the real
identity provider, then select the smallest officially supported BSV testnet wallet/ARC/index
set after a dated dependency review. Only after deterministic adapter contracts pass should
an operator provide synthetic-testnet funding and execute the explicitly configured live
three-client recovery run.
