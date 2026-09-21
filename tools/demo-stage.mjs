/**
 * Serves the demo stage: a Google Sheets surface with the DataMoov sidebar docked to its
 * right, so a recording shows data actually landing in cells instead of a narrow panel on
 * its own. The sidebar is the real local preview in an iframe; the grid is a mock the
 * recorder drives through window.stage.
 *
 * Sample data only. Nothing live is contacted and nothing is written to a real spreadsheet.
 *
 *   node tools/demo-stage.mjs          # http://127.0.0.1:8893
 */
import http from 'node:http';

const host = '127.0.0.1';
const port = 8893;
const sidebarOrigin = 'http://127.0.0.1:8891';

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>DataMoov demo stage</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>
  :root {
    --chrome: #ffffff;
    --line: #e1e3e1;
    --grid-line: #e8eaed;
    --head: #f8f9fa;
    --ink: #202124;
    --muted: #5f6368;
    --sheets: #0f9d58;
    --indigo: #5146d6;
    --sel: #1a73e8;
    font-family: Inter, 'Segoe UI', Roboto, Arial, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #f8f9fa; color: var(--ink); }
  .app { height: 100%; display: grid; grid-template-rows: auto auto 1fr auto; }

  /* Sheets chrome ------------------------------------------------------ */
  .titlebar { display: flex; align-items: center; gap: 12px; padding: 9px 16px; background: var(--chrome); }
  .sheets-mark { width: 26px; height: 26px; flex: none; }
  .doc { display: grid; }
  .doc strong { font-size: 17px; font-weight: 500; line-height: 1.2; }
  .menu { display: flex; gap: 15px; font-size: 12.5px; color: var(--muted); margin-top: 2px; }
  .menu span.on { color: var(--indigo); font-weight: 600; }
  .right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .share { background: #c2e7ff; color: #001d35; font-size: 13px; font-weight: 500;
    padding: 8px 18px; border-radius: 100px; }
  .avatar { width: 30px; height: 30px; border-radius: 100px; background: var(--indigo);
    color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 600; }

  .toolbar { display: flex; align-items: center; gap: 4px; padding: 5px 12px;
    background: var(--chrome); border-bottom: 1px solid var(--line); }
  .tool { width: 28px; height: 28px; border-radius: 100px; display: grid; place-items: center;
    color: var(--muted); font-size: 13px; }
  .tool.wide { width: auto; padding: 0 9px; font-size: 12.5px; }
  .divider { width: 1px; height: 18px; background: var(--line); margin: 0 5px; }

  /* Body --------------------------------------------------------------- */
  .body { display: grid; grid-template-columns: 1fr 360px; min-height: 0; background: #fff; }
  .sheet { position: relative; overflow: hidden; }
  .grid { display: grid; grid-auto-rows: 25px; font-size: 12px; }
  .colhead, .rowhead { background: var(--head); color: var(--muted); font-size: 11px;
    display: grid; place-items: center; border-right: 1px solid var(--grid-line);
    border-bottom: 1px solid var(--grid-line); }
  .cell { border-right: 1px solid var(--grid-line); border-bottom: 1px solid var(--grid-line);
    padding: 0 7px; display: flex; align-items: center; overflow: hidden; white-space: nowrap;
    background: #fff; }
  .cell.num { justify-content: flex-end; font-variant-numeric: tabular-nums; }
  .cell.head { font-weight: 600; background: #eef1ff; }
  .cell.title { font-weight: 700; font-size: 16px; color: var(--indigo); }
  .cell.section { font-weight: 600; font-size: 12px; }
  .cell.muted { color: var(--muted); font-size: 11px; }
  .cell.kpi-label { color: var(--muted); font-size: 10px; }
  .cell.kpi-value { font-weight: 700; font-size: 17px; }
  .cell.spill { overflow: visible; z-index: 3; }
  .cell.landing { animation: land .5s ease; }
  @keyframes land {
    from { background: #e7f7ee; }
    to { background: #fff; }
  }
  .cell.head.landing { animation: landhead .5s ease; }
  @keyframes landhead {
    from { background: #cdebd9; }
    to { background: #eef1ff; }
  }

  .chartbox { position: absolute; background: #fff; border: 1px solid var(--line);
    border-radius: 3px; box-shadow: 0 1px 3px rgba(60,64,67,.24); padding: 10px 12px 6px;
    opacity: 0; transform: translateY(6px); transition: opacity .45s ease, transform .45s ease; }
  .chartbox.in { opacity: 1; transform: none; }
  .chartbox h4 { margin: 0 0 6px; font-size: 11.5px; font-weight: 600; }

  /* Sidebar ------------------------------------------------------------ */
  .dock { border-left: 1px solid var(--line); background: #f7f8fc; display: grid;
    grid-template-rows: auto 1fr; min-width: 0; }
  .dock-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px;
    background: #fff; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .dock-head b { color: var(--ink); font-weight: 600; font-size: 12.5px; }
  .dock-head .x { margin-left: auto; font-size: 15px; color: var(--muted); }
  iframe { width: 100%; height: 100%; border: 0; display: block; }

  /* Sheet tabs --------------------------------------------------------- */
  .tabs { display: flex; align-items: center; gap: 2px; padding: 0 12px;
    background: var(--chrome); border-top: 1px solid var(--line); height: 38px; }
  .plus { color: var(--muted); font-size: 17px; padding: 0 12px; }
  .tab { font-size: 12.5px; color: var(--muted); padding: 7px 14px; border-radius: 4px 4px 0 0;
    display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .tab.on { color: var(--indigo); font-weight: 600; background: #eef1ff;
    box-shadow: inset 0 -3px 0 var(--indigo); }
  .tab .dot { width: 7px; height: 7px; border-radius: 100px; background: var(--indigo); }
  .tab.fresh { animation: pop .6s ease; }
  @keyframes pop { from { transform: scale(.85); opacity: 0; } to { transform: none; opacity: 1; } }

  /* Caption ------------------------------------------------------------ */
  .caption { position: fixed; left: 0; right: 360px; bottom: 38px; z-index: 99;
    background: rgba(16,17,28,.94); color: #fff; padding: 13px 20px;
    font-size: 14px; font-weight: 500; letter-spacing: .01em; line-height: 1.45;
    opacity: 0; transition: opacity .3s ease; backdrop-filter: blur(3px); }
  .caption.on { opacity: 1; }
  .caption b { color: #b9b2ff; font-weight: 700; }

  .card { position: fixed; inset: 0; z-index: 200; background: #12121c; color: #fff;
    display: grid; place-items: center; text-align: center; opacity: 0; pointer-events: none;
    transition: opacity .5s ease; }
  .card.on { opacity: 1; }
  .card .inner { display: grid; gap: 18px; justify-items: center; padding: 40px; }
  .card .tile { width: 108px; height: 108px; border-radius: 26px; background: var(--indigo);
    display: grid; place-items: center; box-shadow: 0 20px 50px -20px rgba(81,70,214,.9); }
  .card h1 { margin: 0; font-size: 46px; font-weight: 700; letter-spacing: -.035em;
    max-width: 17ch; line-height: 1.08; text-wrap: balance; }
  .card p { margin: 0; font-size: 18px; color: #a9a9c4; max-width: 44ch; line-height: 1.5; }
  .card .note { margin: 6px 0 0; font-size: 13px; letter-spacing: .14em;
    text-transform: uppercase; color: #7a7a99; font-weight: 600; max-width: none; }
  .card .kicker { font-size: 11px; letter-spacing: .22em; text-transform: uppercase;
    color: #7a7a99; font-weight: 600; max-width: none; }
</style></head>
<body>
<div class="app">
  <div class="titlebar">
    <svg class="sheets-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0f9d58" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/>
      <path fill="#87ceac" d="M14 2v6h6l-6-6Z"/>
      <path fill="#fff" d="M8 12h8v6H8v-6Zm1 1.4v1.3h2.4v-1.3H9Zm3.6 0v1.3H15v-1.3h-2.4ZM9 15.9v1.3h2.4v-1.3H9Zm3.6 0v1.3H15v-1.3h-2.4Z"/>
    </svg>
    <div class="doc">
      <strong id="doc-title">Q3 Marketing</strong>
      <div class="menu"><span>File</span><span>Edit</span><span>View</span><span>Insert</span>
        <span>Format</span><span>Data</span><span>Tools</span><span class="on">Extensions</span>
        <span>Help</span></div>
    </div>
    <div class="right"><span class="share">Share</span><span class="avatar">JD</span></div>
  </div>

  <div class="toolbar">
    <span class="tool">&#8617;</span><span class="tool">&#8618;</span><span class="tool">&#128424;</span>
    <span class="divider"></span>
    <span class="tool wide">100%</span>
    <span class="divider"></span>
    <span class="tool">&euro;</span><span class="tool">%</span><span class="tool wide">.0</span>
    <span class="divider"></span>
    <span class="tool wide" style="font-weight:600">Inter</span>
    <span class="divider"></span>
    <span class="tool" style="font-weight:700">B</span>
    <span class="tool" style="font-style:italic">I</span>
    <span class="divider"></span>
    <span class="tool">&#9783;</span><span class="tool">&#9635;</span>
  </div>

  <div class="body">
    <div class="sheet"><div class="grid" id="grid"></div><div id="charts"></div></div>
    <div class="dock">
      <div class="dock-head"><b>DataMoov</b><span>by JustDataPlease</span><span class="x">&times;</span></div>
      <iframe id="sidebar" src="${sidebarOrigin}/" title="DataMoov sidebar"></iframe>
    </div>
  </div>

  <div class="tabs" id="tabs"><span class="plus">+</span></div>
</div>

<div class="caption" id="caption"></div>
<div class="card" id="card"><div class="inner">
  <div class="tile" id="card-tile"></div>
  <p class="kicker" id="card-kicker"></p>
  <h1 id="card-title"></h1>
  <p id="card-text"></p>
  <p class="note" id="card-note"></p>
</div></div>

<script>
(function () {
  var COLS = 9, ROWS = 26;
  var WIDTHS = [46, 92, 150, 96, 88, 104, 78, 88, 96, 96];
  var grid = document.getElementById('grid');
  var chartLayer = document.getElementById('charts');
  var tabsBar = document.getElementById('tabs');
  var cells = {};

  function letter(index) {
    var name = '', n = index;
    while (n >= 0) { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; }
    return name;
  }
  var widths = WIDTHS.slice();
  function applyWidths() {
    grid.style.gridTemplateColumns = widths.slice(0, COLS + 1)
      .map(function (w) { return w + 'px'; }).join(' ');
  }
  // Every child is placed explicitly, so a label that spans its neighbours cannot push the
  // rest of the row sideways.
  function build() {
    applyWidths();
    grid.replaceChildren();
    var corner = document.createElement('div');
    corner.className = 'colhead';
    corner.style.gridArea = '1 / 1';
    grid.appendChild(corner);
    for (var c = 0; c < COLS; c++) {
      var head = document.createElement('div');
      head.className = 'colhead';
      head.textContent = letter(c);
      head.style.gridArea = '1 / ' + (c + 2);
      grid.appendChild(head);
    }
    for (var r = 1; r <= ROWS; r++) {
      var rowHead = document.createElement('div');
      rowHead.className = 'rowhead';
      rowHead.textContent = String(r);
      rowHead.style.gridArea = (r + 1) + ' / 1';
      grid.appendChild(rowHead);
      for (var c2 = 0; c2 < COLS; c2++) {
        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.id = 'c-' + letter(c2) + r;
        cell.dataset.row = String(r + 1);
        cell.dataset.col = String(c2 + 2);
        cell.style.gridArea = (r + 1) + ' / ' + (c2 + 2);
        cells[letter(c2) + r] = cell;
        grid.appendChild(cell);
      }
    }
  }
  function clearGrid() {
    Object.keys(cells).forEach(function (key) {
      var cell = cells[key];
      cell.className = 'cell';
      cell.textContent = '';
      cell.style.gridArea = cell.dataset.row + ' / ' + cell.dataset.col;
    });
    chartLayer.replaceChildren();
  }
  function put(ref, text, kind, span) {
    var cell = cells[ref];
    if (!cell) return;
    cell.textContent = text === null || text === undefined ? '' : String(text);
    cell.className = 'cell' + (kind ? ' ' + kind : '') + (span > 1 ? ' spill' : '') + ' landing';
    cell.style.gridArea = span > 1
      ? cell.dataset.row + ' / ' + cell.dataset.col + ' / auto / span ' + span
      : cell.dataset.row + ' / ' + cell.dataset.col;
    setTimeout(function () { cell.classList.remove('landing'); }, 520);
  }
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var stage = {
    ready: true,
    async setTabs(names, active) {
      tabsBar.replaceChildren();
      names.forEach(function (name) {
        var tab = document.createElement('span');
        tab.className = 'tab' + (name === active ? ' on' : '');
        tab.textContent = name;
        tab.dataset.name = name;
        tabsBar.appendChild(tab);
      });
      var plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = '+';
      tabsBar.appendChild(plus);
    },
    async addTab(name, activate) {
      var tab = document.createElement('span');
      tab.className = 'tab fresh' + (activate ? ' on' : '');
      tab.dataset.name = name;
      var dot = document.createElement('span');
      dot.className = 'dot';
      tab.appendChild(dot);
      tab.appendChild(document.createTextNode(name));
      tabsBar.insertBefore(tab, tabsBar.lastChild);
      if (activate) stage.activate(name);
      await wait(320);
    },
    activate(name) {
      Array.prototype.forEach.call(tabsBar.querySelectorAll('.tab'), function (tab) {
        tab.classList.toggle('on', tab.dataset.name === name);
      });
    },
    clear() { clearGrid(); },
    widths(list) { widths = list && list.length ? list.slice() : WIDTHS.slice(); applyWidths(); },
    async report(options) {
      clearGrid();
      var headers = options.headers, rows = options.rows;
      headers.forEach(function (head, index) {
        put(letter(index) + '1', head.label, 'head' + (head.num ? ' num' : ''));
      });
      await wait(180);
      for (var r = 0; r < rows.length; r++) {
        for (var c = 0; c < headers.length; c++) {
          put(letter(c) + (r + 2), rows[r][c], headers[c].num ? 'num' : '');
        }
        await wait(options.speed || 70);
      }
    },
    async dashboard(plan) {
      clearGrid();
      put('A1', plan.title, 'title', 4);
      put('A2', plan.subtitle, 'muted', 4);
      await wait(260);
      for (var i = 0; i < plan.kpis.length; i++) {
        var col = letter(i * 2);
        put(col + '4', plan.kpis[i].label.toUpperCase(), 'kpi-label');
        put(col + '5', plan.kpis[i].value, 'kpi-value');
        await wait(190);
      }
      await wait(150);
      put('A15', plan.tableTitle, 'section', 3);
      for (var h = 0; h < plan.headers.length; h++)
        put(letter(h) + '16', plan.headers[h].label, 'head' + (plan.headers[h].num ? ' num' : ''));
      for (var r2 = 0; r2 < plan.rows.length; r2++) {
        for (var c2 = 0; c2 < plan.headers.length; c2++)
          put(letter(c2) + (r2 + 17), plan.rows[r2][c2], plan.headers[c2].num ? 'num' : '');
        await wait(70);
      }
      await wait(200);
      stage.charts(plan.charts || []);
      await wait(700);
    },
    charts(list) {
      chartLayer.replaceChildren();
      list.forEach(function (chart, index) {
        var box = document.createElement('div');
        box.className = 'chartbox';
        box.style.left = chart.left + 'px';
        box.style.top = chart.top + 'px';
        box.style.width = chart.width + 'px';
        var heading = document.createElement('h4');
        heading.textContent = chart.title;
        box.appendChild(heading);
        box.insertAdjacentHTML('beforeend', chart.svg);
        chartLayer.appendChild(box);
        setTimeout(function () { box.classList.add('in'); }, 120 + index * 220);
      });
    },
    say(text) {
      var node = document.getElementById('caption');
      node.innerHTML = text || '';
      node.classList.toggle('on', Boolean(text));
    },
    card(options) {
      var node = document.getElementById('card');
      document.getElementById('card-kicker').textContent = options.kicker || '';
      document.getElementById('card-title').textContent = options.title || '';
      document.getElementById('card-text').textContent = options.text || '';
      var note = document.getElementById('card-note');
      note.textContent = options.note || '';
      note.hidden = !options.note;
      document.getElementById('card-tile').innerHTML = options.mark || '';
      node.classList.toggle('on', options.show !== false);
    },
    title(name) { document.getElementById('doc-title').textContent = name; },
  };

  build();
  stage.setTabs(['Sheet1'], 'Sheet1');
  window.stage = stage;
})();
</script>
</body></html>`;

const server = http.createServer((request, response) => {
  if (request.url === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(page);
});

server.listen(port, host, () =>
  console.log('DataMoov demo stage: http://' + host + ':' + port + ' (sample data only)')
);
