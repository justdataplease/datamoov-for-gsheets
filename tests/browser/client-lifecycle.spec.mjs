import { test, expect } from '@playwright/test';

async function open(page, configured = false) {
  if (configured)
    await page.addInitScript(() => {
      window.DATAMOOV_PREVIEW_SETUP = (data) => {
        data.ai = {
          ...data.ai,
          configured: true,
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          model: 'claude-opus-5',
        };
      };
    });
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
}

async function control(page, methods) {
  await page.evaluate((held) => {
    const original = Object.getOwnPropertyDescriptor(google.script, 'run').get;
    window.lifecycleProbe = { calls: [] };
    function runner(success, failure) {
      return new Proxy(
        {},
        {
          get(_, name) {
            if (name === 'withSuccessHandler') return (next) => runner(next, failure);
            if (name === 'withFailureHandler') return (next) => runner(success, next);
            return (...args) => {
              if (held.includes(name)) {
                window.lifecycleProbe.calls.push({ name, args, succeed: success, fail: failure });
                return;
              }
              original
                .call(google.script)
                .withSuccessHandler(success)
                .withFailureHandler(failure)
                [name](...args);
            };
          },
        }
      );
    }
    Object.defineProperty(google.script, 'run', { configurable: true, get: () => runner() });
  }, methods);
}

async function finish(page, method, value, index = 0, failed = false) {
  await page.evaluate(
    ({ method, value, index, failed }) => {
      const call = window.lifecycleProbe.calls.filter((item) => item.name === method)[index];
      if (failed) call.fail(value);
      else call.succeed(value);
    },
    { method, value, index, failed }
  );
}

async function startReport(page, source = 'google_ads') {
  await page.locator('#new-report').click();
  await page.locator('#report-provider').selectOption(source);
}

async function send(page, text) {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
}

const reply = (text) => ({
  text,
  events: [],
  transcriptAppend: [
    { role: 'user', text: 'Question' },
    { role: 'assistant', text },
  ],
});

test('field discovery cannot replace another provider or report editor', async ({ page }) => {
  await open(page);
  await control(page, ['dmvDiscoverFields']);
  await startReport(page);
  await page.locator('#discover-fields').click();
  await page.locator('#report-provider').selectOption('ga4');
  const expected = await page
    .locator('#column-list input')
    .evaluateAll((nodes) => nodes.map((node) => node.value));
  await finish(page, 'dmvDiscoverFields', [
    { key: 'metrics.cost_micros', type: 'currency', default: true },
  ]);
  await expect(page.locator('#discover-fields')).toBeEnabled();
  expect(
    await page.locator('#column-list input').evaluateAll((nodes) => nodes.map((node) => node.value))
  ).toEqual(expected);
  await expect(page.locator('#notice')).not.toContainText('Columns loaded');

  await page.locator('#discover-fields').click();
  await page.locator('#reset-report').click();
  await startReport(page, 'ga4');
  await finish(page, 'dmvDiscoverFields', { message: 'Old query failed' }, 1, true);
  await expect(page.locator('#discover-fields')).toBeEnabled();
  await expect(page.locator('#notice')).not.toContainText('Old query failed');
});

test('field discovery ignores an edited query and accepts the next query response', async ({
  page,
}) => {
  await open(page);
  await control(page, ['dmvDiscoverFields']);
  await startReport(page);
  await page.locator('#report-type').selectOption('custom_query');
  await page.locator('#config-gaql').fill('SELECT campaign.id FROM campaign');
  await page.locator('#discover-fields').click();
  await page.locator('#config-gaql').fill('SELECT campaign.name FROM campaign');
  await finish(page, 'dmvDiscoverFields', [{ key: 'campaign.id', type: 'string' }]);
  await expect(page.locator('#discover-fields')).toBeEnabled();
  await expect(page.locator('#column-list input')).toHaveCount(0);
  await page.locator('#discover-fields').click();
  await finish(
    page,
    'dmvDiscoverFields',
    [{ key: 'campaign.name', type: 'string', default: true }],
    1
  );
  await expect(page.locator('#column-list input')).toHaveCount(1);
  await expect(page.locator('#column-list input')).toHaveValue('campaign.name');
});

test('late preview and save responses preserve the report currently being edited', async ({
  page,
}) => {
  await open(page);
  await control(page, ['dmvPreviewReport', 'dmvSaveReport']);
  await startReport(page);
  await page.locator('#preview-report').click();
  await page.locator('#reset-report').click();
  await page
    .locator('.report-card')
    .nth(1)
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await finish(page, 'dmvPreviewReport', { columns: [{ key: 'old' }], rows: [['OLD PREVIEW']] });
  await expect(page.locator('#report-fields')).toBeEnabled();
  await expect(page.locator('#data-preview')).toBeHidden();
  await expect(page.locator('#report-name')).toHaveValue('Website acquisition');

  await page.locator('#save-report').click();
  await page.locator('#reset-report').click();
  await page
    .locator('.report-card')
    .first()
    .getByRole('button', { name: 'Edit', exact: true })
    .click();
  await page.evaluate(() => {
    const call = window.lifecycleProbe.calls.find((item) => item.name === 'dmvSaveReport');
    call.succeed({ ...call.args[0], status: 'ready' });
  });
  await expect(page.locator('#report-fields')).toBeEnabled();
  await expect(page.locator('#panel-compose')).toBeVisible();
  await expect(page.locator('#report-name')).toHaveValue('Campaign performance');
  expect(await page.evaluate(() => window.dmvSidebar.state.reports.length)).toBe(3);
});

test('pending report runs stay disabled across other completions and list refreshes', async ({
  page,
}) => {
  await open(page);
  await control(page, ['dmvRunReport']);
  const first = () => page.locator('[data-report-id="demo-report-0"]');
  await first().getByRole('button', { name: /Run/ }).click();
  await page
    .locator('[data-report-id="demo-report-1"]')
    .getByRole('button', { name: /Run/ })
    .click();
  await finish(page, 'dmvRunReport', { ok: true, rowCount: 8 }, 1);
  await expect(first().getByRole('button', { name: /Run/ })).toBeDisabled();
  await page.evaluate(() => window.dmvSidebar.refreshReports());
  await expect(first().getByRole('button', { name: /Run/ })).toBeDisabled();
  // The guard also covers a stale button handler after a rerender.
  await first().getByRole('button', { name: /Run/ }).dispatchEvent('click');
  expect(await page.evaluate(() => window.lifecycleProbe.calls.length)).toBe(2);
  await finish(page, 'dmvRunReport', { message: 'Refresh failed' }, 0, true);
  await expect(first()).toContainText('Refresh failed');
  await expect(first().getByRole('button', { name: /Run/ })).toBeEnabled();
  await first().getByRole('button', { name: /Run/ }).click();
  await page.evaluate(() => window.dmvSidebar.refreshReports());
  await finish(page, 'dmvRunReport', { ok: true, rowCount: 42 }, 2);
  await expect(first()).toContainText('42 rows');
  await expect(first().getByRole('button', { name: /Run/ })).toBeEnabled();
});

test('New chat clears the server cache after an earlier answer save finishes', async ({ page }) => {
  await open(page, true);
  await control(page, ['dmvChat', 'dmvChatSaveConversation']);
  await page.locator('#tab-chat').click();
  await send(page, 'First question');
  await finish(page, 'dmvChat', reply('First answer'));
  await expect(page.locator('#chat-new')).toBeEnabled();
  await page.locator('#chat-new').click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.lifecycleProbe.calls.filter((item) => item.name === 'dmvChatSaveConversation').length
    )
  ).toBe(1);
  await page.evaluate(() => {
    const call = window.lifecycleProbe.calls.find(
      (item) => item.name === 'dmvChatSaveConversation'
    );
    window.DATAMOOV_PREVIEW_CONVERSATION = call.args[0];
    call.succeed(true);
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.lifecycleProbe.calls.filter((item) => item.name === 'dmvChatSaveConversation')
            .length
      )
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.lifecycleProbe.calls.filter((item) => item.name === 'dmvChatSaveConversation')[1]
          .args[0]
    )
  ).toBeNull();
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_CONVERSATION = null;
    window.lifecycleProbe.calls
      .filter((item) => item.name === 'dmvChatSaveConversation')[1]
      .succeed(true);
  });
  expect(await page.evaluate(() => window.DATAMOOV_PREVIEW_CONVERSATION)).toBeNull();
});

test('conversation persistence snapshots each turn and continues after a failed save', async ({
  page,
}) => {
  await open(page, true);
  await control(page, ['dmvChat', 'dmvChatSaveConversation']);
  await page.locator('#tab-chat').click();
  await send(page, 'First question');
  await finish(page, 'dmvChat', reply('First answer'));
  await expect(page.locator('#chat-send')).toBeEnabled();
  await send(page, 'Second question');
  await finish(page, 'dmvChat', reply('Second answer'), 1);
  await expect(page.locator('.chat-message')).toHaveCount(4);
  const saved = await page.evaluate(() =>
    window.lifecycleProbe.calls
      .filter((item) => item.name === 'dmvChatSaveConversation')
      .map((item) => item.args[0])
  );
  expect(saved).toHaveLength(1);
  expect(saved[0].messages).toHaveLength(2);
  await finish(page, 'dmvChatSaveConversation', { message: 'Cache unavailable' }, 0, true);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.lifecycleProbe.calls.filter((item) => item.name === 'dmvChatSaveConversation')
            .length
      )
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.lifecycleProbe.calls.filter((item) => item.name === 'dmvChatSaveConversation')[1]
          .args[0].messages.length
    )
  ).toBe(4);
});

for (const change of ['add', 'remove'])
  test(`source ${change} during a turn preserves its answer and starts the next turn with fresh context`, async ({
    page,
  }) => {
    await open(page, true);
    await control(page, ['dmvChat', 'dmvChatProgress', 'dmvChatSaveConversation']);
    await page.locator('#tab-chat').click();
    await send(page, 'Working question');
    const originalIds = await page.evaluate(
      () =>
        window.lifecycleProbe.calls.find((item) => item.name === 'dmvChat').args[0].connectionIds
    );
    await page.evaluate((change) => {
      if (change === 'add')
        window.dmvSidebar.state.connections.push({
          id: 'new-source',
          connectorId: 'ga4',
          label: 'New Source',
        });
      else window.dmvSidebar.state.connections.shift();
      window.dmvChatUi.updateSources();
    }, change);
    await expect(page.locator('#chat-send')).toBeDisabled();
    await expect(page.locator('.chat-message.user')).toHaveText('Working question');
    await finish(page, 'dmvChat', reply('Completed answer'));
    await expect(page.locator('.chat-message.assistant')).toContainText('Completed answer');
    await expect(page.locator('#chat-send')).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          window.lifecycleProbe.calls.find((item) => item.name === 'dmvChatSaveConversation')
            .args[0]
      )
    ).toBeNull();
    await send(page, 'Next question');
    const next = await page.evaluate(
      () => window.lifecycleProbe.calls.filter((item) => item.name === 'dmvChat')[1].args[0]
    );
    expect(next.transcript).toEqual([]);
    if (change === 'add') expect(next.connectionIds).toEqual([...originalIds, 'new-source']);
    else expect(next.connectionIds).toEqual(originalIds.slice(1));
    await expect(page.locator('.chat-message')).toHaveCount(1);
  });
