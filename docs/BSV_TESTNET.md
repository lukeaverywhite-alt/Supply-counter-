# BSV testnet research and Stage 2 result

## Result: NOT COMPLETED

No transaction was broadcast and no TXID was generated. The documentation browser was unavailable (HTTP 401) and direct access to official documentation was blocked by the environment proxy (HTTP 403). Package registry metadata was reachable on 2026-09-11 and identified the official `bsv-blockchain/ts-stack` repository, `@bsv/sdk` 2.6.0, `@bsv/wallet-toolbox` 2.13.0, and `@bsv/overlay` 2.3.1. Registry metadata alone is not enough to verify wallet funding, ARC endpoint configuration, testnet broadcaster behavior, or Merkle proof APIs safely, so no dependency or guessed adapter was added.

## Intended adapter boundary

A future `BsvTestnetProvider` should accept only a privacy-safe commitment containing protocol/version, event ID/type, opaque entity reference, SHA-256 event hash, timestamp, and public signer reference. It must use an externally controlled development wallet, an explicitly configured verified testnet ARC broadcaster, persist the returned real TXID, request/validate confirmation proof, and fail closed on network mismatch. It must never fall back to another endpoint or mainnet.

“Verified” must distinguish: signature/hash validation performed locally; transaction inclusion established from a Merkle path and header chain; and facts still trusted from ARC, wallet, overlay lookup, or header source. Merely receiving a TXID is not SPV verification.

CI remains MOCK-only. Testnet work requires a separately reviewed, manually invoked workflow and secure non-`VITE_` configuration. Mainnet configuration continues to throw before provider construction.
