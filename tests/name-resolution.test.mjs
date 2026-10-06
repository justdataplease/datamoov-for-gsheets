import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';
import { exemptDashboardPages } from './helpers/dashboard-goldens.mjs';

exemptDashboardPages(
  'These dashboards check how names written loosely resolve to real keys; each test checks its numbers against totals worked out from the rows it wrote.'
);

// Models often write a key from the display name of its column with the key's suffix: "Deal
// Value__sum" for deal_value__sum. A name that matches exactly one real key once case, spaces and
// punctuation are set aside means that key, in every place a tile or summary names one. A name
// that matches several, or none, is refused with the valid keys.

const HEADER = ['Deal ID', 'Deal Date', 'Owner', 'Stage', 'Deal Value'];
const OWNERS = ['Ana', 'Ben', 'Cleo', 'Dev'];
const STAGES = ['Open', 'Won', 'Lost'];
const serial = (day) => (Date.parse(day + 'T00:00:00Z') - Date.UTC(1899, 11, 30)) / 86400000;

function dealRows(count = 24) {
  return Array.from({ length: count }, (_, i) => ({
    id: 'D' + (100 + i),
    date: new Date(Date.UTC(2026, 7, 1 + (i % 28))).toISOString().slice(0, 10),
    owner: OWNERS[(i * 3) % 4],
    stage: STAGES[i % 3],
    value: 100 + ((i * 53) % 400),
  }));
}

function fixture(rows = dealRows()) {
  const f = createDatamoovSandbox();
  const sheet = f.book.insertSheet('Deals');
  sheet.maxRows = Math.max(sheet.maxRows, rows.length + 50);
  HEADER.forEach((header, index) => f.setCell(sheet, 1, index + 1, header));
  rows.forEach((row, index) => {
    const r = index + 2;
    f.setCell(sheet, r, 1, row.id);
    f.setCell(sheet, r, 2, serial(row.date));
    sheet.formats.set(r + ':2', { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } });
    f.setCell(sheet, r, 3, row.owner);
    f.setCell(sheet, r, 4, row.stage);
    f.setCell(sheet, r, 5, row.value);
  });
  f.rows = rows;
  f.save = (input) => plain(f.api.dmvSaveDashboard(input));
  f.run = (id) => plain(f.api.dmvRunDashboard(id));
  f.plan = (id) => plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', id).plan));
  return f;
}

function dashboard(tiles, extra = {}) {
  return {
    name: 'Deals overview',
    target: { sheetName: 'Deals Dashboard' },
    datasets: [{ id: 'deals', label: 'Deals', sourceSheet: 'Deals' }],
    tiles: [{ title: 'Value by stage', type: 'column', groupBy: ['Stage'], metrics: [{ field: 'Deal Value', agg: 'sum' }] }].concat(tiles),
    ...extra,
  };
}

const byOwner = (rows) => {
  const totals = {};
  rows.forEach((row) => (totals[row.owner] = (totals[row.owner] || 0) + row.value));
  return totals;
};

test('dmvChatColumn_ takes a name that matches one key once case, spaces and punctuation are set aside', () => {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'owner', label: 'Owner' },
    { key: 'deal_value__sum', label: 'Deal Value (sum)' },
    { key: 'deal_id__count', label: 'Deal ID (count)' },
  ];
  const key = (name) => f.api.dmvChatColumn_({ columns }, name, 'orderBy column').key;
  assert.equal(key('Deal Value__sum'), 'deal_value__sum');
  assert.equal(key('deal value sum'), 'deal_value__sum');
  assert.equal(key('Deal-ID  count'), 'deal_id__count');
  assert.equal(key('OWNER'), 'owner');
  // Unknown names still fail, listing the real keys.
  assert.throws(() => key('Profit__sum'), /^Error: Unknown orderBy column "Profit__sum"\. Result columns are: owner, deal_value__sum, deal_id__count$/);
  // A loose name that fits two columns is refused, naming both.
  const twin = [{ key: 'deal_value' }, { key: 'deal.value' }, { key: 'owner' }];
  assert.throws(
    () => f.api.dmvChatColumn_({ columns: twin }, 'Deal Value', 'metric'),
    /^Error: Unknown metric "Deal Value", which could be any of deal_value, deal\.value\. Result columns are: deal_value, deal\.value, owner$/
  );
  // Exact names win over loose ones, and a key over another column's label.
  assert.equal(f.api.dmvChatColumn_({ columns: twin }, 'deal.value', 'metric').key, 'deal.value');
  const labelled = [{ key: 'cost', label: 'Spend' }, { key: 'spend', label: 'Amount' }];
  assert.equal(f.api.dmvChatColumn_({ columns: labelled }, 'Spend', 'metric').key, 'spend');
  // Letters beyond ASCII are part of a name: a different word never matches by its suffix alone.
  assert.throws(() => f.api.dmvChatColumn_({ columns: [{ key: 'κόστος_a' }] }, 'έσοδα_a', 'metric'), /Unknown metric "έσοδα_a"/);
  assert.equal(f.api.dmvChatColumn_({ columns: [{ key: 'κόστος_a' }] }, 'Κόστος A', 'metric').key, 'κόστος_a');
});

test('summarize orders and ranks by a key written from its display name', () => {
  const f = createDatamoovSandbox();
  const session = f.api.dmvChatSession_(f.book);
  const rows = dealRows();
  const resultId = f.api.dmvChatStoreResult_(session, {
    columns: [
      { key: 'deal_id', label: 'Deal ID', type: 'text' },
      { key: 'owner', label: 'Owner', type: 'text' },
      { key: 'stage', label: 'Stage', type: 'text' },
      { key: 'deal_value', label: 'Deal Value', type: 'number' },
    ],
    rows: rows.map((row) => ({ deal_id: row.id, owner: row.owner, stage: row.stage, deal_value: row.value })),
    metadata: {},
  });
  const summary = plain(
    f.api.dmvChatSummarize_(session, {
      resultId,
      groupBy: ['Owner'],
      metrics: [{ field: 'Deal Value', agg: 'sum' }],
      orderBy: { field: 'Deal Value__sum', direction: 'asc' },
    })
  );
  const totals = byOwner(rows);
  const ascending = Object.keys(totals).sort((a, b) => totals[a] - totals[b]);
  assert.deepEqual(summary.rows.map((row) => row.owner), ascending);
  // rankWithin names a groupBy column the same loose way.
  const ranked = plain(
    f.api.dmvChatSummarize_(session, {
      resultId,
      groupBy: ['stage', 'owner'],
      metrics: [{ field: 'deal_value', agg: 'sum' }],
      orderBy: { field: 'Deal Value  Sum', direction: 'desc' },
      rankWithin: ['Stage'],
      limitPerGroup: 1,
    })
  );
  assert.equal(ranked.rows.length, 3);
  assert.throws(
    () => f.api.dmvChatSummarize_(session, { resultId, groupBy: ['Owner'], metrics: [{ field: 'Deal Value', agg: 'sum' }], orderBy: { field: 'Profit__sum', direction: 'desc' } }),
    /Unknown orderBy column "Profit__sum"\. Result columns are: owner, deal_value__sum/
  );
  // A formula sums its columns itself: a metric key in it is refused with the column to write.
  assert.throws(
    () => f.api.dmvChatSummarize_(session, { resultId, groupBy: ['owner'], formulas: [{ key: 'half', expression: 'deal_value__sum / 2' }] }),
    /unknown column "deal_value__sum" at position 1; summable columns are deal_value; a formula sums each column itself, so write deal_value/
  );
  assert.throws(
    () => f.api.dmvChatSummarize_(session, { resultId, groupBy: ['owner'], formulas: [{ key: 'each', expression: 'deal_value / deal_id__count' }] }),
    /unknown column "deal_id__count" at position 14; summable columns are deal_value; a formula reads summed columns only: a count, average, minimum or maximum is a metric of its own/
  );
  // A count in a formula is a ratio's denominator: the error names the ratio that divides by it.
  assert.throws(
    () => f.api.dmvChatSummarize_(session, { resultId, groupBy: ['owner'], formulas: [{ key: 'each', expression: 'deal_value / deal_id__count' }] }),
    /a metric of its own; to divide by a count, use a ratio with denominator deal_id__count\.$/
  );
});

test('a tile over a tab resolves highlight, orderBy, secondaryAxis and polarity names written from display names', () => {
  const f = fixture();
  const saved = f.save(
    dashboard(
      [
        {
          title: 'Owners',
          type: 'table',
          groupBy: ['Owner'],
          metrics: [{ field: 'Deal Value', agg: 'sum' }, { field: 'Deal ID', agg: 'count' }],
          orderBy: { field: 'Deal Value__sum', direction: 'desc' },
          highlight: [{ field: 'Deal Value__sum', op: 'gte', ofTotal: 0.25, color: 'green' }],
        },
        {
          title: 'Value and deals by stage',
          type: 'column',
          groupBy: ['Stage'],
          metrics: [{ field: 'Deal Value', agg: 'sum' }, { field: 'Deal ID', agg: 'count' }],
          secondaryAxis: ['deal_id__count'],
        },
      ],
      { lowerIsBetter: ['Deal ID__count'] }
    )
  );
  const plan = f.plan(saved.id);
  // Saved under the names the tile uses, so a refresh reads them as it reads any other.
  assert.equal(plan.tiles[1].highlight[0].field, 'Deal Value');
  assert.equal(plan.tiles[2].secondaryAxis[0], 'Deal ID');
  assert.deepEqual(plan.lowerIsBetter, ['Deal ID']);
  const result = f.run(saved.id);
  assert.equal(result.ok, true);
  assert.ok(result.highlights.length > 0, 'the highlight rule reads its metric');
  // The table is ordered by deal value, highest first.
  const totals = byOwner(f.rows);
  const page = f.tab('Deals Dashboard');
  const shown = [...page.cells.keys()]
    .map((key) => key.split(':').map(Number))
    .filter(([row, column]) => OWNERS.includes(f.shown(page, row, column)))
    .sort((a, b) => a[0] - b[0])
    .map(([row, column]) => f.shown(page, row, column));
  assert.deepEqual(shown, Object.keys(totals).sort((a, b) => totals[b] - totals[a]));
});

test('loose names that fit no key or several keys are refused with the valid ones', () => {
  const f = fixture();
  const table = (patch) => ({
    title: 'Owners',
    type: 'table',
    groupBy: ['Owner'],
    metrics: [{ field: 'Deal Value', agg: 'sum' }],
    ...patch,
  });
  assert.throws(
    () => f.save(dashboard([table({ highlight: [{ field: 'Profit__sum', op: 'gt', value: 1, color: 'red' }] })])),
    /"Owners": highlight field "Profit__sum" is not a metric field, ratio key, formula key or groupBy column of this tile\. Name one of: Deal Value, Owner\./
  );
  assert.throws(
    () =>
      f.save(
        dashboard([
          table({
            formulas: [{ key: 'deal_value_sum', expression: 'deal_value * 1' }],
            highlight: [{ field: 'Deal-Value sum', op: 'gt', value: 1, color: 'red' }],
          }),
        ])
      ),
    /"Owners": highlight field "Deal-Value sum" could be any of Deal Value, deal_value_sum\. Name one of: Deal Value, deal_value_sum, Owner\./
  );
  assert.throws(
    () =>
      f.save(
        dashboard([
          {
            title: 'Value and deals by stage',
            type: 'column',
            groupBy: ['Stage'],
            metrics: [{ field: 'Deal Value', agg: 'sum' }, { field: 'Deal ID', agg: 'count' }],
            secondaryAxis: ['deal_count'],
          },
        ])
      ),
    /secondaryAxis names metric fields, ratio keys or formula keys/
  );
  // A run whose saved orderBy fits no result column still fails, listing them.
  const saved = f.save(dashboard([table({ orderBy: { field: 'Profit__sum', direction: 'desc' } })]));
  assert.throws(() => f.run(saved.id), /Unknown orderBy column "Profit__sum"\. Result columns are: owner, deal_value__sum/);
});

test('a metric key or a bare count in place of a column says how a tile names it', () => {
  const f = fixture();
  const metric = (field, agg = 'sum') => dashboard([{ title: 'Totals', type: 'kpi', metrics: [{ field, agg }] }]);
  assert.throws(
    () => f.save(metric('deal_value__sum')),
    /"Totals": unknown column "deal_value__sum"\. Columns of Deals: Deal ID, Deal Date, Owner, Stage, Deal Value\. "deal_value__sum" is Deal Value with agg sum: a metric names the column and its agg apart, and ratios and formulas sum their columns themselves\./
  );
  // A count named as a column says a ratio may divide by it.
  assert.throws(
    () => f.save(metric('deal_id__count_distinct')),
    /"deal_id__count_distinct" is Deal ID with agg count_distinct: a metric names the column and its agg apart, a formula sums its columns itself, and a ratio may divide by deal_id__count_distinct\./
  );
  assert.throws(
    () => f.save(metric('count', 'count')),
    /"Totals": unknown column "count"\. Columns of Deals: Deal ID, Deal Date, Owner, Stage, Deal Value\. No column is named count: count rows with a metric such as \{field: "Deal ID", agg: "count"\}\./
  );
  // A name the tab does not hold gets no guess.
  assert.throws(() => f.save(metric('win_rate')), /"Totals": unknown column "win_rate"\. Columns of Deals: Deal ID, Deal Date, Owner, Stage, Deal Value$/);
});

test('a mapped tile saves names written loosely under their mapped keys, and refuses one that fits none', () => {
  const f = createDatamoovSandbox();
  const columns = [
    { key: 'date', type: 'date' },
    { key: 'team', type: 'text' },
    { key: 'amount', type: 'currency' },
    { key: 'units', type: 'number' },
  ];
  f.api.dmvRegisterConnector_({
    id: 'mapped_fixture',
    label: 'Mapped fixture',
    category: 'Test',
    allowedHosts: [],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: columns,
        dateRange: true,
        configFields: [],
        fetch: () => ({
          columns,
          rows: Array.from({ length: 12 }, (_, i) => ({ date: '2026-08-' + String(10 + i), team: 'T' + (i % 3), amount: 5 + i, units: 1 + (i % 4) })),
          metadata: { complete: true, currency: 'EUR' },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'mapped_fixture', label: 'Book', credentials: { account: 'one' } });
  const input = {
    name: 'Teams',
    target: { sheetName: 'Teams Dashboard' },
    datasets: [
      {
        id: 'daily',
        label: 'Daily',
        sheetName: 'Daily data',
        connectionId: connection.id,
        reportType: 'daily',
        fields: columns.map((column) => column.key),
        dateRange: { preset: 'last30' },
        mapping: columns.map((column) => ({ field: column.key, key: column.key })),
      },
    ],
    tiles: [
      { title: 'Amount by team', type: 'bar', groupBy: ['team'], metrics: [{ field: 'amount', agg: 'sum' }] },
      {
        title: 'Teams',
        type: 'table',
        groupBy: ['Team'],
        metrics: [{ field: 'Amount', agg: 'sum' }, { field: 'units', agg: 'sum' }],
        orderBy: { field: 'Amount__sum', direction: 'desc' },
        highlight: [{ field: 'Amount__sum', op: 'gt', value: 5, color: 'green' }],
      },
    ],
  };
  const saved = plain(f.api.dmvSaveDashboard(input));
  const tile = plain(f.api.dmvUnpack_(f.api.dmvRead_('dashboard', saved.id).plan)).tiles[1];
  assert.deepEqual(tile.groupBy, ['team']);
  assert.deepEqual(tile.metrics, [{ field: 'amount', agg: 'sum' }, { field: 'units', agg: 'sum' }]);
  assert.equal(tile.highlight[0].field, 'amount');
  assert.equal(plain(f.api.dmvRunDashboard(saved.id)).ok, true);
  input.tiles[1] = { title: 'Teams', type: 'table', groupBy: ['team'], metrics: [{ field: 'Amount Total', agg: 'sum' }] };
  assert.throws(() => f.api.dmvSaveDashboard(input), /"Teams": unknown column "Amount Total"\. Mapped columns: date, team, amount, units, source, currency$/);
  input.tiles[1].metrics = [{ field: 'Amount__sum', agg: 'sum' }];
  assert.throws(() => f.api.dmvSaveDashboard(input), /Mapped columns: date, team, amount, units, source, currency\. "Amount__sum" is amount with agg sum: a metric names the column and its agg apart/);
  // Two spellings of one mapped column are one column: refused at save, not at every refresh.
  input.tiles[1] = { title: 'Teams', type: 'table', groupBy: ['team'], metrics: [{ field: 'Amount', agg: 'sum' }, { field: 'amount', agg: 'sum' }] };
  assert.throws(() => f.api.dmvSaveDashboard(input), /"Teams": choose distinct metrics with a supported agg\./);
  input.tiles[1] = { title: 'Teams', type: 'table', groupBy: ['team', 'Team'], metrics: [{ field: 'amount', agg: 'sum' }] };
  assert.throws(() => f.api.dmvSaveDashboard(input), /^Error: Choose distinct groupBy columns\.$/);
});
