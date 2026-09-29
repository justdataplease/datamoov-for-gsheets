import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';

// Export to file writes the whole setup; Import from file reads it back, reports and
// dashboards included, and the result lists every kind.
async function open(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
}

test('export asks first, then downloads a version 2 settings file with every kind counted', async ({
  page,
}) => {
  await open(page);
  const button = page.locator('#export-settings');
  await expect(page.locator('#credential-import-help')).toContainText('keep it private');
  // Declining the confirmation downloads nothing.
  page.once('dialog', (dialog) => dialog.dismiss());
  await button.click();
  await expect(page.locator('#notice')).toBeHidden();
  page.once('dialog', (dialog) => {
    assert.match(dialog.message(), /clear text/);
    dialog.accept();
  });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  assert.equal(download.suggestedFilename(), 'datamoov-settings.json');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bundle = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(bundle.version, 2);
  assert.equal(bundle.reports.length, 3);
  assert.ok(bundle.reports.every((item) => item.connectionRef && item.target?.sheetName));
  assert.ok(Array.isArray(bundle.dashboards));
  await expect(page.locator('#notice')).toContainText('3 reports');
  await expect(page.locator('#notice')).toContainText('keep it private');
});

test('importing a version 2 file reports credentials, connections, reports and dashboards', async ({
  page,
}) => {
  await open(page);
  const exported = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).dmvExportSettings();
      })
  );
  const bundle = JSON.parse(exported.json);
  bundle.reports = [{ ...bundle.reports[0], ref: 'copy', name: 'Imported cost', target: { sheetName: 'Imported cost', startCell: 'A1' } }];
  bundle.dashboards = [
    {
      ref: 'imported-dashboard',
      name: 'Imported dashboard',
      target: { sheetName: 'Imported Dashboard' },
      datasets: [{ id: 'gads', label: 'Google Ads campaigns', sheetName: 'Imported Data', connectionRef: bundle.connections[0].ref, reportType: 'campaigns', fields: ['date', 'spend'], dateRange: { preset: 'last30' } }],
      tiles: [{ title: 'Spend', type: 'line' }],
      schedule: 'manual',
      at: null,
    },
  ];
  await page.locator('#credential-import-file').setInputFiles({
    name: 'datamoov-settings.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(bundle)),
  });
  const region = page.locator('#credential-import-result');
  await expect(region).toContainText('Import complete.');
  await expect(region).toContainText('Credentials: 0 added');
  await expect(region).toContainText('Reports: 1 added, 0 already saved, 0 failed.');
  await expect(region).toContainText('Dashboards: 1 added, 0 already saved, 0 failed.');
  await page.locator('#tab-reports').click();
  await expect(page.locator('#reports-list .report-card').filter({ hasText: 'Imported cost' })).toHaveCount(1);
  await expect(page.locator('#dashboards-list .dashboard-card').filter({ hasText: 'Imported dashboard' })).toHaveCount(1);
  await expect(page.locator('#dashboards-drafts')).toBeHidden();
});
