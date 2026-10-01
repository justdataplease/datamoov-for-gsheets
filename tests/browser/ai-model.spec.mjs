import { test, expect } from '@playwright/test';

async function noOverflow(page) {
  const sizes = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
}

async function rpc(page, method, ...args) {
  return page.evaluate(
    ({ method, args }) =>
      new Promise((resolve, reject) => {
        google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[method](...args);
      }),
    { method, args }
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await expect(page.locator('#ai-settings')).toHaveAttribute('open', '');
});

test('Test checks the typed model before the first save and offers similar models', async ({
  page,
}) => {
  const model = page.locator('#ai-model');
  const result = page.locator('#ai-model-result');
  const useDefault = page.locator('#ai-model-use-default');
  await expect(page.locator('#ai-test')).toBeVisible();
  await expect(model).toHaveValue('claude-opus-5');
  await expect(model).toHaveAttribute('placeholder', 'claude-opus-5');
  await expect(page.locator('#ai-model-default')).toHaveText('Default: claude-opus-5.');
  await expect(useDefault).toBeHidden();
  await expect(result).toHaveAttribute('aria-live', 'polite');

  // Without a saved key, Test asks for one first.
  await page.locator('#ai-test').click();
  await expect(page.locator('#ai-key')).toBeFocused();

  await page.locator('#ai-key').fill('offline-preview-key');
  await page.locator('#ai-provider').selectOption('openai');
  await expect(model).toHaveValue('gpt-5.5');
  await expect(page.locator('#ai-model-default')).toHaveText('Default: gpt-5.5.');
  await model.fill('gpt-unknown');
  await expect(useDefault).toBeVisible();
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_DELAY_MS = 800;
  });
  await page.locator('#ai-test').click();
  await expect(page.locator('#ai-test')).toBeDisabled();
  await expect(page.locator('#ai-test')).toHaveText('Testing…');
  await expect(result).toContainText('✗ Model not found');
  await expect(page.locator('#ai-test')).toBeEnabled();
  await expect(page.locator('#ai-test')).toHaveText('Test');
  await expect(page.locator('#notice')).toContainText(
    'Model "gpt-unknown" was not found for OpenAI (ChatGPT).'
  );
  const chips = result.locator('.chip');
  await expect(chips).toHaveText(['gpt-5.5', 'gpt-5.5-mini', 'gpt-5.5-pro']);
  await noOverflow(page);

  await chips.nth(1).click();
  await expect(model).toHaveValue('gpt-5.5-mini');
  await expect(model).toBeFocused();
  await expect(result.locator('.chip')).toHaveCount(0);
  await page.locator('#ai-test').click();
  await expect(result).toHaveText('✓ gpt-5.5-mini is available');
  await expect(page.locator('#notice')).toContainText('gpt-5.5-mini is available and replied: OK');

  // Editing the model drops the outcome; Use default restores the provider default.
  await useDefault.click();
  await expect(model).toHaveValue('gpt-5.5');
  await expect(useDefault).toBeHidden();
  await expect(result).toBeEmpty();

  await page.locator('#ai-provider').selectOption('gemini');
  await expect(model).toHaveValue('gemini-3.8-flash');
  await page.locator('#ai-test').click();
  await expect(result).toHaveText('✓ gemini-3.8-flash is available (Gemini 3.8 Flash)');
  await noOverflow(page);

  // Test saved nothing.
  await expect(page.locator('#ai-settings-status')).toHaveText('Not set up');
  expect((await rpc(page, 'dmvAiSettings')).configured).toBe(false);
});

test('after a save, Test uses the unsaved model in the form and keeps a custom model across providers', async ({
  page,
}) => {
  await page.locator('#ai-key').fill('offline-preview-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toHaveText('Anthropic (Claude) · claude-opus-5');
  await page.locator('#ai-settings summary').click();
  await expect(page.locator('#ai-test')).toBeVisible();
  await page.locator('#ai-model').fill('claude-sonnet-5');
  await page.locator('#ai-test').click();
  await expect(page.locator('#ai-model-result')).toHaveText(
    '✓ claude-sonnet-5 is available (Claude Sonnet 5)'
  );
  // A custom name survives a provider switch; the blank key is not reused for another provider.
  await page.locator('#ai-provider').selectOption('openai');
  await expect(page.locator('#ai-model')).toHaveValue('claude-sonnet-5');
  await expect(page.locator('#ai-model-result')).toBeEmpty();
  await page.locator('#ai-test').click();
  await expect(page.locator('#ai-model-result')).toHaveText(
    '✗ Paste the API key for OpenAI (ChatGPT).'
  );
  await expect(page.locator('#ai-settings-status')).toHaveText('Anthropic (Claude) · claude-opus-5');
  await noOverflow(page);
});
