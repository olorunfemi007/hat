import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import * as sdk from '@aws-sdk/client-s3';
import { loadTypeScript } from './storage-test-loader.mjs';

const adapterPath = fileURLToPath(new URL('../src/lib/storage/index.ts', import.meta.url));
const policyPath = fileURLToPath(new URL('../src/lib/storage/policy.ts', import.meta.url));
const originalCredentials = process.env.HARDHAT_STORAGE_CREDENTIALS;
const originalInsecure = process.env.HARDHAT_ALLOW_INSECURE_STORAGE;
afterEach(() => {
  if (originalCredentials === undefined) delete process.env.HARDHAT_STORAGE_CREDENTIALS;
  else process.env.HARDHAT_STORAGE_CREDENTIALS = originalCredentials;
  if (originalInsecure === undefined) delete process.env.HARDHAT_ALLOW_INSECURE_STORAGE;
  else process.env.HARDHAT_ALLOW_INSECURE_STORAGE = originalInsecure;
});
const orgId = '7878d0be-4344-4398-b6fc-335098874ec9';
const config = { org_id: orgId, provider: 's3', bucket: 'hardhat-captures', region: 'us-east-1', endpoint: null, credentials_secret_ref: 'customer-a' };
function credentials(overrides = {}) {
  process.env.HARDHAT_STORAGE_CREDENTIALS = JSON.stringify({ 'customer-a': {
    org_id: orgId, provider: 's3', allowed_buckets: ['hardhat-captures'],
    access_key_id: 'test-key', secret_access_key: 'test-secret', ...overrides,
  } });
}
const data = Buffer.from('a real captured sensor batch');
const capture = {
  capture_id: 'd4a92d39-f21b-4e19-b5e3-c64e839ef565', object_key: `hardhat/${orgId}/capture.json`,
  content_type: 'application/json', byte_size: data.length, sha256: createHash('sha256').update(data).digest('hex'),
};

// resolveStoragePolicy became async when it gained a second resolution path
// (a "connection:" reference, looked up via an admin client -- see
// 0015_storage_connections.sql / lib/storage/policy.ts). None of these
// cases use that path, so any object satisfies the now-required admin
// parameter; it's never dereferenced for the env-var path these tests cover.
const unusedAdmin = {};

test('connection policy isolates credentials and buckets by organization and provider', async () => {
  credentials();
  const { resolveStoragePolicy } = loadTypeScript(policyPath);
  assert.equal((await resolveStoragePolicy(config, orgId, unusedAdmin)).endpoint, 'https://s3.us-east-1.amazonaws.com');
  for (const attempt of [
    [{ ...config, org_id: 'someone-else' }, orgId], [config, 'someone-else'],
    [{ ...config, bucket: 'another-company-bucket' }, orgId],
    [{ ...config, credentials_secret_ref: '__proto__' }, orgId],
    [{ ...config, provider: 'minio' }, orgId],
  ]) await assert.rejects(resolveStoragePolicy(...attempt, unusedAdmin), /not configured/);
});

test('connection policy rejects arbitrary endpoints, credentials in URLs and HTTP by default', async () => {
  credentials({ allowed_endpoints: ['https://minio.example.com', 'http://localhost:19000'] });
  const { resolveStoragePolicy } = loadTypeScript(policyPath);
  for (const endpoint of ['http://localhost:19000', 'https://169.254.169.254', 'https://evil.example.com', 'https://user:password@minio.example.com', 'https://minio.example.com/path', 'https://minio.example.com/?target=evil']) {
    await assert.rejects(resolveStoragePolicy({ ...config, endpoint }, orgId, unusedAdmin), /not configured/);
  }
  process.env.HARDHAT_ALLOW_INSECURE_STORAGE = 'true';
  assert.equal((await resolveStoragePolicy({ ...config, endpoint: 'http://localhost:19000' }, orgId, unusedAdmin)).endpoint, 'http://localhost:19000');
});

test('unsupported providers and implicit ambient credentials cannot silently activate', async () => {
  credentials({ access_key_id: undefined, secret_access_key: undefined });
  const { resolveStoragePolicy } = loadTypeScript(policyPath);
  await assert.rejects(resolveStoragePolicy(config, orgId, unusedAdmin), /not configured/);
  await assert.rejects(resolveStoragePolicy({ ...config, provider: 'gcs' }, orgId, unusedAdmin), /currently supports/);
});

test('official SDK signs one object, SHA256, content length, type and create-only condition for five minutes', async () => {
  credentials();
  const { prepareUpload } = loadTypeScript(adapterPath);
  const instruction = await prepareUpload(config, capture, orgId, unusedAdmin);
  const url = new URL(instruction.url);
  assert.equal(url.pathname, `/hardhat-captures/${capture.object_key}`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders').split(';');
  for (const header of ['content-type', 'content-length', 'if-none-match', 'x-amz-checksum-sha256']) assert.ok(signedHeaders.includes(header), header);
  assert.equal(instruction.headers['if-none-match'], '*');
  assert.equal(instruction.headers['x-amz-checksum-sha256'], createHash('sha256').update(data).digest('base64'));
  assert.ok(!instruction.url.includes('test-secret'));
});

function mockedAdapter(send) {
  return loadTypeScript(adapterPath, { '@aws-sdk/client-s3': {
    ...sdk, S3Client: class { async send(command) { return send(command); } destroy() {} },
  } });
}

test('verification trusts provider-validated checksum, never custom metadata', async () => {
  credentials();
  let requests = 0;
  const adapter = mockedAdapter(() => {
    requests++;
    return { ContentLength: data.length, ChecksumSHA256: createHash('sha256').update(data).digest('base64'), VersionId: 'version-1' };
  });
  assert.equal((await adapter.verifyUpload(config, capture, orgId, unusedAdmin)).provider_version, 'version-1');
  assert.equal(requests, 1);
  const mismatched = mockedAdapter(() => ({ ContentLength: data.length, ChecksumSHA256: Buffer.alloc(32).toString('base64'), Metadata: { sha256: capture.sha256 } }));
  await assert.rejects(mismatched.verifyUpload(config, capture, orgId, unusedAdmin), /does not match/);
});

test('checksum fallback hashes bounded actual bytes and pins GET to HEAD version', async () => {
  credentials();
  const adapter = mockedAdapter((command) => {
    if (command instanceof sdk.HeadObjectCommand) return { ContentLength: data.length, ETag: 'etag-1', VersionId: 'version-1', Metadata: { sha256: 'not-trusted' } };
    assert.equal(command.input.VersionId, 'version-1');
    assert.equal(command.input.IfMatch, 'etag-1');
    return { Body: Readable.from([data.subarray(0, 10), data.subarray(10)]) };
  });
  assert.equal((await adapter.verifyUpload(config, capture, orgId, unusedAdmin)).provider_version, 'version-1');
  const oversized = mockedAdapter((command) => command instanceof sdk.HeadObjectCommand
    ? { ContentLength: data.length } : { Body: Readable.from([Buffer.alloc(data.length + 1)]) });
  await assert.rejects(oversized.verifyUpload(config, capture, orgId, unusedAdmin), /does not match/);
});

test('missing and denied provider objects produce safe actionable errors without SDK secrets', async () => {
  credentials();
  const missing = mockedAdapter(() => { throw Object.assign(new Error('secret URL'), { $metadata: { httpStatusCode: 404 } }); });
  await assert.rejects(missing.verifyUpload(config, capture, orgId, unusedAdmin), (error) => error.status === 409 && error.code === 'upload_incomplete' && !error.message.includes('secret'));
  const denied = mockedAdapter(() => { throw Object.assign(new Error('secret URL'), { $metadata: { httpStatusCode: 403 } }); });
  await assert.rejects(denied.verifyUpload(config, capture, orgId, unusedAdmin), (error) => error.code === 'storage_permission_denied' && !error.message.includes('secret'));
});

test('connection probe verifies and deletes only its own random test object', async () => {
  credentials();
  let uploaded;
  const keys = [];
  const adapter = mockedAdapter((command) => {
    keys.push(command.input.Key);
    if (command instanceof sdk.PutObjectCommand) {
      if (uploaded) throw Object.assign(new Error('already exists'), { $metadata: { httpStatusCode: 412 } });
      uploaded = command.input; return {};
    }
    if (command instanceof sdk.HeadObjectCommand) return { ContentLength: uploaded.ContentLength, ChecksumSHA256: uploaded.ChecksumSHA256 };
    assert.ok(command instanceof sdk.DeleteObjectCommand);
    return {};
  });
  assert.ok((await adapter.testStorageConnection(config, orgId, unusedAdmin)).verified_at);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 1);
  assert.ok(keys[0].startsWith(`${orgId}/.hardhat-tests/`));
  assert.equal(uploaded.IfNoneMatch, '*');
});
