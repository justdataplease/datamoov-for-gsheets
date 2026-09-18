import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = '127.0.0.1';
const port = 8891;

export async function previewCatalog() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const connectorFiles = (await readdir(path.join(root, 'src/connectors'))).filter(name => name.endsWith('.js')).sort();
  for (const name of ['dmv_core.js', 'dmv_connector_helpers.js', ...connectorFiles.map(name => 'connectors/' + name)]) {
    const source = await readFile(path.join(root, 'src', name), 'utf8');
    new vm.Script(source, { filename: name }).runInContext(context, { timeout: 1000 });
  }
  return JSON.parse(JSON.stringify(context.dmvCatalog_()));
}

export function previewFixture(catalog) {
  const connections = catalog.map((source, index) => ({ id: 'demo-' + source.id, label: source.label + (source.category === 'Database' ? ' · Demo warehouse' : ' · Demo account'), connectorId: source.id,
    values: Object.fromEntries((source.authFields || []).filter(field => !field.secret && field.type !== 'password' && field.key !== 'serviceAccountJson').map(field => [field.key, field.default ?? ({ customerId: '1234567890', propertyId: '123456789', subdomain: 'demo-team', email: 'demo@example.com', host: 'localhost', database: 'analytics', username: 'report_reader' }[field.key] || '')])),
    configuredFields: (source.authFields || []).filter(field => field.secret || field.type === 'password' || field.key === 'serviceAccountJson')
      .filter(field => !field.showWhen || [field.showWhen.value].flat().includes(source.authFields.find(item => item.key === field.showWhen.key)?.default ?? ''))
      .map(field => field.key) }));
  const featured = ['google_ads', 'ga4', 'hubspot'].map(id => catalog.find(source => source.id === id)).filter(Boolean);
  const reports = featured.map((source, index) => {
    const report = source.reports[0];
    return { id: 'demo-report-' + index, name: ['Campaign performance', 'Website acquisition', 'Sales pipeline'][index], connectorId: source.id, connectionId: 'demo-' + source.id, reportType: report.id,
      fields: report.fields.filter(field => report.fields.some(item => typeof item.default === 'boolean') ? field.default === true : field.default !== false).map(field => field.key),
      config: Object.fromEntries((report.configFields || []).map(field => [field.key, field.default ?? ''])), dateRange: { preset: 'last30' },
      target: { sheetName: ['Campaigns', 'Website', 'Deals'][index], startCell: 'A1' }, maxRows: 1000, schedule: index === 2 ? 'manual' : 'daily',
      status: 'success', lastRun: '2026-09-18T08:30:00.000Z', lastRowCount: [248, 86, 32][index] };
  });
  return { catalog, connections, reports, sheetNames: ['Campaigns', 'Website', 'Deals', 'New report'], defaultTarget: { sheetName: 'New report', startCell: 'A1' }, dateTimezone: 'Europe/Athens', limits: { maxRows: 20000, defaultRows: 1000 }, branding: { name: 'DataMoov' } };
}

// This function is stringified into the localhost preview. It has no network or
// Google APIs. Every mutation only changes its disposable in-memory fixture.
function installPreview(initial) {
  window.DATAMOOV_LOCAL_PREVIEW = true;
  const data = structuredClone(initial);
  const copy = value => structuredClone(value);
  let nextId = 1;
  function definition(report) {
    return data.catalog.find(source => source.id === report.connectorId)?.reports.find(item => item.id === report.reportType);
  }
  function sampleColumns(report) {
    const def = definition(report);
    return (report.fields || []).map(key => def?.fields.find(field => field.key === key) || { key, label: key, type: 'text' });
  }
  function sampleValue(field, index) {
    if (field.type === 'date' || /(^date$|\.date$)/.test(field.key)) return '2026-09-' + String(1 + index).padStart(2, '0');
    if (['number', 'currency', 'percent'].includes(field.type)) return field.type === 'percent' ? (0.03 + index / 1000) : field.type === 'currency' ? 124.5 + index * 17.25 : index === 0 ? 0 : 180 + index * 57;
    if (field.type === 'boolean') return index % 2 === 0;
    if (/currency/i.test(field.key)) return 'EUR';
    if (/time.?zone/i.test(field.key)) return 'Europe/Athens';
    if (/campaign|name/i.test(field.key)) return ['Brand search', 'Summer collection', 'Remarketing'][index % 3];
    if (/source/i.test(field.key)) return ['google', 'facebook', 'direct'][index % 3];
    if (/medium/i.test(field.key)) return ['cpc', 'paid_social', 'none'][index % 3];
    if (/status|stage/i.test(field.key)) return ['Active', 'Review', 'Complete'][index % 3];
    if (/id/i.test(field.key)) return String(100001 + index);
    return 'Sample ' + (index + 1);
  }
  const handlers = {
    dmvBootstrap: () => copy(data),
    dmvDiscoverAccounts(input) {
      window.DATAMOOV_PREVIEW_LAST_ACCOUNT_REQUEST = copy(input);
      if (Array.isArray(window.DATAMOOV_PREVIEW_ACCOUNTS)) return { accounts: copy(window.DATAMOOV_PREVIEW_ACCOUNTS), complete: true };
      const keys = data.catalog.find(source => source.id === input.connectorId)?.accountDiscovery?.credentialKeys || [];
      return { accounts: [1, 2].map(index => ({ id: 'sample-account-' + index, label: 'Sample account ' + index,
        credentials: Object.fromEntries(keys.map(key => [key, key === 'loginCustomerId' ? '' : String(900000000 + index)])) })), complete: true };
    },
    dmvSaveConnection(input) {
      if (!input.label) throw new Error('Enter a connection name.');
      const source = data.catalog.find(item => item.id === input.connectorId);
      const previous = data.connections.find(item => item.id === input.id);
      const credentials = input.credentials || {};
      const secretKeys = source.authFields.filter(field => field.secret || field.type === 'password' || field.key === 'serviceAccountJson').map(field => field.key);
      const values = { ...previous?.values };
      Object.keys(credentials).filter(key => !secretKeys.includes(key)).forEach(key => { values[key] = credentials[key]; });
      const saved = { id: input.id || 'preview-connection-' + nextId++, label: input.label, connectorId: input.connectorId, values,
        configuredFields: Array.from(new Set([...(previous?.configuredFields || []), ...secretKeys.filter(key => credentials[key])])) };
      const index = data.connections.findIndex(item => item.id === saved.id);
      if (index < 0) data.connections.push(saved); else data.connections[index] = saved;
      return copy(saved);
    },
    dmvDeleteConnection(id) {
      if (data.reports.some(report => report.connectionId === id)) throw new Error('This connection is used by a saved report. Update or remove that report first.');
      data.connections = data.connections.filter(item => item.id !== id); return { ok: true };
    },
    dmvTestConnection: () => ({ ok: true, message: 'Preview connection is ready. No provider was contacted.' }),
    dmvSaveReport(report) {
      if (!report.fields?.length) throw new Error('Choose at least one column.');
      const saved = { ...copy(report), id: report.id || 'preview-report-' + nextId++ };
      const index = data.reports.findIndex(item => item.id === saved.id);
      if (index < 0) data.reports.push(saved); else data.reports[index] = { ...data.reports[index], ...saved };
      return copy(index < 0 ? saved : data.reports[index]);
    },
    dmvDeleteReport(id) { data.reports = data.reports.filter(item => item.id !== id); return { ok: true }; },
    dmvDiscoverFields(input) {
      if (Array.isArray(window.DATAMOOV_PREVIEW_DISCOVERY_FIELDS)) return copy(window.DATAMOOV_PREVIEW_DISCOVERY_FIELDS);
      const connection = data.connections.find(item => item.id === input.connectionId);
      const report = data.catalog.find(source => source.id === connection.connectorId).reports.find(item => item.id === input.reportType);
      return copy(report.fields.length ? report.fields : [{ key: 'date', label: 'Date', type: 'date', default: true }, { key: 'orders', label: 'Orders', type: 'number', default: true }, { key: 'revenue', label: 'Revenue', type: 'currency', default: true }]);
    },
    dmvPreviewReport(report) {
      const columns = sampleColumns(report);
      return { columns, rows: Array.from({ length: 8 }, (_, index) => Object.fromEntries(columns.map(field => [field.key, sampleValue(field, index)]))), totalRows: 8,
        metadata: { currency: 'EUR', timezone: 'Europe/Athens', warnings: ['Sample data for interface preview. No provider requests or spreadsheet writes.'] } };
    },
    dmvRunReport(id) {
      const report = data.reports.find(item => item.id === id);
      if (!report) throw new Error('Report not found.');
      if (window.DATAMOOV_PREVIEW_PENDING_NEXT) {
        const result = copy(window.DATAMOOV_PREVIEW_PENDING_NEXT);
        delete window.DATAMOOV_PREVIEW_PENDING_NEXT;
        report.status = 'paused'; report.fetchedRowCount = result.rowCount; delete report.lastError;
        return result;
      }
      report.lastRun = new Date().toISOString(); report.lastRowCount = 8; report.status = 'success'; delete report.lastError;
      delete report.fetchedRowCount;
      return { ok: true, rowCount: 8, updatedAt: report.lastRun };
    },
  };
  function runner(success, failure) {
    return new Proxy({}, { get(_, name) {
      if (name === 'withSuccessHandler') return next => runner(next, failure);
      if (name === 'withFailureHandler') return next => runner(success, next);
      return (...args) => setTimeout(() => {
        try {
          if (!handlers[name]) throw new Error('Unknown preview method: ' + name);
          if (window.DATAMOOV_PREVIEW_FAIL_NEXT === name) { window.DATAMOOV_PREVIEW_FAIL_NEXT = ''; throw new Error('Simulated request failure. Your form values are preserved.'); }
          const result = handlers[name](...args); if (success) success(result);
        } catch (error) { if (failure) failure(error); }
      }, 250);
    } });
  }
  window.google = { script: { get run() { return runner(); } } };
}

export async function renderPreview() {
  let html = await readFile(path.join(root, 'src/dmv_sidebar.html'), 'utf8');
  for (const filename of ['dmv_styles', 'dmv_client']) {
    html = html.replace("<?!= include('" + filename + "'); ?>", await readFile(path.join(root, 'src/' + filename + '.html'), 'utf8'));
  }
  const fixture = JSON.stringify(previewFixture(await previewCatalog())).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return html.replace('</head>', '<script>(' + installPreview.toString() + ')(' + fixture + ');</script></head>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(async (request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'GET' || !['/', '/?width=300'].includes(request.url)) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const html = await renderPreview();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Preview could not load: ' + error.message);
    }
  });
  server.listen(port, host, () => console.log('DataMoov local preview: http://' + host + ':' + port + ' (sample data; no live writes)'));
}
