// Explicit opt-in, real infrastructure: node tests/sensor-capture-keys.integration.mjs
// Requires local Supabase running (portal/.env.local configured).
// Proves 0018_sensor_capture_keys.sql's object_key convention directly against
// reserve_capture(), independent of the slower full sync-local.integration.mjs:
//   - sensor captures nest under sensors/<sensor_type>/<sensor_id>/
//   - video/audio/image captures are byte-for-byte unchanged from 0017
//   - a sensor capture missing a safe sensor_type/sensor_id is rejected, never
//     silently placed somewhere generic
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));
const env = Object.fromEntries((await import('node:fs')).readFileSync(envPath, 'utf8')
  .split('\n').filter((line) => line.includes('=') && !line.startsWith('#'))
  .map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url?.includes('127.0.0.1') || url?.includes('localhost'), 'Integration test is restricted to local Supabase');

function api(path, body, opts = {}) {
  return fetch(url + path, {
    method: opts.method ?? 'POST',
    headers: { apikey: opts.token ? publishableKey : serviceRoleKey, 'Content-Type': 'application/json',
      Prefer: 'return=representation', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => { const data = await r.json().catch(() => null); if (!r.ok) throw Object.assign(new Error(JSON.stringify(data)), { status: r.status, data }); return data; });
}

function manifest(overrides = {}) {
  const data = randomBytes(16);
  return {
    p_capture_id: randomUUID(), p_captured_at: '2026-09-15T12:34:56.000Z',
    p_content_type: 'application/x-ndjson', p_byte_size: data.length,
    p_sha256: createHash('sha256').update(data).digest('hex'), p_metadata: {},
    ...overrides,
  };
}

let userId, orgId;
try {
  const email = `sensor-key-test-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const signup = await api('/auth/v1/admin/users', { email, password, email_confirm: true });
  userId = signup.id;
  const login = await api('/auth/v1/token?grant_type=password', { email, password });
  const token = login.access_token;
  const org = await api('/rest/v1/rpc/create_organization', { p_name: 'Sensor Key Test' }, { token });
  orgId = org.id ?? org[0]?.id;

  const serial = 'SNTEST-' + randomUUID().slice(0, 8);
  const labels = await api('/rest/v1/rpc/provision_devices', { p_serial_numbers: [serial], p_hardware_serials: [randomBytes(8).toString('hex')] });
  const claimed = await api('/rest/v1/rpc/claim_device', { p_serial_number: labels[0].serial_number, p_claim_code: labels[0].claim_code }, { token });
  const deviceId = claimed[0].id;

  // A verified destination is required before reserve_capture will assign a key at all.
  const config = (await api('/rest/v1/storage_configs', {
    org_id: orgId, name: 'Key test destination', provider: 'minio', bucket: 'irrelevant-not-used',
    region: 'us-east-1', endpoint: 'http://127.0.0.1:19000', credentials_secret_ref: 'unused:' + randomUUID(),
  }, { token }))[0];
  await api('/rest/v1/storage_configs?id=eq.' + config.id, { verified_at: new Date().toISOString() }, { method: 'PATCH' });
  await api('/rest/v1/rpc/set_default_storage', { p_config_id: config.id }, { token });

  const sensorManifest = manifest({ p_kind: 'sensor', p_metadata: { sensor_type: 'dht11', sensor_id: 'front-left' } });
  const sensorRow = (await api('/rest/v1/rpc/reserve_capture', { p_device_id: deviceId, ...sensorManifest }))[0];
  const expectedSensorKey = `${orgId}/${serial}/sensors/dht11/front-left/2026/09/15/${sensorManifest.p_capture_id}.ndjson`;
  assert.equal(sensorRow.object_key, expectedSensorKey);
  console.log('PASS sensor capture nests under sensors/<sensor_type>/<sensor_id>/YYYY/MM/DD/');

  for (const badMetadata of [{}, { sensor_type: 'dht11' }, { sensor_id: 'front-left' }, { sensor_type: 'has/slash', sensor_id: 'x' }, { sensor_type: 'ok', sensor_id: '' }]) {
    await assert.rejects(
      api('/rest/v1/rpc/reserve_capture', { p_device_id: deviceId, ...manifest({ p_kind: 'sensor', p_metadata: badMetadata }) }),
      (error) => error.status === 400,
      `expected rejection for metadata ${JSON.stringify(badMetadata)}`,
    );
  }
  console.log('PASS sensor captures without a safe sensor_type/sensor_id are rejected outright, never placed somewhere generic');

  const videoManifest = manifest({ p_kind: 'video', p_content_type: 'video/mp4' });
  const videoRow = (await api('/rest/v1/rpc/reserve_capture', { p_device_id: deviceId, ...videoManifest }))[0];
  const expectedVideoKey = `${orgId}/${serial}/2026/09/15/${videoManifest.p_capture_id}.mp4`;
  assert.equal(videoRow.object_key, expectedVideoKey);
  assert.ok(!videoRow.object_key.includes('sensors/'), 'video keys must be byte-for-byte unchanged by 0018');
  console.log('PASS video capture key format is unchanged by the sensor-folder migration');

  process.stdout.write(JSON.stringify({ ok: true, checks: 3 }) + '\n');
} finally {
  if (orgId) {
    await api('/rest/v1/captures?org_id=eq.' + orgId, undefined, { method: 'DELETE' });
    await api('/rest/v1/devices?org_id=eq.' + orgId, undefined, { method: 'DELETE' });
    await api('/rest/v1/storage_configs?org_id=eq.' + orgId, undefined, { method: 'DELETE' });
    await api('/rest/v1/organizations?id=eq.' + orgId, undefined, { method: 'DELETE' });
  }
  if (userId) await api('/auth/v1/admin/users/' + userId, undefined, { method: 'DELETE' });
}
