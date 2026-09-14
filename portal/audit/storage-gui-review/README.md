# Storage GUI implementation test report

Tested revision: `ab5433d`. The working tree was clean at the start. This audit
adds tests and evidence only; it does not fix or modify application behavior.

**Result: the existing upload pipeline works in local integration tests, but
the GUI-managed storage feature is not ready to call complete.**

## Findings

### 1. AWS setup accepts a role that does not enforce the external ID — high

`src/app/(app)/storage/connections-actions.ts:112` tests successful bucket access
with the correct external ID, then saves the connection. The credential provider
in `src/lib/storage/index.ts:39` only requests the role with that ID. Neither
layer tests rejection when the ID is omitted or incorrect.

The new controlled-cloud regression test simulates a role accepting every ID.
Setup incorrectly returns success and saves it. Four role credential requests
use the correct ID; none tests a negative case. A permissive customer trust
policy therefore bypasses the intended customer-binding safeguard. AWS explicitly
recommends testing assumption both with and without the correct external ID in
its [third-party access guidance](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html).

Required correction: reject roles that can be assumed without the required ID
or with an incorrect ID; distinguish authorization denial from transport errors.
This finding is reproduced with controlled cloud boundaries, not a live AWS
account or an attempted cross-customer exploit.

### 2. MinIO destination DNS is not bound to the validated address — high

The initial private-address checks pass. However, `src/lib/storage/ssrf.ts:21`
explicitly documents that DNS is not pinned. `src/lib/storage/index.ts:35`
constructs the SDK transport with only timeouts, and the saved-connection path
does not repeat endpoint address validation. A customer-controlled hostname can
resolve publicly at setup and later resolve to an internal address. There is
also a check-to-request DNS race during setup itself.

Required correction: validate the resolved addresses and bind each actual
server connection to those validated addresses, preserving TLS hostname checks
and redirect rejection. See OWASP's [SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).
This is a source-confirmed security gap; no requests to internal production
services or metadata endpoints were attempted.

### 3. Connection lifecycle controls are not wired into the GUI — medium

The database disconnect/reconnect operations work and pass tests. However,
`src/app/(app)/storage/page.tsx:50` renders destination rows only, and
`storage-config-row.tsx` provides test/default/pause/resume/remove actions.
The exported `disconnectStorageConnection` action has no GUI caller. There is
no credential-rotation or reconnect form and no connection audit-history view.

The browser found zero disconnect/rotate buttons. Pausing a destination does
not delete its stored credentials. Removing a GUI-managed destination also
encounters the connection's foreign-key reference. Users cannot perform the
promised connection lifecycle through the GUI.

### 4. Canceling or reloading AWS setup leaves an inaccessible draft — medium

`connect-storage-wizard.tsx:24` clears local state on Cancel but does not cancel
the database draft. The Storage page never lists pending connection rows.
The browser successfully started setup, received the external ID, canceled,
and reloaded; the draft was no longer visible. Reloading during setup similarly
loses the wizard's connection ID. The database caps pending drafts at 30, so
repeated abandoned attempts eventually block new AWS setup.

Required correction: expose pending setups for resume/cancel, and make Cancel
close the draft on the server. The test did not create 30 abandoned drafts;
the cap and lack of cleanup are confirmed in the migration and client code.

## Passing checks

| Check | Result |
| --- | --- |
| Portal lint, TypeScript and production build | Passed |
| Existing portal unit tests | 21 passed |
| Pi Python tests | 32 passed |
| Identity import shell cases | 5 passed |
| Voice-trigger Go race tests | Passed (3 tests) |
| Wi-Fi onboarding compilation | Passed; package has no Go tests |
| Existing database assertions | 140 passed |
| Capture-sync database assertions | 79 passed |
| New connection grants/RLS/lifecycle assertions | 22 passed; transaction rolled back |
| Real MinIO storage adapter tests | 11 passed |
| Real GUI-managed connection database/adapter integration | 6 passed |
| Production portal → Supabase → MinIO → Python queue | 8 grouped checks passed |
| Browser layouts | 8 scans: 320px/1440px, light/dark, Storage/Captures; no overflow or automated WCAG violations |
| Browser runtime errors | None |
| Focused GUI security audit | 3 checks passed, 1 failed (AWS external-ID enforcement) |

The full upload test verifies a failed transfer persists across a fresh uploader
process, then verifies the stored bytes, commits the receipt, and cleans up the
local file. It also checks upload pause does not interrupt heartbeat. The new
connection integration proves encrypted stored credentials can drive real MinIO
traffic and that disconnect removes credentials and blocks further resolution.

Additional browser checks cover AWS draft creation via the real server action
and MinIO's rejection of a local/private endpoint. The successful MinIO GUI
submission itself was not exercised against a public HTTPS MinIO host: the local
fixture is intentionally rejected by the GUI's private-address protection.
The existing successful browser connection tests use the legacy configured
account path. Do not interpret those as a complete successful new-wizard test.

No live customer AWS role, hosted migration/deployment, Pi systemd installation,
or physical camera/audio/light operation was exercised. The local fixture data
was removed or rolled back after testing. No cloud or encryption secrets appear
in these evidence files.

## Reproduce

From `portal/`:

```bash
npm run lint
npm test
npm run build
node tests/storage-gui-security.audit.mjs
# The audit command above currently exits 1 for the AWS finding.
node tests/storage-connections.integration.mjs
node tests/storage-minio.integration.mjs /path/to/private/minio.env
HARDHAT_BROWSER_MODULES=/path/to/browser-tooling \
  node tests/sync-local.integration.mjs /path/to/private/minio.env \
  tests/storage-gui-browser.audit.mjs
```

The existing connection integration expects its local MinIO fixture and the
configured encryption key. The browser tooling directory needs `playwright`
and `@axe-core/playwright`; the driver uses an installed Chrome browser.

From the repository root, after the existing isolated database suite:

```bash
bash portal/supabase/local-test/capture-sync-run.sh
docker exec -i hardhat_rls_test psql -X -U postgres \
  -d hardhat_capture_sync_test -v ON_ERROR_STOP=1 \
  < portal/supabase/local-test/storage-connections.sql
```

Evidence: [upload and browser results](capture-sync-results.json),
[security regression result](security-results.json),
[GUI lifecycle observation](gui-lifecycle.json).
