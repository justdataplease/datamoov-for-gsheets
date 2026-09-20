import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

function fixture({ mixed = false } = {}) {
  const f = createDatamoovSandbox();
  const session = f.api.dmvChatSession_(f.book);
  const rows = [
    { date: '2026-08-01', campaign: 'A', spend: 6, currency: 'USD' },
    { date: '2026-08-02', campaign: 'A', spend: 7, currency: 'USD' },
    { date: '2026-08-03', campaign: 'B', spend: 12, currency: 'USD' },
    { date: '2026-09-01', campaign: 'A', spend: 10, currency: 'USD' },
    { date: '2026-09-02', campaign: 'B', spend: 9, currency: 'USD' },
    { date: '2026-09-03', campaign: 'B', spend: 5, currency: 'USD' },
  ];
  if (mixed) rows.push(
    { date: '2026-08-01', campaign: 'C', spend: 100, currency: 'EUR' },
    { date: '2026-08-02', campaign: 'D', spend: 50, currency: 'EUR' },
    { date: '2026-09-01', campaign: 'C', spend: 20, currency: 'EUR' },
    { date: '2026-09-02', campaign: 'D', spend: 30, currency: 'EUR' },
  );
  const resultId = f.api.dmvChatStoreResult_(session, {
    columns: [{ key: 'date', type: 'date' }, { key: 'campaign', type: 'text' },
      { key: 'spend', type: 'currency' }, { key: 'currency', type: 'text' }],
    rows, metadata: { currencyColumn: 'currency' }, source: 'Offline campaigns',
  });
  const input = { resultId, groupBy: ['date', 'campaign'], dateBucket: 'month',
    metrics: [{ field: 'spend', agg: 'sum' }], orderBy: { field: 'spend__sum', direction: 'desc' },
    rankWithin: ['date'], limitPerGroup: 1, limit: 20000 };
  return { ...f, session, resultId, input };
}

test('monthly ranking aggregates every campaign before selecting a different winner in each month', () => {
  const f = fixture();
  const result = f.api.dmvChatSummarize_(f.session, f.input);
  const byMonth = Object.fromEntries(plain(result.rows).map((row) => [row.date, row]));
  assert.deepEqual(byMonth, {
    '2026-08': { date: '2026-08', campaign: 'A', spend__sum: 13 },
    '2026-09': { date: '2026-09', campaign: 'B', spend__sum: 14 },
  });
  assert.equal(result.inputRows, 6);
  assert.equal(result.metadata.currency, 'USD');
  assert.equal(result.metadata.limited, true);
  assert.deepEqual(plain(result.ranking), { within: ['date'], limitPerGroup: 1,
    orderBy: { field: 'spend__sum', direction: 'desc' }, totalGroups: 4, selectedGroups: 2 });
});

test('ranked winners write through the protected atomic writer into a new tab', () => {
  const f = fixture();
  const ranked = f.api.dmvChatSummarize_(f.session, f.input);
  const written = f.api.dmvChatWriteSheet_(f.session, { resultId: ranked.resultId, sheetName: 'Top campaigns per month' });
  assert.equal(written.rows, 2);
  assert.equal(written.range, 'Top campaigns per month!A1:C3');
  assert.equal(f.state.batches.length, 1);
  assert.equal(f.value(f.book.getSheetByName('Top campaigns per month'), 2, 3), 14);
  const occupied = f.book.sheets[0];
  f.setCell(occupied, 1, 1, 'Keep this data');
  assert.throws(() => f.api.dmvChatWriteSheet_(f.session, { resultId: ranked.resultId, sheetName: occupied.getName() }), /existing data/);
  assert.equal(f.value(occupied, 1, 1), 'Keep this data');
  assert.equal(f.state.batches.length, 1);
});

test('money rankings require a currency partition and keep independent winners for each unit', () => {
  const f = fixture({ mixed: true });
  const input = { ...f.input, groupBy: ['date', 'campaign', 'currency'] };
  assert.throws(() => f.api.dmvChatSummarize_(f.session, input), /Include currency in rankWithin/);
  const ranked = f.api.dmvChatSummarize_(f.session, { ...input, rankWithin: ['date', 'currency'] });
  const winners = Object.fromEntries(plain(ranked.rows).map((row) => [row.date + ':' + row.currency, row.campaign]));
  assert.deepEqual(winners, { '2026-08:USD': 'A', '2026-09:USD': 'B', '2026-08:EUR': 'C', '2026-09:EUR': 'D' });
  assert.equal(ranked.rowCount, 4);
});

test('ranking rejects incomplete controls, unknown or duplicate partitions, and nonnumeric ordering', () => {
  const f = fixture();
  for (const patch of [
    { rankWithin: undefined }, { limitPerGroup: undefined }, { rankWithin: [] },
    { rankWithin: ['spend'] }, { rankWithin: ['missing'] }, { rankWithin: ['date', 'date'] },
    { limitPerGroup: 0 }, { limitPerGroup: 20001 }, { limitPerGroup: 1.5 },
    { orderBy: undefined }, { orderBy: { field: 'campaign', direction: 'desc' } },
  ]) assert.throws(() => f.api.dmvChatSummarize_(f.session, { ...f.input, ...patch }), /rankWithin|limitPerGroup|Ranking/);
});

test('the global limit marks omitted monthly winners and keeps the warning through cache reuse', () => {
  const f = fixture();
  const ranked = f.api.dmvChatSummarize_(f.session, { ...f.input, limit: 1 });
  assert.equal(ranked.rowCount, 1);
  assert.equal(ranked.metadata.totalGroups, 4);
  assert.equal(ranked.metadata.rankedGroups, 2);
  assert.equal(ranked.metadata.keptGroups, 1);
  assert.equal(ranked.metadata.limited, true);
  assert.match(ranked.metadata.note, /not a complete per-group ranking/);
  const later = f.api.dmvChatSession_(f.book);
  const cached = f.api.dmvChatResult_(later, ranked.resultId);
  assert.equal(cached.metadata.rankedGroups, 2);
  assert.match(cached.metadata.note, /omitted some ranked rows/);
});

test('ascending ranking selects monthly minima and handles multiple winners without crossing partitions', () => {
  const f = fixture();
  const minimum = f.api.dmvChatSummarize_(f.session, { ...f.input, orderBy: { field: 'spend__sum', direction: 'asc' } });
  assert.deepEqual(Object.fromEntries(plain(minimum.rows).map((row) => [row.date, row.campaign])), { '2026-08': 'B', '2026-09': 'A' });
  const both = f.api.dmvChatSummarize_(f.session, { ...f.input, limitPerGroup: 2 });
  assert.equal(both.rowCount, 4);
  assert.equal(both.rows.filter((row) => row.date === '2026-08').length, 2);
  assert.equal(both.rows.filter((row) => row.date === '2026-09').length, 2);
});