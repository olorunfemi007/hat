// Explicit opt-in, real infrastructure: node tests/storage-connections.integration.mjs
// Requires local Supabase running (portal/.env.local configured) and the
// local MinIO container (hardhat-sync-minio, see storage-minio.integration.mjs).
// Exercises 0015_storage_connections.sql's RPCs and lib/storage's new
// "connection:" resolution path end to end against real infrastructure --
// not mocked, matching this project's existing integration-test convention.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Node 20 has no native WebSocket; @supabase/supabase-js's realtime client
// initializes eagerly at construction regardless of whether this script
// ever opens a channel (it never does here). A do-nothing stub is enough --
// this only needs to exist, not work, to stop construction from throwing.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class NoopWebSocket { static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3; };
}
import { createClient } from '@supabase/supabase-js';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { loadTypeScript } from './storage-test-loader.mjs';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
const env = Object.fromEntries((await import('node:fs')).readFileSync(envPath, 'utf8')
  .split('\n').filter((line) => line.includes('=') && !line.startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
process.env.HARDHAT_STORAGE_ENCRYPTION_KEYS = env.HARDHAT_STORAGE_ENCRYPTION_KEYS;
process.env.HARDHAT_ALLOW_INSECURE_STORAGE = 'true';
assert.ok(url?.includes('127.0.0.1') || url?.includes('localhost'), 'Integration test is restricted to local Supabase');

function api(path, body, opts = {}) {
  return fetch(url + path, {
    method: opts.method ?? 'POST',
    headers: { apikey: opts.token ? publishableKey : serviceRoleKey, 'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => { const data = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(JSON.stringify(data)), { status: r.status, data }); return data; });
}

const adapter = loadTypeScript(fileURLToPath(new URL('../src/lib/storage/index.ts', import.meta.url)));
const crypto = loadTypeScript(fileURLToPath(new URL('../src/lib/storage/crypto.ts', import.meta.url)));
const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const email = `storage-conn-test-${randomUUID().slice(0, 8)}@example.test`;
const password = randomUUID();
const minioEndpoint = 'http://127.0.0.1:19000';
const bucket = `hardhat-conn-test-${randomUUID().slice(0, 8)}`;
const s3 = new S3Client({ endpoint: minioEndpoint, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'hardhat-local-test', secretAccessKey: 'S47jbBz8C7Pd0SRUt_JPlxOv2QYSA6IzJhRXzfMvwoJjV4fT' },
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });

let userId, orgId;
try {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));

  const signup = await api('/auth/v1/admin/users', { email, password, email_confirm: true });
  userId = signup.id;
  const login = await api('/auth/v1/token?grant_type=password', { email, password });
  const orgResult = await api('/rest/v1/rpc/create_organization', { p_name: 'Storage Connections Test' }, { token: login.access_token });
  orgId = orgResult.id ?? orgResult[0]?.id;
  assert.ok(orgId, 'org creation must return an id');

  // --- AWS branch: external_id must be server-generated, never influenced by the caller ---
  const connectionId1 = randomUUID();
  const externalId = await api('/rest/v1/rpc/begin_storage_connection', {
    p_actor: userId, p_org: orgId, p_id: connectionId1, p_details: { name: 'Prod S3', bucket: 'irrelevant-for-this-check', region: 'us-east-1' },
  });
  assert.match(externalId, /^[0-9a-f]{40}$/, 'external_id must be 40 lowercase hex chars, server-generated');
  const { data: pendingRow } = await admin.from('storage_connections').select('*').eq('id', connectionId1).single();
  assert.equal(pendingRow.status, 'pending');
  assert.equal(pendingRow.external_id, externalId);
  console.log('PASS begin_storage_connection generates a real server-side external_id, never caller-influenced');

  // Starting a second AWS connection must generate a DIFFERENT external_id (no reuse/determinism bug).
  const connectionId2 = randomUUID();
  const externalId2 = await api('/rest/v1/rpc/begin_storage_connection', {
    p_actor: userId, p_org: orgId, p_id: connectionId2, p_details: { name: 'Second', bucket: 'bucket-two', region: 'us-east-1' },
  });
  assert.notEqual(externalId, externalId2, 'each connection must get its own independent external_id');
  await admin.from('storage_connections').delete().eq('id', connectionId2); // cleanup, not under test below
  console.log('PASS distinct connections get distinct external_ids');

  // --- MinIO branch: real save_storage_connection with an encrypted secret, then real resolution + real S3 traffic ---
  const secret = crypto.encryptStorageSecret('hardhat-local-test\nS47jbBz8C7Pd0SRUt_JPlxOv2QYSA6IzJhRXzfMvwoJjV4fT');
  const minioConnectionId = randomUUID();
  const configId = await api('/rest/v1/rpc/save_storage_connection', {
    p_actor: userId, p_org: orgId, p_id: minioConnectionId, p_revision: 0,
    p_details: { provider: 'minio', bucket, region: 'us-east-1', endpoint: minioEndpoint, auth_mode: 'keys', name: 'Local MinIO' },
    p_key_id: secret.keyId, p_ciphertext: secret.ciphertext, p_make_default: false,
  });
  assert.ok(configId, 'save_storage_connection must return the storage_configs id');
  const { data: config } = await admin.from('storage_configs').select('*').eq('id', configId).single();
  assert.equal(config.credentials_secret_ref, `connection:${minioConnectionId}`);
  assert.ok(config.verified_at, 'save_storage_connection must mark the config verified immediately');
  console.log('PASS save_storage_connection (MinIO) persists a connection: reference and verified_at');

  // The real point of this whole feature: resolveStoragePolicy must decrypt
  // this connection's secret and successfully drive a REAL MinIO round trip
  // through it -- no env var involved anywhere in this path.
  const verified = await adapter.testStorageConnection(config, orgId, admin);
  assert.ok(verified.verified_at);
  console.log('PASS resolveStoragePolicy("connection:...") + testStorageConnection: real MinIO round trip via a GUI-managed, encrypted-at-rest connection');

  // Wrong org must never resolve someone else's connection.
  await assert.rejects(adapter.testStorageConnection(config, randomUUID(), admin), (error) => error.code === 'storage_not_configured');
  console.log('PASS a connection cannot be resolved under a different org_id');

  // --- Disconnect must actually revoke access, immediately, not on some cache/TTL ---
  const disconnectResult = await api('/rest/v1/rpc/disconnect_storage_connection', {
    p_actor: userId, p_org: orgId, p_id: minioConnectionId, p_revision: 1,
  });
  void disconnectResult;
  const { data: secretAfter } = await admin.from('storage_connection_secrets').select('connection_id').eq('connection_id', minioConnectionId).maybeSingle();
  assert.equal(secretAfter, null, 'disconnect must delete the stored secret, not just flip a flag');
  const { data: configAfter } = await admin.from('storage_configs').select('disabled_at').eq('id', configId).single();
  assert.ok(configAfter.disabled_at, 'disconnect must disable the storage_configs row');
  await assert.rejects(adapter.testStorageConnection({ ...config }, orgId, admin), (error) => error.code === 'storage_not_configured');
  console.log('PASS disconnect_storage_connection revokes the secret and the config immediately');

  process.stdout.write(JSON.stringify({ ok: true, checks: 6 }) + '\n');
} finally {
  try { const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket })); for (const o of objects.Contents ?? []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.Key })); await s3.send(new DeleteBucketCommand({ Bucket: bucket })); } catch { /* best-effort cleanup */ }
  if (orgId) await admin.from('organizations').delete().eq('id', orgId);
  if (userId) await admin.auth.admin.deleteUser(userId);
}
