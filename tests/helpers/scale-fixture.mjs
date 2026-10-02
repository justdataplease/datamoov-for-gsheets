// A dashboard over two large periods of campaign rows, built in a sandbox: a fake connector
// returns `current` rows of last month and `previous` rows of the month before, generated from
// their position so a test can add them up on its own.
import { createDatamoovSandbox, plain } from './datamoov-sandbox.mjs';

export const CHANNELS = ['Search', 'Display', 'Video', 'Shopping'];
export const COLUMNS = [
  { key: 'date', type: 'date' },
  { key: 'campaign', type: 'text' },
  { key: 'channel', type: 'text' },
  { key: 'cost', type: 'currency' },
  { key: 'clicks', type: 'number' },
  { key: 'impressions', type: 'number' },
  { key: 'conversions', type: 'number' },
  { key: 'value', type: 'currency' },
  { key: 'currency', type: 'text' },
];

// Row i of a month: every day in turn, 240 campaigns each on one channel, amounts in cents.
export function scaleRows(count, month, seed) {
  return Array.from({ length: count }, (_, i) => {
    const n = (i * 7919 + seed) % 100003;
    return {
      date: `2026-${month}-${String(1 + (i % 31)).padStart(2, '0')}`,
      campaign: 'Campaign ' + String(n % 240).padStart(3, '0'),
      channel: CHANNELS[n % 4],
      cost: (n % 5000) / 100,
      clicks: n % 40,
      impressions: 50 + (n % 950),
      conversions: (n % 9) / 4,
      value: (n % 20000) / 100,
      currency: 'EUR',
    };
  });
}

export function scaleFixture({ current, previous }) {
  const f = createDatamoovSandbox();
  f.rows = { current: scaleRows(current, '08', 11), previous: scaleRows(previous, '07', 23) };
  f.api.dmvRegisterConnector_({
    id: 'scale_source',
    label: 'Scale source',
    category: 'Test',
    allowedHosts: ['scale.example'],
    authFields: [{ key: 'account', label: 'Account', type: 'text', required: true }],
    reports: [
      {
        id: 'daily',
        label: 'Daily',
        fields: COLUMNS,
        dateRange: true,
        configFields: [],
        fetch: (ctx) => ({
          columns: COLUMNS,
          rows: ctx.startDate.startsWith('2026-08') ? f.rows.current : f.rows.previous,
          metadata: { complete: true, currencyColumn: 'currency' },
        }),
      },
    ],
  });
  const connection = f.api.dmvSaveConnection({ connectorId: 'scale_source', label: 'Shop', credentials: { account: 'shop' } });
  const dataset = (id, label, preset) => ({
    id,
    label,
    sheetName: label + ' data',
    connectionId: connection.id,
    reportType: 'daily',
    fields: COLUMNS.map((column) => column.key),
    config: {},
    dateRange: { preset },
    maxRows: 100000,
    mapping: COLUMNS.map((column) => ({ field: column.key, key: column.key })),
  });
  const compare = { current: 'now', previous: 'before' };
  const sum = (...fields) => fields.map((field) => ({ field, agg: 'sum' }));
  f.input = plain({
    name: 'Scale',
    target: { sheetName: 'Scale page' },
    datasets: [dataset('now', 'August', 'lastMonth'), dataset('before', 'July', 'previousMonth')],
    tiles: [
      {
        title: 'Totals',
        type: 'kpi',
        datasets: ['now', 'before'],
        metrics: sum('cost', 'clicks', 'conversions'),
        ratios: [{ key: 'roas', label: 'ROAS', numerator: 'value', denominator: 'cost' }],
        compare,
      },
      { title: 'Cost by channel', type: 'bar', datasets: ['now'], groupBy: ['channel'], metrics: sum('cost') },
      { title: 'Weekly cost', type: 'line', datasets: ['now'], groupBy: ['date'], dateBucket: 'week', metrics: sum('cost', 'conversions') },
      { title: 'Weekly cost by channel', type: 'column', datasets: ['now'], groupBy: ['date', 'channel'], dateBucket: 'week', metrics: sum('cost') },
      { title: 'Weekly cost vs July', type: 'line', datasets: ['now', 'before'], groupBy: ['date'], dateBucket: 'week', metrics: sum('cost'), compare },
      {
        title: 'Top campaigns',
        type: 'table',
        datasets: ['now', 'before'],
        groupBy: ['campaign'],
        metrics: sum('cost', 'conversions'),
        ratios: [{ key: 'cpa', label: 'CPA', numerator: 'cost', denominator: 'conversions' }],
        orderBy: { field: 'cost__sum', direction: 'desc' },
        limit: 20,
        compare,
        highlight: [{ field: 'cpa', op: 'gt', ofTotal: 1.02, color: 'red' }],
      },
    ],
  });
  f.saved = plain(f.api.dmvSaveDashboard(f.input));
  f.run = () => plain(f.api.dmvRunDashboard(f.saved.id));
  return f;
}
