# A.R.G.U.S.

**Asset Readiness & Gear Utility System** is a phone-first inventory and uniform-issuance application designed for Bethel Navy NJROTC supply operations.

This repository currently contains the first functional front-end prototype. It uses fictional demonstration records only; no uploaded roster names or unverified inventory quantities are included.

## Current prototype

- Installable PWA shell with an A.R.G.U.S. home-screen icon
- Fast physical counting with 1, 5, 10, and custom increments
- Persisted local draft counts that remain separate from official inventory until submission
- Functional local count submission, item creation, issue, return, and annual rollover actions
- Local audit events for every inventory-changing action
- Privacy-filtered, SHA-256 audit commitments with an offline mock blockchain provider
- Search by item name, category, size, or normalized CDMIS NIIN
- Inventory, cadet, activity, and administration views
- Fictional data for safe interface review
- Responsive phone, tablet, and desktop layouts

## Local development

```bash
npm install
npm run dev
```

## Checks

```bash
npm test
npm run test:coverage
npm run lint
npm run build
npm run test:deploy
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

Authentication, shared real-time counting, production roster imports, backend persistence, and authoritative audit storage require the planned backend phase. The current local prototype intentionally does not claim to provide those security guarantees.

## BSV integration status

**Current environment:** Development

- **Supported:** local mock blockchain provider, deterministic audit hashing, mock signing/verification, retry and duplicate protection
- **Not yet implemented:** real BSV testnet transactions (reserved for a separately verified Stage 2 adapter)
- **Not enabled:** BSV mainnet; selecting it causes an explicit startup error
- **Production funds:** never used

The mock provider makes no network requests and every simulated transaction ID starts with `MOCK_TX_`. A.R.G.U.S. continues to use off-chain local application state for fast inventory and roster queries. Read-only actions do not create audit transactions.

See [the BSV architecture](docs/BSV_ARCHITECTURE.md) and [security model](docs/SECURITY_MODEL.md) before changing network or signing behavior.

## Stage 2 distributed proof

Stage 2 adds permission-enforced mock identities and signed authority chains, append-only replica/event/outbox abstractions, IndexedDB and memory repositories, idempotent mock multi-client synchronization, explicit inventory conflicts, and correction events. It does **not** claim production key custody, encrypted private-history replication, an operational overlay, or a completed testnet transaction. See [the distributed architecture](docs/DISTRIBUTED_ARCHITECTURE.md), [offline sync](docs/OFFLINE_SYNC.md), [identity model](docs/IDENTITY_MODEL.md), and [testnet result](docs/BSV_TESTNET.md).

## Stage 2.5 distributed integration

The normal issue, return, and count-submit controls now use permission-checked signed events and a schema-versioned IndexedDB projection. A non-destructive, idempotent migration copies legacy inventory as genesis state. The Activity view separates local/private-sync and BSV-audit status.

## Stage 3A cadets, bundles, and readiness

Stage 3A adds signed, permission-checked cadet records, immutable editable bundle versions, exact idempotent factory presets, and lifecycle-preserving Still Needed requirements to the existing IndexedDB replica. Availability and readiness are derived from live projections; concurrent cadet or bundle edits become explicit reconciliation conflicts. See [the Stage 3A architecture](docs/STAGE_3A_CADETS_AND_BUNDLES.md) and [ADR 004](docs/adr/004-stage-3a-cadets-bundles.md).

Stage 2.5 also provides an AES-256-GCM private-envelope protocol, mock epoch rotation/key grants, untrusted private-history provider interfaces, redundant-provider recovery tests, and a fail-closed external testnet-wallet boundary. No real BSV transaction or overlay was run, no TXID exists, and mainnet remains impossible. See [Stage 2.5 architecture](docs/STAGE_2_5_ARCHITECTURE.md), [private encryption](docs/PRIVATE_EVENT_ENCRYPTION.md), [private sync](docs/PRIVATE_HISTORY_SYNC.md), [device recovery](docs/DEVICE_RECOVERY.md), [storage migration](docs/STORAGE_MIGRATION.md), and [dependency review](docs/BSV_DEPENDENCY_REVIEW.md).

## Stage 3A.5 consolidation

Operational screens now read one `ArgusAppProjection` backed by `RepositoryState`. Inventory creation and count submission use one authorized signed-event path; cadets, bundles, Still Needed, activity, conflicts, and integrity diagnostics come directly from repository projections. Legacy `AppData` remains migration input only. See [the consolidation guide](docs/STAGE_3A_5_CONSOLIDATION.md) and [ADR 005](docs/adr/005-stage-3a-5-application-consolidation.md).

## Stage 3B issue and return

Stage 3B adds atomic multi-SKU Issue and Return transactions, exact bundle mappings and snapshots, variant-safe property records, partial Issue/Still Needed integration, inactive-cadet returns, offline durability, and inventory-keyed conflict quarantine. See [the Stage 3B guide](docs/STAGE_3B_ISSUE_RETURN.md) and [ADR 006](docs/adr/006-stage-3b-issue-return.md).
