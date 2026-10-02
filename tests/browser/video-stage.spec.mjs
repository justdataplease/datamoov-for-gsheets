import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { replay, renderSheet } from '../../tools/dashboard-preview.mjs';

// The video stage (videos/kit/stage.html). Its camera must never snap: the recorder keeps
// a frame only when Chrome paints one, so a camera that runs ahead while a frame is late shows as
// a hold and then a jump in the video.
const ORIGIN = 'http://stage.test';
const SIDEBAR = { x: 1200, y: 400, w: 400, h: 500 };

// A rendered tab smaller than the sheet area: one cell, so a few rows and the default columns.
function smallTab() {
  const requests = [
    { addSheet: { properties: { sheetId: 1, title: 'Tab', gridProperties: { columnCount: 3 } } } },
    {
      updateCells: {
        start: { sheetId: 1, rowIndex: 0, columnIndex: 0 },
        rows: [{ values: [{ userEnteredValue: { stringValue: 'Name' } }] }],
        fields: 'userEnteredValue',
      },
    },
  ];
  const model = replay([{ body: { requests } }], []);
  return renderSheet([...model.sheets.values()][0], model);
}

// The stage is served over http, so it can read the rendered tab inside its frame.
test.beforeEach(async ({ page }) => {
  await page.route('https://**', (route) => route.abort());
  await page.route(ORIGIN + '/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const tab = smallTab();
    const pages = { 'tab.html': tab, 'short.html': '<meta name="rows" content="6">' + tab };
    if (pages[name] !== undefined)
      return route.fulfill({ contentType: 'text/html', body: pages[name] });
    return route.fulfill({
      contentType: 'text/html',
      body: readFileSync(path.resolve('videos/kit', name)),
    });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(ORIGIN + '/stage.html');
  await page.waitForFunction(() => window.stage && window.stage.ready);
});

// Runs `script` in the stage while sampling the camera's on-screen width at every frame.
async function filmed(page, script) {
  return page.evaluate(async (body) => {
    const camera = document.getElementById('camera');
    const widths = [];
    let rolling = true;
    (function sample() {
      widths.push(camera.getBoundingClientRect().width);
      if (rolling) requestAnimationFrame(sample);
    })();
    await new Function('stage', 'return (async () => {' + body + '})()')(window.stage);
    rolling = false;
    return widths;
  }, script);
}

// The largest change between two frames, as a share of the whole change filmed.
function largestStep(widths) {
  const total = Math.max(...widths) - Math.min(...widths);
  const steps = widths.slice(1).map((width, index) => Math.abs(width - widths[index]));
  return Math.max(...steps) / total;
}

test('a late frame holds the camera instead of skipping ahead', async ({ page }) => {
  const widths = await filmed(
    page,
    `const moving = stage.look(${JSON.stringify(SIDEBAR)}, 1000);
     await new Promise((r) => setTimeout(r, 300));
     const until = performance.now() + 400;
     while (performance.now() < until) {}
     await moving;`
  );
  expect(largestStep(widths)).toBeLessThan(0.2);
});

test('a look starts from where the drift before it left the camera', async ({ page }) => {
  const widths = await filmed(
    page,
    `await stage.drift(600, 1.2);
     await stage.look(${JSON.stringify(SIDEBAR)}, 800);`
  );
  expect(largestStep(widths)).toBeLessThan(0.2);
});

test('the stage measures world rectangles correctly while the camera moves', async ({ page }) => {
  const [rest, moving] = await page.evaluate(async (target) => {
    const rest = window.stage.rect('sidebar');
    const move = window.stage.look(target, 1000);
    await new Promise((r) => setTimeout(r, 400));
    const during = window.stage.rect('sidebar');
    await move;
    return [rest, during];
  }, SIDEBAR);
  for (const key of ['x', 'y', 'w', 'h']) expect(moving[key]).toBeCloseTo(rest[key], 0);
});

test('a card over a card stays on black and fades its words across', async ({ page }) => {
  const seen = await page.evaluate(async () => {
    const card = document.getElementById('card');
    const words = card.querySelector('.inner');
    const title = document.getElementById('card-title');
    await window.stage.card({ title: 'First' });
    await new Promise((r) => setTimeout(r, 700));
    const samples = [];
    let rolling = true;
    (function sample() {
      const opacity = (node) => Number(getComputedStyle(node).opacity);
      samples.push({ card: opacity(card), words: opacity(words), title: title.textContent });
      if (rolling) requestAnimationFrame(sample);
    })();
    await window.stage.card({ title: 'Second' });
    await new Promise((r) => setTimeout(r, 700));
    rolling = false;
    return samples;
  });
  // The stage never shows through between the two cards.
  expect(Math.min(...seen.map((s) => s.card))).toBe(1);
  // The first words fade out before the second ones fade in.
  const swap = seen.findIndex((s) => s.title === 'Second');
  expect(swap).toBeGreaterThan(0);
  expect(seen[swap - 1].words).toBeLessThan(0.2);
  expect(seen.at(-1).words).toBe(1);
});

test('a tab draws as one grid: its rows and columns reach the sheet edges, its cells wipe in', async ({
  page,
}) => {
  const seen = await page.evaluate(async () => {
    const frame = document.getElementById('dashboard');
    await window.stage.dashboard('/tab.html');
    const wipe = window.stage.reveal(800);
    await new Promise((r) => setTimeout(r, 400));
    // Mid-wipe, near the bottom of the sheet: the tab's own grid, not the empty sheet under it.
    const box = frame.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + 300, box.bottom - 4);
    await wipe;
    const heads = [...frame.contentDocument.querySelectorAll('.head')].map((head) =>
      head.getBoundingClientRect()
    );
    return {
      under: under && under.id,
      bottom: Math.max(...heads.map((head) => head.bottom)),
      right: Math.max(...heads.map((head) => head.right)),
      width: frame.clientWidth,
      height: frame.clientHeight,
    };
  });
  expect(seen.under).toBe('dashboard');
  expect(seen.bottom).toBeGreaterThanOrEqual(seen.height);
  expect(seen.right).toBeGreaterThanOrEqual(seen.width);
});

test('a tab with a known last row stops its grid there', async ({ page }) => {
  const last = await page.evaluate(async () => {
    await window.stage.dashboard('/short.html');
    await window.stage.reveal(10);
    const doc = document.getElementById('dashboard').contentDocument;
    return [...doc.querySelectorAll('[id^="row-"]')].at(-1).textContent;
  });
  expect(last).toBe('6');
});

// When the camera frames the sidebar, the sheet beside it and the tab strip under it go dark, so
// no stray strip of the tab shows at the edge of the shot; the panel itself stays as it is.
test('shading the sheet darkens it and leaves the sidebar clear', async ({ page }) => {
  const seen = await page.evaluate(async () => {
    const shade = (id) => Number(getComputedStyle(document.getElementById(id), '::after').opacity);
    const opacity = () => Math.min(shade('sheet'), shade('tabs'));
    const atRight = () => {
      const box = document.getElementById('sidebar').getBoundingClientRect();
      return document.elementFromPoint(box.left + 20, box.top + 20).id;
    };
    window.stage.shade(true);
    await new Promise((r) => setTimeout(r, 900));
    const on = { shade: opacity(), sidebar: atRight() };
    window.stage.shade(false);
    await new Promise((r) => setTimeout(r, 900));
    return { on, off: Math.max(shade('sheet'), shade('tabs')) };
  });
  expect(seen.on.shade).toBe(1);
  expect(seen.on.sidebar).toBe('sidebar');
  expect(seen.off).toBe(0);
});
