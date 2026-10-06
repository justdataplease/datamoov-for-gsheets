// One chained benchmark conversation: its turns run in order in one session (one book, one
// conversation id), each a fresh request carrying the previous turns as transcript, as the
// sidebar sends them. Each turn is measured from the book right after it; Google Ads turns are
// also checked against the fake's ground truth, and a reports scenario ends with a refresh.
import { randomUUID } from 'node:crypto';
import { runRequest } from './runtime.mjs';
import {
  snapshot,
  findDataSheet,
  measureTurn,
  chartTitles,
  editApplied,
  savedPlans,
} from './metrics.mjs';
import { signature, tabStats } from './cells.mjs';
import { TAB_TURN_KINDS } from './scenarios.mjs';
import { checkNumbers, adsFacts, bookFacts, wasteRecall } from './accuracy.mjs';
import {
  captureBeforeRefresh,
  refreshAndMeasure,
  reportTabsEdited,
  dashboardPath,
  reportTabs,
} from './refresh.mjs';

// scenario: { id, family, turns: [{ n, kind, text, edit? }], rowsRequested, nouns, seed?,
// refresh? }. The older form (turns as numbers with prompt(turn)) is also accepted.
export function runConversation(
  rt,
  scenario,
  { run = 1, autoConfirm = true, onTurn = () => {} } = {}
) {
  const family = scenario.family || 'tab';
  const turns = scenario.turns.map((t) =>
    typeof t === 'number' ? { n: t, kind: TAB_TURN_KINDS[t - 1], text: scenario.prompt(t) } : t
  );
  const conversationId = randomUUID();
  let transcript = [];
  let dataSheetId = null;
  if (scenario.seed) {
    dataSheetId = rt.seedTab(scenario.seed.tab, scenario.seed.table).id;
    transcript = scenario.seed.transcript.slice();
  }
  const records = [];
  for (const [index, turn] of turns.entries()) {
    const before = snapshot(rt, dataSheetId);
    const titlesBefore = chartTitles(rt);
    const plansBefore = turn.kind === 'edit' ? savedPlans(rt) : [];
    const reportsBefore = new Set(
      turn.kind === 'save_report' ? reportTabs(rt).map((r) => r.id) : []
    );
    const adsBefore = rt.ads
      ? { requests: rt.ads.stats.requests, rows: rt.ads.stats.rows, errors: rt.ads.stats.errors }
      : null;
    const result = runRequest(rt, { text: turn.text, transcript, conversationId, autoConfirm });
    transcript = transcript.concat(result.transcriptAppend);
    // The generated data tab is fixed by turn 1 (or the seed).
    if (family === 'tab' && turn.n === 1 && !scenario.seed)
      dataSheetId = findDataSheet(rt)?.id ?? null;
    const measured = measureTurn(rt, {
      before,
      result,
      turn: turn.n,
      kind: turn.kind,
      rowsRequested: family === 'tab' ? scenario.rowsRequested : null,
      dataSheetId,
      nouns: scenario.nouns,
    });
    const record = { scenario: scenario.id, family, run, prompt: turn.text, ...measured };
    // What this turn asked of the fake Google Ads API: a dashboard over an empty fetch shows up
    // here (and as a page of zeros: not delivered, metrics.mjs).
    if (adsBefore) {
      record.ads_requests = rt.ads.stats.requests - adsBefore.requests;
      record.ads_rows = rt.ads.stats.rows - adsBefore.rows;
      record.ads_rejected = rt.ads.stats.errors - adsBefore.errors;
    }
    // Numbers the reply states, against facts the harness computes.
    let answer;
    if (rt.ads) {
      const truth = rt.ads.truth();
      answer = checkNumbers(result.text, adsFacts(truth, rt.ads.data));
      if (turn.kind === 'analysis') {
        const waste = wasteRecall(result.text, truth);
        record.waste_recall = waste ? waste.recall : null;
        record.waste_window = waste ? waste.window : null;
        record.waste_expected = waste ? waste.expected : [];
        record.waste_named = waste ? waste.named : [];
        record.waste_precision = waste ? waste.precision : null;
        record.waste_flagged = waste ? waste.flagged : [];
      }
    } else {
      const dataSheet = rt.f.book.sheets.find((s) => s.id === dataSheetId) || null;
      answer = checkNumbers(
        result.text,
        bookFacts(rt.f.book, dataSheet, dataSheet ? tabStats(rt, dataSheet).headerRow : 0)
      );
    }
    record.numbers_checked = answer.numbers_checked;
    record.numbers_matched = answer.numbers_matched;
    record.answer_mismatches = answer.mismatches.slice(0, 8);
    record.answer_accurate =
      turn.kind === 'analysis'
        ? // Every zero-conversion campaign named, and at least half of the campaigns the reply
          // flags as waste really are (naming every campaign is no answer).
          answer.mismatches.length === 0 &&
          record.waste_recall === 1 &&
          record.waste_precision !== null &&
          record.waste_precision >= 0.5
        : answer.numbers_checked
          ? answer.mismatches.length === 0
          : null;
    if (turn.kind === 'edit') {
      record.edit_kind = turn.edit || null;
      record.edit_applied = editApplied(rt, { before, titlesBefore, plansBefore, edit: turn.edit });
    }
    if (turn.kind === 'save_report') {
      const tabs = reportTabs(rt);
      // Reports saved this turn (a report may write into a tab that was there before).
      const fresh = tabs.filter((r) => !reportsBefore.has(r.id));
      const rows = fresh.map((r) => tabStats(rt, r.sheet).dataRows);
      record.reports_saved = tabs.length;
      record.report_rows = fresh.map((r, i) => `${r.sheet.name}:${rows[i]}`);
      // A saved report that fetched no row (an empty resource, a window with no data) is not done.
      record.completed = record.completed && fresh.length > 0 && rows.every((n) => n > 0);
    }
    if (family === 'reports') {
      record.report_tabs_edited = reportTabsEdited(rt, before, signature);
      if (turn.kind === 'dashboard') Object.assign(record, dashboardPath(rt, result));
    }
    // The reports scenario's last turn: refresh every saved report and dashboard with more rows.
    if (scenario.refresh && index === turns.length - 1) {
      const captured = captureBeforeRefresh(rt);
      Object.assign(record, refreshAndMeasure(rt, captured, scenario.refresh));
    }
    records.push(record);
    onTurn(record, result);
  }
  return records;
}
