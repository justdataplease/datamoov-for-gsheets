import { test, expect } from '@playwright/test';

const savedDashboard = {
  id: 'dashboard-fixture',
  name: 'Monthly account dashboard',
  datasets: [
    { id: 'gads', label: 'Google Ads campaigns', sheetName: 'Google Ads Data', rowCount: null, url: null },
    { id: 'meta', label: 'Facebook Ads campaigns', sheetName: 'Facebook Ads Data', rowCount: null, url: null },
  ],
  chartCount: 3,
  target: { sheetName: 'Marketing Dashboard', startCell: 'A1' },
  status: 'ready',
  statusMessage: '',
  private: true,
};

async function open(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
}

async function configureAi(page) {
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-dashboard-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.locator('#tab-reports').click();
}

async function controlDashboards(page, dashboards = [savedDashboard]) {
  await page.evaluate((items) => {
    const original = Object.getOwnPropertyDescriptor(google.script, 'run').get;
    window.dashboardProbe = {
      items,
      lists: [],
      runs: [],
      removals: [],
      chats: [],
      schedules: [],
      holdLists: false,
    };
    const copy = (value) => JSON.parse(JSON.stringify(value));
    function runner(success, failure) {
      return new Proxy(
        {},
        {
          get(_, name) {
            if (name === 'withSuccessHandler') return (next) => runner(next, failure);
            if (name === 'withFailureHandler') return (next) => runner(success, next);
            return (...args) => {
              const probe = window.dashboardProbe;
              if (name === 'dmvListDashboards') {
                probe.lists.push({ args, succeed: success, fail: failure });
                if (!probe.holdLists) queueMicrotask(() => success(copy(probe.items)));
                return;
              }
              const collection = {
                dmvRunDashboard: 'runs',
                dmvDeleteDashboard: 'removals',
                dmvChat: 'chats',
                dmvScheduleDashboard: 'schedules',
              }[name];
              if (collection) {
                probe[collection].push({ args, succeed: success, fail: failure });
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
    return window.dmvSidebar.refreshDashboards();
  }, dashboards);
}

const card = (page) => page.locator('.dashboard-card');

test('dashboard cards explain private setup, safely show every tab, and start an unsent chat draft', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('#dashboards-section')).toContainText('Each dataset lands in its own tab');
  await expect(page.locator('#dashboards-section')).toContainText('No saved reports are needed');
  await expect(page.locator('#dashboards-list')).toContainText(
    'Create your first dashboard in Chat'
  );
  await configureAi(page);
  await controlDashboards(page, [
    { ...savedDashboard, name: '<img src=x onerror=alert(1)> Dashboard' },
  ]);
  await expect(card(page)).toHaveCount(1);
  await expect(card(page)).toContainText('2 datasets · 3 charts');
  await expect(card(page)).toContainText('Google Ads campaigns');
  await expect(card(page)).toContainText('Google Ads Data');
  await expect(card(page)).toContainText('Facebook Ads Data');
  await expect(card(page)).toContainText('Marketing Dashboard');
  await expect(card(page).locator('img,script')).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'Refresh dashboard' })).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  await page.locator('#dashboards-section').getByRole('button', { name: 'Create in chat' }).click();
  await expect(page.locator('#panel-chat')).toBeVisible();
  await expect(page.locator('#chat-input')).toHaveValue(/Create a performance dashboard/);
  expect(await page.evaluate(() => window.dashboardProbe.chats.length)).toBe(0);
});

test('a dashboard card sets its own refresh schedule', async ({ page }) => {
  await open(page);
  await controlDashboards(page);
  const select = () => card(page).getByRole('combobox', { name: /Refresh schedule for/ });
  await expect(select()).toHaveValue('manual');
  const hour = () => card(page).getByRole('combobox', { name: /Refresh hour for/ });
  await expect(hour()).toBeHidden();
  await select().selectOption('daily');
  await expect(select()).toBeDisabled();
  await expect(hour()).toBeVisible();
  await page.waitForFunction(() => window.dashboardProbe.schedules.length === 1);
  expect(await page.evaluate(() => window.dashboardProbe.schedules[0].args)).toEqual([
    'dashboard-fixture',
    'daily',
    { hour: 6, weekday: 1 },
  ]);
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    probe.items[0] = { ...probe.items[0], schedule: 'daily', at: { hour: 6 }, nextRunAt: Date.now() };
    probe.schedules[0].succeed(probe.items[0]);
  });
  await expect(page.locator('#notice')).toContainText('refreshes daily at 06:00 in the background');
  await expect(select()).toHaveValue('daily');
  await expect(select()).toBeEnabled();
  await expect(hour()).toHaveValue('6');
  await expect(card(page).getByRole('combobox', { name: /Refresh weekday for/ })).toBeHidden();
  await expect(card(page)).toContainText('due at the next hourly check');
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    probe.items[0] = { ...probe.items[0], nextRunAt: Date.now() + 86400000 };
    return window.dmvSidebar.refreshDashboards();
  });
  await expect(card(page)).toContainText('next after');
});

test('dashboard polling never overlaps and stale phases cannot replace completed counts', async ({
  page,
}) => {
  await open(page);
  await controlDashboards(page);
  await page.evaluate(() => {
    window.dashboardProbe.holdLists = true;
  });
  await card(page).getByRole('button', { name: 'Refresh dashboard' }).click();
  await expect(card(page).getByRole('button', { name: 'Refreshing...' })).toBeDisabled();
  await expect(card(page).getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
  await page.waitForFunction(() => window.dashboardProbe.lists.length === 2);
  await page.waitForTimeout(2200);
  expect(await page.evaluate(() => window.dashboardProbe.lists.length)).toBe(2);
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    probe.items[0] = {
      ...probe.items[0],
      status: 'running',
      statusMessage: 'Fetching Facebook Ads (2 of 2)',
    };
    probe.lists[1].succeed(probe.items);
  });
  await expect(card(page)).toContainText('Fetching Facebook Ads (2 of 2)');
  await page.waitForFunction(() => window.dashboardProbe.lists.length === 3);
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    const datasets = probe.items[0].datasets.map((dataset, index) => ({
      ...dataset,
      rowCount: index ? 12 : 30,
    }));
    const result = {
      id: probe.items[0].id,
      rowCount: 42,
      chartCount: 3,
      updatedAt: '2026-09-20T10:00:00.000Z',
      target: probe.items[0].target,
      datasets,
    };
    probe.items[0] = {
      ...probe.items[0],
      status: 'success',
      statusMessage: '',
      lastRun: result.updatedAt,
      lastRowCount: result.rowCount,
      datasets,
    };
    probe.runs[0].succeed(result);
  });
  await expect(card(page)).toContainText('Google Ads Data · 30 rows');
  await expect(card(page)).toContainText('Facebook Ads Data · 12 rows');
  await expect(page.locator('#notice')).toContainText(
    '42 rows refreshed in 2 data tabs; 3 charts rebuilt on Marketing Dashboard.'
  );
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    probe.holdLists = false;
    probe.lists[2].succeed([
      { ...probe.items[0], status: 'running', statusMessage: 'STALE PHASE MUST NOT RETURN' },
    ]);
  });
  await expect(card(page)).not.toContainText('STALE PHASE');
  await expect(card(page).locator('.status')).toHaveText('Up to date');
  await expect(card(page).getByRole('button', { name: 'Refresh dashboard' })).toBeEnabled();
  await page.waitForTimeout(2200);
  expect(await page.evaluate(() => window.dashboardProbe.lists.length)).toBe(4);
});

test('dashboard refresh failure preserves previous output counts and removal preserves sheet data', async ({
  page,
}) => {
  await open(page);
  await controlDashboards(page, [
    {
      ...savedDashboard,
      status: 'success',
      lastRun: '2026-09-19T10:00:00.000Z',
      lastRowCount: 34,
      datasets: savedDashboard.datasets.map((dataset, index) => ({
        ...dataset,
        rowCount: index ? 4 : 30,
      })),
    },
  ]);
  await card(page).getByRole('button', { name: 'Refresh dashboard' }).click();
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    probe.items[0] = {
      ...probe.items[0],
      status: 'error',
      lastError: 'Facebook Ads campaigns: the source is unavailable. Previous tabs were preserved.',
    };
    probe.runs[0].fail(new Error(probe.items[0].lastError));
  });
  await expect(card(page)).toContainText('Google Ads Data · 30 rows');
  await expect(card(page)).toContainText('Facebook Ads Data · 4 rows');
  await expect(card(page).locator('.card-error')).toContainText(
    'Facebook Ads campaigns: the source is unavailable'
  );
  await expect(card(page).getByRole('button', { name: 'Refresh dashboard' })).toBeEnabled();
  page.once('dialog', (dialog) => dialog.dismiss());
  await card(page).getByRole('button', { name: 'Remove', exact: true }).click();
  expect(await page.evaluate(() => window.dashboardProbe.removals.length)).toBe(0);
  let confirmation;
  page.once('dialog', (dialog) => {
    confirmation = dialog.message();
    return dialog.accept();
  });
  await card(page).getByRole('button', { name: 'Remove', exact: true }).click();
  expect(confirmation).toContain('delete the tabs it created');
  expect(confirmation).toContain('Marketing Dashboard');
  expect(confirmation).toContain('Facebook Ads Data');
  expect(confirmation).toContain('Your other tabs are not touched');
  await expect(card(page).getByRole('button', { name: 'Refresh dashboard' })).toBeDisabled();
  expect(await page.evaluate(() => window.dashboardProbe.removals[0].args)).toEqual([
    'dashboard-fixture',
  ]);
  await page.evaluate(() => {
    window.dashboardProbe.items = [];
    window.dashboardProbe.removals[0].succeed({ ok: true, deletedTabs: 4 });
  });
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('#notice')).toContainText('Dashboard removed with its 4 tabs.');
});

test('resetting the report list ignores late dashboard run and poll responses', async ({
  page,
}) => {
  await open(page);
  await controlDashboards(page);
  await page.evaluate(() => {
    window.dashboardProbe.holdLists = true;
  });
  await card(page).getByRole('button', { name: 'Refresh dashboard' }).click();
  await page.waitForFunction(() => window.dashboardProbe.lists.length === 2);
  await page.locator('#refresh-reports').click();
  await expect(page.locator('#boot-state')).toBeHidden();
  await expect(card(page)).toHaveCount(0);
  await page.evaluate(() => {
    const probe = window.dashboardProbe;
    probe.lists[1].succeed([{ ...probe.items[0], status: 'running', statusMessage: 'OLD POLL' }]);
    probe.runs[0].succeed({ id: probe.items[0].id, rowCount: 999, dataRowCount: 999 });
  });
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('#notice')).not.toContainText('999');
  await page.waitForTimeout(2200);
  expect(await page.evaluate(() => window.dashboardProbe.lists.length)).toBe(2);
});

test('a dashboard chat event updates cards without resetting unsaved AI settings', async ({
  page,
}) => {
  await open(page);
  await configureAi(page);
  await controlDashboards(page, []);
  await page.locator('#tab-settings').click();
  await page.locator('#ai-settings summary').click();
  await page.locator('#ai-instructions').fill('Unsaved dashboard guidance');
  await page.locator('#tab-chat').click();
  await page.locator('#chat-input').fill('Save the dashboard');
  await page.locator('#chat-send').click();
  await page.evaluate((dashboard) => {
    const probe = window.dashboardProbe;
    probe.items = [dashboard];
    probe.chats[0].succeed({
      text: 'Dashboard saved.',
      events: [{ kind: 'dashboard', text: 'Saved your dashboard' }],
      transcriptAppend: [],
    });
  }, savedDashboard);
  await expect(page.locator('.chat-message.assistant')).toContainText('Dashboard saved.');
  await expect(page.locator('.chat-message.assistant')).toContainText('Reports > Dashboards');
  await page.getByRole('button', { name: 'View dashboards', exact: true }).click();
  await expect(card(page)).toHaveCount(1);
  await page.locator('#tab-chat').click();
  await page.locator('#chat-settings-toggle').click();
  await expect(page.locator('#ai-instructions')).toHaveValue('Unsaved dashboard guidance');
  expect(await page.evaluate(() => window.dashboardProbe.lists.length)).toBe(2);
});

test('preview dashboard can be created, refreshed into a tab per dataset and removed from the sidebar', async ({
  page,
}, testInfo) => {
  await open(page);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler(reject)
          .dmvSaveDashboard({
            name: 'Reusable marketing dashboard',
            datasets: [
              { id: 'gads', label: 'Google Ads campaigns', sheetName: 'Google Ads Data' },
              { id: 'meta', label: 'Facebook Ads campaigns', sheetName: 'Facebook Ads Data' },
            ],
            tiles: [{ title: 'Weekly spend', type: 'line' }, { title: 'Totals', type: 'kpi' }],
            target: { sheetName: 'Monthly Dashboard' },
          });
      })
  );
  await page.evaluate(() => window.dmvSidebar.refreshDashboards());
  await expect(card(page)).toContainText('Reusable marketing dashboard');
  await card(page).getByRole('button', { name: 'Refresh dashboard' }).click();
  await expect(card(page).getByRole('button', { name: 'Refreshing...' })).toBeDisabled();
  await expect(card(page).locator('.status')).toHaveText('Up to date');
  await expect(card(page)).toContainText('2 datasets · 1 chart');
  await expect(card(page).getByRole('link', { name: 'Monthly Dashboard' })).toHaveAttribute(
    'href',
    'https://docs.google.com/spreadsheets/d/datamoov-preview-only/edit#gid=900&range=A1'
  );
  await expect(card(page).getByRole('link', { name: 'Google Ads Data' })).toHaveAttribute(
    'href',
    'https://docs.google.com/spreadsheets/d/datamoov-preview-only/edit#gid=901&range=A1'
  );
  await expect(card(page).getByRole('link', { name: 'Facebook Ads Data' })).toHaveAttribute(
    'href',
    'https://docs.google.com/spreadsheets/d/datamoov-preview-only/edit#gid=902&range=A1'
  );
  await expect(card(page)).toContainText('Facebook Ads Data · 576 rows');
  await expect(page.locator('#notice')).toContainText(
    '864 rows refreshed in 2 data tabs; 1 chart rebuilt on Monthly Dashboard.'
  );
  await page.screenshot({ path: testInfo.outputPath('dashboard-ready.png'), fullPage: true });
  page.once('dialog', (dialog) => dialog.accept());
  await card(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  const saved = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler(reject)
          .dmvListDashboards();
      })
  );
  expect(saved).toEqual([]);
});
