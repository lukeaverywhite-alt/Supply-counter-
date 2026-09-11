# BSV dependency review (Stage 2.5)

Verified 2026-09-11 from npm registry metadata after the documentation browser returned HTTP 401. Every listed package identifies the maintained official [`bsv-blockchain/ts-stack`](https://github.com/bsv-blockchain/ts-stack) repository. Registry metadata verifies provenance/version, **not** a funded wallet or live endpoint.

| Package | Version | Need / support decision | Browser / Node boundary | Network, testnet, security |
|---|---:|---|---|---|
| `@bsv/sdk` | 2.6.0 | Candidate transaction, BEEF and MerklePath primitives; not installed until a wallet path is exercised. | Core TypeScript SDK is intended to support browser use; individual broadcasters still require network access. | Supports BSV transaction primitives; network selection and trusted broadcaster/header sources remain application responsibilities. Never holds a key in Vite config. |
| `@bsv/wallet-toolbox` | 2.13.0 | BRC-100 wallet/storage/signer implementation candidate; not installed. | Server/toolbox and storage integrations are Node-oriented and must not enter the PWA bundle. | A separately controlled TESTNET wallet needs custody, funding, ARC configuration and review. |
| `@bsv/wallet-toolbox-client` | 2.13.0 | Browser-safe BRC-100 client candidate; not installed because no external wallet endpoint exists here. | Client boundary is suitable for browser; the wallet remains external. | Authenticated wallet transport is required; a client is not secret storage. |
| `@bsv/overlay` | 2.3.1 | Overlay engine candidate for `tm_argus_audit_v1`; not installed. | Node/provider infrastructure, separate from Vite. | Public topic admission must accept only privacy-safe commitments. |
| `@bsv/overlay-express` | 2.6.1 | HTTP host for a future overlay; not installed. | Node/Express only. | Requires an online hardened service; it is not business authority. |
| `@bsv/overlay-discovery-services` | 2.2.1 | Future discovery; not installed. | Provider-side Node service. | Availability and metadata disclosure require review. |
| `@bsv/overlay-topics` | 1.7.1 | Reference topic-manager patterns; not installed. | Provider-side. | No generic topic was assumed to enforce A.R.G.U.S. rules. |
| `@bsv/gasp` | 1.3.6 | Graph-aware overlay synchronization candidate; not installed. | Provider infrastructure. | Does not itself encrypt private history or establish authorization. |

BRC-42 derived keys and BRC-103 mutual authentication remain candidates for production key wrapping/authenticated device enrollment. BRC-62 BEEF and BRC-74 Merkle paths are the candidate proof containers. No API was guessed and the dependency surface remains zero in Stage 2.5.
