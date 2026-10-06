// The benchmark's self-test: no AI request leaves the machine. A scripted provider answers each
// AI request of the real chat runtime with known tool calls, so every tool runs for real against
// the in-memory book, and the same measuring code must report the known answer for each metric.
import { createBenchRuntime } from './runtime.mjs';
import { runConversation } from './conversation.mjs';
import { DOMAINS, seedData } from './scenarios.mjs';
import { call, say, editToken, confirmToken, scripted } from './self-test-script.mjs';
import { runAdversarial } from './self-test-adversarial.mjs';
import { runAdsSelfTest } from './self-test-ads.mjs';
import { runSkeptic } from './self-test-skeptic.mjs';

const ROWS = 120;
const regions = ['North', 'South', 'West'];
const dataTable = [['Region', 'Amount', 'Units']].concat(
  Array.from({ length: ROWS }, (_, i) => [regions[i % 3], 10 * ((i % 7) + 1), (i % 5) + 1])
);

// Conversation A: generate (short of the request, with a wrong claim), summarize (formulas,
// pasted values, a #DIV/0!, an unevaluable formula, a failing step), dashboard (tab, pivot, chart).
const conversationA = [
  // Turn 1
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Data', count: 200 }),
  (b) => call('inspect_sheet', { sheetName: 'Data', range: 'A1:C121' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_values',
      sheetName: 'Data',
      range: 'A1:C121',
      editToken: editToken(b),
      values: dataTable,
    }),
  () => say('I created 150 orders in Data!A1:C151 with Region, Amount and Units.'),
  // Turn 2
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Summary', count: 50 }),
  (b) => call('inspect_sheet', { sheetName: 'Summary', range: 'A1:E4' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Summary',
      range: 'A1:E4',
      editToken: editToken(b),
      formulas: [
        ['Region', 'Total', 'Units (pasted)', 'Ratio', 'Note'],
        ['North', '=SUMIFS(Data!B:B,Data!A:A,A2)', '12', '=B2/0', '=TEXTJOIN(",",TRUE,A2:A4)'],
        ['South', '=SUMIFS(Data!B:B,Data!A:A,A3)', '7', '=B3/C3', ''],
        ['West', '=SUMIFS(Data!B:B,Data!A:A,A4)', '5', '=IFERROR(B4/0,0)', ''],
      ],
    }),
  // A step that fails: an edit of existing cells without the inspected editToken (on a tab an
  // earlier request made; one this request made needs none).
  () =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Data',
      range: 'G1',
      formulas: [['=1+1']],
    }),
  () => say('Summary!A1:E4 totals the 120 orders per region.'),
  // Turn 3
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Dashboard', count: 50 }),
  () =>
    call('create_pivot', {
      sourceSheet: 'Data',
      sourceRange: 'A1:C121',
      targetSheet: 'Dashboard',
      targetCell: 'A1',
      rows: [{ column: 1 }],
      values: [{ column: 2, summarize: 'SUM' }],
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
  () => say('The Dashboard tab has a pivot of amount by region and a column chart of totals.'),
];

// Conversation B: a change that needs a yes (auto-confirmed), a question to the user, and a turn
// that runs into the round cap.
const conversationB = [
  // Turn 1
  () => call('edit_sheet', { action: 'insert_rows', sheetName: 'Sheet1', start: 2, count: 5 }),
  () => call('ask_user', { question: 'Insert 5 rows in Sheet1?', options: ['Yes', 'No'] }),
  (b) =>
    call('edit_sheet', {
      action: 'insert_rows',
      sheetName: 'Sheet1',
      start: 2,
      count: 5,
      confirmToken: confirmToken(b),
    }),
  () => say('I inserted 5 rows in Sheet1.'),
  // Turn 2
  () => call('ask_user', { question: 'Which column should I use?', options: ['A', 'B'] }),
  // Turn 3
  { loop: () => call('list_sheets', {}), final: 'I ran out of rounds before finishing.' },
];

// Conversation C: a generated table (MAKEARRAY with a VSTACK header and the model's own lists),
// frozen to values, as chat generates datasets.
const GENERATED = 300;
const conversationC = [
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Leads', count: 400 }),
  (b) => call('inspect_sheet', { sheetName: 'Leads', range: 'A1:C1' }),
  (b) =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Leads',
      range: 'A1',
      editToken: editToken(b),
      formulas: [
        [
          `=VSTACK({"Lead ID","Source","Value"},MAKEARRAY(${GENERATED},3,LAMBDA(r,c,CHOOSE(c,"L-"&TEXT(r,"0000"),INDEX({"Ads","Referral","Events"},MOD(r,3)+1),RANDBETWEEN(100,900)))))`,
        ],
      ],
    }),
  (b) =>
    call('edit_sheet', {
      action: 'copy_range',
      sheetName: 'Leads',
      range: 'A1',
      destination: 'A1',
      pasteType: 'values',
      editToken: editToken(b),
    }),
  () => say(`I created the Leads tab with ${GENERATED} leads in Leads!A1:C301.`),
];

// metric: [expected, actual] checks per turn.
const EXPECT = {
  A: [
    // 120 of the 150 rows asked for: answered, but the request is not done.
    {
      stop: 'answer',
      completed: false,
      delivered: false,
      rows_requested: 150,
      rows_written: ROWS,
      rows_ratio: 0.8,
      rows_approx: false,
      data_tab: 'Data',
      failed_steps: 0,
      claims_mismatch: true,
      error_cells: 0,
      charts: 0,
      pivots: 0,
    },
    {
      stop: 'answer',
      completed: true,
      rows_written: ROWS,
      derived_tabs: ['Summary'],
      // Seven formulas; the one showing #DIV/0! and the TEXTJOIN label deliver no number, so
      // five are live numbers.
      formula_cells: 7,
      live_cells: 5,
      value_cells: 3,
      formula_share: 0.625,
      error_cells: 1,
      unevaluated_formulas: 1,
      errors_approx: true,
      tool_reported_errors: 1,
      failed_steps: 1,
      claims_mismatch: false,
      charts: 0,
    },
    // A native pivot's numbers are live: the dashboard's numbers are all live.
    {
      stop: 'answer',
      completed: true,
      derived_tabs: ['Dashboard'],
      charts: 1,
      pivots: 1,
      dashboard_tab: true,
      failed_steps: 0,
      error_cells: 1,
      error_cells_new: 0,
      formula_cells: 0,
      live_cells: 3,
      value_cells: 0,
      formula_share: 1,
    },
  ],
  B: [
    {
      stop: 'answer',
      completed: true,
      needs_confirmation: 1,
      confirms_sent: 1,
      failed_steps: 0,
      claims_mismatch: false,
    },
    { stop: 'ask_user', completed: false, failed_steps: 0 },
    { stop: 'round_cap', completed: false },
  ],
  // D: turn 1 skipped, the data tab seeded (--turns 2,3); the reply alone summarizes nothing,
  // so the turn is not done.
  D: [
    {
      stop: 'answer',
      delivered: false,
      completed: false,
      rows_requested: 50,
      rows_written: 50,
      rows_ratio: 1,
      data_tab: 'Orders',
      derived_tabs: [],
      claims_mismatch: false,
    },
  ],
  C: [
    {
      stop: 'answer',
      completed: true,
      rows_requested: GENERATED,
      rows_written: GENERATED,
      rows_ratio: 1,
      rows_approx: false,
      data_tab: 'Leads',
      failed_steps: 0,
      claims_mismatch: false,
      formula_cells: 0,
      error_cells: 0,
    },
  ],
};

// Values the calculator must give (checked on the book after the conversation).
const sumBy = (region) =>
  dataTable
    .slice(1)
    .filter((row) => row[0] === region)
    .reduce((a, row) => a + row[1], 0);
const VALUES = {
  A: [
    ['Summary', '2:2', sumBy('North')],
    ['Summary', '3:2', sumBy('South')],
    ['Summary', '4:2', sumBy('West')],
    ['Summary', '2:4', '#DIV/0!'],
    ['Summary', '3:4', sumBy('South') / 7],
    ['Summary', '4:4', 0],
  ],
  C: [['Leads', '1:2', 'Source']],
};

export function runSelfTest({ log = console.log } = {}) {
  let failures = 0,
    checks = 0;
  const conversations = [
    {
      key: 'A',
      steps: conversationA,
      turns: [1, 2, 3],
      rowsRequested: 150,
      prompts: ['make 150 orders', 'summarize per region', 'dashboard please'],
    },
    {
      key: 'B',
      steps: conversationB,
      turns: [1, 2, 3],
      rowsRequested: null,
      prompts: ['insert 5 rows at the top', 'add a column', 'list the tabs forever'],
    },
    {
      key: 'C',
      steps: conversationC,
      turns: [1],
      rowsRequested: GENERATED,
      prompts: ['generate 300 leads'],
    },
    {
      key: 'D',
      steps: [() => say('The Orders tab holds 50 orders.')],
      turns: [2],
      rowsRequested: 50,
      prompts: ['', 'summarize per customer'],
      seed: seedData(DOMAINS[0], 50),
    },
  ];
  for (const conv of conversations) {
    const rt = createBenchRuntime({
      provider: scripted(conv.steps),
      apiKey: 'self-test-key',
      timeLimit: 60,
    });
    const records = runConversation(rt, {
      id: 'selftest-' + conv.key,
      rowsRequested: conv.rowsRequested,
      turns: conv.turns,
      prompt: (turn) => conv.prompts[turn - 1],
      nouns: ['orders', 'rows', 'records'],
      seed: conv.seed || null,
    });
    records.forEach((record, i) => {
      const expected = EXPECT[conv.key][i];
      const bad = [];
      for (const [key, want] of Object.entries(expected)) {
        checks++;
        const got = record[key];
        const same = JSON.stringify(got) === JSON.stringify(want);
        if (!same) {
          failures++;
          bad.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
      }
      log(
        `${bad.length ? 'FAIL' : 'ok  '} conversation ${conv.key} turn ${record.turn} (${record.kind}) stop=${record.stop} rounds=${record.rounds} rows=${record.rows_written}/${record.rows_requested ?? '-'} formulas=${record.formula_cells} values=${record.value_cells} share=${record.formula_share} errors=${record.error_cells} uneval=${record.unevaluated_formulas} charts=${record.charts} pivots=${record.pivots} failed=${record.failed_steps} confirm=${record.needs_confirmation} claims=${record.claims_mismatch ? 'mismatch' : 'ok'}`
      );
      for (const line of bad) log('       ' + line);
      if (bad.length) {
        log('       tabs: ' + record.tabs.join(' '));
        for (const e of record.failed_step_sample) log('       failed step: ' + e);
        for (const e of record.error_sample) log('       error cell: ' + e);
        for (const e of record.claims_evidence) log('       claim: ' + e);
      }
    });
    for (const [tab, key, want] of VALUES[conv.key] || []) {
      checks++;
      const got = rt.f.book.sheets.find((sheet) => sheet.name === tab)?.cells.get(key)?.value;
      const same = typeof want === 'number' ? Math.abs(got - want) < 1e-9 : got === want;
      if (!same) failures++;
      log(
        `${same ? 'ok  ' : 'FAIL'} value ${tab}!${key} expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`
      );
    }
    if (conv.key === 'C') {
      // Generated values come from the model's own list for that column.
      checks++;
      const sheet = rt.f.book.sheets.find((x) => x.name === 'Leads');
      const sources = new Set();
      for (let r = 2; r <= GENERATED + 1; r++) sources.add(sheet.cells.get(`${r}:2`)?.value);
      const ok =
        [...sources].every((v) => ['Ads', 'Referral', 'Events'].includes(v)) && sources.size === 3;
      if (!ok) failures++;
      log(
        `${ok ? 'ok  ' : 'FAIL'} generated Source values from the formula's list: ${[...sources].join(', ')}`
      );
    }
    if (conv.key === 'A') {
      // Claims evidence names both wrong statements of turn 1.
      checks++;
      const ev = records[0].claims_evidence.join(' | ');
      if (!/150 orders/.test(ev) || !/Data!A1:C151/.test(ev)) {
        failures++;
        log('FAIL claims evidence of turn 1 should cite "150 orders" and "Data!A1:C151": ' + ev);
      } else log('ok   claims evidence: ' + ev);
    }
  }
  const adversarial = runAdversarial({ log });
  checks += adversarial.checks;
  failures += adversarial.failures;
  const ads = runAdsSelfTest({ log });
  checks += ads.checks;
  failures += ads.failures;
  const skeptic = runSkeptic({ log });
  checks += skeptic.checks;
  failures += skeptic.failures;
  log(`self-test: ${checks - failures}/${checks} checks passed`);
  return failures === 0;
}
