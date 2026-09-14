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

Apply `portal/supabase/migrations/0014_capture_sync.sql` to the same Supabase
project the portal uses, after migrations 0001–0013. Use your normal migration
deployment process; do not reset an existing database. This migration has been
applied to the development database here, not your hosted project.

Install the locked dependencies and deploy the portal:

```bash
cd portal
npm ci
npm run build
```

Retain the existing Supabase environment variables, including the server-only
service-role key. The deployment must serve `/api/device/sync` over HTTPS and
allow its Node handler up to 120 seconds for storage verification. The video
bytes go directly from the Pi to storage, not through this route. The Pi must
reach both the portal and the storage endpoint.

## 2. Connect a company storage account once

Get the organization's UUID from Supabase's `organizations` table. Create a
private S3 bucket or use an existing private MinIO bucket. Configure the server's
secret environment variable `HARDHAT_STORAGE_CREDENTIALS` as a JSON object.
Each entry belongs to exactly one organization and explicitly lists its buckets.

For an AWS workload with its own IAM role:

```json
{
  "company-recordings": {
    "label": "Company AWS account",
    "org_id": "REPLACE_WITH_ORGANIZATION_UUID",
    "provider": "s3",
    "allowed_buckets": ["company-hardhat-recordings"],
    "use_default_credentials": true
  }
}
```

For a customer AWS role, replace `use_default_credentials` with `role_arn` and
`external_id`. Configure that role's trust policy to allow the portal's AWS
principal with the same external ID, and permit the portal principal to call
`sts:AssumeRole`. A separate role per customer limits access across companies.
Static `access_key_id` and `secret_access_key` (plus optional `session_token`)
are also supported when a workload role is unavailable.

For MinIO:

```json
{
  "company-minio": {
    "label": "Company MinIO",
    "org_id": "REPLACE_WITH_ORGANIZATION_UUID",
    "provider": "minio",
    "allowed_buckets": ["hardhat-recordings"],
    "allowed_endpoints": ["https://storage.example.com"],
    "access_key_id": "REPLACE_WITH_SERVICE_ACCOUNT_KEY",
    "secret_access_key": "REPLACE_WITH_SERVICE_ACCOUNT_SECRET"
  }
}
```

Use a scoped service account, not MinIO root credentials. Endpoints must be
HTTPS origins without a path, query, or embedded credentials. Save the JSON as
one environment-variable value and restart/redeploy the portal. Never copy this
variable or the Supabase service-role key to a Pi or public environment variable.
The browser receives only the organization's allowed connection names, buckets,
and endpoints.

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

## 3. Activate the destination in the portal

Sign in as an organization admin and open **Storage**:

1. Select the connected account and allowed bucket, give the destination a name,
   and select the actual bucket region (or MinIO endpoint).
2. Add the destination, then select **Test connection**.
3. After the test succeeds, select **Use as default**.
4. Optionally assign different tested destinations to individual sites.

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
captures. Cloud credential rotation can keep the same connection reference.

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
# Requires local Supabase with migration 0014, MinIO on 127.0.0.1:19000,
# and a private env file containing MINIO_ROOT_USER / MINIO_ROOT_PASSWORD:
node tests/sync-local.integration.mjs /path/to/private/minio.env
```

For the optional browser pass, install `playwright` and `@axe-core/playwright`
in a separate tooling directory and use an installed Chrome browser:

```bash
HARDHAT_BROWSER_MODULES=/path/to/browser-tooling \
  node tests/sync-local.integration.mjs /path/to/private/minio.env \
  tests/sync-browser.integration.mjs
```

The browser driver tests both 320px and 1440px layouts in light and dark mode,
including automated WCAG checks. Screenshots go to a temporary directory unless
`HARDHAT_BROWSER_SCREENSHOTS` specifies an output directory. The integration
runner creates a temporary organization, devices, and bucket and removes its
own fixtures afterward; it refuses non-local Supabase URLs.

Pi installation, actual new camera recordings, and your hosted AWS/MinIO account
must still be checked in their deployment environment. The local integration test
uses generated sensor bytes to exercise transfer/recovery; it does not simulate
successful physical camera recording.
