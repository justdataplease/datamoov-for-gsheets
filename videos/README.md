# Social videos

Short feature videos for LinkedIn and other feeds, recorded from the real sidebar and the real
dashboard renderer on fictional data. The `social-video` skill (`.claude/skills/social-video/`)
is the procedure; this page is the reference.

```
videos/
  kit/                    the recorder, stage, logo and fictional fixture
  <slug>/storyboard.mjs   one video: its scenes, captions and scripted chat
  <slug>/out/             renders (not in git): <slug>-<format>.mp4, -poster.png, -contact.png
```

```bash
npm run video -- videos/ppc-dashboard                  # the storyboard's first format
npm run video -- videos/ppc-dashboard --format all     # square, portrait and landscape
```

| Format | Size | Use |
| --- | --- | --- |
| square | 1080 × 1080 | LinkedIn and X feed (default) |
| portrait | 1080 × 1350 | mobile-first feeds |
| landscape | 1920 × 1080 | YouTube, the website, slides |

Needs an ffmpeg with libx264: `DATAMOOV_FFMPEG`, PATH, or a common install location
(`winget install Gyan.FFmpeg` adds one). Chrome is the installed one, as in the browser tests.

## Privacy

Nothing real can be recorded. The sidebar runs on the preview fixture (reshaped to Demo Store US /
EU), dashboards are drawn from `kit/demo-fixture.mjs`, and every request outside the two local
servers and Google Fonts is aborted. The sidebar's clock reads a fictional morning (1 Oct 2026,
03:26 in Los Angeles, just before the demo dashboard's refresh) and its date presets use that
timezone, so no real time or timezone is recorded. While recording, every frame's visible text and
inputs are scanned for account-shaped numbers, runs of 7+ digits, e-mails outside example.com and
every ID in the private files under `data/` and `.local/`; one hit fails the run and deletes that
render.

## Storyboard

```js
export const formats = ['square', 'portrait', 'landscape'];
export const dashboardFixture = '../kit/demo-fixture.mjs'; // optional: draw a dashboard
export const dashboardPlan = 'v2'; // optional, the tools/dashboard-preview.mjs plan
export const report = { type: 'keyword', tab: 'Keywords' }; // optional: a real report run, d.dashboard('report')
export function setupSidebar(data) {} // optional, replaces the default Demo Store setup

export default async function (d) {
  await d.card({ kicker: 'New in DataMoov for Google Sheets', title: 'One prompt. A dashboard.' });
  await d.look('chat', 1200);
  // ...
}
```

| Director call | Does |
| --- | --- |
| `d.card({ kicker, title, text, note, logo, hold, stay })` | Black card, white letters, the logo; holds `hold` ms (2,600), then fades unless `stay`; a card shown over a `stay` card swaps its words on black |
| `d.say(html, hold)` | Caption at the bottom; `''` hides it. `<em>` is the accent colour |
| `d.look(target, ms, { ease, band, floor })` | Camera to `'app'`, `'sidebar'`, `'chat'`, `'sheet'` or a world rectangle `{x, y, w, h}` (the world is 1,600 × 1,000); `ease` is `'inOut'` (default), `'out'`, `'in'` or `'linear'`. Landscape keeps no room for the caption, so there `band: true` frames a wide shot down to the app's bottom edge (the caption on the black below it) and `floor: y` ends a close-up at world y (the caption on the blank rows just above it); square and portrait already keep that room. Framing `'sidebar'` or `'chat'` (or `d.lookAt`) shades the sheet and tab strip, so no strip of the tab shows beside the panel |
| `d.drift(ms, zoom)` | A slow push in (`zoom` > 1, default 1.05) or pull out around the frame's centre, so a hold keeps moving; act only after it ends |
| `d.click(selector)`, `d.type(selector, text, { cps, paste })` | The pointer ring moves to a sidebar element and acts; `paste` lands at once after the typed part |
| `d.select(selector, value)`, `d.fill(selector, text, cps)` | Pointer to a sidebar select or input, then choose or type |
| `d.lookAt(selector, { h })`, `d.scrollTo(selector)` | Frame the sidebar around one element (in landscape with the caption's band free below it); scroll the panel to it |
| `d.sidebarSet(name, value)` | Hand the preview a value: `DATAMOOV_PREVIEW_REPORT_ROWS` / `_REPORT_META` (the builder's preview), `DATAMOOV_PREVIEW_RUN_ROWS` (a run's row count) |
| `d.side` | Playwright frame locator of the sidebar, for anything else |
| `d.chatScript(turns, stepMs)` | Queues chat answers, one per message: `{ steps: [labels], reply: { text, options, events } }` |
| `d.waitAnswers(n)` | Waits for the n-th assistant message |
| `d.dashboard(name)`, `d.reveal(ms, show)`, `d.dock(open)` | Loads a rendered page into the sheet, its grid drawn to the sheet's edges as Sheets does (rows stop at a `<meta name="rows" content="1001">` the page starts with); shows its grid and wipes its cells in over it (or out, `show` false, back to the empty grid); opens or closes the sidebar |
| `d.tab(name, active)`, `d.activate(name)` | Sheet tabs |
| `d.cell(ref, content)` | Pointer to a cell of the rendered tab (`'B4'`, `'A3:B4'`), selects it and shows `content` (a formula or a value) in the formula bar |
| `d.stage('formula', name, content)`, `d.stage('rect', 'fbar')`, `d.stage('wrapFormula', px)` | Sets the formula bar without a click; the bar's world rectangle; wraps its text at `px` world pixels (`null`: full width), so a close-up can frame a long formula whole |
| `d.section(title, { height, w, x, say, hold })` | Scrolls the dashboard to the section whose title cell reads `title` and frames it (in landscape with the caption's band free below it); the caption lands after the move |
| `d.wait(ms)`, `d.hidePointer()`, `d.stage(method, ...args)` | Pauses, hides the ring, calls the stage directly |
