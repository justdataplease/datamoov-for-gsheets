import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

const range = (preset, today) => plain(createDatamoovSandbox().api.dmvDateRange_({ preset }, today));

test('last week is the most recent complete Monday to Sunday week on every weekday', () => {
  assert.deepEqual(range('lastWeek', '2026-09-20'), { startDate: '2026-09-07', endDate: '2026-09-13' }, 'Sunday');
  assert.deepEqual(range('lastWeek', '2026-09-21'), { startDate: '2026-09-14', endDate: '2026-09-20' }, 'Monday');
  assert.deepEqual(range('lastWeek', '2026-09-22'), { startDate: '2026-09-14', endDate: '2026-09-20' }, 'Tuesday');
  assert.deepEqual(range('lastWeek', '2026-09-26'), { startDate: '2026-09-14', endDate: '2026-09-20' }, 'Saturday');
  for (let day = 1; day <= 31; day++) {
    const today = '2026-10-' + String(day).padStart(2, '0');
    const { startDate, endDate } = range('lastWeek', today);
    assert.equal(new Date(startDate + 'T12:00:00Z').getUTCDay(), 1, today + ' starts on a Monday');
    assert.equal(new Date(endDate + 'T12:00:00Z').getUTCDay(), 0, today + ' ends on a Sunday');
    assert.ok(endDate < today, today + ' ends before today');
    assert.ok(Date.parse(today) - Date.parse(endDate) <= 7 * 86400000, today + ' is the most recent week');
  }
});

test('day ranges end yesterday and calendar presets keep their boundaries', () => {
  assert.deepEqual(range('yesterday', '2026-09-20'), { startDate: '2026-09-19', endDate: '2026-09-19' });
  assert.deepEqual(range('last7', '2026-09-20'), { startDate: '2026-09-13', endDate: '2026-09-19' });
  assert.deepEqual(range('lastMonth', '2026-09-20'), { startDate: '2026-08-01', endDate: '2026-08-31' });
  assert.deepEqual(range('thisMonth', '2026-09-20'), { startDate: '2026-09-01', endDate: '2026-09-20' });
  assert.deepEqual(range('lastYear', '2026-09-20'), { startDate: '2025-01-01', endDate: '2025-12-31' });
  assert.throws(() => range('fortnight', '2026-09-20'), /supported date range/);
});

test('previous day windows end the day before the matching last window and keep its length', () => {
  assert.deepEqual(range('previous7', '2026-09-20'), { startDate: '2026-09-06', endDate: '2026-09-12' });
  assert.deepEqual(range('previous14', '2026-09-20'), { startDate: '2026-08-23', endDate: '2026-09-05' });
  assert.deepEqual(range('previous30', '2026-09-20'), { startDate: '2026-07-22', endDate: '2026-08-20' });
  assert.deepEqual(range('previous90', '2026-09-20'), { startDate: '2026-03-24', endDate: '2026-06-21' });
  assert.deepEqual(range('previous7', '2026-01-05'), { startDate: '2025-12-22', endDate: '2025-12-28' }, 'year boundary');
  assert.deepEqual(range('previous30', '2026-01-10'), { startDate: '2025-11-11', endDate: '2025-12-10' }, 'year boundary');
  const day = (text) => Date.parse(text + 'T12:00:00Z') / 86400000;
  for (const days of [7, 14, 30, 90])
    for (const today of ['2024-03-01', '2026-03-01', '2026-03-29', '2026-10-25', '2026-12-31']) {
      const last = range('last' + days, today), previous = range('previous' + days, today);
      assert.equal(day(last.startDate) - day(previous.endDate), 1, `${days} days before ${today} meet`);
      assert.equal(day(previous.endDate) - day(previous.startDate) + 1, days, `${days} days before ${today} keep the length`);
    }
});

test('the month before last is the calendar month before last month, across years and leap days', () => {
  assert.deepEqual(range('previousMonth', '2026-09-20'), { startDate: '2026-07-01', endDate: '2026-07-31' });
  assert.deepEqual(range('previousMonth', '2026-03-31'), { startDate: '2026-01-01', endDate: '2026-01-31' });
  assert.deepEqual(range('previousMonth', '2026-02-10'), { startDate: '2025-12-01', endDate: '2025-12-31' });
  assert.deepEqual(range('previousMonth', '2026-01-15'), { startDate: '2025-11-01', endDate: '2025-11-30' });
  assert.deepEqual(range('previousMonth', '2024-04-05'), { startDate: '2024-02-01', endDate: '2024-02-29' });
  assert.deepEqual(range('previousMonth', '2026-04-01'), { startDate: '2026-02-01', endDate: '2026-02-28' });
});
