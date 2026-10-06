// Best-effort stand-in for Sheets' calculation in the chat benchmark's in-memory book (dev tool,
// never deployed). Started as a copy of the replay harness calculator; general additions:
//   - #DIV/0! for a division by zero and for AVERAGE/AVERAGEIF(S) over nothing, as Sheets shows;
//     IFERROR and ROUND evaluate their first argument (an error there takes the fallback);
//   - an error inside a formula propagates to the formula's value as its error text (#DIV/0!),
//     which the benchmark turns into a Sheets-like error value on the cell;
//   - range reads and equality criteria are memoized per batch (reset() between batches), so a
//     per-entity summary over 100,000 rows evaluates in seconds;
//   - a generated table (MAKEARRAY, SEQUENCE, RANDARRAY, also with sizes bound by LET and a
//     header in VSTACK) that the evaluator below cannot read spills the requested number of rows
//     as stand-ins, with values taken from the model's own per-column lists (CHOOSE(c,
//     INDEX({"a","b"},...), ...)) where it has them, else domain-neutral values inferred from the
//     header name;
//   - {range} and stacked references in an array literal, MAXIFS/MINIFS;
//   - any other formula through the parser-based evaluator of arrays.mjs (LET, LAMBDA, MAP,
//     MAKEARRAY, UNIQUE, SORT, FILTER, ARRAYFORMULA arithmetic...), which replays the model's own
//     arithmetic and draws; only a formula it cannot read gets the stand-in table above.
// Anything else returns undefined: the formula text stays as its value and the benchmark counts
// it as unevaluated.
import { prng } from './random.mjs';
import { evaluateFormula, UNSUPPORTED } from './arrays.mjs';

const COLUMN = (letters) =>
  letters
    .toUpperCase()
    .split('')
    .reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

export const ERROR_RE = /^#(DIV\/0!|REF!|N\/A|VALUE!|NAME\?|NUM!|ERROR!|NULL!)/;
const isErrorText = (v) => typeof v === 'string' && ERROR_RE.test(v);

export function createCalculator(getBook) {
  // Memo of this batch: last rows, range grids and equality indexes.
  let memo = new Map();
  const remember = (key, make) => {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const sheetNamed = (name) =>
    getBook().sheets.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  const lastRow = (sheet) =>
    remember('last:' + sheet.id, () => {
      let max = 0;
      for (const [key, entry] of sheet.cells)
        if (entry && entry.value !== '' && entry.value != null)
          max = Math.max(max, Number(key.split(':')[0]));
      return max;
    });
  // A reference such as Sheet1!A2:H50, 'My tab'!A:A, H2:H or B5.
  const range = (text, at) => {
    const m =
      /^\s*(?:'((?:[^']|'')+)'!|([A-Za-z0-9_]+)!)?\$?([A-Za-z]{1,3})\$?(\d*)(?::\$?([A-Za-z]{1,3})\$?(\d*))?\s*$/.exec(
        text
      );
    if (!m) return null;
    const sheet =
      m[1] || m[2] ? sheetNamed((m[1] || m[2]).replace(/''/g, "'")) : sheetNamed(at.sheet);
    if (!sheet) return null;
    const left = COLUMN(m[3]),
      right = m[5] ? COLUMN(m[5]) : left;
    const top = m[4] ? Number(m[4]) : 1;
    const bottom = m[5] ? (m[6] ? Number(m[6]) : lastRow(sheet)) : m[4] ? top : lastRow(sheet);
    return {
      sheet,
      top,
      left,
      bottom,
      right,
      key: `${sheet.id}!${top}:${left}:${bottom}:${right}`,
    };
  };
  const grid = (r) => {
    const rows = [];
    for (let y = r.top; y <= r.bottom; y++) {
      const row = [];
      for (let x = r.left; x <= r.right; x++) {
        const v = r.sheet.cells.get(`${y}:${x}`)?.value;
        row.push(v === undefined || v === null ? '' : v);
      }
      rows.push(row);
    }
    return rows;
  };
  // Ranges on the formula's own tab are read fresh (a batch may be writing them); others are
  // memoized for the batch.
  const flat = (text, at) => {
    const r = range(text, at);
    if (!r) return null;
    if (r.sheet.name.toLowerCase() === String(at.sheet).toLowerCase()) return grid(r).flat();
    return remember('flat:' + r.key, () => grid(r).flat());
  };
  const number = (v) =>
    v instanceof Date ? v.getTime() / 86400000 + 25569 : typeof v === 'number' ? v : Number.NaN;
  const aggregate = (fn, list) => {
    const nums = list.map(number).filter(Number.isFinite);
    switch (fn) {
      case 'SUM':
        return nums.reduce((a, b) => a + b, 0);
      case 'COUNT':
        return nums.length;
      case 'COUNTA':
        return list.filter((v) => v !== '').length;
      case 'AVERAGE':
        return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : '#DIV/0!';
      // Folded, not spread: a list of 100,000 values overflows the call stack.
      case 'MAX':
        return nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : 0;
      case 'MIN':
        return nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : 0;
      case 'COUNTUNIQUE':
        return new Set(list.filter((v) => v !== '').map(String)).size;
      default:
        return undefined;
    }
  };
  const literal = (text, at) => {
    text = text.trim();
    if (/^".*"$/s.test(text)) return text.slice(1, -1).replace(/""/g, '"');
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    const cell = range(text, at);
    if (cell && cell.top === cell.bottom && cell.left === cell.right) return grid(cell)[0][0];
    return text;
  };
  const meets = (value, criterion) => {
    if (typeof criterion === 'number') return number(value) === criterion;
    const m = /^(<>|>=|<=|=|>|<)?(.*)$/s.exec(String(criterion));
    const op = m[1] || '=',
      rhs = m[2];
    if (op === '<>' && rhs === '') return value !== '';
    const n = Number(rhs);
    const numeric = rhs !== '' && Number.isFinite(n);
    const left = numeric ? number(value) : String(value).toLowerCase();
    const right = numeric ? n : rhs.toLowerCase();
    return {
      '=': left === right,
      '<>': left !== right,
      '>': left > right,
      '<': left < right,
      '>=': left >= right,
      '<=': left <= right,
    }[op];
  };
  // A text criterion matched by equality: positions of each value, memoized per range.
  const equalityKey = (criterion) => {
    if (typeof criterion !== 'string') return null;
    const m = /^(=)?(.*)$/s.exec(criterion);
    if (/^(<>|>=|<=|>|<)/.test(criterion)) return null;
    const rhs = m[2];
    if (rhs !== '' && Number.isFinite(Number(rhs))) return null;
    return rhs.toLowerCase();
  };
  const split = (text) => {
    const parts = [];
    let depth = 0,
      quote = false,
      start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') quote = !quote;
      else if (!quote && (ch === '(' || ch === '{')) depth++;
      else if (!quote && (ch === ')' || ch === '}')) depth--;
      else if (!quote && depth === 0 && ch === ',') {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim());
  };
  const conditional = (fn, args, at) => {
    if (fn === 'SUMIF' || fn === 'AVERAGEIF' || fn === 'COUNTIF') {
      const base = flat(args[0], at),
        crit = literal(args[1], at),
        sum = args[2] ? flat(args[2], at) : base;
      if (!base || !sum) return undefined;
      const picked = sum.filter((_, i) => meets(base[i], crit));
      return fn === 'COUNTIF'
        ? picked.length
        : aggregate(fn === 'SUMIF' ? 'SUM' : 'AVERAGE', picked);
    }
    let target = null,
      pairs = args;
    if (fn !== 'COUNTIFS') {
      target = flat(args[0], at);
      if (!target) return undefined;
      pairs = args.slice(1);
    }
    const tests = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const list = flat(pairs[i], at);
      if (!list) return undefined;
      tests.push({ text: pairs[i], list, crit: literal(pairs[i + 1], at) });
    }
    const size = (target || (tests[0] && tests[0].list) || []).length;
    // Candidates from the first equality criterion's index, then every test checked.
    let candidates = null;
    const indexed = tests.find((t) => equalityKey(t.crit) !== null && range(t.text, at));
    if (indexed) {
      const r = range(indexed.text, at);
      const build = () => {
        const map = new Map();
        indexed.list.forEach((v, i) => {
          const k = String(v).toLowerCase();
          if (!map.has(k)) map.set(k, []);
          map.get(k).push(i);
        });
        return map;
      };
      // Like flat(), a range on the formula's own tab is not memoized.
      const own = r.sheet.name.toLowerCase() === String(at.sheet).toLowerCase();
      const index = own ? build() : remember('index:' + r.key, build);
      candidates = index.get(equalityKey(indexed.crit)) || [];
    }
    const rows = [];
    const check = (i) => tests.every((t) => meets(t.list[i] ?? '', t.crit));
    if (candidates) {
      for (const i of candidates) if (i < size && check(i)) rows.push(i);
    } else for (let i = 0; i < size; i++) if (check(i)) rows.push(i);
    if (fn === 'COUNTIFS') return rows.length;
    return aggregate(
      { SUMIFS: 'SUM', AVERAGEIFS: 'AVERAGE', MAXIFS: 'MAX', MINIFS: 'MIN' }[fn],
      rows.map((i) => target[i])
    );
  };
  // Plain arithmetic over numbers, cell references and error placeholders.
  const arithmetic = (expr, at, errors) => {
    expr = expr.replace(/(?:'(?:[^']|'')+'!|[A-Za-z0-9_]+!)?\$?[A-Z]{1,3}\$?\d+\b/g, (ref) => {
      const v = literal(ref, at);
      if (v === '') return '(0)';
      if (isErrorText(v)) {
        errors.push(v);
        return '__E' + (errors.length - 1) + '__';
      }
      // Arithmetic reads numeric text as its number, as Sheets does ("7" entered as text).
      const n =
        typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
          ? Number(v)
          : number(v);
      return Number.isFinite(n) ? '(' + n + ')' : 'NaN';
    });
    const failed = /__E(\d+)__/.exec(expr);
    if (failed) return errors[Number(failed[1])];
    if (!/^[\d\s.+\-*/()eNa]*$/.test(expr) || !expr.trim()) return undefined;
    let value;
    try {
      value = Function('return (' + expr + ')')();
    } catch {
      return undefined;
    }
    if (Number.isNaN(value)) return undefined;
    if (!Number.isFinite(value)) return '#DIV/0!';
    return value;
  };
  // Replaces each aggregate call by its number (or an error placeholder), then evaluates plain
  // arithmetic.
  const scalar = (text, at) => {
    let expr = text,
      guard = 0,
      m;
    const errors = [];
    const call =
      /\b(SUMIFS|COUNTIFS|AVERAGEIFS|MAXIFS|MINIFS|SUMIF|COUNTIF|AVERAGEIF|SUM|COUNTA|COUNTUNIQUE|COUNT|AVERAGE|MAX|MIN|IFERROR|ROUND)\(([^()]*)\)/i;
    while ((m = call.exec(expr)) && guard++ < 200) {
      const fn = m[1].toUpperCase(),
        args = split(m[2]);
      let value;
      if (fn === 'IFERROR') {
        const first = arithmetic(args[0], at, errors);
        if (first === undefined) return undefined;
        value = isErrorText(first)
          ? args[1] === undefined
            ? ''
            : (arithmetic(args[1], at, errors) ?? literal(args[1], at))
          : first;
        if (typeof value === 'string' && !isErrorText(value)) return undefined; // text results are not modelled
      } else if (fn === 'ROUND') {
        const first = arithmetic(args[0], at, errors);
        value =
          isErrorText(first) || first === undefined
            ? first
            : Number(Number(first).toFixed(Number(args[1] || 0)));
      } else if (/IFS?$/.test(fn)) value = conditional(fn, args, at);
      else {
        const lists = args.map((a) => flat(a, at) || [literal(a, at)]);
        const bad = lists.flat().find(isErrorText);
        value = bad && fn !== 'COUNTA' && fn !== 'COUNTUNIQUE' ? bad : aggregate(fn, lists.flat());
      }
      if (value === undefined) return undefined;
      let token;
      if (isErrorText(value)) {
        errors.push(value);
        token = '__E' + (errors.length - 1) + '__';
      } else if (typeof value === 'number' && Number.isFinite(value)) token = '(' + value + ')';
      else return undefined;
      expr = expr.slice(0, m.index) + token + expr.slice(m.index + m[0].length);
    }
    return arithmetic(expr, at, errors);
  };
  const query = (source, text, headerRows, at) => {
    const r = range(source, at);
    if (!r || /\bpivot\b/i.test(text)) return undefined;
    const all = grid(r),
      withHeader = Number(headerRows ?? 1) > 0;
    const header = withHeader ? all[0] : all[0].map(() => '');
    const data = withHeader ? all.slice(1) : all;
    const col = (letter) => COLUMN(letter) - r.left;
    const KEYS = [
      'select',
      'where',
      'group by',
      'pivot',
      'order by',
      'limit',
      'offset',
      'label',
      'format',
      'options',
    ];
    const clause = (name) => {
      const others = KEYS.filter((k) => k !== name).join('|');
      const m = new RegExp('\\b' + name + '\\b(.*?)(?=\\b(?:' + others + ')\\b|$)', 'is').exec(
        text
      );
      return m ? m[1].trim() : '';
    };
    const select = clause('select'),
      where = clause('where'),
      groupBy = clause('group by'),
      orderBy = clause('order by'),
      limit = clause('limit'),
      label = clause('label');
    const columns =
      select === '*' || !select
        ? header.map((_, i) => String.fromCharCode(64 + r.left + i))
        : split(select);
    const items = columns.map((item) => {
      const m = /^(sum|count|avg|max|min)\(\s*([A-Z]{1,3})\s*\)$/i.exec(item.trim());
      return m
        ? { key: item.replace(/\s+/g, '').toLowerCase(), fn: m[1].toLowerCase(), column: col(m[2]) }
        : { key: item.trim().toLowerCase(), column: col(item.trim()) };
    });
    let rows = data.filter((row) => row.some((v) => v !== ''));
    for (const cond of where
      .split(/\band\b/i)
      .map((s) => s.trim())
      .filter(Boolean)) {
      let m;
      if ((m = /^([A-Z]{1,3})\s+is\s+not\s+null$/i.exec(cond)))
        rows = rows.filter((row) => row[col(m[1])] !== '');
      else if (
        (m = /^([A-Z]{1,3})\s*(=|!=|<>|>=|<=|>|<)\s*(?:'([^']*)'|(-?[\d.]+))$/i.exec(cond))
      ) {
        const c = col(m[1]),
          op = m[2] === '!=' ? '<>' : m[2];
        const crit =
          m[3] !== undefined
            ? (op === '=' ? '' : op) + m[3]
            : op === '='
              ? Number(m[4])
              : op + m[4];
        rows = rows.filter((row) => meets(row[c], crit));
      }
    }
    const groups = groupBy ? split(groupBy).map((g) => col(g)) : null;
    let out;
    if (groups || items.some((i) => i.fn)) {
      const buckets = new Map();
      for (const row of rows) {
        const key = JSON.stringify(
          (groups || []).map((g) => (row[g] instanceof Date ? row[g].toISOString() : row[g]))
        );
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      }
      out = [...buckets.values()].map((list) =>
        items.map((item) => {
          if (!item.fn) return list[0][item.column];
          const map = { sum: 'SUM', count: 'COUNTA', avg: 'AVERAGE', max: 'MAX', min: 'MIN' };
          const values = list.map((row) => row[item.column]);
          const result = aggregate(map[item.fn], values);
          // The earliest or latest of dates is a date, as QUERY returns it.
          const filled = values.filter((v) => v !== '');
          return (item.fn === 'max' || item.fn === 'min') &&
            filled.length &&
            filled.every((v) => v instanceof Date)
            ? new Date((result - 25569) * 86400000)
            : result;
        })
      );
    } else out = rows.map((row) => items.map((item) => row[item.column]));
    if (orderBy) {
      const specs = split(orderBy)
        .map((spec) => {
          const m = /^(.*?)(\s+(asc|desc))?$/i.exec(spec.trim());
          const key = m[1].replace(/\s+/g, '').toLowerCase();
          return {
            index: items.findIndex((item) => item.key === key),
            desc: /desc/i.test(m[3] || ''),
          };
        })
        .filter((spec) => spec.index >= 0);
      out.sort((a, b) => {
        for (const spec of specs) {
          const x = a[spec.index],
            y = b[spec.index];
          if (x === y) continue;
          return (x < y ? -1 : 1) * (spec.desc ? -1 : 1);
        }
        return 0;
      });
    }
    if (limit) out = out.slice(0, Number(limit));
    const labels = {};
    for (const part of split(label)) {
      const m = /^(.*?)\s+'([^']*)'$/.exec(part);
      if (m) labels[m[1].replace(/\s+/g, '').toLowerCase()] = m[2];
    }
    const head = items.map(
      (item) =>
        labels[item.key] ?? (item.fn ? item.fn + ' ' + header[item.column] : header[item.column])
    );
    return [head].concat(out.length ? out : [items.map(() => '')]);
  };
  const generated = (text) => generateTable(text, split);
  // The parser-based evaluator (arrays.mjs): the model's own formula, its arithmetic and draws
  // included. undefined when it uses a function that evaluator does not know.
  const evaluated = (formula, at) => {
    try {
      return evaluateFormula(formula, at, {
        range,
        grid,
        remember,
        seed: hash(formula),
        query: (source, text, headers, where) => query(source, text, headers, where),
      });
    } catch (error) {
      if (error === UNSUPPORTED) return undefined;
      throw error;
    }
  };
  // An array literal such as {100;200;300}, {"a",1;"b",2} or {Sheet1!A1:D6}: rows split by ;
  // and columns by ,.
  const arrayLiteral = (body, at) => {
    const rows = [];
    let depth = 0,
      quote = false,
      start = 0;
    for (let i = 0; i <= body.length; i++) {
      const ch = body[i];
      if (ch === '"') quote = !quote;
      else if (!quote && (ch === '(' || ch === '{')) depth++;
      else if (!quote && (ch === ')' || ch === '}')) depth--;
      else if (i === body.length || (!quote && depth === 0 && ch === ';')) {
        rows.push(body.slice(start, i));
        start = i + 1;
      }
    }
    // Each item is a block: a constant is 1x1, a reference ({Sheet1!A1:D6}) its cells. Items in a
    // row sit side by side (same height) and rows stack (same width), as Sheets requires.
    const block = (item) => {
      item = item.trim();
      if (/^"(?:[^"]|"")*"$/s.test(item)) return [[item.slice(1, -1).replace(/""/g, '"')]];
      if (/^-?\d+(\.\d+)?$/.test(item)) return [[Number(item)]];
      if (/^(TRUE|FALSE)$/i.test(item)) return [[/^TRUE$/i.test(item)]];
      const r = at ? range(item, at) : null;
      return r ? grid(r) : undefined;
    };
    const lines = [];
    for (const row of rows) {
      const blocks = split(row).map(block);
      if (blocks.some((b) => b === undefined)) return undefined;
      const height = blocks[0].length;
      if (blocks.some((b) => b.length !== height)) return '#VALUE!';
      for (let y = 0; y < height; y++) lines.push(blocks.flatMap((b) => b[y]));
    }
    const width = Math.max(...lines.map((line) => line.length));
    return lines.some((line) => line.length !== width) ? '#VALUE!' : lines;
  };
  function formulaResult(formula, at) {
    try {
      const text = formula.slice(1).trim();
      let m;
      if ((m = /^QUERY\((.*)\)$/is.exec(text))) {
        const args = split(m[1]);
        const q = /^"((?:[^"]|"")*)"$/s.exec(args[1] || '');
        return q ? query(args[0], q[1].replace(/""/g, '"'), args[2], at) : undefined;
      }
      // A literal of constants only; {"header";LET(..MAKEARRAY..)} is a generated table below.
      if ((m = /^\{(.*)\}$/s.exec(text))) {
        const literal = arrayLiteral(m[1], at);
        if (literal !== undefined) return literal;
        return evaluated(formula, at) ?? generated(text);
      }
      return scalar(text, at) ?? evaluated(formula, at) ?? generated(text);
    } catch {
      return undefined;
    }
  }
  // A new batch: cells may have changed, so the memo starts empty.
  formulaResult.reset = () => {
    memo = new Map();
  };
  return formulaResult;
}

// ---------- generated tables ----------
// The text inside the parenthesis that opens at text[open] (balanced, quotes respected).
function inside(text, open) {
  let depth = 0,
    quote = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quote = !quote;
    else if (quote) continue;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const strings = (text) =>
  [...text.matchAll(/"((?:[^"]|"")*)"/g)].map((x) => x[1].replace(/""/g, '"'));
const numbers = (text) =>
  [
    ...text
      .replace(/"(?:[^"]|"")*"/g, '')
      .matchAll(/(?<![A-Za-z_$])-?\d+(?:\.\d+)?(?![A-Za-z_\d])/g),
  ].map((x) => Number(x[0]));

// CHOOSE(<index>, "a", "b", ...) or CHOOSE(<index>, 19.99, 29.99, ...): its literal choices.
function chooseLiterals(expr, split) {
  for (const m of expr.matchAll(/\bCHOOSE\(/gi)) {
    const body = inside(expr, m.index + 'CHOOSE'.length);
    if (!body) continue;
    const items = split(body).slice(1);
    if (items.length < 2) continue;
    if (items.every((x) => /^"(?:[^"]|"")*"$/s.test(x)))
      return items.map((x) => x.slice(1, -1).replace(/""/g, '"'));
    if (items.every((x) => /^-?\d+(\.\d+)?$/.test(x))) return items.map(Number);
  }
  return null;
}

// What one column's expression in the model's LAMBDA makes, when it can be read.
function recipe(expr, split) {
  const list = /\{\s*("(?:[^"]|"")*"(?:\s*[,;]\s*"(?:[^"]|"")*")+)\s*\}/s.exec(expr);
  if (list) return { kind: 'list', items: strings(list[1]) };
  // Choices of text anywhere ("x" & CHOOSE(...) is an id below); choices of numbers only when
  // the column is the CHOOSE itself (DATE(...)+CHOOSE(i,0,30) is a date).
  const chosen = split && !/^\s*"[^"]*"\s*&/.test(expr) ? chooseLiterals(expr, split) : null;
  if (chosen && (typeof chosen[0] === 'string' || /^\s*CHOOSE\(/i.test(expr)))
    return { kind: 'list', items: chosen };
  if (/\b(DATE|EDATE|EOMONTH|TODAY|DATEVALUE)\s*\(/i.test(expr) && !/^\s*"/.test(expr)) {
    const d = /DATE\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)/i.exec(expr);
    return {
      kind: 'date',
      base: d ? Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) : Date.UTC(2026, 0, 1),
    };
  }
  const prefix = /^\s*"([^"]*)"\s*&/.exec(expr);
  if (prefix) return { kind: 'id', prefix: prefix[1], repeat: /RANDBETWEEN|MOD\(/i.test(expr) };
  const between = /RANDBETWEEN\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i.exec(expr);
  if (between)
    return { kind: 'number', lo: Number(between[1]), hi: Number(between[2]), decimals: 0 };
  if (/^\s*(TRUE|FALSE)\s*$/i.test(expr)) return { kind: 'list', items: [true, false] };
  const nums = numbers(expr).filter((n) => n > 0);
  if (nums.length && !/"/.test(expr)) {
    const decimals = /ROUND\([^)]*,\s*2\s*\)|\.\d/.test(expr) ? 2 : 0;
    return {
      kind: 'number',
      lo: Math.min(...nums),
      hi: Math.max(...nums, Math.min(...nums) + 1),
      decimals,
    };
  }
  return null;
}

// What a header name suggests, for columns the formula does not describe. Generic across domains.
function fromHeader(name, c, n) {
  const h = String(name).toLowerCase();
  if (/\b(id|number|no|code|ref|#)\b/.test(h))
    return {
      kind: 'id',
      prefix: (name.match(/\b[A-Za-z]/g) || ['X']).join('').toUpperCase().slice(0, 3) + '-',
      repeat: c > 1,
    };
  if (
    /date|month|day|time|created|closed|hired|shipped|delivered|period|start|end|joined|signup/.test(
      h
    )
  )
    return { kind: 'date', base: Date.UTC(2026, 0, 1) };
  if (
    /amount|price|cost|revenue|salary|value|mrr|arr|fee|total|spend|budget|income|pay|sales|profit|discount amount|bonus/.test(
      h
    )
  )
    return { kind: 'number', lo: 10, hi: 5000, decimals: 2 };
  if (/rate|percent|%|margin|probability|ratio|share/.test(h))
    return { kind: 'number', lo: 0, hi: 1, decimals: 2 };
  if (
    /qty|quantity|units|count|seats|days|hours|age|score|rating|weight|distance|km|miles|tenure|years|items|headcount|clicks|visits/.test(
      h
    )
  )
    return { kind: 'number', lo: 1, hi: 50, decimals: 0 };
  if (/name|customer|employee|client|account|company|user|contact|vendor|supplier/.test(h))
    return { kind: 'id', prefix: name + ' ', repeat: true, spread: Math.max(3, Math.round(n / 3)) };
  return { kind: 'list', items: ['A', 'B', 'C', 'D', 'E'].map((x) => name + ' ' + x) };
}

function cellValue(spec, r, rand, n) {
  switch (spec.kind) {
    case 'list':
      return spec.items[Math.floor(rand() * spec.items.length)];
    case 'date':
      return new Date(spec.base + Math.floor(rand() * 365) * 86400000);
    case 'id':
      return (
        spec.prefix +
        (spec.repeat
          ? 1000 + Math.floor(rand() * (spec.spread || Math.max(3, Math.round(n / 3))))
          : 10000 + r)
      );
    case 'number': {
      const v = spec.lo + rand() * (spec.hi - spec.lo);
      return spec.decimals ? Math.round(v * 100) / 100 : Math.round(v);
    }
    default:
      return '';
  }
}

function generateTable(text, split) {
  // Sizes may be literals or names bound by LET (LET(n,30000,MAKEARRAY(n,10,...))).
  const bound = (token) => {
    if (token == null) return undefined;
    if (/^\d+$/.test(token)) return token;
    const m = new RegExp('[(,]\\s*' + token + '\\s*,\\s*(\\d+)\\s*,', 'i').exec(text);
    return m ? m[1] : undefined;
  };
  const raw =
    /\b(MAKEARRAY|SEQUENCE|RANDARRAY)\(\s*([A-Za-z_][A-Za-z0-9_.]*|\d+)\s*(?:,\s*([A-Za-z_][A-Za-z0-9_.]*|\d+))?/i.exec(
      text
    );
  if (!raw || bound(raw[2]) === undefined) return undefined;
  const n = Number(bound(raw[2]));
  const width = Number(bound(raw[3]) || 1);
  if (!(n > 0) || n > 1_000_000 || width > 200) return undefined;
  // The header: a leading {...; or a literal text array of 2+ items before the generator
  // ({"a","b"} in VSTACK), so lists inside its LAMBDA are not taken for it.
  const head =
    /^\{([^;]*);/s.exec(text) ||
    /\{\s*("(?:[^"]|"")*"(?:\s*,\s*"(?:[^"]|"")*")+)\s*[;}]/s.exec(text.slice(0, raw.index));
  const header = head ? strings(head[1]) : [];
  const columns = Math.max(width, header.length);
  // Per-column recipes from CHOOSE(<column parameter>, e1, e2, ...) inside the LAMBDA.
  const recipes = [];
  const lambda = /LAMBDA\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/i.exec(
    text.slice(raw.index)
  );
  if (lambda && raw[1].toUpperCase() === 'MAKEARRAY') {
    const at = new RegExp('CHOOSE\\(\\s*' + lambda[2] + '\\s*,', 'i').exec(text);
    if (at) {
      const body = inside(text, at.index + 'CHOOSE'.length);
      if (body)
        split(body)
          .slice(1)
          .forEach((expr, c) => (recipes[c] = recipe(expr)));
    }
  }
  // A generator per formula, so a rerun of the same benchmark writes the same table.
  const rand = prng(hash(text));
  const specs = Array.from(
    { length: columns },
    (_, c) => recipes[c] || fromHeader(header[c] || 'Column ' + (c + 1), c, n)
  );
  const rows = header.length ? [header.concat(Array(columns - header.length).fill(''))] : [];
  for (let r = 1; r <= n; r++) rows.push(specs.map((spec) => cellValue(spec, r, rand, n)));
  return rows;
}

// Draws each native pivot's output into its tab as values without an entered value, as Sheets
// shows them (row groups and values only; column groups are summed into the rows).
// The cells each pivot drew last time, per tab, so a removed or moved pivot takes them away and
// only pivot anchors are visited (a tab with a validation rule on every cell has as many meta
// entries as cells).
const drawn = new WeakMap();
export function renderPivots(book) {
  for (const sheet of book.sheets) {
    const previous = drawn.get(sheet) || new Map();
    for (const keys of previous.values())
      for (const key of keys)
        if (String(sheet.cells.get(key)?.spilledFrom || '').startsWith('pivot:'))
          sheet.cells.delete(key);
    const now = new Map();
    drawn.set(sheet, now);
    for (const [anchor, meta] of sheet.meta) {
      const pivot = meta && meta.pivotTable;
      if (!pivot) continue;
      const cells = [];
      now.set(anchor, cells);
      const source = book.sheets.find((s) => s.id === (pivot.source.sheetId ?? 0));
      if (!source) continue;
      const g = pivot.source;
      const cell = (r, c) => source.cells.get(`${r + 1}:${c + 1}`)?.value ?? '';
      const header = (offset) => String(cell(g.startRowIndex, g.startColumnIndex + offset));
      const month = (k) => (k instanceof Date ? k.toISOString().slice(0, 7) : k);
      const rows = pivot.rows || [],
        values = pivot.values || [];
      const buckets = new Map();
      const end = g.endRowIndex ?? source.maxRows;
      for (let r = g.startRowIndex + 1; r < end; r++) {
        const keys = rows.map((group) =>
          month(cell(r, g.startColumnIndex + group.sourceColumnOffset))
        );
        if (keys.every((k) => k === '')) continue;
        const id = JSON.stringify(keys);
        if (!buckets.has(id)) buckets.set(id, { keys, rows: [] });
        buckets.get(id).rows.push(r);
      }
      const total = (list) => list.reduce((a, b) => a + b, 0);
      const value = (spec, list) => {
        const xs = list.map((r) => cell(r, g.startColumnIndex + spec.sourceColumnOffset));
        const nums = xs.filter((x) => typeof x === 'number');
        switch (spec.summarizeFunction) {
          case 'COUNT':
            return nums.length;
          case 'COUNTA':
            return xs.filter((x) => x !== '').length;
          case 'AVERAGE':
            return nums.length ? total(nums) / nums.length : 0;
          case 'MAX':
            return nums.length ? Math.max(...nums) : 0;
          case 'MIN':
            return nums.length ? Math.min(...nums) : 0;
          default:
            return total(nums);
        }
      };
      const lines = [
        rows
          .map((group) => header(group.sourceColumnOffset))
          .concat(values.map((v) => v.summarizeFunction + ' of ' + header(v.sourceColumnOffset))),
      ];
      [...buckets.values()]
        .sort((a, b) => (String(a.keys) < String(b.keys) ? -1 : 1))
        .forEach((bucket) =>
          lines.push(bucket.keys.concat(values.map((v) => value(v, bucket.rows))))
        );
      if (rows.some((group) => group.showTotals)) {
        const everything = [...buckets.values()].flatMap((b) => b.rows);
        lines.push(
          ['Grand Total'].concat(
            rows.slice(1).map(() => ''),
            values.map((v) => value(v, everything))
          )
        );
      }
      const [top, left] = anchor.split(':').map(Number);
      lines.forEach((line, r) =>
        line.forEach((v, c) => {
          if (top + r > sheet.maxRows || left + c > sheet.maxColumns || v === '') return;
          // A cell someone typed into keeps its value (the API refuses edits inside a pivot).
          const key = `${top + r}:${left + c}`;
          const entry = sheet.cells.get(key);
          if (entry && !String(entry.spilledFrom || '').startsWith('pivot:')) return;
          sheet.cells.set(key, { value: v, formula: '', spilledFrom: 'pivot:' + anchor });
          cells.push(key);
        })
      );
    }
  }
}
