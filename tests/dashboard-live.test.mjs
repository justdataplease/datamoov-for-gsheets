import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildDashboard, useFixture } from '../tools/dashboard-preview.mjs';
import * as demo from '../videos/kit/demo-fixture.mjs';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { shownText } from './helpers/sheet-formulas.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// The page's cells as [row, column, shown value, formula], in row order.
function cellsOf(f, sheet) {
  return [...sheet.cells.keys()]
    .map((key) => key.split(':').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([row, column]) => [row, column, f.shown(sheet, row, column), f.formula(sheet, row, column)]);
}

// The numbers a page shows above its data sources (cards, changes, tables) that are not formulas,
// as [row, column, shown value]. Only the data sources list their row counts as written. The
// page must show at least least of them.
function literals(f, name, least = 6) {
  const cells = cellsOf(f, f.tab(name));
  const sources = cells.find(([, , value]) => value === 'Dataset')[0];
  const numbers = cells.filter(([row, , value]) => row < sources && (typeof value === 'number' || /^[▲▼▶] .* vs |^no (current|previous) value$|^previous 0$/.test(value)));
  assert.ok(numbers.length >= least, 'the page shows numbers');
  return numbers.filter(([, , , formula]) => !formula).map(([row, column, value]) => [row, column, value]);
}

const assertLive = (f, name) => {
  assert.deepEqual(literals(f, name), [], 'every number is a formula');
  const charts = cellsOf(f, f.tab(name + ' (chart data)'));
  assert.ok(charts.some(([, , value]) => typeof value === 'number'), 'the charts show numbers');
  assert.deepEqual(
    charts.filter(([, , value, formula]) => typeof value === 'number' && !formula),
    [],
    'every number behind the charts is a formula'
  );
};

// The text a cell shows, with its number format.
const textOf = (f, sheet, row, column) => shownText(f.shown(sheet, row, column), f.format(sheet, row, column).numberFormat);

// Every formula on a page and its chart data follows the data tabs: some change to one data cell
// moves what it shows. Each data cell in turn takes another value (a number 1000 more, text
// blank, a blank 1) and gets its own back. Returns the formulas, for checks of their form.
function assertMoves(f, name) {
  const sheets = [f.tab(name), f.tab(name + ' (chart data)')];
  const formulas = sheets.flatMap((sheet) =>
    cellsOf(f, sheet)
      .filter(([, , , formula]) => formula)
      .map(([row, column, , formula]) => ({ sheet, row, column, formula }))
  );
  const read = () => f.reading(() => formulas.map((cell) => f.shown(cell.sheet, cell.row, cell.column)));
  const before = read(),
    moved = before.map(() => false);
  const book = f.state.books.get(f.book.getId());
  const filled = (sheet, row, column) => row <= sheet.maxRows && !['', null, undefined].includes(sheet.cells.get(row + ':' + column)?.value);
  for (const data of book.sheets.filter((sheet) => / data$/.test(sheet.name))) {
    // The header is row 4, under the provenance rows; the data rows follow it.
    let width = 0;
    while (filled(data, 4, width + 1)) width++;
    for (let row = 5; Array.from({ length: width }, (_, c) => c + 1).some((column) => filled(data, row, column)); row++)
      for (let column = 1; column <= width; column++) {
        const key = row + ':' + column,
          entry = data.cells.get(key),
          value = entry ? entry.value : '';
        f.setCell(data, row, column, typeof value === 'number' ? value + 1000 : value === '' || value === null ? 1 : '');
        read().forEach((shown, index) => {
          if (!Object.is(shown, before[index])) moved[index] = true;
        });
        if (entry) data.cells.set(key, entry);
        else data.cells.delete(key);
      }
  }
  assert.deepEqual(read(), before, 'every data cell is back');
  assert.deepEqual(
    formulas.filter((cell, index) => !moved[index]).map((cell) => [cell.sheet.name, cell.row, cell.column, cell.formula]),
    [],
    'every formula moves with its data'
  );
  return formulas.map((cell) => cell.formula);
}

// What a refresh worked out in memory agrees with what its formulas show right after it: every
// scorecard, every chart point the chat reads (the previews it returns) and the numbers its
// highlights state. The highlights are sentences of the refresh, so they must not disagree.
function assertAgrees({ f, result, input }) {
  const name = input.target.sheetName,
    page = f.tab(name),
    charts = f.tab(name + ' (chart data)');
  // Compared charts keep four decimals in memory.
  const near = (shown, value, label) => {
    if (value === '' || value === null) return assert.equal(shown, '', label);
    assert.ok(typeof shown === 'number' && Math.abs(shown - value) <= 5e-5 + 1e-9 * Math.abs(value), `${label}: ${shown} is not ${value}`);
  };
  f.reading(() => {
    const cells = cellsOf(f, page),
      chartCells = cellsOf(f, charts);
    const below = (label) => {
      const found = cells.find(([, , value]) => value === label);
      return [found[0] + 1, found[1]];
    };
    for (const card of result.scorecards) near(f.shown(page, ...below(card.label)), card.value, card.label);
    // A chart's table on the chart data tab: its title row (with any note), then its points.
    const chart = (title) => {
      const at = chartCells.find(([, column, value]) => column === 1 && (value === title || String(value).startsWith(title + ' (')));
      const rows = [];
      for (let row = at[0] + 2; f.shown(charts, row, 1) !== ''; row++) rows.push(row);
      return { rows, note: at[2].slice(title.length) };
    };
    let compared = 0;
    for (const tile of result.tiles.filter((item) => item.type !== 'table')) {
      const { rows } = chart(tile.title),
        points = tile.preview.slice(1);
      // A trend's preview holds its latest points, any other chart's its first ones.
      const dated = /^\d{4}(-\d{2}){0,2}$/.test(String(points[0][0]));
      points.forEach((point, index) => {
        const row = dated ? rows[rows.length - points.length + index] : rows[index];
        point.slice(1).forEach((value, at) => {
          near(f.shown(charts, row, at + 2), value, tile.title + ' ' + point[0]);
          compared++;
        });
      });
    }
    assert.ok(compared > 0, 'chart points are compared');
    for (const text of result.highlights) {
      // "Spend rose 4.4% to 1,003 (previous 961).": its card and change line read the same.
      const change = /^(.+) (rose|fell) (\S+) to (.+) \(previous (.+)\)\.$/.exec(text);
      if (change) {
        const [row, column] = below(change[1]);
        assert.equal(textOf(f, page, row, column), change[4], text);
        assert.equal(f.shown(page, row + 1, column), (change[2] === 'rose' ? '▲ ' : '▼ ') + change[3] + ' vs ' + change[5], text);
      }
      // "Spend by channel type: Search holds 65.6% of the total.": the share of its chart's points.
      const share = /^(.+): (.+) holds (\S+) of /.exec(text);
      if (share) {
        const { rows, note } = chart(share[1]);
        if (/top/.test(note)) continue;
        const values = rows.map((row) => f.shown(charts, row, 2));
        const at = rows.findIndex((row) => f.shown(charts, row, 1) === share[2]);
        assert.equal(f.api.dmvDashboardPercent_(values[at] / values.reduce((sum, value) => sum + value, 0)), share[3], text);
      }
    }
  });
}

// A table card as it reads: its rows' non-empty cells, without in-cell bars, from its header to
// the end of the card.
function tableOf(f, name, title) {
  const sheet = f.tab(name),
    rows = [];
  // The last cell with the title: a section link may name the card too.
  let at = cellsOf(f, sheet).filter(([, , value]) => value === title).at(-1)[0] + 1;
  for (; ; at++) {
    const row = [];
    for (let c = 1; c <= sheet.maxColumns; c++) {
      const value = f.shown(sheet, at, c);
      if (value !== '' && !/^█+$/.test(value)) row.push(value);
    }
    if (!row.length) return rows;
    rows.push(row);
  }
}

for (const tier of ['v2', 'v2-basic', 'v1'])
  test(`the preview dashboard (plan ${tier}) shows live formulas that read exactly as before, refreshed twice`, async () => {
    const run = await buildDashboard({ tier, refresh: true, sourceRoot: root });
    assertLive(run.f, run.input.target.sheetName);
    assertAgrees(run);
  });

test('the demo shop of the videos shows live formulas that read exactly as before', async () => {
  useFixture(demo);
  const run = await buildDashboard({ tier: 'v2', refresh: false, sourceRoot: root });
  assertLive(run.f, run.input.target.sheetName);
  assertAgrees(run);
});

function liveFixture() {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  f.api.dmvRegisterConnector_({
    id: 'live_source',
    label: 'Live source',
    category: 'Test',
    allowedHosts: ['live.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: () => ({
          columns,
          rows: [
            { date: '2026-08-01', campaign: 'Brand', spend: 30, clicks: 10 },
            { date: '2026-08-02', campaign: 'Generic', spend: 50, clicks: 20 },
            { date: '2026-08-03', campaign: 'Brand', spend: 20, clicks: 5 },
          ],
          metadata: { complete: true, currency: 'EUR' },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'live_source', label: 'Live', credentials: { token: 'live-token' } });
  const saved = plain(
    f.api.dmvSaveDashboard({
      name: 'Live',
      target: { sheetName: 'Live page' },
      datasets: [
        {
          id: 'ads',
          label: 'Ads',
          sheetName: 'Ads data',
          connectionId: connection.id,
          reportType: 'daily',
          fields: columns.map((column) => column.key),
          config: {},
          dateRange: { preset: 'lastMonth' },
          maxRows: 100,
        },
      ],
      tiles: [
        {
          title: 'Totals',
          type: 'kpi',
          metrics: [{ field: 'spend', agg: 'sum' }],
          ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
        },
        { title: 'Daily spend', type: 'line', groupBy: ['date'], metrics: [{ field: 'spend', agg: 'sum' }] },
        {
          title: 'Campaigns',
          type: 'table',
          groupBy: ['campaign'],
          metrics: [{ field: 'spend', agg: 'sum' }],
          orderBy: { field: 'spend__sum', direction: 'desc' },
        },
      ],
    })
  );
  f.api.dmvRunDashboard(saved.id);
  return f;
}

test('a page follows its data tab: a changed amount moves its card, its row and its total at once', () => {
  const f = liveFixture(),
    page = f.tab('Live page'),
    data = f.tab('Ads data');
  const find = (value) => cellsOf(f, page).find((cell) => cell[2] === value);
  const below = (value) => {
    const [row, column] = find(value);
    return [row + 1, column];
  };
  const total = () => {
    const [row] = find('Total');
    return cellsOf(f, page).filter((cell) => cell[0] === row && typeof cell[2] === 'number')[0][2];
  };
  const brand = () => {
    const [row] = find('Brand');
    return cellsOf(f, page).filter((cell) => cell[0] === row && typeof cell[2] === 'number')[0][2];
  };
  assert.deepEqual([f.shown(page, ...below('Spend (EUR)')), f.shown(page, ...below('CPC (EUR)')), brand(), total()], [100, 100 / 35, 50, 100]);
  // Row 5 is the first data row: Brand on 1 Aug, spend in the third column.
  assert.equal(f.shown(data, 5, 2), 'Brand');
  f.setCell(data, 5, 3, 130);
  assert.deepEqual([f.shown(page, ...below('Spend (EUR)')), f.shown(page, ...below('CPC (EUR)')), brand(), total()], [200, 200 / 35, 150, 200]);
  f.setCell(data, 5, 3, 30);
  assert.deepEqual([f.shown(page, ...below('Spend (EUR)')), brand(), total()], [100, 50, 100], 'and back');
});

test('numbers in change lines and sentences round like the cells that show them', () => {
  const f = createDatamoovSandbox();
  // 746.145 is stored as 746.14499..., which toFixed prints 746.14; a Sheets cell shows 746.15.
  assert.deepEqual([f.api.dmvDashboardNumber_(746.145, 'currency'), f.api.dmvDashboardNumber_(-1.005, 'currency'), f.api.dmvDashboardNumber_(0.00125, 'number')], ['746.15', '-1.01', '0.0013']);
});

// Two accounts read together under shared column names, with names that hold the IFS wildcards
// and differ only by case, a blank name and dates across weeks.
function filtersFixture() {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  const rows = {
    one: [
      { date: '2026-08-01', campaign: 'Brand*', spend: 10, clicks: 2 },
      { date: '2026-08-15', campaign: 'brand*', spend: 5, clicks: 1 },
      { date: '2026-08-20', campaign: 'Gen?eric', spend: 7, clicks: 0 },
      { date: '2026-08-21', campaign: '', spend: 3, clicks: 4 },
    ],
    two: [
      { date: '2026-08-02', campaign: 'Brand*', spend: 20, clicks: 5 },
      { date: '2026-08-31', campaign: 'Other~x', spend: 1, clicks: 1 },
    ],
  };
  f.api.dmvRegisterConnector_({
    id: 'filter_source',
    label: 'Filter source',
    category: 'Test',
    allowedHosts: ['filter.example'],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: (ctx) => ({ columns, rows: rows[ctx.credentials.account], metadata: { complete: true, currency: 'EUR' } }),
      },
    ],
  });
  const datasets = ['one', 'two'].map((account) => {
    const connection = f.api.dmvSaveConnection({ connectorId: 'filter_source', label: account, credentials: { account } });
    return {
      id: account,
      label: account === 'one' ? 'One' : 'Two',
      sheetName: account + ' data',
      connectionId: connection.id,
      reportType: 'daily',
      fields: columns.map((column) => column.key),
      config: {},
      dateRange: { preset: 'lastMonth' },
      maxRows: 100,
      mapping: columns.map((column) => ({ field: column.key, key: column.key })),
    };
  });
  const table = (title, filters, extra = {}) => ({
    title,
    type: 'table',
    groupBy: ['campaign'],
    metrics: [{ field: 'spend', agg: 'sum' }],
    orderBy: { field: 'spend__sum', direction: 'desc' },
    filters,
    ...extra,
  });
  const saved = plain(
    f.api.dmvSaveDashboard({
      name: 'Filters',
      target: { sheetName: 'Filters page' },
      datasets,
      tiles: [
        {
          title: 'Totals',
          type: 'kpi',
          metrics: [
            { field: 'spend', agg: 'sum' },
            { field: 'clicks', agg: 'avg' },
            { field: 'clicks', agg: 'min' },
            { field: 'clicks', agg: 'max' },
            { field: 'campaign', agg: 'count' },
            { field: 'campaign', agg: 'count_distinct' },
          ],
        },
        { title: 'Daily spend', type: 'line', groupBy: ['date'], metrics: [{ field: 'spend', agg: 'sum' }] },
        table('Contains a star', [{ field: 'campaign', op: 'contains', value: '*' }]),
        table('Brand in any case', [{ field: 'campaign', op: 'eq', value: 'BRAND*' }]),
        table('Named', [{ field: 'campaign', op: 'ne', value: '' }]),
        table('Listed', [{ field: 'campaign', op: 'in', value: 'brand*, OTHER~X, brand*' }]),
        table('Busy', [{ field: 'clicks', op: 'gt', value: 1 }]),
        table('Late', [{ field: 'date', op: 'gte', value: '2026-08-15' }]),
        table('Second account', [{ field: 'source', op: 'eq', value: 'Two' }]),
        table('Weeks', [], {
          groupBy: ['date'],
          dateBucket: 'week',
          metrics: [
            { field: 'spend', agg: 'sum' },
            { field: 'clicks', agg: 'max' },
          ],
          orderBy: { field: 'date', direction: 'asc' },
        }),
      ],
    })
  );
  f.api.dmvRunDashboard(saved.id);
  return f;
}

test('filters, groups and every aggregate keep their meaning as formulas over several data tabs', () => {
  const f = filtersFixture(),
    page = 'Filters page';
  // The scorecards come first on the page.
  const cards = cellsOf(f, f.tab(page))
    .filter(([, , value]) => /^(Spend|Avg|Min|Max|Count|Distinct) /.test(value))
    .slice(0, 6);
  assert.deepEqual(
    cards.map(([row, column, label]) => [label, f.shown(f.tab(page), row + 1, column)]),
    [['Spend (EUR)', 46], ['Avg clicks', 13 / 6], ['Min clicks', 0], ['Max clicks', 5], ['Count of campaign', 5], ['Distinct campaign', 4]]
  );
  // Text filters match without regard to case and take * ? ~ literally; "in" counts a name once.
  assert.deepEqual(tableOf(f, page, 'Contains a star'), [['Campaign', 'Spend (EUR)'], ['Brand*', 30], ['brand*', 5], ['Total', 35]]);
  assert.deepEqual(tableOf(f, page, 'Brand in any case'), [['Campaign', 'Spend (EUR)'], ['Brand*', 30], ['brand*', 5], ['Total', 35]]);
  assert.deepEqual(tableOf(f, page, 'Named'), [['Campaign', 'Spend (EUR)'], ['Brand*', 30], ['Gen?eric', 7], ['brand*', 5], ['Other~x', 1], ['Total', 43]]);
  assert.deepEqual(tableOf(f, page, 'Listed'), [['Campaign', 'Spend (EUR)'], ['Brand*', 30], ['brand*', 5], ['Other~x', 1], ['Total', 36]]);
  // A blank name is a group of its own; a date filter compares dates; source picks a data tab.
  assert.deepEqual(tableOf(f, page, 'Busy'), [['Campaign', 'Spend (EUR)'], ['Brand*', 30], [3], ['Total', 33]]);
  assert.deepEqual(tableOf(f, page, 'Late'), [['Campaign', 'Spend (EUR)'], ['Gen?eric', 7], ['brand*', 5], [3], ['Other~x', 1], ['Total', 16]]);
  assert.deepEqual(tableOf(f, page, 'Second account'), [['Campaign', 'Spend (EUR)'], ['Brand*', 20], ['Other~x', 1], ['Total', 21]]);
  // Weeks start on Monday: 1 and 2 August share the week of 27 July.
  assert.deepEqual(tableOf(f, page, 'Weeks'), [
    ['Date', 'Spend (EUR)', 'Max clicks'],
    ['2026-07-27', 30, 5],
    ['2026-08-10', 5, 1],
    ['2026-08-17', 10, 4],
    ['2026-08-31', 1, 1],
    ['Total', 46, 5],
  ]);
  // Every number is live, also where the IFS functions cannot say a value exactly: rows a name in
  // another case would join (EXACT tells them apart) and a distinct count over two tabs.
  assert.deepEqual(literals(f, page), []);
  const formulas = assertMoves(f, page);
  assert.ok(formulas.some((formula) => /EXACT\(/.test(formula)), 'names split by case');
  assert.ok(formulas.some((formula) => /COUNTUNIQUE\(FILTER\(VSTACK\(/.test(formula)), 'a distinct count over two tabs');
  // An "in" filter is one array criterion, so each data tab takes one SUMIFS, not one per option.
  const cells = cellsOf(f, f.tab(page));
  const listed = cells.filter((cell) => cell[2] === 'Other~x').map(([row]) => cells.find((cell) => cell[0] === row && typeof cell[2] === 'number'));
  const inListed = listed.find(([, , , formula]) => formula.includes('{'))[3];
  assert.match(inListed, /\{"=brand~\*";"=other~~x"\}/);
  assert.equal(inListed.split('SUMIFS(').length - 1, 2, inListed);
});

// Compared charts count each period's buckets from its own first day: a month bucket of a period
// that starts on the 31st runs to the 31st of the next month that has one (1 March after
// February), and a previous period longer than the current one keeps as many days.
function comparedFixture() {
  const f = createDatamoovSandbox();
  // Refreshed in October, so last month (30 days) is compared with August (31 days).
  f.advance(Date.parse('2026-10-05T12:00:00Z') - f.api.Date.now());
  // The chat reads every chart point, whole.
  f.api.DMV_DASHBOARD.previewRows = 1000;
  f.api.DMV_DASHBOARD.previewTileChars = 1e7;
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  const day = (text) => Date.parse(text + 'T00:00:00Z') / 86400000;
  f.api.dmvRegisterConnector_({
    id: 'daily_source',
    label: 'Daily source',
    category: 'Test',
    allowedHosts: ['daily.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        // One row a day, its amounts telling the days apart.
        fetch: (ctx) => ({
          columns,
          rows: Array.from({ length: day(ctx.endDate) - day(ctx.startDate) + 1 }, (_, i) => {
            const n = day(ctx.startDate) + i;
            return { date: new Date(n * 86400000).toISOString().slice(0, 10), spend: 1 + (n % 17) + (n % 100) / 100, clicks: 1 + (n % 5) };
          }),
          metadata: { complete: true, currency: 'EUR' },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'daily_source', label: 'Daily', credentials: { token: 'daily-token' } });
  const dataset = (id, dateRange) => ({
    id,
    label: id,
    sheetName: id + ' data',
    connectionId: connection.id,
    reportType: 'daily',
    fields: columns.map((column) => column.key),
    config: {},
    dateRange,
    maxRows: 1000,
    mapping: columns.map((column) => ({ field: column.key, key: column.key })),
  });
  const chart = (title, dateBucket, datasets) => ({
    title,
    type: 'line',
    datasets,
    groupBy: ['date'],
    dateBucket,
    metrics: [
      { field: 'spend', agg: 'sum' },
      { field: 'clicks', agg: 'max' },
      { field: 'spend', agg: 'avg' },
    ],
    ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
    compare: { current: datasets[0], previous: datasets[1] },
  });
  const input = plain({
    name: 'Compared',
    target: { sheetName: 'Compared page' },
    datasets: [
      dataset('spring', { preset: 'custom', startDate: '2026-01-31', endDate: '2026-04-29' }),
      dataset('winter', { preset: 'custom', startDate: '2025-11-03', endDate: '2026-01-30' }),
      dataset('september', { preset: 'lastMonth' }),
      dataset('august', { preset: 'previousMonth' }),
    ],
    tiles: [
      {
        title: 'September',
        type: 'kpi',
        datasets: ['september', 'august'],
        metrics: [
          { field: 'spend', agg: 'sum' },
          { field: 'clicks', agg: 'sum' },
        ],
        ratios: [{ key: 'cpc', label: 'CPC', numerator: 'spend', denominator: 'clicks' }],
        compare: { current: 'september', previous: 'august' },
      },
      chart('Months from the 31st', 'month', ['spring', 'winter']),
      chart('Days of September', 'day', ['september', 'august']),
      chart('Weeks of September', 'week', ['september', 'august']),
    ],
  });
  const saved = plain(f.api.dmvSaveDashboard(input));
  const result = plain(f.api.dmvRunDashboard(saved.id));
  return { f, result, input };
}

test('compared charts are live over each period from its own first day, by day, week and month', () => {
  const run = comparedFixture();
  assertLive(run.f, 'Compared page');
  assertAgrees(run);
  const titles = cellsOf(run.f, run.f.tab('Compared page (chart data)')).filter(([, column, value]) => column === 1 && /^(Months|Days|Weeks) /.test(value));
  assert.deepEqual(titles.map(([, , value]) => value), [
    'Months from the 31st (vs 3 Nov 2025 – 30 Jan 2026)',
    'Days of September (vs 1 Aug – 30 Aug 2026 (same days))',
    'Weeks of September (vs 1 Aug – 30 Aug 2026 (same days))',
  ]);
});

test('a bucket of a compared chart starts on the first day its period counts into it', () => {
  const f = createDatamoovSandbox();
  const day = (text) => Date.parse(text + 'T00:00:00Z') / 86400000;
  const text = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  for (const start of ['2026-01-28', '2026-01-29', '2026-01-31', '2024-02-29', '2026-03-31', '2026-08-01'])
    for (const bucket of ['day', 'week', 'month', 'year'])
      for (let index = 0; index < 14; index++) {
        let first = day(start);
        while (f.api.dmvDashboardBucket_(text(first), start, bucket) < index) first++;
        assert.equal(f.api.dmvDashboardBucketStart_(start, index, bucket), text(first), [start, bucket, index].join(' '));
      }
});

// A chart's points on the chart data tab, each as its label and values.
function pointsOf(f, name, title) {
  const charts = f.tab(name + ' (chart data)');
  const at = cellsOf(f, charts).find(([, column, value]) => column === 1 && (value === title || String(value).startsWith(title + ' (')))[0];
  const points = [];
  for (let row = at + 2; f.shown(charts, row, 1) !== ''; row++) {
    const point = [];
    for (let column = 1; column <= charts.maxColumns && f.shown(charts, row, column) !== ''; column++) point.push(f.shown(charts, row, column));
    points.push(point);
  }
  return points;
}

// A dashboard over accounts of one source under shared column names: "now" holds last month and
// "before", when given, the month before. setup(f) runs before the first refresh; f.run()
// refreshes again.
function edgeFixture(columns, accounts, tiles, setup = () => {}) {
  const f = createDatamoovSandbox();
  f.api.dmvRegisterConnector_({
    id: 'edge_source',
    label: 'Edge source',
    category: 'Test',
    allowedHosts: ['edge.example'],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: (ctx) => ({ columns, rows: accounts[ctx.credentials.account], metadata: { complete: true, currency: 'EUR' } }),
      },
    ],
  });
  const datasets = Object.keys(accounts).map((account) => ({
    id: account,
    label: account === 'now' ? 'Now' : 'Before',
    sheetName: account + ' data',
    connectionId: f.api.dmvSaveConnection({ connectorId: 'edge_source', label: account, credentials: { account } }).id,
    reportType: 'daily',
    fields: columns.map((column) => column.key),
    config: {},
    dateRange: { preset: account === 'now' ? 'lastMonth' : 'previousMonth' },
    maxRows: 100,
    mapping: columns.map((column) => ({ field: column.key, key: column.key })),
  }));
  // A dashboard needs a chart: rows by the first column, unless the test brings its own.
  const chart = { title: 'Rows', type: 'bar', datasets: ['now'], groupBy: [columns[0].key], metrics: [{ field: columns[0].key, agg: 'count' }] };
  if (!tiles.some((tile) => !['kpi', 'table'].includes(tile.type))) tiles = tiles.concat([chart]);
  const saved = plain(f.api.dmvSaveDashboard({ name: 'Edges', target: { sheetName: 'Edges page' }, datasets, tiles }));
  f.run = () => plain(f.api.dmvRunDashboard(saved.id));
  setup(f);
  f.run();
  return f;
}

// The values the page shows below each cell that reads label (a scorecard), with the change line
// below them.
const cardsOf = (f, label) => {
  const page = f.tab('Edges page');
  return cellsOf(f, page)
    .filter((cell) => cell[2] === label)
    .map(([row, column]) => [f.shown(page, row + 1, column), f.shown(page, row + 2, column)]);
};

test('date groups of a timestamp column are live over the days their text starts with', () => {
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'ticket', type: 'text' },
  ];
  const days = ['2026-08-03T10:00:00Z', '2026-08-04T23:30:00Z', '2026-08-10T09:00:00Z', '2026-08-11T12:00:00Z', '2026-08-16T08:15:00Z'];
  const tickets = { title: 'Tickets by week', type: 'column', datasets: ['now'], groupBy: ['date'], dateBucket: 'week', metrics: [{ field: 'ticket', agg: 'count' }] };
  const f = edgeFixture(columns, { now: days.map((date, index) => ({ date, ticket: 'T' + index })) }, [
    { ...tickets, title: 'Weekly tickets', type: 'table', orderBy: { field: 'date', direction: 'asc' } },
    tickets,
  ]);
  assert.deepEqual(tableOf(f, 'Edges page', 'Weekly tickets').slice(1), [['2026-08-03', 2], ['2026-08-10', 3], ['Total', 5]]);
  assert.deepEqual(pointsOf(f, 'Edges page', 'Tickets by week').map((point) => point.slice(1)), [[2], [3]]);
  assert.equal(f.shown(f.tab('now data'), 5, 1), '2026-08-03T10:00:00Z', 'the data tab keeps the timestamps');
  assert.deepEqual(literals(f, 'Edges page', 3), []);
  // Text that starts with a day sorts between it and the next day: no LEFT over every cell.
  assert.ok(assertMoves(f, 'Edges page').some((formula) => /\('now data'!\$A\$5:\$A\$9>="2026-08-03"\)\*\('now data'!\$A\$5:\$A\$9<"2026-08-10"\)/.test(formula)));
});

test('an aggregate blank at refresh stays blank, with its ratios and change, where a formula would say 0', () => {
  const columns = [
    { key: 'stage', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'conversions', type: 'number' },
    { key: 'amount', type: 'currency' },
  ];
  const row = (stage, spend, conversions, amount) => ({ stage, spend, conversions, amount });
  const compare = { datasets: ['now', 'before'], compare: { current: 'now', previous: 'before' } };
  const f = edgeFixture(
    columns,
    {
      now: [row('Lead', 10, '', ''), row('Won', 20, 2, '')],
      before: [row('Lead', 5, 3, 50), row('Won', 10, 1, 70)],
    },
    [
      {
        title: 'Totals',
        type: 'kpi',
        ...compare,
        metrics: [
          { field: 'amount', agg: 'sum' },
          { field: 'conversions', agg: 'sum' },
        ],
      },
      {
        title: 'Stages',
        type: 'table',
        ...compare,
        groupBy: ['stage'],
        metrics: [
          { field: 'spend', agg: 'sum' },
          { field: 'conversions', agg: 'sum' },
        ],
        ratios: [
          { key: 'cpa', label: 'CPA', numerator: 'spend', denominator: 'conversions' },
          { key: 'cr', label: 'CR', numerator: 'conversions', denominator: 'spend' },
        ],
        orderBy: { field: 'stage', direction: 'asc' },
      },
    ]
  );
  const page = f.tab('Edges page');
  // Lead has no conversions now: they, their change and both ratios read blank, not 0 or -100%.
  const [lead] = cellsOf(f, page).find((cell) => cell[2] === 'Lead');
  const header = cellsOf(f, page).filter((cell) => cell[0] === lead - 1 && cell[2] !== '');
  assert.deepEqual(
    header.map(([, column, label]) => [label, f.shown(page, lead, column)]),
    [['Stage', 'Lead'], ['Spend (EUR)', 10], ['Δ %', 1], ['Conversions', ''], ['Δ %', ''], ['CPA (EUR)', ''], ['Δ %', ''], ['CR (EUR)', ''], ['Δ %', '']]
  );
  // A card whose sum has no values reads blank, and its change line says so.
  assert.deepEqual(cardsOf(f, 'Amount (EUR)'), [['', 'no current value']]);
  // The blanks are formulas too: a value on the data tab fills them.
  for (const [, column] of header.slice(1)) assert.notEqual(f.formula(page, lead, column), '', 'Lead column ' + column);
  assertMoves(f, 'Edges page');
  // Lead's conversions are row 5, column C of the current tab.
  try {
    f.setCell(f.tab('now data'), 5, 3, 4);
    assert.deepEqual(
      header.map(([, column]) => f.shown(page, lead, column)),
      ['Lead', 10, 1, 4, (4 - 3) / 3, 2.5, (2.5 - 5 / 3) / (5 / 3), 0.4, (0.4 - 0.6) / 0.6]
    );
  } finally {
    f.setCell(f.tab('now data'), 5, 3, '');
  }
  assert.deepEqual(cardsOf(f, 'Amount (EUR)'), [['', 'no current value']], 'and back');
});

test('a change line without a previous value is live: a previous value on its tab fills it in', () => {
  const columns = [
    { key: 'stage', type: 'text' },
    { key: 'spend', type: 'currency' },
  ];
  const f = edgeFixture(columns, { now: [{ stage: 'Lead', spend: 10 }], before: [{ stage: 'Lead', spend: '' }] }, [
    { title: 'Totals', type: 'kpi', datasets: ['now', 'before'], compare: { current: 'now', previous: 'before' }, metrics: [{ field: 'spend', agg: 'sum' }] },
  ]);
  assert.deepEqual(cardsOf(f, 'Spend (EUR)'), [[10, 'no previous value']]);
  assertMoves(f, 'Edges page');
  try {
    f.setCell(f.tab('before data'), 5, 2, 8);
    assert.deepEqual(cardsOf(f, 'Spend (EUR)'), [[10, '▲ 25.0% vs 8.00']]);
  } finally {
    f.setCell(f.tab('before data'), 5, 2, '');
  }
  assert.deepEqual(cardsOf(f, 'Spend (EUR)'), [[10, 'no previous value']], 'and back');
});

test('text that Sheets would read as a number, date or boolean keeps its group and filter numbers, live', () => {
  const columns = [
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
  ];
  const names = ['2026-09', '50%', '$5', '1/2', 'TRUE', '10:00', 'Sep 2026', 'Summer 2026'];
  const kpi = (filters) => ({ title: 'Spend', type: 'kpi', datasets: ['now'], metrics: [{ field: 'spend', agg: 'sum' }], filters });
  const f = edgeFixture(columns, { now: names.map((campaign, index) => ({ campaign, spend: index + 1 })) }, [
    kpi([{ field: 'campaign', op: 'eq', value: '50%' }]),
    kpi([{ field: 'campaign', op: 'in', value: 'true, 1/2' }]),
    kpi([{ field: 'campaign', op: 'ne', value: '$5' }]),
    { title: 'Campaigns', type: 'table', datasets: ['now'], groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], orderBy: { field: 'spend__sum', direction: 'asc' } },
  ]);
  assert.deepEqual(
    tableOf(f, 'Edges page', 'Campaigns').slice(1),
    names.map((name, index) => [name, index + 1]).concat([['Total', 36]])
  );
  assert.deepEqual(cardsOf(f, 'Spend (EUR)').slice(0, 3).map((card) => card[0]), [2, 9, 33]);
  // A name Sheets reads as text takes the IFS functions; one it would read as a number, date or
  // boolean is compared as the text it is.
  const page = f.tab('Edges page');
  const formulaOf = (name) => {
    const [row] = cellsOf(f, page).find((cell) => cell[2] === name);
    return cellsOf(f, page).find((cell) => cell[0] === row && typeof cell[2] === 'number')[3];
  };
  assert.match(formulaOf('Summer 2026'), /^=SUMIFS\(/);
  assert.match(formulaOf('50%'), /EXACT\('now data'!\$A\$5:\$A\$12,"50%"\)/);
  assert.deepEqual(literals(f, 'Edges page'), []);
  assertMoves(f, 'Edges page');
});

// Snowflake, BigQuery and Postgres return a boolean column as true and false, written as booleans.
test('a group of a boolean column is live over the booleans it holds, in a table and a chart', () => {
  const columns = [
    { key: 'paid', type: 'text' },
    { key: 'amount', type: 'currency' },
  ];
  const groups = { datasets: ['now'], groupBy: ['paid'], metrics: [{ field: 'amount', agg: 'sum' }] };
  const f = edgeFixture(columns, { now: [{ paid: true, amount: 30 }, { paid: false, amount: 20 }, { paid: true, amount: 5 }] }, [
    { title: 'Paid or not', type: 'table', ...groups, orderBy: { field: 'amount__sum', direction: 'desc' } },
    { title: 'Amount by paid', type: 'bar', ...groups },
  ]);
  assert.deepEqual(tableOf(f, 'Edges page', 'Paid or not').slice(1), [[true, 35], [false, 20], ['Total', 55]]);
  assert.deepEqual(pointsOf(f, 'Edges page', 'Amount by paid').map((point) => point.slice(1)), [[35], [20]]);
  assert.deepEqual(literals(f, 'Edges page', 3), []);
  assertMoves(f, 'Edges page');
});

// Sheets reads an empty cell as FALSE and as 0, where the summary keeps blanks in a group of
// their own: the FALSE and the 0 groups count no blank row.
test('a group of FALSE among blanks counts no blank row, live', () => {
  const columns = [
    { key: 'paid', type: 'text' },
    { key: 'amount', type: 'currency' },
  ];
  const groups = { datasets: ['now'], groupBy: ['paid'], metrics: [{ field: 'amount', agg: 'sum' }] };
  const f = edgeFixture(columns, { now: [{ paid: true, amount: 30 }, { paid: false, amount: 20 }, { paid: '', amount: 7 }, { paid: false, amount: 1 }] }, [
    { title: 'Paid or not', type: 'table', ...groups, orderBy: { field: 'amount__sum', direction: 'desc' } },
    { title: 'Amount by paid', type: 'bar', ...groups },
  ]);
  assert.deepEqual(tableOf(f, 'Edges page', 'Paid or not').slice(1), [[true, 30], [false, 21], [7], ['Total', 58]]);
  assert.deepEqual(literals(f, 'Edges page', 3), []);
  assertMoves(f, 'Edges page');
});

test('a group of 0 among blanks and text counts no blank row, live', () => {
  const columns = [
    { key: 'code', type: 'text' },
    { key: 'amount', type: 'currency' },
  ];
  const row = (code, amount) => ({ code, amount });
  const groups = { datasets: ['now'], groupBy: ['code'], metrics: [{ field: 'amount', agg: 'sum' }] };
  const f = edgeFixture(columns, { now: [row(0, 30), row('', 7), row('x', 4), row(0, 2), row(5, 1)] }, [
    { title: 'Codes', type: 'table', ...groups, orderBy: { field: 'amount__sum', direction: 'desc' } },
    { title: 'Amount by code', type: 'bar', ...groups },
  ]);
  assert.deepEqual(tableOf(f, 'Edges page', 'Codes').slice(1), [[0, 32], [7], ['x', 4], [5, 1], ['Total', 44]]);
  assert.deepEqual(literals(f, 'Edges page', 3).filter(([, column]) => column !== 2), []);
  assertMoves(f, 'Edges page');
});

// The summary keeps 12, "12", true and "TRUE" apart, and a numeric filter drops text it cannot
// read as a number; Sheets prints 12 as "12" and TRUE as "TRUE", and sorts text after numbers.
test('groups of a column of mixed types count each type apart, and a numeric filter drops text, live', () => {
  const columns = [
    { key: 'code', type: 'text' },
    { key: 'amount', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  const row = (code, amount, clicks) => ({ code, amount, clicks });
  const f = edgeFixture(
    columns,
    { now: [row(12, 1, 10), row('12', 2, 10), row(true, 4, 10), row('TRUE', 8, 10), row('12', 16, 'n/a'), row(12, 32, 1)] },
    [
      {
        title: 'Codes',
        type: 'table',
        datasets: ['now'],
        groupBy: ['code'],
        metrics: [{ field: 'amount', agg: 'sum' }],
        filters: [{ field: 'clicks', op: 'gt', value: 5 }],
        orderBy: { field: 'amount__sum', direction: 'desc' },
      },
    ]
  );
  assert.deepEqual(tableOf(f, 'Edges page', 'Codes').slice(1), [['TRUE', 8], [true, 4], ['12', 2], [12, 1], ['Total', 15]]);
  // The code 12 in the first column is a label; every number after it is a formula.
  assert.deepEqual(literals(f, 'Edges page', 3).filter(([, column]) => column !== 2), []);
  assertMoves(f, 'Edges page');
});

// The summary reads only numbers in a number column, counts a distinct value by the text it prints
// (12 and "12" once, true and "true" once) and finds text in a number or a boolean too, where
// the IFS functions count any filled cell, keep "n/a" for <>5 and find text in text only.
test('a column of mixed types reads as the refresh did: text among numbers, numbers and booleans among text, live', () => {
  const columns = [
    { key: 'name', type: 'text' },
    { key: 'code', type: 'text' },
    { key: 'clicks', type: 'number' },
    { key: 'spend', type: 'currency' },
  ];
  const row = (name, code, clicks, spend) => ({ name, code, clicks, spend });
  const kpi = (title, metric, filters = []) => ({ title, type: 'kpi', datasets: ['now'], metrics: [metric], filters });
  const f = edgeFixture(
    columns,
    { now: [row('a', 'a12', 10, 1), row('b', 123, 'n/a', 2), row('c', 12, 5, 4), row('d', '12', 20, 8), row('e', true, '', 16), row('f', 'true', 7, 32)] },
    [
      kpi('Kept', { field: 'name', agg: 'count' }, [{ field: 'clicks', op: 'ne', value: 5 }]),
      kpi('Average', { field: 'clicks', agg: 'avg' }),
      kpi('Least', { field: 'clicks', agg: 'min' }, [{ field: 'name', op: 'in', value: 'b, e' }]),
      kpi('Codes', { field: 'code', agg: 'count_distinct' }),
      kpi('Twelve', { field: 'spend', agg: 'sum' }, [{ field: 'code', op: 'contains', value: '12' }]),
      kpi('True', { field: 'spend', agg: 'sum' }, [{ field: 'code', op: 'contains', value: 'ru' }]),
    ]
  );
  assert.deepEqual(
    [...cardsOf(f, 'Count of name'), ...cardsOf(f, 'Avg clicks'), ...cardsOf(f, 'Min clicks'), ...cardsOf(f, 'Distinct code')].map((card) => card[0]),
    [4, 10.5, '', 4]
  );
  assert.deepEqual(cardsOf(f, 'Spend (EUR)').map((card) => card[0]), [15, 48]);
  assert.deepEqual(literals(f, 'Edges page', 3), []);
  assertMoves(f, 'Edges page');
});

// Text Sheets would read as an error or as an operator of its own ("#N/A", "<5", "=x") is no
// criterion of the IFS functions: such a name compares as the text it is.
test('names that read as an error or an operator keep their numbers, live', () => {
  const columns = [
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
  ];
  const names = ['#N/A', '<5', '=x', '<>', '>=2', 'Plain'];
  const kpi = (filters) => ({ title: 'Spend', type: 'kpi', datasets: ['now'], metrics: [{ field: 'spend', agg: 'sum' }], filters });
  const f = edgeFixture(columns, { now: names.map((campaign, index) => ({ campaign, spend: 2 ** index })) }, [
    kpi([{ field: 'campaign', op: 'eq', value: '<5' }]),
    kpi([{ field: 'campaign', op: 'ne', value: '#N/A' }]),
    kpi([{ field: 'campaign', op: 'in', value: '=x, <>' }]),
    { title: 'Campaigns', type: 'table', datasets: ['now'], groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], orderBy: { field: 'spend__sum', direction: 'asc' } },
  ]);
  assert.deepEqual(
    tableOf(f, 'Edges page', 'Campaigns').slice(1),
    names.map((name, index) => [name, 2 ** index]).concat([['Total', 63]])
  );
  assert.deepEqual(cardsOf(f, 'Spend (EUR)').slice(0, 3).map((card) => card[0]), [2, 62, 12]);
  assert.deepEqual(literals(f, 'Edges page', 3), []);
  assertMoves(f, 'Edges page');
});

// "in" matches the text a value prints, in any case: a cell is read as text only for an option a
// number or a boolean could print, and a date column compares days as dates, a blank option
// keeping blank dates.
test('"in" filters the IFS functions cannot say read a cell as text only for an option that needs it, live', () => {
  const columns = [
    { key: 'campaign', type: 'text' },
    { key: 'date', type: 'date' },
    { key: 'spend', type: 'currency' },
    { key: 'code', type: 'text' },
  ];
  const row = (campaign, date, spend, code) => ({ campaign, date, spend, code });
  const kpi = (field, value) => ({ title: 'Spend', type: 'kpi', datasets: ['now'], metrics: [{ field: 'spend', agg: 'sum' }], filters: [{ field, op: 'in', value }] });
  const f = edgeFixture(
    columns,
    { now: [row('Summer 2026', '2026-08-01', 1, 12), row('TRUE', '', 2, 'x'), row('Other', '2026-08-02', 4, true), row('summer 2026', '2026-08-03', 8, '12')] },
    [kpi('campaign', 'true, summer 2026'), kpi('date', '2026-08-02, '), kpi('code', '12, true')]
  );
  assert.deepEqual(cardsOf(f, 'Spend (EUR)').map((card) => card[0]), [11, 6, 13]);
  const formulas = assertMoves(f, 'Edges page');
  assert.ok(formulas.some((formula) => formula.includes(`(LOWER('now data'!$A$5:$A$8)="true")+('now data'!$A$5:$A$8="summer 2026")`)), 'a name compares as itself');
  assert.ok(formulas.some((formula) => formula.includes(`('now data'!$B$5:$B$8=46236)+('now data'!$B$5:$B$8="")`)), 'days compare as dates');
});

test('a numeric filter keeps a blank cell when the summary, reading it as 0, keeps it', () => {
  const columns = [
    { key: 'keyword', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'conversions', type: 'number' },
  ];
  const row = (keyword, spend, conversions) => ({ keyword, spend, conversions });
  const table = (title, op, value) => ({
    title,
    type: 'table',
    datasets: ['now'],
    groupBy: ['keyword'],
    metrics: [{ field: 'spend', agg: 'sum' }],
    orderBy: { field: 'spend__sum', direction: 'desc' },
    filters: [{ field: 'conversions', op, value }],
  });
  const f = edgeFixture(columns, { now: [row('blank', 40, ''), row('zero', 30, 0), row('one', 20, 1), row('two', 10, 2)] }, [
    { title: 'Waste', type: 'kpi', datasets: ['now'], metrics: [{ field: 'spend', agg: 'sum' }], filters: [{ field: 'conversions', op: 'eq', value: 0 }] },
    table('No conversions', 'eq', 0),
    table('Under one', 'lt', 1),
    table('At most zero', 'lte', 0),
    table('Some conversions', 'ne', 0),
    table('Not one', 'ne', 1),
  ]);
  assert.deepEqual(cardsOf(f, 'Spend (EUR)')[0], [70, '']);
  for (const title of ['No conversions', 'Under one', 'At most zero'])
    assert.deepEqual(tableOf(f, 'Edges page', title).slice(1), [['blank', 40], ['zero', 30], ['Total', 70]], title);
  assert.deepEqual(tableOf(f, 'Edges page', 'Some conversions').slice(1), [['one', 20], ['two', 10], ['Total', 30]]);
  assert.deepEqual(tableOf(f, 'Edges page', 'Not one').slice(1), [['blank', 40], ['zero', 30], ['two', 10], ['Total', 80]]);
  assert.deepEqual(literals(f, 'Edges page'), []);
  assertMoves(f, 'Edges page');
});

// The summary compares a number as the text it prints and a day as text, where a blank sorts
// first; the IFS functions find no text in a number cell and skip a blank date.
test('a filter that reads numbers as text is live over the text they print, and a date filter keeps blank dates as it does', () => {
  const columns = [
    { key: 'keyword', type: 'text' },
    { key: 'date', type: 'date' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  const row = (keyword, date, spend, clicks) => ({ keyword, date, spend, clicks });
  const kpi = (field, op, value) => ({ title: 'Spend', type: 'kpi', datasets: ['now'], metrics: [{ field: 'spend', agg: 'sum' }], filters: [{ field, op, value }] });
  const f = edgeFixture(
    columns,
    { now: [row('a', '2026-08-01', 10, 15), row('b', '2026-08-02', 5, 2), row('c', '2026-08-05', 2, 51), row('d', '', 3, ''), row('e', '2026-08-04', 1, 1)] },
    [
      kpi('clicks', 'contains', '5'),
      kpi('spend', 'contains', '0'),
      kpi('date', 'lt', '2026-08-03'),
      kpi('date', 'lte', '2026-08-02'),
      kpi('date', 'gte', '2026-08-02'),
      kpi('date', 'ne', '2026-08-01'),
      kpi('clicks', 'in', '1.0, 51'),
    ]
  );
  assert.deepEqual(cardsOf(f, 'Spend (EUR)').map((card) => card[0]), [12, 10, 18, 18, 8, 11, 2]);
  // Every card is live, a blank date counted where the filter keeps it.
  const page = f.tab('Edges page');
  const live = cellsOf(f, page)
    .filter((cell) => cell[2] === 'Spend (EUR)')
    .map(([row, column]) => f.formula(page, row + 1, column) !== '');
  assert.deepEqual(live, [true, true, true, true, true, true, true]);
  assert.ok(assertMoves(f, 'Edges page').some((formula) => /ISNUMBER\(FIND\("5",LOWER\('now data'!\$D\$5:\$D\$9\)\)\)/.test(formula)));
});

test('a tile over more groups than a summary keeps still refreshes, its groups ranked after counting', () => {
  const columns = [
    { key: 'term', type: 'text' },
    { key: 'spend', type: 'currency' },
  ];
  const f = edgeFixture(
    columns,
    { now: Array.from({ length: 60 }, (_, index) => ({ term: 'term ' + index, spend: index + 1 })) },
    [{ title: 'Terms', type: 'table', datasets: ['now'], groupBy: ['term'], metrics: [{ field: 'spend', agg: 'sum' }], orderBy: { field: 'spend__sum', direction: 'desc' }, limit: 3 }],
    (sandbox) => {
      // As small as the summaries a dashboard asks for allow (50 rows).
      sandbox.api.DMV_CHAT_RESULTS.maxSummaryRows = 50;
    }
  );
  assert.deepEqual(tableOf(f, 'Edges page', 'Terms').slice(1, 4), [['term 59', 60], ['term 58', 59], ['term 57', 58]]);
});

// Sheets rewrites the formulas that read a tab when the tab is deleted or renamed, or gets rows
// or columns inserted or deleted: each reference to it becomes #REF!, the new name or the shifted
// range. edit(formula) returns a formula as Sheets would rewrite it.
function rewriteReferences(f, edit) {
  for (const name of ['Edges page', 'Edges page (chart data)']) {
    const sheet = f.tab(name);
    for (const [key, entry] of sheet.cells)
      if (entry.formula) {
        const formula = edit(entry.formula);
        sheet.cells.set(key, { value: formula, formula });
      }
  }
}

test('a page whose data tab was deleted, renamed or shifted refreshes, and an edited formula is still refused', () => {
  const columns = [
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
  ];
  const compare = { datasets: ['now', 'before'], compare: { current: 'now', previous: 'before' } };
  const f = edgeFixture(
    columns,
    {
      now: [{ campaign: 'Brand', spend: 30 }, { campaign: 'Generic', spend: 50 }],
      before: [{ campaign: 'Brand', spend: 20 }, { campaign: 'Generic', spend: 60 }],
    },
    [
      { title: 'Totals', type: 'kpi', ...compare, metrics: [{ field: 'spend', agg: 'sum' }] },
      { title: 'Campaigns', type: 'table', ...compare, groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }], orderBy: { field: 'spend__sum', direction: 'desc' } },
      { title: 'By campaign', type: 'bar', datasets: ['now'], groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }] },
    ]
  );
  const read = () => [cardsOf(f, 'Spend (EUR)'), tableOf(f, 'Edges page', 'Campaigns'), pointsOf(f, 'Edges page', 'By campaign')];
  const before = read();
  // Deleted: the tab is gone and every reference to it reads #REF!.
  const server = f.state.books.get(f.book.getId());
  server.sheets.splice(server.sheets.indexOf(f.tab('now data')), 1);
  rewriteReferences(f, (formula) => formula.replace(/'now data'!\$[A-Z]+\$\d+:\$[A-Z]+\$\d+/g, '#REF!'));
  f.run();
  assert.deepEqual(read(), before, 'the data tab is written again and the page reads it');
  // Renamed: the formulas follow the tab's new name; the refresh writes a new data tab.
  f.tab('now data').name = 'Renamed';
  rewriteReferences(f, (formula) => formula.replace(/'now data'!/g, 'Renamed!'));
  f.run();
  assert.deepEqual(read(), before);
  // Rows inserted above the data: every range moves down a row.
  rewriteReferences(f, (formula) => formula.replace(/(\$[A-Z]+\$)(\d+)/g, (all, column, row) => column + (Number(row) + 1)));
  f.run();
  assert.deepEqual(read(), before);
  // A formula changed beyond its references is an edit.
  rewriteReferences(f, (formula) => (formula.startsWith('=SUMIFS(') ? formula + '*2' : formula));
  assert.throws(() => f.run(), /edited or moved/);
  rewriteReferences(f, (formula) => formula.replace(/\*2$/, ''));
  f.run();
  assert.deepEqual(read(), before);
});

// The previous value of a change, an expression over the previous period's tab, enters its
// formula once, so the many SUMIFS behind it run once per change.
test('a change line and a table change read the previous period once', () => {
  const columns = [
    { key: 'campaign', type: 'text' },
    { key: 'spend', type: 'currency' },
    { key: 'clicks', type: 'number' },
  ];
  const compare = { datasets: ['now', 'before'], compare: { current: 'now', previous: 'before' } };
  const f = edgeFixture(
    columns,
    {
      now: [{ campaign: 'Brand', spend: 30, clicks: 3 }, { campaign: 'Generic', spend: 50, clicks: 4 }],
      before: [{ campaign: 'Brand', spend: 20, clicks: 2 }, { campaign: 'Generic', spend: 60, clicks: 5 }],
    },
    [
      { title: 'Totals', type: 'kpi', ...compare, metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'avg' }] },
      { title: 'Campaigns', type: 'table', ...compare, groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }, { field: 'clicks', agg: 'avg' }], orderBy: { field: 'spend__sum', direction: 'desc' } },
    ]
  );
  const page = f.tab('Edges page');
  const changes = cellsOf(f, page).filter(([, , , formula]) => /before data/.test(formula));
  assert.ok(changes.length >= 6, changes.length + ' changes');
  for (const [, , , formula] of changes) {
    // =LET(previous,<expression>,<the change over it>): the tab appears in the expression only.
    assert.match(formula, /^=LET\(previous,/);
    let depth = 0,
      end = 'LET('.length + 1;
    for (; end < formula.length; end++) {
      if (formula[end] === '(') depth++;
      if (formula[end] === ')') depth--;
      if (formula[end] === ',' && depth === 0 && end > '=LET(previous,'.length) break;
    }
    assert.doesNotMatch(formula.slice(end), /before data/, formula);
  }
  assert.deepEqual(cardsOf(f, 'Spend (EUR)')[0], [80, '▶ 0.0% vs 80.00']);
  assert.deepEqual(tableOf(f, 'Edges page', 'Campaigns').slice(1, 3), [
    ['Generic', 50, -1 / 6, 4, -0.2],
    ['Brand', 30, 0.5, 3, 0.5],
  ]);
});

test('a data tab shows its dates on the left, as text did before they became dates', () => {
  const f = liveFixture();
  const data = f.tab('Ads data');
  assert.equal(f.shown(data, 5, 1), '2026-08-01');
  assert.equal(f.format(data, 5, 1).horizontalAlignment, 'LEFT');
  assert.equal(f.format(data, 7, 1).horizontalAlignment, 'LEFT');
  assert.notEqual(f.format(data, 5, 3).horizontalAlignment, 'LEFT');
});
