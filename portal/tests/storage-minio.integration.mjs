// Explicit opt-in: node tests/storage-minio.integration.mjs /path/to/private/minio.env
// Uses a fresh isolated bucket on local MinIO; never an existing customer bucket.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { S3Client, CreateBucketCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { loadTypeScript } from './storage-test-loader.mjs';

// resolveStoragePolicy() now takes an admin client for the "connection:"
// (GUI-managed) lookup path (0015_storage_connections.sql); this test's
// credentials_secret_ref is the pre-existing env-var path, which never
// dereferences it. A real createClient() here throws under Node 20 (no
// native WebSocket, and @supabase/supabase-js's realtime init runs eagerly
// at construction) for a client this test never actually uses -- an inert
// stand-in avoids that entirely, deliberately, not by accident.
const unusedAdminClient = /** @type {import('@supabase/supabase-js').SupabaseClient} */ ({});

if (!process.argv[2]) throw new Error('Supply a local MinIO env file to run this integration test.');
const env = Object.fromEntries(fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')];
}));
assert.ok(env.MINIO_ROOT_USER && env.MINIO_ROOT_PASSWORD, 'MinIO test credentials missing');
const endpoint = 'http://127.0.0.1:19000';
const orgId = randomUUID();
const bucket = `hardhat-adapter-test-${randomUUID().slice(0, 8)}`;
const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: env.MINIO_ROOT_USER, secretAccessKey: env.MINIO_ROOT_PASSWORD },
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
await client.send(new CreateBucketCommand({ Bucket: bucket }));
process.env.HARDHAT_ALLOW_INSECURE_STORAGE = 'true';
process.env.HARDHAT_STORAGE_CREDENTIALS = JSON.stringify({ 'integration-only': {
  org_id: orgId, provider: 'minio', allowed_buckets: [bucket], allowed_endpoints: [endpoint],
  access_key_id: env.MINIO_ROOT_USER, secret_access_key: env.MINIO_ROOT_PASSWORD,
} });
const config = { org_id: orgId, provider: 'minio', bucket, region: 'us-east-1', endpoint, credentials_secret_ref: 'integration-only' };
const adapter = loadTypeScript(fileURLToPath(new URL('../src/lib/storage/index.ts', import.meta.url)));
const data = Buffer.from('real MinIO integration capture\n');
const capture = {
  capture_id: randomUUID(), object_key: `hardhat/${orgId}/${randomUUID()}.json`,
  content_type: 'application/json', byte_size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
};
const tracked = [];
try {
  assert.ok((await adapter.testStorageConnection(config, orgId, unusedAdminClient)).verified_at);
  const probeObjects = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  assert.equal(probeObjects.KeyCount, 0, 'connection probe must remove its own object');
  await assert.rejects(adapter.verifyUpload(config, capture, orgId, unusedAdminClient), (error) => error.code === 'upload_incomplete');
  const upload = await adapter.prepareUpload(config, capture, orgId, unusedAdminClient);
  const wrongBytes = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: Buffer.alloc(data.length), redirect: 'error' });
  assert.equal(wrongBytes.status, 400, 'provider must reject checksum mismatch');
  const changedHeaders = { ...upload.headers };
  delete changedHeaders['if-none-match'];
  const unsignedCondition = await fetch(upload.url, { method: 'PUT', headers: changedHeaders, body: data, redirect: 'error' });
  assert.ok([400, 403].includes(unsignedCondition.status), 'create-only condition must be signed');
  const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: data, redirect: 'error' });
  assert.equal(response.status, 200, 'valid signed upload');
  tracked.push(capture.object_key);
  assert.ok((await adapter.verifyUpload(config, capture, orgId, unusedAdminClient)).provider_version);
  const metadataCapture = { ...capture, device_id: randomUUID(), site_id: null, captured_at: '2026-09-13T00:00:00.000Z',
    kind: 'sensor', metadata: { source: 'integration-test', nested: { b: 2, a: 1 } } };
  const providerVersion = (await adapter.verifyUpload(config, capture, orgId, unusedAdminClient)).provider_version;
  await adapter.persistCaptureMetadata(config, metadataCapture, orgId, providerVersion, unusedAdminClient);
  tracked.push(`${capture.object_key}.metadata.json`);
  await adapter.persistCaptureMetadata(config, { ...metadataCapture, metadata: { nested: { a: 1, b: 2 }, source: 'integration-test' } }, orgId, providerVersion, unusedAdminClient);
  await assert.rejects(adapter.persistCaptureMetadata(config, { ...metadataCapture, kind: 'video' }, orgId, providerVersion, unusedAdminClient), (error) => error.code === 'capture_integrity_mismatch');
  const overwrite = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: data, redirect: 'error' });
  assert.equal(overwrite.status, 412, 'late signed URL must not overwrite verified object');
  const forged = { ...capture, capture_id: randomUUID(), object_key: `hardhat/${orgId}/${randomUUID()}.json` };
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: forged.object_key,
    Body: Buffer.alloc(data.length), ContentType: 'application/json', Metadata: { sha256: capture.sha256 } }));
  tracked.push(forged.object_key);
  await assert.rejects(adapter.verifyUpload(config, forged, orgId, unusedAdminClient), (error) => error.code === 'capture_integrity_mismatch');
  process.stdout.write(JSON.stringify({ ok: true, checks: 11, provider: 'MinIO', bucket }) + '\n');
} finally {
  for (const key of tracked) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  client.destroy();
}
