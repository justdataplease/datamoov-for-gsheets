import { test, expect } from '@playwright/test';

// The last line of Settings names the deployed commit and when it went live, in the
// viewer's own time zone. Local previews and tests have no stamp and show nothing.
test.use({ timezoneId: 'Europe/Athens' });

async function openSettings(page, build) {
  if (build) await page.addInitScript((value) => (window.DATAMOOV_PREVIEW_BUILD = value), build);
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
}

test('settings ends with the deployed version and local deployment time', async ({ page }, testInfo) => {
  await openSettings(page, {
    deployedAt: '2026-10-02T07:30:00.000Z',
    commit: 'a1b2c3d',
    dirty: false,
    target: 'development',
  });
  const line = page.locator('#build-stamp');
  await expect(line).toBeVisible();
  await expect(line).toHaveText('Version a1b2c3d · deployed 2 Oct 2026, 10:30 · development');
  expect(
    await page.evaluate(() => document.querySelector('#panel-settings').lastElementChild.id)
  ).toBe('build-stamp');
  const panel = await page.locator('#panel-settings').boundingBox();
  const box = await line.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(panel.x);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  await line.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('build-stamp.png') });
});

test('a production build with uncommitted changes says so and omits the target', async ({ page }) => {
  await openSettings(page, {
    deployedAt: '2026-10-02T07:30:00.000Z',
    commit: 'a1b2c3d',
    dirty: true,
    target: 'production',
  });
  await expect(page.locator('#build-stamp')).toHaveText(
    'Version a1b2c3d (modified) · deployed 2 Oct 2026, 10:30'
  );
});

test('without a build stamp the settings view shows no version line', async ({ page }) => {
  await openSettings(page);
  await expect(page.locator('#credentials-card')).toBeVisible();
  await expect(page.locator('#build-stamp')).toBeHidden();
  await expect(page.locator('#build-stamp')).toHaveText('');
});
