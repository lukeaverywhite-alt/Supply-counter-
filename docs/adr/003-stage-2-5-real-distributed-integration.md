# ADR 003: Stage 2.5 real distributed integration

- **Status:** Accepted prototype boundary
- **Date:** 2026-09-11

1. **Actual UI?** Yes for issue, return and per-item count submission; remaining flows are deliberately unmigrated.
2. **Local authority?** Valid signed events plus schema-versioned IndexedDB projection; legacy inventory is genesis.
3. **Encryption?** Web Crypto AES-256-GCM with random nonce, authenticated metadata, SHA-256 ciphertext hash and sender signature.
4. **Epoch keys?** Non-extractable mock group keys behind `KeyDistributionService`; production wallet wrapping is unresolved.
5. **Enrollment?** Independent identity, signed credential, permitted epoch grants, encrypted-history download, validate/decrypt/replay/check.
6. **History location?** Local repository and replaceable encrypted-history providers.
7. **Provider plaintext?** No; interface receives ciphertext only. Metadata remains visible.
8. **Multiple providers?** Yes in deterministic proof.
9. **Failure?** At least one publish may succeed; otherwise durable local work stays queued.
10. **Months of recovery?** Full permitted history then future signed checkpoint; long-horizon performance remains unproven.
11. **BSV role?** Public integrity/timestamp anchor and possible discovery, never private state authority.
12. **On BSV?** Only allow-listed opaque organization/event/entity references, type, hash, timestamp and public signer reference.
13. **Real TESTNET?** No. No safe funded external wallet was present; no TXID was fabricated.
14. **Independent verification?** Local hashes/signatures only; no broadcast, confirmation, Merkle proof or header verification.
15. **Overlay?** Architectural admission/lookup design only; no real overlay ran.
16. **Always online?** At least one history/discovery provider for prompt convergence, plus wallet/broadcaster/proof/header sources for anchoring.
17. **Central CRUD database?** Avoided for migrated flows; providers transport opaque immutable events rather than authorize CRUD.
18. **Before Stage 3?** Finish encrypted sync wiring to the durable outbox, identity switching, multi-item count semantics and remaining UI flows.
19. **Before production?** Real crypto identity/custody, authenticated remote providers, ordering governance, checkpoints/backups, testnet/SPV and operations.
20. **Why no mainnet?** It is unnecessary, unfunded, unreviewed, and prohibited; network guards fail closed and no adapter exists.
