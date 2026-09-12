# Real-device shared synchronization acceptance test

Use fictional data only. Required: relay host, Device A, Device B, all on the same Wi-Fi (or a production HTTPS relay).

1. Back up existing test data. Generate one opaque organization ID, strong relay token, epoch key, and separate authorized test identities; do not save them in the repository.
2. On the host set the variables described in `relay/.env.example`. For LAN development bind `0.0.0.0`, run `npm run relay:dev`, allow the port through the private-network firewall, and record the host's LAN IP.
3. Configure each client with `VITE_ARGUS_SYNC_MODE=remote` and the public endpoint. A phone must use `http://HOST_LAN_IP:8787`, not `localhost`. Production/PWA testing requires HTTPS because browsers restrict secure features on non-local HTTP.
4. Import the same organization enrollment/epoch access on both devices, but use independent user identities. Confirm both report shared sync connected only after relay health succeeds.
5. On A create fictional inventory, a fictional cadet, and Still Needed; tap **Sync now**. Observe the exact projections on B without refreshing.
6. Issue property on A. Confirm B inventory, current property, transaction history, and requirement fulfillment. Return it on B and confirm A converges.
7. Edit a bundle on A; confirm B gets the immutable new version while an earlier issue retains its old version. Submit a count on B and confirm A.
8. Put A offline, make a confirmed change, close/reopen it, and verify it remains queued. Reconnect; confirm upload and B receipt with no duplicate.
9. With final stock `1`, take both offline and issue it independently. Reconnect both. Confirm stock never becomes negative, both signed events remain, and ACTION REQUIRED names an open conflict for an authorized resolver.
10. Stop/restart relay and verify history remains. Enroll a clean Device C at cursor zero and compare normalized inventory, cadets, bundles, Still Needed, and transactions with A/B.
11. Record browsers, versions, endpoint/TLS, times, screenshots, failures, and resolver result. Stage 3C is not complete until both directions, offline restart, conflict, and new-device recovery pass on physical devices.
