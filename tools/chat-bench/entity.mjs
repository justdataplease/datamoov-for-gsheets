// Measures of per-entity work and of generated data, read from the book (never from the reply).
//
// derivedConsistency(rt, dataSheet): on a generated table, every column whose values should be
//   computed from two others (a total next to a quantity and a price, or any column that is the
//   product, sum, difference or ratio of two others in most rows) and the share of rows where it
//   is, within rounding: a total drawn at random beside its quantity and price matches in almost
//   no row.
// entityMeasures(rt, dataSheet, { entity }): for an entity key of the data (the column whose
//   header matches the scenario's entity pattern, else the most repeated text column), the tab
//   that holds one row per distinct key (entity_tab), how much of it is live (formula share),
//   which of its number columns equal a per-key aggregate of the data (count, sum, average,
//   minimum, maximum, days since the last date), a segment column (two or more labels, live)
//   and a retention measure (repeat share, share active in the last N days, or a recency
//   column) that matches the data.
// Domain words stay in the scenarios: these read headers only through the patterns given.
import { tabStats, isConstantFormula } from './cells.mjs';

const DAY_MS = 86400000;
// Largest and smallest of a list of any length (spreading 100,000 values overflows the stack).
const maxOf = (list) => list.reduce((a, b) => (b > a ? b : a), -Infinity);
const minOf = (list) => list.reduce((a, b) => (b < a ? b : a), Infinity);
const serial = (v) =>
  v instanceof Date ? v.getTime() / DAY_MS + 25569 : typeof v === 'number' ? v : null;
const blank = (v) => v === '' || v === null || v === undefined;
const keyText = (v) =>
  v instanceof Date
    ? 'n:' + serial(v)
    : typeof v === 'number'
      ? 'n:' + v
      : 's:' + String(v).trim().toLowerCase();
const close = (a, b, rel = 0.005, abs = 0.011) =>
  Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));
const round = (x, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// What a cell shows: its value, or for a formula the calculator left, what the strict evaluator
// of tests/helpers gives (bounded); undefined when neither can tell.
function reader(rt) {
  let tries = 0;
  return (sheet, r, c) => {
    const entry = sheet.cells.get(`${r}:${c}`);
    if (!entry) return '';
    if (entry.formula && entry.value === entry.formula) {
      if (tries++ > 3000) return undefined;
      try {
        const v = rt.f.shown(sheet, r, c);
        return v && typeof v === 'object' && !(v instanceof Date) ? undefined : v;
      } catch {
        return undefined;
      }
    }
    return entry.value;
  };
}
const isLive = (sheet, entry) => {
  if (!entry) return false;
  if (entry.formula) return !isConstantFormula(entry.formula);
  if (!entry.spilledFrom) return false;
  if (String(entry.spilledFrom).startsWith('pivot:')) return true;
  const anchor = sheet.cells.get(entry.spilledFrom);
  return Boolean(anchor && anchor.formula && !isConstantFormula(anchor.formula));
};

// The data tab as { headers, rows, columns: [{ name, numeric, date, values }] }.
export function readTable(rt, sheet) {
  if (!sheet) return null;
  const stats = tabStats(rt, sheet);
  const header = stats.headerRow || 1;
  const read = reader(rt);
  const headers = [];
  for (let c = 1; c <= stats.lastColumn; c++) headers.push(String(read(sheet, header, c) ?? ''));
  const rows = [];
  for (let r = header + 1; r <= stats.lastRow; r++) {
    const row = headers.map((_, i) => read(sheet, r, i + 1));
    if (row.some((v) => !blank(v))) rows.push(row);
  }
  const columns = headers.map((name, i) => {
    const values = rows.map((row) => row[i]);
    const filled = values.filter((v) => !blank(v));
    const nums = filled.filter((v) => typeof v === 'number' || v instanceof Date);
    const numeric = filled.length > 0 && nums.length >= 0.95 * filled.length;
    const date =
      numeric &&
      (filled.some((v) => v instanceof Date) ||
        (/date|day|time|month|period|created|joined|signed|shipped|delivered|placed|billed|issued|start|end|when/i.test(
          name
        ) &&
          nums.every((v) => serial(v) > 20000 && serial(v) < 80000)));
    return { name, index: i, numeric, date, values };
  });
  return { headers, rows, columns };
}

// ---------- derived consistency ----------
const TOTAL =
  /\b(total|amount|revenue|sales|subtotal|gross|net|value|charge|billed|turnover|spend|cost|price total|line)\b/i;
const NOT_TOTAL = /\b(unit|per|each|rate|avg|average|%|percent|share|list|base|discount|tax)\b/i;
const QUANTITY =
  /\b(qty|quantity|units?|count|seats?|licen[cs]es|items|pieces|hours|weight|kg|lbs|volume|nights|days|sessions)\b/i;
const PRICE =
  /\b(price|rate|fee|unit cost|cost per|per unit|per seat|per kg|per hour|each|tariff)\b/i;

export function derivedConsistency(rt, sheet) {
  const table = readTable(rt, sheet);
  if (!table || !table.rows.length) return { derived_consistency: null, derived_checked: [] };
  const step = Math.max(1, Math.floor(table.rows.length / 5000));
  const rows = table.rows.filter((_, i) => i % step === 0);
  const numericCols = table.columns.filter((c) => c.numeric && !c.date);
  const value = (row, col) => (typeof row[col.index] === 'number' ? row[col.index] : null);
  // Adjusters a total may carry beside quantity x price: a discount fraction or percent, an
  // amount taken off or added (a fee, tax or shipping column).
  const adjusters = (t, a, b) => {
    const out = [{ name: '', fn: (x) => x }];
    for (const d of numericCols) {
      if (d === t || d === a || d === b) continue;
      const vs = rows.map((row) => value(row, d)).filter((v) => v !== null);
      if (!vs.length) continue;
      const max = maxOf(vs),
        min = minOf(vs);
      if (min >= 0 && max < 1)
        out.push({ name: ` x (1 - ${d.name})`, fn: (x, row) => x * (1 - value(row, d)) });
      if (min >= 0 && max <= 100 && max >= 1)
        out.push({ name: ` x (1 - ${d.name}%)`, fn: (x, row) => x * (1 - value(row, d) / 100) });
      out.push({ name: ` - ${d.name}`, fn: (x, row) => x - value(row, d) });
      out.push({ name: ` + ${d.name}`, fn: (x, row) => x + value(row, d) });
    }
    return out;
  };
  const score = (t) => {
    let best = { share: 0, rule: '' };
    for (let i = 0; i < numericCols.length; i++)
      for (let j = i + 1; j < numericCols.length; j++) {
        const a = numericCols[i],
          b = numericCols[j];
        if (a === t || b === t) continue;
        for (const adj of adjusters(t, a, b)) {
          let ok = 0,
            seen = 0;
          for (const row of rows) {
            const x = value(row, a),
              y = value(row, b),
              z = value(row, t);
            if (x === null || y === null || z === null) continue;
            seen++;
            const want = adj.fn(x * y, row);
            if (Number.isFinite(want) && close(z, want)) ok++;
          }
          const share = seen ? ok / seen : 0;
          if (share > best.share)
            best = { share, rule: `${t.name} = ${a.name} x ${b.name}${adj.name}` };
        }
      }
    return best;
  };
  // Any other arithmetic of two columns: a sum, a difference (of dates too, in days, hours or
  // minutes) or a ratio. Found only where it holds in most rows; a column drawn apart is not.
  const allCols = table.columns.filter((c) => c.numeric);
  const number = (row, col) => {
    const v = row[col.index];
    return v instanceof Date ? serial(v) : typeof v === 'number' ? v : null;
  };
  const OPS = [
    ['+', (x, y) => x + y, 1],
    ['-', (x, y) => x - y, 1],
    ['- (hours)', (x, y) => (x - y) * 24, 1],
    ['- (minutes)', (x, y) => (x - y) * 1440, 1],
    ['/', (x, y) => (y ? x / y : NaN), 1],
  ];
  const other = (t) => {
    let best = { share: 0, rule: '' };
    for (const a of allCols)
      for (const b of allCols) {
        if (a === t || b === t || a === b) continue;
        for (const [name, fn] of OPS) {
          // Dates only subtract; a sum is checked once per pair.
          if ((a.date || b.date) && !name.startsWith('-')) continue;
          if (name === '+' && a.index > b.index) continue;
          let ok = 0,
            seen = 0;
          for (const row of rows) {
            const x = number(row, a),
              y = number(row, b),
              z = number(row, t);
            if (x === null || y === null || z === null) continue;
            seen++;
            const want = fn(x, y);
            if (Number.isFinite(want) && close(z, want)) ok++;
          }
          const share = seen ? ok / seen : 0;
          if (share > best.share) best = { share, rule: `${t.name} = ${a.name} ${name} ${b.name}` };
        }
      }
    return best;
  };
  const checked = [];
  const hasFactors = (t) =>
    numericCols.some((c) => c !== t && QUANTITY.test(c.name)) &&
    numericCols.some(
      (c) => c !== t && PRICE.test(c.name) && !TOTAL.test(c.name.replace(PRICE, ''))
    );
  for (const t of numericCols) {
    const isTotal = TOTAL.test(t.name) && !NOT_TOTAL.test(t.name) && hasFactors(t);
    const product = score(t);
    const best = product.share >= 0.5 || isTotal ? product : other(t);
    // A column is held to a rule when its header says it is a total of a quantity and a price
    // (the product), or when it is a product, sum, difference or ratio of two others in most
    // rows already: then every row should be.
    if (isTotal || best.share >= 0.5)
      checked.push({ column: t.name, share: round(best.share), rule: best.rule, named: isTotal });
  }
  return {
    derived_consistency: consistency(checked),
    derived_checked: checked.map(
      (c) => `${c.column}: ${Math.round(c.share * 1000) / 10}% of rows (${c.rule || 'no rule'})`
    ),
  };
}

// The least share among the columns held to a rule, leaving out a column that is an input of
// another column's rule that holds (99%): beside total = quantity x price, price = quantity x
// total holds wherever the quantity is 1, and the price is no derived column for it.
// The columns a rule reads: "T = A x B x (1 - D%)" reads A, B and D.
const inputs = (rule) =>
  rule
    .split(' = ')
    .slice(1)
    .join(' = ')
    .split(/ (?:x|\+|-|\/) /)
    .map((part) =>
      part
        .replace(/^\((?:hours|minutes)\) /, '')
        .replace(/^\(1$|^\(|%?\)$/g, '')
        .trim()
    );
export function consistency(checked) {
  const holds = checked.filter((c) => c.share >= 0.99);
  const kept = checked.filter(
    (c) =>
      c.named || c.share >= 0.99 || !holds.some((d) => d !== c && inputs(d.rule).includes(c.column))
  );
  return kept.length ? minOf(kept.map((c) => c.share)) : null;
}

// The same from a record's derived_checked lines ("Total: 98.5% of rows (Total = A x B)"), for
// results measured before this rule.
export function consistencyOfLines(lines) {
  return consistency(
    (lines || []).map((line) => {
      const m = /^(.*?): ([\d.]+)% of rows \((.*)\)$/.exec(line);
      const column = m ? m[1] : line;
      return {
        column,
        share: m ? Number(m[2]) / 100 : 0,
        rule: m ? m[3] : '',
        named: TOTAL.test(column) && !NOT_TOTAL.test(column),
      };
    })
  );
}

// ---------- entity measures ----------
// The entity key of the data: a column (not a date, not unique per row) whose header matches the
// pattern, else the text column repeated most per value.
function entityKey(table, pattern) {
  const candidates = table.columns
    .map((c) => {
      const filled = c.values.filter((v) => !blank(v));
      const distinct = new Set(filled.map(keyText));
      return { col: c, distinct: distinct.size, filled: filled.length };
    })
    .filter((x) => !x.col.date && x.distinct >= 2 && x.distinct <= 0.8 * x.filled);
  const named = pattern ? candidates.filter((x) => pattern.test(x.col.name)) : [];
  const pool = named.length ? named : candidates.filter((x) => !x.col.numeric);
  // Several named columns (an id and a name): the one with the most distinct values.
  pool.sort((a, b) => b.distinct - a.distinct);
  return pool[0] ? pool[0].col : null;
}

// Per key: rows, and per number or date column its sum, minimum and maximum.
function perKey(table, key) {
  // Text columns of 2 to 8 values (a status, a channel) give filtered aggregates too: per key,
  // the rows with each value (the count of paid invoices, the last paid date).
  const filters = table.columns.filter((col) => {
    if (col === key || col.numeric) return false;
    const values = new Set(col.values.filter((v) => !blank(v)).map(keyText));
    return values.size >= 2 && values.size <= 8;
  });
  const add = (stats, row) => {
    stats.n++;
    for (const col of table.columns) {
      if (!col.numeric) continue;
      const v = serial(row[col.index]);
      if (v === null) continue;
      const slot = stats.cols.get(col.index) || { sum: 0, n: 0, min: Infinity, max: -Infinity };
      slot.sum += v;
      slot.n++;
      slot.min = Math.min(slot.min, v);
      slot.max = Math.max(slot.max, v);
      stats.cols.set(col.index, slot);
    }
  };
  const groups = new Map();
  table.rows.forEach((row) => {
    const k = row[key.index];
    if (blank(k)) return;
    const id = keyText(k);
    if (!groups.has(id)) groups.set(id, { n: 0, cols: new Map(), when: new Map() });
    const g = groups.get(id);
    add(g, row);
    for (const col of filters) {
      const v = row[col.index];
      if (blank(v)) continue;
      const name = `${col.name} = ${String(v).trim()}`;
      if (!g.when.has(name)) g.when.set(name, { n: 0, cols: new Map() });
      add(g.when.get(name), row);
    }
  });
  const conditions = [...new Set([...groups.values()].flatMap((g) => [...g.when.keys()]))];
  return { groups, conditions };
}

export function entityMeasures(rt, dataSheet, { entity = null } = {}) {
  const none = {
    entity_key: null,
    entity_tab: false,
    entity_tab_name: null,
    entity_formula_share: null,
    entity_columns: [],
    entity_columns_verified: 0,
    segment_column: false,
    segment_detail: null,
    retention_measure: false,
    retention_live: false,
    retention_evidence: [],
  };
  const table = readTable(rt, dataSheet);
  if (!table || !table.rows.length) return none;
  const key = entityKey(table, entity);
  if (!key) return none;
  const { groups, conditions } = perKey(table, key);
  const keys = [...groups.keys()];
  const dateCols = table.columns.filter((c) => c.date);
  const lastDate = dateCols.length
    ? maxOf(table.rows.map((row) => serial(row[dateCols[0].index]) ?? -Infinity))
    : null;
  const today = (() => {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / DAY_MS + 25569;
  })();
  const out = { ...none, entity_key: key.name, entity_keys: keys.length };
  const read = reader(rt);

  // The tab and column holding each key once.
  let best = null;
  for (const sheet of rt.f.book.sheets) {
    if (sheet === dataSheet) continue;
    const stats = tabStats(rt, sheet);
    for (let c = 1; c <= stats.lastColumn; c++) {
      const rowsOf = new Map();
      let duplicates = 0;
      for (let r = 1; r <= stats.lastRow; r++) {
        const v = read(sheet, r, c);
        if (blank(v) || v === undefined) continue;
        const id = keyText(v);
        if (!groups.has(id)) continue;
        if (rowsOf.has(id)) duplicates++;
        else rowsOf.set(id, r);
      }
      const coverage = rowsOf.size / keys.length;
      if (
        coverage >= 0.98 &&
        duplicates <= 0.02 * keys.length &&
        (!best || coverage > best.coverage)
      )
        best = { sheet, column: c, rowsOf, coverage, stats };
    }
  }
  if (best) {
    out.entity_tab = true;
    out.entity_tab_name = best.sheet.name;
    const { sheet, rowsOf, stats } = best;
    // Live share of the entity rows' cells, the key column included.
    let live = 0,
      typed = 0;
    const columns = new Map();
    for (const [id, r] of rowsOf) {
      for (let c = 1; c <= stats.lastColumn; c++) {
        const entry = sheet.cells.get(`${r}:${c}`);
        const v = read(sheet, r, c);
        if (!entry || blank(v)) continue;
        if (isLive(sheet, entry)) live++;
        else typed++;
        if (c === best.column) continue;
        if (!columns.has(c)) columns.set(c, []);
        columns.get(c).push([id, v, isLive(sheet, entry)]);
      }
    }
    out.entity_formula_share = live + typed ? round(live / (live + typed)) : null;
    // Which number columns are a per-key aggregate of the data.
    // Aggregates of a key's rows, then of its rows with each value of a filter column.
    const EMPTY = { n: 0, cols: new Map() };
    const views = [{ suffix: '', of: (g) => g }].concat(
      conditions.map((name) => ({ suffix: ` where ${name}`, of: (g) => g.when.get(name) || EMPTY }))
    );
    const aggregates = [];
    for (const view of views) {
      aggregates.push({ name: 'rows' + view.suffix, of: (g) => view.of(g).n });
      for (const col of table.columns) {
        if (!col.numeric) continue;
        const slot = (g) => view.of(g).cols.get(col.index);
        if (!col.date) {
          aggregates.push({ name: `sum ${col.name}${view.suffix}`, of: (g) => slot(g)?.sum ?? 0 });
          aggregates.push({
            name: `avg ${col.name}${view.suffix}`,
            of: (g) => slot(g) && slot(g).sum / slot(g).n,
          });
        }
        aggregates.push({
          name: `min ${col.name}${view.suffix}`,
          of: (g) => slot(g)?.min,
          day: col.date,
        });
        aggregates.push({
          name: `max ${col.name}${view.suffix}`,
          of: (g) => slot(g)?.max,
          day: col.date,
        });
        if (col.date) {
          aggregates.push({
            name: `days since last ${col.name}${view.suffix}`,
            recency: true,
            of: (g) => slot(g)?.max,
          });
          aggregates.push({
            name: `days between first and last ${col.name}${view.suffix}`,
            of: (g) => slot(g) && slot(g).max - slot(g).min,
          });
        }
      }
    }
    const header = (c) => {
      for (let r = minOf([...rowsOf.values()]) - 1; r >= 1; r--) {
        const v = read(sheet, r, c);
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return 'column ' + c;
    };
    let segment = null;
    for (const [c, list] of columns) {
      const nums = list.filter(([, v]) => serial(v) !== null);
      if (nums.length >= 0.9 * rowsOf.size) {
        let matched = null;
        for (const agg of aggregates) {
          let ok = 0;
          if (agg.recency) {
            // Days since the last date, counted to any fixed day (the data's last day, today):
            // value + last date is one constant for every key.
            const sums = nums.map(([id, v]) => serial(v) + agg.of(groups.get(id)));
            const mid = sums.slice().sort((a, b) => a - b)[sums.length >> 1];
            ok = sums.filter((s) => Math.abs(s - mid) <= 1).length;
          } else
            for (const [id, v] of nums) {
              const want = agg.of(groups.get(id));
              if (want === undefined || want === null) continue;
              if (agg.day ? Math.abs(serial(v) - want) <= 1 : close(serial(v), want)) ok++;
            }
          if (ok >= 0.95 * nums.length) {
            matched = agg;
            break;
          }
        }
        out.entity_columns.push(`${header(c)}: ${matched ? matched.name : 'unmatched'}`);
        if (matched) out.entity_columns_verified++;
        if (matched && matched.recency) {
          out.retention_measure = true;
          if (nums.every(([, , liveCell]) => liveCell)) out.retention_live = true;
          out.retention_evidence.push(`${sheet.name} ${header(c)}: days since last per key`);
        }
        continue;
      }
      const texts = list.filter(([, v]) => typeof v === 'string' && v.trim());
      const labels = new Set(texts.map(([, v]) => v.trim()));
      if (
        texts.length >= 0.9 * rowsOf.size &&
        labels.size >= 2 &&
        labels.size <= 12 &&
        // A segment groups keys: a column with a label per key or nearly (a name) is none.
        labels.size <= rowsOf.size / 2 &&
        (!segment || (texts.every((x) => x[2]) && !segment.live))
      )
        segment = {
          column: header(c),
          labels: labels.size,
          live: texts.every(([, , isLiveCell]) => isLiveCell),
        };
    }
    if (segment) {
      out.segment_column = segment.live;
      out.segment_detail = `${segment.column}: ${segment.labels} labels${segment.live ? ', live' : ', typed'}`;
    }
  }

  // Retention figures anywhere outside the data tab: the share of keys seen more than once, or
  // active (or lapsed) within the last N days of the data or of today, as a fraction or a
  // percent. Counts are left out: a count of keys is too easily some other count.
  const facts = [];
  const repeat = keys.filter((id) => groups.get(id).n >= 2).length;
  facts.push({ name: 'repeat share', share: repeat / keys.length });
  if (dateCols.length) {
    const lastOf = (id) => groups.get(id).cols.get(dateCols[0].index)?.max ?? -Infinity;
    for (const [label, ref] of [
      ['data', lastDate],
      ['today', today],
    ])
      for (const days of [30, 60, 90, 180, 365]) {
        const active = keys.filter((id) => lastOf(id) > ref - days - 0.5).length;
        if (active === 0 || active === keys.length) continue;
        facts.push({ name: `active in last ${days} days (${label})`, share: active / keys.length });
        facts.push({
          name: `lapsed over ${days} days (${label})`,
          share: 1 - active / keys.length,
        });
      }
  }
  for (const sheet of rt.f.book.sheets) {
    if (sheet === dataSheet) continue;
    for (const [cellKey, entry] of sheet.cells) {
      const [r, c] = cellKey.split(':').map(Number);
      const v = read(sheet, r, c);
      if (typeof v !== 'number' || Number.isInteger(v)) continue;
      const fact = facts.find(
        (f) =>
          (v > 0 && v < 1 && Math.abs(v - f.share) <= 0.0005) ||
          (v > 1 && v < 100 && Math.abs(v - f.share * 100) <= 0.05)
      );
      if (!fact) continue;
      out.retention_measure = true;
      if (isLive(sheet, entry)) out.retention_live = true;
      if (out.retention_evidence.length < 4)
        out.retention_evidence.push(
          `${sheet.name}!${cellKey} ${round(v)}: ${fact.name}${isLive(sheet, entry) ? '' : ' (typed)'}`
        );
    }
  }
  return out;
}
