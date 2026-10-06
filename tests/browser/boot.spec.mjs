import { test, expect } from '@playwright/test';

// Opening the workspace waits on one Apps Script call. A call that never answers must not leave
// the sidebar or the larger window on its spinner: it gives up with a notice and Try again.

test('a workspace call that never answers offers Try again, and the retry opens the workspace', async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.DATAMOOV_PREVIEW_HANG_NEXT = 'dmvBootstrap';
  });
  await page.goto('/');
  await expect(page.locator('#boot-state')).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect(page.locator('#boot-state')).toBeVisible();
  await expect(page.locator('#retry-bootstrap')).toBeHidden();
  await page.clock.fastForward(40_000);
  await expect(page.locator('#boot-state')).toBeHidden();
  await expect(page.locator('#retry-bootstrap')).toBeVisible();
  await expect(page.locator('#notice')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('taking longer than usual');
  await page.locator('#retry-bootstrap').click();
  await expect(page.locator('.report-card')).toHaveCount(3);
  await expect(page.locator('#boot-state')).toBeHidden();
  await expect(page.locator('#retry-bootstrap')).toBeHidden();
  await expect(page.locator('#notice')).toBeHidden();
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
});

test('a slow workspace answer that arrives after the timeout still opens the workspace', async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(() => {
    window.DATAMOOV_PREVIEW_DELAY_MS = 70_000;
  });
  await page.goto('/');
  await page.clock.fastForward(60_000);
  await expect(page.locator('#retry-bootstrap')).toBeVisible();
  await expect(page.locator('#notice')).toContainText('taking longer than usual');
  await page.clock.fastForward(15_000);
  await expect(page.locator('.report-card')).toHaveCount(3);
  await expect(page.locator('#retry-bootstrap')).toBeHidden();
  await expect(page.locator('#notice')).toBeHidden();
});
