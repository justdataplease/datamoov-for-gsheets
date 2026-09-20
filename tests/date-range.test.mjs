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
