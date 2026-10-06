// Self-test of the array evaluator (arrays.mjs through the calculator) and of the per-entity and
// generated-data measures (entity.mjs). Every case states the true answer: generated totals
// computed from their columns are consistent and totals drawn again per cell are not; an entity
// tab of live spilling formulas is found, live, checked column by column against the data, with
// a live segment and a correct repeat share; the same table pasted as values is found but not
// live, and a top-5 table is no entity tab.
import { createBenchRuntime } from './runtime.mjs';
import { runConversation } from './conversation.mjs';
import { createCalculator } from './formulas.mjs';
import { call, say, editToken, savedId, scripted, differences } from './self-test-script.mjs';

const HEADER = '{"Order ID","Order Date","Customer","Quantity","Unit Price","Total"}';
const N = 300;
// Each random column drawn once for every row, the total computed from them.
const CONSISTENT = `=LET(n,${N},q,1+INT(RANDARRAY(n,1)*4),p,ROUND(5+RANDARRAY(n,1)*20,2),VSTACK(${HEADER},HSTACK("O-"&SEQUENCE(n),DATE(2026,1,1)+INT(RANDARRAY(n,1)*200),"C-"&(100+INT(RANDARRAY(n,1)^2*40)),q,p,ROUND(q*p,2))))`;
// MAKEARRAY draws again in every cell: the total is not the row's quantity x price.
const REDRAWN = `=VSTACK(${HEADER},MAKEARRAY(${N},6,LAMBDA(r,c,CHOOSE(c,"O-"&r,DATE(2026,1,1)+INT(RAND()*200),"C-"&(100+INT(RAND()^2*40)),1+INT(RAND()*4),ROUND(5+RAND()*20,2),ROUND((1+INT(RAND()*4))*(5+RAND()*20),2)))))`;
// One spilling formula: keys, orders, revenue, first and last date, days since last, a segment.
const ENTITY = `=LET(k,SORT(UNIQUE(FILTER(Orders!C2:C,Orders!C2:C<>""))),n,COUNTIF(Orders!C2:C,k),rev,SUMIF(Orders!C2:C,k,Orders!F2:F),first,MAP(k,LAMBDA(x,MINIFS(Orders!B2:B,Orders!C2:C,x))),last,MAP(k,LAMBDA(x,MAXIFS(Orders!B2:B,Orders!C2:C,x))),days,MAX(Orders!B2:B)-last,seg,IFS(n>=12,"Loyal",days>45,"Lapsed",TRUE,"Active"),VSTACK({"Customer","Orders","Revenue","First Order","Last Order","Days Since Last","Segment"},HSTACK(k,n,rev,first,last,days,seg)))`;

const generate = (formula) => [
  () => call('edit_sheet', { action: 'create_sheet', newName: 'Orders', count: N + 1 }),
  () =>
    call('edit_sheet', {
      action: 'set_formulas',
      sheetName: 'Orders',
      range: 'A1',
      formulas: [[formula]],
    }),
  (b) =>
    call('edit_sheet', {
      action: 'copy_range',
      sheetName: 'Orders',
      range: 'A1',
      destination: 'A1',
      pasteType: 'values',
      editToken: editToken(b),
    }),
  () => say(`I created the Orders tab with ${N} orders in Orders!A1:F${N + 1}.`),
];

// A small seeded data tab with known keys (for the pasted-values and top-5 cases).
// Eight keys seen several times, three seen once: the repeat share is 8 / 11.
const KEYS = ['K-1', 'K-2', 'K-3', 'K-4', 'K-5', 'K-6', 'K-7', 'K-8'];
const ONCE = ['K-9', 'K-10', 'K-11'];
const seedTable = [
  ['Order ID', 'Order Date', 'Customer', 'Quantity', 'Unit Price', 'Total', 'Status'],
].concat(
  Array.from({ length: 80 }, (_, i) => {
    const q = (i % 3) + 1,
      p = 10 + (i % 5);
    return [
      'O-' + (i + 1),
      new Date(Date.UTC(2026, 0, 1 + ((i * 7) % 150))),
      // Every key, the first ones most often.
      KEYS[Math.floor(((i * 37) % 80) ** 2 / 800)],
      q,
      p,
      q * p,
      i % 3 ? 'Paid' : 'Open',
    ];
  }),
  ONCE.map((k, i) => ['O-' + (81 + i), new Date(Date.UTC(2026, 5, 1 + i)), k, 1, 10, 10, 'Paid'])
);
const seed = {
  tab: 'Orders',
  table: seedTable,
  transcript: [
    { role: 'user', text: 'make 83 orders' },
    {
      role: 'assistant',
      text: 'I created the Orders tab with 83 rows in A1:G84.',
      actions: ['Created tab Orders', 'Updated Orders!A1:G84'],
    },
  ],
};
const counts = new Map(KEYS.concat(ONCE).map((k) => [k, 0]));
seedTable.slice(1).forEach((row) => counts.set(row[2], counts.get(row[2]) + 1));
const pasted = [['Customer', 'Orders', 'Segment']].concat(
  [...counts].filter(([, n]) => n > 0).map(([k, n]) => [k, n, n > 10 ? 'High' : 'Low'])
);

// The recipe the system prompt gives: a QUERY grouped by the key, then ARRAYFORMULA columns over
// ranges that end at the last key (X2:INDEX(X:X,COUNTA(A:A))), so no row below the keys shows "".
const QUERY_CELL = `=QUERY(Orders!A1:F${N + 1},"select C, count(A), sum(F), min(B), max(B) where C is not null group by C label count(A) 'Orders', sum(F) 'Revenue', min(B) 'First Order', max(B) 'Last Order'",1)`;
const TO_KEY = (column) => `${column}2:INDEX(${column}:${column},COUNTA(A:A))`;
const RECIPE = [
  [QUERY_CELL, '', '', '', '', 'Days Since Last', 'Repeat', 'Segment'],
  [
    '',
    '',
    '',
    '',
    '',
    `=ARRAYFORMULA(MAX(Orders!B2:B)-${TO_KEY('E')})`,
    `=ARRAYFORMULA(--(${TO_KEY('B')}>1))`,
    `=ARRAYFORMULA(IFS(${TO_KEY('F')}>45,"Lapsed",${TO_KEY('B')}>=12,"Loyal",TRUE,"Active"))`,
  ],
];
// The earlier recipe, still met on users' tabs: columns over open ranges, guarded by the key, show
// "" in every row below the keys.
const GUARDED = [
  [QUERY_CELL, '', '', '', '', 'Days Since Last', 'Repeat', 'Segment'],
  [
    '',
    '',
    '',
    '',
    '',
    `=ARRAYFORMULA(IF(A2:A="",,MAX(Orders!B2:B)-E2:E))`,
    '=ARRAYFORMULA(IF(A2:A="",,--(B2:B>1)))',
    '=ARRAYFORMULA(IF(A2:A="",,IFS(F2:F>45,"Lapsed",B2:B>=12,"Loyal",TRUE,"Active")))',
  ],
];

// A conversation that builds the entity tab with recipe, then a dashboard of ratios over counts.
const recipeConversation = (name, recipe, extra) => ({
  name,
  steps: generate(CONSISTENT).concat([
    () => call('edit_sheet', { action: 'create_sheet', newName: 'Customers', count: 200 }),
    () =>
      call('edit_sheet', {
        action: 'set_formulas',
        sheetName: 'Customers',
        range: 'A1:H2',
        formulas: recipe,
      }),
    () =>
      call('save_dashboard', {
        name: 'Customers',
        target: { sheetName: 'Customer Dashboard' },
        datasets: [{ id: 'customers', label: 'Customers', sourceSheet: 'Customers' }],
        tiles: [
          {
            title: 'Customers',
            type: 'kpi',
            metrics: [{ field: 'Customer', agg: 'count' }],
            ratios: [
              { key: 'per_customer', numerator: 'Revenue', denominator: 'Customer__count' },
              {
                key: 'repeat_share',
                numerator: 'Repeat',
                denominator: 'Customer__count',
                percent: true,
              },
            ],
          },
          {
            title: 'Customers by segment',
            type: 'bar',
            groupBy: ['Segment'],
            metrics: [{ field: 'Customer', agg: 'count' }],
          },
        ],
      }),
    (b) => call('run_dashboard', { id: savedId(b) }),
    () => say('The Customer Dashboard shows segments and the repeat share.'),
  ]),
  turns: [
    { n: 1, kind: 'generate', text: `generate ${N} orders` },
    { n: 2, kind: 'entity', text: 'segment the customers on a dashboard', dashboard: true },
  ],
  expect: [
    { completed: true, rows_written: N, derived_consistency: 1, failed_steps: 0 },
    {
      failed_steps: 0,
      entity_key: 'Customer',
      entity_tab: true,
      entity_tab_name: 'Customers',
      entity_formula_share: 1,
      segment_column: true,
      retention_measure: true,
      saved_dashboard: true,
    },
  ],
  check: (records, rt) => {
    const ok =
      records[1].entity_columns_verified >= 5 &&
      records[1].charts >= 1 &&
      records[1].retention_evidence.some((e) => /repeat share/.test(e));
    const more = extra ? extra(records, rt) : [true, ''];
    return [
      ok && more[0],
      `the recipe's columns check out (${records[1].entity_columns.join('; ')}), the dashboard charts them (${records[1].charts}) and shows the repeat share (${records[1].retention_evidence.join('; ')})${more[1]}`,
    ];
  },
});

// The rows of a tab as Sheets reports them (a shown "" counts), and its keys.
const tabExtent = (rt, name) => {
  // The book's own handle, which sees the tabs chat made through the Sheets API too.
  const sheet = rt.f.book.sheets.find((tab) => tab.name === name);
  const keys = sheet
    .getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), 1)
    .getValues()
    .filter((row) => row[0] !== '').length;
  return { lastRow: sheet.getLastRow(), keys };
};

const CONVERSATIONS = [
  recipeConversation(
    'the prompt recipe: QUERY entity tab, columns to the last key, then a dashboard of ratios over counts',
    RECIPE,
    (records, rt) => {
      const { lastRow, keys } = tabExtent(rt, 'Customers');
      return [
        keys > 1 && lastRow === keys + 1,
        `; its columns end at the last key (last row ${lastRow}, ${keys} keys)`,
      ];
    }
  ),
  recipeConversation(
    'the earlier guarded recipe: columns over open ranges, guarded by the key, still check out',
    GUARDED
  ),
  {
    name: 'live entity tab over consistent generated data',
    steps: generate(CONSISTENT).concat([
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Customers', count: 200 }),
      () =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Customers',
          range: 'A1',
          formulas: [[ENTITY]],
        }),
      (b) =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Customers',
          range: 'I1:J1',
          editToken: editToken(b),
          formulas: [['Repeat rate', '=COUNTIF(B2:B,">1")/COUNTA(A2:A)']],
        }),
      () => say('The Customers tab has one row per customer with orders, revenue and a segment.'),
    ]),
    turns: [
      { n: 1, kind: 'generate', text: `generate ${N} orders` },
      { n: 2, kind: 'entity', text: 'segment the customers' },
    ],
    expect: [
      { completed: true, rows_written: N, derived_consistency: 1 },
      {
        entity_key: 'Customer',
        entity_tab: true,
        entity_tab_name: 'Customers',
        entity_formula_share: 1,
        entity_columns_verified: 5,
        segment_column: true,
        retention_measure: true,
      },
    ],
  },
  {
    name: 'a difference of two dates computed from them',
    steps: [
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Cases', count: N + 1 }),
      () =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Cases',
          range: 'A1',
          formulas: [
            [
              `=LET(n,${N},o,DATE(2026,1,1)+INT(RANDARRAY(n,1)*200),d,INT(RANDARRAY(n,1)*9),VSTACK({"Case","Owner","Opened","Closed","Days Open"},HSTACK("K-"&SEQUENCE(n),"P-"&(1+INT(RANDARRAY(n,1)*30)),o,o+d,d)))`,
            ],
          ],
        }),
      (b) =>
        call('edit_sheet', {
          action: 'copy_range',
          sheetName: 'Cases',
          range: 'A1',
          destination: 'A1',
          pasteType: 'values',
          editToken: editToken(b),
        }),
      () => say(`I created the Cases tab with ${N} cases.`),
    ],
    turns: [{ n: 1, kind: 'generate', text: `generate ${N} cases` }],
    expect: [{ completed: true, rows_written: N, derived_consistency: 1 }],
    check: (records) => [
      records[0].derived_checked.some((e) =>
        /^Days Open: 100% of rows \(Days Open = Closed - Opened\)/.test(e)
      ),
      `a difference of dates is found and holds (${records[0].derived_checked.join('; ')})`,
    ],
  },
  {
    // Where the quantity is 1, price = quantity x total holds too: the price is an input of the
    // total's rule, not a derived column that fails in the other rows.
    name: 'consistent totals where most quantities are 1',
    steps: generate(
      `=LET(n,${N},q,IF(RANDARRAY(n,1)<0.7,1,2+INT(RANDARRAY(n,1)*3)),p,ROUND(5+RANDARRAY(n,1)*20,2),VSTACK(${HEADER},HSTACK("O-"&SEQUENCE(n),DATE(2026,1,1)+INT(RANDARRAY(n,1)*200),"C-"&(100+INT(RANDARRAY(n,1)*40)),q,p,ROUND(q*p,2))))`
    ),
    turns: [{ n: 1, kind: 'generate', text: `generate ${N} orders` }],
    expect: [{ completed: true, rows_written: N, derived_consistency: 1 }],
  },
  {
    name: 'totals drawn again per cell',
    steps: generate(REDRAWN),
    turns: [{ n: 1, kind: 'generate', text: `generate ${N} orders` }],
    expect: [{ completed: true, rows_written: N }],
    check: (records) => [
      records[0].derived_consistency !== null && records[0].derived_consistency < 0.2,
      `a redrawn total matches quantity x price in few rows (${records[0].derived_consistency}; ${records[0].derived_checked.join('; ')})`,
    ],
  },
  {
    name: 'entity table pasted as values',
    seed,
    steps: [
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Per Customer', count: 20 }),
      () =>
        call('edit_sheet', {
          action: 'set_values',
          sheetName: 'Per Customer',
          range: `A1:C${pasted.length}`,
          values: pasted,
        }),
      () => say('Per Customer lists each customer.'),
    ],
    turns: [{ n: 2, kind: 'entity', text: 'per customer analysis' }],
    expect: [
      {
        entity_tab: true,
        entity_tab_name: 'Per Customer',
        entity_formula_share: 0,
        entity_columns_verified: 1,
        segment_column: false,
        retention_measure: false,
      },
    ],
  },
  {
    name: 'a repeat share as a live formula, and a share of rows that is not one',
    seed,
    steps: [
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Retention', count: 20 }),
      () =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Retention',
          range: 'A1:B2',
          formulas: [
            [
              'Repeat share',
              '=SUMPRODUCT(--(COUNTIF(Orders!C2:C,UNIQUE(FILTER(Orders!C2:C,Orders!C2:C<>"")))>1))/COUNTUNIQUE(Orders!C2:C)',
            ],
            ['Share of rows from top key', '=COUNTIF(Orders!C2:C,"K-1")/COUNTA(Orders!C2:C)'],
          ],
        }),
      () => say('Retention shows the repeat share.'),
    ],
    turns: [{ n: 2, kind: 'entity', text: 'how many customers come back?' }],
    expect: [{ entity_tab: false, retention_measure: true, retention_live: true }],
    check: (records) => [
      records[0].retention_evidence.length === 1 &&
        /Retention!1:2 0\.7273: repeat share/.test(records[0].retention_evidence[0]),
      `only the repeat share is a retention figure: ${records[0].retention_evidence.join('; ')}`,
    ],
  },
  {
    name: 'a count and a last date of the rows with one status check out as filtered aggregates',
    seed,
    steps: [
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Paid', count: 20 }),
      () =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Paid',
          range: 'A1',
          formulas: [
            [
              `=QUERY(Orders!A1:G84,"select C, count(A), max(B) where G = 'Paid' group by C label count(A) 'Paid Orders', max(B) 'Last Paid'",1)`,
            ],
          ],
        }),
      () => say('Paid lists paid orders per customer.'),
    ],
    turns: [{ n: 2, kind: 'entity', text: 'paid orders per customer' }],
    expect: [
      {
        entity_tab: true,
        entity_columns: [
          'Paid Orders: rows where Status = Paid',
          'Last Paid: max Order Date where Status = Paid',
        ],
        entity_columns_verified: 2,
      },
    ],
  },
  {
    name: 'a live label per key is no segment',
    seed,
    steps: [
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Keys', count: 20 }),
      () =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Keys',
          range: 'A1:B2',
          formulas: [
            ['=SORT(UNIQUE(FILTER(Orders!C2:C,Orders!C2:C<>"")))', 'Name'],
            ['', '=ARRAYFORMULA(IF(A1:A="",,"Name of "&A1:A))'],
          ],
        }),
      () => say('Keys lists each customer with a name.'),
    ],
    turns: [{ n: 2, kind: 'entity', text: 'list the customers' }],
    expect: [{ entity_tab: true, entity_tab_name: 'Keys', segment_column: false }],
  },
  {
    name: 'a top-5 table is no entity tab',
    seed,
    steps: [
      () => call('edit_sheet', { action: 'create_sheet', newName: 'Top', count: 20 }),
      () =>
        call('edit_sheet', {
          action: 'set_formulas',
          sheetName: 'Top',
          range: 'A1',
          formulas: [
            [
              '=SORTN(HSTACK(UNIQUE(Orders!C2:C81),COUNTIF(Orders!C2:C81,UNIQUE(Orders!C2:C81))),5,0,2,FALSE)',
            ],
          ],
        }),
      () => say('Top shows the five busiest customers.'),
    ],
    turns: [{ n: 2, kind: 'entity', text: 'top customers' }],
    expect: [{ entity_tab: false, segment_column: false }],
  },
];

// The evaluator on its own: values Sheets gives for the functions the measures rely on.
function evaluatorChecks() {
  const cells = new Map();
  const rows = [
    ['Key', 'Day', 'Amount'],
    ['a', new Date(Date.UTC(2026, 0, 5)), 10],
    ['b', new Date(Date.UTC(2026, 0, 9)), 4],
    ['a', new Date(Date.UTC(2026, 1, 1)), 6],
    ['c', new Date(Date.UTC(2026, 0, 2)), 1],
  ];
  rows.forEach((row, r) => row.forEach((v, c) => cells.set(`${r + 1}:${c + 1}`, { value: v })));
  const calc = createCalculator(() => ({ sheets: [{ id: 1, name: 'Data', cells }] }));
  const at = { sheet: 'Other', row: 1, column: 1 };
  const jan = (d) => new Date(Date.UTC(2026, 0, d)).getTime();
  const json = (v) => JSON.stringify(v);
  const day = (v) => (v instanceof Date ? v.getTime() : (v - 25569) * 86400000);
  return [
    [json(calc('=SORT(UNIQUE(FILTER(Data!A2:A,Data!A2:A<>"")))', at)), json([['a'], ['b'], ['c']])],
    [json(calc('=ARRAYFORMULA(COUNTIF(Data!A2:A,{"a";"b";"z"}))', at)), json([[2], [1], [0]])],
    [json(calc('=MAP({"a";"b"},LAMBDA(k,SUMIFS(Data!C2:C,Data!A2:A,k)))', at)), json([[16], [4]])],
    // MAXIFS does not expand over a criteria array: it reads its first value.
    [json(calc('=ARRAYFORMULA(MAXIFS(Data!C2:C,Data!A2:A,{"b";"a"}))', at)), json(4)],
    // A maximum of dates is that day (a date, or its serial number on the plain path).
    [day(calc('=MAXIFS(Data!B2:B,Data!A2:A,"b")', at)), jan(9)],
    [day(calc('=LET(d,MAXIFS(Data!B2:B,Data!A2:A,"b"),d)', at)), jan(9)],
    [calc('=MAX(Data!B2:B)-DATE(2026,1,25)', at), 7],
    // QUERY keeps the latest of dates a date, as Sheets does.
    [
      (() => {
        const v = calc('=QUERY(Data!A1:C5,"select A, max(B) group by A",1)', at)[1][1];
        return v instanceof Date && v.getTime();
      })(),
      Date.UTC(2026, 1, 1),
    ],
    [
      json(calc('=ARRAYFORMULA(IFS(Data!C2:C5>=6,"High",Data!C2:C5>1,"Mid",TRUE,"Low"))', at)),
      json([['High'], ['Mid'], ['High'], ['Low']]),
    ],
    [json(calc('=BYROW({1,2;3,4},LAMBDA(r,SUM(r)))', at)), json([[3], [7]])],
    // A range that ends where INDEX points (the range operator over a reference INDEX returns):
    // to the last key, on another tab or the formula's own, in either order, and past the
    // filled rows of a whole column.
    [
      json(calc('=ARRAYFORMULA(Data!C2:INDEX(Data!C:C,COUNTA(Data!A:A)))', at)),
      json([[10], [4], [6], [1]]),
    ],
    [
      json(calc('=ARRAYFORMULA(N(C2:INDEX(C:C,COUNTA(A:A))>5))', { ...at, sheet: 'Data' })),
      json([[1], [0], [1], [0]]),
    ],
    [
      json(calc('=ARRAYFORMULA(IF(INDEX(Data!A:A,3):Data!A2="a","yes","no"))', at)),
      json([['yes'], ['no']]),
    ],
    [json(calc('=ROWS(Data!C2:INDEX(Data!C:C,1))', at)), json(2)],
    [json(calc('=SUM(Data!C2:INDEX(Data!C:C,3))', at)), json(14)],
    [json(calc('=COUNTA(Data!C2:INDEX(Data!C:C,4,1))', at)), json(3)],
    // INDEX of one column with one index is that cell, not a row of it.
    [json(calc('=INDEX(Data!C:C,3)+1', at)), json(5)],
    [calc('="C-"&TEXT(7,"0000")', at), 'C-0007'],
    [calc('=TEXT(DATE(2026,3,9),"yyyy-mm")', at), '2026-03'],
    [json(calc('=AND({TRUE;FALSE})', at)), 'false'],
    [
      json(calc('=SORTN({"x",3;"y",9;"z",5},2,0,2,FALSE)', at)),
      json([
        ['y', 9],
        ['z', 5],
      ]),
    ],
  ];
}

export function runEntitySelfTest({ log = console.log } = {}) {
  let checks = 0,
    failures = 0;
  const check = (ok, text) => {
    checks++;
    if (!ok) failures++;
    log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  };
  evaluatorChecks().forEach(([got, want], i) =>
    check(got === want, `evaluator case ${i + 1}: ${got} (expected ${want})`)
  );
  for (const conv of CONVERSATIONS) {
    const rt = createBenchRuntime({
      provider: scripted(conv.steps),
      apiKey: 'self-test-key',
      timeLimit: 60,
    });
    const records = runConversation(rt, {
      id: 'selftest-entity',
      family: 'tab',
      rowsRequested: conv.seed ? 83 : N,
      nouns: ['orders', 'rows'],
      entity: /customer/i,
      seed: conv.seed || null,
      turns: conv.turns,
    });
    records.forEach((record, i) => {
      const bad = differences(record, conv.expect[i]);
      check(
        !bad.length,
        `entity: ${conv.name}, turn ${record.turn} (${record.kind}) consistency=${record.derived_consistency} tab=${record.entity_tab_name} live=${record.entity_formula_share} verified=${record.entity_columns_verified} [${(record.entity_columns || []).join('; ')}] segment=${record.segment_detail} retention=[${(record.retention_evidence || []).join('; ')}]${bad.length ? ' -- ' + bad.join('; ') + ' failed: ' + record.failed_step_sample.join(' | ') + ' errors: ' + record.error_sample.join(' | ') : ''}`
      );
    });
    if (conv.check) check(...conv.check(records, rt));
  }
  return { checks, failures };
}
