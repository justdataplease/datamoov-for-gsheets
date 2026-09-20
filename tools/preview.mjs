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
  const connectorFiles = (await readdir(path.join(root, 'src/connectors')))
    .filter((name) => name.endsWith('.js'))
    .sort();
  for (const name of [
    'dmv_core.js',
    'dmv_connector_helpers.js',
    'dmv_credentials.js',
    'dmv_ai.js',
    ...connectorFiles.map((name) => 'connectors/' + name),
  ]) {
    const source = await readFile(path.join(root, 'src', name), 'utf8');
    new vm.Script(source, { filename: name }).runInContext(context, { timeout: 1000 });
  }
  return JSON.parse(JSON.stringify(context.dmvCatalog_()));
}

export async function previewFamilies() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const connectorFiles = (await readdir(path.join(root, 'src/connectors')))
    .filter((name) => name.endsWith('.js'))
    .sort();
  for (const name of [
    'dmv_core.js',
    'dmv_connector_helpers.js',
    'dmv_credentials.js',
    ...connectorFiles.map((name) => 'connectors/' + name),
  ]) {
    const source = await readFile(path.join(root, 'src', name), 'utf8');
    new vm.Script(source, { filename: name }).runInContext(context, { timeout: 1000 });
  }
  return JSON.parse(JSON.stringify(context.dmvFamilyCatalog_()));
}

export async function previewAiProviders() {
  const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(await readFile(path.join(root, 'src/dmv_ai.js'), 'utf8'), {
    filename: 'dmv_ai.js',
  }).runInContext(context, { timeout: 1000 });
  return JSON.parse(JSON.stringify(context.dmvAiCatalog_()));
}

export function previewFixture(catalog, aiProviders = [], families = []) {
  // Families may be derived from the catalog when the caller has none (unit tests).
  const credentialFamilies = families.length
    ? families
    : Object.values(
        catalog.reduce((all, source) => {
          const id = source.credentialFamily || source.id;
          const fields = (source.authFields || []).filter((field) => !field.perConnection);
          if (!fields.length) return all;
          all[id] ||= {
            id,
            label: id === 'google' ? 'Google Cloud' : source.label,
            fields,
            guide: source.guide || null,
            connectors: [],
          };
          all[id].connectors.push(source.id);
          return all;
        }, {})
      );
  const isSecret = (field) =>
    field.secret || field.type === 'password' || field.key === 'serviceAccountJson';
  const credentials = credentialFamilies.map((fam) => ({
    id: 'demo-credential-' + fam.id,
    label: fam.label + ' · Demo key',
    family: fam.id,
    familyLabel: fam.label,
    values: Object.fromEntries(
      fam.fields
        .filter((field) => !isSecret(field))
        .map((field) => [
          field.key,
          field.default ??
            ({ email: 'demo@example.com', username: 'report_reader' }[field.key] || ''),
        ])
    ),
    configuredFields: fam.fields
      .filter(isSecret)
      .filter(
        (field) =>
          !field.showWhen ||
          [field.showWhen.value]
            .flat()
            .includes(fam.fields.find((item) => item.key === field.showWhen.key)?.default ?? '')
      )
      .map((field) => field.key),
    usedBy: fam.connectors.length,
  }));
  const connections = catalog.map((source, index) => ({
    id: 'demo-' + source.id,
    label:
      source.label + (source.category === 'Database' ? ' · Demo warehouse' : ' · Demo account'),
    connectorId: source.id,
    credentialId: 'demo-credential-' + (source.credentialFamily || source.id),
    values: Object.fromEntries(
      (source.authFields || [])
        .filter(
          (field) =>
            !field.secret && field.type !== 'password' && field.key !== 'serviceAccountJson'
        )
        .map((field) => [
          field.key,
          field.default ??
            ({
              customerId: '1234567890',
              propertyId: '123456789',
              subdomain: 'demo-team',
              email: 'demo@example.com',
              host: 'localhost',
              database: 'analytics',
              username: 'report_reader',
            }[field.key] ||
              ''),
        ])
    ),
    configuredFields: (source.authFields || [])
      .filter(
        (field) => field.secret || field.type === 'password' || field.key === 'serviceAccountJson'
      )
      .filter(
        (field) =>
          !field.showWhen ||
          [field.showWhen.value]
            .flat()
            .includes(
              source.authFields.find((item) => item.key === field.showWhen.key)?.default ?? ''
            )
      )
      .map((field) => field.key),
  }));
  const featured = ['google_ads', 'ga4', 'hubspot']
    .map((id) => catalog.find((source) => source.id === id))
    .filter(Boolean);
  const reports = featured.map((source, index) => {
    const report = source.reports[0];
    return {
      id: 'demo-report-' + index,
      definitionId: 'demo-definition-' + index,
      connectionRequired: false,
      approvalRequired: false,
      name: ['Campaign performance', 'Website acquisition', 'Sales pipeline'][index],
      connectorId: source.id,
      connectionId: 'demo-' + source.id,
      reportType: report.id,
      fields: report.fields
        .filter((field) =>
          report.fields.some((item) => typeof item.default === 'boolean')
            ? field.default === true
            : field.default !== false
        )
        .map((field) => field.key),
      config: Object.fromEntries(
        (report.configFields || []).map((field) => [field.key, field.default ?? ''])
      ),
      dateRange: { preset: 'last30' },
      target: { sheetName: ['Campaigns', 'Website', 'Deals'][index], startCell: 'A1' },
      maxRows: 1000,
      schedule: index === 2 ? 'manual' : 'daily',
      status: 'success',
      lastRun: '2026-09-18T08:30:00.000Z',
      lastRowCount: [248, 86, 32][index],
    };
  });
  return {
    catalog,
    credentialFamilies,
    credentials,
    connections,
    reports,
    sheetNames: ['Campaigns', 'Website', 'Deals', 'New report'],
    defaultTarget: { sheetName: 'New report', startCell: 'A1' },
    dateTimezone: 'Europe/Athens',
    limits: { maxRows: 20000, defaultRows: 1000 },
    branding: { name: 'DataMoov' },
    ai: { configured: false, providers: aiProviders },
  };
}

// This function is stringified into the localhost preview. It has no network or
// Google APIs. Every mutation only changes its disposable in-memory fixture.
function installPreview(initial) {
  window.DATAMOOV_LOCAL_PREVIEW = true;
  const data = structuredClone(initial);
  const copy = (value) => structuredClone(value);
  let nextId = 1;
  function reportFingerprint(report) {
    return JSON.stringify(
      [
        'name',
        'connectorId',
        'reportType',
        'fields',
        'config',
        'dateRange',
        'target',
        'maxRows',
      ].map((key) => report[key] ?? null)
    );
  }
  data.reports.forEach((report) => {
    report.definitionId ||= report.id;
    report.definitionFingerprint = reportFingerprint(report);
    report.connectionRequired = Boolean(report.connectionRequired || !report.connectionId);
    report.approvalRequired = Boolean(report.approvalRequired || report.definitionMissing);
    if (report.connectionRequired) {
      report.id = null;
      report.connectionId = '';
    }
    if (report.connectionRequired || report.approvalRequired) report.schedule = 'manual';
  });
  function findReport(input) {
    return data.reports.find((report) =>
      input.definitionId ? report.definitionId === input.definitionId : report.id === input.id
    );
  }
  function definition(report) {
    return data.catalog
      .find((source) => source.id === report.connectorId)
      ?.reports.find((item) => item.id === report.reportType);
  }
  function sampleColumns(report) {
    const def = definition(report);
    return (report.fields || []).map(
      (key) => def?.fields.find((field) => field.key === key) || { key, label: key, type: 'text' }
    );
  }
  function sampleValue(field, index) {
    if (field.type === 'date' || /(^date$|\.date$)/.test(field.key))
      return '2026-09-' + String(1 + index).padStart(2, '0');
    if (['number', 'currency', 'percent'].includes(field.type))
      return field.type === 'percent'
        ? 0.03 + index / 1000
        : field.type === 'currency'
          ? 124.5 + index * 17.25
          : index === 0
            ? 0
            : 180 + index * 57;
    if (field.type === 'boolean') return index % 2 === 0;
    if (/currency/i.test(field.key)) return 'EUR';
    if (/time.?zone/i.test(field.key)) return 'Europe/Athens';
    if (/campaign|name/i.test(field.key))
      return ['Brand search', 'Summer collection', 'Remarketing'][index % 3];
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
      if (Array.isArray(window.DATAMOOV_PREVIEW_ACCOUNTS))
        return { accounts: copy(window.DATAMOOV_PREVIEW_ACCOUNTS), complete: true };
      const keys =
        data.catalog.find((source) => source.id === input.connectorId)?.accountDiscovery
          ?.credentialKeys || [];
      return {
        accounts: [1, 2].map((index) => ({
          id: 'sample-account-' + index,
          label: 'Sample account ' + index,
          credentials: Object.fromEntries(
            keys.map((key) => [key, key === 'loginCustomerId' ? '' : String(900000000 + index)])
          ),
        })),
        complete: true,
      };
    },
    showWindow: () => ({ ok: true }),
    dmvSaveCredential(input) {
      if (!input.label) throw new Error('Enter a credential name.');
      const fam = data.credentialFamilies.find((item) => item.id === input.family);
      if (!fam) throw new Error('Choose a supported credential type.');
      const previous = data.credentials.find((item) => item.id === input.id);
      const secretKeys = fam.fields
        .filter(
          (field) => field.secret || field.type === 'password' || field.key === 'serviceAccountJson'
        )
        .map((field) => field.key);
      const values = { ...previous?.values };
      Object.keys(input.values || {})
        .filter((key) => !secretKeys.includes(key))
        .forEach((key) => {
          values[key] = input.values[key];
        });
      for (const field of fam.fields) {
        const visible =
          !field.showWhen ||
          [field.showWhen.value].flat().includes(String(values[field.showWhen.key] ?? ''));
        if (visible && field.required && !secretKeys.includes(field.key) && !values[field.key])
          throw new Error(field.label + ' is required.');
      }
      const saved = {
        id: input.id || 'preview-credential-' + nextId++,
        label: input.label,
        family: fam.id,
        familyLabel: fam.label,
        values,
        configuredFields: Array.from(
          new Set([
            ...(previous?.configuredFields || []),
            ...secretKeys.filter((key) => input.values?.[key]),
          ])
        ),
        usedBy: data.connections.filter((item) => item.credentialId === input.id).length,
        verified: fam.id === 'google' && values.authMode !== 'token',
      };
      const index = data.credentials.findIndex((item) => item.id === saved.id);
      if (index < 0) data.credentials.push(saved);
      else data.credentials[index] = saved;
      return copy(saved);
    },
    dmvDeleteCredential(id) {
      const users = data.connections.filter((item) => item.credentialId === id);
      if (users.length)
        throw new Error(
          'This credential is used by ' +
            users.map((item) => item.label).join(', ') +
            '. Point those connections at another credential first.'
        );
      data.credentials = data.credentials.filter((item) => item.id !== id);
      return { ok: true };
    },
    dmvSaveConnection(input) {
      if (!input.label) throw new Error('Enter a connection name.');
      const source = data.catalog.find((item) => item.id === input.connectorId);
      const previous = data.connections.find((item) => item.id === input.id);
      const credential = data.credentials.find((item) => item.id === input.credentialId);
      if (input.credentialId && !credential)
        throw new Error('This credential no longer exists. Refresh the sidebar.');
      const credentials = { ...(credential?.values || {}), ...(input.credentials || {}) };
      const secretKeys = source.authFields
        .filter(
          (field) => field.secret || field.type === 'password' || field.key === 'serviceAccountJson'
        )
        .map((field) => field.key);
      const values = { ...previous?.values };
      Object.keys(credentials)
        .filter((key) => !secretKeys.includes(key))
        .forEach((key) => {
          values[key] = credentials[key];
        });
      const saved = {
        id: input.id || 'preview-connection-' + nextId++,
        label: input.label,
        connectorId: input.connectorId,
        credentialId: input.credentialId || null,
        values,
        configuredFields: Array.from(
          new Set([
            ...(previous?.configuredFields || []),
            ...secretKeys.filter((key) => credentials[key]),
          ])
        ),
      };
      const index = data.connections.findIndex((item) => item.id === saved.id);
      if (index < 0) data.connections.push(saved);
      else data.connections[index] = saved;
      return { ...copy(saved), verified: true };
    },
    dmvDeleteConnection(id) {
      if (data.reports.some((report) => report.connectionId === id))
        throw new Error(
          'This connection is used by a saved report. Update or remove that report first.'
        );
      data.connections = data.connections.filter((item) => item.id !== id);
      return { ok: true };
    },
    dmvTestConnection: () => ({
      ok: true,
      message: 'Preview connection is ready. No provider was contacted.',
    }),
    dmvSaveReport(report) {
      if (!report.fields?.length) throw new Error('Choose at least one column.');
      const connection = data.connections.find((item) => item.id === report.connectionId);
      if (!connection || connection.connectorId !== report.connectorId)
        throw new Error('Choose one of your connections for this source.');
      const previous = findReport(report);
      if ((report.id || report.definitionId) && (!previous || previous.definitionMissing))
        throw new Error('This shared report was removed. Refresh the report list.');
      if (previous && report.definitionFingerprint !== previous.definitionFingerprint)
        throw new Error('This shared report changed. Refresh the report list and open it again.');
      const saved = {
        ...previous,
        ...copy(report),
        id: previous?.id || 'preview-report-' + nextId++,
        definitionId: previous?.definitionId || 'preview-definition-' + nextId++,
        connectionRequired: false,
        approvalRequired: false,
        schedule: report.schedule || 'manual',
      };
      saved.definitionFingerprint = reportFingerprint(saved);
      const index = previous ? data.reports.indexOf(previous) : -1;
      if (index < 0) data.reports.push(saved);
      else data.reports[index] = saved;
      return copy(saved);
    },
    dmvDeleteReport(input) {
      const request = typeof input === 'string' ? { id: input } : input;
      const report = findReport(request);
      if (!report) throw new Error('Report not found.');
      if (
        !report.definitionMissing &&
        typeof input !== 'string' &&
        request.definitionFingerprint !== report.definitionFingerprint
      )
        throw new Error('This shared report changed. Refresh the report list before removing it.');
      data.reports = data.reports.filter((item) => item.definitionId !== report.definitionId);
      return { ok: true };
    },
    dmvDiscoverFields(input) {
      if (Array.isArray(window.DATAMOOV_PREVIEW_DISCOVERY_FIELDS))
        return copy(window.DATAMOOV_PREVIEW_DISCOVERY_FIELDS);
      const connection = data.connections.find((item) => item.id === input.connectionId);
      const report = data.catalog
        .find((source) => source.id === connection.connectorId)
        .reports.find((item) => item.id === input.reportType);
      return copy(
        report.fields.length
          ? report.fields
          : [
              { key: 'date', label: 'Date', type: 'date', default: true },
              { key: 'orders', label: 'Orders', type: 'number', default: true },
              { key: 'revenue', label: 'Revenue', type: 'currency', default: true },
            ]
      );
    },
    dmvPreviewReport(report) {
      const columns = sampleColumns(report);
      return {
        columns,
        rows: Array.from({ length: 8 }, (_, index) =>
          Object.fromEntries(columns.map((field) => [field.key, sampleValue(field, index)]))
        ),
        totalRows: 8,
        metadata: {
          currency: 'EUR',
          timezone: 'Europe/Athens',
          warnings: [
            'Sample data for interface preview. No provider requests or spreadsheet writes.',
          ],
        },
      };
    },
    dmvAiSettings: () => copy(data.ai),
    dmvSaveAiSettings(input) {
      const provider = data.ai.providers.find((item) => item.id === input.provider);
      if (!provider) throw new Error('Choose a supported AI provider.');
      if (!input.apiKey && !(data.ai.configured && data.ai.provider === input.provider))
        throw new Error('Paste the API key for ' + provider.label + '.');
      data.ai = {
        ...data.ai,
        configured: true,
        provider: provider.id,
        providerLabel: provider.label,
        model: input.model || provider.defaultModel,
        instructions: input.instructions || '',
      };
      return copy(data.ai);
    },
    dmvDeleteAiSettings() {
      data.ai = { configured: false, providers: data.ai.providers };
      return copy(data.ai);
    },
    dmvTestAi() {
      if (!data.ai.configured) throw new Error('Save an AI provider and API key first.');
      return {
        ok: true,
        message:
          data.ai.providerLabel +
          ' · ' +
          data.ai.model +
          ' replied: OK (preview, no provider was contacted)',
      };
    },
    dmvChat(input) {
      if (!data.ai.configured)
        throw new Error('Add an AI provider and API key under Settings first.');
      const text = String(input.text || '');
      if (/which|\?$/i.test(text) && !/^Use /.test(text) && !/highest|chart/i.test(text)) {
        return {
          text: 'Which source do you mean?',
          events: [],
          options: ['Google Ads', 'Facebook Ads'],
          transcriptAppend: [
            { role: 'user', text },
            { role: 'assistant', text: 'Which source do you mean?', actions: [] },
          ],
        };
      }
      const events = [
        {
          kind: 'report',
          text: 'Ran Google Ads (Marketing account) · Daily campaign performance · 248 rows',
        },
        { kind: 'summary', text: 'Summarized 248 rows into 6' },
        { kind: 'write', text: 'Wrote 6 rows to Spend by campaign!A1:C7' },
      ];
      if (/chart/i.test(text))
        events.push({
          kind: 'chart',
          text: 'Added a column chart "Spend by campaign" on Spend by campaign',
        });
      const answer =
        'Brand search spent EUR 4,120.50, Summer collection EUR 2,310.00 and Remarketing EUR 980.25. The table is in Spend by campaign!A1:C7. (Google Ads, last 30 days; preview data)';
      return {
        text: answer,
        events,
        options: null,
        transcriptAppend: [
          { role: 'user', text },
          { role: 'assistant', text: answer, actions: events.map((event) => event.text) },
        ],
      };
    },
    dmvRunReport(id) {
      const report = data.reports.find((item) => item.id === id);
      if (!report) throw new Error('Report not found.');
      if (report.definitionMissing || report.connectionRequired || report.approvalRequired)
        throw new Error('Open the shared report and save your connection and schedule first.');
      if (window.DATAMOOV_PREVIEW_PENDING_NEXT) {
        const result = copy(window.DATAMOOV_PREVIEW_PENDING_NEXT);
        delete window.DATAMOOV_PREVIEW_PENDING_NEXT;
        report.status = 'paused';
        report.fetchedRowCount = result.rowCount;
        delete report.lastError;
        return result;
      }
      report.lastRun = new Date().toISOString();
      report.lastRowCount = 8;
      report.status = 'success';
      delete report.lastError;
      delete report.fetchedRowCount;
      return { ok: true, rowCount: 8, updatedAt: report.lastRun };
    },
  };
  function runner(success, failure) {
    return new Proxy(
      {},
      {
        get(_, name) {
          if (name === 'withSuccessHandler') return (next) => runner(next, failure);
          if (name === 'withFailureHandler') return (next) => runner(success, next);
          return (...args) =>
            setTimeout(() => {
              try {
                if (!handlers[name]) throw new Error('Unknown preview method: ' + name);
                if (window.DATAMOOV_PREVIEW_FAIL_NEXT === name) {
                  window.DATAMOOV_PREVIEW_FAIL_NEXT = '';
                  throw new Error('Simulated request failure. Your form values are preserved.');
                }
                const result = handlers[name](...args);
                if (success) success(result);
              } catch (error) {
                if (failure) failure(error);
              }
            }, window.DATAMOOV_PREVIEW_DELAY_MS || 250);
        },
      }
    );
  }
  window.google = {
    script: {
      get run() {
        return runner();
      },
    },
  };
}

export async function renderPreview() {
  let html = await readFile(path.join(root, 'src/dmv_sidebar.html'), 'utf8');
  for (const filename of ['dmv_styles', 'dmv_client', 'dmv_client_chat']) {
    html = html.replace(
      "<?!= include('" + filename + "'); ?>",
      await readFile(path.join(root, 'src/' + filename + '.html'), 'utf8')
    );
  }
  const fixture = JSON.stringify(
    previewFixture(await previewCatalog(), await previewAiProviders(), await previewFamilies())
  )
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return html.replace(
    '</head>',
    '<script>(' + installPreview.toString() + ')(' + fixture + ');</script></head>'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(async (request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET' || !['/', '/?width=300'].includes(request.url)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    try {
      const html = await renderPreview();
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Preview could not load: ' + error.message);
    }
  });
  server.listen(port, host, () =>
    console.log(
      'DataMoov local preview: http://' + host + ':' + port + ' (sample data; no live writes)'
    )
  );
}
