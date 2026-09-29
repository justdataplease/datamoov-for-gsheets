import { test, expect } from '@playwright/test';

// Chat saves reports and dashboards as drafts; the Reports tab shows Saved and Drafts groups
// for each, and Save on a draft card moves it across and unlocks the schedule.
async function open(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-drafts-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.locator('#tab-chat').click();
}

async function ask(page, text) {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
  await expect(page.locator('#chat-send')).toBeEnabled();
  return page.locator('.chat-message.assistant').last();
}

test('the Reports tab starts with open Saved groups, hidden Drafts groups and a guide chip in chat', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('#chat-suggestions .chip').last()).toHaveText('What can you do?');
  await page.locator('#tab-reports').click();
  await expect(page.locator('#reports-saved')).toHaveAttribute('open', '');
  await expect(page.locator('#reports-saved-count')).toHaveText('3');
  await expect(page.locator('#reports-drafts')).toBeHidden();
  await expect(page.locator('#dashboards-saved')).toHaveAttribute('open', '');
  await expect(page.locator('#dashboards-drafts')).toBeHidden();
  // A group folds with one click and stays folded while the list re-renders.
  await page.locator('#reports-saved summary').click();
  await expect(page.locator('#reports-saved')).not.toHaveAttribute('open', '');
  await page.locator('#create-report-chat').click();
  await expect(page.locator('#panel-chat')).toBeVisible();
  await expect(page.locator('#chat-input')).toHaveValue(/Create a report from one of my connections/);
});

test('a report created in chat is a draft until Save; the answer says where it is and opens the card', async ({
  page,
}) => {
  await open(page);
  const reply = await ask(page, 'Create a report of daily campaign cost for the last 30 days');
  await expect(reply).toContainText('Report saved as a draft.');
  await expect(reply.locator('.chat-dashboard-status')).toContainText(
    'Saved as a draft under Reports > Drafts. Save it to keep it and schedule refreshes, or remove it.'
  );
  await expect(reply.getByRole('link', { name: 'Campaign performance (preview)' })).toHaveAttribute(
    'target',
    '_blank'
  );
  await reply.getByRole('button', { name: 'Open the report' }).click();
  await expect(page.locator('#panel-reports')).toBeVisible();
  await expect(page.locator('#reports-drafts')).toBeVisible();
  await expect(page.locator('#reports-drafts-count')).toHaveText('1');
  const card = page.locator('#reports-drafts-list .report-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Campaign performance (chat)');
  await expect(card.locator('.draft-badge')).toHaveText('Draft');
  await expect(card).toContainText('from Chat');
  await expect(card).toContainText('On demand · save to schedule');
  await expect(card.locator('.status')).toHaveText('Up to date');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('Report saved');
  await expect(page.locator('#reports-drafts')).toBeHidden();
  await expect(page.locator('#reports-saved-count')).toHaveText('4');
  const kept = page.locator('#reports-list .report-card').filter({ hasText: 'Campaign performance (chat)' });
  await expect(kept).toHaveCount(1);
  await expect(kept.locator('.draft-badge')).toHaveCount(0);
  await expect(kept).toContainText('On demand');
});

test('a schedule asked for in chat saves the report outright', async ({ page }) => {
  await open(page);
  const reply = await ask(page, 'Create a report of campaign cost and refresh it every day at 8');
  await expect(reply.locator('.chat-dashboard-status')).toContainText(
    'Saved under Reports > Saved. Refresh or schedule it from its card.'
  );
  await reply.getByRole('button', { name: 'Open the report' }).click();
  await expect(page.locator('#reports-drafts')).toBeHidden();
  const card = page.locator('#reports-list .report-card').filter({ hasText: 'Campaign performance (chat)' });
  await expect(card).toContainText('Daily at 08:00');
});

test('a dashboard created in chat is a draft without schedule controls until Save', async ({
  page,
}) => {
  await open(page);
  const reply = await ask(page, 'Create a performance dashboard');
  await expect(reply.locator('.chat-dashboard-status')).toContainText(
    'Saved as a draft under Reports > Dashboards > Drafts. Save it to keep it and schedule refreshes, or remove it to delete its tabs.'
  );
  await reply.getByRole('button', { name: 'Open the dashboard' }).click();
  await expect(page.locator('#dashboards-drafts')).toBeVisible();
  const card = page.locator('#dashboards-drafts-list .dashboard-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.draft-badge')).toHaveText('Draft');
  await expect(card).toContainText('save this dashboard to schedule refreshes');
  await expect(card.locator('select')).toHaveCount(0);
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#notice')).toContainText('Dashboard saved');
  await expect(page.locator('#dashboards-drafts')).toBeHidden();
  const kept = page.locator('#dashboards-list .dashboard-card');
  await expect(kept).toHaveCount(1);
  await expect(kept.locator('select').first()).toBeVisible();
  await expect(kept.locator('.draft-badge')).toHaveCount(0);
});

test('a sidebar link in an answer opens the named tab', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.DATAMOOV_PREVIEW_CHAT_REPLY = {
      text: 'Add a key under [Settings > AI provider](sidebar:settings), then look at [Reports](sidebar:reports). Never [here](javascript:alert(1)).',
      events: [],
      transcriptAppend: [],
    };
  });
  const reply = await ask(page, 'What can you do?');
  await expect(reply.locator('a')).toHaveCount(0);
  await expect(reply.locator('button.sidebar-link')).toHaveCount(2);
  await reply.getByRole('button', { name: 'Settings > AI provider' }).click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await page.locator('#tab-chat').click();
  await reply.getByRole('button', { name: 'Reports' }).click();
  await expect(page.locator('#panel-reports')).toBeVisible();
});
