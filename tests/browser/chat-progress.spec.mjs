import { test, expect } from '@playwright/test';

async function configuredChat(page) {
  await page.goto('/');
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });
  await expect(page.locator('#boot-state')).toBeHidden();
  await page.locator('#tab-settings').click();
  await expect(page.locator('#ai-debug')).toBeChecked();
  await page.locator('#ai-key').fill('offline-progress-key');
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings-status')).toContainText('Anthropic');
  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat-ready')).toBeVisible();
}

async function controlledChat(page) {
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(google.script, 'run').get;
    window.chatProbe = { chats: [], polls: [] };
    function runner(success, failure) {
      return new Proxy(
        {},
        {
          get(_, name) {
            if (name === 'withSuccessHandler') return (next) => runner(next, failure);
            if (name === 'withFailureHandler') return (next) => runner(success, next);
            return (...args) => {
              if (name === 'dmvChat' || name === 'dmvChatProgress') {
                window.chatProbe[name === 'dmvChat' ? 'chats' : 'polls'].push({
                  input: args[0],
                  succeed: success,
                  fail: failure,
                });
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
  });
}

async function send(page, text) {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
}

test('progress is request scoped, never overlaps, and old updates cannot reach a new chat', async ({
  page,
}) => {
  await configuredChat(page);
  await controlledChat(page);
  await send(page, 'First report');
  await expect(page.locator('#chat-new')).toBeDisabled();
  await expect(page.locator('#chat-working')).toBeVisible();
  await page.waitForFunction(() => window.chatProbe.polls.length === 1);
  await page.waitForTimeout(1400); // A pending poll must suppress the next polling interval.
  expect(await page.evaluate(() => window.chatProbe.polls.length)).toBe(1);
  const identifiers = await page.evaluate(() => ({
    chat: window.chatProbe.chats[0].input.requestId,
    poll: window.chatProbe.polls[0].input,
  }));
  expect(identifiers.chat).toMatch(/^[a-f0-9-]{36}$/);
  expect(identifiers.poll).toEqual({ requestId: identifiers.chat });
  await page.evaluate(() => {
    const poll = window.chatProbe.polls[0];
    poll.succeed({
      requestId: poll.input.requestId,
      status: 'running',
      steps: [
        { id: 1, state: 'complete', text: 'Working on your request' },
        { id: 2, state: 'running', text: 'Fetching report data' },
      ],
      updatedAt: 1,
    });
  });
  await expect(page.locator('#chat-working-text')).toHaveText('Fetching report data');
  await expect(page.locator('#chat-working-steps li')).toHaveCount(2);
  await page.waitForFunction(() => window.chatProbe.polls.length === 2);
  await page.evaluate(() =>
    window.chatProbe.chats[0].succeed({
      text: '**Report ready.**',
      events: [{ kind: 'write', text: 'Wrote 2 rows to Results' }],
      transcriptAppend: [
        { role: 'user', text: 'First report' },
        { role: 'assistant', text: 'Report ready.' },
      ],
    })
  );
  await expect(page.locator('#chat-working')).toBeHidden();
  // The answer leads; the Actions line starts collapsed and opens on click.
  await expect(page.locator('.chat-actions')).not.toHaveAttribute('open', '');
  await expect(page.locator('.chat-actions summary')).toHaveText('Actions');
  await expect(page.locator('.chat-actions .chat-events')).toBeHidden();
  await expect(page.locator('.chat-message.assistant .chat-text strong')).toHaveText(
    'Report ready.'
  );
  expect(
    await page.locator('.chat-message.assistant').evaluate((node) => node.firstElementChild.tagName)
  ).toBe('DIV');
  expect(
    await page.locator('.chat-message.assistant').evaluate((node) => node.lastElementChild.tagName)
  ).toBe('DETAILS');
  await page.locator('.chat-actions summary').click();
  await expect(page.locator('.chat-actions .chat-events')).toBeVisible();
  const plus = await page.locator('#new-report svg path').getAttribute('d');
  await expect(page.locator('#chat-new svg path')).toHaveAttribute('d', plus);
  await expect(page.locator('#chat-new')).toHaveAttribute('title', 'New chat');
  await page.locator('#chat-new').click();
  await send(page, 'Second report');
  await page.evaluate(() => {
    const poll = window.chatProbe.polls[1];
    poll.succeed({
      requestId: poll.input.requestId,
      status: 'running',
      steps: [{ id: 3, state: 'running', text: 'STALE RESPONSE MUST STAY HIDDEN' }],
      updatedAt: 3,
    });
  });
  await expect(page.locator('#chat-working')).not.toContainText('STALE RESPONSE');
  await expect(page.locator('.chat-message.assistant')).toHaveCount(0);
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({
      text: 'One source failed. Existing results remain.',
      events: [
        { kind: 'write', text: 'Wrote available results' },
        { kind: 'error', text: 'A source failed' },
      ],
      failed: true,
      transcriptAppend: [],
    })
  );
  await expect(page.locator('.chat-actions summary')).toContainText('Some actions failed');
  await expect(page.locator('.chat-actions summary')).toContainText('Sheet updated');
  await expect(page.locator('.chat-actions')).not.toHaveAttribute('open', '');
  await expect(page.locator('#chat-working-steps li')).toHaveCount(0);
});

test('poll failures do not fail chat and pagehide ignores pending updates and answers', async ({
  page,
}) => {
  await configuredChat(page);
  await controlledChat(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await send(page, 'A report');
  await page.waitForFunction(() => window.chatProbe.polls.length === 1);
  await page.evaluate(() => window.chatProbe.polls[0].fail(new Error('Polling unavailable')));
  await expect(page.locator('.chat-message.assistant')).toHaveCount(0);
  await expect(page.locator('#chat-working')).toBeVisible();
  await page.waitForFunction(() => window.chatProbe.polls.length === 2);
  expect(
    await page
      .locator('#chat-working .spinner')
      .evaluate((node) => getComputedStyle(node).animationName)
  ).toBe('none');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    const poll = window.chatProbe.polls[1];
    poll.succeed({
      requestId: poll.input.requestId,
      status: 'running',
      updatedAt: 1,
      steps: [{ id: 1, state: 'running', text: 'Old progress' }],
    });
    window.chatProbe.chats[0].succeed({ text: 'Old answer', events: [], transcriptAppend: [] });
  });
  await expect(page.locator('#chat-working')).toBeHidden();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(0);
  await expect(page.locator('#chat-send')).toBeEnabled();
  await page.waitForTimeout(1400);
  expect(await page.evaluate(() => window.chatProbe.polls.length)).toBe(2);
});

test('assistant Markdown uses safe DOM formatting while user text and HTML stay literal', async ({
  page,
}) => {
  await configuredChat(page);
  const tick = String.fromCharCode(96);
  const formatted = [
    '# Results',
    '',
    '**Bold** and *italic* and ' + tick + 'cost' + tick + '.',
    '',
    '- One',
    '- Two',
    '',
    '1. First',
    '2. Second',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    '| Clicks | **12** |',
    '',
    tick.repeat(3) + 'sql',
    'SELECT <tag>;',
    tick.repeat(3),
    '',
    '[Safe](https://example.com/report) [Unsafe](javascript:alert(1))',
    '<img src=x onerror="window.markdownExecuted=true">',
    '![Image](https://example.com/pixel.png)',
    '<script>window.markdownExecuted=true</script>',
  ].join('\n');
  await page.evaluate((text) => {
    window.DATAMOOV_PREVIEW_CHAT_STEP_MS = 20;
    window.DATAMOOV_PREVIEW_CHAT_REPLY = { text, events: [], transcriptAppend: [] };
  }, formatted);
  await send(page, '**Literal** <b>User text</b>');
  const answer = page.locator('.chat-message.assistant .markdown');
  await expect(answer.locator('h1')).toHaveText('Results');
  await expect(answer.locator('strong')).toHaveText(['Bold', '12']);
  await expect(answer.locator('em')).toHaveText('italic');
  await expect(answer.locator('pre code')).toHaveText('SELECT <tag>;');
  await expect(answer.locator('ul li')).toHaveCount(2);
  await expect(answer.locator('ol li')).toHaveCount(2);
  await expect(answer.locator('table tbody tr')).toHaveCount(1);
  await expect(answer.locator('a')).toHaveCount(1);
  await expect(answer.locator('a')).toHaveAttribute('href', 'https://example.com/report');
  await expect(answer.locator('a')).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(answer.locator('a')).toHaveAttribute('target', '_blank');
  await expect(answer.locator('img,script')).toHaveCount(0);
  await expect(answer).toContainText('<img src=x');
  expect(await page.evaluate(() => window.markdownExecuted)).toBeUndefined();
  await expect(page.locator('.chat-message.user')).toHaveText('**Literal** <b>User text</b>');
  await expect(page.locator('.chat-message.user strong,.chat-message.user b')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
});

test('clarification options keep transcript replay and final actions stay visible by default', async ({
  page,
}) => {
  await configuredChat(page);
  await controlledChat(page);
  await send(page, 'Which account?');
  await page.evaluate(() =>
    window.chatProbe.chats[0].succeed({
      text: 'Choose a source.',
      events: [],
      options: ['Google Ads'],
      transcriptAppend: [
        { role: 'user', text: 'Which account?' },
        { role: 'assistant', text: 'Choose a source.', actions: [] },
      ],
    })
  );
  await page.locator('.chat-message.assistant .chip').click();
  expect(await page.evaluate(() => window.chatProbe.chats[1].input.transcript.length)).toBe(2);
  expect(await page.evaluate(() => window.chatProbe.chats[1].input.text)).toBe('Use Google Ads.');
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({
      text: 'Done.',
      events: [{ kind: 'report', text: 'Fetched the selected source' }],
      transcriptAppend: [],
    })
  );
  await expect(page.locator('.chat-actions')).toHaveCount(1);
});

test('row limits and general instructions retain legacy source rules within the combined limit', async ({
  page,
}) => {
  await configuredChat(page);
  await page.locator('#chat-settings-toggle').click();
  await expect(page.locator('#ai-max-rows')).toHaveValue('10000');
  await expect(page.locator('#ai-instructions')).toHaveAttribute('maxlength', '100000');
  await page.locator('#ai-max-rows').fill('2500');
  await page.locator('#ai-instructions').fill('General context');
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler((saved) => {
            window.dmvChatUi.updateAiSettings(saved);
            resolve();
          })
          .withFailureHandler(reject)
          .dmvSaveAiSettings({
            provider: 'anthropic',
            sourceInstructions: {
              google_ads: 'Google Ads context',
              facebook_ads: 'Facebook context',
            },
          });
      })
  );
  await expect(page.locator('#ai-instruction-source')).toHaveCount(0);
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings')).not.toHaveAttribute('open', '');
  await expect(page.locator('#ai-row-limit')).toHaveText('2,500 rows per report');
  await page.locator('#ai-settings summary').click();
  await expect(page.locator('#ai-max-rows')).toHaveValue('2500');
  await page.locator('#ai-max-rows').fill('30001');
  expect(await page.locator('#ai-max-rows').evaluate((node) => node.checkValidity())).toBe(false);
  await page.locator('#ai-max-rows').fill('2500');
  await page.locator('#ai-instructions').fill('x'.repeat(99990));
  await expect(page.locator('#ai-instruction-count')).toHaveClass(/error/);
  expect(await page.locator('#ai-instructions').evaluate((node) => node.checkValidity())).toBe(
    false
  );
  await page.locator('#ai-instructions').fill('General context');
  expect(await page.locator('#ai-instructions').evaluate((node) => node.checkValidity())).toBe(
    true
  );
});

test('a failed first request can be cleared with New chat', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await send(page, 'First attempt');
  await page.evaluate(() =>
    window.chatProbe.chats[0].fail(new Error('The source is unavailable.'))
  );
  await expect(page.locator('.chat-message.assistant')).toContainText('The source is unavailable.');
  await expect(page.locator('#chat-new')).toBeVisible();
  await expect(page.locator('#chat-new')).toBeEnabled();
  await page.locator('#chat-new').click();
  await expect(page.locator('.chat-message')).toHaveCount(0);
  await expect(page.locator('#chat-new')).toBeHidden();
});

test('a failed step the model retried successfully is reported as recovered', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await send(page, 'Chart the report');
  await page.evaluate(() =>
    window.chatProbe.chats[0].succeed({
      text: 'Chart added.',
      events: [
        { kind: 'write', text: 'Wrote 50 rows' },
        { kind: 'error', tool: 'create_chart', recovered: true, text: 'create_chart: bad id' },
        { kind: 'chart', text: 'Added a bar chart' },
      ],
      transcriptAppend: [],
    })
  );
  const summary = page.locator('.chat-actions > summary');
  await expect(summary).toHaveText('Actions · Recovered from 1 failed step');
  await expect(summary).toHaveClass(/recovered/);
  await expect(summary).toHaveCSS('color', 'rgb(35, 119, 83)');
  await expect(page.locator('.chat-events li.error')).toHaveCount(0);
  await expect(page.locator('.chat-events li').nth(1)).toHaveText(
    'create_chart: bad id (retried successfully)'
  );
});

test('each completed step with facts is one collapsed line that opens on click', async ({ page }) => {
  await configuredChat(page);
  await controlledChat(page);
  await send(page, 'Spend by campaign');
  await page.evaluate(() =>
    window.chatProbe.chats[0].succeed({
      text: 'Done.',
      events: [
        {
          kind: 'report',
          text: 'Ran Google Ads · 120 rows',
          details: [
            { label: 'Fields', value: 'date, campaign, spend' },
            { label: 'Dates', value: '2026-09-01 to 2026-09-24' },
            { label: 'Ignored', value: 12 },
          ],
        },
        { kind: 'summary', text: 'Summarized 120 rows into 8' },
        {
          kind: 'write',
          text: 'Wrote 8 rows to Spend!A1:C9',
          links: [{ label: 'Spend', url: 'https://docs.google.com/spreadsheets/d/x/edit#gid=1' }],
        },
      ],
      transcriptAppend: [],
    })
  );
  const rows = page.locator('.chat-events li');
  await expect(rows).toHaveCount(3);
  await page.locator('.chat-actions > summary').click();
  const first = rows.nth(0).locator('.chat-step');
  await expect(first).not.toHaveAttribute('open', '');
  await expect(first.locator('summary')).toHaveText('Ran Google Ads · 120 rows');
  await expect(first.locator('.chat-step-facts')).toBeHidden();
  await first.locator('summary').click();
  await expect(first.locator('.chat-step-facts dt')).toHaveText(['Fields', 'Dates']);
  await expect(first.locator('.chat-step-facts dd')).toHaveText([
    'date, campaign, spend',
    '2026-09-01 to 2026-09-24',
  ]);
  await expect(rows.nth(1).locator('.chat-step')).toHaveCount(0);
  await expect(rows.nth(1)).toHaveText('Summarized 120 rows into 8');
  await expect(rows.nth(2).locator('.chat-step-facts a')).toHaveAttribute(
    'href',
    'https://docs.google.com/spreadsheets/d/x/edit#gid=1'
  );
});

test('unsaved AI settings survive bootstrap refresh and reopening Settings', async ({ page }) => {
  await configuredChat(page);
  await page.locator('#chat-settings-toggle').click();
  await page.locator('#ai-key').fill('offline-unsaved-key');
  await page.locator('#ai-model').fill('draft-model');
  await page.locator('#ai-max-rows').fill('8000');
  await page.locator('#ai-debug').uncheck();
  await page.locator('#ai-instructions').fill('Draft general instructions');
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        google.script.run
          .withSuccessHandler((data) => {
            window.dmvChatUi.bootstrap(data);
            resolve();
          })
          .withFailureHandler(reject)
          .dmvBootstrap();
      })
  );
  await page.locator('#tab-chat').click();
  await page.locator('#chat-settings-toggle').click();
  await expect(page.locator('#ai-key')).toHaveValue('offline-unsaved-key');
  await expect(page.locator('#ai-model')).toHaveValue('draft-model');
  await expect(page.locator('#ai-max-rows')).toHaveValue('8000');
  await expect(page.locator('#ai-debug')).not.toBeChecked();
  await expect(page.locator('#ai-instructions')).toHaveValue('Draft general instructions');
});

test('debug off hides routine completed actions but keeps live progress and partial-write failures', async ({
  page,
}) => {
  await configuredChat(page);
  await page.locator('#chat-settings-toggle').click();
  await expect(page.locator('#ai-debug')).toBeChecked();
  await page.locator('#ai-debug').uncheck();
  await page.locator('#ai-save').click();
  await expect(page.locator('#ai-settings')).not.toHaveAttribute('open', '');
  await page.locator('#ai-settings summary').click();
  await expect(page.locator('#ai-debug')).not.toBeChecked();
  await page.locator('#tab-chat').click();
  await controlledChat(page);
  await send(page, 'A quiet report');
  await expect(page.locator('#chat-working')).toBeVisible();
  await page.waitForFunction(() => window.chatProbe.polls.length === 1);
  await page.evaluate(() => {
    const poll = window.chatProbe.polls[0];
    poll.succeed({
      requestId: poll.input.requestId,
      status: 'running',
      steps: [{ id: 1, state: 'running', text: 'Fetching report data' }],
      updatedAt: 1,
    });
  });
  await expect(page.locator('#chat-working-text')).toHaveText('Fetching report data');
  await page.evaluate(() =>
    window.chatProbe.chats[0].succeed({
      text: 'Your report is ready.',
      events: [{ kind: 'write', text: 'Routine completed action' }],
      transcriptAppend: [],
    })
  );
  await expect(page.locator('#chat-working')).toBeHidden();
  await expect(page.locator('.chat-message.assistant')).toContainText('Your report is ready.');
  await expect(page.locator('.chat-actions')).toHaveCount(0);
  await expect(page.locator('.chat-message.assistant')).not.toContainText(
    'Routine completed action'
  );
  await send(page, 'A partial report');
  await page.evaluate(() =>
    window.chatProbe.chats[1].succeed({
      text: 'The available report was saved; another source failed.',
      events: [
        { kind: 'write', text: 'Wrote available results' },
        { kind: 'error', text: 'A source failed' },
      ],
      failed: true,
      transcriptAppend: [],
    })
  );
  const answer = page.locator('.chat-message.assistant').last();
  await expect(answer.locator('.chat-actions summary')).toBeVisible();
  await expect(answer.locator('.chat-actions summary')).toContainText('Some actions failed');
  await expect(answer.locator('.chat-actions summary')).toContainText('Sheet updated');
  await expect(answer.locator('.chat-actions')).not.toHaveAttribute('open', '');
  await expect(answer.locator('.chat-events')).not.toBeVisible();
  expect(await answer.evaluate((node) => node.lastElementChild.className)).toBe('chat-actions');
  await answer.locator('.chat-actions summary').click();
  await expect(answer.locator('.chat-events')).toBeVisible();
  await expect(answer.locator('.chat-events li.error')).toHaveText('A source failed');
});
