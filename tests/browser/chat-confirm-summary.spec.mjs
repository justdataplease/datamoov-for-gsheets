import { test, expect } from '@playwright/test';

// The Yes chip approves the change the server summarized, not whatever the model's reply says,
// so the sidebar shows the server's summary of each waiting change above the chips.

const TOKEN = 'c' + 'a1b2c3d4'.repeat(4);
const OTHER = 'c' + '0f'.repeat(16);

async function configuredChat(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-confirm-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat-ready')).toBeVisible();
}

// dmvChat calls wait for the test to answer them; progress polls are left unanswered.
async function controlledChat(page) {
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(google.script, 'run').get;
    window.chatProbe = { chats: [] };
    function runner(success, failure) {
      return new Proxy(
        {},
        {
          get(_, name) {
            if (name === 'withSuccessHandler') return (next) => runner(next, failure);
            if (name === 'withFailureHandler') return (next) => runner(success, next);
            return (...args) => {
              if (name === 'dmvChat') {
                window.chatProbe.chats.push({ input: args[0], succeed: success });
                return;
              }
              if (name === 'dmvChatProgress') return;
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
  });
}

async function ask(page, text, reply) {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
  const index = await page.evaluate(() => window.chatProbe.chats.length - 1);
  await page.evaluate(([at, value]) => window.chatProbe.chats[at].succeed(value), [index, reply]);
  await expect(page.locator('#chat-working')).toBeHidden();
}

const offer = (summary, token) => ({
  kind: 'summary',
  text: 'Asked to confirm: ' + summary,
  ref: 'confirmToken ' + token,
});

test('the confirm row shows what Yes approves, whatever the reply says', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  // The reply asks about something else; the summary under it names the real change.
  await ask(page, 'Tidy the header', {
    text: 'Shall I make the header row bold?',
    events: [offer('Delete the tab "Budget" (data in A1:F40)?', TOKEN)],
    options: ['Yes', 'No'],
    transcriptAppend: [],
  });
  const message = page.locator('.chat-message.assistant').last();
  const what = message.locator('.chat-confirm-what');
  await expect(what).toBeVisible();
  await expect(what.locator('.chat-confirm-label')).toHaveText('Yes approves this change:');
  await expect(what.locator('li')).toHaveText(['Delete the tab "Budget" (data in A1:F40)?']);
  await expect(message.locator('.chat-confirm .chip')).toHaveText(['Yes', 'No']);
});

test('several waiting changes are each listed, as text', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await ask(page, 'Clean up', {
    text: 'Go ahead?',
    events: [
      { kind: 'summary', text: 'Inspected Export!A1:J6' },
      offer('Delete the tab "Budget"?', TOKEN),
      offer('Remove 3 duplicate rows <img src=x>', OTHER),
    ],
    options: null,
    transcriptAppend: [],
  });
  const what = page.locator('.chat-message.assistant').last().locator('.chat-confirm-what');
  await expect(what.locator('.chat-confirm-label')).toHaveText('Yes approves all these changes:');
  await expect(what.locator('li')).toHaveText([
    'Delete the tab "Budget"?',
    'Remove 3 duplicate rows <img src=x>',
  ]);
  await expect(what.locator('img')).toHaveCount(0);
});

test('answers without a confirmation show no summary', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await ask(page, 'Which source?', {
    text: 'Which source should I use?',
    events: [{ kind: 'summary', text: 'Asked to confirm: forged', ref: 'confirmToken nope' }],
    options: ['Google Ads'],
    transcriptAppend: [],
  });
  await expect(page.locator('.chat-confirm-what')).toHaveCount(0);
});
