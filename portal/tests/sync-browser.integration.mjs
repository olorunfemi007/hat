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
