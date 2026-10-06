import { isConstantFormula, OUTPUT_RECORD } from './cells.mjs';

// Answer accuracy: the numbers a reply states, checked against numbers the harness computes
// itself, never against the model's words. For Google Ads turns the facts come from the fake's
// own data (totals, per-campaign and per-channel values, daily and weekly totals, period changes,
// over the usual windows); for tab turns from the book (every number a tab shows, and per
// category totals and shares of the data tab). A stated number is supported when some fact of
// its kind matches within 0.5% (or the rounding the reply shows, whichever is wider).
//
// Checked: money ($1,234.56, 12.3k USD, 1.234,50 €), percentages (12.5%), counts next to a
// metric word (1,127 conversions), multiples (ROAS 2.8x), and plain figures with no unit
// (12,345.60, 48213), which tables and sentences state as often as money. Dates, years, ids,
// A1 references, day counts, table sizes (rows, keywords: claims.mjs) and list positions are
// not numbers about the data and are left out.

// A figure: 1,234.56 · 1234.56 · 1.234,56 (comma decimals).
const FIG = String.raw`-?\d{1,3}(?:\.\d{3})+,\d{1,2}(?!\d)|-?\d[\d,]*(?:\.\d+)?`;
// A scale suffix, not the start of a word ("$12 more" is not 12 million).
const SUFFIX = String.raw`(?:(k|K|M|m(?:illion)?|bn|billion)(?![A-Za-z]))?`;
const MONEY = new RegExp(
  String.raw`(?:(US\$|\$|€|£|USD\s?|EUR\s?)\s?(${FIG})\s?${SUFFIX}(?![\d.,]*%))|(?:(${FIG})\s?(k|K|M)?\s?(?:USD|dollars|EUR|euros|€|£)(?![A-Za-z]))`,
  'g'
);
const PERCENT = /(-?\d[\d,]*(?:\.\d+)?)\s?%/g;
const COUNT_WORDS =
  'clicks|impressions|conversions|conversion|orders|invoices|employees|shipments|leads|deals|customers|subscriptions|units|transactions|deliveries|parcels|contacts|opportunities|hires|accounts';
// A plain figure: grouped (12,345), with decimals and 4+ digits or exactly 2 decimals, or 5+
// digits. Not part of an id, a date, a time, a version or a reference (a letter, -, /, :, ! or
// # beside it), and not a size of something (rows, keywords, days: claims.mjs checks sizes).
const BARE =
  /(?<![\w.,$€£\-/:!#@])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}\.\d+|\d+\.\d{2}|\d{5,})(?![\w%\-/:]|[.,]\d)/g;
const SIZE_AFTER =
  /^\s*(?:rows?|records?|entries|lines|cells|columns|tabs?|sheets?|days?|weeks?|months?|years?|hours?|keywords?|(?:search\s+)?terms?|queries|campaigns?|ad\s+groups?|ads|pages?|characters?)\b/i;
const SIZE_BEFORE = /\b(?:rows?|row number|line|top|first|last|bottom|version)\s*$/i;
// A change stated with its direction: "up 12%", "decreased by $300", "-4.1%". The word right
// before the number (or "by" between) sets the sign the fact must have; "fell to $300" states
// a level, not a change.
const AMOUNT_LEAD = String.raw`\s+(?:by\s+)?(?:about\s+|around\s+|roughly\s+|nearly\s+)?(?:US\$|\$|€|£|USD\s?|EUR\s?)?$`;
const UP_BEFORE = new RegExp(
  String.raw`\b(?:up|increas\w*|rose|risen|grew|grown|higher|jump\w*|gain\w*|climb\w*)` +
    AMOUNT_LEAD,
  'i'
);
const DOWN_BEFORE = new RegExp(
  String.raw`\b(?:down|decreas\w*|fell|fallen|drop\w*|declin\w*|lower|shr[ai]nk\w*|dipp?\w*|slipp?\w*)` +
    AMOUNT_LEAD,
  'i'
);
const COUNT = new RegExp(
  `(?<![\\d.,$€£])(\\d[\\d,]*(?:\\.\\d+)?)\\s?(k|K|M)?\\s+(?:(?:total|new|paid|more|fewer)\\s+)?(${COUNT_WORDS})\\b`,
  'g'
);
const MULTIPLE =
  /(?:ROAS|return on ad spend)[^.\d\n]{0,20}(\d+(?:\.\d+)?)\s?(?:x|×)?|(\d+(?:\.\d+)?)\s?(?:x|×)\s+ROAS/gi;

const scale = (suffix) =>
  !suffix ? 1 : /^k$/i.test(suffix) ? 1e3 : /^(bn|billion)$/i.test(suffix) ? 1e9 : 1e6;
const european = (text) => /^-?\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(String(text));
const num = (text) =>
  european(text)
    ? Number(String(text).replace(/\./g, '').replace(',', '.'))
    : Number(String(text).replace(/,/g, ''));
// Half a unit of the last digit shown, scaled: "$55.4k" is 55,400 ± 50.
const halfUnit = (text, suffix) => {
  const decimals = european(text)
    ? String(text).split(',')[1].length
    : (String(text).split('.')[1] || '').length;
  return 0.5 * Math.pow(10, -decimals) * scale(suffix);
};

// Numbers a reply states, each { kind, value, tolerance, text }.
export function statedNumbers(reply) {
  const plain = String(reply || '').replace(/\*\*|__|`/g, '');
  const out = [];
  const taken = [];
  const free = (start, end) => !taken.some(([a, b]) => start < b && end > a);
  const push = (kind, m, text, suffix, value) => {
    if (!free(m.index, m.index + m[0].length)) return;
    if (!Number.isFinite(value)) return;
    taken.push([m.index, m.index + m[0].length]);
    const before = plain.slice(Math.max(0, m.index - 40), m.index);
    const direction =
      /^\s*-/.test(m[0]) || value < 0
        ? -1
        : UP_BEFORE.test(before)
          ? 1
          : DOWN_BEFORE.test(before)
            ? -1
            : 0;
    out.push({
      kind,
      value,
      tolerance: halfUnit(text, suffix),
      text: m[0].trim(),
      index: m.index,
      direction,
    });
  };
  for (const m of plain.matchAll(MONEY)) {
    const text = m[2] ?? m[4],
      suffix = m[3] ?? m[5];
    push('money', m, text, suffix, num(text) * scale(suffix));
  }
  for (const m of plain.matchAll(PERCENT)) push('percent', m, m[1], null, num(m[1]));
  for (const m of plain.matchAll(MULTIPLE)) {
    const text = m[1] ?? m[2];
    push('multiple', m, text, null, num(text));
  }
  for (const m of plain.matchAll(COUNT)) {
    // Not a year, a day count or a rank.
    const before = plain.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(top|first|last|bottom)\s*$/i.test(before)) continue;
    push('count', m, m[1], m[2], num(m[1]) * scale(m[2]));
  }
  for (const m of plain.matchAll(BARE)) {
    const after = plain.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const before = plain.slice(Math.max(0, m.index - 12), m.index);
    if (SIZE_AFTER.test(after) || SIZE_BEFORE.test(before)) continue;
    push('number', m, m[1], null, num(m[1]));
  }
  out.sort((a, b) => a.index - b.index);
  // "from $250 to $4,500", "between 2% and 9%", "$250-$4,500": a range of values, stated as
  // its bounds.
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i],
      b = out[i + 1];
    if (a.kind !== b.kind || a.range || b.range) continue;
    const between = plain.slice(a.index + a.text.length, b.index);
    const lead = plain.slice(Math.max(0, a.index - 24), a.index);
    if (
      /^\s*[-–—]\s*$/.test(between) ||
      (/^\s*(to|and)\s*$/i.test(between) &&
        /\b(from|between|range[sd]?|ranging)\b[^.\n]*$/i.test(lead))
    )
      a.range = b.range = { lo: Math.min(a.value, b.value), hi: Math.max(a.value, b.value) };
  }
  return out;
}

// facts: { money: number[], percent: number[], count: number[], multiple: number[] }, or scoped
// facts (adsFacts) whose lists depend on the sentence a number stands in.
export function checkNumbers(reply, facts) {
  const plain = String(reply || '').replace(/\*\*|__|`/g, '');
  const stated = statedNumbers(plain);
  const mismatches = [];
  let matched = 0;
  for (const n of stated) {
    const pool = facts.scoped ? facts.forSentence(sentenceAt(plain, n.index)) : facts;
    // A plain figure may be a fact of any kind.
    const list =
      n.kind === 'number'
        ? [].concat(pool.money || [], pool.count || [], pool.multiple || [], pool.percent || [])
        : pool[n.kind] || [];
    // A bound of a stated range: some column's values lie within the range and reach close to
    // both bounds (5% of the range), as generated values drawn between them do.
    if (n.range) {
      const slack = Math.max(0.05 * (n.range.hi - n.range.lo), n.tolerance);
      const fits = (pool.ranges || []).some(
        ([min, max]) =>
          min >= n.range.lo - slack &&
          max <= n.range.hi + slack &&
          min - n.range.lo <= slack &&
          n.range.hi - max <= slack
      );
      if (fits) {
        matched++;
        continue;
      }
    }
    const v = Math.abs(n.value);
    // The rounding the reply shows widens the match, but not past 5% of the value (a percent:
    // half a point): "$1M" is no fair rounding of $1.4M, nor "$0.1M" of $55k.
    const shown = Math.min(n.tolerance, Math.max(0.05 * v, n.kind === 'percent' ? 0.5 : 0));
    const tolerance = Math.max(0.005 * v, shown, 1e-9);
    // A change stated with a direction must have that sign ("up 12%" is no fall of 12%); one
    // stated without it ("changed 12%", "12% vs last month") matches either.
    const signed = (f) => !n.direction || Math.sign(f) === n.direction;
    if (list.some((f) => signed(f) && Math.abs(Math.abs(f) - v) <= tolerance)) matched++;
    else mismatches.push(`${n.text} (no ${n.kind} fact within ${round(tolerance)})`);
  }
  return { numbers_checked: stated.length, numbers_matched: matched, mismatches };
}
const round = (x) => Math.round(x * 1000) / 1000;
// The sentence (or line, or table row) around a position: from the last line break or sentence
// end before it to the next one after it.
export function sentenceAt(text, index) {
  let start = 0;
  for (const m of text.slice(0, index).matchAll(/\n|[.!?;](?=\s)/g)) start = m.index + 1;
  const rest = text.slice(index);
  const stop = rest.search(/\n|[.!?;](?=\s|$)/);
  return text.slice(start, stop < 0 ? text.length : index + stop);
}

const empty = () => ({ money: [], percent: [], count: [], multiple: [], ranges: [] });
const merge = (into, from) => {
  for (const k of Object.keys(into)) for (const v of from[k]) into[k].push(v);
  return into;
};
const TOTAL_KEYS = ['spend', 'value', 'clicks', 'impressions', 'conversions'];
// Money, counts, rates and multiples of one total t (spend and value in dollars); shares of whole.
function metricFacts(t, whole) {
  const facts = empty();
  facts.money.push(t.spend, t.value);
  facts.count.push(t.clicks, t.impressions, t.conversions);
  if (t.impressions) {
    facts.percent.push((100 * t.clicks) / t.impressions);
    facts.money.push((1000 * t.spend) / t.impressions);
  }
  if (t.clicks) {
    facts.money.push(t.spend / t.clicks);
    facts.percent.push((100 * t.conversions) / t.clicks);
  }
  if (t.conversions) facts.money.push(t.spend / t.conversions, t.value / t.conversions);
  if (t.spend) {
    facts.multiple.push(t.value / t.spend);
    facts.percent.push((100 * t.value) / t.spend);
  }
  if (whole)
    for (const k of ['spend', 'conversions', 'clicks', 'value'])
      if (whole[k]) facts.percent.push((100 * t[k]) / whole[k]);
  return facts;
}
// Changes from b to a: percent changes, differences, rate changes in percent and in points.
function changeFacts(a, b) {
  const facts = empty();
  for (const k of TOTAL_KEYS) {
    if (b[k]) facts.percent.push((100 * (a[k] - b[k])) / b[k]);
    (k === 'spend' || k === 'value' ? facts.money : facts.count).push(a[k] - b[k]);
  }
  const r = (t, n, d) => (t[d] ? t[n] / t[d] : null);
  for (const [n, d] of [
    ['spend', 'conversions'],
    ['spend', 'clicks'],
    ['clicks', 'impressions'],
    ['value', 'spend'],
    ['conversions', 'clicks'],
  ]) {
    const x = r(a, n, d),
      y = r(b, n, d);
    if (x !== null && y) facts.percent.push((100 * (x - y)) / y);
    if (x !== null && y !== null) {
      facts.percent.push(100 * (x - y));
      facts.money.push(x - y);
      facts.multiple.push(x - y);
    }
  }
  return facts;
}
const addUp = (list) => {
  const t = { spend: 0, value: 0, clicks: 0, impressions: 0, conversions: 0 };
  for (const x of list) for (const k of TOTAL_KEYS) t[k] += x[k];
  return t;
};
const CHANNEL_WORDS = {
  SEARCH: /\bsearch\b/i,
  PERFORMANCE_MAX: /\bpmax\b|performance max/i,
  DISPLAY: /\bdisplay\b/i,
  VIDEO: /\bvideo|youtube\b/i,
  DEMAND_GEN: /demand gen/i,
};
const PAIRS = [
  ['last30', 'previous30'],
  ['last7', 'previous7'],
  ['last14', 'previous14'],
];
const DAY_WORDS =
  /\bdays?\b|daily|peak|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i;
const WEEK_WORDS = /\bweeks?\b|weekly|\bwk\b/i;
// A count of days or weeks ("the last 30 days", "a 12-week window") names a window, not one day
// or week: it opens no daily or weekly facts.
const WINDOW = /\b\d+[\s-]*(?:days?|weeks?|wks?)\b/gi;
const CHANGE_WORDS =
  /\b(up|down|increase[ds]?|decrease[ds]?|rose|fell|grew|drop(ped)?|declin\w*|changes?|changed|vs\.?|versus|compared|previous|prior|before|growth|jump\w*|higher|lower|more|less|from)\b|Δ/i;

// Facts of the fake Google Ads account, scoped by what a sentence talks about, so a number is
// only compared with the facts it could be: account totals (every window) always; the spend
// without conversions when the sentence names no campaign or speaks of waste; a campaign's
// values when the sentence names it (and the sums of the campaigns it names together); a
// channel's when it names the channel; daily or weekly totals when it speaks of days or weeks;
// period changes when it speaks of a change. Unscoped, a number would find some match among
// thousands of facts by chance.
export function adsFacts(truth, data) {
  const periods = Object.entries(truth.periods);
  const base = empty(),
    waste = empty();
  for (const [, p] of periods) {
    merge(base, metricFacts(p.total, null));
    const wasted = addUp(p.campaigns.filter((c) => p.zeroConversion.includes(c.name)));
    waste.money.push(wasted.spend);
    waste.count.push(wasted.clicks, wasted.impressions);
    if (p.total.spend) waste.percent.push((100 * wasted.spend) / p.total.spend);
  }
  const change = empty();
  for (const [a, b] of PAIRS)
    if (truth.periods[a] && truth.periods[b])
      merge(change, changeFacts(truth.periods[a].total, truth.periods[b].total));
  const channels = new Map();
  for (const [channel, word] of Object.entries(CHANNEL_WORDS)) {
    const facts = empty();
    for (const [key, p] of periods) {
      const list = p.campaigns.filter((c) => c.channel === channel);
      if (!list.length) continue;
      const t = addUp(list);
      merge(facts, metricFacts(t, p.total));
      const pair = PAIRS.find(([a]) => a === key);
      if (pair && truth.periods[pair[1]])
        merge(
          facts,
          changeFacts(
            t,
            addUp(truth.periods[pair[1]].campaigns.filter((c) => c.channel === channel))
          )
        );
    }
    channels.set(word, facts);
  }
  const names = truth.periods.last30.campaigns.map((c) => c.name);
  // Daily and weekly (Monday) account totals; weekly spend per campaign.
  const day = empty(),
    week = empty();
  if (data) {
    const monday = (date) => {
      const ms = Date.parse(date + 'T12:00:00Z');
      return new Date(ms - ((new Date(ms).getUTCDay() + 6) % 7) * 86400000)
        .toISOString()
        .slice(0, 10);
    };
    const weeks = new Map();
    for (const [d, r] of data.account.days) {
      const t = {
        spend: r.cost / 1e6,
        value: r.value / 100,
        clicks: r.clicks,
        impressions: r.impr,
        conversions: r.conv,
      };
      merge(day, metricFacts(t, null));
      const w = monday(data.dates[d]);
      if (!weeks.has(w)) weeks.set(w, []);
      weeks.get(w).push(t);
    }
    for (const list of weeks.values()) merge(week, metricFacts(addUp(list), null));
    for (const c of data.campaigns) {
      const cw = new Map();
      for (const [d, r] of c.days) {
        const w = monday(data.dates[d]);
        cw.set(w, (cw.get(w) || 0) + r.cost / 1e6);
      }
      for (const v of cw.values()) week.money.push(v);
    }
  }
  const cache = new Map();
  return {
    scoped: true,
    forSentence(sentence) {
      const text = sentence.toLowerCase();
      if (cache.has(text)) return cache.get(text);
      const named = names.filter((name) => mentions(text, name));
      const facts = merge(empty(), base);
      // A sentence that names campaigns states their figures, not the waste of unnamed ones.
      if (!named.length || WASTE_FLAG.test(text)) merge(facts, waste);
      if (named.length)
        for (const [k, p] of periods) {
          const list = p.campaigns.filter((c) => named.includes(c.name));
          for (const c of list) merge(facts, metricFacts(c, p.total));
          if (list.length > 1) merge(facts, metricFacts(addUp(list), p.total));
          const pair = PAIRS.find(([a]) => a === k);
          if (pair && truth.periods[pair[1]]) {
            const prev = truth.periods[pair[1]].campaigns.filter((c) => named.includes(c.name));
            list.forEach((c, i) => merge(facts, changeFacts(c, prev[i])));
            if (list.length > 1) merge(facts, changeFacts(addUp(list), addUp(prev)));
          }
        }
      // A campaign's name is no mention of its channel ("Search - Brand" says nothing of search).
      let unnamed = text;
      for (const name of named) unnamed = unnamed.split(name.toLowerCase()).join(' ');
      for (const [word, channelFacts] of channels)
        if (word.test(unnamed)) merge(facts, channelFacts);
      const unwindowed = sentence.replace(WINDOW, ' ');
      if (WEEK_WORDS.test(unwindowed)) merge(facts, week);
      if (DAY_WORDS.test(unwindowed)) merge(facts, day);
      if (CHANGE_WORDS.test(sentence)) merge(facts, change);
      cache.set(text, facts);
      return facts;
    },
  };
}

// Zero-conversion campaigns the reply names: recall per window, the best window kept (the turn
// may analyse the last 30 days or another period it says).
// Precision: of the campaigns named on lines (or sentences) that flag waste ("no conversions",
// "0", "wasting", "pause"), the share that spent without converting. Naming every campaign in one
// "these waste money" list reaches recall 1 but not precision; a table of every campaign with
// its conversions flags only the rows showing 0.
const WASTE_FLAG =
  /\b(?:no|zero|without|wast\w*|burn\w*|paus\w*|stop\w*|cut\w*|losing|nothing|none)\b|(?<![\d.,$])0(?![\d.,%])/i;
export function wasteRecall(reply, truth) {
  const text = String(reply || '').toLowerCase();
  // Lines, and sentences within them; the items of a list a flagging line introduces ("These
  // waste money:" then bullets) are flagged with it.
  const pieces = [];
  let intro = false;
  for (const line of text.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s/.test(line);
    for (const sentence of line.split(/(?<=[.!?;])\s+/))
      pieces.push(bullet && intro ? sentence + ' (waste)' : sentence);
    if (!bullet) intro = /:\s*$/.test(line) && WASTE_FLAG.test(line);
  }
  let best = null;
  for (const [key, period] of Object.entries(truth.periods)) {
    if (!period.zeroConversion.length) continue;
    const named = period.zeroConversion.filter((name) => mentions(text, name));
    const recall = named.length / period.zeroConversion.length;
    const flagged = new Set();
    for (const piece of pieces) {
      if (!WASTE_FLAG.test(piece.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ''))) continue;
      for (const c of period.campaigns) if (mentions(piece, c.name)) flagged.add(c.name);
    }
    const hits = [...flagged].filter((name) => period.zeroConversion.includes(name)).length;
    const precision = flagged.size ? hits / flagged.size : null;
    if (!best || recall > best.recall || (recall === best.recall && key === 'last30'))
      best = {
        window: key,
        recall: Math.round(recall * 1000) / 1000,
        precision: precision === null ? null : Math.round(precision * 1000) / 1000,
        named,
        flagged: [...flagged],
        expected: period.zeroConversion,
      };
  }
  return best;
}
// A campaign is named by its full name or by its distinctive part ("Grammar Checker").
function mentions(text, name) {
  const lower = name.toLowerCase();
  if (text.includes(lower)) return true;
  const tail = lower.split(' - ').slice(1).join(' - ');
  return tail.length >= 6 && text.includes(tail);
}

// Facts of a book: every number a tab shows, and on the data tab per column totals and means,
// and per category (a text column with at most 60 values) its count, totals and share.
export function bookFacts(book, dataSheet, headerRow) {
  const facts = { money: [], percent: [], count: [], multiple: [], ranges: [] };
  const add = (v) => {
    facts.money.push(v);
    facts.count.push(v);
    facts.multiple.push(v);
    facts.percent.push(v, v * 100);
  };
  // Numbers the book computed or fetched: formula results, their spills, pivots, and tabs a report
  // or dashboard run wrote. A number the model typed is no evidence (it may be made up): a reply
  // that quotes it is checked against the data tab's own aggregates instead.
  for (const sheet of book.sheets) {
    if (sheet === dataSheet) continue;
    const runOutput = (sheet.developerMetadata || []).some(
      (m) => m && m.metadataKey === OUTPUT_RECORD
    );
    const computed = (entry) => {
      if (runOutput) return true;
      if (entry.formula) return !isConstantFormula(entry.formula);
      if (!entry.spilledFrom) return false;
      if (String(entry.spilledFrom).startsWith('pivot:')) return true;
      const anchor = sheet.cells.get(entry.spilledFrom);
      return Boolean(anchor && anchor.formula && !isConstantFormula(anchor.formula));
    };
    for (const entry of sheet.cells.values())
      if (typeof entry.value === 'number' && Number.isFinite(entry.value) && computed(entry))
        add(entry.value);
  }
  if (!dataSheet || !headerRow) return facts;
  const columns = new Map();
  for (const [key, entry] of dataSheet.cells) {
    const [r, c] = key.split(':').map(Number);
    if (r <= headerRow) continue;
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c)[r] = entry.value;
  }
  const numericCols = [],
    textCols = [];
  for (const [c, values] of columns) {
    const present = values.filter((v) => v !== undefined && v !== '');
    const nums = present.filter((v) => typeof v === 'number');
    if (nums.length >= present.length * 0.9 && nums.length) numericCols.push(c);
    else if (new Set(present.map(String)).size <= 60) textCols.push(c);
  }
  const rows = Math.max(0, ...[...columns.values()].map((v) => v.length - 1));
  // The table's size and how many distinct values each column holds (412 customers).
  facts.count.push(rows, rows - headerRow);
  for (const values of columns.values())
    facts.count.push(new Set(values.filter((v) => v !== undefined && v !== '').map(String)).size);
  for (const c of numericCols) {
    const values = columns.get(c).filter((v) => typeof v === 'number');
    const sum = values.reduce((a, b) => a + b, 0);
    let min = Infinity,
      max = -Infinity;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    facts.ranges.push([min, max], [100 * min, 100 * max]);
    add(min);
    add(max);
    add(sum);
    add(sum / values.length);
    for (const t of textCols) {
      const groups = new Map();
      const labels = columns.get(t);
      columns.get(c).forEach((v, r) => {
        if (typeof v !== 'number') return;
        const g = String(labels[r] ?? '');
        const acc = groups.get(g) || { sum: 0, n: 0 };
        acc.sum += v;
        acc.n++;
        groups.set(g, acc);
      });
      for (const g of groups.values()) {
        add(g.sum);
        add(g.sum / g.n);
        add(g.n);
        if (sum) facts.percent.push((100 * g.sum) / sum);
        if (rows > headerRow) facts.percent.push((100 * g.n) / (rows - headerRow)); // a category's share of the rows
      }
    }
  }
  return facts;
}
