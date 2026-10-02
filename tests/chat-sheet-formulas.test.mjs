import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Analyst formulas for set_formulas (every Sheets built-in except the denied ones, other tabs,
// named ranges, arrays, spills and the read-back of results) and the read-only search_sheets
// tool. The sandbox answers spreadsheets.get like the Sheets API but does not evaluate formulas,
// so tests set the results Sheets would compute, and mark cells an array result filled (they
// carry a value but no entered value).

const DENIED = [
  'IMPORTRANGE',
  'IMPORTDATA',
  'IMPORTHTML',
  'IMPORTXML',
  'IMPORTFEED',
  'IMAGE',
  'GOOGLEFINANCE',
  'GOOGLETRANSLATE',
  'DETECTLANGUAGE',
  'INDIRECT',
  'AI',
];

const COLUMNS = [
  { key: 'date', label: 'Date', type: 'date', role: 'dimension', default: true },
  { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension', default: true },
  { key: 'spend', label: 'Spend', type: 'currency', role: 'metric', default: true },
  { key: 'clicks', label: 'Clicks', type: 'number', role: 'metric', default: true },
];

function fixture() {
  const f = createDatamoovSandbox({ gridData: true });
  f.sheet = f.book.sheets[0];
  f.work = f.book.insertSheet('Work');
  f.work.maxRows = 1000;
  f.data = f.book.insertSheet('Campaign Data');
  f.book.insertSheet('Targets');
  f.book.insertSheet("Q1 '25");
  f.book.insertSheet('Δεδομένα');
  f.book.server.namedRanges = [
    {
      namedRangeId: 'n1',
      name: 'TargetCPA',
      range: { sheetId: f.sheet.id, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
    },
    {
      namedRangeId: 'n2',
      name: 'Regions',
      range: { sheetId: f.sheet.id, startRowIndex: 0, endRowIndex: 9, startColumnIndex: 1, endColumnIndex: 2 },
    },
  ];
  // Cells an array result filled: "sheetId:row:column", 1-based like setCell.
  f.spilled = new Set();
  const sheets = f.api.Sheets.Spreadsheets,
    get = sheets.get,
    batch = sheets.batchUpdate;
  sheets.get = (id, options) => {
    const result = get(id, options);
    for (const sheet of result.sheets || [])
      for (const block of sheet.data || [])
        (block.rowData || []).forEach((row, r) =>
          (row.values || []).forEach((cell, c) => {
            const key = `${sheet.properties?.sheetId}:${(block.startRow || 0) + r + 1}:${(block.startColumn || 0) + c + 1}`;
            if (f.spilled.has(key)) delete cell.userEnteredValue;
          })
        );
    return result;
  };
  // What Sheets computes once a batch is in: set by each test.
  f.compute = null;
  sheets.batchUpdate = (body, id) => {
    const result = batch(body, id);
    if (f.compute) f.compute();
    return result;
  };
  f.spill = (sheet, row, column, value) => {
    f.setCell(sheet, row, column, value);
    f.spilled.add(`${sheet.id}:${row}:${column}`);
  };
  f.session = f.api.dmvChatSession_(f.book);
  f.check = (formula, options = {}) =>
    plain(
      f.api.dmvChatSheetFormulaCheck_(f.session, formula, {
        sheet: f.work,
        cell: 'B2',
        cache: {},
        ...options,
      })
    );
  f.inspect = (range, sheetName = 'Work') =>
    plain(f.api.dmvChatInspectSheet_(f.session, { sheetName, range }));
  f.edit = (formulas, range, sheetName = 'Work') => {
    const inspected = f.inspect(range, sheetName);
    return plain(
      f.api.dmvChatEditSheet_(f.session, {
        action: 'set_formulas',
        sheetName,
        range,
        editToken: inspected.editToken,
        formulas,
      })
    );
  };
  f.search = (input) => plain(f.api.dmvChatSearchSheets_(f.session, input));
  return f;
}

const a1 = (row, column) => String.fromCharCode(64 + column) + row;

// Realistic analyst formulas, all accepted as written.
const CORPUS = [
  "=VLOOKUP(A2,'Campaign Data'!A:F,3,FALSE)",
  '=XLOOKUP(A2,\'Campaign Data\'!A:A,\'Campaign Data\'!D:D,"not found")',
  "=INDEX('Campaign Data'!D:D,MATCH(A2,'Campaign Data'!A:A,0))",
  '=IFERROR(INDEX(Targets!B:B,MATCH(A2&"|"&B2,Targets!A:A&"|"&Targets!C:C,0)),"")',
  '=SUMIFS(\'Campaign Data\'!D:D,\'Campaign Data\'!B:B,B2,\'Campaign Data\'!A:A,">="&DATE(2026,9,1))',
  '=COUNTIFS(\'Campaign Data\'!B2:B,"Brand*",\'Campaign Data\'!E2:E,">0")',
  "=AVERAGEIFS('Campaign Data'!D2:D,'Campaign Data'!B2:B,B2)",
  '=QUERY(\'Campaign Data\'!A1:F,"select B, sum(D) where A >= date \'2026-09-01\' and C <> \'IMPORTRANGE\' group by B order by sum(D) desc label sum(D) \'Spend\'",1)',
  '=QUERY(A1:C,"select * where B contains \'IMAGE(\' and C = \'INDIRECT(""A1"")\'")',
  '=FILTER(\'Campaign Data\'!A2:F,\'Campaign Data\'!D2:D>100,\'Campaign Data\'!B2:B<>"")',
  "=SORT(UNIQUE('Campaign Data'!B2:B))",
  "=SORTN('Campaign Data'!B2:D,10,0,3,FALSE)",
  '=ARRAYFORMULA(IF(A2:A="","",B2:B/C2:C))',
  '=LET(spend,SUM(\'Campaign Data\'!D:D),conv,SUM(\'Campaign Data\'!E:E),IF(conv=0,"",spend/conv))',
  '=LET(cpa,LAMBDA(s,c,IF(c=0,"",s/c)),cpa(SUM(D2:D100),SUM(E2:E100)))',
  '=MAP(B2:B10,C2:C10,LAMBDA(spend,clicks,IFERROR(spend/clicks,0)))',
  '=BYROW(B2:D10,LAMBDA(row,SUM(row)))',
  '=BYCOL(B2:D10,LAMBDA(col,MAX(col)))',
  '=REDUCE(0,B2:B10,LAMBDA(total,value,total+value))',
  '=SCAN(0,B2:B10,LAMBDA(running,value,running+value))',
  '=MAKEARRAY(3,4,LAMBDA(r,c,r*c))',
  "=CHOOSECOLS('Campaign Data'!A2:F,1,4)",
  '=CHOOSEROWS(A2:F100,1,2,3)',
  '=HSTACK(UNIQUE(B2:B20),COUNTIF(B2:B20,UNIQUE(B2:B20)))',
  '=VSTACK({"Campaign","Spend"},QUERY(\'Campaign Data\'!B2:D,"select B, sum(D) group by B",0))',
  '=TOCOL(B2:D10,1)',
  '=WRAPROWS(TOCOL(A2:A50,1),5)',
  '=TOROW(UNIQUE(B2:B20))',
  '=REGEXEXTRACT(A2,"utm_campaign=([^&]+)")',
  '=REGEXMATCH(LOWER(A2),"^(brand|generic)")',
  '=REGEXREPLACE(A2,"\\s+"," ")',
  '=IFS(F2>=2,"Scale",F2>=1,"Hold",F2>0,"Cut",TRUE,"No data")',
  '=IF(AND(D2>0,E2>0),ROUND(D2/E2,2),IF(D2>0,"No conversions",""))',
  "=SUMPRODUCT(('Campaign Data'!B2:B100=B2)*('Campaign Data'!D2:D100))",
  '={"Total",SUM(B2:B10);"Average",AVERAGE(B2:B10)}',
  '={1,2,3;4,5,6}',
  '=SUM(TargetCPA)*1.1',
  '=COUNTIF(Regions,A2)>0',
  '=TEXT(EOMONTH(TODAY(),-1),"yyyy-mm")',
  '=DATEDIF(A2,TODAY(),"D")',
  '=NETWORKDAYS(DATE(2026,9,1),EOMONTH(DATE(2026,9,1),0))',
  '=SPLIT(A2,",")',
  '=TEXTJOIN(", ",TRUE,UNIQUE(FILTER(B2:B,D2:D>0)))',
  '=XMATCH(MAX(D2:D20),D2:D20)',
  '=PERCENTRANK.INC($D$2:$D$20,D2)',
  '=HYPERLINK("https://ads.google.com/aw/campaigns","Open Google Ads")',
  "=SUM('Q1 ''25'!B:B)",
  '=AVERAGE(Δεδομένα!A1:A10)',
  "=sum(a1:a3) + vlookup(a1, 'campaign data'!a:b, 2, false)",
  "=IFERROR(\n  VLOOKUP(A2, 'Campaign Data'!A:F, 4, FALSE),\n  0\n)",
  '=ARRAYFORMULA(IFERROR(VLOOKUP(A2:A,Targets!A:B,2,FALSE),""))',
  '=SEQUENCE(12,1,DATE(2026,1,1),31)',
  '=LAMBDA(x,x*2)(A2)',
  '=STDEV.S(B2:B100)',
  '=OFFSET(A1,0,0,COUNTA(A:A),1)',
  '=SPARKLINE(B2:M2,{"charttype","column"})',
  '=SUM(2:2)-SUM($A$1:$B$2)',
  '=CONCAT("IMPORTRANGE(", "is just text")',
  '=IF(ISNA(#N/A),-A2%,+A2^2&"x")',
  '=SUM(IF(A1:A3>0,1,0),,3)',
  '=SHEETS()',
  "=SHEET('Campaign Data'!A1)",
];

test('a corpus of analyst formulas is accepted and written exactly as given', () => {
  const f = fixture();
  assert.ok(CORPUS.length >= 40);
  CORPUS.forEach((formula, index) => {
    // Each in its own cell, with room below and to the right for its result.
    const row = 1 + index * 14;
    const result = f.edit([[formula]], 'B' + row);
    assert.equal(result.ok, true, formula);
    assert.equal(f.formula(f.work, row, 2), formula, formula);
    assert.deepEqual(f.state.batches.at(-1).body, {
      requests: [
        {
          updateCells: {
            range: { sheetId: f.work.id, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 1, endColumnIndex: 2 },
            rows: [{ values: [{ userEnteredValue: { formulaValue: formula } }] }],
            fields: 'userEnteredValue',
          },
        },
      ],
    });
  });
  assert.equal(f.state.batches.length, CORPUS.length);
  // What the check reports for a few of them.
  assert.deepEqual(f.check(CORPUS[0]), {
    shape: { rows: 1, columns: 1 },
    functions: ['VLOOKUP'],
    names: [],
    tabs: ['Campaign Data'],
  });
  assert.deepEqual(f.check(CORPUS[14]).functions, ['LET', 'LAMBDA', 'IF', 'SUM']);
  assert.deepEqual(f.check('=SUM(TargetCPA)*1.1').names, ['TARGETCPA']);
  assert.deepEqual(f.check('={1,2,3;4,5,6}').shape, { rows: 2, columns: 3 });
  assert.deepEqual(f.check('=MAKEARRAY(3,4,LAMBDA(r,c,r*c))').shape, { rows: 3, columns: 4 });
  assert.deepEqual(f.check('=ARRAYFORMULA(IF(A2:A10="","",B2:B10*2))').shape, { rows: 9, columns: 1 });
  assert.deepEqual(f.check('=TRANSPOSE(A1:C2)').shape, { rows: 3, columns: 2 });
  assert.equal(f.check('=FILTER(A1:A10,A1:A10>0)').shape, null);
  // Up to 8,000 characters.
  const long = '=' + 'A1+'.repeat(2665) + '1234';
  assert.equal(long.length, 8000);
  assert.deepEqual(f.check(long).shape, { rows: 1, columns: 1 });
  assert.throws(() => f.check(long + '5'), /^Error: B2: a formula can be at most 8000 characters\.$/);
});

test('every denied function is refused in every disguise, by name, and nothing is written', () => {
  const f = fixture();
  for (const name of DENIED) {
    const mixed = name.charAt(0) + name.slice(1).toLowerCase();
    const disguises = [
      `=${name}("x")`,
      `=${name.toLowerCase()}("x")`,
      `=${mixed}("x")`,
      `=${name} ("x")`,
      `=${name}\n("x")`,
      `=IF(TRUE,${name}("x"),0)`,
      `=SUM(1,IFERROR(${name}("x"),0))`,
      `=LET(v,${name}("x"),v)`,
      `=LET(v,1,${name}(v))`,
      `=LAMBDA(x,${name}(x))("a")`,
      `=MAP(A1:A3,LAMBDA(c,${name}(c)))`,
      `=LET(${name},LAMBDA(x,x),1)`,
      `=LAMBDA(${name},1)(2)`,
      `=${name}`,
      `=SUM(${name})`,
      `={1,${name}("x")}`,
      `=-${name}("x")`,
      `=QUERY(A1:B3,"select A where B = '${name}'")&${name}("x")`,
      `="${name}("&${name}("x")`,
      `=ARRAYFORMULA(${name}(A1:A3))`,
      `=${name}[Column]`,
    ];
    for (const formula of disguises)
      assert.throws(
        () => f.check(formula),
        new RegExp(`^Error: B2: ${name} is not allowed in chat formulas: .*Chat formulas stay inside this spreadsheet`),
        formula
      );
    // Inside a string literal it is only text.
    assert.equal(f.check(`=CONCAT("${name}(", "a")`).shape.rows, 1);
    f.check(`=QUERY(A1:B3,"select A where B = '${name}(x)'")`);
  }
  // Through edit_sheet: refused before anything is sent, even beside accepted formulas.
  for (const formula of ['=IMPORTRANGE("abc","A1")', '=sum(1,indirect ("A1"))', '=LET(f,LAMBDA(u,IMAGE(u)),f("https://x.test/a.png"))'])
    assert.throws(() => f.edit([['=1', formula]], 'B1:C1'), /is not allowed in chat formulas/, formula);
  assert.equal(f.state.batches.length, 0);
  assert.equal(f.formula(f.work, 1, 2), '');
  // HYPERLINK takes a literal https address only.
  for (const formula of [
    '=HYPERLINK("http://example.com","x")',
    '=HYPERLINK("javascript:alert(1)")',
    '=HYPERLINK(A1,"x")',
    '=HYPERLINK("https://"&A1)',
    '=HYPERLINK()',
  ])
    assert.throws(() => f.check(formula), /HYPERLINK takes a literal https:\/\/ address/, formula);
});

test('unknown functions, names and tabs are refused by name; custom and named functions too', () => {
  const f = fixture();
  for (const [formula, name] of [
    ['=MYFUNCTION(A1)', 'MYFUNCTION'],
    ['=myCustom_fn(A1:A3)', 'myCustom_fn'],
    // A named function (Data > Named functions), whatever it wraps.
    ['=CLEANDATA(A1)', 'CLEANDATA'],
    ['=SUM(A1,FETCHPRICE(2))', 'FETCHPRICE'],
    ['=WEBSERVICE("https://example.com")', 'WEBSERVICE'],
    ['=FILTERXML(A1,"//a")', 'FILTERXML'],
    ['=__xludf.DUMMYFUNCTION("IMPORTRANGE(""x"")")', '__xludf.DUMMYFUNCTION'],
    ['=_xlfn.IMPORTRANGE("a","b")', '_xlfn.IMPORTRANGE'],
    ['=ＳＵＭ(A1)', 'ＳＵＭ'],
    // A LET name is not visible outside its LET.
    ['=LET(f,LAMBDA(x,x),1)+f(2)', 'f'],
  ])
    assert.throws(
      () => f.check(formula),
      (error) =>
        error.message.startsWith(`B2: unknown function ${name}. Chat formulas use Google Sheets built-in functions only`),
      formula
    );
  assert.throws(
    () => f.check('=Nope*2'),
    /^Error: B2: unknown name NOPE: it is not a function call, a LET or LAMBDA name, or a named range of this spreadsheet \(named ranges: TargetCPA, Regions\)\. Put text in double quotes\.$/
  );
  assert.throws(() => f.check('=LET(x,1,y)'), /unknown name Y/);
  assert.throws(() => f.check('=Missing!A1'), /^Error: B2: No tab named "Missing"\. Tabs: .*Use list_sheets first \(at character 2, near "Missing!A1"\)\.$/);
  assert.throws(() => f.check("='Old tab'!A1:B2"), /No tab named "Old tab"/);
  // Malformed formulas say where.
  for (const [formula, message] of [
    ['SUM(A1)', /must be text beginning with =/],
    [' =1', /must be text beginning with =/],
    ['=', /the formula is empty/],
    ['=SUM(1', /a function call is not closed/],
    ['=1+', /the formula ends early/],
    ['=A1 B1', /unexpected "B1" \(at character 5/],
    ['="open', /missing its closing quote/],
    ['={}', /an array literal needs at least one value/],
    ['=1;2', /unexpected ";"/],
    ['=#BOGUS!', /is not a Sheets error value/],
    ['=A1@B1', /"@" is not something Sheets formulas use/],
    ['=LET(1,2,3)', /LET needs names and values/],
    ['=LET(TRUE,1,2)', /TRUE cannot be a name/],
    ['=' + '('.repeat(101) + '1' + ')'.repeat(101), /nested too deeply/],
    ['=ZZZZ1', /unknown name ZZZZ1/],
  ])
    assert.throws(() => f.check(formula), message, formula);
  f.check('=' + '('.repeat(99) + '1' + ')'.repeat(99));
  // Conditional-format rules refuse other tabs (the helper other analyst tools use).
  assert.throws(
    () => f.check('=$D2>Targets!B1', { otherTabs: false }),
    /this formula can refer only to cells of its own tab \("Work"\)/
  );
  assert.deepEqual(f.check('=AND($D2>50,COUNTIF($A:$A,$A2)>1)', { otherTabs: false }).functions, [
    'AND',
    'COUNTIF',
  ]);
  f.check("=Work!$D2>50", { otherTabs: false });
  assert.throws(() => f.check('=IMAGE("x")', { otherTabs: false }), /IMAGE is not allowed/);
  assert.equal(f.state.batches.length, 0);
});

test('an array result is checked for room before writing and its cells are kept for undo', () => {
  const f = fixture();
  f.setCell(f.work, 4, 2, 'keep');
  assert.throws(
    () => f.edit([['=SEQUENCE(5)']], 'B2'),
    /^Error: B2: the result fills B2:B6, but 1 cell there holds data \(B4\)\. Sheets would show #REF! instead of overwriting it\./
  );
  f.setCell(f.work, 2, 4, 'x');
  f.setCell(f.work, 3, 3, 'y');
  assert.throws(
    () => f.edit([['={1,2,3;4,5,6}']], 'B2'),
    /the result fills B2:D3, but 2 cells there hold data \(D2, C3\)/
  );
  assert.throws(
    () => f.edit([['={1,2,3}']], 'Y1'),
    /^Error: Y1: the result fills 1 rows × 3 columns from Y1, past the end of the tab \(1000 rows × 26 columns\)\./
  );
  assert.throws(
    () => f.edit([['=SEQUENCE(3)'], ['=1']], 'F1:F2'),
    /^Error: F1: the result fills F1:F3, which overlaps other cells this edit writes\./
  );
  assert.throws(() => f.edit([["=TRANSPOSE('Campaign Data'!A1:A3)", '=1']], 'E1:F1'), /fills E1:G1/);
  assert.equal(f.state.batches.length, 0);
  // Room below: written, and undo restores the cells the result filled as they were.
  f.setMeta(f.work, 12, 7, { note: 'kept note' });
  const result = f.edit([['=SEQUENCE(3,2)']], 'F10');
  assert.equal(result.ok, true);
  assert.deepEqual(result.spills, [
    { cell: 'F10', range: 'F10:G12', rows: 3, columns: 2, sample_rows: [['=SEQUENCE(3,2)', null], [null, null], [null, null]] },
  ]);
  f.compute = null;
  const undone = plain(f.api.dmvChatUndoSheetEdit_(f.session, { action: 'undo' }));
  assert.equal(undone.ok, true);
  assert.equal(f.formula(f.work, 10, 6), '');
  assert.deepEqual(f.meta(f.work, 12, 7), { note: 'kept note' });
  // A result of unknown size is left to Sheets, which never spills over data.
  assert.equal(f.edit([['=FILTER(A1:A10,A1:A10>0)']], 'B3').ok, true);
});

test('an array result may not spill onto report output', () => {
  const f = fixture();
  f.api.dmvRegisterConnector_({
    id: 'orchard',
    label: 'Orchard Ads',
    description: 'Arbitrary test source',
    category: 'Test',
    allowedHosts: ['orchard.example'],
    authFields: [{ key: 'token', label: 'Token', type: 'password', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily campaigns',
        fields: COLUMNS,
        dateRange: true,
        configFields: [],
        fetch: () => ({
          columns: COLUMNS,
          rows: [{ date: null, campaign: null, spend: 10.5, clicks: 100 }],
          metadata: { complete: true },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'orchard', label: 'Orchard main', credentials: { token: 't' } });
  const report = f.api.dmvSaveReport({
    connectionId: connection.id,
    name: 'Daily',
    reportType: 'daily',
    fields: ['date', 'campaign', 'spend', 'clicks'],
    config: {},
    maxRows: 100,
    dateRange: { preset: 'lastMonth' },
    target: { sheetName: 'Work', startCell: 'C3' },
    schedule: 'manual',
  });
  f.api.dmvRunReport(report.id);
  assert.equal(f.value(f.work, 3, 3), 'Date');
  assert.equal(f.value(f.work, 4, 3), '');
  // A4:D4 is empty apart from the report's blank date and campaign cells.
  assert.throws(() => f.edit([['={1,2,3,4}']], 'A4'), /output of the saved report "Daily"/);
  assert.equal(f.formula(f.work, 4, 1), '');
  // Reading the report's cells is fine.
  assert.equal(f.edit([['=SUM(E4:E10)']], 'A6').ok, true);
});

test('after writing, errors come back with the cell and Sheets message, with a sample of results', () => {
  const f = fixture();
  f.compute = () => {
    f.setError(f.work, 2, 2, { type: 'N_A', message: "Did not find value 'x' in VLOOKUP evaluation." }, '=VLOOKUP("x",A1:B3,2,FALSE)');
    f.setError(f.work, 3, 2, { type: 'DIVIDE_BY_ZERO', message: 'Function DIVIDE parameter 2 cannot be zero.' }, '=1/0');
    f.setCell(f.work, 4, 2, 6, '=SUM(A1:A3)');
    f.setError(f.work, 5, 2, { type: 'NAME', message: 'Unknown range name: TargetCPA2.' }, '=SUM(TargetCPA)');
  };
  const result = f.edit([['=VLOOKUP("x",A1:B3,2,FALSE)'], ['=1/0'], ['=SUM(A1:A3)'], ['=SUM(TargetCPA)']], 'B2:B5');
  assert.equal(result.ok, true);
  assert.match(result.undoId, /^u[a-f0-9]{12}$/);
  assert.equal(result.errorCount, 3);
  assert.deepEqual(result.formulaErrors, [
    { cell: 'Work!B2', error: '#N/A', message: "Did not find value 'x' in VLOOKUP evaluation." },
    { cell: 'Work!B3', error: '#DIV/0!', message: 'Function DIVIDE parameter 2 cannot be zero.' },
    { cell: 'Work!B5', error: '#NAME?', message: 'Unknown range name: TargetCPA2.' },
  ]);
  assert.deepEqual(result.results, [
    { cell: 'B2', value: '#N/A' },
    { cell: 'B3', value: '#DIV/0!' },
    { cell: 'B4', value: 6 },
    { cell: 'B5', value: '#NAME?' },
  ]);
  assert.match(result.next, /Nothing was rolled back.*undo_sheet_edit/);
  // The edit stands; undo is offered.
  assert.equal(f.formula(f.work, 4, 2), '=SUM(A1:A3)');
  f.compute = null;
  assert.equal(plain(f.api.dmvChatUndoSheetEdit_(f.session, { action: 'undo' })).ok, true);
  assert.equal(f.formula(f.work, 4, 2), '');
});

test('errors inside an array result and where a result of unknown size spilled are reported', () => {
  const f = fixture();
  // An exact result: its cells were read back with the range.
  f.compute = () => {
    f.setCell(f.work, 2, 2, 1, '=ARRAYFORMULA(1/A2:A4)');
    f.setError(f.work, 3, 2, { type: 'DIVIDE_BY_ZERO', message: 'Function DIVIDE parameter 2 cannot be zero.' });
    f.spilled.add(`${f.work.id}:3:2`);
    f.spill(f.work, 4, 2, 0.5);
  };
  let result = f.edit([['=ARRAYFORMULA(1/A2:A4)']], 'B2');
  assert.deepEqual(result.formulaErrors, [
    { cell: 'Work!B3', error: '#DIV/0!', message: 'Function DIVIDE parameter 2 cannot be zero.' },
  ]);
  assert.deepEqual(result.spills, [{ cell: 'B2', range: 'B2:B4', rows: 3, columns: 1, sample_rows: [[1], ['#DIV/0!'], [0.5]] }]);
  // A result of unknown size: the cells below and right of the range are read once.
  const gets = f.state.gets.length;
  f.compute = () => {
    f.setCell(f.work, 10, 4, 'Brand', '=QUERY(\'Campaign Data\'!A:B,"select A, B")');
    f.spill(f.work, 10, 5, 30.5);
    f.spill(f.work, 11, 4, 'Generic');
    f.spill(f.work, 11, 5, 5);
    f.spill(f.work, 12, 4, 'Video');
    f.setError(f.work, 12, 5, { type: 'VALUE', message: 'Expected a number.' });
    f.spilled.add(`${f.work.id}:12:5`);
  };
  result = f.edit([['=QUERY(\'Campaign Data\'!A:B,"select A, B")']], 'D10');
  assert.deepEqual(result.spills, [
    {
      cell: 'D10',
      range: 'D10:E12',
      rows: 3,
      columns: 2,
      sample_rows: [['Brand', 30.5], ['Generic', 5], ['Video', '#VALUE!']],
    },
  ]);
  assert.deepEqual(result.formulaErrors, [{ cell: 'Work!E12', error: '#VALUE!', message: 'Expected a number.' }]);
  const window = f.state.gets.slice(gets).map((entry) => entry.options.ranges).filter(Boolean).at(-1);
  assert.deepEqual(window, ["'Work'!D10:L30"]);
  // Sheets refuses to spill over data and says where.
  f.compute = () =>
    f.setError(f.work, 20, 8, { type: 'REF', message: 'Array result was not expanded because it would overwrite data in H22.' }, '=UNIQUE(A1:A5)');
  result = f.edit([['=UNIQUE(A1:A5)']], 'H20');
  assert.deepEqual(result.formulaErrors, [
    { cell: 'Work!H20', error: '#REF!', message: 'Array result was not expanded because it would overwrite data in H22.' },
  ]);
  // Still calculating is not an error.
  f.compute = () => f.setError(f.work, 30, 2, { type: 'LOADING', message: 'Loading data...' }, '=SUM(A:A)');
  result = f.edit([['=SUM(A:A)']], 'B30');
  assert.deepEqual(result.stillLoading, ['Work!B30']);
  assert.equal(result.formulaErrors, undefined);
  // A scalar result needs no window read.
  const before = f.state.gets.length;
  f.compute = null;
  f.edit([['=SUM(A1:A3)']], 'B40');
  assert.equal(
    f.state.gets.slice(before).filter((entry) => /!B40:/.test(String(entry.options.ranges))).length,
    0
  );
});

test('search_sheets finds values and formulas across tabs, read-only, with caps and totals', () => {
  const f = fixture();
  f.fill = (sheet, rows) => rows.forEach((row, r) => row.forEach((value, c) => value !== null && f.setCell(sheet, r + 1, c + 1, value)));
  f.fill(f.data, [
    ['Date', 'Campaign', 'Spend'],
    ['2026-09-01', 'Brand Search', 1234.5],
    ['2026-09-02', 'Generic', 50],
    ['2026-09-03', 'brand video', 12],
  ]);
  f.fill(f.sheet, [['Campaign', 'Spend'], ['Brand Search', 99]]);
  f.setCell(f.sheet, 2, 3, 99, "=VLOOKUP(A2,'Campaign Data'!B:C,2,FALSE)");
  const hidden = f.book.insertSheet('Archive');
  hidden.hidden = true;
  f.setCell(hidden, 1, 1, 'Brand old');
  const batches = f.state.batches.length;

  let result = f.search({ query: 'brand' });
  assert.equal(result.total, 3);
  assert.deepEqual(result.matches, [
    { cell: 'Output!A2', value: 'Brand Search' },
    { cell: 'Campaign Data!B2', value: 'Brand Search' },
    { cell: 'Campaign Data!B4', value: 'brand video' },
  ]);
  assert.deepEqual(result.byTab, { Output: 1, 'Campaign Data': 2 });
  assert.ok(!result.searchedTabs.includes('Archive'));
  assert.equal(f.state.batches.length, batches, 'search never writes');
  const event = f.session.events.at(-1);
  assert.equal(event.kind, 'summary');
  assert.match(event.text, /^Searched \d tabs for "brand": 3 matches$/);
  assert.deepEqual(plain(event.links.map((link) => link.label)), ['Output', 'Campaign Data']);
  assert.match(event.links[0].url, /#gid=\d+&range=A2$/);

  assert.equal(f.search({ query: 'brand', matchCase: true }).total, 1);
  assert.equal(f.search({ query: 'Brand', matchCase: true }).total, 2);
  assert.equal(f.search({ query: 'brand search', wholeCell: true }).total, 2);
  assert.equal(f.search({ query: 'brand', wholeCell: true }).total, 0);
  assert.deepEqual(
    f.search({ query: '^brand\\s\\w+$', regex: true }).matches.map((match) => match.cell),
    ['Output!A2', 'Campaign Data!B2', 'Campaign Data!B4']
  );
  // Numbers match by value as well as by what the cell shows.
  assert.deepEqual(f.search({ query: '1234.50' }).matches, [{ cell: 'Campaign Data!C2', value: '1234.5' }]);
  // Formulas: the formula text, with the formula in each match.
  result = f.search({ query: 'vlookup', lookIn: 'formulas' });
  assert.deepEqual(result.matches, [
    { cell: 'Output!C2', value: '99', formula: "=VLOOKUP(A2,'Campaign Data'!B:C,2,FALSE)" },
  ]);
  assert.equal(f.search({ query: 'vlookup' }).total, 0);
  // Chosen tabs, a hidden one included when named, and a range within one tab.
  assert.equal(f.search({ query: 'brand', sheetNames: ['Archive'] }).total, 1);
  assert.equal(f.search({ query: 'brand', sheetName: 'Campaign Data', range: 'B3:C' }).total, 1);
  assert.equal(f.search({ query: 'brand', sheetName: 'Campaign Data', range: 'A:A' }).total, 0);
  // At most limit matches, and the total.
  result = f.search({ query: 'a', limit: 2 });
  assert.equal(result.returned, 2);
  assert.ok(result.total > 2);
  assert.match(result.note, /Only the first 2 matches/);
  // The cell cap stops before a tab that would pass it, and says so.
  f.api.DMV_SHEET_SEARCH.maxCells = 12;
  result = f.search({ query: 'brand', sheetNames: ['Campaign Data', 'Output'] });
  assert.deepEqual(result.searchedTabs, ['Campaign Data']);
  assert.deepEqual(result.skippedTabs, ['Output']);
  assert.match(result.incomplete, /Stopped at 12 cells/);
  f.api.DMV_SHEET_SEARCH.maxCells = 5;
  assert.throws(
    () => f.search({ query: 'brand', sheetName: 'Campaign Data' }),
    /^Error: Tab "Campaign Data" has 12 cells to scan; one search reads at most 5\. Narrow the search with sheetName and a range\.$/
  );
  f.api.DMV_SHEET_SEARCH.maxCells = 200000;
  for (const [input, message] of [
    [{ query: '' }, /query must be text of 1 to 200 characters/],
    [{ query: 'x'.repeat(201) }, /query must be text/],
    [{ query: '(a', regex: true }, /The regular expression is not valid/],
    [{ query: '(a+)+$', regex: true }, /Avoid repeating a group that itself repeats/],
    [{ query: '(\\w*,)*x', regex: true }, /Avoid repeating a group/],
    [{ query: 'a', range: 'A1:B2' }, /A range needs exactly one tab/],
    [{ query: 'a', sheetName: 'Output', range: 'A1:ZZ99999' }, /outside the tab "Output"/],
    [{ query: 'a', sheetName: 'Output', range: 'B5:A1' }, /must end after it starts/],
    [{ query: 'a', limit: 201 }, /limit/],
    [{ query: 'a', sheetName: 'Nope' }, /No tab named "Nope"/],
    [{ query: 'a', sheetName: 'Output', sheetNames: ['Output'] }, /not both/],
    [{ query: 'a', lookIn: 'notes' }, /Choose lookIn values or formulas/],
    [{ query: 'a', columns: [1] }, /belong to mode duplicates/],
    [{ query: 'a', requests: [] }, /Use only the documented fields/],
    [{ mode: 'replace', query: 'a' }, /Choose mode find or duplicates/],
  ])
    assert.throws(() => f.search(input), message, JSON.stringify(input));
  assert.equal(f.state.batches.length, batches);
});

test('search_sheets reports duplicate rows by key columns without changing anything', () => {
  const f = fixture();
  [
    ['Email', 'Name', 'Spend'],
    ['a@x.com', 'Ann', 10],
    ['A@X.com', 'Ann B', 10],
    [' b@x.com ', 'Bob', 5],
    ['b@x.com', 'Bob', 5],
    ['c@x.com', 'Cy', 1],
    [null, null, null],
    ['a@x.com', 'Ann', 10],
  ].forEach((row, r) => row.forEach((value, c) => value !== null && f.setCell(f.sheet, r + 1, c + 1, value)));
  const batches = f.state.batches.length;
  let result = f.search({ mode: 'duplicates', sheetName: 'Output', columns: [1] });
  assert.deepEqual(result, {
    sheetName: 'Output',
    range: 'A1:C8',
    url: result.url,
    keyColumns: ['Email'],
    rowsChecked: 7,
    blankRowsSkipped: 1,
    duplicateGroups: 2,
    duplicateRows: 3,
    compared: 'ignoring case and surrounding spaces',
    groups: [
      { values: ['a@x.com'], count: 3, rows: [2, 3, 8] },
      { values: [' b@x.com '], count: 2, rows: [4, 5] },
    ],
  });
  assert.match(result.url, /#gid=\d+&range=A1%3AC8$/);
  // Exact text: case counts, surrounding spaces still do not.
  result = f.search({ mode: 'duplicates', sheetName: 'Output', columns: [1], matchCase: true });
  assert.deepEqual(result.groups.map((group) => [group.values[0], group.count]), [
    ['a@x.com', 2],
    [' b@x.com ', 2],
  ]);
  // Every column is the key by default: only the exact repeats remain.
  result = f.search({ mode: 'duplicates', sheetName: 'Output' });
  assert.deepEqual(result.keyColumns, ['Email', 'Name', 'Spend']);
  assert.deepEqual(result.groups.map((group) => group.rows), [[2, 8], [4, 5]]);
  // A range without a header, and a limit on the groups listed.
  result = f.search({ mode: 'duplicates', sheetName: 'Output', range: 'B2:B8', headerRows: 0, limit: 1 });
  assert.deepEqual(result.keyColumns, ['B']);
  assert.deepEqual(result.groups, [{ values: ['Ann'], count: 2, rows: [2, 8] }]);
  assert.equal(result.duplicateGroups, 2);
  assert.match(result.note, /Only the 1 largest groups/);
  assert.match(f.session.events.at(-1).text, /^Found 2 duplicate groups in Output!B2:B8$/);
  for (const [input, message] of [
    [{ mode: 'duplicates' }, /duplicates checks one tab/],
    [{ mode: 'duplicates', sheetNames: ['Output', 'Work'] }, /duplicates checks one tab/],
    [{ mode: 'duplicates', sheetName: 'Output', columns: [4] }, /Key column/],
    [{ mode: 'duplicates', sheetName: 'Output', columns: [1, 1] }, /List each key column once/],
    [{ mode: 'duplicates', sheetName: 'Output', query: 'a' }, /query belongs to mode find/],
    [{ mode: 'duplicates', sheetName: 'Output', range: 'A1:C1' }, /at least one row below its header/],
  ])
    assert.throws(() => f.search(input), message, JSON.stringify(input));
  assert.equal(f.state.batches.length, batches);
});

test('search_sheets joins the chat tools with its progress label and a plain schema', () => {
  const f = fixture();
  const tools = f.api.dmvChatTools_(f.session);
  const search = tools.find((tool) => tool.name === 'search_sheets');
  assert.ok(search);
  assert.equal(f.api.dmvChatSheetToolLabel_('search_sheets'), 'Searching the spreadsheet');
  const schema = plain(search.input_schema);
  assert.deepEqual(Object.keys(schema.properties), [
    'mode',
    'query',
    'regex',
    'matchCase',
    'wholeCell',
    'lookIn',
    'sheetName',
    'sheetNames',
    'range',
    'columns',
    'headerRows',
    'limit',
  ]);
  assert.ok(!/oneOf|allOf|\$ref/.test(JSON.stringify(schema)));
  // The edit_sheet schema keeps its fields; set_formulas is still one of its actions.
  const edit = plain(tools.find((tool) => tool.name === 'edit_sheet').input_schema);
  assert.ok(edit.properties.action.enum.includes('set_formulas'));
  assert.deepEqual(edit.properties.formulas.items, { type: 'array', items: { type: 'string' } });
});
