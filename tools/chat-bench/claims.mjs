// What a reply says about the book, checked against the book: table sizes, counts, A1 ranges and
// tabs it names. A count is supported when it is a tab's size or a number the book shows (a
// cell of a derived tab, how often a value occurs in a data column), so counts quoted from a
// summary ("North has 40 orders") pass and counts the book does not hold are evidence.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 1,000 · 1 000 (also with a no-break or thin space) · 1.000 (dot grouping) · 1000 · 2.5
const NUMBER =
  '\\d{1,3}(?:,\\d{3})+(?![\\d.])|\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+(?![\\d.,])|\\d{1,3}(?:\\.\\d{3})+(?![\\d,]|\\.\\d)|\\d+(?:\\.\\d+)?';
const toNumber = (text) =>
  /^\d{1,3}(?:\.\d{3})+$/.test(text)
    ? Number(text.replace(/\./g, ''))
    : Number(text.replace(/[,\s]/g, ''));
// A subset (top 10 orders) or an operation's own count (inserted 5 rows) is not a table size.
const SUBSET_BEFORE =
  /\b(top|first|last|bottom|latest|recent|sample of|over|under|more than|fewer than|less than|at least|at most|up to|insert(?:ed)?|delet(?:ed|e)|remov(?:ed|e)|hid(?:e|den)|skipp(?:ed)?|dropp(?:ed)?)\s*$/i;
const APPROX_BEFORE =
  /\b(about|around|roughly|approximately|approx\.?|nearly|almost|some)\s*$|~\s*$/i;
// A count stated as the size of what the turn made ("I generated 500 shipments", "a dataset of
// 1,000 orders", "all 1,200 orders") must be a table's size: a cell that happens to show the
// same number (a Units value of 500) is no support for it.
const SIZE_CLAIM_BEFORE =
  /(?<![A-Za-z])(?:generated|created|wrote|written|added|built|made|populated|filled|produced|dataset of|table of|list of|tab with|sheet with|all|total of)\s+(?:the\s+|a\s+|an\s+|exactly\s+)?$/i;
// "12 months of orders", "3 orders per month", "2 orders each": another quantity, or a rate.
const LINKING_WORD = /\b(of|per|in|from|across|by|for|with|to|at|on)\b/i;
const RATE_AFTER = /^\s*(?:per|each|every|an?|on average)\b|^\s*\//i;

// tabs: [{ sheet: { name }, stats: { dataRows, lastRow, headerRow }, empty }]; evidence: numbers
// the book shows.
export function checkClaims(text, { nouns, tabs, dataRows, evidence = [] }) {
  const out = [];
  const plain = String(text || '').replace(/\*\*|__|`/g, '');
  const sizes = [dataRows]
    .concat(
      tabs.flatMap((t) => [
        t.stats.dataRows,
        t.stats.lastRow,
        t.stats.lastRow - (t.stats.headerRow || 1),
      ])
    )
    .filter((n) => Number.isFinite(n) && n > 0);
  const shown = evidence instanceof Set ? evidence : new Set(evidence);
  const near = (n, x, share = 0.005) => Math.abs(n - x) <= Math.max(1, share * x);
  const nounRe = new RegExp(
    `(?<![\\w.,])(${NUMBER})\\s*(k|K|thousand)?\\s+((?:[A-Za-z-]+\\s+){0,2}?)(${nouns.map(escape).join('|')})\\b`,
    'g'
  );
  for (const m of plain.matchAll(nounRe)) {
    const before = plain.slice(Math.max(0, m.index - 16), m.index);
    const after = plain.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (SUBSET_BEFORE.test(before) || LINKING_WORD.test(m[3]) || RATE_AFTER.test(after)) continue;
    const n = toNumber(m[1]) * (m[2] ? 1000 : 1);
    if (!Number.isInteger(n)) continue; // an average, not a count
    const share = APPROX_BEFORE.test(before) || m[2] ? 0.05 : 0.005;
    const sizeClaim = SIZE_CLAIM_BEFORE.test(plain.slice(Math.max(0, m.index - 24), m.index));
    if (sizes.some((x) => near(n, x, share)) || (!sizeClaim && shown.has(n))) continue;
    out.push(
      `says "${m[0].trim()}" but the data tab has ${dataRows ?? '?'} rows and no tab or cell shows ${n}`
    );
  }
  // A1 ranges, qualified by a tab name or not. A range of 100+ rows is a table claim: its end row
  // must match the tab's last used row; a named tab must exist.
  const tabNamed = (words) => {
    const parts = words.trim().split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const name = parts.slice(i).join(' ').replace(/^'|'$/g, '');
      const hit = tabs.find((t) => t.sheet.name.toLowerCase() === name.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };
  const rangeRe =
    /(?:('[^']+'|(?:[A-Za-z0-9_&-]+ ){0,3}[A-Za-z0-9_&-]+)!)?\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)\b/g;
  for (const m of plain.matchAll(rangeRe)) {
    const start = Number(m[3]),
      end = Number(m[5]);
    const big = end - start + 1 >= 100;
    if (m[1]) {
      const hit = tabNamed(m[1]);
      if (!hit) {
        out.push(`names ${m[0]} but no tab "${m[1].trim()}" exists`);
        continue;
      }
      if (big && !near(end, hit.stats.lastRow))
        out.push(
          `says ${hit.sheet.name}!${m[2]}${m[3]}:${m[4]}${m[5]} but ${hit.sheet.name} ends at row ${hit.stats.lastRow}`
        );
    } else if (big && !tabs.some((t) => near(end, t.stats.lastRow)))
      out.push(`says ${m[0]} but no tab ends at row ${end}`);
  }
  // A tab the reply points to ("the Shipments tab") that holds nothing.
  for (const t of tabs) {
    if (!t.empty) continue;
    const name = escape(t.sheet.name);
    const re = new RegExp(
      `(?<![\\w-])["'“‘]?${name}["'”’]?\\s+(?:tab|sheet)\\b|\\b(?:tab|sheet)\\s+(?:called\\s+|named\\s+)?["'“‘]?${name}(?![\\w-])`,
      'i'
    );
    if (re.test(plain)) out.push(`names the ${t.sheet.name} tab but it is empty`);
  }
  return { mismatch: out.length > 0, evidence: out };
}
