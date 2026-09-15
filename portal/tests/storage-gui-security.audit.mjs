// Focused GUI security audit with controlled cloud/DNS boundaries; no real cloud
// requests or customer credentials. Exits nonzero for missing protections.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sdk from '@aws-sdk/client-s3';
import { loadTypeScript } from './storage-test-loader.mjs';
const file = name => fileURLToPath(new URL('../src/' + name, import.meta.url));
const results = [];
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, detail: error.message }); }
}
process.env.HARDHAT_STORAGE_ENCRYPTION_KEYS = 'audit:' + randomBytes(32).toString('base64');
delete process.env.HARDHAT_ALLOW_INSECURE_STORAGE;
const crypto = loadTypeScript(file('lib/storage/crypto.ts'));
await check('Encryption round trip, unique nonce, tamper rejection and unknown-key rejection', () => {
  const a = crypto.encryptStorageSecret('fixture-key\nfixture-secret');
  const b = crypto.encryptStorageSecret('fixture-key\nfixture-secret');
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(crypto.decryptStorageSecret(a.keyId, a.ciphertext), 'fixture-key\nfixture-secret');
  const changed = Buffer.from(a.ciphertext, 'base64'); changed[changed.length - 1] ^= 1;
  assert.throws(() => crypto.decryptStorageSecret(a.keyId, changed.toString('base64')));
  assert.throws(() => crypto.decryptStorageSecret('missing-key', a.ciphertext));
});
await check('Initial endpoint validation rejects loopback, metadata and private addresses', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', '10.0.0.1']) {
    const guard = loadTypeScript(file('lib/storage/ssrf.ts'), { 'node:dns/promises': { lookup: async () => [{ address }] } });
    await assert.rejects(guard.assertPublicEndpoint('https://storage.example.test'), /private or reserved/);
  }
});
const orgId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
let roles = [], put;
class FakeS3Client {
  constructor(options) { this.options = options; }
  async send(command) {
    if (typeof this.options.credentials === 'function') await this.options.credentials();
    if (command instanceof sdk.PutObjectCommand) {
      if (put) throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
      put = command.input; return {};
    }
    if (command instanceof sdk.HeadObjectCommand) return { ContentLength: put.ContentLength, ChecksumSHA256: put.ChecksumSHA256 };
    if (command instanceof sdk.DeleteObjectCommand) { put = null; return {}; }
    throw Error('Unexpected cloud operation');
  }
  destroy() {}
}
const adapter = loadTypeScript(file('lib/storage/index.ts'), {
  '@aws-sdk/client-s3': { ...sdk, S3Client: FakeS3Client },
  '@aws-sdk/client-sts': { AssumeRoleCommand: class { constructor(input) { this.input = input; } }, STSClient: class {
    async send(command) { roles.push(command.input.ExternalId); return { Credentials: { AccessKeyId: 'fixture', SecretAccessKey: 'fixture', SessionToken: 'fixture' } }; }
    destroy() {}
  } },
  '@aws-sdk/credential-providers': { fromTemporaryCredentials: options => async () => {
    // Deliberately unsafe simulated role: accepts every external ID, including
    // no ID. Setup must detect this instead of certifying this role as safe.
    roles.push(options.params.ExternalId);
    return { accessKeyId: 'fixture', secretAccessKey: 'fixture' };
  } },
});
let saves = 0, role = 'org_admin';
const existing = { id: connectionId, name: 'Audit', bucket: 'audit-bucket', region: 'us-east-1', external_id: 'server-generated-unique-external-id', status: 'pending', auth_mode: 'role', revision: 0 };
const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: existing }) };
const actions = loadTypeScript(file('app/(app)/storage/connections-actions.ts'), {
  'next/cache': { revalidatePath() {} },
  '@/lib/supabase/server': { createServerSupabaseClient: async () => ({ from: () => query }) },
  '@/lib/supabase/admin': { createAdminSupabaseClient: () => ({ rpc: async () => { saves++; return { data: connectionId }; } }) },
  '@/lib/org-context': { getOrgContext: async () => ({ orgId, userId: 'audit-actor', role }) },
  '@/lib/roles': { canManageStorage: value => value === 'org_admin' },
  '@/lib/storage/connection-types': loadTypeScript(file('lib/storage/connection-types.ts')),
  '@/lib/storage/policy': loadTypeScript(file('lib/storage/policy.ts')),
  '@/lib/storage/ssrf': loadTypeScript(file('lib/storage/ssrf.ts')),
  '@/lib/storage/crypto': crypto,
  '@/lib/storage': adapter,
});
const form = new FormData();
form.set('connection_id', connectionId); form.set('revision', '0');
form.set('role_arn', 'arn:aws:iam::123456789012:role/Audit');
await check('Non-admin connection actions fail before cloud requests or privileged writes', async () => {
  role = 'viewer';
  assert.equal((await actions.saveAwsStorageConnection(form)).ok, false);
  assert.equal(saves, 0); assert.equal(roles.length, 0);
  role = 'org_admin';
});
await check('AWS setup rejects a role that does not enforce external ID', async () => {
  const result = await actions.saveAwsStorageConnection(form);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing or incorrect external ID/);
  assert.equal(saves, 0);
  assert.ok(roles.includes(undefined), 'Must actually attempt assumption without an external ID');
});
console.log(JSON.stringify({ checks: results, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length }, null, 2));
process.exitCode = results.some(r => !r.passed) ? 1 : 0;
