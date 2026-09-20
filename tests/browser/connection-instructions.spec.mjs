import { test, expect } from '@playwright/test';
async function rpc(page, method, ...args) {
  return page.evaluate(
    ({ method, args }) =>
      new Promise((resolve, reject) =>
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler(reject)
          [method](...args)
      ),
    { method, args }
  );
}
async function open(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('.report-card')).toHaveCount(3);
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-instructions-key');
  await page.locator('#ai-instructions').fill('General guidance');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
}
async function edit(page, index = 0) {
  await page.locator('#tab-connections').click();
  await page
    .locator('#connections-list .connection-card')
    .nth(index)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await expect(page.locator('#connection-chat-instructions')).toBeEnabled();
}

async function save(page) {
  await page.locator('#save-connection').click();
}

test('chat instructions save with the connection through its one Save button, per account', async ({
  page,
}) => {
  await open(page);
  await edit(page);
  await expect(page.locator('#save-connection-chat')).toHaveCount(0);
  const context = 'Account one: use campaign naming rules';
  await page.locator('#connection-chat-instructions').fill(context);
  await expect(page.locator('#connection-chat-count')).toContainText(
    (16 + context.length).toLocaleString() + ' / 100,000'
  );
  await save(page);
  await expect(page.locator('#panel-connections')).toBeVisible();
  await edit(page, 1);
  await expect(page.locator('#connection-chat-instructions')).toHaveValue('');
  await edit(page, 0);
  await expect(page.locator('#connection-chat-instructions')).toHaveValue(context);
  await page.locator('#tab-settings').click();
  await page.locator('#ai-settings summary').click();
  await expect(page.locator('#ai-instruction-source')).toHaveCount(0);
  await expect(page.locator('#ai-instruction-count')).toContainText(
    (16 + context.length).toLocaleString() + ' / 100,000'
  );
  await page.locator('#ai-instructions').fill('Updated general');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings')).not.toHaveAttribute('open', '');
  await edit(page, 0);
  await expect(page.locator('#connection-chat-instructions')).toHaveValue(context);
});

test('a failed instruction save keeps the saved connection open with the draft, and the limit blocks Save', async ({
  page,
}) => {
  await open(page);
  await edit(page);
  await page.locator('#connection-chat-instructions').fill('x'.repeat(99990));
  await expect(page.locator('#connection-chat-count')).toHaveClass(/error/);
  await save(page);
  await expect(page.locator('#panel-connect')).toBeVisible();
  await page.locator('#connection-chat-instructions').fill('Keep my draft');
  await page.evaluate(
    () => (window.DATAMOOV_PREVIEW_FAIL_NEXT = 'dmvSaveConnectionChatInstructions')
  );
  await save(page);
  await expect(page.locator('#notice')).toContainText('chat instructions were not');
  await expect(page.locator('#connection-chat-instructions')).toHaveValue('Keep my draft');
  await expect(page.locator('#connection-chat-instructions')).toBeEnabled();
  await save(page);
  await expect(page.locator('#panel-connections')).toBeVisible();
  await edit(page);
  await expect(page.locator('#connection-chat-instructions')).toHaveValue('Keep my draft');
});

test('legacy source guidance is inherited then can be explicitly cleared for one connection', async ({
  page,
}) => {
  await open(page);
  const boot = await rpc(page, 'dmvBootstrap');
  await rpc(page, 'dmvSaveAiSettings', {
    provider: 'anthropic',
    sourceInstructions: { [boot.connections[0].connectorId]: 'Legacy account context' },
  });
  await edit(page);
  await expect(page.locator('#connection-chat-instructions')).toHaveValue('Legacy account context');
  await expect(page.locator('#connection-chat-status')).toContainText(
    'previous source instructions'
  );
  await page.locator('#connection-chat-instructions').fill('');
  await save(page);
  await expect(page.locator('#panel-connections')).toBeVisible();
  await edit(page);
  await expect(page.locator('#connection-chat-instructions')).toHaveValue('');
  await expect(page.locator('#connection-chat-status')).not.toContainText(
    'previous source instructions'
  );
});
