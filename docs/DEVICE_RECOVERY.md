# Device recovery

A new device creates or connects an independent wallet identity; a Master signs its credential; the device receives only permitted epoch keys through the future authenticated key-distribution adapter; it downloads encrypted history from one or more providers; validates, decrypts, verifies, deduplicates and replays; then compares signed checkpoints and public BSV commitments.

Stage 2.5 tests the encryption/provider/recovery building blocks with mock identities and complete authorized epoch history. Durable remote history, production credential discovery, key wrapping, retention governance and a full checkpoint implementation remain blockers. Copying a live IndexedDB file or a private signing key is not enrollment.
