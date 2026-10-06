// The chat benchmark's runtime: the real src chat code (tests/helpers/datamoov-sandbox.mjs loads
// every src file into a vm context) over an in-memory spreadsheet, with Sheets' calculation
// stood in by ./formulas.mjs. The AI provider is either the live Gemini API (through the HTTPS
// transport of tools/live-check.mjs; the key travels only in the provider header src/dmv_ai.js
// builds) or a scripted provider that answers each request from a function (self-test).
//
// Time spent in the stand-in calculator is taken off the runtime's clock, so the app's own time
// limit sees Sheets-like timing, and seconds are reported without it.
import { randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDatamoovSandbox } from '../../tests/helpers/datamoov-sandbox.mjs';
import { createLiveRuntime } from '../live-check.mjs';
import { createCalculator, renderPivots, ERROR_RE } from './formulas.mjs';
import { createGoogleAdsFake, CUSTOMER_ID } from './google-ads-fake.mjs';

const ERROR_TYPE = {
  '#DIV/0!': 'DIVIDE_BY_ZERO',
  '#REF!': 'REF',
  '#N/A': 'N_A',
  '#VALUE!': 'VALUE',
  '#NAME?': 'NAME',
  '#NUM!': 'NUM',
  '#ERROR!': 'ERROR',
  '#NULL!': 'NULL_VALUE',
};
const CONFIRM_REF = /^confirmToken (c[a-f0-9]{32})$/;
// Batch requests that can change cell values.
const VALUE_REQUESTS = new Set([
  'updateCells',
  'appendCells',
  'copyPaste',
  'cutPaste',
  'pasteData',
  'sortRange',
  'insertDimension',
  'deleteDimension',
  'insertRange',
  'deleteRange',
  'moveDimension',
  'findReplace',
  'autoFill',
  'deleteDuplicates',
  'trimWhitespace',
  'textToColumns',
  'randomizeRange',
  'duplicateSheet',
  'appendDimension',
]);
// Every sheetId named anywhere in a request body.
const sheetIds = (node, out = []) => {
  if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) {
      if (key === 'sheetId' && Number.isInteger(value)) out.push(value);
      else if (key === 'sourceSheetId' && Number.isInteger(value)) out.push(value);
      else sheetIds(value, out);
    }
  return out;
};

const cut = (value, n) => {
  const text = String(value ?? '');
  return text.length > n ? text.slice(0, n) + '…' : text;
};
const size = (value) => {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return -1;
  }
};

// provider: 'live' or a function (requestBodyText) => Gemini response object.
// apiKey: the Gemini key (a live run's is never logged). timeLimit: seconds, or the app default.
// googleAds: { variant } adds the real Google Ads connector (src/connectors/google_ads.js) with
// one fictional connection whose API is the local fake of ./google-ads-fake.mjs.
export function createBenchRuntime({
  provider,
  apiKey,
  model = null,
  timeLimit,
  maxRequests = 600,
  googleAds = null,
}) {
  // paused: calculator time taken off the app's clock; skew: time a self-test moves it forward.
  let paused = 0,
    skew = 0;
  class ClockDate extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(Date.now() - paused + skew);
    }
    static now() {
      return Date.now() - paused + skew;
    }
  }
  const timed = (fn) => {
    const t = Date.now();
    try {
      return fn();
    } finally {
      paused += Date.now() - t;
    }
  };
  // Formulas are evaluated after each batch is published (settle), not inside it: the sandbox
  // stages a batch's cells, so a formula evaluated mid-batch would read the cells as they were
  // before the batch (a formula beside the values it divides by would read empty cells).
  const f = createDatamoovSandbox({ gridData: true });
  const calc = createCalculator(() => f.book);
  const { api, state } = f;

  const rowMajor = (a, b) => {
    const [ar, ac] = a.split(':').map(Number),
      [br, bc] = b.split(':').map(Number);
    return ar - br || ac - bc;
  };
  // One formula's value and array result, as the sandbox's own calculate() would set them.
  const evaluate = (sheet, key, spills) => {
    const entry = sheet.cells.get(key);
    for (const other of spills.get(key) || []) sheet.cells.delete(other);
    spills.delete(key);
    const { error, value, ...rest } = entry;
    const [row, column] = key.split(':').map(Number);
    const result = calc(entry.formula, { sheet: sheet.name, row, column });
    if (result === undefined || result === null) {
      sheet.cells.set(key, { ...rest, value: entry.formula });
      return;
    }
    const lines = Array.isArray(result) ? result : [[result]];
    const width = Math.max(...lines.map((line) => line.length));
    if (row - 1 + lines.length > sheet.maxRows || column - 1 + width > sheet.maxColumns) {
      sheet.cells.set(key, {
        ...rest,
        value: '#REF!',
        error: {
          type: 'REF',
          message: 'Result was not automatically expanded, please insert more rows.',
        },
      });
      return;
    }
    const blocked = lines.some((line, r) =>
      line.some((v, c) => (r || c) && v !== '' && sheet.cells.has(`${row + r}:${column + c}`))
    );
    if (blocked) {
      sheet.cells.set(key, {
        ...rest,
        value: '#REF!',
        error: {
          type: 'REF',
          message: 'Array result was not expanded because it would overwrite data.',
        },
      });
      return;
    }
    sheet.cells.set(key, { ...rest, value: lines[0][0] });
    const made = [];
    lines.forEach((line, r) =>
      line.forEach((v, c) => {
        if ((r || c) && v !== '') {
          const at = `${row + r}:${column + c}`;
          sheet.cells.set(at, { value: v, formula: '', spilledFrom: key });
          made.push(at);
        }
      })
    );
    if (made.length) spills.set(key, made);
  };
  // After a batch that can change values: every formula on the tabs it touched, and on tabs whose
  // formulas name a touched tab, is evaluated again in row order; a second pass retries those that
  // read a formula evaluated later in the first.
  const settle = (requests) => {
    const touched = new Set();
    for (const request of requests) {
      const [type, body] = Object.entries(request || {})[0] || [];
      if (
        !VALUE_REQUESTS.has(type) &&
        !(type === 'repeatCell' && /userEnteredValue|^\*$/.test(String(body?.fields || '')))
      )
        continue;
      const ids = sheetIds(body);
      if (!ids.length) ids.push(0);
      ids.forEach((id) => touched.add(id));
    }
    if (!touched.size) return;
    const names = f.book.sheets.filter((s) => touched.has(s.id)).map((s) => s.name.toLowerCase());
    for (let pass = 0; pass < 2; pass++)
      for (const sheet of f.book.sheets) {
        const anchors = [];
        const spills = new Map();
        for (const [key, entry] of sheet.cells) {
          if (entry.formula) anchors.push(key);
          else if (entry.spilledFrom && !String(entry.spilledFrom).startsWith('pivot:')) {
            if (!spills.has(entry.spilledFrom)) spills.set(entry.spilledFrom, []);
            spills.get(entry.spilledFrom).push(key);
          }
        }
        if (!anchors.length) continue;
        const own = touched.has(sheet.id);
        anchors.sort(rowMajor);
        for (const key of anchors) {
          const entry = sheet.cells.get(key);
          if (!entry || !entry.formula) continue;
          const mentions = own || names.some((name) => entry.formula.toLowerCase().includes(name));
          if (!mentions) continue;
          if (pass === 1 && entry.value !== entry.formula) continue;
          evaluate(sheet, key, spills);
        }
      }
  };

  // A spilled cell whose formula is gone, no longer a formula, or now an error (a tab it read was
  // deleted, its text was replaced) is gone in Sheets too.
  const dropOrphanSpills = () => {
    for (const sheet of f.book.sheets)
      for (const [key, entry] of sheet.cells) {
        if (!entry.spilledFrom || String(entry.spilledFrom).startsWith('pivot:')) continue;
        const anchor = sheet.cells.get(entry.spilledFrom);
        if (
          !anchor ||
          !anchor.formula ||
          anchor.error ||
          (typeof anchor.value === 'string' && ERROR_RE.test(anchor.value))
        )
          sheet.cells.delete(key);
      }
  };
  // An error text the calculator gave a formula becomes an error value, as Sheets reports it.
  const markErrors = () => {
    for (const sheet of f.book.sheets)
      for (const entry of sheet.cells.values())
        if (
          entry.formula &&
          !entry.error &&
          typeof entry.value === 'string' &&
          ERROR_RE.test(entry.value)
        ) {
          const type = ERROR_TYPE[entry.value.match(ERROR_RE)[0]] || 'ERROR';
          entry.error = { type, message: 'Evaluated by the benchmark calculator.' };
        }
  };
  // sortRange (which the shared sandbox leaves out) moves whole cells within its range.
  const sortInPlace = (sort, id) => {
    const grid = sort.range;
    const sheet = state.books.get(id).sheets.find((s) => s.id === (grid.sheetId ?? 0));
    const endRow = grid.endRowIndex ?? sheet.maxRows,
      startCol = grid.startColumnIndex ?? 0,
      endCol = grid.endColumnIndex ?? sheet.maxColumns;
    const rows = [];
    for (let r = grid.startRowIndex ?? 0; r < endRow; r++)
      rows.push(
        Array.from({ length: endCol - startCol }, (_, c) => {
          const key = `${r + 1}:${c + startCol + 1}`;
          return { cell: sheet.cells.get(key), format: sheet.formats.get(key) };
        })
      );
    const val = (e) => (e.cell?.value instanceof Date ? e.cell.value.getTime() : e.cell?.value);
    rows.sort((a, b) => {
      for (const spec of sort.sortSpecs) {
        const column = spec.dimensionIndex - startCol;
        const av = val(a[column]),
          bv = val(b[column]);
        const ae = av === '' || av == null,
          be = bv === '' || bv == null;
        if (ae !== be) return ae ? 1 : -1;
        if (av !== bv) return (av < bv ? -1 : 1) * (spec.sortOrder === 'DESCENDING' ? -1 : 1);
      }
      return 0;
    });
    rows.forEach((row, r) =>
      row.forEach((entry, c) => {
        const key = `${r + (grid.startRowIndex ?? 0) + 1}:${c + startCol + 1}`;
        if (entry.cell) sheet.cells.set(key, entry.cell);
        else sheet.cells.delete(key);
        if (entry.format) sheet.formats.set(key, entry.format);
        else sheet.formats.delete(key);
      })
    );
  };
  const batch = api.Sheets.Spreadsheets.batchUpdate;
  api.Sheets.Spreadsheets.batchUpdate = function (body, id, ...rest) {
    calc.reset();
    const requests = (body && body.requests) || [];
    let out;
    if (requests.some((r) => r.sortRange)) {
      const replies = [];
      let pending = [];
      const flush = () => {
        if (!pending.length) return;
        const res = batch.call(this, { ...body, requests: pending }, id, ...rest);
        replies.push(...(res.replies || pending.map(() => ({}))));
        pending = [];
      };
      for (const request of requests) {
        if (!request.sortRange) {
          pending.push(request);
          continue;
        }
        flush();
        state.batches.push({
          body: { requests: [JSON.parse(JSON.stringify(request))] },
          spreadsheetId: id,
        });
        sortInPlace(request.sortRange, id);
        replies.push({});
      }
      flush();
      out = { spreadsheetId: id, replies };
    } else out = batch.call(this, body, id, ...rest);
    timed(() => {
      calc.reset();
      settle(requests);
      dropOrphanSpills();
      renderPivots(f.book);
      markErrors();
    });
    return out;
  };

  let held = false,
    scriptHeld = false;
  api.LockService = {
    getUserLock: () => ({
      hasLock: () => held,
      tryLock: () => (held ? false : (held = true)),
      releaseLock: () => (held = false),
      waitLock: () => (held = true),
    }),
    getScriptLock: () => ({
      hasLock: () => scriptHeld,
      tryLock: () => (scriptHeld ? false : (scriptHeld = true)),
      releaseLock: () => (scriptHeld = false),
      waitLock: () => (scriptHeld = true),
    }),
  };
  api.Date = ClockDate;
  api.Utilities.getUuid = randomUUID;
  api.Utilities.computeRsaSha256Signature = (value, key) => [
    ...sign('RSA-SHA256', Buffer.from(String(value), 'utf8'), key),
  ];
  api.Utilities.sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  let transport = null;
  if (provider === 'live') {
    transport = createLiveRuntime({ connectorIds: [], maxRequests, requestTimeoutMs: 120000 });
    api.UrlFetchApp.fetch = transport.api.UrlFetchApp.fetch;
  } else {
    api.UrlFetchApp.fetch = (url, options) => {
      const body = JSON.stringify(provider(String((options && options.payload) || '')));
      return {
        getResponseCode: () => 200,
        getContentText: () => body,
        getAllHeaders: () => ({}),
        getBlob: () => ({ getBytes: () => [...Buffer.from(body)], getDataAsString: () => body }),
      };
    };
  }
  api.dmvSaveAiSettings({
    provider: 'gemini',
    apiKey,
    ...(model ? { model } : {}),
    ...(timeLimit ? { timeLimit } : {}),
  });

  // Google Ads: the real connector, a fictional connection, the local fake as its API. Requests
  // to googleads.googleapis.com never leave the machine.
  let ads = null;
  const connectionIds = [];
  if (googleAds) {
    const today = api.Utilities.formatDate(new ClockDate(), f.book.timezone, 'yyyy-MM-dd');
    ads = createGoogleAdsFake({ variant: googleAds.variant || 'normal', today });
    const fetch = api.UrlFetchApp.fetch;
    api.UrlFetchApp.fetch = (url, options) => ads.handle(url, options) || fetch(url, options);
    const file = new URL('../../src/connectors/google_ads.js', import.meta.url);
    new vm.Script(readFileSync(file, 'utf8'), { filename: 'google_ads.js' }).runInContext(api, {
      timeout: 5000,
    });
    connectionIds.push(
      api.dmvSaveConnection({
        connectorId: 'google_ads',
        label: 'Google Ads - Lingoloop (demo)',
        credentials: {
          customerId: CUSTOMER_ID.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3'),
          authMode: 'token',
          accessToken: 'fictional-access-token',
        },
      }).id
    );
  }

  // A new spreadsheet: one empty tab, Sheet1, 1,000 rows by 26 columns.
  const first = f.book.sheets[0];
  first.name = 'Sheet1';
  first.maxRows = 1000;
  first.maxColumns = 26;
  f.book.setActiveSheet(first);

  // ---------- instrumentation ----------
  const trace = { rounds: [], tools: [], finals: [] };
  const parse = api.dmvAiGemini_.parse;
  api.dmvAiGemini_.parse = function (response) {
    const candidate =
      response && Array.isArray(response.candidates) ? response.candidates[0] : null;
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const usage = (response && response.usageMetadata) || {};
    trace.rounds.push({
      finishReason: candidate ? candidate.finishReason : 'NO_CANDIDATE',
      parts: parts.map((part) =>
        part.functionCall
          ? 'call:' +
            part.functionCall.name +
            (part.functionCall.args?.action ? '/' + part.functionCall.args.action : '')
          : typeof part.text === 'string'
            ? (part.thought ? 'thought' : 'text') + '(' + part.text.length + 'ch)'
            : 'other'
      ),
      tokens: {
        prompt: usage.promptTokenCount,
        output: usage.candidatesTokenCount,
        thoughts: usage.thoughtsTokenCount,
      },
    });
    const reply = parse.call(this, response);
    // What the app made of the reply: a tool_error is a call it could not use (not a round).
    const round = trace.rounds[trace.rounds.length - 1];
    round.stop = reply && reply.stop;
    round.calls = reply && Array.isArray(reply.toolCalls) ? reply.toolCalls.length : 0;
    return reply;
  };
  const runTool = api.dmvChatRunTool_;
  api.dmvChatRunTool_ = function (session, tools, call) {
    const outcome = runTool(session, tools, call);
    let parsed = null;
    try {
      parsed = JSON.parse(outcome.content);
    } catch {
      /* not JSON */
    }
    const input = call.input || {};
    trace.tools.push({
      round: trace.rounds.length,
      name: call.name,
      action: input.action,
      sheet: input.sheetName,
      range: typeof input.range === 'string' ? input.range : undefined,
      argChars: size(input),
      error: outcome.isError
        ? cut(
            parsed && parsed.error !== undefined
              ? typeof parsed.error === 'string'
                ? parsed.error
                : JSON.stringify(parsed.error)
              : outcome.content,
            400
          )
        : undefined,
      needsConfirmation: Boolean(parsed && parsed.needsConfirmation),
      reportedErrors: parsed && Number.isFinite(parsed.errorCount) ? parsed.errorCount : 0,
      reportedErrorSample:
        parsed && Array.isArray(parsed.formulaErrors)
          ? cut(JSON.stringify(parsed.formulaErrors.slice(0, 3)), 300)
          : undefined,
    });
    return outcome;
  };
  // The round cap and the time-over final call both end in dmvChatFinalAnswer_; an output-limit
  // recovery in dmvChatRecoverAnswer_.
  for (const [name, kind] of [
    ['dmvChatFinalAnswer_', 'final'],
    ['dmvChatRecoverAnswer_', 'recover'],
  ]) {
    const original = api[name];
    api[name] = function (...args) {
      trace.finals.push({ kind, round: trace.rounds.length });
      return original.apply(this, args);
    };
  }

  const settings = api.dmvAiRead_();
  const limitSecs = api.dmvAiTimeLimit_(settings);
  const maxRounds = Math.max(
    api.DMV_CHAT.maxRounds,
    Math.round((api.DMV_CHAT.maxRounds * limitSecs * 1000) / api.DMV_CHAT.budgetMs)
  );

  return {
    f,
    api,
    state,
    trace,
    transport,
    model: settings.model,
    connectionIds,
    ads,
    limitSecs,
    maxRounds,
    pausedMs: () => paused,
    // Evaluates every formula of the book again (after a refresh outside chat).
    recalc() {
      timed(() => {
        calc.reset();
        settle(f.book.sheets.map((sheet) => ({ updateCells: { range: { sheetId: sheet.id } } })));
        dropOrphanSpills();
        renderPivots(f.book);
        markErrors();
      });
    },
    // Moves the app's clock forward (self-test of a turn whose time runs out).
    advance(ms) {
      skew += ms;
    },
    // Puts a table on a tab (seeding a skipped turn 1); returns the tab.
    seedTab(name, table) {
      const sheet = f.book.sheets[0];
      sheet.name = name;
      sheet.maxRows = Math.max(1000, table.length + 1);
      sheet.maxColumns = Math.max(26, table[0].length);
      table.forEach((row, r) => row.forEach((value, c) => f.setCell(sheet, r + 1, c + 1, value)));
      for (let c = 0; c < table[0].length; c++)
        sheet.formats.set(`1:${c + 1}`, { textFormat: { bold: true } });
      return sheet;
    },
  };
}

// One user request as the sidebar sends it: continued while the app says pending, and, when the
// reply waits for a yes to a sheet change, answered Yes with the offered token (autoConfirm, at
// most maxConfirms times), as a user clicking Yes. Returns what happened, measured from the run.
export function runRequest(
  rt,
  { text, transcript, conversationId, autoConfirm = true, maxConfirms = 2 }
) {
  const { api, trace } = rt;
  const mark = {
    rounds: trace.rounds.length,
    tools: trace.tools.length,
    finals: trace.finals.length,
  };
  const wallStart = Date.now(),
    pausedStart = rt.pausedMs();
  const requests = [];
  let history = transcript.slice();
  let message = text,
    confirmToken = undefined,
    confirms = 0;
  while (true) {
    const one = sendOnce(api, trace, rt.f, {
      connectionIds: rt.connectionIds || [],
      text: message,
      transcript: history,
      conversationId,
      confirmToken,
    });
    requests.push(one);
    if (one.reply && one.reply.transcriptAppend)
      history = history.concat(one.reply.transcriptAppend);
    if (one.stop === 'needs_confirmation' && autoConfirm && confirms < maxConfirms) {
      const tokens = one.confirmTokens;
      confirmToken = tokens.length === 1 ? tokens[0] : undefined;
      message = 'Yes';
      confirms++;
      continue;
    }
    break;
  }
  const last = requests[requests.length - 1];
  const wall = (Date.now() - wallStart) / 1000;
  const tools = trace.tools.slice(mark.tools);
  return {
    text: last.text,
    stop: last.stop,
    failure: last.failure,
    executions: requests.reduce((a, r) => a + r.executions, 0),
    requests: requests.length,
    confirmsSent: confirms,
    // Replies whose tool call the app could not use (it retried without running anything).
    malformedCalls: trace.rounds.slice(mark.rounds).filter((r) => r.stop === 'tool_error').length,
    rounds: trace.rounds.length - mark.rounds,
    roundLog: trace.rounds.slice(mark.rounds),
    tools,
    seconds: Math.round((wall - (rt.pausedMs() - pausedStart) / 1000) * 10) / 10,
    wallSeconds: Math.round(wall * 10) / 10,
    calcSeconds: Math.round((rt.pausedMs() - pausedStart) / 100) / 10,
    transcriptAppend: history.slice(transcript.length),
    events: requests.flatMap((r) => (r.reply && r.reply.events) || []),
  };
}

// Apps Script gives each execution its own Spreadsheet object, which sees every tab made before
// it, also those an earlier execution added through the Sheets API; the sandbox's active handle
// would otherwise keep the tabs of the first execution only (its list of Tabs then misses them).
function sendOnce(
  api,
  trace,
  f,
  { text, transcript, conversationId, confirmToken, connectionIds }
) {
  const execute = (input) => {
    f.setActive(f.reopen());
    return api.dmvChat(input);
  };
  const finalsBefore = trace.finals.length,
    roundsBefore = trace.rounds.length;
  const requestId = randomUUID();
  let reply = null,
    failure,
    executions = 0;
  try {
    reply = execute({
      text,
      transcript,
      connectionIds,
      requestId,
      conversationId,
      ...(confirmToken ? { confirmToken } : {}),
    });
    executions++;
    while (reply && reply.pending && executions < 30) {
      reply = execute({ requestId, resume: true });
      executions++;
    }
  } catch (error) {
    failure = cut(error && error.message, 400);
  }
  const replyText = reply ? String(reply.text || '') : '';
  const confirmTokens = ((reply && reply.events) || [])
    .map((event) =>
      event && event.kind === 'summary' && typeof event.ref === 'string'
        ? CONFIRM_REF.exec(event.ref)?.[1]
        : null
    )
    .filter(Boolean);
  const finals = trace.finals.slice(finalsBefore);
  let stop;
  if (failure) stop = 'provider_error';
  else if (reply && reply.pending) stop = 'still_pending';
  else if (confirmTokens.length) stop = 'needs_confirmation';
  else if (reply && Array.isArray(reply.options)) stop = 'ask_user';
  else if (finals.some((x) => x.kind === 'final')) {
    // The final call came either from the round cap or from the turn's time running out. The
    // app's rounds are counted as it counts them: replies before the final call whose tool calls
    // ran (a malformed call it retried is not a round).
    const finalAt = finals.find((x) => x.kind === 'final').round;
    const rounds = trace.rounds
      .slice(roundsBefore, finalAt)
      .filter((r) => r.calls > 0 && r.stop !== 'tool_error').length;
    stop = rounds >= roundCap(api) ? 'round_cap' : 'time_over';
  } else if (finals.some((x) => x.kind === 'recover')) stop = 'output_limit';
  else if (/could not form a valid tool call/i.test(replyText)) stop = 'tool_call_error';
  else if (/The AI provider failed after/i.test(replyText)) stop = 'provider_error';
  else if (/declined to answer/i.test(replyText)) stop = 'refusal';
  else if (reply && reply.failed) stop = 'no_answer';
  else stop = 'answer';
  return { reply, text: failure ? '' : replyText, failure, executions, stop, confirmTokens };
}

function roundCap(api) {
  const settings = api.dmvAiRead_();
  const limit = api.dmvAiTimeLimit_(settings);
  return Math.max(
    api.DMV_CHAT.maxRounds,
    Math.round((api.DMV_CHAT.maxRounds * limit * 1000) / api.DMV_CHAT.budgetMs)
  );
}
