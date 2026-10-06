// Chat benchmark (dev tool; only src/ deploys). Runs chained chat conversations against the real
// src chat runtime, an in-memory spreadsheet and the live Gemini API, and measures each turn from
// the book and the run (never from the model's words): rows written vs requested, how much of
// each derived tab is live formulas, error cells, charts, pivots, dashboard tab, stop reason,
// failed steps, rounds, seconds, confirmations, whether the reply's row counts and ranges match
// the book, and whether the numbers it states match facts the harness computes.
//
// Scenarios (tools/chat-bench/scenarios.mjs):
//   retail, saas, hr, logistics, marketing   generate N rows, summarize, dashboard
//   shop_customers, subscription_accounts, marketplace_sellers, freight_clients
//                       generate N rows, then analysis per entity (segments, retention)
//   google_ads          dashboard (30 days vs previous), "which campaigns waste money", an edit
//   reports_dashboard   save 3 reports, dashboard over their tabs, then a refresh with more rows
// Google Ads data is fictional and served by a local fake of the API (google-ads-fake.mjs);
// nothing reaches Google Ads.
//
// Results go to .scratch/bench/<label>/ (results.json, results.md, log.txt; .scratch is gitignored
// and, unlike .local, not scanned by the video privacy check).
//
// Usage:
//   node tools/chat-bench.mjs [--label <name>] [--scenarios retail,saas,hr,logistics,marketing,google_ads,reports_dashboard]
//                             [--variant normal|large] [--turns 1,2,3] [--runs 1] [--model <gemini model>]
//                             [--rows-override <N>] [--time-limit <seconds>] [--no-auto-confirm]
// A scenario entry may name its Google Ads size: --scenarios google_ads:normal,google_ads:large.
//   node tools/chat-bench.mjs --self-test      (no AI request: scripted tool calls, known answers)
//
// --domains is accepted as an alias of --scenarios. --variant sizes the Google Ads search terms
// (normal about 3,500, large about 100,000 in the last 30 days). Conversations run one at a time.
// The API key is read from .local/live-ai-credential.json and only handed to the app's settings
// (src/dmv_ai.js sends it in the provider header); it is never logged or written to the results.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCENARIO_IDS, buildScenario } from './chat-bench/scenarios.mjs';
import { createBenchRuntime } from './chat-bench/runtime.mjs';
import { runConversation } from './chat-bench/conversation.mjs';
import { aggregate, markdown } from './chat-bench/report.mjs';
import { runSelfTest } from './chat-bench/self-test.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const flag = (name) => args.includes('--' + name);
const list = (text) =>
  String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

if (flag('self-test')) {
  const ok = runSelfTest();
  process.exit(ok ? 0 : 1);
}

const LABEL = opt('label', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
if (!/^[A-Za-z0-9_.-]{1,80}$/.test(LABEL)) throw new Error('--label: letters, digits, _ . - only');
const IDS = list(opt('scenarios', opt('domains', SCENARIO_IDS.join(','))));
const TURNS =
  opt('turns', null) === null
    ? null
    : list(opt('turns'))
        .map(Number)
        .sort((a, b) => a - b);
const RUNS = Number(opt('runs', '1'));
const MODEL = opt('model', null);
const VARIANT = opt('variant', 'normal');
const ROWS_OVERRIDE = opt('rows-override', null) === null ? null : Number(opt('rows-override'));
const TIME_LIMIT = opt('time-limit', null) === null ? undefined : Number(opt('time-limit'));
const AUTO_CONFIRM = !flag('no-auto-confirm');
// A scenario may carry its own Google Ads size: google_ads:large (else --variant).
const splitId = (entry) => {
  const [id, variant = VARIANT] = entry.split(':');
  return { id, variant };
};
for (const { id, variant } of IDS.map(splitId)) {
  if (!['normal', 'large'].includes(variant))
    throw new Error(`${id}:${variant}: the variant is normal or large`);
  if (!SCENARIO_IDS.includes(id))
    throw new Error(`Unknown scenario ${id}; choose from ${SCENARIO_IDS.join(', ')}`);
}
if (TURNS && (!TURNS.length || TURNS.some((t) => !(t >= 1 && t <= 4))))
  throw new Error('--turns: turn numbers 1 to 4 (tab scenarios have 3, reports_dashboard 4)');
if (!(RUNS >= 1)) throw new Error('--runs: 1 or more');
if (!['normal', 'large'].includes(VARIANT)) throw new Error('--variant: normal or large');
if (ROWS_OVERRIDE !== null && !(ROWS_OVERRIDE >= 1))
  throw new Error('--rows-override: a positive number');

const OUT = path.join(REPO, '.scratch', 'bench', LABEL);
mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'log.txt');
const log = (line) => {
  console.log(line);
  appendFileSync(LOG, line + '\n');
};

const credential = JSON.parse(
  readFileSync(path.join(REPO, '.local', 'live-ai-credential.json'), 'utf8')
);
if (credential.provider !== 'gemini' || typeof credential.apiKey !== 'string')
  throw new Error('Expected a gemini credential in .local/live-ai-credential.json');

const meta = {
  label: LABEL,
  model: MODEL || 'app default',
  limitSecs: null,
  maxRounds: null,
  runs: RUNS,
  variant: VARIANT,
  rowsOverride: ROWS_OVERRIDE,
  scenarios: IDS,
  turns: TURNS,
  autoConfirm: AUTO_CONFIRM,
  started: new Date().toISOString(),
};
const records = [];
const save = () => {
  const totals = aggregate(records);
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ meta, totals, records }, null, 2));
  writeFileSync(path.join(OUT, 'results.md'), markdown({ label: LABEL, meta, records, totals }));
  return totals;
};

log(
  `=== chat-bench ${LABEL}: scenarios=${IDS.join(',')} turns=${TURNS ? TURNS.join(',') : 'all'} runs=${RUNS} variant=${VARIANT} model=${MODEL || 'default'} rowsOverride=${ROWS_OVERRIDE ?? '-'} autoConfirm=${AUTO_CONFIRM}`
);
let liveRequests = 0;
for (const entry of IDS) {
  const { id, variant } = splitId(entry);
  for (let run = 1; run <= RUNS; run++) {
    const scenario = buildScenario(id, { run, turns: TURNS, rows: ROWS_OVERRIDE });
    // Named with its size when the entry gave one, so normal and large stay apart in the results.
    if (entry.includes(':')) scenario.id = entry;
    if (!scenario.turns.length) continue;
    const rt = createBenchRuntime({
      provider: 'live',
      apiKey: credential.apiKey,
      model: MODEL,
      timeLimit: TIME_LIMIT,
      googleAds: scenario.family === 'tab' ? null : { variant },
    });
    meta.model = rt.model;
    meta.limitSecs = rt.limitSecs;
    meta.maxRounds = rt.maxRounds;
    log(
      `--- ${scenario.label} (${id}) run ${run}: ${scenario.rowsRequested ? scenario.rowsRequested.toLocaleString('en-US') + ' rows, ' : ''}${rt.ads ? `fake Google Ads ${variant} (${rt.ads.data.campaigns.length} campaigns, ${rt.ads.data.keywords.length} keywords, ${rt.ads.data.terms.length} search terms), ` : ''}model ${rt.model}, time limit ${rt.limitSecs}s, round cap ${rt.maxRounds}`
    );
    try {
      runConversation(rt, scenario, {
        run,
        autoConfirm: AUTO_CONFIRM,
        onTurn(record, result) {
          records.push(record);
          log(`  turn ${record.turn} ${record.kind}: "${record.prompt}"`);
          log(
            `    stop=${record.stop} done=${record.completed} rounds=${record.rounds} secs=${record.seconds} (wall ${record.wall_seconds}, calc ${record.calc_seconds}) requests=${result.requests} executions=${result.executions}`
          );
          if (record.rows_requested)
            log(
              `    rows ${record.rows_written}${record.rows_approx ? '~' : ''}/${record.rows_requested} ratio=${record.rows_ratio} dataTab=${record.data_tab} volatileData=${record.data_volatile}`
            );
          log(
            `    nonzero=${record.nonzero_numbers} liveZeros=${record.live_zero_cells} dataTotalsRows=${record.data_summary_rows}`
          );
          log(
            `    derived=[${record.derived_tabs.join(', ')}] source=[${record.source_tabs.join(', ')}] formulas=${record.formula_cells} live=${record.live_cells} values=${record.value_cells} constants=${record.constant_formulas} labels=${record.label_cells} fetched=${record.fetched_cells} share=${record.formula_share} srcShare=${record.source_formula_share} emptyNewTabs=${record.empty_new_tabs}`
          );
          log(
            `    errors=${record.error_cells} (derived ${record.error_cells_derived}, tool-reported ${record.tool_reported_errors}) new=${record.error_cells_new} unevaluated=${record.unevaluated_formulas} charts=${record.charts} (empty ${record.charts_empty}) pivots=${record.pivots} (empty ${record.pivots_empty}) dashboardTab=${record.dashboard_tab} saved=${record.saved_dashboard} failedSteps=${record.failed_steps} malformed=${record.malformed_calls} confirm=${record.needs_confirmation} claims=${record.claims_mismatch ? 'MISMATCH' : 'ok'} numbers=${record.numbers_matched}/${record.numbers_checked} accurate=${record.answer_accurate}`
          );
          if (record.waste_recall !== undefined)
            log(
              `    waste recall=${record.waste_recall} precision=${record.waste_precision} window=${record.waste_window} named=[${record.waste_named.join(', ')}] flagged=[${(record.waste_flagged || []).join(', ')}] expected=[${record.waste_expected.join(', ')}]`
            );
          if (record.ads_requests !== undefined)
            log(
              `    fake Google Ads this turn: ${record.ads_requests} requests, ${record.ads_rows} rows, ${record.ads_rejected} rejected`
            );
          if (record.edit_kind) log(`    edit ${record.edit_kind} applied=${record.edit_applied}`);
          if (record.derived_consistency !== undefined)
            log(
              `    derived consistency=${record.derived_consistency} [${(record.derived_checked || []).join('; ')}]`
            );
          if (record.kind === 'entity')
            log(
              `    entity key=${record.entity_key} keys=${record.entity_keys} tab=${record.entity_tab_name} live=${record.entity_formula_share} verified=${record.entity_columns_verified} [${record.entity_columns.join('; ')}] segment=${record.segment_column} (${record.segment_detail}) retention=${record.retention_measure} [${record.retention_evidence.join('; ')}]`
            );
          if (record.report_rows)
            log(`    reports saved=${record.reports_saved} new=[${record.report_rows.join(', ')}]`);
          if (record.path)
            log(
              `    path=${record.path} readsReportTabs=${record.reads_report_tabs} reportTabsEdited=[${(record.report_tabs_edited || []).join(', ')}]`
            );
          if (record.stale_after_refresh !== undefined)
            log(
              `    refresh: stale=${record.stale_after_refresh} ranges ${record.stale_ranges}/${record.ranges_checked} (partial ${record.ranges_partial}) totals ${record.stale_kpis}/${record.kpis_checked} typed ${record.frozen_numbers} rows ${record.report_rows_before.join(' ')} -> ${record.report_rows_after.join(' ')} errors=${record.refresh_errors.length}`
            );
          log(
            `    tools: ${result.tools.map((t) => t.name + (t.action ? '/' + t.action : '') + (t.error ? '!' : '')).join(', ') || '-'}`
          );
          log(`    tabs: ${record.tabs.join(' ')}`);
          for (const e of record.failed_step_sample) log(`    failed step: ${e}`);
          for (const e of record.error_sample) log(`    error cell: ${e}`);
          for (const e of record.unevaluated_sample) log(`    unevaluated: ${e}`);
          for (const e of record.claims_evidence) log(`    claim: ${e}`);
          for (const e of record.answer_mismatches || []) log(`    unsupported number: ${e}`);
          for (const e of record.stale_sample || []) log(`    stale: ${e}`);
          for (const e of record.refresh_errors || []) log(`    refresh error: ${e}`);
          log(`    reply: ${record.reply.replace(/\s+/g, ' ').slice(0, 600)}`);
          save();
        },
      });
    } catch (error) {
      log(`  conversation stopped: ${String(error && error.stack).slice(0, 600)}`);
    }
    if (rt.ads)
      log(
        `  fake Google Ads served ${rt.ads.stats.requests} requests, ${rt.ads.stats.rows} rows, ${rt.ads.stats.errors} rejected queries`
      );
    liveRequests += rt.transport ? rt.transport.requests.length : 0;
  }
}
const totals = save();
log(
  `=== done: ${records.length} turns, ${liveRequests} live requests. pass rates: ${JSON.stringify(Object.fromEntries(Object.entries(totals.pass).map(([k, v]) => [k, `${v.pass}/${v.of}`])))}`
);
log(`results: ${path.join(OUT, 'results.md')}`);
