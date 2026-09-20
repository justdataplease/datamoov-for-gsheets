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
  // Security software on the host injects a password-manager balloon over password fields in the
  // real Chrome build; it is not part of the sidebar and must not intercept clicks.
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
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
  await page.locator('#new-connection').click();
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/connection-editor' + suffix + '.png', fullPage: true });
  await page.locator('#tab-settings').click();
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/settings' + suffix + '.png', fullPage: true });
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

test('paused reports preserve the previous output details and resume after refreshing the list', async ({ page }) => {
  const card = page.locator('.report-card').filter({ hasText: 'Campaign performance' });
  const updated = card.locator('.card-detail').filter({ hasText: 'Updated' });
  const previousUpdated = await updated.textContent();
  const previous = (await rpc(page, 'dmvBootstrap')).reports[0];
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_PENDING_NEXT = { ok: true, pending: true, rowCount: 4, message: 'Report paused.' };
  });
  await card.getByRole('button', { name: /Run/ }).click();
  await expect(card.locator('.status')).toHaveText('Paused');
  await expect(card.getByRole('button', { name: /Resume/ })).toBeEnabled();
  await expect(updated).toHaveText(previousUpdated);
  await expect(page.locator('#notice')).toContainText('4 rows fetched');
  await expect(page.locator('#notice')).toContainText('Existing sheet output is unchanged');
  await expect(page.locator('#notice')).toContainText('hourly scheduler');
  await expect(page.locator('#notice')).toHaveClass('notice info');
  const paused = (await rpc(page, 'dmvBootstrap')).reports[0];
  expect(paused.status).toBe('paused');
  expect(paused.fetchedRowCount).toBe(4);
  expect(paused.lastRun).toBe(previous.lastRun);
  expect(paused.lastRowCount).toBe(previous.lastRowCount);

  await page.locator('#refresh-reports').click();
  await expect(page.locator('#boot-state')).toBeHidden();
  await expect(card.locator('.status')).toHaveText('Paused');
  await expect(card.locator('.card-progress')).toContainText('4 rows fetched');
  await expect(updated).toHaveText(previousUpdated);
  await noOverflow(page);
  await card.getByRole('button', { name: /Resume/ }).click();
  await expect(page.locator('#notice')).toContainText('8 rows updated');
  await expect(card.locator('.status')).toHaveText('Up to date');
  await expect(card.locator('.card-progress')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Run/ })).toBeEnabled();
  expect((await rpc(page, 'dmvBootstrap')).reports[0]).not.toHaveProperty('fetchedRowCount');
});

test('a saved paused report without previous output stays not run until continuation completes', async ({ page }) => {
  const template = (await rpc(page, 'dmvBootstrap')).reports[0];
  await rpc(page, 'dmvSaveReport', {
    ...template,
    id: undefined,
    name: 'Paused first refresh',
    status: 'paused',
    fetchedRowCount: 0,
    lastRun: undefined,
    lastRowCount: undefined,
  });
  await page.locator('#refresh-reports').click();
  const card = page.locator('.report-card').filter({ hasText: 'Paused first refresh' });
  await expect(card.locator('.status')).toHaveText('Paused');
  await expect(card).toContainText('Not run yet');
  await expect(card.locator('.card-progress')).toContainText('0 rows fetched');
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_PENDING_NEXT = { ok: true, pending: true, rowCount: 3 };
  });
  await card.getByRole('button', { name: /Resume/ }).click();
  await expect(card.locator('.card-progress')).toContainText('3 rows fetched');
  await expect(card).toContainText('Not run yet');
  await expect(card.locator('.status')).toHaveText('Paused');
  await card.getByRole('button', { name: /Resume/ }).click();
  await expect(page.locator('#notice')).toContainText('8 rows updated');
  await expect(card.locator('.status')).toHaveText('Up to date');
  await expect(card).not.toContainText('Not run yet');
});

test('chat needs an AI provider set up under Settings, then answers with activity lines, option chips and a new-chat reset', async ({ page }) => {
  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat-setup')).toBeVisible();
  await expect(page.locator('#chat-ready')).toBeHidden();
  await page.locator('#chat-open-settings').click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await expect(page.locator('#ai-settings')).toHaveAttribute('open', '');
  await expect(page.locator('#ai-settings-status')).toHaveText('Not set up');
  await expect(page.locator('#ai-model')).toHaveValue('claude-opus-5');
  await page.locator('#ai-provider').selectOption('gemini');
  await expect(page.locator('#ai-model')).toHaveValue('gemini-3.8-flash');
  await expect(page.locator('#ai-key-help')).toContainText('aistudio');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-key')).toBeFocused();
  await page.locator('#ai-key').fill('offline-preview-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#notice')).toContainText('AI provider saved');
  await expect(page.locator('#ai-settings')).not.toHaveAttribute('open', '');
  await expect(page.locator('#ai-settings-status')).toHaveText('Google Gemini · gemini-3.8-flash');
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/settings.png', fullPage: true });
  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat-setup')).toBeHidden();
  await expect(page.locator('#chat-ready')).toBeVisible();
  await expect(page.locator('#ai-status')).toContainText('Google Gemini · gemini-3.8-flash');
  await expect(page.locator('#chat-suggestions .chip')).toHaveCount(3);
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/chat-ready.png', fullPage: true });
  await page.locator('#chat-input').fill('Which account?');
  await page.locator('#chat-send').click();
  await expect(page.locator('.chat-message.user')).toHaveText('Which account?');
  await expect(page.locator('.chat-message.assistant .chip')).toHaveCount(2);
  await page.locator('.chat-message.assistant .chip').first().click();
  await expect(page.locator('.chat-message.user').nth(1)).toHaveText('Use Google Ads.');
  await expect(page.locator('.chat-message.assistant').nth(1)).toContainText('Brand search spent EUR 4,120.50');
  await expect(page.locator('.chat-message.assistant').nth(1).locator('.chat-events li')).toHaveCount(3);
  await expect(page.locator('#chat-send')).toBeEnabled();
  await noOverflow(page);
  await page.screenshot({ path: 'data/screenshots/chat-answer.png', fullPage: true });
  await page.locator('#chat-settings-toggle').click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await expect(page.locator('#ai-settings')).toHaveAttribute('open', '');
  await expect(page.locator('#ai-key')).toHaveAttribute('placeholder', /leave blank to keep/);
  await page.locator('#ai-test').click();
  await expect(page.locator('#notice')).toContainText('replied: OK');
  await page.locator('#tab-chat').click();
  await page.locator('#chat-new').click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await expect(page.locator('#chat-suggestions .chip')).toHaveCount(3);
  await expect(page.locator('#chat-new')).toBeHidden();
  const bootstrap = await rpc(page, 'dmvBootstrap');
  expect(JSON.stringify(bootstrap)).not.toContain('offline-preview-key');
});

test('a connection picks a saved credential or adds one inline; Google defaults to a service account key with a guide per mode', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('google_ads');
  await expect(page.locator('#connection-credential')).toHaveValue('demo-credential-google');
  await expect(page.locator('#connection-credential-help')).toContainText('Google Cloud');
  await expect(page.locator('#credential-inline')).toBeHidden();
  await expect(page.locator('#auth-customerId')).toBeEditable();
  await page.locator('#connection-credential').selectOption('__new');
  await expect(page.locator('#credential-inline')).toBeVisible();
  await expect(page.locator('#auth-authMode')).toHaveValue('service_account');
  await expect(page.locator('#auth-serviceAccountJson')).toBeVisible();
  await expect(page.locator('#auth-accessToken')).toBeHidden();
  for (const key of ['clientId','clientSecret','refreshToken']) await expect(page.locator('#auth-'+key)).toBeHidden();
  await expect(page.locator('#setup-guide')).toBeVisible();
  await page.locator('#setup-guide summary').click();
  await expect(page.locator('#setup-guide-body')).toContainText('Service accounts');
  await expect(page.locator('#setup-guide-body')).toContainText('Access and security');
  await expect(page.locator('#setup-guide-body a.chip').first()).toHaveAttribute('target', '_blank');
  await page.locator('#auth-authMode').selectOption('oauth');
  for (const key of ['clientId','clientSecret','refreshToken']) await expect(page.locator('#auth-'+key)).toBeVisible();
  await expect(page.locator('#setup-guide-body')).toContainText('refresh token');
  await expect(page.locator('#account-discovery')).toBeVisible();
  await expect(page.locator('#auth-serviceAccountJson')).toBeHidden();
  await page.locator('#auth-authMode').selectOption('token');
  await expect(page.locator('#auth-accessToken')).toBeVisible();
  await noOverflow(page);
  await page.locator('#connection-provider').selectOption('hubspot');
  await expect(page.locator('#connection-credential')).toHaveValue('demo-credential-hubspot');
  await expect(page.locator('#setup-guide-body')).toContainText('Private apps');
  await expect(page.locator('#account-discovery')).toBeHidden();
  await page.locator('#connection-provider').selectOption('postgres');
  await expect(page.locator('#auth-chatSchemas')).toHaveValue('public');
  await expect(page.locator('#auth-host')).toBeEditable();
  // Editing keeps the saved credential selected and never shows its secrets.
  await page.locator('#cancel-connection').click();
  await expect(page.locator('#panel-connections')).toBeVisible();
  const connection = page.locator('#connections-list .connection-card').filter({ hasText: 'Google Ads' }).first();
  await expect(connection).toContainText('Google Cloud · Demo key');
  await connection.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('#connection-credential')).toHaveValue('demo-credential-google');
  await expect(page.locator('#credential-inline')).toBeHidden();
  await expect(page.locator('#auth-customerId')).toHaveValue('1234567890');
  await page.locator('#connection-label').fill('Marketing account renamed');
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved and verified');
  const saved = (await rpc(page, 'dmvBootstrap')).connections.find(item => item.label === 'Marketing account renamed');
  expect(saved.credentialId).toBe('demo-credential-google');
  expect(saved.values).not.toHaveProperty('serviceAccountJson');
  // A second Google source reuses the same credential from the dropdown.
  await expect(page.locator('#panel-connections')).toBeVisible();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('ga4');
  await expect(page.locator('#connection-credential')).toHaveValue('demo-credential-google');
  await page.locator('#connection-label').fill('Second property');
  await page.locator('#auth-propertyId').fill('987654');
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  await expect(page.locator('.connection-card').filter({ hasText: 'Second property' })).toContainText('Google Cloud · Demo key');
  await page.locator('#tab-settings').click();
  await expect(page.locator('#credentials-list .connection-card').filter({ hasText: 'Google Cloud · Demo key' })).toContainText('5 connections');
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
test('a new inline credential is kept when the connection save fails, and the retry reuses it', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('hubspot');
  await page.locator('#connection-label').fill('QA CRM connection');
  await page.locator('#connection-credential').selectOption('__new');
  await page.locator('#inline-credential-label').fill('QA private app');
  await page.locator('#auth-accessToken').fill('offline-example-token');
  const count = (await rpc(page, 'dmvBootstrap')).connections.length;
  const credentials = (await rpc(page, 'dmvBootstrap')).credentials.length;
  await page.evaluate(() => { window.DATAMOOV_PREVIEW_FAIL_NEXT = 'dmvSaveConnection'; });
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Simulated request failure');
  await expect(page.locator('#connection-label')).toHaveValue('QA CRM connection');
  expect((await rpc(page, 'dmvBootstrap')).connections.length).toBe(count);
  const created = (await rpc(page, 'dmvBootstrap')).credentials;
  expect(created.length).toBe(credentials + 1);
  await expect(page.locator('#connection-credential')).toHaveValue(created.find(item => item.label === 'QA private app').id);
  await expect(page.locator('#credential-inline')).toBeHidden();
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  await expect(page.locator('#connections-list .connection-card')).toHaveCount(count + 1);
  expect((await rpc(page, 'dmvBootstrap')).credentials.length).toBe(credentials + 1, 'no duplicate credential on retry');
  await expect(page.locator('#connections-list .connection-card').filter({ hasText: 'QA CRM connection' })).toContainText('QA private app');
  await expect(page.locator('#panel-connections')).toBeVisible();
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

test('Find accounts works with a saved credential, fills the ID, and saving never requires it', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('ga4');
  await page.locator('#connection-label').fill('Selected Google property');
  await expect(page.locator('#connection-credential')).toHaveValue('demo-credential-google');
  await expect(page.locator('#auth-propertyId')).toBeEditable();
  await page.locator('#discover-accounts').click();
  await expect(page.locator('#discovered-account option')).toHaveCount(3);
  await expect(page.locator('#discovered-account')).toHaveValue('');
  await expect(page.locator('#account-discovery-status')).toContainText('Choose an account');
  await page.locator('#discovered-account').selectOption('1');
  await expect(page.locator('#auth-propertyId')).toHaveValue('900000002');
  await expect(page.locator('#account-discovery-status')).toContainText('filled in above');
  await noOverflow(page);
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  const saved=(await rpc(page,'dmvBootstrap')).connections.find(item=>item.label==='Selected Google property');
  expect(saved.values.propertyId).toBe('900000002');
  expect(saved.credentialId).toBe('demo-credential-google');
  await expect(page.locator('.connection-card').filter({ hasText: 'Selected Google property' })).toContainText('900000002');
});

test('discovered choices reset when the credential changes while typed IDs stay editable in every mode', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('google_ads');
  await page.locator('#discover-accounts').click();
  await expect(page.locator('#discovered-account option')).toHaveCount(3);
  await page.locator('#discovered-account').selectOption('0');
  await expect(page.locator('#auth-customerId')).toHaveValue('900000001');
  await page.locator('#connection-credential').selectOption('__new');
  await expect(page.locator('#discovered-account')).toBeDisabled();
  await expect(page.locator('#auth-customerId')).toHaveValue('900000001');
  await page.locator('#auth-developerToken').fill('offline-developer-token');
  await page.locator('#discover-accounts').click();
  await expect(page.locator('#discovered-account option')).toHaveCount(3);
  await page.locator('#auth-developerToken').fill('different-developer-token');
  await expect(page.locator('#discovered-account')).toBeDisabled();
  await page.locator('#auth-authMode').selectOption('token');
  await expect(page.locator('#account-discovery')).toBeVisible();
  await page.locator('#auth-customerId').fill('5555555555');
  await page.locator('#auth-accessToken').fill('offline-token');
  await expect(page.locator('#auth-customerId')).toHaveValue('5555555555');
  await page.locator('#auth-authMode').selectOption('service_account');
  await expect(page.locator('#auth-customerId')).toHaveValue('5555555555');
});

test('discovery handles empty accounts, errors and stale provider responses', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('ga4');
  await page.evaluate(()=>{window.DATAMOOV_PREVIEW_ACCOUNTS=[];});
  await page.locator('#discover-accounts').click();
  await expect(page.locator('#account-discovery-status')).toContainText('No accessible accounts');
  await expect(page.locator('#discovered-account')).toBeDisabled();
  await page.evaluate(()=>{delete window.DATAMOOV_PREVIEW_ACCOUNTS;window.DATAMOOV_PREVIEW_FAIL_NEXT='dmvDiscoverAccounts';});
  await page.locator('#discover-accounts').click();
  await expect(page.locator('#account-discovery-status')).toContainText('Review the provider access requirements');
  await page.evaluate(()=>{delete window.DATAMOOV_PREVIEW_LAST_ACCOUNT_REQUEST;});
  await page.locator('#discover-accounts').click();
  await page.locator('#connection-provider').selectOption('google_ads');
  await page.waitForFunction(()=>window.DATAMOOV_PREVIEW_LAST_ACCOUNT_REQUEST?.connectorId==='ga4');
  await expect(page.locator('#discovered-account option')).toHaveCount(1);
  await expect(page.locator('#discovered-account')).toBeDisabled();
  await expect(page.locator('#auth-customerId')).toHaveValue('');
});

test('an inline OAuth credential requires a grant, survives a failed connection save, and keeps its secrets redacted', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('ga4');
  await page.locator('#connection-label').fill('Own OAuth analytics');
  await page.locator('#connection-credential').selectOption('__new');
  await page.locator('#inline-credential-label').fill('Own OAuth client');
  await page.locator('#auth-authMode').selectOption('oauth');
  await expect(page.locator('#auth-propertyId')).toBeEditable();
  await page.locator('#auth-propertyId').fill('654321');
  await expect(page.locator('#inline-credential-fields')).toContainText('alone do not grant account access');
  await expect(page.locator('#inline-credential-fields')).toContainText('already granted for this client');
  await expect(page.locator('#inline-credential-fields')).toContainText('access tokens automatically');
  const before=(await rpc(page,'dmvBootstrap')).connections.length;
  for (const [key,value] of [['clientId','offline-client.apps.googleusercontent.com'],['clientSecret','offline-client-secret'],['refreshToken','offline-refresh-token']]) {
    await page.locator('#save-connection').click();
    await expect(page.locator('#auth-'+key)).toBeFocused();
    expect((await rpc(page,'dmvBootstrap')).connections.length).toBe(before);
    await page.locator('#auth-'+key).fill(value);
  }
  await expect(page.locator('#auth-clientSecret')).toHaveAttribute('type','password');
  await expect(page.locator('#auth-refreshToken')).toHaveAttribute('type','password');
  await page.evaluate(()=>{window.DATAMOOV_PREVIEW_FAIL_NEXT='dmvSaveConnection';});
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Simulated request failure');
  await expect(page.locator('#credential-inline')).toBeHidden();
  await expect(page.locator('#connection-credential')).not.toHaveValue('__new');
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  const bootstrap=await rpc(page,'dmvBootstrap');
  const saved=bootstrap.connections.find(item=>item.label==='Own OAuth analytics');
  const credential=bootstrap.credentials.find(item=>item.label==='Own OAuth client');
  expect(saved.credentialId).toBe(credential.id);
  expect(saved.values).toMatchObject({propertyId:'654321',authMode:'oauth',clientId:'offline-client.apps.googleusercontent.com'});
  expect(credential.values).toMatchObject({authMode:'oauth',clientId:'offline-client.apps.googleusercontent.com'});
  expect(credential.configuredFields).toEqual(expect.arrayContaining(['clientSecret','refreshToken']));
  expect(JSON.stringify(bootstrap)).not.toContain('offline-client-secret');
  expect(JSON.stringify(bootstrap)).not.toContain('offline-refresh-token');
  await page.locator('#connections-list .connection-card').filter({hasText:'Own OAuth analytics'}).getByRole('button',{name:'Edit',exact:true}).click();
  await expect(page.locator('#connection-credential')).toHaveValue(credential.id);
  await expect(page.locator('#credential-inline')).toBeHidden();
  await page.locator('#connection-label').fill('Renamed own OAuth');
  await page.locator('#save-connection').click();
  await expect(page.locator('#notice')).toContainText('Connection saved');
  // The credential itself is edited under Settings; secrets stay blank there too.
  await page.locator('#tab-settings').click();
  await page.locator('#credentials-list .connection-card').filter({hasText:'Own OAuth client'}).getByRole('button',{name:'Edit',exact:true}).click();
  await expect(page.locator('#credential-editor')).toBeVisible();
  await expect(page.locator('#credential-family')).toBeDisabled();
  for (const key of ['clientSecret','refreshToken']) {
    await expect(page.locator('#cred-'+key)).toHaveValue('');
    await expect(page.locator('#cred-'+key)).toHaveAttribute('placeholder',/leave blank to keep/);
  }
  await expect(page.locator('#cred-clientId')).toHaveValue('offline-client.apps.googleusercontent.com');
  await page.locator('#credential-label').fill('Own OAuth client (renamed)');
  await page.locator('#save-credential').click();
  await expect(page.locator('#notice')).toContainText('Credential saved');
  const renamed=(await rpc(page,'dmvBootstrap')).credentials.find(item=>item.label==='Own OAuth client (renamed)');
  expect(renamed.configuredFields).toEqual(expect.arrayContaining(['clientSecret','refreshToken']));
});

test('a discovered ID survives switching modes, and a provider change clears inline credentials', async ({ page }) => {
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('ga4');
  await page.locator('#discover-accounts').click();
  await expect(page.locator('#discovered-account option')).toHaveCount(3);
  await page.locator('#discovered-account').selectOption('0');
  await page.locator('#connection-credential').selectOption('__new');
  await page.locator('#auth-authMode').selectOption('oauth');
  await expect(page.locator('#auth-propertyId')).toHaveValue('900000001');
  await expect(page.locator('#auth-propertyId')).toBeEditable();
  await page.locator('#auth-clientId').fill('offline-client');
  await page.locator('#auth-clientSecret').fill('offline-secret');
  await page.locator('#auth-refreshToken').fill('offline-refresh');
  await page.locator('#auth-authMode').selectOption('service_account');
  await expect(page.locator('#auth-propertyId')).toHaveValue('900000001');
  for (const key of ['clientId','clientSecret','refreshToken']) await expect(page.locator('#auth-'+key)).toBeDisabled();
  await page.locator('#connection-provider').selectOption('bigquery');
  await expect(page.locator('#auth-chatDatasets')).toBeVisible();
  await expect(page.locator('#connection-credential')).toHaveValue('demo-credential-google');
  await page.locator('#connection-credential').selectOption('__new');
  await page.locator('#auth-authMode').selectOption('oauth');
  for (const key of ['clientId','clientSecret','refreshToken']) await expect(page.locator('#auth-'+key)).toHaveValue('');
  await expect(page.locator('#account-discovery')).toBeHidden();
  await noOverflow(page);
});

test('the Settings tab manages credentials: add, guide per type, edit, and refuse removal while in use', async ({ page }) => {
  await page.locator('#tab-settings').click();
  await expect(page.locator('#credentials-card')).toHaveAttribute('open', '');
  const cards = page.locator('#credentials-list .connection-card');
  const before = await cards.count();
  expect(before).toBeGreaterThan(3);
  await expect(page.locator('#credential-editor')).toBeHidden();
  await page.locator('#new-credential').click();
  await expect(page.locator('#credential-editor')).toBeVisible();
  await page.locator('#credential-family').selectOption('google');
  await expect(page.locator('#credential-family-help')).toContainText('Google Ads');
  await expect(page.locator('#cred-authMode')).toHaveValue('service_account');
  await page.locator('#credential-guide summary').click();
  await expect(page.locator('#credential-guide-body')).toContainText('Service accounts');
  await page.locator('#credential-label').fill('Agency service account');
  await page.locator('#cred-serviceAccountJson').fill('{"type":"service_account","client_email":"robot@example.iam.gserviceaccount.com","private_key":"offline"}');
  await page.locator('#save-credential').click();
  await expect(page.locator('#notice')).toContainText('Credential saved and verified');
  await expect(cards).toHaveCount(before + 1);
  const card = cards.filter({ hasText: 'Agency service account' });
  await expect(card).toContainText('No connection yet');
  await expect(card).toContainText('Service account');
  await expect(page.locator('#credential-label')).toHaveValue('');
  await noOverflow(page);
  // The new credential is offered to every Google source.
  await page.locator('#tab-connections').click();
  await page.locator('#new-connection').click();
  await page.locator('#connection-provider').selectOption('search_console');
  await expect(page.locator('#connection-credential option')).toContainText(['Agency service account']);
  await page.locator('#tab-settings').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#credentials-list .connection-card').filter({ hasText: 'Google Cloud · Demo key' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('is used by');
  await expect(cards).toHaveCount(before + 1);
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('Credential removed');
  await expect(cards).toHaveCount(before);
});

test('a pending turn blocks New chat and provider removal until its answer lands', async ({ page }) => {
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-preview-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat-ready')).toBeVisible();
  await page.locator('#chat-input').fill('Spend by campaign');
  await page.locator('#chat-send').click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(1);
  await page.evaluate(() => { window.DATAMOOV_PREVIEW_DELAY_MS = 1500; });
  await page.locator('#chat-input').fill('And clicks?');
  await page.locator('#chat-send').click();
  await expect(page.locator('#chat-working')).toBeVisible();
  await expect(page.locator('#chat-new')).toBeDisabled();
  await page.locator('#tab-settings').click();
  await expect(page.locator('#ai-remove')).toBeDisabled();
  await page.locator('#tab-chat').click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(2, { timeout: 5000 });
  await expect(page.locator('#chat-working')).toBeHidden();
  await expect(page.locator('#chat-new')).toBeEnabled();
  await page.locator('#chat-new').click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await expect(page.locator('#chat-suggestions .chip')).toHaveCount(3);
});

test('AI settings keep standing instructions and link to where each key is created', async ({ page }) => {
  await page.locator('#tab-settings').click();
  await expect(page.locator('#ai-key-help a')).toHaveAttribute('href', /console\.anthropic\.com/);
  await page.locator('#ai-provider').selectOption('gemini');
  await expect(page.locator('#ai-key-help a')).toHaveAttribute('href', /aistudio\.google\.com/);
  await page.locator('#ai-key').fill('offline-preview-key');
  await page.locator('#ai-instructions').fill('Spend is in EUR. Brand campaigns start with BR_.');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings')).not.toHaveAttribute('open', '');
  await page.locator('#ai-settings summary').click();
  await expect(page.locator('#ai-instructions')).toHaveValue('Spend is in EUR. Brand campaigns start with BR_.');
  expect((await rpc(page, 'dmvAiSettings')).instructions).toContain('EUR');
  await noOverflow(page);
});
