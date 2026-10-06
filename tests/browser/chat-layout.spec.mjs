import { test, expect } from '@playwright/test';

// How chat answers fit the 300 px Sheets sidebar, how fenced code renders, and how a reopened
// sidebar or the larger window continues the latest conversation.

const TICK = String.fromCharCode(96);
const FENCE = TICK.repeat(3);
const RANGE = "'Q3 Paid Social Campaign Performance Breakdown by Region and Device'!A1:AZ100000";
const FORMULA =
  '=ARRAYFORMULA(IF(LEN(Campaigns!A2:A100000),SUMIFS(Campaigns!F2:F100000,Campaigns!B2:B100000,Campaigns!B2:B100000,Campaigns!C2:C100000,">="&DATE(2026,7,1)),""))';
const TOKEN = 'c' + 'a1b2c3d4'.repeat(4);

async function configuredChat(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await page.locator('#ai-key').fill('offline-layout-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat-ready')).toBeVisible();
}

async function answer(page, question, reply) {
  await page.evaluate((value) => {
    window.DATAMOOV_PREVIEW_CHAT_STEP_MS = 20;
    window.DATAMOOV_PREVIEW_CHAT_REPLY = value;
  }, reply);
  await page.locator('#chat-input').fill(question);
  await page.locator('#chat-send').click();
  await expect(page.locator('#chat-working')).toBeHidden();
}

test('long ranges, formulas and confirmations stay inside a 300 px sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 900 });
  await configuredChat(page);
  await answer(page, 'Add a running total', {
    text: [
      'I will write the total into ' + TICK + RANGE + TICK + ' using ' + TICK + FORMULA + TICK + '.',
      '',
      FENCE + 'excel',
      FORMULA,
      FENCE,
    ].join('\n'),
    events: [
      {
        kind: 'summary',
        text: 'Asked to confirm: Write ' + FORMULA + ' into ' + RANGE,
        ref: 'confirmToken ' + TOKEN,
      },
    ],
    transcriptAppend: [],
  });
  await expect(page.locator('.chat-confirm button')).toHaveCount(2);
  const layout = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const right = (selector) =>
      [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect().right);
    const pre = document.querySelector('.chat-message.assistant pre');
    return {
      width,
      scroll: document.documentElement.scrollWidth,
      messages: right('.chat-message, .chat-confirm-what, .chat-message p code, .chat-message pre'),
      preScrolls: pre.scrollWidth > pre.clientWidth,
    };
  });
  expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  for (const edge of layout.messages) expect(edge).toBeLessThanOrEqual(layout.width);
  // A code block keeps its lines and scrolls inside its own box.
  expect(layout.preScrolls).toBe(true);
});

test('a fenced code block with a language tag renders as code, also indented under a list', async ({
  page,
}) => {
  await configuredChat(page);
  await answer(page, 'Which formula?', {
    text: [
      'Use this formula:',
      '',
      FENCE + 'excel',
      '=SUM(B2:B10)',
      FENCE,
      '',
      '*   **Running total:**',
      '    ' + FENCE + 'excel',
      '    =SUM($B$2:B2)',
      '    ' + FENCE,
    ].join('\n'),
    events: [],
    transcriptAppend: [],
  });
  const reply = page.locator('.chat-message.assistant .markdown');
  await expect(reply.locator('pre code')).toHaveText(['=SUM(B2:B10)', '=SUM($B$2:B2)']);
  await expect(reply).not.toContainText('excel');
  await expect(reply).not.toContainText(TICK);
  await expect(reply.locator('li strong')).toHaveText('Running total:');
});

test('a reopened sidebar continues the latest conversation and New chat forgets it', async ({
  page,
}) => {
  await configuredChat(page);
  await answer(page, 'Spend last week?', {
    text: 'Spend was **EUR 120**.',
    events: [{ kind: 'report', text: 'Ran Google Ads · 7 rows' }],
    transcriptAppend: [
      { role: 'user', text: 'Spend last week?' },
      { role: 'assistant', text: 'Spend was **EUR 120**.', actions: ['Ran Google Ads · 7 rows'] },
    ],
  });
  // Each finished turn is kept for this spreadsheet on the server.
  await expect.poll(() => page.evaluate(() => window.DATAMOOV_PREVIEW_CONVERSATION?.id)).toMatch(
    /^[a-f0-9-]{32,}$/
  );
  const saved = await page.evaluate(() => window.DATAMOOV_PREVIEW_CONVERSATION);
  const conversationId = saved.id;
  expect(saved.transcript).toHaveLength(2);
  expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

  // A new sidebar (or the larger window) bootstraps with that conversation.
  await page.addInitScript((conversation) => {
    window.DATAMOOV_PREVIEW_SETUP = (data) => {
      data.ai = { ...data.ai, configured: true, provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5' };
      data.chat = conversation;
    };
  }, saved);
  await page.reload();
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-chat').click();
  await expect(page.locator('.chat-message.user')).toHaveText('Spend last week?');
  await expect(page.locator('.chat-message.assistant strong')).toHaveText('EUR 120');
  await expect(page.locator('#chat-new')).toBeVisible();
  await expect(page.locator('#chat-suggestions .chip')).toHaveCount(0);

  // The next question continues it: same conversation, same transcript.
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(google.script, 'run').get;
    window.sent = [];
    function runner(success, failure) {
      return new Proxy(
        {},
        {
          get(_, name) {
            if (name === 'withSuccessHandler') return (next) => runner(next, failure);
            if (name === 'withFailureHandler') return (next) => runner(success, next);
            return (...args) => {
              if (name === 'dmvChat') window.sent.push(structuredClone(args[0]));
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
  await answer(page, 'And the week before?', {
    text: 'EUR 95.',
    events: [],
    transcriptAppend: [
      { role: 'user', text: 'And the week before?' },
      { role: 'assistant', text: 'EUR 95.', actions: [] },
    ],
  });
  const next = await page.evaluate(() => window.sent[0]);
  expect(next.conversationId).toBe(conversationId);
  expect(next.transcript).toEqual(saved.transcript);
  await expect(page.locator('.chat-message')).toHaveCount(4);

  // A later sidebar refresh keeps the conversation on screen rather than doubling it.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        google.script.run
          .withSuccessHandler((data) => {
            window.dmvChatUi.bootstrap(data);
            resolve();
          })
          .dmvBootstrap()
      )
  );
  await expect(page.locator('.chat-message')).toHaveCount(4);

  await page.locator('#chat-new').click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.DATAMOOV_PREVIEW_CONVERSATION)).toBeNull();
});

test('a wide table keeps its words whole and scrolls sideways instead of growing tall', async ({
  page,
}) => {
  await configuredChat(page);
  const header = [
    'Segment',
    'Demographic',
    'Impressions',
    'Conversions',
    'Conversion rate',
    'Average order value',
    'Landing page',
    'Notes',
  ];
  const rows = [
    [
      'Group A',
      'demographic',
      '1,234,567',
      '12,345',
      '1.00%',
      'EUR 45.10',
      'https://example.com/landing/path/that-is-quite-long?campaign=autumn&source=newsletter',
      'Strongest segment this quarter, ahead of the previous best by a comfortable margin.',
    ],
    ['Group B', 'professional', '987,654', '9,876', '1.00%', 'EUR 39.80', 'https://example.com/b', 'Steady.'],
  ];
  const line = (cells) => '| ' + cells.join(' | ') + ' |';
  await answer(page, 'Compare the groups', {
    text: ['Here is the comparison:', '', line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n'),
    events: [],
    transcriptAppend: [],
  });
  const table = page.locator('.chat-message.assistant .chat-table-scroll table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  const layout = await page.evaluate(() => {
    const scroll = document.querySelector('.chat-message.assistant .chat-table-scroll');
    const table = scroll.querySelector('table');
    // Lines a cell's text takes: one rectangle per line box it spans.
    const lines = (cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    };
    const cells = [...table.querySelectorAll('th, td')];
    return {
      width: document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollWidth,
      scrolls: scroll.scrollWidth > scroll.clientWidth,
      bubbleRight: document.querySelector('.chat-message.assistant').getBoundingClientRect().right,
      // Every word up to 20 letters stays on one line; a phrase of short words keeps its width.
      broken: cells
        .filter((cell) => cell.textContent.length <= 20)
        .filter((cell) => lines(cell) > 1)
        .map((cell) => cell.textContent),
      widest: Math.max(...cells.map((cell) => cell.getBoundingClientRect().width)),
      tallest: Math.max(...[...table.rows].map((row) => row.getBoundingClientRect().height)),
    };
  });
  expect(layout.broken).toEqual([]);
  expect(layout.scrolls).toBe(true);
  expect(layout.pageScroll).toBeLessThanOrEqual(layout.width);
  expect(layout.bubbleRight).toBeLessThanOrEqual(layout.width);
  // Long text wraps inside a readable column rather than one very wide or very tall one.
  expect(layout.widest).toBeLessThanOrEqual(240);
  expect(layout.tallest).toBeLessThanOrEqual(120);
});

test('a markdown rule line renders as a divider, not as literal dashes', async ({ page }) => {
  await configuredChat(page);
  await answer(page, 'Summarize', {
    text: ['First part.', '', '---', '', 'Second part.', '***', '- - -', 'Third part.'].join('\n'),
    events: [],
    transcriptAppend: [],
  });
  const reply = page.locator('.chat-message.assistant .markdown');
  await expect(reply.locator('hr')).toHaveCount(3);
  await expect(reply.locator('p')).toHaveText(['First part.', 'Second part.', 'Third part.']);
  await expect(reply).not.toContainText('---');
  await expect(reply).not.toContainText('***');
  await expect(reply.locator('li')).toHaveCount(0);
});
