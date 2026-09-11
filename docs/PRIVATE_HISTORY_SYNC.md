# Private history synchronization

`PrivateHistoryProvider` exposes publish, cursor pull and event lookup over encrypted envelopes only. `MockPrivateHistoryProvider` can fail, duplicate and reorder responses. `MultiPrivateHistoryProvider` writes to all configured providers, succeeds when at least one accepts, reads all available providers, deduplicates by event ID, and rejects providers that disagree on ciphertext hashes.

Providers are untrusted availability/storage infrastructure. They cannot decrypt through the interface. Clients validate envelope schema/version, ciphertext hash, AEAD tag, sender envelope signature, inner event schema/signature, credential authorization, organization, event ID, base version and idempotency before projection. A provider outage never reverses a local operation; its durable outbox remains pending.

The mock proof demonstrates recovery from Provider B when Provider A is unavailable. It does not claim an operating remote provider, authentication, retention SLA or automatic cursor failover. Encrypted backup may contain envelopes, public credentials, checkpoint and sync metadata, but excludes signing keys by default.
