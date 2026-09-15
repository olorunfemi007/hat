# Storage GUI fixes and verification

The four findings in the [original review](../storage-gui-review/README.md) are
addressed. This report supersedes its unresolved status.

## Changes

- AWS enrollment and credential replacement require successful assumption with
  the correct external ID and explicit authorization denials for both missing
  and incorrect IDs. A network failure cannot satisfy either negative test.
- Every GUI-managed MinIO operation validates DNS and pins its HTTP(S) socket
  lookup to the validated addresses. The URL hostname is preserved for TLS
  certificate verification. A later operation resolves and validates again.
  Only exact, deployment-approved private origins are exceptions to the public
  address requirement; customer form fields cannot add an exception.
- Storage accounts expose credential replacement, disconnect, reconnect and
  recent audit history. Credentials are tested before replacement; unsuccessful
  tests preserve the existing connection. Disconnect removes stored credentials.
  Reconnect retains the original destination ID and pending captures.
- Pending AWS setups are listed and resumable after reload. Finish later keeps
  the draft; Cancel setup closes it transactionally, advances its revision,
  writes an audit event and releases its pending-setup slot. Stale submissions
  cannot resurrect canceled drafts.

## Verification

| Check | Result |
| --- | --- |
| Portal lint, TypeScript and production build | Passed |
| Portal unit tests | 29 passed, including 8 new trust/DNS tests |
| Previously failing GUI security audit | 4 passed, 0 failed |
| Existing database assertions | 140 passed |
| Capture-sync assertions | 79 passed |
| Connection access/lifecycle/cancellation assertions | 29 passed |
| Real encrypted-connection/MinIO integration | 6 passed |
| Full production portal, browser, MinIO and device upload | 9 grouped checks passed |
| Light/dark Storage/Captures at 320px and 1440px | 8 scans, no overflow or automated accessibility violations |
| Browser runtime errors | None |

The browser created a new MinIO connection, attempted an invalid credential
replacement, then successfully replaced credentials, disconnected, reloaded,
and reconnected. The runner verified the expected four audit events, encrypted
credential storage, unchanged destination identity, and a real device upload
with a verified receipt through the reconnected destination. The valid rotation
test resubmitted the same working fixture credentials; the invalid-key case
proves failed verification cannot overwrite them.

The browser also resumed an unfinished AWS setup after reload, verified its
external ID was unchanged, and canceled it. Database assertions verify that
cancel removes the draft from the pending quota and rejects stale completion.
AWS role trust behavior uses controlled STS test doubles; no customer AWS account
was accessed. MinIO used real local storage with an explicitly approved loopback
origin and an ephemeral server encryption key.

The full pipeline regression also covers upload retries across a fresh Python
worker, checksum verification, local cleanup only after receipt, destination
pinning, and heartbeat independence from upload pausing. Device code and Wi-Fi
onboarding were unchanged by these fixes; physical camera/GPIO behavior was not
retested.

Evidence: [integration results](integration-results.json),
[security results](security-results.json),
[desktop screenshot](light-1440-storage.png),
[mobile dark screenshot](dark-320-storage.png).

## Deploy

Migration `0016_storage_connection_lifecycle.sql` was applied to the **local**
portal database after isolated migration testing. Apply it to the hosted project
through the normal migration process, then deploy the updated portal. Retain
the existing encryption keys so stored credentials stay readable. The example
environment file now uses a placeholder instead of a reusable encryption key.
No hat reflashing, credentials update, or reprovisioning is needed.

See [setup and test instructions](../../../CAPTURE_SYNC.md). For the complete GUI
browser pass, set `HARDHAT_TEST_GUI=1` and use
`tests/storage-gui-browser.audit.mjs` with the local integration runner.
