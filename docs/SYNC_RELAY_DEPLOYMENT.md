# A.R.G.U.S. sync relay deployment

The relay stores opaque encrypted envelopes; it has no cadet, inventory, property, or Still Needed tables and no decryption keys. GitHub Pages hosts only the client. Deploy the relay separately on Node.js 24 with durable disk.

## Development

Copy `relay/.env.example` values into the host environment, generate a random `org_...` identifier and at least 128-bit random token, then run `npm run relay:dev`. The default bind address is loopback. For a same-Wi-Fi test set `ARGUS_RELAY_HOST=0.0.0.0`; use the computer's LAN IP from the phone because `localhost` on the phone means the phone. Keep authentication enabled and do not expose this HTTP development listener publicly.

## Production operations

Terminate TLS at a maintained reverse proxy/load balancer and expose HTTPS only. Set an exact comma-separated origin allowlist; wildcard credentialed CORS is unsupported. Store `ARGUS_ORGANIZATIONS` and enrollment material in the service secret manager, never Git, logs, Pages, or Vite variables. The API caps envelopes at 256 KiB, pages at 200, applies a per-process request limit, validates protocol/transport fields, and returns structured codes.

Mount `/data` persistently when using `relay/Dockerfile`. The initial small-organization store is an atomically replaced, mode-0600 JSON event file; run only one relay process per file. Stop writes briefly or snapshot the volume consistently for backup, encrypt backups operationally, and test restore by starting a second instance against the restored file and replaying from cursor zero. Envelopes remain application-encrypted in backups. Monitor `/health`, disk, 401/409/413/429 rates, and backup age; do not log request bodies or authorization headers.

Before updates: back up, test the new image against a restored copy, drain traffic, stop the old process, migrate/start once, verify `/health`, then resume. The atomic event file persists restarts. Database loss can be repaired only if retained authorized clients can republish; audit commitments do not reconstruct private ciphertext, so relay backup is essential.
