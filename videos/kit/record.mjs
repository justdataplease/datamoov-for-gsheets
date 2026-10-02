/**
 * Records a short social video from a storyboard: black title cards with the DataMoov mark,
 * the real sidebar (tools/preview.mjs) docked in a Sheets stage, a camera that zooms between
 * them, and burned-in captions (feeds autoplay muted).
 *
 *   node videos/kit/record.mjs videos/<slug> [--format square|portrait|landscape|all] [--keep-frames]
 *
 * Writes videos/<slug>/out/<slug>-<format>.mp4, a poster PNG and a contact sheet to check.
 *
 * Privacy, by construction and by check:
 * - Nothing live is reachable. The sidebar runs on its sample fixture, a dashboard is drawn by
 *   tools/dashboard-preview.mjs from a fictional fixture, and every browser request other than
 *   the two local servers and Google Fonts is aborted.
 * - While recording, the visible text of every frame (and every input's value) is scanned for
 *   anything shaped like an account number, any e-mail address outside example.com, and every
 *   ID found in the private files under data/ and .local/. One hit fails the run and deletes
 *   the video.
 */
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderPreview } from '../../tools/preview.mjs';

const kit = fileURLToPath(new URL('./', import.meta.url));
const root = path.resolve(kit, '../..');
const HOST = '127.0.0.1';
const STAGE_PORT = 8894;
const SIDEBAR_PORT = 8895;
const STAGE = `http://${HOST}:${STAGE_PORT}`;
const SIDEBAR = `http://${HOST}:${SIDEBAR_PORT}`;
const ALLOWED = [STAGE, SIDEBAR, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const chrome =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

// Frame sizes social feeds favour. `reserve` keeps the bottom of the frame for captions when
// the camera frames the whole app.
const FORMATS = {
  square: { width: 1080, height: 1080, reserve: 0.2, caption: 36 },
  portrait: { width: 1080, height: 1350, reserve: 0.26, caption: 38 },
  landscape: { width: 1920, height: 1080, reserve: 0, caption: 38 },
};

// The DataMoov mark, white on its indigo tile.
const LOGO = readFileSync(path.join(kit, 'logo.svg'), 'utf8');

// ---------------------------------------------------------------------------------------------
// Privacy check

// IDs that must never be on screen: every long digit run, e-mail and long token in the private
// files. Values are compared, never printed.
function privateValues() {
  const found = new Set();
  const visit = (dir, depth) => {
    if (!existsSync(dir) || depth > 4) return;
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      const info = statSync(file);
      if (info.isDirectory()) {
        if (
          !['playwright-results', 'dashboard-preview', 'walkthrough', 'screenshots'].includes(name)
        )
          visit(file, depth + 1);
      } else if (/\.(json|txt|md|csv|env|ya?ml)$/i.test(name) && info.size < 5_000_000) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?<![\d.])\d(?:[-\s]?\d){5,11}(?![\d.])/g))
          found.add(m[0].replace(/\D/g, ''));
        for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))
          if (!/@example\.(com|org)$/i.test(m[0])) found.add(m[0].toLowerCase());
        for (const m of text.matchAll(/\b[A-Za-z0-9_-]{25,80}\b/g))
          if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0])) found.add(m[0]);
      }
    }
  };
  visit(path.join(root, 'data'), 0);
  visit(path.join(root, '.local'), 0);
  return found;
}

function makeGuard() {
  const secrets = privateValues();
  const digitSecrets = [...secrets].filter((value) => /^\d+$/.test(value));
  const otherSecrets = [...secrets].filter((value) => !/^\d+$/.test(value));
  const problems = new Map();
  const flag = (kind, sample, where) => {
    const key = kind + ':' + sample;
    if (!problems.has(key)) problems.set(key, { kind, sample, where });
  };
  return {
    size: secrets.size,
    problems,
    check(text, where) {
      for (const m of text.matchAll(/\b\d{3}-\d{3}-\d{4}\b/g))
        flag('account-shaped number', m[0], where);
      for (const m of text.matchAll(/\b\d{7,}\b/g)) flag('long digit run', m[0], where);
      for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g))
        if (!/@example\.(com|org)$/i.test(m[0])) flag('e-mail address', m[0], where);
      const digits = text.replace(/(?<=\d)[-\s](?=\d)/g, '');
      for (const value of digitSecrets)
        if (digits.includes(value)) flag('ID from a private file', '[hidden]', where);
      const lower = text.toLowerCase();
      for (const value of otherSecrets)
        if (lower.includes(value.toLowerCase()))
          flag('value from a private file', '[hidden]', where);
    },
  };
}

async function scanFrames(page, guard) {
  for (const frame of page.frames()) {
    let text = '';
    try {
      text = await frame.evaluate(() => {
        if (!document.body) return '';
        const values = [...document.querySelectorAll('input, textarea, select')]
          .filter((el) => el.type !== 'password' && el.type !== 'hidden' && el.checkVisibility())
          .map((el) => el.value);
        return document.body.innerText + '\n' + values.join('\n');
      });
    } catch {
      continue; // a frame navigating away mid-scan
    }
    guard.check(text, new URL(frame.url() || 'about:blank').port || frame.url());
  }
}

// ---------------------------------------------------------------------------------------------
// Servers: the stage (this folder and the render folder) and the sidebar preview.

const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve(port, handler) {
  const server = http.createServer(async (request, response) => {
    try {
      const out = await handler(new URL(request.url, 'http://x').pathname);
      if (!out) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'no-store' });
      response.end(out.body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(error.message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

function staticFrom(dirs) {
  return async (pathname) => {
    const [, mount, ...rest] = pathname.split('/');
    const base = dirs[mount];
    if (!base) return null;
    const file = path.resolve(base, ...rest.map(decodeURIComponent));
    if (!file.startsWith(path.resolve(base)) || !existsSync(file) || statSync(file).isDirectory())
      return null;
    return {
      type: TYPES[path.extname(file)] || 'application/octet-stream',
      body: readFileSync(file),
    };
  };
}

// ---------------------------------------------------------------------------------------------
// ffmpeg: DATAMOOV_FFMPEG, then PATH, then places a full build is commonly installed on Windows.

function findFfmpeg() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.DATAMOOV_FFMPEG,
    'ffmpeg',
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
    path.join(local, 'Microsoft/WinGet/Links/ffmpeg.exe'),
    path.join(local, 'Programs/Stremio/ffmpeg.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status === 0 && /libx264/.test(probe.stdout)) return candidate;
  }
  throw new Error(
    'No ffmpeg with libx264 found. Install one (winget install Gyan.FFmpeg) or set DATAMOOV_FFMPEG.'
  );
}

function ffmpeg(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg: ' + errors))));
  });
}

// ---------------------------------------------------------------------------------------------
// The director: what a storyboard can do.

function director({ page, stageCall, sidebarFrame, format, renderDir, slug }) {
  const side = page.frameLocator('#sidebar');
  const wait = (ms) => page.waitForTimeout(ms);
  const W = format.width;
  const named = async (target) => {
    if (typeof target === 'object') return target;
    if (target === 'app') return { x: -20, y: -20, w: 1640, h: 1040 };
    if (target === 'sidebar') {
      const r = await stageCall('rect', 'sidebar');
      return { x: r.x - 120, y: r.y - 50, w: r.w + 140, h: r.h + 50 };
    }
    // The conversation: the lower part of the sidebar, close enough to read on a phone.
    if (target === 'chat') {
      const r = await stageCall('rect', 'sidebar');
      return { x: r.x - 16, y: r.y + r.h * 0.3, w: r.w + 32, h: r.h * 0.7 };
    }
    if (target === 'sheet') return stageCall('rect', 'sheet');
    throw new Error('Unknown camera target ' + target);
  };
  // Moves the ring to a sidebar element, then acts on it.
  const pointAt = async (selector, press) => {
    const box = await side.locator(selector).first().boundingBox();
    if (!box) throw new Error('Not visible: ' + selector);
    const at = await stageCall('toWorld', box.x + box.width / 2, box.y + box.height / 2);
    await stageCall('point', at.x, at.y, press);
  };
  const d = {
    format,
    side,
    wait,
    stage: stageCall,
    async card(options) {
      await stageCall('card', options);
      await wait(options.hold ?? 2600);
      if (!options.stay) {
        await stageCall('card', { show: false });
        await wait(500);
      }
    },
    async say(html, hold = 0) {
      await stageCall('say', html || '');
      if (hold) await wait(hold);
    },
    async look(target, ms = 1200, options = {}) {
      await stageCall('look', await named(target), ms, options.reserve ?? format.reserve);
    },
    async click(selector) {
      await pointAt(selector, true);
      // The camera may frame only part of the app, leaving the element outside the page viewport,
      // where Playwright will not click; the element's own click is the same user action.
      await side
        .locator(selector)
        .first()
        .evaluate((element) => element.click());
    },
    async select(selector, value) {
      await pointAt(selector, true);
      await side.locator(selector).first().selectOption(value);
    },
    async fill(selector, text, cps = 30) {
      await pointAt(selector, true);
      const field = side.locator(selector).first();
      await field.fill('');
      await field.pressSequentially(String(text), { delay: 1000 / cps });
    },
    // Hands the sidebar preview a value, e.g. DATAMOOV_PREVIEW_REPORT_ROWS for the builder.
    async sidebarSet(name, value) {
      await sidebarFrame().evaluate(([key, data]) => (window[key] = data), [name, value]);
    },
    // Frames the sidebar around one element, `h` world pixels tall, so a long form stays readable.
    async lookAt(selector, { h = 520, ms = 1000 } = {}) {
      const box = await side.locator(selector).first().boundingBox();
      if (!box) throw new Error('Not visible: ' + selector);
      const at = await stageCall('toWorld', box.x + box.width / 2, box.y + box.height / 2);
      const r = await stageCall('rect', 'sidebar');
      await stageCall('look', { x: r.x - 16, y: at.y - h / 2, w: r.w + 32, h }, ms, format.reserve);
    },
    // Scrolls a sidebar element into view inside the panel.
    async scrollTo(selector) {
      await side.locator(selector).first().scrollIntoViewIfNeeded();
      await wait(450);
    },
    async type(selector, text, { cps = 32, paste = '' } = {}) {
      await pointAt(selector, true);
      const field = side.locator(selector).first();
      await field.click();
      await field.pressSequentially(text, { delay: 1000 / cps });
      if (paste) {
        // The rest arrives at once, as a pasted brief does.
        await field.evaluate((el, value) => {
          el.value += value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.scrollTop = 0;
        }, paste);
      }
    },
    hidePointer: () => stageCall('hidePointer'),
    // Queues the chat's answers, one per message sent: { steps: [labels], reply: {...} }.
    async chatScript(turns, stepMs = 900) {
      await sidebarFrame().evaluate(
        ([list, ms]) => {
          window.DATAMOOV_PREVIEW_CHAT_SCRIPT = list;
          window.DATAMOOV_PREVIEW_CHAT_STEP_MS = ms;
          window.DATAMOOV_PREVIEW_DELAY_MS = 120;
        },
        [turns, stepMs]
      );
    },
    async waitAnswers(count, timeout = 60_000) {
      await side
        .locator('.chat-message.assistant')
        .nth(count - 1)
        .waitFor({ state: 'visible', timeout });
    },
    async dashboard(name = 'dashboard') {
      await stageCall('dashboard', `${STAGE}/render/${slug}/dashboard/${name}.html`);
    },
    reveal: (ms) => stageCall('reveal', ms),
    dock: (open, ms) => stageCall('dock', open, ms),
    tab: (name, active = true) => stageCall('addTab', name, active),
    activate: (name) => stageCall('activate', name),
    // Scrolls the dashboard to a section and frames `height` world pixels of it (the full sheet
    // width unless `x`/`w` say otherwise).
    async section(title, { height = 520, offset = 12, x, w, ms = 1300, say, hold = 0 } = {}) {
      const sheet = await stageCall('rect', 'sheet');
      const scroll = stageCall('scrollDashboard', title, offset, ms);
      const rect = {
        x: sheet.x + (x ?? 0),
        y: sheet.y,
        w: w ?? Math.min(sheet.w, 1360),
        h: height,
      };
      await Promise.all([scroll, stageCall('look', rect, ms, format.reserve * 0.55)]);
      // The caption lands once the shot has settled.
      if (say !== undefined) await stageCall('say', say);
      if (hold) await wait(hold);
    },
    W,
  };
  return d;
}

// ---------------------------------------------------------------------------------------------

async function recordOne({
  videoDir,
  slug,
  storyboard,
  formatName,
  guard,
  ffmpegPath,
  keepFrames,
}) {
  const format = { name: formatName, ...FORMATS[formatName] };
  const renderDir = path.join(kit, '.render', slug);
  const framesDir = path.join(renderDir, 'frames-' + formatName);
  const outDir = path.join(videoDir, 'out');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const scale = Math.min(2, 2200 / Math.max(format.width, format.height));
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const blocked = [];
  try {
    const context = await browser.newContext({
      viewport: { width: format.width, height: format.height },
      deviceScaleFactor: scale,
      reducedMotion: 'no-preference',
    });
    context.setDefaultTimeout(20_000);
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (ALLOWED.some((origin) => url.startsWith(origin)) || /^(data|blob|about):/.test(url))
        return route.continue();
      blocked.push(url);
      return route.abort();
    });
    // The sidebar fixture, reshaped before it boots (see installPreview in tools/preview.mjs).
    const setup = storyboard.setupSidebar || defaultSetup;
    await context.addInitScript(
      `if (location.port === '${SIDEBAR_PORT}') window.DATAMOOV_PREVIEW_SETUP = (${setup.toString()});`
    );
    const page = await context.newPage();
    await page.goto(`${STAGE}/kit/stage.html`);
    await page.waitForFunction(() => window.stage && window.stage.ready);
    const stageCall = (method, ...args) =>
      page.evaluate(([name, values]) => window.stage[name](...values), [method, args]);
    await page.evaluate((logo) => (window.stage.logo = logo), LOGO);
    await page.evaluate((f) => {
      document.documentElement.style.setProperty('--caption-size', f.caption + 'px');
    }, format);
    // Start on black, the first card fading in over it.
    await stageCall('card', { logo: false });
    await stageCall('sidebar', `${SIDEBAR}/`);
    const sidebarFrame = () => page.frames().find((frame) => frame.url().startsWith(SIDEBAR));
    // Hidden also matches before the frame has loaded at all, so wait for the panel first.
    await page.frameLocator('#sidebar').locator('#tab-chat').waitFor({ state: 'visible' });
    await page.frameLocator('#sidebar').locator('#boot-state').waitFor({ state: 'hidden' });
    // The preview's banner (sample data, no writes) is the end card's "demo data" note instead.
    await sidebarFrame().addStyleTag({ content: '#preview-banner { display: none !important; }' });
    await stageCall('look', { x: -20, y: -20, w: 1640, h: 1040 }, 0, format.reserve);

    // Frames straight from the compositor, each with its own timestamp.
    const cdp = await context.newCDPSession(page);
    const frames = [];
    let writes = [];
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      const file = path.join(framesDir, 'f' + String(frames.length).padStart(6, '0') + '.jpg');
      frames.push({ file, at: metadata.timestamp });
      writes.push(writeFile(file, Buffer.from(data, 'base64')));
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 92,
      maxWidth: Math.round(format.width * scale),
      maxHeight: Math.round(format.height * scale),
      everyNthFrame: 1,
    });

    let scanning = true;
    const scanner = (async () => {
      while (scanning) {
        await scanFrames(page, guard);
        await page.waitForTimeout(400).catch(() => {});
      }
    })();

    const d = director({ page, stageCall, sidebarFrame, format, renderDir, slug });
    // A failing storyboard must stop the scan loop too, or the process never exits.
    try {
      await storyboard.default(d);
      await scanFrames(page, guard);
    } finally {
      scanning = false;
      await scanner;
    }
    const end = Date.now() / 1000;
    await cdp.send('Page.stopScreencast');
    await Promise.all(writes);
    await context.close();

    // Aborted, so nothing came in; named so a storyboard that needs a host finds out why not.
    // (Security software on the host injects scripts into every page; they are blocked too.)
    const hosts = [...new Set(blocked.map((url) => new URL(url).host))];
    if (hosts.length) console.log('blocked  ' + hosts.join(', '));
    if (guard.problems.size) {
      for (const suffix of ['.mp4', '-poster.png', '-contact.png'])
        await rm(path.join(outDir, slug + '-' + formatName + suffix), { force: true });
      const list = [...guard.problems.values()]
        .map((p) => `  ${p.kind}: ${p.sample} (frame ${p.where})`)
        .join('\n');
      throw new Error('Privacy check failed; no video was written:\n' + list);
    }
    if (frames.length < 10) throw new Error('Only ' + frames.length + ' frames were captured.');

    // Each frame holds until the next one; the last until the run ended.
    const lines = ['ffconcat version 1.0'];
    frames.forEach((frame, index) => {
      const next = index + 1 < frames.length ? frames[index + 1].at : end;
      lines.push(
        `file '${path.basename(frame.file)}'`,
        `duration ${Math.max(0.001, next - frame.at).toFixed(4)}`
      );
    });
    lines.push(`file '${path.basename(frames.at(-1).file)}'`);
    const list = path.join(framesDir, 'frames.ffconcat');
    await writeFile(list, lines.join('\n'));
    const base = path.join(outDir, `${slug}-${formatName}`);
    await ffmpeg(ffmpegPath, [
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-vf',
      `fps=30,scale=${format.width}:${format.height}:flags=lanczos,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '17',
      '-profile:v',
      'high',
      '-movflags',
      '+faststart',
      base + '.mp4',
    ]);
    // A poster (the opening card) and a contact sheet, one tile every two seconds, to check.
    await ffmpeg(ffmpegPath, [
      '-ss',
      '1.6',
      '-i',
      base + '.mp4',
      '-frames:v',
      '1',
      base + '-poster.png',
    ]);
    await ffmpeg(ffmpegPath, [
      '-i',
      base + '.mp4',
      '-vf',
      `fps=1/2,scale=${formatName === 'landscape' ? 384 : 270}:-1,tile=6x${Math.ceil((end - frames[0].at) / 12)}:padding=6:color=0x222222`,
      '-frames:v',
      '1',
      base + '-contact.png',
    ]);
    const seconds = end - frames[0].at;
    console.log(
      `video ${path.relative(root, base + '.mp4')}  ${seconds.toFixed(1)} s, ${frames.length} frames ` +
        `(${(frames.length / seconds).toFixed(1)} fps captured)`
    );
    if (!keepFrames) await rm(framesDir, { recursive: true, force: true });
  } finally {
    await browser.close();
  }
}

// Two Google Ads accounts with fictional names and no numbers, chat ready to answer.
function defaultSetup(data) {
  const ads = data.connections.find((item) => item.connectorId === 'google_ads');
  const ga4 = data.connections.find((item) => item.connectorId === 'ga4');
  const named = (base, id, label) => ({ ...base, id, label, values: {} });
  // A new report opens on the first source; Google Ads first keeps BigQuery's byte-limit default
  // (a long number) off screen.
  data.catalog.sort((a, b) => (b.id === 'google_ads') - (a.id === 'google_ads'));
  data.connections = [
    named(ads, 'demo-store-us', 'Demo Store US'),
    named(ads, 'demo-store-eu', 'Demo Store EU'),
  ].concat(ga4 ? [named(ga4, 'demo-store-web', 'Demo Store website')] : []);
  data.reports = [];
  data.dashboards = [];
  const provider =
    data.ai.providers.find((item) => item.id === 'anthropic') || data.ai.providers[0];
  Object.assign(data.ai, {
    configured: true,
    provider: provider.id,
    providerLabel: provider.label,
    model: provider.defaultModel,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find(
    (arg) => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--format'
  );
  if (!target)
    throw new Error(
      'Usage: node videos/kit/record.mjs videos/<slug> [--format square|portrait|landscape|all]'
    );
  const videoDir = path.resolve(target);
  const slug = path.basename(videoDir);
  const storyboard = await import(pathToFileURL(path.join(videoDir, 'storyboard.mjs')).href);
  const asked = args.includes('--format') ? args[args.indexOf('--format') + 1] : null;
  const formats =
    asked === 'all' ? Object.keys(FORMATS) : [asked || storyboard.formats?.[0] || 'square'];
  for (const name of formats) if (!FORMATS[name]) throw new Error('Unknown format ' + name);
  const ffmpegPath = findFfmpeg();
  const guard = makeGuard();
  console.log(`privacy  ${guard.size} private values loaded to keep off screen`);

  // A dashboard scene draws the real dashboard from the storyboard's fictional fixture.
  const renderDir = path.join(kit, '.render', slug);
  if (storyboard.dashboardFixture) {
    const fixture = path.resolve(videoDir, storyboard.dashboardFixture);
    const run = spawnSync(
      process.execPath,
      [
        path.join(root, 'tools/dashboard-preview.mjs'),
        '--plan',
        storyboard.dashboardPlan || 'v2',
        '--fixture',
        fixture,
        '--out',
        path.join(renderDir, 'dashboard'),
        '--html-only',
      ],
      { cwd: root, encoding: 'utf8' }
    );
    if (run.status !== 0) throw new Error('Dashboard render failed:\n' + run.stderr + run.stdout);
    const html = readFileSync(path.join(renderDir, 'dashboard', 'dashboard.html'), 'utf8');
    guard.check(html.replace(/<[^>]+>/g, ' '), 'dashboard render');
  }
  // A report scene draws the tab a real report run writes: { type, tab } of the fixture's reports.
  if (storyboard.report) {
    const run = spawnSync(
      process.execPath,
      [
        path.join(root, 'tools/dashboard-preview.mjs'),
        '--report',
        storyboard.report.type,
        '--tab',
        storyboard.report.tab,
        '--fixture',
        path.resolve(videoDir, storyboard.report.fixture || '../kit/demo-fixture.mjs'),
        '--out',
        path.join(renderDir, 'dashboard'),
      ],
      { cwd: root, encoding: 'utf8' }
    );
    if (run.status !== 0) throw new Error('Report render failed:\n' + run.stderr + run.stdout);
    const html = readFileSync(path.join(renderDir, 'dashboard', 'report.html'), 'utf8');
    guard.check(html.replace(/<[^>]+>/g, ' '), 'report render');
  }

  // A storyboard may write its own pages (prepare(dir)); they are checked like the renders above.
  if (storyboard.prepare) {
    const dir = path.join(renderDir, 'dashboard');
    await mkdir(dir, { recursive: true });
    await storyboard.prepare(dir);
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.html')))
      guard.check(readFileSync(path.join(dir, name), 'utf8').replace(/<[^>]+>/g, ' '), name);
  }

  const stage = await serve(STAGE_PORT, staticFrom({ kit, render: path.join(kit, '.render') }));
  const sidebar = await serve(SIDEBAR_PORT, async (pathname) =>
    pathname === '/' ? { type: TYPES['.html'], body: await renderPreview() } : null
  );
  try {
    for (const formatName of formats)
      await recordOne({
        videoDir,
        slug,
        storyboard,
        formatName,
        guard,
        ffmpegPath,
        keepFrames: args.includes('--keep-frames'),
      });
  } finally {
    stage.close();
    sidebar.close();
  }
}

main().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
