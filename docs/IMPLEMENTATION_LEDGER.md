# A.R.G.U.S. implementation ledger

Last updated: 2026-09-26. Baseline inspected: `109d568187f00d4980f2ff30552d22a2d0fae09b` on local branch `work`. No Git remote is configured in this checkout, so open/merged PR comparison and default-branch verification are externally blocked.

This ledger is deliberately an evidence record, not a claim that “FIX IT ALL” is complete. `VERIFIED LIVE` is reserved for an actual controlled environment; no production deployment, real student data, external identity service, or blockchain transaction was used.

## Requirement-to-evidence matrix

| Master stage / requested phase | State | Current evidence | Remaining acceptance criteria |
| --- | --- | --- | --- |
| Stage 3C / Phase A: ordinary restart must preserve immutable events | VERIFIED AUTOMATICALLY | `src/private-sync/runtime.ts`; IndexedDB restart regression in `src/private-sync/runtime.test.ts` | Run browser E2E against a real local relay, including multiple tabs and relay restart. |
| Stage 3C / Phase A: ambiguous delivery and immutable ciphertext | VERIFIED AUTOMATICALLY | Durable pending envelopes and delivery evidence in `src/private-sync/eventSyncProvider.ts` and `src/storage/repository.ts`; lost-ack test in `src/private-sync/eventSyncProvider.test.ts` | Add bounded backoff/timeouts, persisted pull cursors, leader election, and application-acceptance receipts. |
| Stage 3C / Phase A: reject cross-organization repository reuse | VERIFIED AUTOMATICALLY | Organization-bound migration marker and rejection test in `src/private-sync/runtime.test.ts` | Replace compatibility import with an explicit user-reviewed import UI and independently authorized provenance acceptance. |
| Stage 1 / Phase B: distinct durable identity, invitation, roles, revocation, recovery | IMPLEMENTED BUT UNWIRED | Authorization primitives exist under `src/auth`; operational runtime still creates development mock root/officer identities. | Persistent protected user/device identity, pinned root and signed invitation, credential/epoch lifecycle, recovery screens, and UI/direct-path tests. This is a production blocker. |
| Stage 4 / Phase C: shared physical count | IMPLEMENTED BUT UNWIRED | Shared count domain/controller tests exist under `src/distributed`; active UI still requires verification and draft persistence. | Replace legacy Count route, persist drafts/undo, complete late-work/movement UI, and browser acceptance scenarios. |
| Stages 3–4 / Phase D: cadets, imports, inventory, bundles, issue/return, corrections, rollover/tutorial | IMPLEMENTED BUT UNWIRED | Portions exist in `src/distributed`, `src/stage3`, and `src/components/SupplyWorkflow.tsx`. | Complete every authorized UI path; typed effective corrections; import/rollover/tutorial; concurrency and browser tests. |
| Stage 5 / Phase E: readiness and dashboard | NOT STARTED | Existing projection exposes limited readiness only. | Correct full-population readiness semantics first, then build and accessibility-test the specified dashboard/tree. |
| Stage 6 / Phase F: shared smart calendar and alerts | NOT STARTED | Permission names exist; no complete authoritative calendar/event/task projection. | Domain/events/repository/UI/offline convergence, templates, alerts, DST and browser tests. |
| Stage 7 / Phase G: audit architecture | EXTERNALLY BLOCKED | Existing ADR 009 and audit adapters are test/synthetic paths. | Owner privacy/chain decision, independent review, and live three-client recovery proof. Mainnet is not enabled or authorized. |
| Stages 1–7 / Phase H: backup/restore and production operations | NOT STARTED | Relay deployment notes exist but do not prove full-state recovery. | Encrypted validated backup/restore, clean-device reconstruction, quota/upgrade tests, monitoring/rollback, security review, and controlled pilot. |

## Phase A changes in this continuation

- Enrollment migration is now an atomic, repository-resident, organization-bound, versioned transition. Once recorded, normal startup does not re-sign events, rebuild the delivery queue, or clear prepared envelopes.
- A repository already bound to one organization fails safely rather than silently relabeling its history.
- Successfully delivered ciphertext is retained as immutable per-provider delivery evidence. A later retry therefore reuses the identical authenticated envelope rather than creating a relay collision.
- When publication has an ambiguous failure, the client performs an event lookup and accepts it only when the complete remote envelope exactly matches the locally prepared envelope.

## Verification record

- Required runtime: Node >=24. Available system runtime was Node 20.20.2; checks were therefore invoked with ephemeral Node 24 via `npx node@24` where recorded.
- Focused Phase A regression: 15 tests passed across runtime, encrypted provider, and private sync suites.
- Full release matrix remains to be run after the remaining implementation phases. A passing existing suite must not be interpreted as production readiness.

## Continuation order

1. Finish Phase A real-relay restart/multi-tab/cursor/backoff/status work.
2. Replace mock operational enrollment with durable distinct identities and signed authority enrollment (Phase B).
3. Wire shared counting end-to-end before expanding daily workflows (Phases C/D).
4. Correct readiness before dashboard/calendar (Phases E/F).
5. Reconcile audit architecture and implement recovery/operations (Phases G/H).

## Release classification

**Development-only.** The restart collision repair is reviewable and automatically covered, but enrollment authority, complete UI workflows, recovery, live operational proof, and independent security review remain required before a controlled pilot or production review.
