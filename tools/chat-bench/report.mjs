// Totals over a benchmark's turn records, and the markdown table of results.
const mean = (xs) => {
  const list = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return list.length
    ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 1000) / 1000
    : null;
};
const rate = (list, test) =>
  list.length
    ? {
        pass: list.filter(test).length,
        of: list.length,
        rate: Math.round((list.filter(test).length / list.length) * 1000) / 1000,
      }
    : { pass: 0, of: 0, rate: null };

export const MEAN_KEYS = [
  'rows_ratio',
  'formula_cells',
  'live_cells',
  'value_cells',
  'formula_share',
  'source_formula_share',
  'error_cells',
  'error_cells_new',
  'unevaluated_formulas',
  'charts',
  'charts_empty',
  'pivots',
  'failed_steps',
  'malformed_calls',
  'rounds',
  'seconds',
  'needs_confirmation',
  'numbers_checked',
  'waste_recall',
  'derived_consistency',
  'entity_formula_share',
  'entity_columns_verified',
];

export function aggregate(records) {
  // Rows are judged on the turn that generated them: later turns repeat the same count, and a
  // seeded run (turn 1 skipped) wrote none.
  const generated = records.filter(
    (r) => r.turn === 1 && r.kind === 'generate' && r.rows_requested
  );
  const means = Object.fromEntries(
    MEAN_KEYS.map((k) => [k, mean((k === 'rows_ratio' ? generated : records).map((r) => r[k]))])
  );
  // Later turns that wrote numbers on their own (non-fetched) tabs.
  const derived = records.filter((r) => r.kind !== 'generate' && r.formula_share !== null);
  // A per-entity turn that asks for a dashboard is judged as one too.
  const dashboards = records.filter(
    (r) => r.kind === 'dashboard' || (r.kind === 'entity' && r.wants_dashboard)
  );
  const entityTurns = records.filter((r) => r.kind === 'entity');
  const generatedChecked = records.filter(
    (r) => r.derived_consistency !== null && r.derived_consistency !== undefined
  );
  const scored = records.filter(
    (r) => r.answer_accurate !== null && r.answer_accurate !== undefined
  );
  const edits = records.filter(
    (r) => r.kind === 'edit' && r.edit_applied !== null && r.edit_applied !== undefined
  );
  const refreshed = records.filter(
    (r) => r.stale_after_refresh !== undefined && r.stale_after_refresh !== null
  );
  const bySpace = (list, key) => {
    const out = {};
    for (const r of list) out[r[key]] = (out[r[key]] || 0) + 1;
    return out;
  };
  return {
    turns: records.length,
    means,
    pass: {
      rows_ratio_ge_0_99: rate(generated, (r) => r.rows_ratio >= 0.99),
      // Stricter: more rows than asked is not a pass either.
      rows_within_1pct: rate(generated, (r) => r.rows_ratio >= 0.99 && r.rows_ratio <= 1.01),
      formula_share_ge_0_9: rate(derived, (r) => r.formula_share >= 0.9),
      error_cells_eq_0: rate(records, (r) => r.error_cells === 0),
      no_new_error_cells: rate(records, (r) => !r.error_cells_new),
      dashboard_has_chart: rate(dashboards, (r) => r.charts >= 1),
      completed: rate(records, (r) => r.completed),
      answer_accurate: rate(scored, (r) => r.answer_accurate === true),
      claims_match: rate(records, (r) => !r.claims_mismatch),
      edit_applied: rate(edits, (r) => r.edit_applied === true),
      fresh_after_refresh: rate(refreshed, (r) => r.stale_after_refresh === false),
      // Generated totals equal their quantity x price (within rounding) in 99% of rows.
      derived_consistency_ge_0_99: rate(generatedChecked, (r) => r.derived_consistency >= 0.99),
      // Per-entity turns: a tab with one row per key, mostly live, with checked columns, a live
      // segment column and a retention figure that matches the data.
      entity_tab: rate(entityTurns, (r) => r.entity_tab),
      entity_formula_share_ge_0_9: rate(entityTurns, (r) => r.entity_formula_share >= 0.9),
      entity_columns_verified_ge_2: rate(entityTurns, (r) => r.entity_columns_verified >= 2),
      segment_column: rate(entityTurns, (r) => r.segment_column),
      retention_measure: rate(entityTurns, (r) => r.retention_measure),
    },
    stops: bySpace(records, 'stop'),
    dashboard_paths: bySpace(
      records.filter((r) => r.path),
      'path'
    ),
    approx: {
      turns_with_unevaluated_formulas: records.filter((r) => r.errors_approx).length,
      turns_with_approx_rows: records.filter((r) => r.rows_approx).length,
      // Later turns that put no number in the book are not in formula_share_ge_0_9.
      later_turns_without_numbers: records.filter(
        (r) => r.kind !== 'generate' && r.formula_share === null
      ).length,
      turns_without_checkable_numbers: records.length - scored.length,
      // Google Ads dashboards that fetched no row from the fake: a broken fixture or query, not a
      // pass (such a page of zeros is not delivered either).
      ads_dashboards_without_rows: records.filter(
        (r) => r.family === 'ads' && r.kind === 'dashboard' && r.ads_rows === 0
      ).length,
    },
  };
}

const fmt = (v) =>
  v === null || v === undefined
    ? '-'
    : typeof v === 'boolean'
      ? v
        ? 'yes'
        : 'no'
      : typeof v === 'number'
        ? String(Math.round(v * 1000) / 1000)
        : String(v);
const pct = (r) => (r.rate === null ? '-' : `${Math.round(r.rate * 100)}% (${r.pass}/${r.of})`);
const cell = (text) => String(text).replace(/\|/g, '\\|');

// What a turn of a special kind adds: the waste recall, the edit, the dashboard path and refresh.
function extra(r) {
  const parts = [];
  if (r.ads_requests !== undefined)
    parts.push(
      `ads ${r.ads_rows} rows / ${r.ads_requests} requests${r.ads_rejected ? `, ${r.ads_rejected} rejected` : ''}`
    );
  if (r.waste_recall !== undefined)
    parts.push(
      `waste recall ${fmt(r.waste_recall)}, precision ${fmt(r.waste_precision)} (${r.waste_window || '-'})`
    );
  if (r.data_summary_rows) parts.push(`totals rows in data: ${r.data_summary_rows}`);
  if (r.live_zero_cells) parts.push(`live zeros ${r.live_zero_cells}`);
  if (r.edit_kind) parts.push(`edit ${r.edit_kind}: ${fmt(r.edit_applied)}`);
  if (r.derived_consistency !== undefined && r.derived_consistency !== null)
    parts.push(`derived consistency ${fmt(r.derived_consistency)}`);
  if (r.kind === 'entity')
    parts.push(
      `entity ${r.entity_key || '-'}: tab ${r.entity_tab_name || '-'}, live ${fmt(r.entity_formula_share)}, verified ${r.entity_columns_verified}/${r.entity_columns.length}, segment ${r.segment_detail || '-'}, retention ${fmt(r.retention_measure)}`
    );
  if (r.report_rows && r.report_rows.length) parts.push(`report ${r.report_rows.join(', ')}`);
  if (r.path) parts.push(`path ${r.path}`);
  if (r.report_tabs_edited && r.report_tabs_edited.length)
    parts.push(`edited report tabs: ${r.report_tabs_edited.join(', ')}`);
  if (r.stale_after_refresh !== undefined)
    parts.push(
      `stale after refresh: ${fmt(r.stale_after_refresh)} (ranges ${r.stale_ranges}/${r.ranges_checked}, totals ${r.stale_kpis}/${r.kpis_checked}, typed ${r.frozen_numbers ?? 0}${r.refresh_errors.length ? ', refresh errors ' + r.refresh_errors.length : ''})`
    );
  return parts.join('; ') || '-';
}

export function markdown({ label, meta, records, totals }) {
  const lines = [];
  lines.push(`# Chat benchmark: ${label}`, '');
  lines.push(
    `model: ${meta.model} · time limit: ${meta.limitSecs}s · round cap: ${meta.maxRounds} · runs: ${meta.runs} · variant: ${meta.variant} · rows override: ${meta.rowsOverride ?? '-'} · started: ${meta.started}`,
    ''
  );
  lines.push(
    '| scenario | turn | run | stop | done | rows req | rows written | ratio | derived tabs | formulas | num values | f share | src share | errors | uneval | charts | pivots | dash | failed steps | rounds | secs | confirm | claims | numbers ok | accurate | notes |'
  );
  lines.push('|' + '---|'.repeat(26));
  for (const r of records)
    lines.push(
      `| ${r.scenario} | ${r.turn} ${r.kind} | ${r.run} | ${r.stop} | ${fmt(r.completed)} | ${fmt(r.rows_requested)} | ${r.rows_requested ? fmt(r.rows_written) + (r.rows_approx ? '~' : '') : '-'} | ${fmt(r.rows_ratio)} | ${cell(r.derived_tabs.join(', ') || '-')} | ${r.formula_cells} | ${r.value_cells} | ${fmt(r.formula_share)} | ${fmt(r.source_formula_share)} | ${r.error_cells}${r.errors_approx ? '~' : ''} | ${r.unevaluated_formulas} | ${r.charts}${r.charts_empty ? ` (+${r.charts_empty} empty)` : ''} | ${r.pivots} | ${fmt(r.dashboard_tab)} | ${r.failed_steps} | ${r.rounds} | ${fmt(r.seconds)} | ${r.needs_confirmation} | ${r.claims_mismatch ? 'MISMATCH' : 'ok'} | ${r.numbers_checked ? `${r.numbers_matched}/${r.numbers_checked}` : '-'} | ${fmt(r.answer_accurate)} | ${cell(extra(r))} |`
    );
  lines.push(
    '',
    '`~` approximate: some formula could not be evaluated by the benchmark calculator (counted in uneval). done: answered (not the round cap, time-over, a question back or an error) and left what the turn asks for. f share: live numbers (formula results, spills, pivots) over live plus typed numbers (pasted values, constant formulas) the turn wrote on its own tabs, a dashboard page included; src share: the same on tabs holding fetched report or dataset rows, where values are expected. numbers ok: stated money, percentages, counts, multiples and plain figures that match a harness-computed fact within 0.5% (or the rounding shown, at most 5%), with the sign a stated direction gives; typed numbers on the sheets are no facts. accurate: all of them match (analysis turns: also every zero-conversion campaign named, and at least half the campaigns flagged as waste are). done: answered, and the rows asked for (0.99), numbers other than 0, a chart or pivot with data, or a saved report with rows. stale after refresh also counts typed numbers on the dashboard tabs, which a refresh cannot update.',
    ''
  );
  lines.push('## Totals', '');
  lines.push('| metric | mean |', '|---|---|');
  for (const [k, v] of Object.entries(totals.means)) lines.push(`| ${k} | ${fmt(v)} |`);
  lines.push('', '| pass rate | value |', '|---|---|');
  for (const [k, v] of Object.entries(totals.pass)) lines.push(`| ${k} | ${pct(v)} |`);
  lines.push(
    '',
    `Stops: ${JSON.stringify(totals.stops)}. Dashboard paths: ${JSON.stringify(totals.dashboard_paths)}.`,
    `Turns with unevaluated formulas: ${totals.approx.turns_with_unevaluated_formulas}; with approximate row counts: ${totals.approx.turns_with_approx_rows}; later turns without numbers: ${totals.approx.later_turns_without_numbers}; turns without checkable numbers: ${totals.approx.turns_without_checkable_numbers}; Google Ads dashboards that fetched no row: ${totals.approx.ads_dashboards_without_rows}.`,
    ''
  );
  const notes = records.filter(
    (r) =>
      r.claims_evidence.length ||
      r.failed_step_sample.length ||
      r.error_sample.length ||
      (r.answer_mismatches || []).length ||
      (r.stale_sample || []).length ||
      (r.refresh_errors || []).length ||
      (r.derived_checked || []).length ||
      r.kind === 'entity'
  );
  if (notes.length) {
    lines.push('## Evidence', '');
    for (const r of notes) {
      lines.push(`**${r.scenario} turn ${r.turn} run ${r.run}**`);
      for (const e of r.claims_evidence) lines.push(`- claim: ${cell(e)}`);
      for (const e of r.answer_mismatches || []) lines.push(`- unsupported number: ${cell(e)}`);
      for (const e of r.failed_step_sample) lines.push(`- failed step: ${cell(e)}`);
      for (const e of r.error_sample) lines.push(`- error cell: ${cell(e)}`);
      for (const e of r.stale_sample || []) lines.push(`- stale after refresh: ${cell(e)}`);
      for (const e of r.refresh_errors || []) lines.push(`- refresh error: ${cell(e)}`);
      for (const e of r.derived_checked || []) lines.push(`- derived column: ${cell(e)}`);
      for (const e of r.entity_columns || []) lines.push(`- entity column: ${cell(e)}`);
      for (const e of r.retention_evidence || []) lines.push(`- retention: ${cell(e)}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
