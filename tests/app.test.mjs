import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
function collectServerFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? collectServerFiles(join(directory, entry.name))
      : ['.js', '.gs'].includes(extname(entry.name)) ? [join(directory, entry.name)] : [])
    .sort();
}
const source = collectServerFiles(sourceRoot)
  .map(filename => readFileSync(filename, 'utf8'))
  .join('\n;\n');

function loadProduction() {
  const unavailable = name => new Proxy(Object.create(null), {
    get() { throw new Error(name + ' is unavailable during application initialization'); },
  });
  const services = ['SpreadsheetApp', 'HtmlService', 'PropertiesService', 'UrlFetchApp',
    'ScriptApp', 'Jdbc', 'Sheets', 'Session', 'CacheService', 'LockService', 'Utilities', 'Logger', 'console'];
  const context = vm.createContext(Object.fromEntries(services.map(name => [name, unavailable(name)])),
    { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(source, { filename: 'complete-production-bundle.js' })
    .runInContext(context, { timeout: 1_000 });
  return context;
}

test('complete production bundle registers thirteen sources and fifteen reports without Google services', () => {
  const app = loadProduction();
  const catalog = app.dmvCatalog_();
  assert.deepEqual(Array.from(catalog, connector => connector.id).sort(),
    ['bigquery', 'facebook_ads', 'ga4', 'github', 'google_ads', 'hubspot', 'linkedin_ads', 'microsoft_ads', 'postgres', 'search_console', 'snowflake', 'tiktok_ads', 'zendesk']);
  assert.equal(catalog.reduce((count, connector) => count + connector.reports.length, 0), 15);
  for (const connector of catalog) {
    const guide = connector.guide;
    assert.ok(guide && (guide.steps?.length || guide.modes), connector.id + ' explains how to get its credentials');
    const links = [...(guide.links || []), ...Object.values(guide.modes || {}).flatMap((mode) => mode.links || [])];
    assert.ok(links.length, connector.id + ' links to the provider console');
    for (const link of links) assert.ok(link.url.startsWith('https://'), connector.id + ' guide links are https');
    const mode = connector.authFields.find((field) => field.key === 'authMode');
    if (mode) assert.ok(!mode.options.some((option) => option.value === 'native'), connector.id + ' never uses the add-on identity');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(catalog.filter((connector) => connector.describesTables).map((connector) => connector.id))), ['bigquery', 'postgres', 'snowflake']);
});

test('the sample credential bundle covers every source and carries no usable secret', () => {
  const app = loadProduction();
  const sample = app.dmvCredentialSample();
  assert.equal(sample.fileName, 'datamoov-credentials-sample.json');
  const bundle = JSON.parse(sample.json);
  assert.equal(bundle.version, 1);
  assert.deepEqual(
    bundle.connections.map((connection) => connection.connectorId),
    Array.from(app.dmvCatalog_(), (connector) => connector.id).sort()
  );
  // Every connection resolves to a credential in the same file, of that source's own type.
  const byRef = new Map(bundle.credentials.map((credential) => [credential.ref, credential]));
  assert.equal(byRef.size, bundle.credentials.length);
  for (const connection of bundle.connections) {
    const credential = byRef.get(connection.credentialRef);
    assert.ok(credential, connection.connectorId + ' references a credential in the bundle');
    assert.equal(credential.family, connection.credentialRef);
  }
  assert.ok(bundle.credentials.length <= 20 && bundle.connections.length <= 20);
  assert.ok(sample.json.length <= 250000);
  // A shipped file must never look like a real key.
  assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sample.json), false);
  assert.equal(/(ghp_|github_pat_|sk-|EAA[A-Za-z0-9]{20})/.test(sample.json), false);
  for (const credential of bundle.credentials)
    for (const [key, value] of Object.entries(credential.values))
      assert.equal(
        typeof value === 'string' ? /REPLACE|^$/.test(value) || value.length < 40 : true,
        true,
        credential.ref + '.' + key + ' is a placeholder'
      );
});

test('open and install entry points build the Extensions add-on menu with existing application handlers', () => {
  const app = loadProduction();
  const menus = [];
  app.SpreadsheetApp = { getUi: () => ({
    createAddonMenu() {
      const menu = { items: [], added: false,
        addItem(label, handler) { this.items.push({ label, handler }); return this; },
        addToUi() { this.added = true; },
      };
      menus.push(menu);
      return menu;
    },
  }) };
  app.onOpen();
  app.onInstall();
  assert.equal(menus.length, 2);
  for (const menu of menus) {
    assert.equal(menu.added, true);
    assert.deepEqual(menu.items, [
      { label: 'Open DataMoov', handler: 'showSidebar' },
      { label: 'Open DataMoov in a window', handler: 'showWindow' },
    ]);
    for (const item of menu.items) assert.equal(typeof app[item.handler], 'function', item.handler);
  }
});

test('sidebar uses the production template and includes only its two approved partials', () => {
  const app = loadProduction();
  const requestedTemplates = [];
  const requestedIncludes = [];
  const displayed = [];
  const output = { title: null, setTitle(title) { this.title = title; return this; } };
  app.HtmlService = {
    createTemplateFromFile(name) {
      requestedTemplates.push(name);
      assert.match(readFileSync(join(sourceRoot, name + '.html'), 'utf8'), /<!doctype html>/i);
      return { evaluate: () => output };
    },
    createHtmlOutputFromFile(name) {
      requestedIncludes.push(name);
      return { getContent: () => readFileSync(join(sourceRoot, name + '.html'), 'utf8') };
    },
  };
  app.SpreadsheetApp = { getUi: () => ({ showSidebar: html => displayed.push(html) }) };
  app.showSidebar();
  assert.deepEqual(requestedTemplates, ['dmv_sidebar']);
  assert.deepEqual(displayed, [output]);
  assert.equal(output.title, 'DataMoov by JustDataPlease');
  for (const name of ['dmv_styles', 'dmv_client', 'dmv_client_chat']) {
    assert.equal(app.include(name), readFileSync(join(sourceRoot, name + '.html'), 'utf8'));
  }
  assert.equal(app.dmvCatalog_().length >= 8, true);
  for (const name of ['dmv_reports', '../dmv_client', 'index', 'dmv_chat']) {
    assert.throws(() => app.include(name), /Unknown DataMoov template/);
  }
  assert.deepEqual(requestedIncludes, ['dmv_styles', 'dmv_client', 'dmv_client_chat'], 'rejected filenames never reach HtmlService');
});