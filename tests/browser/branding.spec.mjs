import { test, expect } from '@playwright/test';
test('header identifies DataMoov by JustDataPlease and keeps its tagline below without overflow', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('.report-card')).toHaveCount(3);
  const title = page.locator('.brand strong');
  const tagline = page.locator('.brand-title > span');
  await expect(title).toHaveText('DataMoov by JustDataPlease');
  await expect(tagline).toHaveText('YOUR DATA, IN SHEETS');
  const headingBounds = await title.boundingBox();
  const taglineBounds = await tagline.boundingBox();
  expect(taglineBounds.y).toBeGreaterThanOrEqual(headingBounds.y + headingBounds.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  await page.locator('.app-header').screenshot({ path: testInfo.outputPath('branding.png') });
});
