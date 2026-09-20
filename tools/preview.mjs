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
    dashboards: [],
    sheetNames: ['Campaigns', 'Website', 'Deals', 'New report'],
    defaultTarget: { sheetName: 'New report', startCell: 'A1' },
    dateTimezone: 'Europe/Athens',
    limits: { maxRows: 20000, defaultRows: 1000 },
    branding: { name: 'DataMoov' },
    ai: { configured: false, debug: true, maxRows: 10000, providers: aiProviders },
  };
}

// This function is stringified into the localhost preview. It has no network or
// Google APIs. Every mutation only changes its disposable in-memory fixture.
function installPreview(initial) {
  window.DATAMOOV_LOCAL_PREVIEW = true;
  const data = structuredClone(initial);
  const copy = (value) => structuredClone(value);
  let nextId = 1;
  const chatProgress = new Map();
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
    dmvCredentialSample() {
      const value = (field, connectorId) => {
        if (field.type === 'select') {
          const chosen = field.default === undefined ? (field.options || [])[0] : field.default;
          return typeof chosen === 'object' && chosen ? chosen.value : chosen || '';
        }
        if (field.default !== undefined && field.default !== null && field.type !== 'password')
          return field.default;
        if (field.type === 'number') return 0;
        return (
          'REPLACE_' +
          String(field.key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase() +
          (connectorId ? '_' + connectorId.toUpperCase() : '')
        );
      };
      const values = (fields, connectorId) =>
        Object.fromEntries((fields || []).map((field) => [field.key, value(field, connectorId)]));
      return {
        fileName: 'datamoov-credentials-sample.json',
        json: JSON.stringify(
          {
            version: 1,
            credentials: data.credentialFamilies.map((family) => ({
              ref: family.id,
              label: family.label + ' (sample)',
              family: family.id,
              values: values(family.fields, family.connectors.length === 1 ? family.id : ''),
            })),
            connections: data.catalog.map((source) => ({
              ref: source.id,
              label: source.label + ' (sample)',
              connectorId: source.id,
              credentialRef: source.credentialFamily || source.id,
              credentials: values(
                (source.authFields || []).filter((field) => field.perConnection),
                source.id
              ),
            })),
          },
          null,
          2
        ),
      };
    },
    dmvImportCredentials(bundle) {
      if (window.DATAMOOV_PREVIEW_IMPORT_RESULT) return copy(window.DATAMOOV_PREVIEW_IMPORT_RESULT);
      if (
        !bundle ||
        bundle.version !== 1 ||
        !Array.isArray(bundle.credentials) ||
        !Array.isArray(bundle.connections)
      )
        throw new Error('Choose a valid DataMoov credentials file.');
      const result = { credentials: [], connections: [] },
        refs = new Map();
      for (const item of bundle.credentials) {
        try {
          const existing = data.credentials.find(
            (value) => value.family === item.family && value.label === item.label
          );
          const saved = existing || handlers.dmvSaveCredential(item);
          refs.set(item.ref, saved.id);
          result.credentials.push({
            ref: item.ref,
            label: item.label,
            status: existing ? 'existing' : 'saved',
            id: saved.id,
          });
        } catch {
          result.credentials.push({
            ref: item.ref,
            label: item.label,
            status: 'failed',
            message: 'Could not import this credential. Check its settings and try again.',
          });
        }
      }
      for (const item of bundle.connections) {
        try {
          const credentialId = refs.get(item.credentialRef);
          if (!credentialId) throw new Error('Credential unavailable');
          const existing = data.connections.find(
            (value) =>
              value.connectorId === item.connectorId &&
              value.credentialId === credentialId &&
              value.label === item.label
          );
          const saved = existing || handlers.dmvSaveConnection({ ...item, credentialId });
          result.connections.push({
            label: item.label,
            status: existing ? 'existing' : 'saved',
            id: saved.id,
          });
        } catch {
          result.connections.push({
            label: item.label,
            status: 'failed',
            message:
              'Could not verify this connection. Check access with the provider and try again.',
          });
        }
      }
      result.summary = Object.fromEntries(
        ['credentials', 'connections'].map((kind) => [
          kind,
          Object.fromEntries(
            ['saved', 'existing', 'failed'].map((status) => [
              status,
              result[kind].filter((item) => item.status === status).length,
            ])
          ),
        ])
      );
      return result;
    },
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
      const previous = data.reports.find((item) => item.id === report.id);
      if (report.id && !previous) throw new Error('Report not found.');
      const saved = {
        ...previous,
        ...copy(report),
        id: previous?.id || 'preview-report-' + nextId++,
        schedule: report.schedule || 'manual',
      };
      const index = previous ? data.reports.indexOf(previous) : -1;
      if (index < 0) data.reports.push(saved);
      else data.reports[index] = saved;
      return copy(saved);
    },
    dmvDeleteReport(id) {
      if (!data.reports.some((item) => item.id === id)) throw new Error('Report not found.');
      data.reports = data.reports.filter((item) => item.id !== id);
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
    dmvListDashboards: () => copy(data.dashboards || []),
    dmvSaveDashboard(input) {
      data.dashboards ||= [];
      const previous = input.id ? data.dashboards.find((item) => item.id === input.id) : null;
      if (input.id && !previous) throw new Error('Dashboard not found.');
      const saved = {
        id: previous?.id || 'dashboard-' + nextId++,
        name: input.name,
        sourceCount: input.sources?.length || 2,
        sourceLabels: input.sources?.map((source) => source.label) || [
          'Google Ads',
          'Facebook Ads',
        ],
        dataTarget: copy(input.dataTarget || { sheetName: 'Dashboard data', startCell: 'A1' }),
        target: copy(input.target || { sheetName: 'Performance dashboard', startCell: 'A1' }),
        status: 'ready',
        statusMessage: 'Ready to fetch all sources.',
        revision: (previous?.revision || 0) + 1,
      };
      if (previous) Object.assign(previous, saved);
      else data.dashboards.push(saved);
      return copy(saved);
    },
    async dmvRunDashboard(id) {
      const saved = (data.dashboards || []).find((item) => item.id === id);
      if (!saved) throw new Error('Dashboard not found.');
      saved.status = 'running';
      saved.lastError = '';
      for (const phase of [
        'Fetching every source',
        'Combining data and building the report',
        'Updating both tabs',
      ]) {
        saved.statusMessage = phase;
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
      Object.assign(saved, {
        status: 'success',
        statusMessage: 'Both tabs updated.',
        lastRun: new Date().toISOString(),
        lastRowCount: 12,
        lastDataRowCount: 576,
        dataUrl:
          'https://docs.google.com/spreadsheets/d/datamoov-preview-only/edit#gid=901&range=A1',
        reportUrl:
          'https://docs.google.com/spreadsheets/d/datamoov-preview-only/edit#gid=902&range=A1',
      });
      return {
        ok: true,
        id,
        rowCount: 12,
        dataRowCount: 576,
        updatedAt: saved.lastRun,
        target: copy(saved.target),
        dataTarget: copy(saved.dataTarget),
        dataUrl: saved.dataUrl,
        reportUrl: saved.reportUrl,
      };
    },
    dmvDeleteDashboard(id) {
      data.dashboards = (data.dashboards || []).filter((item) => item.id !== id);
      return { ok: true };
    },
    dmvAiSettings() {
      return {
        ...copy(data.ai),
        instructionCharacters:
          (data.ai.instructions || '').length +
          Object.values(data.ai.sourceInstructions || {}).reduce(
            (sum, value) => sum + value.length,
            0
          ) +
          Object.values(data.ai.connectionInstructions || {}).reduce(
            (sum, value) => sum + value.length,
            0
          ),
        maxInstructionCharacters: 100000,
      };
    },
    dmvConnectionChatInstructions(connectionId) {
      const connection = data.connections.find((item) => item.id === connectionId);
      if (!connection) throw new Error('This connection no longer exists.');
      const map = data.ai.connectionInstructions || {};
      const stored = Object.hasOwn(map, connectionId);
      const instructions = stored ? map[connectionId] : '';
      const legacy = data.ai.sourceInstructions?.[connection.connectorId] || '';
      return {
        connectionId,
        connectorId: connection.connectorId,
        label: connection.label,
        configured: !!data.ai.configured,
        instructions,
        effectiveInstructions: stored ? instructions : legacy,
        inherited: !stored && !!legacy,
        totalCharacters: handlers.dmvAiSettings().instructionCharacters,
        replacedCharacters:
          instructions.length +
          (legacy &&
          !data.connections.some(
            (item) =>
              item.id !== connectionId &&
              item.connectorId === connection.connectorId &&
              !Object.hasOwn(map, item.id)
          )
            ? legacy.length
            : 0),
        maxCharacters: 100000,
        revision: data.ai.instructionRevision || 0,
      };
    },
    dmvSaveConnectionChatInstructions(input) {
      const current = handlers.dmvConnectionChatInstructions(input.connectionId);
      if (!current.configured) throw new Error('Set up your AI provider in Settings first.');
      if (input.revision !== current.revision)
        throw new Error('Instructions changed. Reopen this connection before saving.');
      if (
        typeof input.instructions !== 'string' ||
        current.totalCharacters - current.replacedCharacters + input.instructions.length > 100000
      )
        throw new Error('Keep all instructions within 100,000 characters combined.');
      data.ai.connectionInstructions ||= {};
      if (current.replacedCharacters > current.instructions.length)
        delete data.ai.sourceInstructions[current.connectorId];
      data.ai.connectionInstructions[input.connectionId] = input.instructions;
      data.ai.instructionRevision = current.revision + 1;
      return handlers.dmvConnectionChatInstructions(input.connectionId);
    },
    dmvSaveAiSettings(input) {
      const provider = data.ai.providers.find((item) => item.id === input.provider);
      if (!provider) throw new Error('Choose a supported AI provider.');
      if (!input.apiKey && !(data.ai.configured && data.ai.provider === input.provider))
        throw new Error('Paste the API key for ' + provider.label + '.');
      const maxRows = input.maxRows === undefined ? data.ai.maxRows || 10000 : input.maxRows;
      if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 20000)
        throw new Error(
          'Maximum rows per chat report must be a whole number between 1 and 20,000.'
        );
      const instructions =
        input.instructions === undefined ? data.ai.instructions || '' : input.instructions;
      const sourceInstructions =
        input.sourceInstructions === undefined
          ? data.ai.sourceInstructions || {}
          : input.sourceInstructions;
      if (
        typeof instructions !== 'string' ||
        !sourceInstructions ||
        Array.isArray(sourceInstructions) ||
        typeof sourceInstructions !== 'object'
      )
        throw new Error('Chat instructions must be text.');
      if (
        Object.entries(sourceInstructions).some(
          ([id, text]) =>
            typeof text !== 'string' || !data.catalog.some((source) => source.id === id)
        )
      )
        throw new Error('Choose an available source for its chat instructions.');
      if (
        instructions.length +
          Object.values(sourceInstructions).reduce((total, value) => total + value.length, 0) +
          Object.values(data.ai.connectionInstructions || {}).reduce(
            (total, value) => total + value.length,
            0
          ) >
        100000
      )
        throw new Error(
          'General and source instructions together may contain at most 100,000 characters.'
        );
      const debug = input.debug === undefined ? data.ai.debug !== false : input.debug;
      if (typeof debug !== 'boolean') throw new Error('Show actions must be true or false.');
      data.ai = {
        ...data.ai,
        debug,
        maxRows,
        sourceInstructions: copy(sourceInstructions),
        instructionRevision: (data.ai.instructionRevision || 0) + 1,
        configured: true,
        provider: provider.id,
        providerLabel: provider.label,
        model: input.model || provider.defaultModel,
        instructions,
      };
      return handlers.dmvAiSettings();
    },
    dmvDeleteAiSettings() {
      data.ai = { configured: false, debug: true, maxRows: 10000, providers: data.ai.providers };
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
    dmvChatProgress(input) {
      return copy(
        chatProgress.get(input.requestId) || {
          requestId: input.requestId,
          status: 'unavailable',
          steps: [],
          updatedAt: 0,
        }
      );
    },
    async dmvChat(input) {
      if (!data.ai.configured)
        throw new Error('Add an AI provider and API key under Settings first.');
      const text = String(input.text || '');
      const progress = {
        requestId: input.requestId,
        status: 'running',
        steps: [],
        updatedAt: Date.now(),
      };
      const progressStep = async (label) => {
        const step = { id: progress.steps.length + 1, state: 'running', text: label };
        progress.steps.push(step);
        progress.updatedAt = Date.now();
        if (input.requestId) chatProgress.set(input.requestId, copy(progress));
        await new Promise((resolve) =>
          setTimeout(resolve, window.DATAMOOV_PREVIEW_CHAT_STEP_MS || 600)
        );
        step.state = 'complete';
        progress.updatedAt = Date.now();
        if (input.requestId) chatProgress.set(input.requestId, copy(progress));
      };
      const finish = (reply) => {
        progress.status = reply.failed ? 'failed' : 'complete';
        progress.updatedAt = Date.now();
        if (input.requestId) chatProgress.set(input.requestId, copy(progress));
        return copy(reply);
      };
      await progressStep('Working on your request');
      if (window.DATAMOOV_PREVIEW_CHAT_REPLY) return finish(window.DATAMOOV_PREVIEW_CHAT_REPLY);
      if (/dashboard/i.test(text)) {
        const saved = handlers.dmvSaveDashboard({
          name: 'Performance dashboard',
          sources: [{ label: 'Google Ads' }, { label: 'Facebook Ads' }],
        });
        await progressStep('Fetching dashboard sources');
        const result = await handlers.dmvRunDashboard(saved.id);
        const answer =
          '**Dashboard created.**\n\n- Data tab: **' +
          result.dataTarget.sheetName +
          '**\n- Report tab: **' +
          result.target.sheetName +
          '**\n\nUse **Reports > Dashboards > Refresh dashboard** to fetch both sources and rebuild both tabs. (Sample preview data.)';
        const events = [
          {
            kind: 'dashboard',
            action: 'refreshed',
            text: 'Saved dashboard with 2 sources.',
            links: [
              { label: 'Report: ' + result.target.sheetName + ' (preview)', url: result.reportUrl },
              { label: 'Data: ' + result.dataTarget.sheetName + ' (preview)', url: result.dataUrl },
            ],
          },
          { kind: 'write', text: 'Updated the data and report tabs.' },
        ];
        return finish({
          text: answer,
          events,
          transcriptAppend: [
            { role: 'user', text },
            { role: 'assistant', text: answer, actions: events.map((event) => event.text) },
          ],
        });
      }
      if (/which|\?$/i.test(text) && !/^Use /.test(text) && !/highest|chart/i.test(text)) {
        return finish({
          text: 'Which source do you mean?',
          events: [],
          options: ['Google Ads', 'Facebook Ads'],
          transcriptAppend: [
            { role: 'user', text },
            { role: 'assistant', text: 'Which source do you mean?', actions: [] },
          ],
        });
      }
      await progressStep('Fetching report data');
      await progressStep('Summarizing data');
      await progressStep('Writing to Sheets');
      if (/chart/i.test(text)) await progressStep('Creating a chart');
      const events = [
        {
          kind: 'report',
          text: 'Ran Google Ads (Marketing account) · Daily campaign performance · 248 rows',
        },
        { kind: 'summary', text: 'Summarized 248 rows into 6' },
        {
          kind: 'write',
          text: 'Wrote 6 rows to Spend by campaign!A1:C7',
          links: [
            {
              label: 'Spend by campaign (preview)',
              url: 'https://docs.google.com/spreadsheets/d/datamoov-preview-only/edit#gid=903&range=A1',
            },
          ],
        },
      ];
      if (/chart/i.test(text))
        events.push({
          kind: 'chart',
          text: 'Added a column chart "Spend by campaign" on Spend by campaign',
        });
      const answer =
        '**Brand search** spent **EUR 4,120.50**, Summer collection EUR 2,310.00 and Remarketing EUR 980.25. The table is in Spend by campaign!A1:C7. (Google Ads, last 30 days; preview data)';
      return finish({
        text: answer,
        events,
        options: null,
        transcriptAppend: [
          { role: 'user', text },
          { role: 'assistant', text: answer, actions: events.map((event) => event.text) },
        ],
      });
    },
    dmvRunReport(id) {
      const report = data.reports.find((item) => item.id === id);
      if (!report) throw new Error('Report not found.');
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
                Promise.resolve(result).then(
                  (value) => {
                    if (success) success(value);
                  },
                  (error) => {
                    if (failure) failure(error);
                  }
                );
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
