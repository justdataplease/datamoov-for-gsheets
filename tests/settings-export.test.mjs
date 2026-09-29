import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Export writes every private setting to one bundle; Import reads it back into another
// account, reports and dashboards included, through the ordinary validators.
const SECRET = 'export-secret-token-value';

function fixture() {
  const f = createDatamoovSandbox();
  f.checks = 0;
  f.api.dmvRegisterConnector_({
    id: 'gads',
    label: 'Google Ads fixture',
    category: 'Test',
    allowedHosts: [],
    authFields: [
      { key: 'token', label: 'Token', type: 'password', required: true },
      { key: 'account', label: 'Account', type: 'text', required: true, perConnection: true },
    ],
    test() {
      f.checks++;
    },
    reports: [
      {
        id: 'campaign_daily',
        label: 'Campaign daily',
        dateRange: true,
        configFields: [{ key: 'level', label: 'Level', type: 'text', default: 'campaign' }],
        fields: [
          { key: 'date', label: 'Date', type: 'date', role: 'dimension' },
          { key: 'campaign', label: 'Campaign', type: 'text', role: 'dimension' },
          { key: 'cost', label: 'Cost', type: 'currency', role: 'metric' },
        ],
        fetch() {
          return { columns: [], rows: [], metadata: { complete: true } };
        },
      },
    ],
  });
  return f;
}

function seed(f) {
  const credential = f.api.dmvSaveCredential({ family: 'gads', label: 'Main token', values: { token: SECRET } });
  const connection = f.api.dmvSaveConnection({
    connectorId: 'gads',
    credentialId: credential.id,
    label: 'Main account',
    credentials: { account: '123-456' },
  });
  const report = f.api.dmvSaveReport({
    name: 'Daily cost',
    connectionId: connection.id,
    reportType: 'campaign_daily',
    fields: ['date', 'cost'],
    config: { level: 'campaign' },
    dateRange: { preset: 'last30' },
    maxRows: 500,
    target: { sheetName: 'Cost', startCell: 'B2' },
    schedule: 'daily',
    at: { hour: 7 },
  });
  const dashboard = f.api.dmvSaveDashboard({
    name: 'Cost dashboard',
    target: { sheetName: 'Cost Dashboard' },
    datasets: [
      {
        id: 'gads',
        label: 'Google Ads campaigns',
        sheetName: 'Google Ads Data',
        connectionId: connection.id,
        reportType: 'campaign_daily',
        fields: ['date', 'campaign', 'cost'],
        dateRange: { preset: 'last90' },
        mapping: [
          { field: 'date', key: 'date' },
          { field: 'campaign', key: 'campaign' },
          { field: 'cost', key: 'spend' },
        ],
      },
    ],
    tiles: [
      { title: 'Cost by campaign', type: 'column', datasets: ['gads'], groupBy: ['campaign'], metrics: [{ field: 'spend', agg: 'sum' }] },
    ],
    schedule: 'weekly',
    at: { hour: 6, weekday: 1 },
  });
  return { credential, connection, report, dashboard };
}

test('export writes a version 2 bundle with secrets, refs and this spreadsheet\'s reports and dashboards', () => {
  const f = fixture();
  const ids = seed(f);
  const exported = f.api.dmvExportSettings();
  assert.equal(exported.fileName, 'datamoov-settings.json');
  assert.deepEqual(plain(exported.counts), { credentials: 1, connections: 1, reports: 1, dashboards: 1 });
  const bundle = JSON.parse(exported.json);
  assert.equal(bundle.version, 2);
  assert.deepEqual(bundle.credentials, [{ ref: 'main-token', label: 'Main token', family: 'gads', values: { token: SECRET } }]);
  assert.deepEqual(bundle.connections, [
    { ref: 'main-account', label: 'Main account', connectorId: 'gads', credentialRef: 'main-token', credentials: { account: '123-456' } },
  ]);
  assert.deepEqual(bundle.reports, [
    {
      ref: 'daily-cost',
      name: 'Daily cost',
      connectionRef: 'main-account',
      reportType: 'campaign_daily',
      fields: ['date', 'cost'],
      config: { level: 'campaign' },
      dateRange: { preset: 'last30' },
      maxRows: 500,
      target: { sheetName: 'Cost', startCell: 'B2' },
      schedule: 'daily',
      at: { hour: 7 },
    },
  ]);
  assert.equal(bundle.dashboards.length, 1);
  const dashboard = bundle.dashboards[0];
  assert.equal(dashboard.ref, 'cost-dashboard');
  assert.deepEqual(dashboard.target, { sheetName: 'Cost Dashboard' });
  assert.deepEqual(dashboard.datasets[0].connectionRef, 'main-account');
  assert.deepEqual(dashboard.datasets[0].mapping[2], { field: 'cost', key: 'spend' });
  assert.equal(dashboard.datasets[0].connectionId, undefined, 'ids never leave the account; refs do');
  assert.equal(dashboard.schedule, 'weekly');
  assert.deepEqual(dashboard.at, { hour: 6, weekday: 1 });
  assert.equal(dashboard.tiles[0].title, 'Cost by campaign');
  for (const record of Object.values(ids)) assert.ok(!exported.json.includes(record.id), 'no private record ids in the file');
});

test('a bundle imported into another account recreates everything; importing it again reuses each item', () => {
  const source = fixture();
  seed(source);
  const bundle = JSON.parse(source.api.dmvExportSettings().json);

  const target = fixture();
  const result = plain(target.api.dmvImportCredentials(bundle));
  assert.deepEqual(result.summary, {
    credentials: { saved: 1, existing: 0, failed: 0 },
    connections: { saved: 1, existing: 0, failed: 0 },
    reports: { saved: 1, existing: 0, failed: 0 },
    dashboards: { saved: 1, existing: 0, failed: 0 },
  });
  assert.equal(target.checks, 1, 'the connection is verified once; reports and dashboards fetch nothing');
  const reports = target.api.dmvListReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].name, 'Daily cost');
  assert.equal(reports[0].schedule, 'daily');
  assert.equal(reports[0].draft, false, 'imported items are saved, not drafts');
  assert.deepEqual(plain(reports[0].target), { sheetName: 'Cost', startCell: 'B2' });
  assert.equal(reports[0].connectionId, result.connections[0].id);
  const dashboards = plain(target.api.dmvListDashboards());
  assert.equal(dashboards.length, 1);
  assert.equal(dashboards[0].name, 'Cost dashboard');
  assert.equal(dashboards[0].schedule, 'weekly');
  assert.equal(dashboards[0].draft, false);
  assert.equal(dashboards[0].datasets[0].sheetName, 'Google Ads Data');
  assert.equal(target.state.batches.length, 0, 'nothing is written to the sheet by an import');

  const again = plain(target.api.dmvImportCredentials(bundle));
  assert.deepEqual(again.summary, {
    credentials: { saved: 0, existing: 1, failed: 0 },
    connections: { saved: 0, existing: 1, failed: 0 },
    reports: { saved: 0, existing: 1, failed: 0 },
    dashboards: { saved: 0, existing: 1, failed: 0 },
  });
  assert.equal(target.api.dmvListReports().length, 1);
  assert.equal(target.api.dmvListDashboards().length, 1);
});

test('report and dashboard items fail one by one with a plain reason and never block the rest', () => {
  const source = fixture();
  seed(source);
  const bundle = JSON.parse(source.api.dmvExportSettings().json);
  bundle.reports.push({
    ...bundle.reports[0],
    ref: 'bad-field',
    name: 'Bad field',
    reportType: 'nonexistent',
    target: { sheetName: 'Other' },
    schedule: 'manual',
    at: null,
  });
  bundle.dashboards.push({
    ...bundle.dashboards[0],
    ref: 'occupied',
    name: 'Occupied',
    target: { sheetName: 'Taken' },
    datasets: [{ ...bundle.dashboards[0].datasets[0], sheetName: 'Taken Data' }],
  });
  const target = fixture();
  target.setCell(target.book.insertSheet('Taken'), 1, 1, 'someone else');
  const result = plain(target.api.dmvImportCredentials(bundle));
  assert.deepEqual(result.summary.reports, { saved: 1, existing: 0, failed: 1 });
  assert.deepEqual(result.summary.dashboards, { saved: 1, existing: 0, failed: 1 });
  const failedReport = result.reports.find((item) => item.status === 'failed');
  assert.equal(failedReport.label, 'Bad field');
  assert.match(failedReport.message, /^Could not save this report: /);
  const failedDashboard = result.dashboards.find((item) => item.status === 'failed');
  assert.match(failedDashboard.message, /"Taken" already exists and has content/);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('the importer rejects reports that point outside the bundle, unknown fields and other versions', () => {
  const source = fixture();
  seed(source);
  const good = JSON.parse(source.api.dmvExportSettings().json);
  const cases = [
    (b) => {
      b.reports[0].connectionRef = 'missing';
    },
    (b) => {
      b.dashboards[0].datasets[0].connectionRef = 'missing';
    },
    (b) => {
      b.reports[0].extra = true;
    },
    (b) => {
      b.reports[0].config = { __proto__: { polluted: true }, level: 'x' };
      b.reports[0].config = JSON.parse('{"__proto__": {"polluted": true}}');
    },
    (b) => {
      b.version = 3;
    },
    (b) => {
      delete b.dashboards;
    },
    (b) => {
      b.reports = Array.from({ length: 31 }, (_, i) => ({ ...b.reports[0], ref: 'r' + i }));
    },
  ];
  for (const alter of cases) {
    const bundle = JSON.parse(JSON.stringify(good));
    alter(bundle);
    const target = fixture();
    assert.throws(() => target.api.dmvImportCredentials(bundle));
    assert.equal(target.api.dmvListReports().length, 0, 'nothing is saved from a rejected bundle');
  }
  // A version 1 file still imports credentials and connections only.
  const v1 = { version: 1, credentials: good.credentials, connections: good.connections };
  const target = fixture();
  const result = plain(target.api.dmvImportCredentials(v1));
  assert.deepEqual(result.summary.connections, { saved: 1, existing: 0, failed: 0 });
  assert.deepEqual(result.reports, []);
});

test('an older connection that embeds its credential exports as a credential plus its own values', () => {
  const f = fixture();
  const connection = f.api.dmvSaveConnection({
    connectorId: 'gads',
    label: 'Legacy account',
    credentials: { token: SECRET, account: '999' },
  });
  assert.equal(connection.credentialId, null);
  const bundle = JSON.parse(f.api.dmvExportSettings().json);
  assert.deepEqual(bundle.credentials, [
    { ref: 'legacy-account-credential', label: 'Legacy account', family: 'gads', values: { token: SECRET } },
  ]);
  assert.deepEqual(bundle.connections[0].credentials, { account: '999' });
  assert.equal(bundle.connections[0].credentialRef, 'legacy-account-credential');
  const target = fixture();
  const result = plain(target.api.dmvImportCredentials(bundle));
  assert.deepEqual(result.summary.connections, { saved: 1, existing: 0, failed: 0 });
});

test('re-importing an export of a legacy embedded connection into the same account links it instead of duplicating', () => {
  const f = fixture();
  const connection = f.api.dmvSaveConnection({
    connectorId: 'gads',
    label: 'Legacy account',
    credentials: { token: SECRET, account: '999' },
  });
  f.api.dmvSaveReport({
    name: 'Legacy cost',
    connectionId: connection.id,
    reportType: 'campaign_daily',
    fields: ['date', 'cost'],
    dateRange: { preset: 'last30' },
    target: { sheetName: 'Cost' },
  });
  const bundle = JSON.parse(f.api.dmvExportSettings().json);
  const result = plain(f.api.dmvImportCredentials(bundle));
  assert.deepEqual(result.summary.credentials, { saved: 1, existing: 0, failed: 0 }, 'the split credential is new to the account');
  assert.deepEqual(result.summary.connections, { saved: 0, existing: 1, failed: 0 });
  assert.deepEqual(result.summary.reports, { saved: 0, existing: 1, failed: 0 });
  const connections = f.api.dmvConnections_();
  assert.equal(connections.length, 1);
  assert.equal(f.api.dmvListReports().length, 1);
  assert.equal(connections[0].id, connection.id);
  assert.equal(connections[0].credentialId, result.credentials[0].id, 'the legacy connection now uses the standalone credential');
});

test('a dashboard tab with stray whitespace matches the saved dashboard', () => {
  const source = fixture();
  seed(source);
  const bundle = JSON.parse(source.api.dmvExportSettings().json);
  const same = plain(source.api.dmvImportCredentials(bundle));
  assert.deepEqual(same.summary.dashboards, { saved: 0, existing: 1, failed: 0 });
  bundle.dashboards[0].target.sheetName = 'Cost Dashboard ';
  const result = plain(source.api.dmvImportCredentials(bundle));
  assert.deepEqual(result.summary.dashboards, { saved: 0, existing: 1, failed: 0 });
  assert.equal(source.api.dmvListDashboards().length, 1);
});

test('export names what it leaves out, keeps refs ordinary, and refuses to write an empty file', () => {
  const empty = fixture();
  assert.throws(() => empty.api.dmvExportSettings(), /nothing to export yet/);

  const f = fixture();
  const { connection } = seed(f);
  // A credential of a source that is no longer installed, and a report whose connection is gone.
  f.api.dmvSaveCredential({ family: 'gads', label: 'Constructor', values: { token: 'other-secret' } });
  f.state.user.setProperty(
    'dmv:v1:credential:00000000-0000-4000-8000-000000000001',
    JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', label: 'Old source key', family: 'gone_source', values: { token: 'x' }, revision: 1 })
  );
  const orphan = f.api.dmvSaveReport({
    name: 'Orphan',
    connectionId: connection.id,
    reportType: 'campaign_daily',
    fields: ['date'],
    dateRange: { preset: 'last7' },
    target: { sheetName: 'Orphan' },
  });
  const record = f.readReport(orphan.id);
  record.connectionId = '00000000-0000-4000-8000-000000000002';
  f.state.user.setProperty('dmv:v1:report:' + orphan.id, JSON.stringify(record));

  const exported = f.api.dmvExportSettings();
  const bundle = JSON.parse(exported.json);
  assert.deepEqual(
    plain(exported.skipped).sort((a, b) => a.label.localeCompare(b.label)),
    [
      { kind: 'credential', label: 'Old source key', reason: 'its source is no longer installed' },
      { kind: 'report', label: 'Orphan', reason: 'its connection is missing' },
    ]
  );
  assert.deepEqual(plain(exported.counts), { credentials: 2, connections: 1, reports: 1, dashboards: 1 });
  assert.equal(bundle.credentials.find((item) => item.label === 'Constructor').ref, 'credential-2-constructor');
  const target = fixture();
  const result = plain(target.api.dmvImportCredentials(bundle));
  assert.deepEqual(result.summary.credentials, { saved: 2, existing: 0, failed: 0 });
});

test('a settings lock during the report phase is reported as busy with re-import guidance', () => {
  const source = fixture();
  seed(source);
  const bundle = JSON.parse(source.api.dmvExportSettings().json);
  const target = fixture();
  target.api.dmvImportCredentials({ ...bundle, reports: [], dashboards: [] });
  target.state.lockAvailable = false;
  const result = plain(target.api.dmvImportCredentials(bundle));
  assert.equal(result.reports[0].status, 'failed');
  assert.equal(result.reports[0].code, 'busy');
  assert.match(result.reports[0].message, /Import again after it finishes/);
  assert.equal(result.dashboards[0].code, 'busy');
});
