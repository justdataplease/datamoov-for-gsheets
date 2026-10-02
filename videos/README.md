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
servers and Google Fonts is aborted. While recording, every frame's visible text and inputs are
scanned for account-shaped numbers, runs of 7+ digits, e-mails outside example.com and every ID
in the private files under `data/` and `.local/`; one hit fails the run and deletes that render.

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
| `d.card({ kicker, title, text, note, logo, hold, stay })` | Black card, white letters, the logo; holds `hold` ms (2,600), then fades unless `stay` |
| `d.say(html, hold)` | Caption at the bottom; `''` hides it. `<em>` is the accent colour |
| `d.look(target, ms)` | Camera to `'app'`, `'sidebar'`, `'chat'`, `'sheet'` or a world rectangle `{x, y, w, h}` (the world is 1,600 × 1,000) |
| `d.click(selector)`, `d.type(selector, text, { cps, paste })` | The pointer ring moves to a sidebar element and acts; `paste` lands at once after the typed part |
| `d.select(selector, value)`, `d.fill(selector, text, cps)` | Pointer to a sidebar select or input, then choose or type |
| `d.lookAt(selector, { h })`, `d.scrollTo(selector)` | Frame the sidebar around one element; scroll the panel to it |
| `d.sidebarSet(name, value)` | Hand the preview a value: `DATAMOOV_PREVIEW_REPORT_ROWS` / `_REPORT_META` (the builder's preview), `DATAMOOV_PREVIEW_RUN_ROWS` (a run's row count) |
| `d.side` | Playwright frame locator of the sidebar, for anything else |
| `d.chatScript(turns, stepMs)` | Queues chat answers, one per message: `{ steps: [labels], reply: { text, options, events } }` |
| `d.waitAnswers(n)` | Waits for the n-th assistant message |
| `d.dashboard()`, `d.reveal()`, `d.dock(open)` | Loads the rendered dashboard into the sheet, wipes it in, opens or closes the sidebar |
| `d.tab(name, active)`, `d.activate(name)` | Sheet tabs |
| `d.section(title, { height, w, x, say, hold })` | Scrolls the dashboard to the section whose title cell reads `title` and frames it; the caption lands after the move |
| `d.wait(ms)`, `d.hidePointer()`, `d.stage(method, ...args)` | Pauses, hides the ring, calls the stage directly |
