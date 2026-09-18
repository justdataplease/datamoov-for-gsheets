import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { google } from 'googleapis';
import { initAuth } from '../node_modules/@google/clasp/build/src/auth/auth.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Usage: node tools/publish.mjs data/development-project.json
//        DATAMOOV_CONFIRM=<scriptId> node tools/publish.mjs data/production-project.json
const recordPath = path.resolve(root, process.argv[2] || 'data/development-project.json');

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(item));
    else if (entry.isFile()) files.push(item);
  }
  return files;
}

export async function projectFiles() {
  const sourceRoot = path.join(root, 'src');
  const result = [];
  for (const file of await filesIn(sourceRoot)) {
    const extension = path.extname(file);
    const type = { '.js': 'SERVER_JS', '.gs': 'SERVER_JS', '.html': 'HTML', '.json': 'JSON' }[extension];
    if (!type) continue;
    const name = path.relative(sourceRoot, file).replaceAll('\\', '/').slice(0, -extension.length);
    result.push({name, type, source: await readFile(file, 'utf8')});
  }
  const priority = name => name === 'dmv_core' ? 0 : name === 'dmv_connector_helpers' || name === 'dmv_sql' ? 1 : name.startsWith('connectors/') ? 3 : 2;
  return result.sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name));
}

async function main() {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  if (!record.scriptId || !record.spreadsheetId) throw new Error('The project record needs scriptId and spreadsheetId. Run node tools/create-dev.mjs for a development project.');
  if (record.production === true && process.env.DATAMOOV_CONFIRM !== record.scriptId) {
    throw new Error('This record is marked production. Re-run with DATAMOOV_CONFIRM=' + record.scriptId + ' to replace its code.');
  }
  // Script IDs listed in the record (for example a production or customer copy) are never overwritten by this tool.
  if ((record.protectedScriptIds || []).includes(record.scriptId)) throw new Error('The recorded script ID is protected. Publication stopped.');
  const { credentials } = await initAuth({ authFilePath: path.join(root, '.local/clasprc.json') });
  if (!credentials) throw new Error('Run npm run login first.');
  const api = google.script({version:'v1', auth:credentials});
  const {data:project} = await api.projects.get({scriptId:record.scriptId});
  if (project.parentId !== record.spreadsheetId) throw new Error('The development project is attached to an unexpected spreadsheet.');
  const files = await projectFiles();
  if (files.some(file => /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN PRIVATE KEY-----/.test(file.source))) throw new Error('Potential embedded credential found in source. Publication stopped.');
  await api.projects.updateContent({scriptId:record.scriptId, requestBody:{files}});
  const {data:remote} = await api.projects.getContent({scriptId:record.scriptId});
  const byName = new Map((remote.files || []).map(file => [file.name, file]));
  for (const file of files) {
    const remoteFile = byName.get(file.name);
    if (!remoteFile || remoteFile.type !== file.type || remoteFile.source.replaceAll('\r\n','\n') !== file.source.replaceAll('\r\n','\n')) throw new Error('Published source did not match: ' + file.name);
  }
  if (byName.size !== files.length) throw new Error('Unexpected remote files after publication.');
  record.lastPublishedAt = new Date().toISOString();
  record.files = files.map(file => ({name:file.name, type:file.type, sha256:createHash('sha256').update(file.source).digest('hex')}));
  await writeFile(recordPath, JSON.stringify(record,null,2)+'\n');
  console.log(JSON.stringify({target:record.production ? 'production' : 'development', verifiedFiles:files.length, spreadsheetUrl:record.spreadsheetUrl, scriptUrl:record.scriptUrl, protectedProjectsChanged:false},null,2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode=1; });
}
