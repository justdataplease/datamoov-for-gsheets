/**
 * Records a narrated walkthrough of the sidebar against the local preview: connect, build a
 * report, ask chat a question, then ask it for a dashboard. Writes a webm video and one
 * screenshot per step to data/walkthrough/. Sample data only; nothing live is contacted.
 *
 *   node tools/walkthrough.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'data/walkthrough');
const origin = 'http://127.0.0.1:8891';
const chrome = process.env.PLAYWRIGHT_CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function reachable() {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startPreview() {
  if (await reachable()) return null;
  const child = spawn(process.execPath, [path.join(root, 'tools/preview.mjs')], {
    cwd: root,
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (await reachable()) return child;
  }
  child.kill();
  throw new Error('The local preview did not come up on ' + origin);
}

// The caption is the narration track: it names the step the viewer is watching.
const CAPTION = `
  (text) => {
    let bar = document.getElementById('walkthrough-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'walkthrough-caption';
      bar.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
        'background:#172033', 'color:#fff', 'font:600 13px Inter,Segoe UI,sans-serif',
        'padding:11px 14px', 'letter-spacing:.01em', 'line-height:1.4',
        'box-shadow:0 -6px 18px rgba(23,32,51,.18)', 'transition:opacity .2s',
      ].join(';');
      document.body.appendChild(bar);
    }
    bar.textContent = text;
    bar.style.opacity = text ? '1' : '0';
  }
`;

const HIGHLIGHT = `
  (selector) => {
    const node = document.querySelector(selector);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const previous = node.style.boxShadow;
    node.style.boxShadow = '0 0 0 3px #5146d6, 0 0 0 7px rgba(81,70,214,.22)';
    node.style.borderRadius = getComputedStyle(node).borderRadius || '4px';
    setTimeout(() => { node.style.boxShadow = previous; }, 900);
  }
`;

async function run() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const preview = await startPreview();
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({
    viewport: { width: 460, height: 1050 },
    deviceScaleFactor: 2,
    recordVideo: { dir: out, size: { width: 920, height: 2100 } },
  });
  const page = await context.newPage();
  let shot = 0;
  const pause = (ms) => page.waitForTimeout(ms);
  const say = async (text, hold = 1500) => {
    await page.evaluate(`(${CAPTION})(${JSON.stringify(text)})`);
    await pause(hold);
  };
  const point = async (selector) => {
    await page.evaluate(`(${HIGHLIGHT})(${JSON.stringify(selector)})`);
    await pause(700);
  };
  const capture = async (name) => {
    shot += 1;
    const file = path.join(out, `${String(shot).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('shot  ' + path.relative(root, file).replaceAll('\\', '/'));
  };
  const click = async (selector) => {
    await point(selector);
    await page.locator(selector).click();
    await pause(500);
  };

  await page.goto(origin);
  await page.locator('#boot-state').waitFor({ state: 'hidden' });
  // The password-manager balloon the host injects is not part of the sidebar.
  await page.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });

  await say('DataMoov brings your marketing, database and CRM data into Google Sheets.', 2600);
  await capture('home');

  await say('Every source you connect carries its own official mark.', 2000);
  await click('#tab-connections');
  await pause(900);
  await capture('connections');

  await say('1 · Connect an account — pick a source and the credential it needs.', 2400);
  await click('#new-connection');
  await page.locator('#connection-provider').selectOption('google_ads');
  await pause(900);
  await point('#connection-provider');
  await click('#setup-guide summary');
  await pause(1100);
  await capture('connection-guide');

  await say('2 · Build a report — source, account, report, dates and columns.', 2400);
  await click('#cancel-connection');
  await click('#tab-reports');
  await click('#new-report');
  await page.locator('#report-provider').selectOption('google_ads');
  await pause(800);
  await point('#report-provider');
  await page.locator('#report-name').fill('Daily campaign spend');
  await page.locator('#target-sheet').fill('Campaigns');
  await page.locator('#date-preset').selectOption('last30');
  await pause(700);
  await capture('report-builder');

  await say('Preview the first rows before anything touches the sheet.', 2200);
  await click('#preview-report');
  await page.locator('#data-preview').waitFor({ state: 'visible' });
  await pause(1200);
  await capture('report-preview');

  await say('3 · Keep it up to date — give it a refresh and save.', 2200);
  await page.locator('#report-schedule').selectOption('daily');
  await pause(600);
  await click('#save-report');
  await pause(1400);
  await capture('report-saved');

  await say('4 · Ask instead of building — add an AI key once.', 2300);
  await click('#tab-settings');
  await click('#ai-settings summary');
  await page.locator('#ai-key').fill('preview-key-not-a-real-secret');
  await pause(600);
  await click('#ai-save');
  await pause(900);
  await capture('ai-settings');

  await say('Now ask in plain language. Chat runs a real report to answer.', 2400);
  await click('#tab-chat');
  await pause(700);
  await page.locator('#chat-input').fill('Which campaign had the highest spend last month?');
  await pause(700);
  await click('#chat-send');
  await page.locator('.chat-message.assistant').first().waitFor({ state: 'visible' });
  await pause(1600);
  await capture('chat-question');

  const chip = page.locator('.chat-message.assistant .chip').first();
  if (await chip.count()) {
    await say('It asks when it needs to, and shows every step it took.', 2200);
    await chip.click();
    await page.locator('.chat-message.assistant').nth(1).waitFor({ state: 'visible' });
    await pause(1800);
    await capture('chat-answer');
  }

  await say('5 · Turn it into a dashboard — just ask for one.', 2300);
  await page.locator('#chat-input').fill('Build me a performance dashboard');
  await pause(700);
  await click('#chat-send');
  await page.locator('.chat-message.assistant').last().waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => /Dashboard created/i.test(document.body.textContent || ''),
    undefined,
    { timeout: 20_000 }
  );
  await pause(2000);
  await capture('chat-dashboard');

  await say('The dashboard is saved, with every tab it owns, and refreshes in one go.', 2600);
  await click('#tab-reports');
  await pause(1200);
  await capture('dashboard-card');

  await say('Your data, in Sheets. No backend, no credentials leaving your account.', 3000);
  await say('', 600);

  await context.close();
  await browser.close();
  if (preview) preview.kill();

  const produced = (await readdir(out)).filter((name) => name.endsWith('.webm'));
  for (const name of produced) {
    await rename(path.join(out, name), path.join(out, 'datamoov-walkthrough.webm'));
  }
  console.log('video ' + path.relative(root, path.join(out, 'datamoov-walkthrough.webm')).replaceAll('\\', '/'));
}

run().catch((error) => {
  console.error('Walkthrough failed: ' + error.message);
  process.exitCode = 1;
});
