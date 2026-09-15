# Capture and storage setup

Voice-triggered recordings now pass through a persistent Pi queue into a
company-owned S3 or MinIO bucket. The portal authenticates the existing device
identity, chooses its organization's destination (or site override), and issues
a five-minute upload URL. The Pi uploads directly to storage. The server verifies
the bytes and writes a JSON metadata file before issuing a receipt.

This release supports AWS S3 and MinIO. Azure Blob Storage, Google Cloud Storage,
multipart resume, live streaming, and analytics connectors are not implemented.
The camera integration is implemented; light control remains an optional command
hook until a hardware driver is available.

## 1. Update the portal

Apply migrations `0014_capture_sync.sql`, `0015_storage_connections.sql`, and
`0016_storage_connection_lifecycle.sql` from `portal/supabase/migrations/` in order,
after migrations 0001–0013. Skip migrations already applied by your deployment
process; do not reset an existing database. They are applied to the local
development database here, not your hosted project.

Install the locked dependencies and deploy the portal:

```bash
cd portal
npm ci
npm run build
```

Retain the existing Supabase environment variables, including the server-only
service-role key. The deployment must serve `/api/device/sync` over HTTPS and
allow its Node handler and Storage page actions up to 120 seconds for storage verification. The video
bytes go directly from the Pi to storage, not through this route. The Pi must
reach both the portal and the storage endpoint.

## 2. Enable GUI connections once per portal deployment

Set `HARDHAT_STORAGE_ENCRYPTION_KEYS` in your hosting platform's secret settings.
Generate a fresh encryption key locally:

```bash
node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"
```

Keep the result outside the database and source control. It encrypts stored
service-account credentials; it is never distributed to hats. Back it up in
your secret manager. For encryption-key rotation, prepend a new `id:key` entry
and retain old entries until existing connections have been re-encrypted by
credential replacement. Restart the portal after changing the key list.

For AWS, configure the portal's workload identity with permission to assume
customer roles, and set `HARDHAT_AWS_TRUST_PRINCIPAL_ARN` to that exact calling
principal's IAM ARN. The wizard displays it in the customer's trust policy.
These are deployment settings, not per-hat or per-customer edits.

## 3. Connect storage through the GUI

An organization admin opens **Storage → Connect storage**. No organization UUID
or cloud credential file needs to be installed on a hat.

For **Amazon S3**, enter the name, bucket and region. The wizard saves a pending
setup with a unique external ID and shows the AWS trust policy. Create the role
in AWS with that trust policy and the scoped permissions below, then paste its
role ARN and select **Test and connect**. The portal tests that the role accepts
the correct external ID and rejects both a missing and an incorrect ID. A timeout
or other transport failure never counts as proof of rejection.

Use **Finish later** or reload the page to leave the draft available under
**Storage accounts → Resume setup**. **Cancel setup** closes it on the server and
frees its pending-setup slot. Canceled drafts cannot be completed by an old tab.

For **MinIO**, enter the name, bucket, region, HTTPS endpoint and restricted
service-account credentials. Select **Test and connect**. The server verifies
actual storage access before saving encrypted credentials. Endpoints must be
origins without paths, queries, fragments or embedded credentials.

MinIO requests resolve and validate DNS, then pin the socket lookup to those
addresses while preserving TLS hostname verification. Each new operation
validates again. Private, loopback and reserved addresses are blocked by default.
For a deliberately private MinIO deployment, the portal operator can approve
specific origins once using `HARDHAT_STORAGE_PRIVATE_ENDPOINTS`, for example
`["https://storage.internal.example:9000"]`. The GUI cannot change this allowlist.
HTTP additionally requires `HARDHAT_ALLOW_INSECURE_STORAGE=true` and is for local
tests only. Do not broadly approve endpoints or metadata-service addresses.

A successful connection creates a tested delivery destination. Check **Make this
the default destination** during connection, or use **Use as default** afterward.
A company connects once for its fleet; new hats inherit the selected destination.
Legacy `HARDHAT_STORAGE_CREDENTIALS` configurations remain supported for existing
operator-managed accounts, but are unnecessary for new GUI connections.

### S3 permissions

Attach a policy based on `portal/storage-policy.example.json` to the storage
role, replacing `BUCKET_NAME` and `ORG_UUID`. It grants object read/write within
the organization prefix, and deletion only for connection-test objects. It also
grants bucket listing so missing-object checks can distinguish absence from
access denial; use a dedicated bucket if listing other tenants' object names
would be inappropriate. Versioned reads and test-object cleanup need their
version-specific permissions. See AWS's [HeadObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html)
and [operation-to-permission mapping](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html).

If the bucket uses a customer-managed KMS key, configure its key policy and the
role's `kms:GenerateDataKey` / `kms:Decrypt` access as appropriate. Bucket defaults
control storage encryption. The connection test verifies actual write, checksum,
read, overwrite protection, and cleanup permissions before activation.

## Manage delivery and connection access

Sign in as an organization admin and open **Storage**:

1. Use a tested delivery destination as the fleet default.
2. Optionally assign different tested destinations to individual sites.
3. Use **Replace credentials** on a storage account to test and save replacement
   MinIO keys or an updated AWS role. Failed tests preserve the working connection.
4. **Disconnect** removes stored credentials and disables delivery. **Reconnect**
   verifies newly supplied credentials and restores the same destination, including
   pending captures. It does not automatically restore a previous fleet default;
   select the default checkbox when reconnecting if desired.
5. Expand **Connection history** for recent connection, replacement and access
   events, with time and actor account ID. The page loads the latest 100 events;
   older records remain in `storage_connection_events`.

Devices must already be claimed into this organization. A site override takes
precedence over the organization default. If an override is paused or invalid,
its captures wait instead of silently falling back to another destination.
Pending captures stay assigned to their original destination when defaults
change. Create a new destination to change a bucket/provider used by captures;
history cannot be deleted through the destination controls.

## 4. Enable camera capture and sync on the Pi

Follow [device-agent/SYNC.md](device-agent/SYNC.md). The short version, from the
updated repository on the Pi:

```bash
cp device-agent/sync.example.json /tmp/hardhat-sync.json
nano /tmp/hardhat-sync.json
# Set portal_url to your deployed HTTPS portal origin.
bash device-agent/setup_pi.sh --sync-config /tmp/hardhat-sync.json
# Stop any existing foreground/tmux voice listener first.
bash voice-trigger/setup_capture_service.sh --alsa-device plughw:0,0
```

Replace the ALSA example with your already-tested microphone device. The existing
device identity is preserved; do not re-provision or reflash. The voice installer
requires the working Pi camera tools and Go installation, installs FFmpeg and
the speech listener, and runs capture and sync under the private service account.

Say **“turn on camera”** for a ten-second MP4 recording; **“turn off camera”**
finishes it early. Each finished clip gets its own capture ID. Inspect
**Captures** in the portal for verification, the last queue report, errors, and
per-device upload pause/resume. Queue counts reflect the last received report;
an offline hat cannot provide a live count.

## Stored format and recovery

Objects use this path:

```text
ORG_UUID/DEVICE_UUID/YYYY/MM/DD/CAPTURE_UUID.mp4
ORG_UUID/DEVICE_UUID/YYYY/MM/DD/CAPTURE_UUID.mp4.metadata.json
```

The sidecar contains schema version, capture/device/site IDs, capture time,
content type, byte size, SHA-256, provider version, and capture metadata. It
contains no device secret. Consumers can discover completed captures via the
metadata files and read ordinary MP4/JSON files with their existing S3 tools.
Use sidecar arrival as the ingestion signal; the video can arrive before its
metadata. There is no analytics notification connector in this release.

Wi-Fi loss, reboots, and expired URLs retain the queue and trigger retries.
Uploads retry the whole clip, bounded to 64 MiB. Only a matching verified receipt
allows cleanup; default local retention is 24 hours after verification. The
default queue limit is 2 GiB. Full storage refuses new recordings without
evicting unverified captures. Incomplete recordings remain local for inspection.
Keep the Pi clock synchronized so capture timestamps are accepted.

Pausing uploads prevents new authorization and completion; an already-issued
signed URL may remain usable for up to five minutes. Heartbeat stays independent.
Resume uploads or restore the pinned storage connection to release blocked
captures. Credential replacement and reconnection retain the same connection reference.

The local spool and identity use restricted filesystem permissions; they are not
encrypted against physical SD-card access. Remove identities and recordings from
any distributable golden image, following the existing per-device import setup.

## Verification and deployment boundary

Automated checks cover database isolation, device authentication, retries,
checksum rejection, write-once storage, receipts, and the actual Python queue
against a production portal build, local Supabase, and real MinIO. Browser checks
exercise storage/site controls and capture status. Results are recorded in
`portal/audit/capture-sync-results.json` when the full integration test passes.

```bash
cd portal
npm run lint
npm test
npm run build
# Requires local Supabase with migrations through 0016, MinIO on 127.0.0.1:19000,
# and a private env file containing MINIO_ROOT_USER / MINIO_ROOT_PASSWORD:
node tests/sync-local.integration.mjs /path/to/private/minio.env
```

For the optional browser pass, install `playwright` and `@axe-core/playwright`
in a separate tooling directory and use an installed Chrome browser:

```bash
HARDHAT_TEST_GUI=1 HARDHAT_BROWSER_MODULES=/path/to/browser-tooling \
  node tests/sync-local.integration.mjs /path/to/private/minio.env \
  tests/storage-gui-browser.audit.mjs
```

The GUI integration uses a temporary encryption key and approves only the local
MinIO fixture for that test server. It exercises new connections, failed and
successful credential replacement, disconnect, reconnect, AWS setup recovery and
cancellation, then uploads through the reconnected destination.

The browser driver tests both 320px and 1440px layouts in light and dark mode,
including automated WCAG checks. Screenshots go to a temporary directory unless
`HARDHAT_BROWSER_SCREENSHOTS` specifies an output directory. The integration
runner creates a temporary organization, devices, and bucket and removes its
own fixtures afterward; it refuses non-local Supabase URLs.

Pi installation, actual new camera recordings, and your hosted AWS/MinIO account
must still be checked in their deployment environment. The local integration test
uses generated sensor bytes to exercise transfer/recovery; it does not simulate
successful physical camera recording.
