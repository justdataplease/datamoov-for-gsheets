import { readFile, writeFile } from 'node:fs/promises';
import { google } from 'googleapis';
import { initAuth } from '../node_modules/@google/clasp/build/src/auth/auth.js';

// Creates (once) a bound Apps Script project on the spreadsheet you want to develop in.
// Usage: DATAMOOV_DEV_SPREADSHEET_ID=<spreadsheet id> node tools/create-dev.mjs
const spreadsheetId = process.env.DATAMOOV_DEV_SPREADSHEET_ID;
const recordPath = 'data/development-project.json';

async function main() {
  let record;
  try { record = JSON.parse(await readFile(recordPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!record && !spreadsheetId) throw new Error('Set DATAMOOV_DEV_SPREADSHEET_ID to the spreadsheet that should host the development script.');
  const { credentials } = await initAuth({ authFilePath: '.local/clasprc.json' });
  if (!credentials) throw new Error('Run npm run login first.');
  const api = google.script({ version: 'v1', auth: credentials });
  if (!record) {
    const { data } = await api.projects.create({ requestBody: { title: 'DataMoov for Sheets - Development', parentId: spreadsheetId } });
    record = { scriptId: data.scriptId, spreadsheetId, createdAt: data.createTime,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      scriptUrl: `https://script.google.com/home/projects/${data.scriptId}/edit`, protectedScriptIds: [] };
    await writeFile(recordPath, JSON.stringify(record, null, 2) + '\n');
  }
  const { data: project } = await api.projects.get({ scriptId: record.scriptId });
  if (project.parentId !== record.spreadsheetId) throw new Error('The development project is attached to an unexpected spreadsheet.');
  let config = { rootDir: 'src', scriptExtensions: ['.js', '.gs'], htmlExtensions: ['.html'], jsonExtensions: ['.json'], filePushOrder: [], skipSubdirectories: false };
  try { config = { ...config, ...JSON.parse(await readFile('.clasp.json', 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  config.scriptId = record.scriptId;
  config.rootDir = 'src';
  await writeFile('.clasp.json', JSON.stringify(config, null, 2) + '\n');
  console.log(JSON.stringify(record, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
