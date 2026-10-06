// Self-test of the Google Ads measures (no AI request; the fake serves the connector). Scripted
// turns go through the real chat runtime and the real connector:
//   G: a saved dashboard over the fake (save_dashboard + run_dashboard), a waste analysis that
//      names every zero-conversion campaign with its true spend, one that names half of them and
//      states a wrong total, an edit adding a weekly chart, an edit moving to the last 90 days,
//      and an edit that only talks.
//   R: two reports saved through chat, then a dashboard built by hand over their tabs: a total
//      over a fixed range, a total over an open-ended range, a typed total and a chart over a
//      fixed range; a note typed into a report tab. The refresh brings more rows: the fixed range,
//      the chart and the typed total go stale, the open-ended total stays fresh.
//   S: a saved report, then a saved dashboard over its tab. The refresh re-runs both: the page's
//      ranges reach the new last row and its totals (one of them moved down) show the new totals.
import { createBenchRuntime } from './runtime.mjs';
import { runConversation } from './conversation.mjs';
import { call, say, editToken, savedId, scripted, differences } from './self-test-script.mjs';
import { tabStats, a1 } from './cells.mjs';
import { runQuery } from './google-ads-fake.mjs';
import { statedNumbers, checkNumbers, adsFacts } from './accuracy.mjs';

const money = (x) =>
  '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAP = [
  ['segments.date', 'date'],
  ['campaign.name', 'campaign_name'],
  ['metrics.cost_micros', 'spend'],
  ['metrics.clicks', 'clicks'],
  ['metrics.impressions', 'impressions'],
  ['metrics.conversions', 'conversions'],
].map(([field, key]) => ({ field, key }));
const dataset = (connectionId, id, sheetName, preset) => ({
  id,
  label: `Google Ads ${id}`,
  sheetName,
  connectionId,
  reportType: 'campaign_daily',
  fields: MAP.map((m) => m.field),
  dateRange: { preset },
  mapping: MAP,
});
const sum = (...names) => names.map((field) => ({ field, agg: 'sum' }));
const plan = (connectionId, { preset = 'last30', weekly = false, id, revision } = {}) => ({
  ...(id ? { id, revision } : {}),
  name: 'Google Ads Performance',
  target: { sheetName: 'Google Ads Dashboard' },
  datasets: [
    dataset(connectionId, 'cur', 'Google Ads Data', preset),
    dataset(
      connectionId,
      'prev',
      'Google Ads Previous Data',
      preset === 'last30' ? 'previous30' : 'previous90'
    ),
  ],
  tiles: [
    {
      title: 'Headline',
      type: 'kpi',
      metrics: sum('spend', 'conversions'),
      compare: { current: ['cur'], previous: ['prev'] },
    },
    {
      title: 'Daily spend',
      type: 'line',
      datasets: ['cur'],
      groupBy: ['date'],
      metrics: sum('spend'),
    },
    ...(weekly
      ? [
          {
            title: 'Weekly spend trend',
            type: 'column',
            datasets: ['cur'],
            groupBy: ['date'],
            dateBucket: 'week',
            metrics: sum('spend'),
          },
        ]
      : []),
    {
      title: 'Campaigns',
      type: 'table',
      datasets: ['cur'],
      groupBy: ['campaign_name'],
      metrics: sum('spend', 'conversions'),
      orderBy: { field: 'spend__sum', direction: 'desc' },
      limit: 30,
    },
  ],
});

export function runAdsSelfTest({ log = console.log } = {}) {
  let checks = 0,
    failures = 0;
  const check = (ok, text, detail = []) => {
    checks++;
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
    if (!ok) for (const line of detail) log('       ' + line);
  };

  // Number reading, on its own.
  {
    const got = statedNumbers(
      'Spend was $55.4k (up 12.5%), 1,127 conversions, ROAS 2.85x, top 10 campaigns in 2026.'
    ).map((n) => `${n.kind}:${n.value}`);
    check(
      JSON.stringify(got) ===
        JSON.stringify(['money:55400', 'percent:12.5', 'count:1127', 'multiple:2.85']),
      `stated numbers: money with a k suffix, a percent, a multiple and a count; not a rank or a year (${got.join(', ')})`
    );
    const r = checkNumbers('Spend $55.4k and $70,000.', {
      money: [55406.53],
      percent: [],
      count: [],
      multiple: [],
    });
    check(
      r.numbers_checked === 2 && r.numbers_matched === 1,
      `"$55.4k" matches 55,406.53 within its rounding; $70,000 does not (${JSON.stringify(r)})`
    );
    // A stated range is checked as bounds of a column: values drawn between them fit, a column
    // reaching far below the lower bound does not.
    const facts = (ranges) => ({ money: [], percent: [], count: [], multiple: [], ranges });
    const inside = checkNumbers('Costs range from $250.00 to $4,500.00.', facts([[258.4, 4490.1]]));
    const outside = checkNumbers('Costs range from $250.00 to $4,500.00.', facts([[12, 4490.1]]));
    check(
      inside.numbers_matched === 2 && outside.numbers_matched === 0,
      `range bounds fit a column's min and max (${inside.numbers_matched}/2), not a column well outside them (${outside.numbers_matched}/2)`
    );
  }

  // ---------- G: saved dashboard, analysis, edits ----------
  let rt;
  const truth = () => rt.ads.truth();
  const last30 = () => truth().periods.last30;
  let dashboardId;
  const stepsG = [
    // Turn 1: dashboard
    () => call('save_dashboard', plan(rt.connectionIds[0])),
    (b) => {
      dashboardId = savedId(b);
      return call('run_dashboard', { id: dashboardId });
    },
    () =>
      say(
        `Spend in the last 30 days was ${money(last30().total.spend)} with ${last30().total.conversions.toLocaleString('en-US')} conversions.`
      ),
    // Turn 2: analysis naming every zero-conversion campaign with its true spend
    () => {
      const p = last30();
      const lines = p.campaigns
        .filter((c) => p.zeroConversion.includes(c.name))
        .map((c) => `- ${c.name}: ${money(c.spend)} and no conversions`);
      return say(
        `These campaigns spent without converting in the last 30 days:\n${lines.join('\n')}`
      );
    },
    // Turn 3: analysis naming half of them, with a wrong amount
    () => {
      const p = last30();
      const half = p.zeroConversion.slice(0, Math.ceil(p.zeroConversion.length / 2));
      return say(`${half.join(' and ')} waste money; together they cost ${money(12345.67)}.`);
    },
    // Turn 4: edit, a weekly chart added to the saved dashboard
    () =>
      call(
        'save_dashboard',
        plan(rt.connectionIds[0], { weekly: true, id: dashboardId, revision: 1 })
      ),
    () => call('run_dashboard', { id: dashboardId }),
    () => say('I added a weekly spend trend chart.'),
    // Turn 5: edit, the last 90 days
    () =>
      call(
        'save_dashboard',
        plan(rt.connectionIds[0], { weekly: true, preset: 'last90', id: dashboardId, revision: 2 })
      ),
    () => call('run_dashboard', { id: dashboardId }),
    () => say('The dashboard now covers the last 90 days.'),
    // Turn 6: an edit that only talks
    () => say('Sure, a weekly chart would be useful.'),
  ];
  rt = createBenchRuntime({
    provider: scripted(stepsG),
    apiKey: 'self-test-key',
    timeLimit: 120,
    googleAds: { variant: 'normal' },
  });
  const recordsG = runConversation(rt, {
    id: 'selftest-G',
    family: 'ads',
    nouns: ['rows'],
    turns: [
      { n: 1, kind: 'dashboard', text: 'google ads dashboard, last 30 days vs before' },
      { n: 2, kind: 'analysis', text: 'which campaigns waste money?' },
      { n: 3, kind: 'analysis', text: 'which campaigns waste money?' },
      { n: 4, kind: 'edit', edit: 'weekly_chart', text: 'add a weekly spend chart' },
      { n: 5, kind: 'edit', edit: 'range_90', text: 'last 90 days please' },
      { n: 6, kind: 'edit', edit: 'weekly_chart', text: 'add a weekly spend chart' },
    ],
  });
  const zero = last30().zeroConversion;
  const expectG = [
    {
      stop: 'answer',
      completed: true,
      saved_dashboard: true,
      dashboard_tab: true,
      charts: 1,
      failed_steps: 0,
      error_cells: 0,
      derived_tabs: ['Google Ads Dashboard', 'Google Ads Dashboard (chart data)'],
      source_tabs: ['Google Ads Data', 'Google Ads Previous Data'],
      // Fetched rows hold no formula: the dataset tabs' share is 0 and stays out of the page's.
      source_formula_share: 0,
      numbers_checked: 2,
      numbers_matched: 2,
      answer_accurate: true,
      claims_mismatch: false,
    },
    {
      stop: 'answer',
      completed: true,
      waste_recall: 1,
      waste_window: 'last30',
      numbers_checked: zero.length,
      numbers_matched: zero.length,
      answer_accurate: true,
    },
    {
      stop: 'answer',
      completed: true,
      waste_recall: Math.ceil(zero.length / 2) / zero.length,
      numbers_checked: 1,
      numbers_matched: 0,
      answer_accurate: false,
    },
    // The rebuilt dashboard keeps its daily chart and adds one: one new chart this turn.
    {
      stop: 'answer',
      completed: true,
      edit_kind: 'weekly_chart',
      edit_applied: true,
      failed_steps: 0,
      charts: 1,
    },
    { stop: 'answer', completed: true, edit_kind: 'range_90', edit_applied: true, failed_steps: 0 },
    { stop: 'answer', completed: false, edit_kind: 'weekly_chart', edit_applied: false },
  ];
  recordsG.forEach((record, i) => {
    const bad = differences(record, expectG[i]);
    check(
      !bad.length,
      `ads G turn ${record.turn} (${record.kind}) stop=${record.stop} done=${record.completed} share=${record.formula_share} src=${record.source_formula_share} charts=${record.charts} numbers=${record.numbers_matched}/${record.numbers_checked} accurate=${record.answer_accurate}${record.waste_recall !== undefined ? ' waste=' + record.waste_recall : ''}${record.edit_kind ? ' edit=' + record.edit_applied : ''}`,
      bad.concat(record.failed_step_sample, record.answer_mismatches || [], record.tabs)
    );
  });
  // The page computes with live formulas: its share is high, and its spend scorecard is the
  // fake's true total.
  {
    const r = recordsG[0];
    check(
      r.formula_share >= 0.9 && r.formula_cells > 0,
      `saved dashboard page is live formulas (share ${r.formula_share}, ${r.formula_cells} formulas, ${r.value_cells} typed numbers)`
    );
    const page = rt.f.book.sheets.find((s) => s.name === 'Google Ads Dashboard');
    const spend = last30().total.spend;
    let found = null;
    for (const [key, entry] of page.cells)
      if (
        /^=SUM\(/i.test(entry.formula || '') &&
        typeof entry.value === 'number' &&
        Math.abs(entry.value - spend) < 0.01
      )
        found = key;
    // After turn 5 the page shows 90 days: compare with the last-90 total instead.
    const spend90 = truth().periods.last90.total.spend;
    for (const [key, entry] of page.cells)
      if (
        /^=SUM\(/i.test(entry.formula || '') &&
        typeof entry.value === 'number' &&
        Math.abs(entry.value - spend90) < 0.01
      )
        found = found || key;
    check(
      Boolean(found),
      `the page's spend scorecard equals the fake's ground truth (${found ? a1(...found.split(':').map(Number)) : 'not found'}; last 90 days ${money(spend90)})`
    );
    // A campaign's sentence is checked against that campaign: another campaign's true spend
    // does not support it.
    const t = truth();
    const [a, b] = t.periods.last30.campaigns;
    const facts = adsFacts(t, rt.ads.data);
    const own = checkNumbers(`${a.name} spent ${money(a.spend)} in the last 30 days.`, facts);
    const other = checkNumbers(`${a.name} spent ${money(b.spend)} in the last 30 days.`, facts);
    check(
      own.numbers_matched === 1 && other.numbers_matched === 0,
      `numbers are scoped to the campaign a sentence names (own spend ${own.numbers_matched}/1, another campaign's ${other.numbers_matched}/1)`
    );
    check(
      rt.ads.stats.errors === 0 && rt.ads.stats.requests > 0,
      `the connector's queries all ran on the fake (${rt.ads.stats.requests} requests, ${rt.ads.stats.errors} rejected)`
    );
  }

  // ---------- R: saved reports, a hand-built dashboard over their tabs, refresh ----------
  let rr;
  const fields = [
    'segments.date',
    'campaign.name',
    'metrics.cost_micros',
    'metrics.clicks',
    'metrics.conversions',
  ];
  const report = (name, reportType, sheetName, extra = {}) => ({
    name,
    connectionId: rr.connectionIds[0],
    reportType,
    dateRange: { preset: 'last30' },
    target: { sheetName },
    ...extra,
  });
  // Where the daily report's table lies, read from the book when the dashboard is built.
  const table = () => {
    const sheet = rr.f.book.sheets.find((s) => s.name === 'Campaign Daily');
    const stats = tabStats(rr, sheet);
    let spendColumn = 0;
    for (let c = 1; c <= stats.lastColumn; c++)
      if (/spend|cost/i.test(String(sheet.cells.get(`${stats.headerRow}:${c}`)?.value || '')))
        spendColumn = c;
    const col = a1(1, spendColumn).replace(/\d+$/, '');
    let total = 0;
    for (let r = stats.headerRow + 1; r <= stats.lastRow; r++)
      total += Number(sheet.cells.get(`${r}:${spendColumn}`)?.value) || 0;
    return { first: stats.headerRow + 1, last: stats.lastRow, col, total, header: stats.headerRow };
  };
  const stepsR = [
    // Turn 1, 2: two reports
    () =>
      call(
        'save_report',
        report('Daily campaigns', 'campaign_daily', 'Campaign Daily', { fields })
      ),
    () => say('Saved the daily campaign report in the Campaign Daily tab.'),
    () =>
      call(
        'save_report',
        report('Search terms', 'search_term', 'Search Terms', {
          fields: [
            'campaign.name',
            'search_term_view.search_term',
            'metrics.cost_micros',
            'metrics.clicks',
            'metrics.conversions',
          ],
        })
      ),
    () => say('Saved the search terms report.'),
    // Turn 3: a dashboard by hand over the tabs
    () => call('edit_sheet', { action: 'create_sheet', newName: 'Dashboard', count: 50 }),
    () => call('inspect_sheet', { sheetName: 'Dashboard', range: 'A1:B3' }),
    (b) => {
      const t = table();
      return call('edit_sheet', {
        action: 'set_formulas',
        sheetName: 'Dashboard',
        range: 'A1:B3',
        editToken: editToken(b),
        formulas: [
          ['Spend (fixed range)', `=SUM('Campaign Daily'!${t.col}${t.first}:${t.col}${t.last})`],
          ['Spend (open range)', `=SUM('Campaign Daily'!${t.col}${t.first}:${t.col})`],
          ['Spend (typed)', String(Math.round(t.total * 100) / 100)],
        ],
      });
    },
    () => {
      const t = table();
      return call('create_chart', {
        sheetName: 'Campaign Daily',
        range: `A${t.header}:${t.col}${t.last}`,
        chartType: 'line',
        title: 'Daily spend',
        xColumn: 'Date',
        seriesColumns: ['Spend'],
      });
    },
    () => call('inspect_sheet', { sheetName: 'Campaign Daily', range: 'L1' }),
    (b) =>
      call('edit_sheet', {
        action: 'set_values',
        sheetName: 'Campaign Daily',
        range: 'L1',
        editToken: editToken(b),
        values: [['checked']],
      }),
    () => say(`Total spend over the report is ${money(table().total)}.`),
  ];
  rr = createBenchRuntime({
    provider: scripted(stepsR),
    apiKey: 'self-test-key',
    timeLimit: 120,
    googleAds: { variant: 'normal' },
  });
  const before = rr.ads.data;
  const range = `'${before.dates[before.dates.length - 30]}' AND '${before.dates[before.dates.length - 1]}'`;
  const dailyRows = runQuery(
    before,
    `SELECT segments.date, campaign.id FROM campaign WHERE segments.date BETWEEN ${range}`
  ).rows.length;
  const termRows = runQuery(
    before,
    `SELECT search_term_view.search_term, metrics.cost_micros FROM search_term_view WHERE metrics.impressions > 0 AND segments.date BETWEEN ${range}`
  ).rows.length;
  const recordsR = runConversation(rr, {
    id: 'selftest-R',
    family: 'reports',
    nouns: ['rows'],
    refresh: { growth: 1.2 },
    turns: [
      { n: 1, kind: 'save_report', text: 'save a daily campaign report' },
      { n: 2, kind: 'save_report', text: 'save a search terms report' },
      { n: 3, kind: 'dashboard', text: 'dashboard from the report tabs' },
    ],
  });
  const grown = rr.ads.data;
  const range2 = `'${grown.dates[grown.dates.length - 30]}' AND '${grown.dates[grown.dates.length - 1]}'`;
  const dailyAfter = runQuery(
    grown,
    `SELECT segments.date, campaign.id FROM campaign WHERE segments.date BETWEEN ${range2}`
  ).rows.length;
  const termsAfter = runQuery(
    grown,
    `SELECT search_term_view.search_term, metrics.cost_micros FROM search_term_view WHERE metrics.impressions > 0 AND segments.date BETWEEN ${range2}`
  ).rows.length;
  const expectR = [
    {
      stop: 'answer',
      completed: true,
      reports_saved: 1,
      report_rows: [`Campaign Daily:${dailyRows}`],
      failed_steps: 0,
      report_tabs_edited: [],
    },
    {
      stop: 'answer',
      completed: true,
      reports_saved: 2,
      report_rows: [`Search Terms:${termRows}`],
      failed_steps: 0,
      report_tabs_edited: [],
    },
    {
      stop: 'answer',
      completed: true,
      failed_steps: 0,
      path: 'hand_built',
      reads_report_tabs: true,
      report_tabs_edited: ['Campaign Daily'],
      charts: 1,
      // Two formulas over the report and one typed number.
      formula_cells: 2,
      value_cells: 1,
      formula_share: 0.6667,
      answer_accurate: true,
      refresh_errors: [],
      report_rows_after: [
        `Campaign Daily:${dailyAfter}`,
        `Search Terms:${Math.min(termsAfter, 10000)}`,
      ],
      // The fixed-range total, the open-ended total and the chart (one object, two ranges).
      // The typed total cannot follow a refresh either.
      frozen_numbers: 1,
      ranges_checked: 3,
      ranges_partial: 0,
      stale_ranges: 2,
      kpis_checked: 3,
      stale_kpis: 2,
      stale_after_refresh: true,
    },
  ];
  recordsR.forEach((record, i) => {
    const bad = differences(record, expectR[i]);
    check(
      !bad.length,
      `reports R turn ${record.turn} (${record.kind}) stop=${record.stop} done=${record.completed} reports=${record.reports_saved ?? '-'} rows=${(record.report_rows || []).join(' ')}${record.path ? ` path=${record.path} edited=[${record.report_tabs_edited}] stale=${record.stale_after_refresh} ranges ${record.stale_ranges}/${record.ranges_checked} totals ${record.stale_kpis}/${record.kpis_checked}` : ''}`,
      bad.concat(
        record.failed_step_sample,
        record.stale_sample || [],
        record.refresh_errors || [],
        record.tabs
      )
    );
  });
  check(
    dailyAfter > dailyRows && termsAfter > termRows,
    `the refresh brings more rows (daily ${dailyRows} -> ${dailyAfter}, terms ${termRows} -> ${termsAfter})`
  );
  {
    const sheet = rr.f.book.sheets.find((s) => s.name === 'Dashboard');
    const open = sheet.cells.get('2:2')?.value;
    const t = table();
    check(
      Math.abs(open - t.total) < 0.01,
      `the open-ended total follows the refresh (${open} vs the refreshed column total ${Math.round(t.total * 100) / 100})`
    );
  }

  // ---------- S: saved reports, a saved dashboard over their tabs, refresh ----------
  // The refresh rewrites the page: every range is sized again and a table tile gains the rows of
  // the new campaigns, so its total row moves down. Measured as it stands after the refresh.
  let rs;
  const header = (name) => {
    const sheet = rs.f.book.sheets.find((s) => s.name === name);
    const stats = tabStats(rs, sheet);
    return Array.from(
      { length: stats.lastColumn },
      (_, i) => sheet.cells.get(`${stats.headerRow}:${i + 1}`)?.value
    );
  };
  const keyOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '__sum';
  const stepsS = [
    () =>
      call('save_report', {
        name: 'Daily campaigns',
        connectionId: rs.connectionIds[0],
        reportType: 'campaign_daily',
        dateRange: { preset: 'last30' },
        target: { sheetName: 'Campaign Daily' },
        fields: [
          'segments.date',
          'campaign.name',
          'metrics.cost_micros',
          'metrics.clicks',
          'metrics.conversions',
        ],
      }),
    () => say('Saved the daily campaign report in the Campaign Daily tab.'),
    () => call('inspect_sheet', { sheetName: 'Campaign Daily', range: 'A1:E3' }),
    () => {
      const [date, campaign, spend, clicks, conversions] = header('Campaign Daily');
      const sums = [spend, clicks, conversions].map((field) => ({ field, agg: 'sum' }));
      return call('save_dashboard', {
        name: 'Campaign overview',
        target: { sheetName: 'Campaign Dashboard' },
        datasets: [{ id: 'daily', label: 'Daily campaigns', sourceSheet: 'Campaign Daily' }],
        tiles: [
          { title: 'Totals', type: 'kpi', metrics: sums },
          {
            title: 'Weekly spend',
            type: 'line',
            groupBy: [date],
            dateBucket: 'week',
            metrics: sums.slice(0, 1),
          },
          {
            title: 'Campaigns',
            type: 'table',
            groupBy: [campaign],
            metrics: sums,
            orderBy: { field: keyOf(spend), direction: 'desc' },
          },
        ],
      });
    },
    (b) => call('run_dashboard', { id: savedId(b) }),
    () => say('Built the dashboard over the Campaign Daily tab.'),
  ];
  rs = createBenchRuntime({
    provider: scripted(stepsS),
    apiKey: 'self-test-key',
    timeLimit: 120,
    googleAds: { variant: 'normal' },
  });
  const recordsS = runConversation(rs, {
    id: 'selftest-S',
    family: 'reports',
    nouns: ['rows'],
    refresh: { growth: 1.2 },
    turns: [
      { n: 1, kind: 'save_report', text: 'save a daily campaign report' },
      { n: 2, kind: 'dashboard', text: 'a saved dashboard from the report tab' },
    ],
  });
  {
    const record = recordsS[1];
    const bad = differences(record, {
      stop: 'answer',
      failed_steps: 0,
      path: 'save_dashboard',
      reads_report_tabs: true,
      refresh_errors: [],
      stale_ranges: 0,
      stale_kpis: 0,
      stale_after_refresh: false,
    });
    check(
      !bad.length && record.ranges_checked > 0 && record.kpis_checked > 0,
      `reports S: a saved dashboard over a report tab follows the refresh (rows ${record.report_rows_before} -> ${record.report_rows_after}, ranges ${record.stale_ranges}/${record.ranges_checked}, totals ${record.stale_kpis}/${record.kpis_checked})`,
      bad.concat(record.failed_step_sample, record.stale_sample || [], record.tabs)
    );
    // The refreshed page reads every row: no range ends at the report's old last row.
    const daily = rs.f.book.sheets.find((s) => s.name === 'Campaign Daily');
    const last = tabStats(rs, daily).lastRow;
    const ends = new Set();
    for (const sheet of rs.f.book.sheets)
      for (const entry of sheet.cells.values())
        for (const m of String(entry.formula || '').matchAll(
          /'Campaign Daily'!\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?(\d+)/g
        ))
          ends.add(Number(m[1]));
    check(
      ends.size === 1 && ends.has(last),
      `reports S: every range over the refreshed tab ends at its new last row ${last} (${[...ends].join(', ')})`
    );
  }
  return { checks, failures };
}
