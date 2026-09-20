/**
 * Records the DataMoov product walkthrough: connect once, build a report the familiar way,
 * then skip the builder entirely and ask chat — for an answer, and for a whole dashboard.
 *
 * Drives the real local sidebar preview docked inside the demo stage (tools/demo-stage.mjs),
 * so the recording shows data landing in cells rather than a panel on its own.
 * Writes data/walkthrough/datamoov-walkthrough.webm and a numbered screenshot per beat.
 *
 * Sample data only: no provider, no AI service and no spreadsheet is contacted.
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
const SIDEBAR = 'http://127.0.0.1:8891';
const STAGE = 'http://127.0.0.1:8893';
const chrome =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// The header mark, for the title and end cards.
const MARK = `<svg viewBox="0 0 24 24" width="62" height="62">
  <path fill="#fff" opacity=".62" d="M2.405 21.75L4.955 21.75C5.369 21.75 5.705 21.414 5.705 21L5.705 11.5C5.705 11.086 5.369 10.75 4.955 10.75L3.148 10.75C2.778 10.75 2.463 11.02 2.407 11.385C1.915 14.569 1.655 17.779 1.655 21C1.655 21.414 1.991 21.75 2.405 21.75Z"/>
  <path fill="#fff" opacity=".62" d="M8.953 21.75L11.492 21.75C11.87 21.75 12.19 21.468 12.236 21.092L13.922 7.382C13.977 6.934 13.629 6.54 13.178 6.54L11.42 6.54C11.072 6.54 10.77 6.78 10.69 7.119C9.618 11.683 8.781 16.255 8.209 20.908C8.154 21.356 8.502 21.75 8.953 21.75Z"/>
  <path fill="#fff" d="M15.47 21.75L17.99 21.75C18.348 21.75 18.655 21.498 18.726 21.147L22.326 3.147C22.418 2.683 22.063 2.25 21.59 2.25L19.87 2.25C19.535 2.25 19.241 2.471 19.149 2.793C17.442 8.738 15.947 14.788 14.734 20.853C14.642 21.317 14.997 21.75 15.47 21.75Z"/>
</svg>`;

// Numbers here match what the preview's chat actually answers with.
const CAMPAIGNS = [
  ['2026-09-01', 'Brand search', 1412.25, 1840, 41200, '4.47%'],
  ['2026-09-02', 'Brand search', 1389.5, 1795, 39850, '4.50%'],
  ['2026-09-03', 'Brand search', 1318.75, 1702, 38400, '4.43%'],
  ['2026-09-01', 'Summer collection', 812.0, 968, 30100, '3.22%'],
  ['2026-09-02', 'Summer collection', 799.5, 941, 29650, '3.17%'],
  ['2026-09-03', 'Summer collection', 698.5, 869, 27900, '3.11%'],
  ['2026-09-01', 'Remarketing', 348.25, 512, 14200, '3.61%'],
  ['2026-09-02', 'Remarketing', 322.0, 478, 13650, '3.50%'],
  ['2026-09-03', 'Remarketing', 310.0, 455, 13100, '3.47%'],
];

const SPEND_BY_CAMPAIGN = [
  ['Brand search', 4120.5, 5337, '€0.77'],
  ['Summer collection', 2310.0, 2778, '€0.83'],
  ['Remarketing', 980.25, 1445, '€0.68'],
];

const money = (value) =>
  '€' + value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (value) => value.toLocaleString('en-GB');

// A bar chart and a trend line, drawn to one scale each so every label names a real value.
function barChart() {
  const data = [
    ['Brand search', 4120.5],
    ['Summer', 2310.0],
    ['Remarketing', 980.25],
  ];
  const max = 4500;
  const width = 300;
  const height = 132;
  const left = 78;
  const bars = data
    .map(([label, value], index) => {
      const y = 8 + index * 40;
      const w = Math.round(((width - left - 44) * value) / max);
      return (
        `<text x="${left - 8}" y="${y + 15}" text-anchor="end" font-size="10" fill="#5f6368">${label}</text>` +
        `<rect x="${left}" y="${y}" width="${w}" height="22" rx="2" fill="#5146d6" opacity="${1 - index * 0.22}"/>` +
        `<text x="${left + w + 6}" y="${y + 15}" font-size="10" fill="#202124" font-weight="600">${money(value)}</text>`
      );
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <line x1="${left}" y1="4" x2="${left}" y2="128" stroke="#e8eaed"/>${bars}
    <text x="${left}" y="128" font-size="9" fill="#9aa0a6">€0</text>
    <text x="${width - 6}" y="128" font-size="9" fill="#9aa0a6" text-anchor="end">€4,500</text>
  </svg>`;
}

function lineChart() {
  const series = [1412.25, 1389.5, 1318.75, 1402.0, 1455.5, 1370.25, 1489.0];
  const max = 1600;
  const width = 300;
  const height = 132;
  const step = (width - 40) / (series.length - 1);
  const y = (value) => 112 - (value / max) * 92;
  const points = series.map((value, index) => `${28 + index * step},${y(value)}`).join(' ');
  const area = `M28,112 L${points.split(' ').join(' L')} L${28 + (series.length - 1) * step},112 Z`;
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    ${[0, 46, 92].map((offset) => `<line x1="28" y1="${20 + offset}" x2="${width - 8}" y2="${20 + offset}" stroke="#f1f3f4"/>`).join('')}
    <path d="${area}" fill="#5146d6" opacity=".10"/>
    <polyline points="${points}" fill="none" stroke="#5146d6" stroke-width="2.2"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${28 + (series.length - 1) * step}" cy="${y(series[series.length - 1])}" r="3.6" fill="#5146d6"/>
    <text x="28" y="126" font-size="9" fill="#9aa0a6">Sep 1</text>
    <text x="${width - 8}" y="126" font-size="9" fill="#9aa0a6" text-anchor="end">Sep 7</text>
    <text x="4" y="24" font-size="9" fill="#9aa0a6">€1,600</text>
  </svg>`;
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function start(script, url) {
  if (await reachable(url)) return null;
  const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, stdio: 'ignore' });
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (await reachable(url)) return child;
  }
  child.kill();
  throw new Error(script + ' did not come up on ' + url);
}

// Playwright records webm. Most places that will show this want mp4, so convert when an
// ffmpeg binary is around - from DATAMOOV_FFMPEG or PATH. Absent one, the webm still stands.
async function toMp4() {
  const ffmpeg = process.env.DATAMOOV_FFMPEG || 'ffmpeg';
  const webm = path.join(out, 'datamoov-walkthrough.webm');
  const mp4 = path.join(out, 'datamoov-walkthrough.mp4');
  const done = await new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      [
        '-y',
        '-i', webm,
        // yuv420p and an even frame size are what the strictest players insist on.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '20',
        '-movflags', '+faststart',
        mp4,
      ],
      { stdio: 'ignore' }
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  console.log(
    done
      ? 'video data/walkthrough/datamoov-walkthrough.mp4'
      : 'note  no ffmpeg found; the webm is the only video (set DATAMOOV_FFMPEG to convert)'
  );
}

async function run() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const preview = await start('tools/preview.mjs', SIDEBAR);
  const stageServer = await start('tools/demo-stage.mjs', STAGE);

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1.5,
    recordVideo: { dir: out, size: { width: 1440, height: 900 } },
  });
  // A wrong selector should stop the run, not retry until the session times out.
  context.setDefaultTimeout(15_000);
  const page = await context.newPage();
  const side = page.frameLocator('#sidebar');

  let shot = 0;
  const pause = (ms) => page.waitForTimeout(ms);
  const stage = (method, ...args) =>
    page.evaluate(
      ([name, values]) => window.stage[name].apply(window.stage, values),
      [method, args]
    );
  const say = async (text, hold = 2200) => {
    await stage('say', text);
    await pause(hold);
  };
  // Clicking deep in a panel scrolls the sidebar, which would push the header mark out of
  // the still. Every capture starts from the top of the panel.
  const toTop = async () => {
    const frame = page.frames().find((item) => item.url().startsWith(SIDEBAR));
    if (frame) await frame.evaluate(() => window.scrollTo(0, 0));
    await pause(280);
  };
  const capture = async (name) => {
    await toTop();
    shot += 1;
    await page.screenshot({ path: path.join(out, `${String(shot).padStart(2, '0')}-${name}.png`) });
    console.log('shot  ' + String(shot).padStart(2, '0') + '-' + name);
  };

  await page.goto(STAGE);
  await page.waitForFunction(() => window.stage && window.stage.ready);
  await side.locator('#boot-state').waitFor({ state: 'hidden' });
  // The sidebar is a cross-origin frame, so reach it through Playwright rather than
  // contentDocument. Security software on the host injects a password-manager balloon over
  // password fields; it is not part of the sidebar and must not appear in the recording.
  const sidebarFrame = page.frames().find((frame) => frame.url().startsWith(SIDEBAR));
  if (sidebarFrame)
    await sidebarFrame.addStyleTag({ content: '.b_KlBalloonClass { display: none !important; }' });

  /* ---- Title card ---- */
  await stage('card', {
    show: true,
    mark: MARK,
    kicker: 'DataMoov for Google Sheets',
    title: 'Stop building queries.',
    text: 'Your marketing, database and CRM data in Sheets — and a chat that knows how to fetch it.',
  });
  await pause(3400);
  await capture('title');
  await stage('card', { show: false });
  await pause(800);

  /* ---- Act 1: connect once ---- */
  await say('Connect an account once. Every source you can reach carries its own mark.', 2600);
  await side.locator('#tab-connections').click();
  await pause(1600);
  await capture('connections');

  await say('Pick a source and DataMoov tells you exactly where its credentials come from.', 2400);
  await side.locator('#new-connection').click();
  await pause(600);
  await side.locator('#connection-provider').selectOption('google_ads');
  await pause(1100);
  await side.locator('#setup-guide summary').click();
  await pause(1600);
  await capture('credentials-guide');

  /* ---- Act 2: the familiar way ---- */
  await say('Build a report the familiar way: source, account, dates, columns, destination.', 2600);
  await side.locator('#cancel-connection').click();
  await side.locator('#tab-reports').click();
  await side.locator('#new-report').click();
  await pause(500);
  await side.locator('#report-provider').selectOption('google_ads');
  await pause(900);
  await side.locator('#report-name').fill('Daily campaign spend');
  await side.locator('#target-sheet').fill('Campaigns');
  await side.locator('#date-preset').selectOption('last30');
  await pause(1000);
  await capture('report-builder');

  await say('Preview the rows before a single cell is touched.', 2200);
  await side.locator('#preview-report').click();
  await side.locator('#data-preview').waitFor({ state: 'visible' });
  await pause(1600);
  await capture('report-preview');

  await say('Save it, and the rows land in the tab you named.', 2000);
  await side.locator('#report-schedule').selectOption('daily');
  await side.locator('#save-report').click();
  await pause(900);
  await stage('addTab', 'Campaigns', true);
  await stage('widths', null);
  await stage('report', {
    headers: [
      { label: 'Date' },
      { label: 'Campaign' },
      { label: 'Cost', num: true },
      { label: 'Clicks', num: true },
      { label: 'Impressions', num: true },
      { label: 'CTR', num: true },
    ],
    rows: CAMPAIGNS.map((row) => [
      row[0],
      row[1],
      money(row[2]),
      count(row[3]),
      count(row[4]),
      row[5],
    ]),
    speed: 110,
  });
  await pause(1200);
  await capture('report-written');

  await say(
    'A refresh replaces exactly those cells — daily, hourly, or on demand — and nothing else.',
    2800
  );

  /* ---- Act 3: skip the builder ---- */
  await stage('card', {
    show: true,
    mark: MARK,
    kicker: 'Or skip all of that',
    title: 'Just ask.',
    text: 'Chat runs a real report to answer — the same validation, the same writer.',
  });
  await pause(3000);
  await capture('card-ask');
  await stage('card', { show: false });
  await pause(700);

  // Chat says what it needs and links straight to it, which is how a first-time user gets here.
  await side.locator('#tab-chat').click();
  await pause(1100);
  await say('Chat asks for one AI key first — yours, on your own account.', 2400);
  await side.locator('#chat-open-settings').click();
  await pause(900);
  await side.locator('#ai-key').fill('preview-key-not-a-real-secret');
  await pause(700);
  await side.locator('#ai-save').click();
  await pause(1100);
  await say('Claude, GPT or Gemini. The key never leaves your Google account.', 2600);
  await capture('ai-settings');

  await side.locator('#tab-chat').click();
  await pause(900);
  await say('Now ask in plain language.', 1700);
  await side.locator('#chat-input').fill('Which campaign had the highest spend last month?');
  await pause(1100);
  await capture('chat-typed');
  await side.locator('#chat-send').click();
  await side.locator('.chat-message.assistant').first().waitFor({ state: 'visible' });
  await say('It shows every step it took — no black box.', 2200);
  await pause(600);

  const chip = side.locator('.chat-message.assistant .chip').first();
  if (await chip.count()) {
    await chip.click();
    await side
      .locator('.chat-message.assistant')
      .nth(1)
      .waitFor({ state: 'visible' });
  }
  await pause(1400);
  await stage('addTab', 'Spend by campaign', true);
  await stage('report', {
    headers: [
      { label: 'Campaign' },
      { label: 'Cost', num: true },
      { label: 'Clicks', num: true },
      { label: 'Avg CPC', num: true },
    ],
    rows: SPEND_BY_CAMPAIGN.map((row) => [row[0], money(row[1]), count(row[2]), row[3]]),
    speed: 200,
  });
  await pause(1000);
  await say('The answer is in the chat. The table is in the sheet.', 2600);
  await capture('chat-answer');

  /* ---- Act 4: the dashboard ---- */
  await say('Ask for a dashboard and you get scorecards, tables and native Sheets charts.', 2600);
  await side.locator('#chat-input').fill('Build me a performance dashboard');
  await pause(1000);
  await side.locator('#chat-send').click();
  await side
    .locator('.chat-message.assistant', { hasText: /Dashboard created/i })
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await pause(900);
  await stage('addTab', 'Performance dashboard', true);
  await stage('widths', [46, 150, 112, 96, 96, 104, 78, 88, 96, 96]);
  await stage('dashboard', {
    title: 'Performance dashboard',
    subtitle: 'Google Ads · last 30 days · refreshed just now',
    kpis: [
      { label: 'Total spend', value: '€7,410.75' },
      { label: 'Clicks', value: '9,560' },
      { label: 'Avg CPC', value: '€0.78' },
      { label: 'CTR', value: '4.02%' },
    ],
    tableTitle: 'Spend by campaign',
    headers: [
      { label: 'Campaign' },
      { label: 'Cost', num: true },
      { label: 'Clicks', num: true },
      { label: 'Avg CPC', num: true },
    ],
    rows: SPEND_BY_CAMPAIGN.map((row) => [row[0], money(row[1]), count(row[2]), row[3]]),
    charts: [
      { title: 'Spend by campaign', left: 60, top: 190, width: 324, svg: barChart() },
      { title: 'Daily spend', left: 416, top: 190, width: 324, svg: lineChart() },
    ],
  });
  await pause(1600);
  await capture('dashboard');

  await say(
    'Every tab it owns is listed, and one refresh rebuilds the whole thing — data and charts.',
    2800
  );
  await side.locator('#tab-reports').click();
  await pause(1600);
  await capture('dashboard-card');

  /* ---- End card ---- */
  await stage('say', '');
  await stage('card', {
    show: true,
    mark: MARK,
    kicker: 'No backend · your credentials never leave your Google account',
    title: 'Your data, in Sheets.',
    text: 'datamoov · by justdataplease.com',
  });
  await pause(3400);
  await capture('end');

  await context.close();
  await browser.close();
  if (preview) preview.kill();
  if (stageServer) stageServer.kill();

  for (const name of (await readdir(out)).filter((file) => file.endsWith('.webm'))) {
    await rename(path.join(out, name), path.join(out, 'datamoov-walkthrough.webm'));
  }
  console.log('video data/walkthrough/datamoov-walkthrough.webm');
  await toMp4();
}

run().catch((error) => {
  console.error('Walkthrough failed: ' + error.message);
  process.exitCode = 1;
});
