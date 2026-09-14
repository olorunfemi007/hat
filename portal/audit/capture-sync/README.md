# Capture sync verification — 2026-09-13

The production portal build passed a local end-to-end test against Supabase and
MinIO, including the real Python queue CLI. See
[machine-readable results](../capture-sync-results.json).

Verified: untested destinations blocked; signed upload and byte verification;
stable receipts; conflicting manifests and overwrites rejected; hardware identity
enforced; upload pause independent of heartbeat; destination pinning; failed
transfer persisted across worker restart; cleanup only after verification.

The browser pass covered connection creation/testing/default/pause/resume, site
assignment persistence, device upload pause/resume, and capture status. Captures
and Storage passed automated WCAG A/AA checks at 320px and 1440px in light/dark
mode, with no horizontal overflow or JavaScript runtime errors. A contrast issue
in the verified badge was fixed before the passing run. These are automated
checks, not a comprehensive accessibility certification.

Other checks passed during implementation:

- 140 existing and 79 new database assertions.
- 32 Python tests, five identity-import shell cases, and three Go race tests.
- 21 portal unit tests and 11 real MinIO adapter checks.
- Portal lint, TypeScript/production build, shell syntax, and diff whitespace.

Screenshots contain disposable test fixtures only. The runner removed its test
organization, devices, and bucket afterward. No hosted migration, customer cloud
connection, Pi installation, or physical recording was performed by these tests.

Run instructions: [Capture and storage setup](../../../CAPTURE_SYNC.md).
