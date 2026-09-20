import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { previewCatalog, previewFixture, renderPreview } from '../tools/preview.mjs';

const html = await renderPreview();
const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi), match => match[1]);

function previewBridge() {
  const window = {};
  const context = vm.createContext({ window, structuredClone, setTimeout: callback => callback() }, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(scripts[0]).runInContext(context, { timeout: 1000 });
  const rpc = (name, ...args) => new Promise((resolve, reject) => window.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args));
  return { window, rpc };
}

test('rendered sidebar scripts compile and all static DOM references exist', async () => {
  assert.equal(html.includes('<?'), false, 'all server includes are resolved');
  assert.equal(scripts.length, 3, 'one isolated preview bridge and two browser client partials');
  scripts.forEach(source => new vm.Script(source));
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]));
  for (const partial of ['dmv_client', 'dmv_client_chat']) {
    const client = await readFile(new URL('../src/' + partial + '.html', import.meta.url), 'utf8');
    for (const match of client.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), 'Missing element: ' + match[1]);
    assert.equal(/\.innerHTML\s*=/.test(client), false, 'untrusted data is rendered using textContent');
    assert.equal(/setInterval\s*\(/.test(client), false, 'sidebar must not accumulate polling timers');
  }
});

test('preview chat answers, asks with options and needs a saved provider first', async () => {
  const { rpc } = previewBridge();
  await assert.rejects(rpc('dmvChat', { text: 'hi' }), /Add an AI provider/);
  const saved = await rpc('dmvSaveAiSettings', { provider: 'anthropic', apiKey: 'offline-key', model: '' });
  assert.equal(saved.configured, true);
  assert.equal(saved.model, 'claude-opus-5');
  assert.ok(!JSON.stringify(await rpc('dmvBootstrap')).includes('offline-key'));
  const asked = await rpc('dmvChat', { text: 'Which account?', transcript: [] });
  assert.deepEqual([...asked.options], ['Google Ads', 'Facebook Ads']);
  const answered = await rpc('dmvChat', { text: 'Spend by campaign with a chart', transcript: asked.transcriptAppend });
  assert.equal(answered.events.length, 4);
  assert.equal(answered.transcriptAppend[1].actions.length, 4);
});

test('preview reads the registered catalog without calling Google services or publishing credentials', async () => {
  const catalog = await previewCatalog();
  assert.ok(catalog.length >= 6);
  const fixture = previewFixture(catalog);
  for (const connection of fixture.connections) {
    const source = catalog.find(item => item.id === connection.connectorId);
    for (const field of source.authFields) {
      if (field.secret || field.type === 'password' || field.key === 'serviceAccountJson') assert.equal(Object.hasOwn(connection.values, field.key), false);
    }
  }
});

test('local preview failures reach the failure handler without saving a partial report', async () => {
  const { window, rpc } = previewBridge();
  const before = await rpc('dmvBootstrap');
  window.DATAMOOV_PREVIEW_FAIL_NEXT = 'dmvSaveReport';
  const report = { ...before.reports[0], id: undefined, name: 'Retained draft' };
  await assert.rejects(rpc('dmvSaveReport', report), /Simulated request failure/);
  const after = await rpc('dmvBootstrap');
  assert.equal(after.reports.length, before.reports.length);
  assert.equal(report.name, 'Retained draft');
});

test('preview save and run mutate only the in-memory fixture and return an updated report summary', async () => {
  const { rpc } = previewBridge();
  const data = await rpc('dmvBootstrap');
  const saved = await rpc('dmvSaveReport', { ...data.reports[0], id: undefined, name: 'Draft report' });
  assert.ok(saved.id);
  const result = await rpc('dmvRunReport', saved.id);
  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 8);
  const preview = await rpc('dmvPreviewReport', saved);
  assert.equal(preview.rows.length, 8);
  assert.ok(preview.metadata.warnings[0].includes('No provider requests'));
  const freshBridge = previewBridge();
  assert.equal((await freshBridge.rpc('dmvBootstrap')).reports.length, data.reports.length, 'no persistence outside the fixture');
});
test('preview report presets use explicit defaults when present and preserve unmarked legacy schemas', () => {
  const catalogFor = fields => [{ id: 'google_ads', label: 'Google Ads', category: 'Marketing', authFields: [], reports: [{ id: 'campaigns', fields, configFields: [] }] }];
  const explicit = previewFixture(catalogFor([{ key: 'date', default: true }, { key: 'extra' }, { key: 'optional', default: false }]));
  assert.deepEqual(explicit.reports[0].fields, ['date']);
  const unmarked = previewFixture(catalogFor([{ key: 'date' }, { key: 'extra' }]));
  assert.deepEqual(unmarked.reports[0].fields, ['date', 'extra']);
  const none = previewFixture(catalogFor([{ key: 'extra' }, { key: 'optional', default: false }]));
  assert.deepEqual(none.reports[0].fields, []);
});