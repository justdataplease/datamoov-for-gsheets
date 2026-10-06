import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from './helpers/datamoov-sandbox.mjs';
import { chatSheetFixture } from './helpers/chat-sheet-fixture.mjs';

// Editing a tab chat made in the same request. Benchmark runs lost rounds to it: an edit beside a
// narrow inspection was refused as "belongs to another range", insert_rows, delete_rows and
// delete_sheet asked first on a tab holding only chat's own formula, rename_sheet asked for an
// inspection, and create_sheet over a name already taken failed with the Sheets API's own error.
// Nothing on such a tab is older than the request, so it needs no inspection and no yes for row
// and tab changes; the overwrite question and undo stay.

function fixture() {
  const f = chatSheetFixture();
  f.column(f.sheet, 1, ['Name', 'a', 'b', 'c']);
  f.made = (name = 'Made') => {
    const made = f.tabAction('create_sheet', { newName: name });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(made.note, 'This request may edit any range of this tab without inspect_sheet or editToken.');
    return f.tab(name);
  };
  // An edit with no inspection: sheetName and range only.
  f.write = (sheetName, range, values, extra = {}) =>
    f.tabAction('set_values', { sheetName, range, values, ...extra });
  return f;
}

const block = (rows, columns, text) =>
  Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => text + r + '.' + c)
  );

test('a tab made in this request takes edits without an inspection; any other tab still needs one', () => {
  const f = fixture();
  const tab = f.made();
  const done = f.write('Made', 'A40:B41', [
    ['x', 1],
    ['y', 2],
  ]);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(f.value(tab, 41, 2), 2);
  const formula = f.tabAction('set_formulas', {
    sheetName: 'Made',
    range: 'C40',
    formulas: [['=SUM(B40:B41)']],
  });
  assert.equal(formula.ok, true, JSON.stringify(formula));
  // A token of another range of it, or an expired one, does not stop the edit either.
  const narrow = f.inspect('A1', 'Made');
  assert.equal(f.write('Made', 'D1:E1', [['p', 'q']], { editToken: narrow.editToken }).ok, true);
  const expired = 'e' + '0'.repeat(32);
  assert.equal(f.write('Made', 'D2', [['r']], { editToken: expired }).ok, true);
  // The tab the request found keeps the inspection rule.
  const before = f.state.batches.length;
  assert.throws(() => f.write(f.sheet.name, 'B1', [['z']]), /Inspect the target range/);
  assert.equal(f.state.batches.length, before);
  // Undo still puts the cells back.
  assert.equal(f.undo().ok, true);
  assert.equal(f.value(tab, 2, 4), '');
});

test('on a tab made in this request, replacing over 200 cells still asks first', () => {
  const f = fixture();
  f.made();
  assert.equal(f.write('Made', 'A1:E50', block(50, 5, 'a')).ok, true);
  const asked = f.write('Made', 'A1:E50', block(50, 5, 'b'));
  assert.equal(asked.needsConfirmation, true, JSON.stringify(asked));
  assert.match(asked.summary || asked.question || JSON.stringify(asked), /250 non-empty cells/);
});

test('rows and the tab itself change without a yes on a tab made in this request', () => {
  const f = fixture();
  f.book.insertSheet('Other');
  const tab = f.made();
  f.write('Made', 'A1:A3', [['h'], ['1'], ['2']]);
  const inserted = f.tabAction('insert_rows', { sheetName: 'Made', start: 2, count: 3 });
  assert.equal(inserted.ok, true, JSON.stringify(inserted));
  assert.equal(f.value(tab, 5, 1), '1');
  const deleted = f.tabAction('delete_rows', { sheetName: 'Made', start: 2, count: 3 });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(f.value(tab, 2, 1), '1');
  // Undo answers how to reverse a row change there: delete the tab.
  assert.throws(() => f.undo(), /Delete the tab "Made" to remove it\./);
  const gone = f.tabAction('delete_sheet', { sheetName: 'Made' });
  assert.equal(gone.ok, true, JSON.stringify(gone));
  assert.equal(f.tab('Made'), null);
  // A tab the request found still asks first, for each of them.
  for (const [action, extra] of [
    ['insert_rows', { start: 2, count: 1 }],
    ['delete_rows', { start: 2, count: 1 }],
    ['delete_sheet', {}],
  ])
    assert.equal(
      f.tabAction(action, { sheetName: f.sheet.name, ...extra }).needsConfirmation,
      true,
      action
    );
  // A later request did not make the tab, so there it asks again.
  const later = f.api.dmvChatSession_(f.book);
  f.made('Again');
  assert.equal(
    f.tabAction('delete_sheet', { sheetName: 'Again' }, later).needsConfirmation,
    true
  );
});

test('rename_sheet is a tab action: sheetName and newName only', () => {
  const f = fixture();
  f.api.dmvReadDefinitions_ = () => ({ definitions: [] });
  const renamed = f.tabAction('rename_sheet', { sheetName: f.sheet.name, newName: 'Renamed' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(f.sheet.name, 'Renamed');
  assert.equal(renamed.range, null);
  assert.equal(plain(f.session.events.at(-1)).text, 'Renamed tab Output to Renamed');
});

test('create_sheet over a name taken names that tab and a free one, without a batch', () => {
  const f = fixture();
  f.made();
  const before = f.state.batches.length;
  assert.throws(
    () => f.tabAction('create_sheet', { newName: 'made' }),
    /^Error: This request already made the tab "Made" \(1,000 rows\): edit it \(no inspection needed\), or create_sheet a free name such as "made 2"\.$/
  );
  assert.throws(
    () => f.tabAction('create_sheet', { newName: 'OUTPUT' }),
    /^Error: A tab named "Output" \(100 rows\) already exists: inspect it to edit it, or create_sheet a free name such as "OUTPUT 2"\.$/
  );
  // A tab another tool added through the Sheets API, which the session's spreadsheet object has
  // not seen, is found too, and the next free number is offered.
  f.byHand({ addSheet: { properties: { title: 'Notes' } } }, { addSheet: { properties: { title: 'Notes 2' } } });
  assert.throws(
    () => f.tabAction('create_sheet', { newName: 'Notes' }),
    /A tab named "Notes" \(1,000 rows\) already exists: .* such as "Notes 3"\./
  );
  assert.equal(f.state.batches.length, before + 1);
});
