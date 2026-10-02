import { test, expect } from '@playwright/test';

// A sheet change that waits for the user's yes comes back as a summary event whose ref carries
// the confirmToken. The sidebar shows Yes and No chips for it; Yes sends the token with the
// message, so the server approves exactly that change.

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

function question(text, tokens, options) {
  return {
    text,
    events: [
      { kind: 'summary', text: 'Inspected Export!A1:J6' },
      ...tokens.map((token) => ({
        kind: 'summary',
        text: 'Asked to confirm: ' + text,
        ref: 'confirmToken ' + token,
      })),
    ],
    options,
    transcriptAppend: [
      { role: 'user', text: 'Clean this export' },
      { role: 'assistant', text, actions: ['Asked to confirm [confirmToken ' + tokens[0] + ']'] },
    ],
  };
}

test('Yes and No chips answer a confirmation, and Yes sends its token', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await ask(
    page,
    'Clean this export',
    question('Remove 1 duplicate row from Export?', [TOKEN], ['Yes', 'No', 'Keep the last one'])
  );
  const message = page.locator('.chat-message.assistant').first();
  const chips = message.locator('.chat-confirm .chip');
  await expect(chips).toHaveText(['Yes', 'No']);
  // The model's own Yes and No give way to the chips; its other options stay.
  await expect(message.locator('.chip-row:not(.chat-confirm) .chip')).toHaveText([
    'Keep the last one',
  ]);
  await chips.first().click();
  await page.waitForFunction(() => window.chatProbe.chats.length === 2);
  const sent = await page.evaluate(() => window.chatProbe.chats[1].input);
  expect(sent.text).toBe('Yes');
  expect(sent.confirmToken).toBe(TOKEN);
  expect(sent.transcript.at(-1).actions[0]).toContain(TOKEN);
  await expect(page.locator('.chat-message.user').last()).toHaveText('Yes');
  // While the answer runs and after it, the old chips no longer answer anything.
  await expect(chips.first()).toBeDisabled();
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({ text: 'Removed 1 row.', events: [], transcriptAppend: [] })
  );
  await expect(page.locator('#chat-working')).toBeHidden();
  await expect(chips.first()).toBeDisabled();
  await expect(chips.last()).toBeDisabled();
  expect(await page.evaluate(() => window.chatProbe.chats.length)).toBe(2);
});

test('No sends a plain no; several questions in one answer are approved by a plain yes', async ({
  page,
}) => {
  await configuredChat(page);
  await controlledChat(page);
  await ask(page, 'Clean this export', question('Delete these rows?', [TOKEN], null));
  await page.locator('.chat-confirm .chip', { hasText: 'No' }).click();
  await page.waitForFunction(() => window.chatProbe.chats.length === 2);
  let sent = await page.evaluate(() => window.chatProbe.chats[1].input);
  expect(sent.text).toBe('No');
  expect(Object.hasOwn(sent, 'confirmToken')).toBe(false);
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({ text: 'Left as is.', events: [], transcriptAppend: [] })
  );
  await expect(page.locator('#chat-working')).toBeHidden();

  // Two changes wait in one answer: one token cannot approve both, so Yes sends the word only
  // and the server approves each change it offered, for its exact input.
  await ask(page, 'Also delete the tab', question('Delete both?', [TOKEN, OTHER], ['Yes', 'No']));
  const latest = page.locator('.chat-message.assistant').last();
  await expect(latest.locator('.chat-confirm .chip')).toHaveText(['Yes', 'No']);
  await expect(latest.locator('.chip-row:not(.chat-confirm)')).toHaveCount(0);
  await latest.locator('.chat-confirm .chip', { hasText: 'Yes' }).click();
  await page.waitForFunction(() => window.chatProbe.chats.length === 4);
  sent = await page.evaluate(() => window.chatProbe.chats[3].input);
  expect(sent.text).toBe('Yes');
  expect(Object.hasOwn(sent, 'confirmToken')).toBe(false);
});

test('answers without a valid confirmation keep the ordinary option chips', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await ask(page, 'Which source?', {
    text: 'Which source should I use?',
    events: [
      { kind: 'summary', text: 'Inspected Export!A1:J6' },
      { kind: 'summary', text: 'Not a question', ref: 'confirmToken <img src=x>' },
      { kind: 'write', text: 'Wrote', ref: 'confirmToken ' + TOKEN },
    ],
    options: ['Yes', 'Google Ads'],
    transcriptAppend: [],
  });
  const message = page.locator('.chat-message.assistant').last();
  await expect(message.locator('.chat-confirm')).toHaveCount(0);
  await expect(message.locator('.chip')).toHaveText(['Yes', 'Google Ads']);
  await message.locator('.chip', { hasText: 'Google Ads' }).click();
  await page.waitForFunction(() => window.chatProbe.chats.length === 2);
  const sent = await page.evaluate(() => window.chatProbe.chats[1].input);
  expect(sent.text).toBe('Use Google Ads.');
  expect(Object.hasOwn(sent, 'confirmToken')).toBe(false);
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({ text: 'Done.', events: [], transcriptAppend: [] })
  );
  await expect(page.locator('#chat-working')).toBeHidden();
  await expect(page.locator('.chat-message.assistant').last()).toContainText('Done.');
});

test('every message of a conversation carries its id, and New chat starts another', async ({
  page,
}) => {
  await configuredChat(page);
  await controlledChat(page);
  await ask(page, 'Clean this export', question('Delete these rows?', [TOKEN], null));
  await page.locator('.chat-confirm .chip', { hasText: 'Yes' }).click();
  await page.waitForFunction(() => window.chatProbe.chats.length === 2);
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({ text: 'Deleted.', events: [], transcriptAppend: [] })
  );
  await expect(page.locator('#chat-working')).toBeHidden();
  await page.locator('#chat-new').click();
  await ask(page, 'Start over', { text: 'Sure.', events: [], transcriptAppend: [] });
  const ids = await page.evaluate(() =>
    window.chatProbe.chats.map((chat) => chat.input.conversationId)
  );
  expect(ids[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{31,79}$/);
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{31,79}$/);
  expect(ids[2]).not.toBe(ids[0]);
});
