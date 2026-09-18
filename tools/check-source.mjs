import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'src');
const displayPath = (path) => relative(projectRoot, path).replaceAll('\\', '/');

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(path);
      return entry.isFile() ? [path] : [];
    });
}

function checkSource() {
  console.log('Static source check only: no code runs and Google service calls are not validated.');

  try {
    if (!statSync(sourceRoot).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`Cannot check src/: ${error.message}. Fetch the Apps Script project first.`);
  }

  let failures = 0;
  const fail = (message) => {
    failures += 1;
    console.error(`FAIL ${message}`);
  };

  const manifestPath = join(sourceRoot, 'appsscript.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest === null || Array.isArray(manifest) || typeof manifest !== 'object') {
      throw new Error('the manifest must be a JSON object');
    }
    console.log(`OK ${displayPath(manifestPath)} parses as JSON.`);
  } catch (error) {
    fail(`${displayPath(manifestPath)}: ${error.message}`);
  }

  const files = collectFiles(sourceRoot);
  const serverFiles = files.filter((path) => ['.gs', '.js'].includes(extname(path).toLowerCase()));
  const htmlCount = files.filter((path) => extname(path).toLowerCase() === '.html').length;
  console.log(`HTML is excluded from this check (${htmlCount} file${htmlCount === 1 ? '' : 's'}).`);

  if (serverFiles.length === 0) {
    fail('No server .gs or .js files found in src/. Fetch the Apps Script project first.');
  } else {
    const sources = [];
    for (const path of serverFiles) {
      try {
        const source = readFileSync(path, 'utf8');
        new Script(source, { filename: displayPath(path) });
        sources.push(source);
      } catch (error) {
        fail(`${displayPath(path)}: ${error.message}`);
      }
    }

    if (sources.length === serverFiles.length) {
      console.log(`OK ${serverFiles.length} server file${serverFiles.length === 1 ? '' : 's'} compile individually.`);
      if (sources.length > 1) {
        try {
          // Apps Script server files share globals. Separators prevent one file's
          // final expression or line comment from consuming the next file.
          new Script(sources.join('\n;\n'), { filename: 'combined-apps-script-server.js' });
          console.log('OK combined server scope compiles without duplicate lexical declarations.');
        } catch (error) {
          fail(`Combined server scope: ${error.message}`);
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`Source check failed (${failures} issue${failures === 1 ? '' : 's'}).`);
    process.exitCode = 1;
  } else {
    console.log('Source check passed. Apps Script runtime behavior still requires separate testing.');
  }
}

try {
  checkSource();
} catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
