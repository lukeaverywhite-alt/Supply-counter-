# BSV testnet research and Stage 2.5 result

## Result: NOT COMPLETED

No transaction was broadcast and no TXID was generated. On 2026-09-11 the web documentation tool returned HTTP 401. Live npm registry metadata verified that the official maintained source is `bsv-blockchain/ts-stack` and the versions recorded in `BSV_DEPENDENCY_REVIEW.md`; it did not provide a funded external BRC-100 wallet, verified TESTNET ARC configuration, or independent header/proof source. Guessing or embedding a wallet secret would violate the security boundary.

Stage 2.5 adds `ArgusWalletAdapter`, an explicitly non-operational testnet adapter, public commitment shape, verification levels, and a testnet-only assertion. Mainnet has no adapter and fails closed. Exact manual completion path:

1. provision a separately controlled, test-only BRC-100 wallet outside the Vite process and fund it with TESTNET coins;
2. implement/review the adapter against the exact installed `@bsv/sdk`/wallet client API and an explicitly verified TESTNET ARC endpoint;
3. use fictional `argus-test-*` and `item-test-001` references and the allow-listed commitment only;
4. create and broadcast exactly one transaction, persist its returned TXID and BEEF separately from private history;
5. label it `TX_BROADCAST`, not confirmed;
6. obtain a Merkle path, validate it locally against the transaction, and validate the containing header against an independently governed header chain before advancing to `MERKLE_PROOF_VERIFIED`;
7. record which broadcaster, proof source and header source remain remotely trusted.

BRC-62 BEEF can package transaction ancestry and BRC-74 MerklePath/BUMP represents inclusion paths. Local path calculation is not full SPV without a trusted/validated header chain. No manually invoked spending workflow was added because there are no secrets or wallet endpoint to supply it safely.
