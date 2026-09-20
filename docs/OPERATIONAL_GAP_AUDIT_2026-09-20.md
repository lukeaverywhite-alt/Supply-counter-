# Operational gap audit — 2026-09-20

## Verified baseline

The reviewed starting commit was `a3b927e1e94c95a45f3ddeb81d57e4e34abb7db9`. No Git remote is configured in this checkout, so current `origin/main`, pull requests 27–29, and merge compatibility could not be fetched or independently verified. The supplied branch already contains the merge commits for PRs 28 and 29 in its local history.

The repository requires Node 24 or newer. The container default is Node 20.20.2; baseline Vitest failed before collecting tests because current jsdom/undici cannot run on that version. Checks executed through `npx node@24` use Node 24.21.0.

## Acceptance-gate status

Items 1–3 of the operational acceptance gate are **not complete**, and A.R.G.U.S. must not be represented as operationally ready:

* The normal React controller still constructs deterministic mock identity and synchronization providers. The real encrypted HTTP relay path is tested separately, but is not selected by the application runtime.
* There is no trusted account/session service, invitation acceptance service, device registry, durable authority distribution, or production key custody. A relay bearer token is only relay access; it is not a user account or authorization decision.
* The relay stores opaque ciphertext and therefore cannot enforce encrypted inventory business rules. Authorization must be verified by enrolled clients, and a future trusted account/key service must govern membership and revocation.
* Simultaneous final-unit issue behavior has repository conflict coverage, but the required independently authenticated browser-context gate and operator conflict-resolution workflow are incomplete.

The correct next implementation action is to add the trusted account/enrollment service and wire a configuration-selected operational controller to `PrivateSyncEngine`; operational mode must fail closed until that enrollment exists. Mock mode should remain an explicit demo/test selection.

## Completed defect closure in this milestone

Physical-count submissions now carry a caller-generated unique session identifier and an optional, trimmed note through the UI, controller, signed event, repository history, and privacy-filtered local audit projection. Blank session identifiers and notes over 500 characters are rejected atomically. Still Needed projections exposed to the UI now include only open and partially fulfilled requirements, keeping summary counts from including fulfilled or cancelled work.

## Security and offline limits

No secrets belong in `VITE_*` values because those values are public browser assets. Development epoch enrollment currently stores exportable AES material in browser storage and is explicitly unsuitable for production. A disconnected client cannot learn of revocation; pending events must be revalidated after reconnect by an authority-aware participant, and rejected work must remain visible rather than being discarded.

## Manual verification still pending

No physical phone/computer run was performed in this container. On a real phone and computer, verify installation, offline navigation, count draft retention, reconnection, update behavior, touch targets, narrow-screen overflow, keyboard focus, and screen-reader dialog naming. Multi-device shared-data testing remains pending until the normal runtime and real account/enrollment service are connected.
