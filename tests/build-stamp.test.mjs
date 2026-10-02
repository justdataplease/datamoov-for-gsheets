import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { buildFor, buildStampFile, publishPayload } from '../tools/publish.mjs';
import { createDatamoovSandbox, plain } from './helpers/datamoov-sandbox.mjs';

// Apps Script cannot read its own deployment, so the publish script adds one generated file.
const stamp = { deployedAt: '2026-10-02T07:30:00.000Z', commit: 'a1b2c3d', dirty: true, target: 'development' };

function run(file, context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })) {
  new vm.Script(file.source, { filename: file.name }).runInContext(context, { timeout: 1000 });
  return context;
}

test('the build stamp is one server file declaring DMV_BUILD and nothing else', () => {
  const file = buildStampFile(stamp);
  assert.equal(file.name, 'dmv_build');
  assert.equal(file.type, 'SERVER_JS');
  const context = run(file);
  assert.deepEqual(Object.keys(context), ['DMV_BUILD']);
  assert.deepEqual(plain(context.DMV_BUILD), stamp);
});

test('the publish payload is every src file plus the stamp, which never lands in src', async () => {
  const sourceCount = async (directory) => {
    let count = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) count += await sourceCount(directory + '/' + entry.name);
      else if (/\.(js|gs|html|json)$/.test(entry.name)) count++;
    }
    return count;
  };
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const files = await publishPayload(stamp);
  assert.equal(files.length, (await sourceCount(src)) + 1);
  assert.deepEqual(files.at(-1), buildStampFile(stamp));
  assert.equal(files.filter((file) => file.name === 'dmv_build').length, 1);
  assert.equal(files[0].name, 'dmv_core', 'load order of the src files is unchanged');
});

test('bootstrap returns the deployed build stamp, or null where none was published', () => {
  const f = createDatamoovSandbox();
  assert.equal(f.api.dmvBootstrap().build, null);
  run(buildStampFile(stamp), f.api);
  assert.deepEqual(plain(f.api.dmvBootstrap().build), stamp);
});

// A fake git: rev-parse names the commit, status prints the given porcelain lines.
function gitWith(status) {
  const calls = [];
  const run = (...args) => {
    calls.push(args.join(' '));
    return args[0] === 'rev-parse' ? 'a1b2c3d' : status;
  };
  run.calls = calls;
  return run;
}
const now = new Date('2026-10-02T07:30:00.000Z');

test('the dirty flag covers only src/, the files a publish sends', () => {
  const clean = gitWith('');
  assert.deepEqual(buildFor({}, clean, now), { ...stamp, dirty: false });
  assert.ok(clean.calls.includes('status --porcelain --ignored -- src'), clean.calls.join('; '));
  assert.equal(buildFor({}, gitWith(' M src/dmv_chat.js'), now).dirty, true);
  assert.equal(buildFor({}, gitWith('?? src/dmv_new.js'), now).dirty, true);
  // A git-ignored file under src/ is still sent, so it counts too.
  assert.equal(buildFor({}, gitWith('!! src/data/x.json'), now).dirty, true);
});

test('a production publish of uncommitted src/ changes is refused; only production: true is production', () => {
  assert.throws(() => buildFor({ production: true }, gitWith(' M src/dmv_chat.js'), now), /src\/ has uncommitted changes/);
  assert.deepEqual(buildFor({ production: true }, gitWith(''), now), { ...stamp, dirty: false, target: 'production' });
  // The DATAMOOV_CONFIRM guard checks production === true, so the stamp does too.
  assert.equal(buildFor({ production: 'yes' }, gitWith(''), now).target, 'development');
});
