import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(fileURLToPath(new URL('../src/lib/redirect-path.ts', import.meta.url)), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {}, URL };
vm.runInNewContext(output, context);
const { safeRedirectPath } = context.exports;

test('preserves a local claim destination, encoded query values, and fragment', () => {
  const destination = '/devices/claim?serial_number=SN%2F123&claim_code=a%2Bb#claim';
  assert.equal(safeRedirectPath(destination), destination);
});

test('rejects external, malformed, and normalized protocol-relative destinations', () => {
  for (const value of [undefined, null, ['//example.com'], '', 'https://example.com', 'javascript:alert(1)', '//example.com', '/\\example.com', '/\n/example.com', '/a/..//example.com', '/a/%2e%2e//example.com']) {
    assert.equal(safeRedirectPath(value), '/dashboard', String(value));
  }
});

test('allows a normal local path with dot segments', () => {
  assert.equal(safeRedirectPath('/sites/../dashboard'), '/dashboard');
});
