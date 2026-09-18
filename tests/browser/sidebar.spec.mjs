import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

async function startReport(page, source = 'google_ads') {
  await page.locator('#new-report').click();
  await page.locator('#report-provider').selectOption(source);
  await expect(page.locator('#report-connection')).not.toHaveValue('');
}

async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
}

async function rpc(page, method, ...args) {
  return page.evaluate(({ method, args }) => new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[method](...args);
  }), { method, args });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.report-card')).toHaveCount(3);
  await expect(page.locator('#boot-state')).toBeHidden();
});

test('sidebar navigation stays inside its viewport and captures the three primary views', async ({ page }, testInfo) => {
  await mkdir('data/screenshots', { recursive: true });
  const suffix = testInfo.project.name === 'sidebar-300' ? '-300' : '';
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/sidebar-home' + suffix + '.png', fullPage: true });
  await startReport(page);
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/report-builder' + suffix + '.png', fullPage: true });
  await page.locator('#tab-connections').click();
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/connections' + suffix + '.png', fullPage: true });
  await expect(page.locator('#preview-banner')).toContainText('Sample data');
});

test('create, preview, save, edit and run a reusable report', async ({ page }) => {
  await startReport(page);
  await page.locator('#report-name').fill('QA daily spend');
  await page.locator('#target-sheet').fill('QA Campaigns');
  await page.locator('#target-cell').fill('B3');
  await page.locator('#date-preset').selectOption('last7');
  await page.locator('#report-schedule').selectOption('daily');
  await page.locator('#preview-report').click();
  await expect(page.locator('#data-preview')).toBeVisible();
  await expect(page.locator('#preview-table tbody tr')).toHaveCount(8);
  await expect(page.locator('#preview-metadata')).toContainText('EUR');
  await expect(page.locator('#preview-metadata')).toContainText('Europe/Athens');
  await expect(page.locator('#preview-metadata')).toContainText('No provider requests');
  await noOverflow(page);
  await page.locator('#save-report').click();
  await expect(page.locator('#report-count')).toHaveText('4');
  const card = page.locator('.report-card').filter({ hasText: 'QA daily spend' });
  await expect(card).toContainText('QA Campaigns');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#date-preset')).toHaveValue('last7');
  await expect(page.locator('#target-cell')).toHaveValue('B3');
  await page.locator('#report-name').fill('QA weekly spend');
  await page.locator('#report-schedule').selectOption('weekly');
  await page.locator('#save-report').click();
  await expect(page.locator('#report-count')).toHaveText('4');
  const edited = page.locator('.report-card').filter({ hasText: 'QA weekly spend' });
  await expect(edited).toContainText('Weekly');
  await edited.getByRole('button', { name: /Run/ }).click();
  await expect(page.locator('#notice')).toContainText('8 rows updated');
  await expect(edited).toContainText('8 rows');
  const saved = (await rpc(page, 'dmvBootstrap')).reports.find(report => report.name === 'QA weekly spend');
  expect(saved.target).toEqual({ sheetName: 'QA Campaigns', startCell: 'B3' });
  expect(saved.schedule).toBe('weekly');
});

test('failed report save retains the draft and retry creates one report', async ({ page }) => {
  await startReport(page, 'ga4');
  await page.locator('#report-name').fill('Keep this draft');
  await page.locator('#target-sheet').fill('Draft output');
  await page.evaluate(() => { window.DATAMOOV_PREVIEW_FAIL_NEXT = 'dmvSaveReport'; });
  await page.locator('#save-report').click();
  await expect(page.locator('#notice')).toContainText('Simulated request failure');
  await expect(page.locator('#report-name')).toHaveValue('Keep this draft');
  await expect(page.locator('#target-sheet')).toHaveValue('Draft output');
  await expect(page.locator('#save-report')).toBeEnabled();
  await expect(page.locator('#report-count')).toHaveText('3');
  await page.locator('#save-report').click();
  await expect(page.locator('#report-count')).toHaveText('4');
  await expect(page.locator('.report-card').filter({ hasText: 'Keep this draft' })).toHaveCount(1);
});

test('Google authorization fields follow mode and saved secrets stay blank on edit', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#connection-provider').selectOption('google_ads');
  await expect(page.locator('#auth-authMode')).toHaveValue('native');
  await expect(page.locator('#auth-accessToken')).toBeHidden();
  await expect(page.locator('#auth-serviceAccountJson')).toBeHidden();
  await page.locator('#auth-authMode').selectOption('token');
  await expect(page.locator('#auth-accessToken')).toBeVisible();
  await expect(page.locator('#auth-serviceAccountJson')).toBeHidden();
  await page.locator('#auth-authMode').selectOption('service_account');
  await expect(page.locator('#auth-accessToken')).toBeHidden();
  await expect(page.locator('#auth-serviceAccountJson')).toBeVisible();
  const connection = page.locator('.connection-card').filter({ hasText: 'Google Ads' }).first();
  await connection.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#auth-developerToken')).toHaveValue('');
  await expect(page.locator('#auth-developerToken')).toHaveAttribute('placeholder', /leave blank to keep/);
  await page.locator('#connection-label').fill('Marketing account renamed');
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  const saved = (await rpc(page, 'dmvBootstrap')).connections.find(item => item.label === 'Marketing account renamed');
  expect(saved.configuredFields).toContain('developerToken');
  expect(saved.values).not.toHaveProperty('developerToken');
  expect(saved.values).not.toHaveProperty('serviceAccountJson');
  await page.locator('.connection-card').filter({ hasText: 'Marketing account renamed' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#auth-developerToken')).toHaveValue('');
});

test('discovery and custom date/configuration selections survive save and edit', async ({ page }) => {
  await startReport(page, 'hubspot');
  await page.locator('#config-dateField').selectOption('closedate');
  await page.locator('#date-preset').selectOption('custom');
  await page.locator('#start-date').fill('2026-08-01');
  await page.locator('#end-date').fill('2026-08-31');
  await page.locator('#discover-fields').click();
  await expect(page.locator('#notice')).toContainText('Columns loaded');
  const checkboxes = page.locator('#column-list input[type=checkbox]');
  expect(await checkboxes.count()).toBeGreaterThan(2);
  await checkboxes.first().uncheck();
  await page.locator('#report-name').fill('August closed deals');
  await page.locator('#target-sheet').fill('August Deals');
  await page.locator('#save-report').click();
  await expect(page.locator('#report-count')).toHaveText('4');
  await page.locator('.report-card').filter({ hasText: 'August closed deals' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#config-dateField')).toHaveValue('closedate');
  await expect(page.locator('#date-preset')).toHaveValue('custom');
  await expect(page.locator('#start-date')).toHaveValue('2026-08-01');
  await expect(page.locator('#end-date')).toHaveValue('2026-08-31');
  await expect(page.locator('#column-list input[type=checkbox]').first()).not.toBeChecked();
});

test('discovered database columns render and initial load failure can be retried', async ({ page }) => {
  await startReport(page, 'bigquery');
  await page.locator('#config-projectId').fill('demo-analytics');
  await page.locator('#config-sql').fill('SELECT current_date() AS date, 0 AS orders, 0 AS revenue');
  await page.locator('#discover-fields').click();
  await expect(page.locator('#column-list input[type=checkbox]')).toHaveCount(3);
  await page.locator('#preview-report').click();
  await expect(page.locator('#preview-table tbody tr')).toHaveCount(8);
  await noOverflow(page);
  await page.locator('#tab-reports').click();
  await page.evaluate(() => { window.DATAMOOV_PREVIEW_FAIL_NEXT = 'dmvBootstrap'; });
  await page.locator('#refresh-reports').click();
  await expect(page.locator('#retry-bootstrap')).toBeVisible();
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#retry-bootstrap').click();
  await expect(page.locator('#retry-bootstrap')).toBeHidden();
  await expect(page.locator('#report-count')).toHaveText('3');
});
test('failed connection save retains entered credentials and clears them only after successful retry', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#connection-provider').selectOption('hubspot');
  await page.locator('#connection-label').fill('QA CRM connection');
  await page.locator('#auth-accessToken').fill('offline-example-token');
  const count = await page.locator('.connection-card').count();
  await page.evaluate(() => { window.DATAMOOV_PREVIEW_FAIL_NEXT = 'dmvSaveConnection'; });
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Simulated request failure');
  await expect(page.locator('#connection-label')).toHaveValue('QA CRM connection');
  await expect(page.locator('#auth-accessToken')).toHaveValue('offline-example-token');
  await expect(page.locator('.connection-card')).toHaveCount(count);
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  await expect(page.locator('.connection-card')).toHaveCount(count + 1);
  await expect(page.locator('#auth-accessToken')).toHaveValue('');
  await expect(page.locator('#connection-label')).toHaveValue('');
});
test('field discovery selects only declared defaults and retains unmarked-schema compatibility', async ({ page }) => {
  await startReport(page, 'ga4');
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_DISCOVERY_FIELDS = [
      { key: 'date', label: 'Date', type: 'date', default: true },
      { key: 'sessions', label: 'Sessions', type: 'number', default: false },
      { key: 'customDimension', label: 'Custom dimension', type: 'text' },
    ];
  });
  await page.locator('#discover-fields').click();
  await expect(page.locator('#column-list input')).toHaveCount(3);
  await expect(page.locator('#column-list input[value="date"]')).toBeChecked();
  await expect(page.locator('#column-list input[value="sessions"]')).not.toBeChecked();
  await expect(page.locator('#column-list input[value="customDimension"]')).not.toBeChecked();
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_DISCOVERY_FIELDS = [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'orders', label: 'Orders', type: 'number' },
    ];
  });
  await page.locator('#discover-fields').click();
  await expect(page.locator('#column-list input:checked')).toHaveCount(2);
});