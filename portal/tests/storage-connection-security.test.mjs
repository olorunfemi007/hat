import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './storage-test-loader.mjs';
const file = name => fileURLToPath(new URL('../src/lib/storage/' + name + '.ts', import.meta.url));
const originalPrivate = process.env.HARDHAT_STORAGE_PRIVATE_ENDPOINTS;
const originalHttp = process.env.HARDHAT_ALLOW_INSECURE_STORAGE;
afterEach(() => {
  for (const [key, value] of [['HARDHAT_STORAGE_PRIVATE_ENDPOINTS', originalPrivate], ['HARDHAT_ALLOW_INSECURE_STORAGE', originalHttp]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const credentials = { AccessKeyId: 'test-key', SecretAccessKey: 'test-secret', SessionToken: 'test-token' };
function trustTest(send) {
  let destroyed = false;
  const loaded = loadTypeScript(file('aws-role'), { '@aws-sdk/client-sts': {
    STSClient: class { send(command) { return send(command.input); } destroy() { destroyed = true; } },
    AssumeRoleCommand: class { constructor(input) { this.input = input; } },
  } });
  return { verify: () => loaded.verifyAwsRoleTrust('arn:aws:iam::123456789012:role/Test', 'correct-id', 'us-east-1'), destroyed: () => destroyed };
}
const denied = () => Object.assign(new Error('private provider message'), { name: 'AccessDenied' });
test('AWS accepts only a role that enforces both missing and incorrect external IDs', async () => {
  const calls = [];
  const role = trustTest(async input => { calls.push(input); if (input.ExternalId !== 'correct-id') throw denied(); return { Credentials: credentials }; });
  const result = await role.verify();
  assert.equal(result.session_token, 'test-token'); assert.equal(calls.length, 3);
  assert.equal(calls[0].ExternalId, 'correct-id'); assert.equal(Object.hasOwn(calls[1], 'ExternalId'), false);
  assert.notEqual(calls[2].ExternalId, 'correct-id'); assert.ok(role.destroyed());
});
for (const permissive of ['missing', 'incorrect']) test(`AWS rejects a role accepting the ${permissive} external-ID case`, async () => {
  const role = trustTest(async input => {
    if (input.ExternalId === 'correct-id' || (permissive === 'missing' ? input.ExternalId === undefined : input.ExternalId !== undefined)) return { Credentials: credentials };
    throw denied();
  });
  await assert.rejects(role.verify(), error => error.code === 'unsafe_aws_trust_policy');
  assert.ok(role.destroyed());
});
test('AWS transport failure is not treated as proof of negative authorization', async () => {
  const role = trustTest(async input => {
    if (input.ExternalId === 'correct-id') return { Credentials: credentials };
    throw Object.assign(new Error('secret transport detail'), { name: 'TimeoutError' });
  });
  await assert.rejects(role.verify(), error => error.code === 'aws_role_unavailable' && !error.message.includes('secret transport'));
});
function endpointTest(resolve) {
  return loadTypeScript(file('ssrf'), {
    'node:dns/promises': { lookup: resolve },
    '@smithy/node-http-handler': { NodeHttpHandler: class { constructor(options) { this.options = options; } } },
  });
}
function lookup(handler, host, options = {}) {
  return new Promise((resolve, reject) => handler.options.httpsAgent.options.lookup(host, options, (error, address, family) => error ? reject(error) : resolve({ address, family })));
}
test('MinIO socket lookup stays pinned after DNS changes and a new operation rejects the changed DNS', async () => {
  delete process.env.HARDHAT_STORAGE_PRIVATE_ENDPOINTS;
  let calls = 0;
  const guard = endpointTest(async () => [{ address: ++calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  const handler = await guard.pinnedStorageHandler('https://storage.example.test');
  assert.equal((await lookup(handler, 'storage.example.test')).address, '8.8.8.8');
  assert.equal((await lookup(handler, 'storage.example.test', { all: true })).address[0].address, '8.8.8.8');
  assert.equal(calls, 1, 'Actual connection must not resolve DNS again');
  assert.equal(handler.options.httpsAgent.options.rejectUnauthorized, true);
  await assert.rejects(lookup(handler, 'different.example.test'), /Unexpected/);
  await assert.rejects(guard.pinnedStorageHandler('https://storage.example.test'), /private or reserved/);
  handler.options.httpsAgent.destroy(); handler.options.httpAgent.destroy();
});
test('MinIO rejects mixed public/private DNS answers and normalized private IP literals', async () => {
  delete process.env.HARDHAT_STORAGE_PRIVATE_ENDPOINTS;
  const guard = endpointTest(async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  for (const endpoint of ['https://storage.example.test', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]', 'https://169.254.169.254']) {
    await assert.rejects(guard.pinnedStorageHandler(endpoint), /private or reserved/);
  }
});
test('Only an exact deployment-approved private origin is allowed and HTTP still requires opt-in', async () => {
  process.env.HARDHAT_STORAGE_PRIVATE_ENDPOINTS = '["http://127.0.0.1:19000"]';
  delete process.env.HARDHAT_ALLOW_INSECURE_STORAGE;
  const guard = endpointTest(async () => { throw Error('IP literals should not resolve DNS'); });
  await assert.rejects(guard.pinnedStorageHandler('http://127.0.0.1:19000'), /HTTPS/);
  process.env.HARDHAT_ALLOW_INSECURE_STORAGE = 'true';
  const handler = await guard.pinnedStorageHandler('http://127.0.0.1:19000');
  await assert.rejects(guard.pinnedStorageHandler('http://127.0.0.1:19001'), /private or reserved/);
  handler.options.httpsAgent.destroy(); handler.options.httpAgent.destroy();
});
test('MinIO rejects paths, embedded credentials, query strings and fragments before requests', async () => {
  const guard = endpointTest(async () => { throw Error('Must reject before DNS'); });
  for (const endpoint of ['https://name:secret@storage.example.test', 'https://storage.example.test/bucket', 'https://storage.example.test/?token=secret', 'https://storage.example.test/#part']) {
    await assert.rejects(guard.pinnedStorageHandler(endpoint), /without a path/);
  }
});
