// Adversarial self-test cases: each one is a way a turn could fool a measure (constant formulas
// passed off as live, values spilled or pasted where the measure does not look, a header or
// title row counted as data, an empty chart, a tab named but empty, counts quoted from the
// sheet taken for false claims, a time-over read as the round cap, fetched values counted as
// pasted). Every case states the true answer; the measures must give it.
import { createBenchRuntime } from './runtime.mjs';
import { runConversation } from './conversation.mjs';
import { snapshot, measureTurn } from './metrics.mjs';
import { aggregate } from './report.mjs';
import { checkClaims } from './claims.mjs';
import { renderPivots, createCalculator } from './formulas.mjs';
import {
  call,
  say,
  malformed,
  editToken,
  confirmToken,
  scripted,
  differences,
} from './self-test-script.mjs';

const ROWS = 120;
const regions = ['North', 'South', 'West'];
const table = [['Region', 'Amount', 'Units']].concat(
  Array.from({ length: ROWS }, (_, i) => [regions[i % 3], 10 * ((i % 7) + 1), (i % 5) + 1])
);
const total = (region) =>
  table
    .slice(1)
    .filter((row) => !region || row[0] === region)
    .reduce((a, row) => a + row[1], 0);
const seed = {
  tab: 'Data',
  table,
  transcript: [
    { role: 'user', text: 'make 120 orders' },
    {
      role: 'assistant',
      text: 'I created the Data tab with 120 rows in A1:C121.',
      actions: ['Created tab Data', 'Updated Data!A1:C121'],
    },
  ],
};

// E: formula share. A QUERY (one formula, several live numbers), constant formulas (=1610,
// =1590+0, ={100;200;300}) that are typed numbers in disguise, a year typed as a column header
// above live formulas, a value pasted beside the data on the pre-existing data tab; then a
// dashboard with an empty chart, a real chart and a pivot, and a reply with counts read from the
// sheet (40 orders per region) and rates (2 orders per customer) next to a wrong total written
// with space grouping.
const conversationE = [
  // Turn 2
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Summary', count: 50 }),
  () => call('inspect_sheet', { sheetName: 'Summary', range: 'A1:I4' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Summary',
      range: 'A1:I4',
      editToken: editToken(b),
      formulas: [
        [
          `=QUERY(Data!A1:C121,"select A, sum(B) group by A label sum(B) 'Total'",1)`,
          '',
          '',
          'Hard',
          '',
          '={100;200;300}',
          '',
          'Region',
          '2025',
        ],
        ['', '', '', '=1610', '', '', '', 'North', '=SUMIFS(Data!B:B,Data!A:A,H2)'],
        ['', '', '', '=1590+0', '', '', '', 'South', '=SUMIFS(Data!B:B,Data!A:A,H3)'],
        ['', '', '', '', '', '', '', 'West', '=SUMIFS(Data!B:B,Data!A:A,H4)'],
      ],
    }),
  () => call('inspect_sheet', { sheetName: 'Data', range: 'E1:E2' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_values',
      sheetName: 'Data',
      range: 'E1:E2',
      editToken: editToken(b),
      values: [['Total'], [total()]],
    }),
  () =>
    say(
      'Summary!A1:B4 totals the 120 orders per region; North has 40 orders, about 2 orders per customer across 12 months of orders.'
    ),
  // Turn 3
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Dashboard', count: 50 }),
  // A chart over headings with nothing below them (the app draws it).
  () => call('inspect_sheet', { sheetName: 'Summary', range: 'K1:L4' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_values',
      sheetName: 'Summary',
      range: 'K1:L1',
      editToken: editToken(b),
      values: [['Month', 'Sales']],
    }),
  () =>
    call('create_chart', {
      sheetName: 'Summary',
      range: 'K1:L4',
      chartType: 'column',
      title: 'Nothing here',
      xColumn: 'Month',
      seriesColumns: ['Sales'],
    }),
  () =>
    call('create_chart', {
      sheetName: 'Summary',
      range: 'A1:B4',
      chartType: 'column',
      title: 'Total by region',
      xColumn: 'Region',
      seriesColumns: ['Total'],
    }),
  () =>
    call('create_pivot', {
      sourceSheet: 'Data',
      sourceRange: 'A1:C121',
      targetSheet: 'Dashboard',
      targetCell: 'A1',
      rows: [{ column: 1 }],
      values: [{ column: 2, summarize: 'SUM' }],
    }),
  () => say('The Dashboard tab has a chart and a pivot over all 1 200 orders.'),
];

// F: stop reasons and completion. Turn 1 answers with a question in prose and writes nothing;
// turn 2 runs out of time after malformed calls (trace rounds reach the cap, app rounds do not);
// turn 3 makes an empty Dashboard tab and says the dashboard is ready.
let clock = null;
const conversationF = [
  // Turn 1
  () => say('Sure! Which columns would you like in the dataset?'),
  // Turn 2
  ...Array.from({ length: 6 }, () => () => call('list_sheets', {})),
  () => malformed(),
  () => malformed(),
  () => {
    clock.advance(10 * 60 * 1000);
    return call('list_sheets', {});
  },
  // Past its time the app answers without another AI request.
  // Turn 3
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Dashboard', count: 50 }),
  () => say('Your dashboard is ready on the Dashboard tab.'),
];

// G: rows. A title row, a blank row and the header on row 3; 100 data rows of which the last 10
// hold only the ID; written to Sheet1 while a new Shipments tab stays empty (and the reply names
// it). Turn 2 pastes a summary beside the data on the data tab.
const shipments = [
  ['Shipments 2026', '', ''],
  ['', '', ''],
  ['Shipment ID', 'Carrier', 'Cost'],
].concat(
  Array.from({ length: 100 }, (_, i) =>
    i < 90
      ? ['SHP-' + (1000 + i), ['FastFreight', 'BlueLine', 'Northway'][i % 3], 50 + i]
      : ['SHP-' + (1000 + i), '', '']
  )
);
const conversationG = [
  // Turn 1
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Shipments', count: 200 }),
  () => call('inspect_sheet', { sheetName: 'Sheet1', range: 'A1:C103' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_values',
      sheetName: 'Sheet1',
      range: 'A1:C103',
      editToken: editToken(b),
      values: shipments,
    }),
  () => say('I created the Shipments tab with 100 shipments.'),
  // Turn 2
  () => call('inspect_sheet', { sheetName: 'Sheet1', range: 'E3:F6' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_values',
      sheetName: 'Sheet1',
      range: 'E3:F6',
      editToken: editToken(b),
      values: [
        ['Carrier', 'Total'],
        ['FastFreight', 1234],
        ['BlueLine', 987],
        ['Northway', 555],
      ],
    }),
  () => say('Per-carrier totals are in Sheet1!E3:F6.'),
];

// H: errors. A formula written as text (set_values keeps it as text, so the sheet shows the
// formula), then the data tab deleted: every formula over it becomes #REF! and the QUERY's old
// spilled result must not linger.
const conversationH = [
  // Turn 2
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Summary', count: 50 }),
  () => call('inspect_sheet', { sheetName: 'Summary', range: 'A1:B4' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Summary',
      range: 'A1:B4',
      editToken: editToken(b),
      formulas: [
        ['Region', 'Total'],
        ['North', '=SUMIFS(Data!B:B,Data!A:A,A2)'],
        ['South', '=SUMIFS(Data!B:B,Data!A:A,A3)'],
        ['West', '=SUMIFS(Data!B:B,Data!A:A,A4)'],
      ],
    }),
  () => call('inspect_sheet', { sheetName: 'Summary', range: 'D1:F2' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Summary',
      range: 'D1',
      editToken: editToken(b),
      formulas: [[`=QUERY(Data!A1:C121,"select A, count(B) group by A",1)`]],
    }),
  (b) =>
    call('edit_sheet', {
      action: 'set_values',
      sheetName: 'Summary',
      range: 'F1:F2',
      editToken: editToken(b),
      values: [['Check'], ['=SUM(B2:B4)']],
    }),
  () => say('The Summary tab totals each region.'),
  // Turn 3
  () => call('edit_sheet', { action: 'delete_sheet', sheetName: 'Data' }),
  () => call('ask_user', { question: 'Delete the Data tab?', options: ['Yes', 'No'] }),
  (b) =>
    call('edit_sheet', {
      action: 'delete_sheet',
      sheetName: 'Data',
      confirmToken: confirmToken(b),
    }),
  () => say('I removed the Data tab.'),
];

const EXPECT = {
  E: [
    {
      stop: 'answer',
      completed: true,
      derived_tabs: ['Summary'],
      // The QUERY's anchor shows its header text, not a number: its three spilled totals and
      // the three SUMIFS are the live numbers.
      formula_cells: 4,
      live_cells: 6,
      value_cells: 6,
      formula_share: 0.5,
      error_cells: 0,
      claims_mismatch: false,
    },
    {
      stop: 'answer',
      completed: true,
      derived_tabs: ['Dashboard'],
      charts: 1,
      charts_empty: 1,
      pivots: 1,
      dashboard_tab: true,
      formula_share: 1,
      claims_mismatch: true,
    },
  ],
  F: [
    { stop: 'answer', completed: false, rows_written: 0 },
    { stop: 'time_over', completed: false, malformed_calls: 2, failed_steps: 0 },
    {
      stop: 'answer',
      completed: false,
      charts: 0,
      dashboard_tab: false,
      empty_new_tabs: 1,
      claims_mismatch: true,
    },
  ],
  G: [
    // 90 full rows of 100 asked for: not done.
    {
      stop: 'answer',
      completed: false,
      rows_requested: 100,
      rows_written: 90,
      rows_ratio: 0.9,
      data_tab: 'Sheet1',
      derived_tabs: [],
      empty_new_tabs: 1,
      claims_mismatch: true,
    },
    {
      stop: 'answer',
      completed: true,
      rows_written: 90,
      derived_tabs: [],
      formula_cells: 0,
      value_cells: 3,
      formula_share: 0,
      claims_mismatch: false,
    },
  ],
  H: [
    { stop: 'answer', completed: true, formula_cells: 4, error_cells: 1, error_cells_new: 1 },
    // Deleting the data tab breaks four formulas and builds nothing: not a delivered dashboard turn.
    {
      stop: 'answer',
      delivered: false,
      completed: false,
      confirms_sent: 1,
      error_cells: 5,
      error_cells_new: 4,
    },
  ],
};

export function runAdversarial({ log = console.log } = {}) {
  let checks = 0,
    failures = 0;
  const check = (ok, text, detail = []) => {
    checks++;
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
    if (!ok) for (const line of detail) log('       ' + line);
  };
  const conversations = [
    {
      key: 'E',
      steps: conversationE,
      turns: [2, 3],
      rowsRequested: ROWS,
      seed,
      prompts: ['', 'summarize per region', 'dashboard please'],
    },
    {
      key: 'F',
      steps: conversationF,
      turns: [1, 2, 3],
      rowsRequested: 50,
      prompts: ['make 50 orders', 'list the tabs', 'dashboard please'],
    },
    {
      key: 'G',
      steps: conversationG,
      turns: [1, 2],
      rowsRequested: 100,
      prompts: ['create 100 shipments', 'per-carrier totals'],
    },
    {
      key: 'H',
      steps: conversationH,
      turns: [2, 3],
      rowsRequested: ROWS,
      seed,
      prompts: ['', 'summarize per region', 'drop the data tab'],
    },
  ];
  const books = {};
  for (const conv of conversations) {
    const rt = createBenchRuntime({
      provider: scripted(conv.steps),
      apiKey: 'self-test-key',
      timeLimit: 60,
    });
    clock = rt;
    books[conv.key] = rt;
    const records = runConversation(rt, {
      id: 'adversarial-' + conv.key,
      rowsRequested: conv.rowsRequested,
      turns: conv.turns,
      prompt: (turn) => conv.prompts[turn - 1],
      nouns: ['orders', 'shipments', 'rows', 'records'],
      seed: conv.seed || null,
    });
    records.forEach((record, i) => {
      const bad = differences(record, EXPECT[conv.key][i]);
      checks += Object.keys(EXPECT[conv.key][i]).length - 1;
      check(
        !bad.length,
        `conversation ${conv.key} turn ${record.turn} (${record.kind}) stop=${record.stop} done=${record.completed} rows=${record.rows_written}/${record.rows_requested} formulas=${record.formula_cells} live=${record.live_cells} values=${record.value_cells} share=${record.formula_share} errors=${record.error_cells} charts=${record.charts}/${record.charts_empty} claims=${record.claims_mismatch ? 'mismatch' : 'ok'}`,
        bad.concat(
          bad.length ? ['tabs: ' + record.tabs.join(' ')] : [],
          record.failed_step_sample.map((e) => 'failed step: ' + e),
          bad.length ? record.error_sample.map((e) => 'error cell: ' + e) : [],
          bad.length ? record.claims_evidence.map((e) => 'claim: ' + e) : []
        )
      );
      if (conv.key === 'E' && record.turn === 3) {
        const ev = record.claims_evidence.join(' | ');
        check(
          /1 200 orders/.test(ev) && !/"200 orders/.test(ev),
          `claims evidence cites the space-grouped total as one number: ${ev}`
        );
      }
      if (conv.key === 'G' && record.turn === 1) {
        const ev = record.claims_evidence.join(' | ');
        check(
          /Shipments/.test(ev) && /empty/.test(ev),
          `claims evidence names the empty Shipments tab: ${ev}`
        );
      }
    });
  }
  // H: the deleted tab's QUERY leaves no stale spilled cells behind its #REF!.
  {
    const summary = books.H.f.book.sheets.find((s) => s.name === 'Summary');
    const stale = [...summary.cells.entries()].filter(
      ([, e]) => e.spilledFrom && !String(e.spilledFrom).startsWith('pivot:')
    );
    check(stale.length === 0, `a #REF! QUERY keeps no spilled cells (found ${stale.length})`);
  }

  // A removed pivot leaves no rendered cells.
  {
    const rt = books.E;
    const dashboard = rt.f.book.sheets.find((s) => s.name === 'Dashboard');
    const anchor = [...dashboard.meta.entries()].find(([, m]) => m && m.pivotTable)?.[0];
    dashboard.meta.delete(anchor);
    renderPivots(rt.f.book);
    const left = [...dashboard.cells.values()].filter((e) =>
      String(e.spilledFrom || '').startsWith('pivot:')
    ).length;
    check(left === 0, `a removed pivot leaves no rendered cells (found ${left})`);
  }

  // Values a report or dashboard run fetched into its own tab are not pasted values; the same
  // values on a dashboard page are.
  {
    const rt = createBenchRuntime({
      provider: scripted([]),
      apiKey: 'self-test-key',
      timeLimit: 60,
    });
    rt.seedTab('Data', table);
    const before = snapshot(rt);
    const book = rt.f.book;
    const fetched = book.insertSheet('Ads data');
    const page = book.insertSheet('Ads page');
    for (const sheet of [fetched, page]) {
      rt.f.setCell(sheet, 1, 1, 'Campaign');
      rt.f.setCell(sheet, 1, 2, 'Spend');
      for (let r = 2; r <= 6; r++) {
        rt.f.setCell(sheet, r, 1, 'C' + r);
        rt.f.setCell(sheet, r, 2, r * 10);
      }
    }
    const record = (sheet, extra) => ({
      metadataKey: 'dmv:v1:output',
      metadataValue: JSON.stringify({
        id: 'r1',
        sheetId: sheet.id,
        row: 1,
        column: 1,
        rows: 6,
        columns: 2,
        ...extra,
      }),
      location: { sheetId: sheet.id },
    });
    fetched.developerMetadata.push(record(fetched, {}));
    page.developerMetadata.push(record(page, { page: true }));
    const dataSheetId = book.sheets[0].id;
    const result = {
      tools: [{ name: 'run_dashboard' }],
      stop: 'answer',
      text: '',
      rounds: 2,
      seconds: 1,
      confirmsSent: 0,
    };
    const m = measureTurn(rt, {
      before,
      result,
      turn: 3,
      kind: 'dashboard',
      rowsRequested: ROWS,
      dataSheetId,
      nouns: ['orders'],
    });
    check(
      m.value_cells === 5 && m.fetched_cells === 12,
      `fetched report values are not pasted values; a page's typed numbers are (value_cells ${m.value_cells}, fetched_cells ${m.fetched_cells})`
    );
  }

  // Claims: grouping styles, rates, subsets, counts read from the sheet.
  {
    const tabs = [
      { sheet: { name: 'Orders' }, stats: { dataRows: 1000, lastRow: 1001, headerRow: 1 } },
    ];
    const run = (text, extra = {}) =>
      checkClaims(text, { nouns: ['orders', 'rows'], tabs, dataRows: 1000, ...extra });
    const cases = [
      ['All 1,000 orders are in Orders!A1:H1001.', false],
      ['All 1 000 orders are in the Orders tab.', false],
      ['All 1.000 orders are in the Orders tab.', false],
      ['I generated 1 500 orders.', true],
      ['I generated 1.500 orders.', true],
      ['Customers average 2.5 orders each and 3 orders per month.', false],
      ['The data spans 12 months of orders.', false],
      // A count the book does not show is unverified; one a cell or a value's frequency shows is not.
      ['The top customer placed 14 orders.', true],
      ['The top customer placed 14 orders.', false, { evidence: [14] }],
      ['Electronics has 212 orders.', false, { evidence: [212] }],
      ['Electronics has 213 orders.', true, { evidence: [212] }],
      [
        'About 30k orders were written.',
        false,
        {
          tabs: [
            { sheet: { name: 'Orders' }, stats: { dataRows: 29850, lastRow: 29851, headerRow: 1 } },
          ],
          dataRows: 29850,
        },
      ],
    ];
    for (const [text, mismatch, extra] of cases) {
      const got = run(text, extra || {});
      check(
        got.mismatch === mismatch,
        `claims "${text}" → ${got.mismatch ? 'mismatch' : 'ok'} ${got.evidence.join(' | ')}`
      );
    }
  }

  // Aggregation: rows are judged on the generate turn only (a seeded or repeated record is no
  // evidence), and more rows than asked is not a pass.
  {
    const base = {
      formula_share: null,
      error_cells: 0,
      charts: 0,
      completed: true,
      claims_mismatch: false,
      errors_approx: false,
      rows_approx: false,
    };
    const records = [
      { ...base, turn: 1, kind: 'generate', rows_requested: 100, rows_ratio: 0.5 },
      { ...base, turn: 2, kind: 'summarize', rows_requested: 100, rows_ratio: 0.5 },
      { ...base, turn: 3, kind: 'dashboard', rows_requested: 100, rows_ratio: 0.5 },
      { ...base, turn: 1, kind: 'generate', rows_requested: 100, rows_ratio: 2 },
      { ...base, turn: 2, kind: 'summarize', rows_requested: 100, rows_ratio: 1 },
    ];
    const totals = aggregate(records);
    const rows = totals.pass.rows_within_1pct;
    check(
      rows && rows.pass === 0 && rows.of === 2,
      `rows pass rate counts generate turns only and caps the ratio: ${JSON.stringify(rows)}; mean ${totals.means.rows_ratio}`
    );
    const atLeast = totals.pass.rows_ratio_ge_0_99;
    check(
      atLeast && atLeast.pass === 1 && atLeast.of === 2,
      `rows_ratio >= 0.99 counts generate turns only (twice the rows passes it): ${JSON.stringify(atLeast)}`
    );
    check(
      totals.means.rows_ratio === 1.25,
      `mean rows ratio over generate turns only: ${totals.means.rows_ratio}`
    );
  }
  {
    // A header row stacked onto a generator inside an array literal is a generated table, not
    // an unreadable literal: the calculator must spill header + n rows (the chat reads the tab).
    const calc = createCalculator(() => ({ sheets: [] }));
    const at = { sheet: 'Data', row: 1, column: 1 };
    const stacked = calc(
      '={"ID","Region","Amount";LET(n,250,MAKEARRAY(n,3,LAMBDA(r,c,CHOOSE(c,"ID-"&r,INDEX({"North","South"},RANDBETWEEN(1,2)),RANDBETWEEN(10,90)))))}',
      at
    );
    check(
      Array.isArray(stacked) && stacked.length === 251 && stacked[0][1] === 'Region',
      `{header;LET(..MAKEARRAY..)} spills header + 250 rows (got ${Array.isArray(stacked) ? stacked.length + ' rows' : JSON.stringify(stacked)})`
    );
    const literal = calc('={1,2;3,4}', at);
    check(
      JSON.stringify(literal) === '[[1,2],[3,4]]',
      `a constant array literal still evaluates as itself (${JSON.stringify(literal)})`
    );
    // {range} and stacked references read the cells, as Sheets does (the chat reads the result).
    const cells = new Map([
      ['1:1', { value: 'Team' }],
      ['1:2', { value: 'Count' }],
      ['2:1', { value: 'Ops' }],
      ['2:2', { value: 7 }],
    ]);
    const refCalc = createCalculator(() => ({ sheets: [{ id: 9, name: 'Team Summary', cells }] }));
    const one = refCalc("={'Team Summary'!A1:B2}", at);
    const stackedRefs = refCalc("={'Team Summary'!A1:B1;'Team Summary'!A2:B2;\"All\",7}", at);
    const extremes = [
      refCalc("=MAXIFS('Team Summary'!B2:B2,'Team Summary'!A2:A2,\"Ops\")", at),
      refCalc("=MINIFS('Team Summary'!B2:B2,'Team Summary'!A2:A2,\"Ops\")+1", at),
    ];
    check(
      JSON.stringify(extremes) === '[7,8]',
      `MAXIFS/MINIFS evaluate (${JSON.stringify(extremes)})`
    );
    const ragged = refCalc("={'Team Summary'!A1:B2,'Team Summary'!A1:A1}", at);
    check(
      JSON.stringify(one) === '[["Team","Count"],["Ops",7]]' &&
        JSON.stringify(stackedRefs) === '[["Team","Count"],["Ops",7],["All",7]]' &&
        ragged === '#VALUE!',
      `{range} reads its cells, stacked references stack, uneven heights are #VALUE! (${JSON.stringify([one, stackedRefs, ragged])})`
    );
  }
  return { checks, failures };
}
