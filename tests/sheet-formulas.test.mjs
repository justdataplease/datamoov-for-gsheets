import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula } from './helpers/sheet-formulas.mjs';

// A tab "Data" with a text column A, a number column B (with a blank) and a date column C.
const DATA = [
  ['Brand', 10, 46235],
  ['brand', 5, 46236],
  ['2026-09', null, null],
  ['Other', 7, 46240],
];
const read = (sheet, row, column) => (sheet === 'Data' ? (DATA[row - 1]?.[column - 1] ?? null) : null);
const run = (formula) => evaluateFormula(formula, read, new Map());

test('the fallback forms evaluate like Sheets: SUMPRODUCT, FILTER, VSTACK and text tests over ranges', () => {
  assert.equal(run('=SUMPRODUCT(Data!B1:B4,(EXACT(Data!A1:A4,"Brand"))*1)'), 10);
  assert.equal(run('=SUMPRODUCT((Data!B1:B4<>"")*(LOWER(Data!A1:A4)="brand"))'), 2);
  assert.equal(run('=SUMPRODUCT(((LOWER(Data!A1:A4)="brand")+(LOWER(Data!A1:A4)="other"))*1)'), 3);
  assert.equal(run('=MAX(FILTER(Data!B1:B4,(Data!B1:B4<>"")*(LOWER(Data!A1:A4)="brand")>0))'), 10);
  assert.equal(run('=COUNTUNIQUE(FILTER(VSTACK(Data!A1:A2,Data!A4:A4,"Brand"),VSTACK((Data!B1:B2<>"")*1,(Data!B4:B4<>"")*1,1)>0))'), 3);
  assert.equal(run('=SUMPRODUCT(ISNUMBER(FIND("0",LOWER(Data!B1:B4)))*1)'), 1);
  assert.equal(run('=SUMPRODUCT((Data!C1:C4<>"")*(TEXT(Data!C1:C4,"yyyy-mm-dd")>="2026-08-02"))'), 2);
  assert.deepEqual(run('=MIN(FILTER(Data!B1:B4,Data!B1:B4>100))'), { error: '#N/A' });
  assert.deepEqual(run('=IF(1=1,NA(),2)'), { error: '#N/A' });
});

// SUMPRODUCT reads its argument as an array in Sheets for certain; whether SUM does is not
// vouched for, so the evaluator refuses it.
test('array criteria give one result per criterion, added up by SUMPRODUCT', () => {
  assert.equal(run('=SUMPRODUCT(SUMIFS(Data!B1:B4,Data!A1:A4,{"=brand";"=other"}))'), 22);
  assert.equal(run('=SUMPRODUCT(COUNTIFS(Data!A1:A4,{"=brand";"=other"},Data!B1:B4,"<>"))'), 3);
  assert.throws(() => run('=SUM(SUMIFS(Data!B1:B4,Data!A1:A4,{"=brand";"=other"}))'), /inside SUMPRODUCT/);
});

test('values of different types are never equal: Sheets sorts numbers, then text, then booleans', () => {
  const cells = [[12], ['12'], [true], ['TRUE'], [null]];
  const typed = (sheet, row, column) => (sheet === 'T' ? (cells[row - 1]?.[column - 1] ?? null) : null);
  const count = (formula) => evaluateFormula(formula, typed, new Map());
  assert.equal(count('=SUMPRODUCT((T!A1:A5=12)*1)'), 1);
  assert.equal(count('=SUMPRODUCT((T!A1:A5=TRUE)*1)'), 1);
  assert.equal(count('=SUMPRODUCT(ISTEXT(T!A1:A5)*EXACT(T!A1:A5,"12"))'), 1);
  assert.equal(count('=SUMPRODUCT(EXACT(T!A1:A5,"12")*1)'), 2);
  assert.equal(count('=SUMPRODUCT((T!A1:A5>5)*1)'), 4);
  assert.equal(count('=SUMPRODUCT(ISNUMBER(T!A1:A5)*(T!A1:A5>5))'), 1);
  // An empty cell equals FALSE and 0; ISLOGICAL and ISNUMBER leave it out.
  assert.equal(count('=SUMPRODUCT((T!A1:A5=FALSE)*1)'), 1);
  assert.equal(count('=SUMPRODUCT(ISLOGICAL(T!A1:A5)*(T!A1:A5=FALSE))'), 0);
  assert.equal(count('=SUMPRODUCT(ISLOGICAL(T!A1:A5)*(T!A1:A5=TRUE))'), 1);
  assert.equal(count('=SUMPRODUCT((T!A1:A5=0)*1)'), 1);
  assert.equal(count('=SUMPRODUCT(ISNUMBER(T!A1:A5)*(T!A1:A5=0))'), 0);
  // As text a number reads as it prints and a boolean in lower case, as the summary prints them.
  assert.equal(count('=COUNTUNIQUE(FILTER(IF(ISTEXT(T!A1:A5),T!A1:A5,LOWER(T!A1:A5)),(T!A1:A5<>"")*1>0))'), 3);
});

test('the evaluator stays strict: a range outside an array function, or anything unknown, does not pass', () => {
  assert.deepEqual(run('=Data!B1:B4*2'), { error: '#VALUE!' });
  assert.deepEqual(run('=LOWER(Data!A1:A4)'), { error: '#VALUE!' });
  assert.throws(() => run('=SUMPRODUCT(SEARCH("a",Data!A1:A4))'), /does not know SEARCH/);
  assert.throws(() => run('=TEXT(Data!C1,"dd/mm/yyyy")'), /pattern/);
  assert.throws(() => run('=SUMPRODUCT(SUMIFS(Data!B1:B4,Data!A1:A4,{"=a";"=b"},Data!A1:A4,{"=c";"=d"}))'), /one array criterion/);
  assert.deepEqual(run('=SUMPRODUCT(Data!B1:B4,Data!B1:B3)'), { error: '#VALUE!' });
  // Sheets may read text after an operator as an error or as another operator.
  for (const criterion of ['=#N/A', '<><5', '==x', '#REF!'])
    assert.throws(() => run(`=SUMIFS(Data!B1:B4,Data!A1:A4,"${criterion}")`), /does not know how Sheets reads/, criterion);
});
