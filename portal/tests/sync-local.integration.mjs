// End-to-end local-only test: production portal -> Supabase -> MinIO + real Pi queue CLI.
// Run after npm run build and migration 0014:
// node tests/sync-local.integration.mjs /path/to/private/minio.env [optional-browser-script.cjs]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { loadTypeScript } from './storage-test-loader.mjs';

const portal = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(portal);
function readEnv(filename) {
  return Object.fromEntries(fs.readFileSync(filename, 'utf8').split('\n').filter((line) => line.includes('=') && !line.trimStart().startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')];
  }));
}
if (!process.argv[2]) throw new Error('Supply the local MinIO env file.');
const env = { ...readEnv(path.join(portal, '.env.local')), ...process.env };
const minio = readEnv(process.argv[2]);
const dbUrl = env.NEXT_PUBLIC_SUPABASE_URL;
assert.ok(['localhost', '127.0.0.1'].includes(new URL(dbUrl).hostname), 'Local Supabase only');
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY && env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Supabase keys missing');
const site = 'http://127.0.0.1:3002';
const endpoint = 'http://127.0.0.1:19000';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hardhat-sync-integration-'));
fs.chmodSync(directory, 0o700);
const bucket = 'hardhat-sync-' + randomUUID().slice(0, 12);
const credentials = { accessKeyId: minio.MINIO_ROOT_USER, secretAccessKey: minio.MINIO_ROOT_PASSWORD };
const storage = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
const ids = { users: [], org: null, devices: [], configs: [] };
const report = { checks: [], browser: null };
let server;
const ok = (name) => { report.checks.push(name); console.log('PASS ' + name); };
async function api(route, body, token, method = body === undefined ? 'GET' : 'POST') {
  const key = token ? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (token || key.split('.').length === 3) headers.Authorization = 'Bearer ' + (token || key);
  const response = await fetch(dbUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Local Supabase ${method} ${route.split('?')[0]} failed: HTTP ${response.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}
async function machine(body, expected = 200) {
  const response = await fetch(site + '/api/device/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, expected, `Machine ${body.action} status`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
function python(code, args = []) {
  const result = spawnSync('python3', ['-c', code, root, directory, ...args], { encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) throw new Error('Pi test helper failed: ' + result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
try {
  await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  const email = `capture-sync-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('base64url') + '1a!';
  const user = await api('/auth/v1/admin/users', { email, password, email_confirm: true });
  ids.users.push(user.id);
  const login = await api('/auth/v1/token?grant_type=password', { email, password });
  const token = login.access_token;
  const org = await api('/rest/v1/rpc/create_organization', { p_name: 'Capture sync integration' }, token);
  ids.org = org.id;
  const hardware = randomBytes(8).toString('hex');
  const labels = await api('/rest/v1/rpc/provision_devices', { p_serial_numbers: ['SYNC-' + randomUUID(), 'SYNC-' + randomUUID()], p_hardware_serials: [hardware, randomBytes(8).toString('hex')] });
  for (const label of labels) {
    const claimed = await api('/rest/v1/rpc/claim_device', { p_serial_number: label.serial_number, p_claim_code: label.claim_code }, token);
    ids.devices.push(claimed[0].id);
  }
  const device = { serial_number: labels[0].serial_number, hardware_serial: hardware, device_identity_secret: labels[0].device_identity_secret };
  const ref = 'integration-' + randomUUID();
  env.HARDHAT_ALLOW_INSECURE_STORAGE = 'true';
  env.HARDHAT_STORAGE_CREDENTIALS = JSON.stringify({ [ref]: { label: 'Local integration account', org_id: org.id, provider: 'minio', allowed_buckets: [bucket], allowed_endpoints: [endpoint], access_key_id: credentials.accessKeyId, secret_access_key: credentials.secretAccessKey } });
  process.env.HARDHAT_ALLOW_INSECURE_STORAGE = env.HARDHAT_ALLOW_INSECURE_STORAGE;
  process.env.HARDHAT_STORAGE_CREDENTIALS = env.HARDHAT_STORAGE_CREDENTIALS;
  const destination = { org_id: org.id, name: 'Integration recordings', provider: 'minio', bucket, region: 'us-east-1', endpoint, credentials_secret_ref: ref };
  const config = (await api('/rest/v1/storage_configs', destination, token))[0];
  ids.configs.push(config.id);
  const serverLog = fs.openSync(path.join(directory, 'portal.log'), 'a', 0o600);
  server = spawn(process.execPath, [path.join(portal, 'node_modules/next/dist/bin/next'), 'start', '-p', '3002', '-H', '127.0.0.1'], { cwd: portal, env, stdio: ['ignore', serverLog, serverLog] });
  fs.closeSync(serverLog);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('Local test portal exited: ' + fs.readFileSync(path.join(directory, 'portal.log'), 'utf8').slice(-2000));
    try { const r = await fetch(site + '/sign-in'); if (r.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Local test portal ready');
  const data = Buffer.from(JSON.stringify({ temperature_c: 24.5, humidity_percent: 61, schema_version: 1 }));
  const capture = { capture_id: randomUUID(), captured_at: new Date().toISOString(), kind: 'sensor', content_type: 'application/json', byte_size: data.length, sha256: createHash('sha256').update(data).digest('hex'), metadata: { format_version: 1 } };
  await machine({ action: 'prepare', device, capture }, 409);
  ok('Untested destination cannot receive captures');
  const adapter = loadTypeScript(path.join(portal, 'src/lib/storage/index.ts'));
  // resolveStoragePolicy()'s admin param is only dereferenced for a
  // "connection:" reference (0015_storage_connections.sql); this test's
  // config uses the pre-existing env-var path, which never touches it.
  const tested = await adapter.testStorageConnection(config, org.id, {});
  await api('/rest/v1/storage_configs?id=eq.' + config.id, { verified_at: tested.verified_at }, undefined, 'PATCH');
  await api('/rest/v1/rpc/set_default_storage', { p_config_id: config.id }, token);
  ok('Real upload/read/delete connection test and default activation');
  const prepared = await machine({ action: 'prepare', device, capture });
  assert.equal(prepared.state, 'uploading');
  await machine({ action: 'complete', device, capture_id: capture.capture_id }, 409);
  const put = await fetch(prepared.upload.url, { method: 'PUT', headers: prepared.upload.headers, body: data, redirect: 'error' });
  assert.equal(put.status, 200);
  const completed = await machine({ action: 'complete', device, capture_id: capture.capture_id });
  assert.equal(completed.receipt.sha256, capture.sha256);
  assert.equal(completed.receipt.byte_size, data.length);
  const stored = (await api('/rest/v1/captures?capture_id=eq.' + capture.capture_id))[0];
  assert.equal(stored.status, 'verified');
  assert.equal(stored.storage_config_id, config.id);
  const object = await storage.send(new GetObjectCommand({ Bucket: bucket, Key: stored.object_key }));
  assert.equal(await object.Body.transformToString(), data.toString());
  ok('Real signed upload, independent verification, database receipt, exact stored bytes');
  const duplicate = await machine({ action: 'prepare', device, capture });
  assert.equal(duplicate.state, 'verified'); assert.equal(duplicate.upload, undefined);
  await machine({ action: 'prepare', device, capture: { ...capture, sha256: '0'.repeat(64) } }, 409);
  const overwrite = await fetch(prepared.upload.url, { method: 'PUT', headers: prepared.upload.headers, body: data, redirect: 'error' });
  assert.equal(overwrite.status, 412);
  ok('Idempotent receipt, conflicting manifest rejection, and late overwrite prevention');
  await machine({ action: 'status', device: { ...device, hardware_serial: 'f'.repeat(16) }, stats: { queued_count: 0, queued_bytes: 0 } }, 401);
  await api('/rest/v1/rpc/set_device_upload_enabled', { p_device_id: ids.devices[0], p_enabled: false }, token);
  await machine({ action: 'complete', device, capture_id: capture.capture_id }, 401);
  const beat = await api('/rest/v1/rpc/device_heartbeat', { p_serial_number: device.serial_number, p_hardware_serial: hardware, p_device_identity_secret: device.device_identity_secret });
  assert.equal(beat[0].status, 'active');
  await api('/rest/v1/rpc/set_device_upload_enabled', { p_device_id: ids.devices[0], p_enabled: true }, token);
  ok('Hardware mismatch and paused uploads rejected while heartbeat still works');
  const pending = { ...capture, capture_id: randomUUID() };
  await machine({ action: 'prepare', device, capture: pending });
  const secondConfig = (await api('/rest/v1/storage_configs', { ...destination, name: 'New destination version' }, token))[0];
  ids.configs.push(secondConfig.id);
  await api('/rest/v1/storage_configs?id=eq.' + secondConfig.id, { verified_at: tested.verified_at }, undefined, 'PATCH');
  await api('/rest/v1/rpc/set_default_storage', { p_config_id: secondConfig.id }, token);
  await machine({ action: 'prepare', device, capture: pending });
  const pinned = (await api('/rest/v1/captures?capture_id=eq.' + pending.capture_id))[0];
  assert.equal(pinned.storage_config_id, config.id);
  ok('Pending capture stays pinned when the fleet default changes');
  fs.writeFileSync(path.join(directory, 'device.json'), JSON.stringify({ ...device, supabase_url: dbUrl, publishable_key: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, allow_http: true }), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'serial'), hardware);
  fs.writeFileSync(path.join(directory, 'sync.json'), JSON.stringify({ portal_url: site, allow_http: true, spool_dir: path.join(directory, 'spool'), max_spool_bytes: 268435456, min_free_bytes: 0, retention_hours: 0, timeout_seconds: 30 }));
  const queueId = python(`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'device-agent'))\nfrom sync import Queue,load_sync_config,utc_now\np=Path(sys.argv[2]);q=Queue(load_sync_config(p/'sync.json'))\nwith q.lock('capture'):\n cid,folder=q.reserve(1024);(folder/'data').write_bytes(b'{"source":"real-pi-queue-test"}');q.finalize(cid,folder,utc_now(),kind='sensor',content_type='application/json')\nq.close();print(json.dumps(cid))`);
  // A failed attempt persists; a fresh worker process must recover and finish it.
  python(`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'device-agent'))\nfrom sync import Queue,SyncClient,load_sync_config,run_once\nfrom heartbeat import load_config\np=Path(sys.argv[2]);c=load_sync_config(p/'sync.json');q=Queue(c);c['portal_url']='http://127.0.0.1:1';c['timeout_seconds']=1\nrun_once(q,SyncClient(c,load_config(p/'device.json',p/'serial')))\nassert q.due(1e20)['attempts']==1\nassert (q.entries/sys.argv[3]/'data').exists()\nwith q.db:q.db.execute('UPDATE captures SET next_attempt=0')\nq.close();print(json.dumps(True))`, [queueId]);
  const worker = spawnSync('python3', [path.join(root, 'device-agent/sync.py'), '--config', path.join(directory, 'sync.json'), '--identity', path.join(directory, 'device.json'), '--hardware-serial-file', path.join(directory, 'serial'), '--once'], { encoding: 'utf8', timeout: 90000 });
  assert.equal(worker.status, 0, worker.stderr);
  const queueState = python(`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(sys.argv[1])/'device-agent'))\nfrom sync import Queue,load_sync_config\np=Path(sys.argv[2]);q=Queue(load_sync_config(p/'sync.json'));row=q.db.execute('SELECT state,receipt,purged FROM captures WHERE capture_id=?',(sys.argv[3],)).fetchone();print(json.dumps(dict(row)));q.close()`, [queueId]);
  assert.equal(queueState.state, 'verified'); assert.equal(queueState.purged, 1);
  assert.equal(fs.existsSync(path.join(directory, 'spool', 'captures', queueId, 'data')), false);
  const queueReceipt = (await api('/rest/v1/captures?capture_id=eq.' + queueId))[0];
  assert.equal(queueReceipt.status, 'verified');
  const sync = (await api('/rest/v1/device_sync_status?device_id=eq.' + ids.devices[0]))[0];
  assert.equal(sync.queued_count, 0); assert.ok(sync.last_verified_at);
  ok('Real Pi queue survives failed transfer, restarts, verifies, then cleans up and reports status');
  if (process.argv[3]) {
    const fixture = path.join(directory, 'browser-fixture.json');
    fs.writeFileSync(fixture, JSON.stringify({ site, email, password, org_id: org.id, bucket, device_id: ids.devices[0], capture_id: queueId, config_id: secondConfig.id }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [path.resolve(process.argv[3]), fixture], { encoding: 'utf8', timeout: 180000 });
    if (result.status !== 0) throw new Error('Browser verification failed: ' + result.stderr + result.stdout);
    report.browser = JSON.parse(result.stdout.trim());
    ok('Portal storage/captures browser workflow');
  }
  fs.writeFileSync(path.join(portal, 'audit', 'capture-sync-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, checks: report.checks.length, browser: report.browser }));
} finally {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 5000); }); }
  // Only objects and rows created in this test's unique bucket/organization.
  if (ids.org) {
    await api('/rest/v1/captures?org_id=eq.' + ids.org, undefined, undefined, 'DELETE');
    await api('/rest/v1/devices?org_id=eq.' + ids.org, undefined, undefined, 'DELETE');
    await api('/rest/v1/sites?org_id=eq.' + ids.org, undefined, undefined, 'DELETE');
    await api('/rest/v1/storage_configs?org_id=eq.' + ids.org, undefined, undefined, 'DELETE');
    await api('/rest/v1/organizations?id=eq.' + ids.org, undefined, undefined, 'DELETE');
  }
  for (const id of ids.users) await api('/auth/v1/admin/users/' + id, undefined, undefined, 'DELETE');
  const objects = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
  if (objects.Contents?.length) await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) } }));
  await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
  storage.destroy();
  fs.rmSync(directory, { recursive: true, force: true });
}
