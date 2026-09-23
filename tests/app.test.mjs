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

test('complete production bundle registers twelve offered sources and fifty-two reports without Google services', () => {
  const app = loadProduction();
  const catalog = app.dmvCatalog_();
  assert.deepEqual(Array.from(catalog, connector => connector.id).sort(),
    ['bigquery', 'facebook_ads', 'ga4', 'github', 'google_ads', 'hubspot', 'linkedin_ads', 'microsoft_ads', 'postgres', 'search_console', 'snowflake', 'zendesk']);
  assert.equal(catalog.reduce((count, connector) => count + connector.reports.length, 0), 52);
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

test('every offered source ships an official brand mark the browser can rebuild safely', () => {
  const app = loadProduction();
  const pathCommands = /^[MmLlHhVvCcSsQqTtAaZz0-9eE ,.+-]+$/;
  for (const connector of app.dmvCatalog_()) {
    const icon = connector.icon;
    assert.ok(icon, connector.id + ' declares an icon');
    assert.match(icon.viewBox, /^-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+$/, connector.id + ' viewBox');
    assert.ok(icon.shapes.length, connector.id + ' has at least one path');
    for (const shape of icon.shapes) {
      // Only geometry and colour cross the boundary: no markup, no url(), no remote reference.
      assert.match(shape.d, pathCommands, connector.id + ' path data is geometry only');
      assert.match(shape.fill, /^#[0-9a-f]{6}$/, connector.id + ' fill is a plain hex colour');
      assert.deepEqual(
        Object.keys(shape).filter(key => !['d', 'fill', 'rule', 'opacity'].includes(key)),
        [], connector.id + ' carries no extra icon attributes');
      if ('rule' in shape) assert.equal(shape.rule, 'evenodd');
      if ('opacity' in shape) assert.ok(shape.opacity > 0 && shape.opacity < 1);
    }
  }
});

test('the icon validator drops anything that is not a filled path', () => {
  const app = loadProduction();
  // dmvIcon_ builds its record inside the application realm, so compare the JSON it produces.
  const built = icon => JSON.parse(JSON.stringify(app.dmvIcon_(icon) ?? null));
  const valid = { viewBox: '0 0 250 250', shapes: [{ d: 'M0 0h24v24H0z', fill: '#FF7A59' }] };
  assert.deepEqual(built(valid),
    { viewBox: '0 0 250 250', shapes: [{ d: 'M0 0h24v24H0z', fill: '#ff7a59' }] });
  assert.equal(app.dmvIcon_(null), null);
  assert.equal(app.dmvIcon_({ shapes: 'M0 0' }), null);
  assert.equal(app.dmvIcon_({ viewBox: '0 0 24', shapes: valid.shapes }), null, 'short viewBox');
  assert.equal(app.dmvIcon_({ viewBox: 'javascript:alert(1)', shapes: valid.shapes }), null);
  // A remote or scripted fill, a non-hex colour and stray markup all leave nothing behind.
  assert.equal(app.dmvIcon_({ shapes: [{ d: 'M0 0h24v24H0z', fill: 'url(#a)' }] }), null);
  assert.equal(app.dmvIcon_({ shapes: [{ d: 'M0 0h24v24H0z', fill: 'red' }] }), null);
  assert.equal(app.dmvIcon_({ shapes: [{ d: '"/><script>x()</script>', fill: '#000000' }] }), null);
  assert.equal(app.dmvIcon_({ shapes: [{ d: 'M0 0 url(#a)', fill: '#000000' }] }), null);
  const mixed = built({ shapes: [
    { d: 'M0 0h2v2H0z', fill: '#000000', rule: 'evenodd', opacity: 0.07, extra: 'dropped' },
    { d: 'M0 0h2v2H0z', fill: '#000000', rule: 'nonzero', opacity: 4 },
  ] });
  assert.equal(mixed.viewBox, '0 0 24 24', 'a mark without a viewBox falls back to the 24 grid');
  assert.deepEqual(mixed.shapes, [
    { d: 'M0 0h2v2H0z', fill: '#000000', rule: 'evenodd', opacity: 0.07 },
    { d: 'M0 0h2v2H0z', fill: '#000000' },
  ]);
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
      { label: 'Open', handler: 'showSidebar' },
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