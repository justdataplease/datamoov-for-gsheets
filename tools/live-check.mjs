// Live provider/AI validation around the production Apps Script runtime.
// Google Sheets, properties, cache and triggers remain local in-memory service doubles.
// Requests and responses cross child-process stdin/stdout only; never log either.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { createDatamoovSandbox } from '../tests/helpers/datamoov-sandbox.mjs';

const self = fileURLToPath(import.meta.url);
const sourceRoot = new URL('../src/', import.meta.url);
const maxResponseBytes = 16 * 1024 * 1024;

export function readCredentialEnvironment(filename) {
  return parseEnv(readFileSync(filename, 'utf8'));
}

export function safeFailure(error) {
  const message = String(error?.message || '');
  if (/row limit|too many rows|more than.*rows/i.test(message)) return 'row_limit';
  if (/deadline|time limit|time budget/i.test(message)) return 'deadline';
  if (/rate.limit|provider is busy/i.test(message)) return 'rate_limited';
  if (/access denied|permission|authenticate|credentials|token|HTTP 40[13]/i.test(message))
    return 'authentication_or_access';
  if (/model|not found|HTTP 404/i.test(message)) return 'unavailable_resource_or_model';
  if (/field|column|query|report type/i.test(message)) return 'report_configuration';
  if (/reach the data provider|transport/i.test(message)) return 'transport';
  return 'runtime_error';
}

export function createLiveRuntime({
  connectorIds,
  allowedHosts = [],
  maxRequests = 100,
  requestTimeoutMs = 45000,
} = {}) {
  const sandbox = createDatamoovSandbox();
  const { api, state } = sandbox;
  const hosts = new Set(['oauth2.googleapis.com', ...allowedHosts]);
  const requests = [];
  const loaded = new Set();
  const lock = () => {
    let held = false;
    return {
      hasLock: () => held,
      tryLock() {
        if (held) return false;
        held = true;
        return true;
      },
      releaseLock() {
        held = false;
      },
    };
  };
  const userLock = lock(),
    scriptLock = lock();
  api.LockService = { getUserLock: () => userLock, getScriptLock: () => scriptLock };
  api.Date = Date;
  api.Utilities.getUuid = randomUUID;
  api.Utilities.computeRsaSha256Signature = (value, privateKey) => [
    ...sign('RSA-SHA256', Buffer.from(String(value), 'utf8'), privateKey),
  ];
  api.Utilities.sleep = (milliseconds) => {
    state.sleeps.push(milliseconds);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  };
  for (const provider of Object.values(api.DMV_AI_PROVIDERS)) hosts.add(provider.host);
  const allowConnection = (connectorId, credentials) => {
    const connector = api.dmvConnector_(connectorId);
    const declared =
      typeof connector.allowedHosts === 'function'
        ? connector.allowedHosts(credentials)
        : connector.allowedHosts || [];
    for (const host of declared) hosts.add(host);
  };
  const loadConnector = (id) => {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Error('Invalid connector ID');
    if (loaded.has(id)) return;
    const path = new URL('connectors/' + id + '.js', sourceRoot);
    new vm.Script(readFileSync(path, 'utf8'), {
      filename: 'connectors/' + id + '.js',
    }).runInContext(api, { timeout: 1000 });
    loaded.add(id);
    const connector = api.dmvConnector_(id);
    if (Array.isArray(connector.allowedHosts))
      for (const host of connector.allowedHosts) hosts.add(host);
  };
  const selected =
    connectorIds ||
    readdirSync(new URL('connectors/', sourceRoot))
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.slice(0, -3));
  for (const id of selected) loadConnector(id);
  api.UrlFetchApp.fetch = (url, options = {}) => {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      !hosts.has(target.hostname)
    )
      throw new Error('Live transport refused an undeclared host');
    if (requests.length >= maxRequests) throw new Error('Live transport request budget exceeded');
    const record = {
      providerHost: target.hostname.endsWith('.snowflakecomputing.com')
        ? '*.snowflakecomputing.com'
        : target.hostname,
      method: String(options.method || 'get').toUpperCase(),
      status: null,
    };
    requests.push(record);
    const began = Date.now();
    const result = spawnSync(process.execPath, [self, '--transport'], {
      input: JSON.stringify({ url, options, timeoutMs: requestTimeoutMs }),
      encoding: 'utf8',
      maxBuffer: 24 * 1024 * 1024,
      timeout: requestTimeoutMs + 10000,
      windowsHide: true,
    });
    record.durationMs = Date.now() - began;
    if (result.error || result.status !== 0) throw new Error('Live transport worker failed');
    let reply;
    try {
      reply = JSON.parse(result.stdout);
    } catch {
      throw new Error('Live transport returned an invalid envelope');
    }
    if (reply.failure) {
      record.failure = reply.failure;
      throw new Error('Live transport request failed');
    }
    record.status = reply.status;
    const bytes = Buffer.from(reply.body, 'base64');
    record.responseBytes = bytes.length;
    return {
      getResponseCode: () => reply.status,
      getContentText: () => bytes.toString('utf8'),
      getAllHeaders: () => reply.headers,
      getBlob: () => ({
        getBytes: () => [...bytes],
        getDataAsString: () => bytes.toString('utf8'),
      }),
    };
  };
  const summary = () => ({
    boundary: 'live provider and AI HTTP; local in-memory Google Sheets/properties/cache/triggers',
    requests: requests.map((request) => ({ ...request })),
    localSheetBatches: state.batches.length,
    localCharts: state.charts.length,
  });
  return { ...sandbox, requests, summary, loadConnector, allowConnection };
}

async function transportWorker() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > maxResponseBytes) throw new Error('input_too_large');
    }
    const { url, options = {}, timeoutMs = 45000 } = JSON.parse(input);
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password)
      throw new Error('unsafe_url');
    const headers = { ...(options.headers || {}) };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    const response = await fetch(url, {
      method: String(options.method || 'get').toUpperCase(),
      headers,
      body: options.payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > maxResponseBytes) throw new Error('response_too_large');
      chunks.push(chunk);
    }
    process.stdout.write(
      JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.concat(chunks).toString('base64'),
      })
    );
  } catch (error) {
    const known = ['input_too_large', 'unsafe_url', 'response_too_large'];
    process.stdout.write(
      JSON.stringify({
        failure: known.includes(error?.message) ? error.message : 'network_request_failed',
      })
    );
  }
}

if (process.argv[1] === self && process.argv[2] === '--transport') await transportWorker();
