import test from 'node:test';
import assert from 'node:assert/strict';
import { exemptDashboardPages } from './helpers/dashboard-goldens.mjs';
import { formatNumber } from './helpers/sheet-formulas.mjs';
import { CHANNELS, scaleFixture } from './helpers/scale-fixture.mjs';

exemptDashboardPages(
  'Source without formulas refused tabs over 30,000 rows, so no golden can show these pages; the test checks every number against totals it works out from the generated rows.'
);

const DATA_TABS = ['August data', 'July data'];

const close = (actual, expected, label) =>
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} is not ${expected}`
  );

// Sums of the generated rows, worked out here without the app, by any key of a row.
function totals(rows, keyOf) {
  const out = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = out.get(key) || { cost: 0, clicks: 0, conversions: 0, value: 0 };
    for (const field of ['cost', 'clicks', 'conversions', 'value']) entry[field] += row[field];
    out.set(key, entry);
  }
  return out;
}
const day = (text) => Date.parse(text + 'T00:00:00Z') / 86400000;
// Weeks start on Monday; 5 January 1970 was one.
const monday = (row) => new Date((day(row.date) - ((day(row.date) - 4) % 7)) * 86400000).toISOString().slice(0, 10);
const change = (now, before) => (now - before) / Math.abs(before);
const byCost = (groups) => [...groups].sort((a, b) => b[1].cost - a[1].cost);

// The first cell of a tab that shows text, as [row, column].
function where(f, sheet, text) {
  for (const key of sheet.cells.keys()) {
    const [row, column] = key.split(':').map(Number);
    if (f.shown(sheet, row, column) === text) return [row, column];
  }
  throw new Error('Nothing shows ' + text);
}

// A chart's table on the chart data tab: its header, then [label, ...values] per point.
function chartOf(f, title) {
  const sheet = f.tab('Scale page (chart data)');
  let row = [...sheet.cells.keys()]
    .map((key) => key.split(':').map(Number))
    .filter(([r, c]) => c === 1 && String(f.shown(sheet, r, c)).startsWith(title))
    .map(([r]) => r)
    .sort((a, b) => a - b)[0];
  const lines = [];
  for (row++; f.shown(sheet, row, 1) !== ''; row++) {
    const line = [];
    for (let column = 1; f.shown(sheet, row, column) !== ''; column++) line.push(f.shown(sheet, row, column));
    lines.push(line);
  }
  return { header: lines[0], points: lines.slice(1) };
}

test('a dashboard over 100,000 rows a period shows every number live, reads no data tab back and stays within Sheets limits', () => {
  const started = Date.now();
  const f = scaleFixture({ current: 100000, previous: 95000 });
  const now = f.rows.current,
    before = f.rows.previous;
  let result;
  for (const refresh of [1, 2]) {
    result = f.run();
    assert.equal(result.ok, true, 'refresh ' + refresh);
    assert.deepEqual(
      result.datasets.map((dataset) => [dataset.sheetName, dataset.rowCount]),
      [['August data', 100000], ['July data', 95000]]
    );
  }
  // The data tabs hold every row under their provenance rows and header, dates as dates.
  const august = f.tab('August data'),
    july = f.tab('July data');
  assert.deepEqual(
    [f.shown(august, 5, 1), f.shown(august, 5, 2), f.shown(august, 100004, 2), f.shown(august, 100005, 2)],
    ['2026-08-01', now[0].campaign, now[99999].campaign, '']
  );
  assert.deepEqual([f.shown(july, 95004, 4), f.shown(july, 95005, 4)], [before[94999].cost, '']);
  assert.equal([...august.cells.keys()].filter((key) => key.endsWith(':2')).length, 100001, 'every row and its header');
  // Neither refresh read a data tab back, and every Sheets request stayed within the size limit.
  assert.deepEqual(f.state.reads.filter((read) => DATA_TABS.includes(read.sheet)), []);
  assert.ok(f.state.batches.length > 2, 'the rows take several writes');
  for (const batch of f.state.batches) assert.ok(Buffer.byteLength(JSON.stringify(batch.body)) <= f.api.DMV_LIMITS.maxBytes);

  const page = f.tab('Scale page');
  const all = { now: totals(now, () => 'all').get('all'), before: totals(before, () => 'all').get('all') };
  const campaigns = { now: totals(now, (row) => row.campaign), before: totals(before, (row) => row.campaign) };
  // Every number against the rows, with shift added to the cost of the first August row.
  const check = (shift = 0) =>
    f.reading(() => {
      const first = now[0];
      // Scorecards and their change lines.
      for (const [label, value, previous] of [
        ['Cost (EUR)', all.now.cost + shift, all.before.cost],
        ['Clicks', all.now.clicks, all.before.clicks],
        ['Conversions', all.now.conversions, all.before.conversions],
        ['ROAS', all.now.value / (all.now.cost + shift), all.before.value / all.before.cost],
      ]) {
        const [row, column] = where(f, page, label);
        close(f.shown(page, row + 1, column), value, label);
        const delta = change(value, previous);
        assert.equal(
          f.shown(page, row + 2, column),
          (delta > 0 ? '▲ ' : '▼ ') +
            formatNumber(Math.abs(delta), '0.0%').text +
            ' vs ' +
            formatNumber(previous, previous >= 1000 ? '#,##0' : '#,##0.00').text,
          label
        );
      }
      // The ranked table: the top 20 campaigns by cost with their changes and CPA, then the total.
      const [header, name] = where(f, page, 'Campaign');
      const columnOf = (text, after = 0) => {
        for (let c = after + 1; c <= page.maxColumns; c++) if (f.shown(page, header, c) === text) return c;
        throw new Error('No column ' + text);
      };
      const cost = columnOf('Cost (EUR)'),
        conversions = columnOf('Conversions'),
        cpa = columnOf('CPA (EUR)');
      byCost(campaigns.now)
        .slice(0, 20)
        .forEach(([campaign, values], index) => {
          const row = header + 1 + index,
            previous = campaigns.before.get(campaign),
            spent = values.cost + (campaign === first.campaign ? shift : 0);
          assert.equal(f.shown(page, row, name), campaign);
          close(f.shown(page, row, cost), spent, campaign + ' cost');
          close(f.shown(page, row, columnOf('Δ %', cost)), change(spent, previous.cost), campaign + ' cost change');
          close(f.shown(page, row, conversions), values.conversions, campaign + ' conversions');
          close(f.shown(page, row, cpa), spent / values.conversions, campaign + ' CPA');
          close(
            f.shown(page, row, columnOf('Δ %', cpa)),
            change(spent / values.conversions, previous.cost / previous.conversions),
            campaign + ' CPA change'
          );
        });
      assert.equal(f.shown(page, header + 21, name), 'Total (all 240)');
      close(f.shown(page, header + 21, cost), all.now.cost + shift, 'total cost');
      close(f.shown(page, header + 21, cpa), (all.now.cost + shift) / all.now.conversions, 'total CPA');
      // Charts: by channel, by week, by week and channel, and by week against July.
      const channels = totals(now, (row) => row.channel);
      const byChannel = chartOf(f, 'Cost by channel');
      assert.deepEqual(byChannel.points.map((point) => point[0]).sort(), CHANNELS.slice().sort());
      for (const [channel, value] of byChannel.points)
        close(value, channels.get(channel).cost + (channel === first.channel ? shift : 0), channel);
      const weeks = [...totals(now, monday)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const weekly = chartOf(f, 'Weekly cost');
      assert.equal(weekly.points.length, weeks.length);
      weeks.forEach(([week, values], index) => {
        close(weekly.points[index][1], values.cost + (index === 0 ? shift : 0), week);
        close(weekly.points[index][2], values.conversions, week);
      });
      const split = totals(now, (row) => monday(row) + ' ' + row.channel);
      const byWeek = chartOf(f, 'Weekly cost by channel');
      assert.deepEqual(byWeek.header.slice(1).sort(), CHANNELS.slice().sort());
      weeks.forEach(([week], index) =>
        byWeek.header.slice(1).forEach((channel, at) =>
          close(
            byWeek.points[index][at + 1],
            split.get(week + ' ' + channel).cost + (index === 0 && channel === first.channel ? shift : 0),
            week + ' ' + channel
          )
        )
      );
      // Compared weeks count from the first day of each period.
      const offset = (rows, start) => totals(rows, (row) => Math.floor((day(row.date) - day(start)) / 7));
      const ours = offset(now, '2026-08-01'),
        theirs = offset(before, '2026-07-01');
      const compared = chartOf(f, 'Weekly cost vs July');
      assert.equal(compared.points.length, 5);
      compared.points.forEach((point, index) => {
        close(point[1], ours.get(index).cost + (index === 0 ? shift : 0), 'week ' + index);
        close(point[2], theirs.get(index).cost, 'previous week ' + index);
      });
    });
  check();

  // Highlights are sentences of the refresh, and their numbers agree with the formulas then.
  const [label, value, previous, type] = [
    ['Cost (EUR)', all.now.cost, all.before.cost, 'currency'],
    ['Clicks', all.now.clicks, all.before.clicks, 'number'],
    ['Conversions', all.now.conversions, all.before.conversions, 'number'],
  ].sort((a, b) => Math.abs(change(b[1], b[2])) - Math.abs(change(a[1], a[2])))[0];
  const number = f.api.dmvDashboardNumber_,
    percent = f.api.dmvDashboardPercent_;
  assert.equal(
    result.highlights[0],
    `${label} ${value > previous ? 'rose' : 'fell'} ${percent(change(value, previous))} to ${number(value, type)} (previous ${number(previous, type)}).`
  );
  const overall = all.now.cost / all.now.conversions;
  const flagged = byCost(campaigns.now).filter(([, values]) => values.cost / values.conversions > 1.02 * overall);
  const shown = flagged.filter(([campaign]) => byCost(campaigns.now).slice(0, 20).some(([other]) => other === campaign));
  assert.ok(
    result.highlights[1].startsWith(
      `Top campaigns: ${shown.length} of 20 rows (${flagged.length} of 240 in all) have CPA above 1.02× the overall EUR ${number(overall, 'currency')} (red rows)`
    ),
    result.highlights[1]
  );
  const [leader, lead] = byCost(campaigns.now)[0];
  assert.equal(
    result.highlights[2],
    `${leader} leads Top campaigns with EUR ${number(lead.cost, 'currency')} cost (${percent(lead.cost / all.now.cost)} of the total).`
  );

  // Live: a changed cost on the August tab moves its card, its campaign's row, the total and
  // every chart point it falls in, and back.
  f.setCell(august, 5, 4, now[0].cost + 1000);
  check(1000);
  f.setCell(august, 5, 4, now[0].cost);
  check();
  assert.ok(Date.now() - started < 60000, 'the test takes seconds, not minutes: ' + (Date.now() - started) + ' ms');
});
