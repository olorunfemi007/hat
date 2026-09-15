// Optional browser driver for sync-local.integration.mjs.
// HARDHAT_BROWSER_MODULES may point to an external directory containing package.json
// and installed playwright + @axe-core/playwright dependencies.
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(process.env.HARDHAT_BROWSER_MODULES ? path.resolve(process.env.HARDHAT_BROWSER_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const screenshots = process.env.HARDHAT_BROWSER_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'hardhat-sync-browser-'));
fs.mkdirSync(screenshots, { recursive: true });
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const checks = [];
  await page.goto(fixture.site + '/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(fixture.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/dashboard');
  await page.getByRole('navigation').getByRole('link', { name: 'Captures', exact: true }).click();
  await page.getByRole('heading', { name: 'Captures', exact: true }).waitFor();
  assert.ok(await page.getByText('Verified', { exact: true }).count() >= 2);
  await page.getByRole('link', { name: 'Manage storage' }).click();
  const original = page.locator('li').filter({ has: page.getByText('Integration recordings', { exact: true }) });
  await original.getByRole('button', { name: 'Test connection', exact: true }).click();
  await original.getByText('Test capture uploaded, verified, and cleaned up successfully.', { exact: true }).waitFor();
  checks.push('Connection test through authenticated server action');
  await page.getByLabel('Destination name', { exact: true }).fill('Browser destination');
  await page.getByRole('button', { name: 'Add destination', exact: true }).click();
  const added = page.locator('li').filter({ has: page.getByText('Browser destination', { exact: true }) });
  await added.waitFor();
  await added.getByRole('button', { name: 'Test connection', exact: true }).click();
  await added.getByText('Test capture uploaded, verified, and cleaned up successfully.', { exact: true }).waitFor();
  await added.getByRole('button', { name: 'Use as default', exact: true }).click();
  await added.getByText('Fleet default', { exact: true }).waitFor();
  await added.getByRole('button', { name: 'Pause', exact: true }).click();
  await added.getByText('Paused', { exact: true }).waitFor();
  await added.getByRole('button', { name: 'Resume', exact: true }).click();
  await added.getByRole('button', { name: 'Use as default', exact: true }).click();
  await added.getByText('Fleet default', { exact: true }).waitFor();
  checks.push('Guided account/bucket selection, create, test, activate, pause, resume');
  await page.getByRole('navigation').getByRole('link', { name: 'Sites', exact: true }).click();
  await page.getByLabel('Site name', { exact: true }).fill('Integration site');
  await page.getByRole('button', { name: 'Add site', exact: true }).click();
  await page.getByText('Integration site', { exact: true }).waitFor();
  await page.getByRole('navigation').getByRole('link', { name: 'Storage', exact: true }).click();
  await page.getByRole('combobox', { name: /^Integration site/ }).selectOption({ label: 'Browser destination' });
  const selected = await page.getByRole('combobox', { name: /^Integration site/ }).inputValue();
  await Promise.all([
    page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/storage') && response.ok()),
    page.getByRole('button', { name: 'Save destination', exact: true }).click(),
  ]);
  await page.reload();
  assert.equal(await page.getByRole('combobox', { name: /^Integration site/ }).inputValue(), selected);
  checks.push('Site destination persists');
  await page.getByRole('navigation').getByRole('link', { name: 'Captures', exact: true }).click();
  const control = page.locator('section').first().getByRole('button', { name: 'Pause uploads', exact: true }).first();
  await control.click();
  await page.getByRole('button', { name: 'Resume uploads', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Resume uploads', exact: true }).click();
  await page.getByRole('button', { name: 'Pause uploads', exact: true }).first().waitFor();
  checks.push('Device upload pause/resume');
  // Exercise setup recovery and cancellation through actual server actions.
  await page.goto(fixture.site + '/storage');
  await page.getByRole('button', { name: 'Connect storage', exact: true }).click();
  await page.getByRole('button', { name: 'Amazon S3', exact: true }).click();
  let wizard = page.locator('div.surface').filter({ has: page.getByRole('heading', { name: 'Connect storage', exact: true }) });
  await wizard.getByLabel('Destination name', { exact: true }).fill('GUI audit AWS draft');
  await wizard.getByLabel('Bucket', { exact: true }).fill('gui-audit-recordings');
  await wizard.getByRole('button', { name: 'Continue', exact: true }).click();
  await wizard.getByLabel('Role ARN', { exact: true }).waitFor();
  const externalId = await wizard.locator('code').innerText();
  assert.match(externalId, /^[0-9a-f]{40}$/);
  await wizard.getByRole('button', { name: 'Finish later', exact: true }).click();
  await page.reload();
  let draftCard = page.locator('li.surface').filter({ has: page.getByRole('heading', { name: 'GUI audit AWS draft', exact: true }) });
  await draftCard.getByRole('button', { name: 'Resume setup', exact: true }).click();
  wizard = draftCard.locator('div.surface');
  assert.equal(await wizard.locator('code').innerText(), externalId);
  await wizard.getByRole('button', { name: 'Cancel setup', exact: true }).click();
  await draftCard.waitFor({ state: 'detached' });
  await page.reload();
  assert.equal(await page.getByRole('heading', { name: 'GUI audit AWS draft', exact: true }).count(), 0);
  checks.push('AWS unfinished setup survives reload with same external ID; cancellation closes server draft');

  // The local fixture explicitly approves just the MinIO loopback origin.
  assert.ok(fixture.storage_secret_access_key, 'Run with HARDHAT_TEST_GUI=1');
  await page.getByRole('button', { name: 'Connect storage', exact: true }).click();
  await page.getByRole('button', { name: 'MinIO / S3-compatible', exact: true }).click();
  wizard = page.locator('div.surface').filter({ has: page.getByRole('heading', { name: 'Connect storage', exact: true }) });
  await wizard.getByLabel('Destination name', { exact: true }).fill('GUI lifecycle MinIO');
  await wizard.getByLabel('Endpoint URL', { exact: true }).fill(fixture.storage_endpoint);
  await wizard.getByLabel('Bucket', { exact: true }).fill(fixture.bucket);
  await wizard.getByLabel('Access key ID', { exact: true }).fill(fixture.storage_access_key_id);
  await wizard.getByLabel('Secret access key', { exact: true }).fill(fixture.storage_secret_access_key);
  await wizard.getByLabel('Make this the default destination').check();
  await wizard.getByRole('button', { name: 'Test and connect', exact: true }).click();
  const account = () => page.locator('li.surface').filter({ has: page.getByRole('heading', { name: 'GUI lifecycle MinIO', exact: true }) });
  await account().getByText('Connected', { exact: true }).waitFor();
  assert.equal((await page.content()).includes(fixture.storage_secret_access_key), false);
  checks.push('GUI creates and verifies MinIO connection with encrypted server-side credentials');
  await account().getByRole('button', { name: 'Replace credentials', exact: true }).click();
  wizard = account().locator('div.surface');
  await wizard.getByLabel('Access key ID', { exact: true }).fill(fixture.storage_access_key_id);
  await wizard.getByLabel('Secret access key', { exact: true }).fill('deliberately-invalid-fixture-secret');
  await wizard.getByRole('button', { name: 'Test and connect', exact: true }).click();
  await wizard.getByRole('alert').waitFor();
  await wizard.getByLabel('Access key ID', { exact: true }).fill(fixture.storage_access_key_id);
  await wizard.getByLabel('Secret access key', { exact: true }).fill(fixture.storage_secret_access_key);
  await wizard.getByRole('button', { name: 'Test and connect', exact: true }).click();
  await account().getByRole('button', { name: 'Replace credentials', exact: true }).waitFor();
  await account().getByText('Connection history', { exact: true }).click();
  await account().getByText(/Credentials replaced/).waitFor();
  await account().getByRole('button', { name: 'Disconnect', exact: true }).click();
  await account().getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
  await page.reload();
  await account().getByRole('button', { name: 'Reconnect', exact: true }).click();
  wizard = account().locator('div.surface');
  await wizard.getByLabel('Access key ID', { exact: true }).fill(fixture.storage_access_key_id);
  await wizard.getByLabel('Secret access key', { exact: true }).fill(fixture.storage_secret_access_key);
  await wizard.getByLabel('Make this the default destination').check();
  await wizard.getByRole('button', { name: 'Test and connect', exact: true }).click();
  await account().getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
  assert.equal((await page.content()).includes(fixture.storage_secret_access_key), false);
  checks.push('Failed replacement preserves connection; valid replacement, disconnect, and reconnect work through GUI');
  const scans = [];
  for (const colorScheme of ['light','dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440,320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const route of ['/captures','/storage']) {
        await page.goto(fixture.site+route); await page.locator('h1').waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), route+' overflow');
        const scan = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
        if (scan.violations.length) throw Error(JSON.stringify(scan.violations.map(v => ({id:v.id,nodes:v.nodes.map(n => ({target:n.target,summary:n.failureSummary}))}))));
        scans.push(`${colorScheme} ${width} ${route}`);
        await page.screenshot({ path: path.join(screenshots, `${colorScheme}-${width}-${route.slice(1)}.png`), fullPage:true });
      }
    }
  }
  assert.deepEqual(errors, []);
  await browser.close();
  process.stdout.write(JSON.stringify({ checks, scans, runtime_errors:errors, accessibility_violations:0 }));
})().catch(e=>{ console.error(e);process.exit(1); });
