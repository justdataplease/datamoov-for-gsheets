import { test, expect } from '@playwright/test';
const reportUrl =
  'https://docs.google.com/spreadsheets/d/offline-output-fixture/edit#gid=42&range=B3';
const dataUrl =
  'https://docs.google.com/spreadsheets/d/offline-output-fixture/edit#gid=43&range=A1';
async function open(page, reply) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-output-key');
  await page.locator('#ai-debug').uncheck();
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.evaluate((value) => {
    window.DATAMOOV_PREVIEW_CHAT_REPLY = value;
    window.DATAMOOV_PREVIEW_CHAT_STEP_MS = 0;
  }, reply);
  await page.locator('#tab-chat').click();
  await page.locator('#chat-input').fill('Create the dashboard');
  await page.locator('#chat-send').click();
  await expect(page.locator('.chat-message.assistant')).toBeVisible();
}

test('committed output links and dashboard status survive debug off and a truncated model reply', async ({
  page,
}) => {
  await open(page, {
    text: 'Spend increased',
    events: [
      { kind: 'dashboard', action: 'saved', text: 'Saved setup.' },
      {
        kind: 'dashboard',
        action: 'refreshed',
        text: 'Updated both tabs.',
        links: [
          { label: 'Report: Marketing', url: reportUrl },
          { label: 'Data: Marketing', url: dataUrl },
        ],
      },
      {
        kind: 'write',
        text: 'Wrote report.',
        links: [{ label: 'Duplicate tab', url: reportUrl.replace('B3', 'C9') }],
      },
      {
        kind: 'chart',
        text: 'Added chart.',
        links: [
          { label: 'Unsafe', url: 'https://evil.example/phish' },
          {
            label: 'Unsafe query',
            url: reportUrl.replace('/edit#', '/edit?redirect=https://evil.example#'),
          },
        ],
      },
    ],
    transcriptAppend: [],
  });
  const reply = page.locator('.chat-message.assistant');
  await expect(reply).toContainText('Dashboard saved and refreshed.');
  await expect(reply.locator('.chat-actions')).toHaveCount(0);
  await expect(reply.locator('.chat-output-links a')).toHaveCount(2);
  await expect(reply.getByRole('link', { name: 'Report: Marketing' })).toHaveAttribute(
    'href',
    reportUrl
  );
  await expect(reply.getByRole('link', { name: 'Data: Marketing' })).toHaveAttribute(
    'href',
    dataUrl
  );
  await expect(reply.getByRole('link', { name: 'Report: Marketing' })).toHaveAttribute(
    'target',
    '_blank'
  );
  await expect(reply.getByRole('link', { name: 'Report: Marketing' })).toHaveAttribute(
    'rel',
    'noopener noreferrer'
  );
});

test('saved setup without a committed output never claims a created sheet', async ({ page }) => {
  await open(page, {
    text: 'The source failed.',
    events: [
      { kind: 'dashboard', action: 'saved', text: 'Saved setup.' },
      { kind: 'error', text: 'Source unavailable.' },
    ],
    transcriptAppend: [],
  });
  const reply = page.locator('.chat-message.assistant');
  await expect(reply).toContainText(
    'Dashboard setup saved. Its output has not been refreshed in this reply.'
  );
  await expect(reply.locator('.chat-output-links')).toHaveCount(0);
  await expect(reply.getByRole('button', { name: 'View dashboards' })).toBeVisible();
});

test('analysis-only response has no saved-dashboard claim or output links', async ({ page }) => {
  await open(page, {
    text: 'Spend increased by 10%.',
    events: [{ kind: 'summary', text: 'Summarized results.' }],
    transcriptAppend: [],
  });
  await expect(page.locator('.chat-dashboard-status, .chat-output-links')).toHaveCount(0);
});

test('committed dashboard output remains linked when recording completion fails', async ({
  page,
}) => {
  await open(page, {
    text: 'Refresh needs recovery.',
    events: [
      { kind: 'dashboard', action: 'saved', text: 'Saved setup.' },
      {
        kind: 'write',
        action: 'updated_incomplete',
        text: 'Both tabs updated; completion could not be saved.',
        links: [
          { label: 'Report: Marketing', url: reportUrl },
          { label: 'Data: Marketing', url: dataUrl },
        ],
      },
      { kind: 'error', text: 'Ownership storage unavailable.' },
    ],
    transcriptAppend: [],
  });
  const reply = page.locator('.chat-message.assistant');
  await expect(reply).toContainText(
    'Dashboard tabs updated; saving refresh status needs recovery.'
  );
  await expect(reply).not.toContainText('has not been refreshed');
  await expect(reply.locator('.chat-output-links a')).toHaveCount(2);
});
