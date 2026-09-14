import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './storage-test-loader.mjs';

const handlerPath = fileURLToPath(new URL('../src/app/api/device/sync/handler.ts', import.meta.url));
const protocolPath = fileURLToPath(new URL('../src/app/api/device/sync/protocol.ts', import.meta.url));
const { validateSyncRequest } = loadTypeScript(protocolPath);
const captureId = 'f2a8649a-02e4-4bd6-9a68-f72e08c3d846';
const input = {
  capture_id: captureId, captured_at: '2026-09-13T12:00:00Z', kind: 'video',
  content_type: 'video/h264', byte_size: 128, sha256: 'a'.repeat(64), metadata: { source: 'voice-trigger' },
};
const device = { serial_number: 'HH-12345', hardware_serial: '0000000000012345', device_identity_secret: 'not-a-real-secret' };
const pending = {
  ...input, device_id: 'device-1', site_id: null, org_id: 'org-1', storage_config_id: 'config-1',
  object_key: 'hardhat/org-1/device-1/capture.h264', status: 'queued', verified_at: null,
};
function request(body, headers = {}) {
  return new Request('https://portal.example.com/api/device/sync', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function harness(options = {}) {
  const calls = [];
  const queries = [];
  const row = options.capture === undefined ? { ...pending } : options.capture;
  const admin = {
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === 'authenticate_upload_device') return { data: options.unauthorized ? [] : [{ device_id: 'device-1', org_id: 'org-1' }], error: null };
      if (name === 'reserve_capture') return options.reservationError ? { error: options.reservationError } : { data: [row] };
      if (name === 'begin_capture_upload') return { data: [options.raceVerified ? { ...row, status: 'verified', verified_at: '2026-09-13T13:00:00Z' } : { ...row, status: 'uploading' }] };
      if (name === 'verify_capture_receipt') return { data: [{ ...row, status: 'verified', verified_at: '2026-09-13T13:00:00Z' }] };
      return { data: [] };
    },
    from(table) {
      const query = { table, filters: [] };
      queries.push(query);
      const builder = {
        select() { return builder; },
        eq(...args) { query.filters.push(['eq', ...args]); return builder; },
        is(...args) { query.filters.push(['is', ...args]); return builder; },
        not(...args) { query.filters.push(['not', ...args]); return builder; },
        async maybeSingle() { return { data: table === 'captures' ? row : (options.noDestination ? null : { org_id: 'org-1', provider: 's3', bucket: 'test' }) }; },
      };
      return builder;
    },
  };
  const handler = loadTypeScript(handlerPath).createSyncHandler({
    createAdmin() { calls.push({ name: 'createAdmin' }); return admin; },
    async prepareUpload(config, capture, orgId) {
      calls.push({ name: 'prepareUpload', capture, orgId });
      if (options.storageError) throw new Error('AWS_SECRET_ACCESS_KEY and https://secret-url must stay private');
      return { url: 'https://bucket.example.com/signed', method: 'PUT', headers: {} };
    },
    async verifyUpload(config, capture, orgId) {
      calls.push({ name: 'verifyUpload', capture, orgId });
      if (options.storageError) throw new Error('private provider error');
      return { provider_version: 'version-1' };
    },
    async persistCaptureMetadata(config, capture, orgId, providerVersion) {
      calls.push({ name: 'persistCaptureMetadata', capture, orgId, providerVersion });
      if (options.metadataError) throw new Error('private sidecar failure');
    },
  });
  return { handler, calls, queries };
}

test('validates capture type, MIME, size, checksum and bounded metadata before database access', () => {
  assert.equal(validateSyncRequest({ action: 'prepare', device, capture: { ...input } }).capture.capture_id, captureId);
  for (const patch of [
    { content_type: 'text/html' }, { kind: 'constructor' }, { byte_size: 0 }, { byte_size: 67108865 },
    { sha256: 'not-a-sha' }, { captured_at: 'yesterday' }, { metadata: { password: 'x'.repeat(9000) } },
    { metadata: JSON.parse('{"__proto__":{"polluted":true}}') }, { metadata: { a: { b: { c: { d: { e: { f: { g: true } } } } } } } },
  ]) assert.throws(() => validateSyncRequest({ action: 'prepare', device, capture: { ...input, ...patch } }), /invalid/);
});

test('unauthorized devices cannot read captures, report status or obtain cloud instructions', async () => {
  const { handler, calls, queries } = harness({ unauthorized: true });
  const response = await handler(request({ action: 'prepare', device, capture: input, stats: { queued_count: 1, queued_bytes: 128 } }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.map((call) => call.name), ['createAdmin', 'authenticate_upload_device']);
  assert.equal(queries.length, 0);
});

test('oversized chunked request is rejected before creating privileged database client', async () => {
  const { handler, calls } = harness();
  const response = await handler(request({ action: 'status', device, padding: 'x'.repeat(25 * 1024) }));
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('prepare reserves through device-only RPC and selects verified pinned destination in its organization', async () => {
  const { handler, calls, queries } = harness();
  const response = await handler(request({ action: 'prepare', device, capture: input, org_id: 'attacker-org', storage_config_id: 'attacker-config' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'uploading');
  const reservation = calls.find((call) => call.name === 'reserve_capture');
  assert.equal(reservation.params.p_device_id, 'device-1');
  assert.equal(reservation.params.p_org_id, undefined);
  const config = queries.find((query) => query.table === 'storage_configs');
  assert.ok(config.filters.some(([kind, column, value]) => kind === 'eq' && column === 'id' && value === 'config-1'));
  assert.ok(config.filters.some(([kind, column, value]) => kind === 'eq' && column === 'org_id' && value === 'org-1'));
  assert.ok(config.filters.some(([kind, column]) => kind === 'is' && column === 'disabled_at'));
  assert.ok(config.filters.some(([kind, column]) => kind === 'not' && column === 'verified_at'));
});

test('complete checks capture ownership and verifies provider bytes before atomic receipt', async () => {
  const { handler, calls, queries } = harness();
  const response = await handler(request({ action: 'complete', device, capture_id: captureId }));
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.state, 'verified');
  assert.equal(envelope.receipt.sha256, input.sha256);
  assert.equal(envelope.receipt.byte_size, input.byte_size);
  const names = calls.map((call) => call.name);
  assert.ok(names.indexOf('verifyUpload') < names.indexOf('verify_capture_receipt'));
  assert.ok(names.indexOf('verifyUpload') < names.indexOf('persistCaptureMetadata'));
  assert.ok(names.indexOf('persistCaptureMetadata') < names.indexOf('verify_capture_receipt'));
  assert.ok(queries[0].filters.some(([, key, value]) => key === 'device_id' && value === 'device-1'));
  assert.ok(queries[0].filters.some(([, key, value]) => key === 'org_id' && value === 'org-1'));
  const other = harness({ capture: { ...pending, device_id: 'other-device' } });
  assert.equal((await other.handler(request({ action: 'complete', device, capture_id: captureId }))).status, 404);
  assert.ok(!other.calls.some((call) => call.name === 'verifyUpload'));
});

test('sidecar write failure retains pending capture and never issues a verified receipt', async () => {
  const { handler, calls } = harness({ metadataError: true });
  assert.equal((await handler(request({ action: 'complete', device, capture_id: captureId }))).status, 503);
  assert.ok(!calls.some((call) => call.name === 'verify_capture_receipt'));
});

test('verified retries authenticate again and return identical receipt without issuing more uploads', async () => {
  for (const action of ['prepare', 'complete']) {
    const { handler, calls, queries } = harness({ capture: { ...pending, status: 'verified', verified_at: '2026-09-13T13:00:00Z' } });
    const response = await handler(request({ action, device, capture: input, capture_id: captureId }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).receipt.capture_id, captureId);
    assert.ok(calls.some((call) => call.name === 'authenticate_upload_device'));
    assert.ok(!calls.some((call) => ['prepareUpload', 'verifyUpload'].includes(call.name)));
    assert.ok(!queries.some((query) => query.table === 'storage_configs'));
  }
});

test('verification racing prepare prevents creation of a second signed upload', async () => {
  const { handler, calls } = harness({ raceVerified: true });
  const response = await handler(request({ action: 'prepare', device, capture: input }));
  assert.equal((await response.json()).state, 'verified');
  assert.ok(!calls.some((call) => call.name === 'prepareUpload'));
});

test('unregistered captures return 404, missing active destinations return 409, and provider errors stay private', async () => {
  const missing = harness({ capture: null });
  assert.equal((await missing.handler(request({ action: 'complete', device, capture_id: captureId }))).status, 404);
  const destination = harness({ noDestination: true });
  assert.equal((await destination.handler(request({ action: 'prepare', device, capture: input }))).status, 409);
  const provider = harness({ storageError: true });
  const response = await provider.handler(request({ action: 'prepare', device, capture: input }));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.ok(!text.includes('AWS_SECRET') && !text.includes('secret-url'));
  assert.ok(!JSON.stringify(provider.calls.find((call) => call.name === 'fail_capture_upload')).includes('AWS_SECRET'));
});

test('device queue reports are authenticated and raw error text cannot enter portal status', async () => {
  const { handler, calls } = harness();
  const response = await handler(request({ action: 'status', device, stats: { queued_count: 3, queued_bytes: 400, last_error: 'https://secret-url?signature=private' } }));
  assert.equal(response.status, 200);
  const params = calls.find((call) => call.name === 'report_device_sync_status').params;
  assert.equal(params.p_queued_count, 3);
  assert.ok(!params.p_last_error.includes('secret-url'));
});
