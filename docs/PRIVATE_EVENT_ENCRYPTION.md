# Private event encryption

Stage 2.5 implements `EncryptedArgusEnvelope` with AES-256-GCM through Web Crypto. A fresh 96-bit nonce makes encryption randomized while `eventId` remains stable. The protocol header is authenticated as additional data. SHA-256 detects transport corruption before decrypt; the sender signs the header plus ciphertext hash. After authenticated decryption, clients validate the signed event schema and bind event, organization and sender metadata.

`MockEpochKeyDistribution` creates non-extractable `CryptoKey` values. It proves grants, revocation and rotation but deliberately does not persist/export raw keys. A production `KeyDistributionService` must wrap epoch material per authorized identity through a reviewed BRC-100/BRC-42/BRC-103-capable wallet exchange. No identity private key is exposed.

Revocation starts a new epoch. It prevents the revoked mock identity from receiving future keys; it cannot erase old keys or plaintext already obtained. Initial history policy is **complete organizational history for explicitly authorized epochs**: a Master may grant a new device every retained epoch or only selected epochs. Grants are explicit, never inferred from access to a provider.
