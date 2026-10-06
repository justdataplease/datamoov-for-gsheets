// A parser-based evaluator of array formulas for the chat benchmark's calculator (dev tool, never
// deployed). formulas.mjs tries its pattern-based paths first (plain aggregates, QUERY over a
// range); a formula they leave goes here, before any stand-in: LET, LAMBDA with MAP, BYROW,
// BYCOL and MAKEARRAY, SEQUENCE, RANDARRAY, array literals of expressions, element-wise
// arithmetic, comparisons and text over ranges (ARRAYFORMULA), UNIQUE, SORT, SORTN, FILTER,
// HSTACK, VSTACK, lookups and the IFS family with criteria arrays, so a generated table is the
// model's own arithmetic (a total computed from its columns, or drawn again) and a per-entity
// summary built from spilling formulas has real values to check.
//
// It follows Sheets where the benchmark's measures depend on it: RAND draws again on every call
// (inside MAKEARRAY once per cell), COUNTIF(S), SUMIF(S) and AVERAGEIF expand over a criteria
// array while MAXIFS, MINIFS, AVERAGEIFS and COUNTUNIQUEIFS do not (they read its first value),
// AND and OR collapse an array to one value, INDEX does not expand, and a result of dates stays
// dates. The range operator joins references, including the one INDEX returns, so
// B2:INDEX(B:B,COUNTA(A:A)) is the cells from B2 to the last key, as in Sheets (in either order,
// and past the filled rows of a whole column up to the tab's grid). A function it does not know
// throws UNSUPPORTED, and formulas.mjs then falls back as before.
export const UNSUPPORTED = new Error('unsupported');

const ERROR = /^#(DIV\/0!|REF!|N\/A|VALUE!|NAME\?|NUM!|ERROR!|NULL!)/;
const isError = (v) => typeof v === 'string' && ERROR.test(v);
const isArray = Array.isArray;
// Largest and smallest of a list of any length (spreading 100,000 values overflows the stack).
const maxOf = (list) => list.reduce((a, b) => (b > a ? b : a), -Infinity);
const minOf = (list) => list.reduce((a, b) => (b < a ? b : a), Infinity);
const blank = (v) => v === '' || v === null || v === undefined;
const DAY = 86400000;
const toSerial = (d) => d.getTime() / DAY + 25569;
const fromSerial = (n) => new Date(Math.round((n - 25569) * DAY));

// ---------- tokens and syntax ----------
const REF =
  /^(?:'(?:[^']|'')+'!|[A-Za-z0-9_.]+!)?(?:\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d*)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}(?:\$?\d+)?)(?![A-Za-z0-9_(])/;

function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const rest = text.slice(i);
    let m;
    if (ch === '"') {
      m = /^"((?:[^"]|"")*)"/.exec(rest);
      if (!m) throw UNSUPPORTED;
      out.push({ t: 'str', v: m[1].replace(/""/g, '"') });
    } else if ((m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![A-Za-z_:])/.exec(rest)))
      out.push({ t: 'num', v: Number(m[0]) });
    else if ((m = REF.exec(rest)) && !/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(rest))
      out.push({ t: 'ref', v: m[0] });
    else if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) out.push({ t: 'id', v: m[0] });
    else if ((m = /^(<>|<=|>=|[-+*/^&=<>%(){},;:])/.exec(rest))) out.push({ t: 'op', v: m[0] });
    else throw UNSUPPORTED;
    i += m[0].length;
  }
  return out;
}

function parse(text) {
  const tokens = tokenize(text);
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  const expect = (v) => {
    if (!isOp(v)) throw UNSUPPORTED;
    at++;
  };
  const binary = (next, ops) => () => {
    let left = next();
    while (peek() && peek().t === 'op' && ops.includes(peek().v)) {
      const op = tokens[at++].v;
      left = { type: 'bin', op, left, right: next() };
    }
    return left;
  };
  const primary = () => {
    const tok = tokens[at++];
    if (!tok) throw UNSUPPORTED;
    if (tok.t === 'num') return { type: 'num', value: tok.v };
    if (tok.t === 'str') return { type: 'str', value: tok.v };
    if (tok.t === 'ref') return { type: 'ref', text: tok.v };
    if (tok.t === 'op' && tok.v === '(') {
      const inner = expression();
      expect(')');
      return inner;
    }
    if (tok.t === 'op' && tok.v === '{') {
      const rows = [[]];
      if (!isOp('}'))
        for (;;) {
          rows[rows.length - 1].push(expression());
          if (isOp(',')) at++;
          else if (isOp(';')) {
            at++;
            rows.push([]);
          } else break;
        }
      expect('}');
      return { type: 'array', rows };
    }
    if (tok.t === 'id') {
      if (isOp('(')) {
        at++;
        const args = [];
        if (!isOp(')'))
          for (;;) {
            args.push(isOp(',') || isOp(')') ? { type: 'empty' } : expression());
            if (isOp(',')) at++;
            else break;
          }
        expect(')');
        return { type: 'call', name: tok.v.toUpperCase(), args };
      }
      if (/^(TRUE|FALSE)$/i.test(tok.v)) return { type: 'bool', value: /^TRUE$/i.test(tok.v) };
      return { type: 'name', name: tok.v.toLowerCase() };
    }
    throw UNSUPPORTED;
  };
  // The range operator: two references (a cell, a range or INDEX of one) as the box around both.
  const span = () => {
    let node = primary();
    while (isOp(':')) {
      at++;
      node = { type: 'span', left: node, right: primary() };
    }
    return node;
  };
  const postfix = () => {
    let node = span();
    for (;;) {
      if (isOp('%')) {
        at++;
        node = { type: 'bin', op: '/', left: node, right: { type: 'num', value: 100 } };
      } else if (isOp('(') && node.type === 'call' && node.name === 'LAMBDA') {
        at++;
        const args = [];
        if (!isOp(')'))
          for (;;) {
            args.push(expression());
            if (isOp(',')) at++;
            else break;
          }
        expect(')');
        node = { type: 'invoke', fn: node, args };
      } else return node;
    }
  };
  const unary = () => {
    if (isOp('-')) {
      at++;
      return { type: 'neg', arg: unary() };
    }
    if (isOp('+')) {
      at++;
      return unary();
    }
    return postfix();
  };
  const power = binary(unary, ['^']);
  const product = binary(power, ['*', '/']);
  const sum = binary(product, ['+', '-']);
  const concat = binary(sum, ['&']);
  const expression = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  const tree = expression();
  if (at !== tokens.length) throw UNSUPPORTED;
  return tree;
}

// ---------- values ----------
function num(v) {
  if (isError(v)) return v;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return toSerial(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (blank(v)) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return String(v).trim() !== '' && Number.isFinite(n) ? n : '#VALUE!';
}
function text(v) {
  if (blank(v)) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return String(toSerial(v));
  if (typeof v === 'number') return String(Number(v.toPrecision(15)));
  return String(v);
}
function truthy(v) {
  if (isError(v)) return v;
  if (typeof v === 'boolean') return v;
  if (blank(v)) return false;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof Date) return true;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return '#VALUE!';
}
// Sheets' order: numbers (and dates) before text before booleans; text ignores case; a blank
// equals 0 and "".
function compare(a, b) {
  const rank = (v) =>
    typeof v === 'number' || v instanceof Date ? 0 : typeof v === 'boolean' ? 2 : 1;
  if (blank(a) && blank(b)) return 0;
  if (blank(a)) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (blank(b)) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = rank(a),
    rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return num(a) - num(b);
  if (ra === 2) return Number(a) - Number(b);
  const x = String(a).toLowerCase(),
    y = String(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
const grid = (v) => (isArray(v) ? v : [[v]]);
const first = (v) => (isArray(v) ? v[0][0] : v);
const flat = (v) => (isArray(v) ? v.flat() : [v]);

// Applies fn to the elements of its arguments, broadcasting a single row or column; positions
// past an argument's end read #N/A, as Sheets shows them.
function lift(fn, ...args) {
  if (!args.some(isArray)) return fn(...args);
  const grids = args.map(grid);
  const rows = maxOf(grids.map((g) => g.length)),
    cols = maxOf(grids.map((g) => g[0].length));
  const out = [];
  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++)
      line.push(
        fn(
          ...grids.map((g) => {
            const rr = g.length === 1 ? 0 : r,
              cc = g[0].length === 1 ? 0 : c;
            return rr < g.length && cc < g[0].length ? g[rr][cc] : '#N/A';
          })
        )
      );
    out.push(line);
  }
  return out;
}
const firstError = (...vs) => vs.find(isError);

function arithmetic(op, a, b) {
  const e = firstError(a, b);
  if (e) return e;
  if (op === '&') return text(a) + text(b);
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    const c = compare(a, b);
    return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
  }
  const x = num(a),
    y = num(b);
  const bad = firstError(x, y);
  if (bad) return bad;
  // A date plus or minus days stays a date; two dates apart are days.
  const dated =
    a instanceof Date !== b instanceof Date && (op === '+' || (op === '-' && a instanceof Date));
  let value;
  if (op === '+') value = x + y;
  else if (op === '-') value = x - y;
  else if (op === '*') value = x * y;
  else if (op === '/') {
    if (y === 0) return '#DIV/0!';
    value = x / y;
  } else if (op === '^') value = Math.pow(x, y);
  if (!Number.isFinite(value)) return '#NUM!';
  return dated ? fromSerial(value) : value;
}

// The numbers of aggregate arguments: from ranges and arrays only numbers and dates; a value
// typed into the call counts as its number.
function numbers(values, direct) {
  const out = [];
  for (const { value, literal } of values) {
    if (isArray(value)) {
      for (const v of value.flat()) {
        if (isError(v)) throw Object.assign(new Error('err'), { sheetError: v });
        if (typeof v === 'number') out.push(v);
        else if (v instanceof Date) out.push(toSerial(v));
      }
    } else {
      if (isError(value)) throw Object.assign(new Error('err'), { sheetError: value });
      if (blank(value) && !literal) continue;
      const n = direct ? num(value) : typeof value === 'number' ? value : null;
      if (isError(n)) throw Object.assign(new Error('err'), { sheetError: n });
      if (n !== null) out.push(n);
    }
  }
  return out;
}
const allDates = (values) => {
  const list = values.flatMap((x) => flat(x.value)).filter((v) => !blank(v));
  return list.length > 0 && list.every((v) => v instanceof Date);
};

// ---------- criteria ----------
function criterion(crit) {
  if (crit instanceof Date) crit = toSerial(crit);
  if (typeof crit === 'number') return { eq: 'n:' + crit, test: (v) => num(v) === crit };
  if (typeof crit === 'boolean') return { eq: 'b:' + crit, test: (v) => v === crit };
  const m = /^(<>|>=|<=|=|>|<)?(.*)$/s.exec(String(crit));
  const op = m[1] || '=',
    rhs = m[2];
  if (rhs === '') return op === '<>' ? { test: (v) => !blank(v) } : { test: (v) => blank(v) };
  const n = Number(rhs);
  if (Number.isFinite(n) && rhs.trim() !== '') {
    const test = (v) => {
      if (typeof v !== 'number' && !(v instanceof Date)) return op === '<>';
      const x = num(v);
      return { '=': x === n, '<>': x !== n, '>': x > n, '<': x < n, '>=': x >= n, '<=': x <= n }[
        op
      ];
    };
    return op === '=' ? { eq: 'n:' + n, test } : { test };
  }
  const lower = rhs.toLowerCase();
  if ((op === '=' || op === '<>') && /[*?]/.test(rhs)) {
    const re = new RegExp(
      '^' +
        lower
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
      's'
    );
    return { test: (v) => (typeof v === 'string' && re.test(v.toLowerCase())) === (op === '=') };
  }
  const test = (v) => {
    if (op === '=') return typeof v === 'string' && v.toLowerCase() === lower;
    if (op === '<>') return !(typeof v === 'string' && v.toLowerCase() === lower);
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return { '>': s > lower, '<': s < lower, '>=': s >= lower, '<=': s <= lower }[op];
  };
  return op === '=' ? { eq: 's:' + lower, test } : { test };
}
const keyOf = (v) =>
  typeof v === 'number'
    ? 'n:' + v
    : v instanceof Date
      ? 'n:' + toSerial(v)
      : typeof v === 'boolean'
        ? 'b:' + v
        : typeof v === 'string'
          ? 's:' + v.toLowerCase()
          : '';

// ---------- the evaluator ----------
// io: { range(text, at) -> { sheet, top, left, bottom, right, key } | null, grid(r) -> rows,
// remember(key, make), query(sourceText, queryText, headers, at) -> rows | undefined, seed }.
export function evaluateFormula(formula, at, io) {
  const tree = parse(String(formula).replace(/^=/, ''));
  let state = io.seed >>> 0 || 1;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const own = (r) => r.sheet.name.toLowerCase() === String(at.sheet).toLowerCase();
  // Indexes of arrays this evaluation made or read from its own tab.
  const local = new WeakMap();
  // Equality indexes of ranges on other tabs, per batch: value key -> row positions.
  const indexOf = (values) => {
    const make = () => {
      const map = new Map();
      values.forEach((row, i) => {
        const k = keyOf(row[0]);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i);
      });
      return map;
    };
    if (values.ref && !values.ref.own) return io.remember('aindex:' + values.ref.key, make);
    if (!local.has(values)) local.set(values, make());
    return local.get(values);
  };

  const readRef = (refText) => {
    const r = io.range(refText, at);
    return r ? readBox(r) : '#REF!';
  };
  const readBox = (r) => {
    const read = () => {
      const rows = io
        .grid(r)
        .map((row) => row.map((v) => (v === null || v === undefined ? '' : v)));
      return rows.length ? rows : [['']];
    };
    const rows = own(r) ? read() : io.remember('agrid:' + r.key, read);
    // A shared grid is never changed in place: results are new arrays.
    const out = rows.slice();
    out.ref = { key: r.key, top: r.top, left: r.left, own: own(r) };
    return out;
  };

  const call = (fn, args, env) => {
    if (fn && fn.lambda) {
      const scope = Object.create(fn.env);
      fn.params.forEach((p, i) => (scope[p] = args[i]));
      return evaluate(fn.body, scope);
    }
    throw UNSUPPORTED;
  };
  const scalarOf = (v) => {
    if (isArray(v)) return v.length === 1 && v[0].length === 1 ? v[0][0] : '#VALUE!';
    return v;
  };

  // The cells a reference node names, as io.range does: a reference, INDEX of a reference (the
  // cell, row or column it picks) or a range between two of them. A whole column (A:A, B2:B)
  // reaches the tab's last grid row for INDEX, as in Sheets, though reading it stops at the last
  // filled row. null when it is no reference (#REF!); UNSUPPORTED for what this does not model.
  const boxOf = (node, env) => {
    if (node.type === 'ref') {
      const r = io.range(node.text, at);
      if (!r) return null;
      const open = /[A-Za-z]$/.test(node.text.replace(/\$/g, ''));
      return open && r.sheet.maxRows > r.bottom ? { ...r, reach: r.sheet.maxRows } : r;
    }
    if (node.type === 'span') {
      const a = boxOf(node.left, env),
        b = boxOf(node.right, env);
      if (!a || !b || a.sheet.id !== b.sheet.id) return null;
      return box(
        a.sheet,
        Math.min(a.top, b.top),
        Math.min(a.left, b.left),
        Math.max(a.bottom, b.bottom),
        Math.max(a.right, b.right)
      );
    }
    if (node.type === 'call' && node.name === 'INDEX' && node.args.length >= 2) {
      const r = boxOf(node.args[0], env);
      if (!r) return null;
      const height = (r.reach || r.bottom) - r.top + 1,
        width = r.right - r.left + 1;
      let row = num(first(evaluate(node.args[1], env))),
        column = node.args[2] ? num(first(evaluate(node.args[2], env))) : 0;
      if (isError(row) || isError(column)) return null;
      row = Math.floor(row);
      column = Math.floor(column);
      if (!node.args[2] && height === 1 && row) [row, column] = [1, row];
      if (!node.args[2] && width === 1 && row) column = 1;
      if (row < 0 || column < 0 || row > height || column > width) return null;
      return box(
        r.sheet,
        row ? r.top + row - 1 : r.top,
        column ? r.left + column - 1 : r.left,
        row ? r.top + row - 1 : r.bottom,
        column ? r.left + column - 1 : r.right
      );
    }
    throw UNSUPPORTED;
  };
  const box = (sheet, top, left, bottom, right) => ({
    sheet,
    top,
    left,
    bottom,
    right,
    key: `${sheet.id}!${top}:${left}:${bottom}:${right}`,
  });

  function evaluate(node, env) {
    switch (node.type) {
      case 'num':
      case 'str':
      case 'bool':
        return node.value;
      case 'empty':
        return '';
      case 'ref':
        return readRef(node.text);
      case 'span': {
        const box = boxOf(node, env);
        return box ? readBox(box) : '#REF!';
      }
      case 'name':
        if (node.name in env) return env[node.name];
        throw UNSUPPORTED;
      case 'neg': {
        const v = evaluate(node.arg, env);
        return isArray(v) ? lift((x) => arithmetic('-', 0, x), v) : arithmetic('-', 0, v);
      }
      case 'bin': {
        const left = evaluate(node.left, env),
          right = evaluate(node.right, env);
        return isArray(left) || isArray(right)
          ? lift((x, y) => arithmetic(node.op, x, y), left, right)
          : arithmetic(node.op, left, right);
      }
      case 'array': {
        const lines = [];
        for (const row of node.rows) {
          const blocks = row.map((item) => grid(evaluate(item, env)));
          const height = maxOf(blocks.map((b) => b.length));
          for (let y = 0; y < height; y++)
            lines.push(blocks.flatMap((b) => (y < b.length ? b[y] : b[0].map(() => '#N/A'))));
        }
        const width = maxOf(lines.map((l) => l.length));
        if (lines.some((l) => l.length !== width)) return '#VALUE!';
        return lines.length === 1 && width === 1 ? lines[0][0] : lines;
      }
      case 'invoke':
        return call(
          evaluate(node.fn, env),
          node.args.map((a) => evaluate(a, env)),
          env
        );
      case 'call':
        return fn(node, env);
      default:
        throw UNSUPPORTED;
    }
  }

  const ev = (node, env) => evaluate(node, env);
  const evAll = (node, env) => node.args.map((a) => ev(a, env));
  const n0 = (v) => num(first(v));

  // Aggregates over every argument (ranges, arrays and typed values).
  const aggregate = (node, env, reduce, { direct = true, dates = false } = {}) => {
    const values = node.args.map((a) => ({
      value: ev(a, env),
      literal: a.type === 'num' || a.type === 'bool' || a.type === 'str',
    }));
    try {
      const list = numbers(values, direct);
      const out = reduce(list);
      return dates && typeof out === 'number' && allDates(values) ? fromSerial(out) : out;
    } catch (error) {
      if (error.sheetError) return error.sheetError;
      throw error;
    }
  };

  // The IFS family: pairs of (range, criterion). A criteria array expands the result for the
  // functions Sheets expands (expand), else its first value is used.
  const conditional = (target, pairs, reduce, expand) => {
    if (pairs.some(([values]) => grid(values)[0].length !== 1)) throw UNSUPPORTED;
    const one = (crits) => {
      let rows = null;
      const tests = [];
      pairs.forEach(([rangeValue], i) => {
        const c = criterion(crits[i]);
        if (c.eq && rows === null && isArray(rangeValue) && rangeValue[0].length === 1)
          rows = (indexOf(rangeValue).get(c.eq) || []).slice();
        else tests.push([rangeValue, c]);
      });
      const height = grid(target || pairs[0][0]).length;
      if (rows === null) rows = Array.from({ length: height }, (_, i) => i);
      const kept = rows.filter((i) =>
        tests.every(([values, c]) => c.test(grid(values)[i] ? grid(values)[i][0] : ''))
      );
      return reduce(
        kept.map((i) => (target ? grid(target)[i][0] : null)),
        kept.length
      );
    };
    const crits = pairs.map(([, c]) => c);
    if (!crits.some(isArray)) return one(crits);
    if (!expand) return one(crits.map(first));
    return lift((...cs) => one(cs), ...crits);
  };
  const sumOf = (vals) =>
    vals.reduce((a, v) => a + (typeof v === 'number' ? v : v instanceof Date ? toSerial(v) : 0), 0);
  const numericOf = (vals) =>
    vals.filter((v) => typeof v === 'number' || v instanceof Date).map(num);
  const datesOnly = (vals) => {
    const list = vals.filter((v) => !blank(v));
    return list.length > 0 && list.every((v) => v instanceof Date);
  };

  const sortRows = (rows, specs) =>
    rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        for (const { key, asc } of specs) {
          const x = key(a),
            y = key(b);
          if (blank(x) !== blank(y)) return blank(x) ? 1 : -1;
          const c = compare(x, y);
          if (c) return asc ? c : -c;
        }
        return a.i - b.i;
      })
      .map((x) => x.row);
  const sortSpecs = (data, args) => {
    const specs = [];
    for (let i = 0; i < args.length; i += 2) {
      const col = args[i],
        asc =
          args[i + 1] === undefined || blank(args[i + 1])
            ? true
            : truthy(first(args[i + 1])) === true;
      if (isArray(col) && !(col.length === 1 && col[0].length === 1)) {
        const values = col.map((r) => r[0]);
        const positions = new Map(data.map((row, j) => [row, j]));
        specs.push({ key: (x) => values[positions.get(x.row)], asc });
      } else {
        const c = n0(col) - 1;
        specs.push({ key: (x) => x.row[c], asc });
      }
    }
    return specs.length ? specs : [{ key: (x) => x.row[0], asc: true }];
  };

  const roundTo = (x, d, mode) => {
    const f = Math.pow(10, d);
    const v = Number((Math.abs(x) * f).toPrecision(15));
    const r = mode === 'up' ? Math.ceil(v) : mode === 'down' ? Math.floor(v) : Math.round(v);
    return (Math.sign(x) * r) / f;
  };
  const dateOf = (v) => {
    const n = num(v);
    return isError(n) ? n : fromSerial(n);
  };
  const textFormat = (value, format) => {
    if (isError(value)) return value;
    const f = String(format);
    if (/[yd]|m{3,}/i.test(f) || /^m{1,2}([/-]|$)/i.test(f)) {
      const d = value instanceof Date ? value : dateOf(value);
      if (isError(d)) return d;
      const Y = d.getUTCFullYear(),
        M = d.getUTCMonth(),
        D = d.getUTCDate();
      const months = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d/gi, (t) => {
        const k = t.toLowerCase();
        if (k === 'yyyy') return String(Y);
        if (k === 'yy') return String(Y).slice(2);
        if (k === 'mmmm') return months[M];
        if (k === 'mmm') return months[M].slice(0, 3);
        if (k === 'mm') return String(M + 1).padStart(2, '0');
        if (k === 'm') return String(M + 1);
        if (k === 'dddd') return days[d.getUTCDay()];
        if (k === 'ddd') return days[d.getUTCDay()].slice(0, 3);
        if (k === 'dd') return String(D).padStart(2, '0');
        return String(D);
      });
    }
    const x = num(value);
    if (isError(x)) return typeof value === 'string' ? value : x;
    const pct = /%/.test(f);
    const v = pct ? x * 100 : x;
    const decimals = (/\.(0+)/.exec(f) || [, ''])[1].length;
    const zeros = (/^[^.]*?(0+)(?:\.|%|$)/.exec(f.replace(/[#,]/g, '')) || [, '0'])[1].length;
    let out = Math.abs(v).toFixed(decimals);
    let [int, frac] = out.split('.');
    int = int.padStart(zeros, '0');
    if (/,/.test(f)) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const prefix = (/^[^0#]*/.exec(f.replace(/"/g, '')) || [''])[0].replace(/[.,%]/g, '');
    return (v < 0 ? '-' : '') + prefix + int + (frac ? '.' + frac : '') + (pct ? '%' : '');
  };

  const SCALAR = {
    ABS: (x) => Math.abs(x),
    INT: (x) => Math.floor(x),
    TRUNC: (x, d = 0) => roundTo(x, d, 'down'),
    ROUND: (x, d = 0) => roundTo(x, d),
    ROUNDUP: (x, d = 0) => roundTo(x, d, 'up'),
    ROUNDDOWN: (x, d = 0) => roundTo(x, d, 'down'),
    MOD: (x, y) => (y === 0 ? '#DIV/0!' : x - y * Math.floor(x / y)),
    POWER: (x, y) => Math.pow(x, y),
    SQRT: (x) => (x < 0 ? '#NUM!' : Math.sqrt(x)),
    EXP: (x) => Math.exp(x),
    LN: (x) => (x <= 0 ? '#NUM!' : Math.log(x)),
    LOG10: (x) => (x <= 0 ? '#NUM!' : Math.log10(x)),
    SIGN: (x) => Math.sign(x),
    CEILING: (x, s = 1) => (s ? Math.ceil(x / s) * s : 0),
    FLOOR: (x, s = 1) => (s ? Math.floor(x / s) * s : 0),
    MROUND: (x, s) => (s ? Math.round(x / s) * s : 0),
    YEAR: (x) => fromSerial(x).getUTCFullYear(),
    MONTH: (x) => fromSerial(x).getUTCMonth() + 1,
    DAY: (x) => fromSerial(x).getUTCDate(),
    WEEKDAY: (x, type = 1) => {
      const d = fromSerial(x).getUTCDay();
      return type === 2 ? ((d + 6) % 7) + 1 : type === 3 ? (d + 6) % 7 : d + 1;
    },
    // Weeks start on Sunday; the week of January 1 is week 1.
    WEEKNUM: (x) => {
      const d = fromSerial(x),
        start = Date.UTC(d.getUTCFullYear(), 0, 1);
      return Math.floor(((d.getTime() - start) / DAY + new Date(start).getUTCDay()) / 7) + 1;
    },
  };
  const DATED = {
    DATE: (y, m, d) => new Date(Date.UTC(y, m - 1, d)),
    EDATE: (x, k) => {
      const d = fromSerial(x);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, d.getUTCDate()));
    },
    EOMONTH: (x, k) => {
      const d = fromSerial(x);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k + 1, 0));
    },
  };
  const TEXTUAL = {
    LEN: (s) => s.length,
    UPPER: (s) => s.toUpperCase(),
    LOWER: (s) => s.toLowerCase(),
    PROPER: (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, a, b) => a + b.toUpperCase()),
    TRIM: (s) => s.trim().replace(/\s+/g, ' '),
    LEFT: (s, n = 1) => s.slice(0, num(n)),
    RIGHT: (s, n = 1) => (num(n) ? s.slice(-num(n)) : ''),
    MID: (s, start, n) => s.slice(num(start) - 1, num(start) - 1 + num(n)),
    REPT: (s, n) => s.repeat(Math.max(0, num(n))),
    SUBSTITUTE: (s, a, b) => s.split(text(a)).join(text(b)),
    TO_TEXT: (s) => s,
  };

  function fn(node, env) {
    const name = node.name.replace(/^_XLFN\./, '');
    const a = node.args;
    // A LET or LAMBDA name called as a function.
    if (name.toLowerCase() in env) return call(env[name.toLowerCase()], evAll(node, env), env);
    switch (name) {
      case 'ARRAYFORMULA':
        return ev(a[0], env);
      case 'LET': {
        const scope = Object.create(env);
        for (let i = 0; i + 1 < a.length; i += 2) {
          if (a[i].type !== 'name') throw UNSUPPORTED;
          scope[a[i].name] = ev(a[i + 1], scope);
        }
        return ev(a[a.length - 1], scope);
      }
      case 'LAMBDA':
        return {
          lambda: true,
          params: a.slice(0, -1).map((p) => {
            if (p.type !== 'name') throw UNSUPPORTED;
            return p.name;
          }),
          body: a[a.length - 1],
          env,
        };
      case 'MAP': {
        const fnv = ev(a[a.length - 1], env);
        const arrays = a.slice(0, -1).map((x) => grid(ev(x, env)));
        return arrays[0].map((row, r) =>
          row.map((_, c) =>
            scalarOf(
              call(
                fnv,
                arrays.map((g) => (g[r] ? g[r][c] : '#N/A'))
              )
            )
          )
        );
      }
      case 'BYROW':
      case 'BYCOL': {
        const g = grid(ev(a[0], env)),
          fnv = ev(a[1], env);
        if (name === 'BYROW') return g.map((row) => [scalarOf(call(fnv, [[row]]))]);
        return [g[0].map((_, c) => scalarOf(call(fnv, [g.map((row) => [row[c]])])))];
      }
      case 'MAKEARRAY': {
        const rows = n0(ev(a[0], env)),
          cols = n0(ev(a[1], env)),
          fnv = ev(a[2], env);
        if (!(rows >= 1 && cols >= 1) || rows * cols > 5e6) return '#VALUE!';
        const out = [];
        for (let r = 1; r <= rows; r++) {
          const line = [];
          for (let c = 1; c <= cols; c++) line.push(scalarOf(call(fnv, [r, c])));
          out.push(line);
        }
        return out;
      }
      case 'REDUCE':
      case 'SCAN': {
        let acc = ev(a[0], env);
        const g = grid(ev(a[1], env)),
          fnv = ev(a[2], env),
          out = [];
        for (const row of g) {
          const line = [];
          for (const v of row) {
            acc = call(fnv, [acc, v]);
            line.push(scalarOf(acc));
          }
          out.push(line);
        }
        return name === 'REDUCE' ? acc : out;
      }
      case 'SEQUENCE': {
        const [rows, cols = 1, start = 1, step = 1] = evAll(node, env).map((v) =>
          blank(first(v)) ? undefined : n0(v)
        );
        if (!(rows >= 1 && cols >= 1) || rows * cols > 5e6) return '#VALUE!';
        return Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => start + (r * cols + c) * step)
        );
      }
      case 'RAND':
        return rand();
      case 'RANDBETWEEN': {
        const [lo, hi] = evAll(node, env).map(n0);
        return Math.ceil(lo) + Math.floor(rand() * (Math.floor(hi) - Math.ceil(lo) + 1));
      }
      case 'RANDARRAY': {
        const [rows = 1, cols = 1] = evAll(node, env).map(n0);
        if (!(rows >= 1 && cols >= 1) || rows * cols > 5e6) return '#VALUE!';
        return Array.from({ length: rows }, () => Array.from({ length: cols }, () => rand()));
      }
      case 'TODAY': {
        const now = new Date();
        return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      }
      case 'NOW':
        return new Date();
      case 'NA':
        return '#N/A';
      case 'TRUE':
        return true;
      case 'FALSE':
        return false;
      case 'ROW':
      case 'COLUMN': {
        if (!a.length) return name === 'ROW' ? at.row : at.column;
        const v = ev(a[0], env);
        if (!isArray(v) || !v.ref) throw UNSUPPORTED;
        return name === 'ROW'
          ? v.map((_, r) => [v.ref.top + r])
          : [v[0].map((_, c) => v.ref.left + c)];
      }
      case 'ROWS':
        return grid(ev(a[0], env)).length;
      case 'COLUMNS':
        return grid(ev(a[0], env))[0].length;
      case 'IF': {
        const cond = ev(a[0], env);
        if (!isArray(cond)) {
          const t = truthy(cond);
          if (isError(t)) return t;
          return t ? ev(a[1], env) : a[2] ? ev(a[2], env) : false;
        }
        const yes = ev(a[1], env),
          no = a[2] ? ev(a[2], env) : false;
        return lift(
          (c, y, n) => {
            const t = truthy(c);
            return isError(t) ? t : t ? y : n;
          },
          cond,
          yes,
          no
        );
      }
      case 'IFS': {
        const conds = [];
        for (let i = 0; i + 1 < a.length; i += 2) {
          const c = ev(a[i], env);
          if (!isArray(c) && !conds.some((x) => isArray(x.c))) {
            const t = truthy(c);
            if (isError(t)) return t;
            if (t) return ev(a[i + 1], env);
            continue;
          }
          conds.push({ c, v: ev(a[i + 1], env) });
        }
        if (!conds.length) return '#N/A';
        return lift(
          (...xs) => {
            for (let i = 0; i < xs.length; i += 2) {
              const t = truthy(xs[i]);
              if (isError(t)) return t;
              if (t) return xs[i + 1];
            }
            return '#N/A';
          },
          ...conds.flatMap((x) => [x.c, x.v])
        );
      }
      case 'SWITCH': {
        const subject = ev(a[0], env);
        const cases = [];
        for (let i = 1; i + 1 < a.length; i += 2) cases.push([ev(a[i], env), ev(a[i + 1], env)]);
        const fallback = (a.length - 1) % 2 ? ev(a[a.length - 1], env) : '#N/A';
        return lift(
          (s, ...xs) => {
            for (let i = 0; i + 1 < xs.length; i += 2)
              if (compare(s, xs[i]) === 0) return xs[i + 1];
            return xs[xs.length - 1];
          },
          subject,
          ...cases.flat(),
          fallback
        );
      }
      case 'CHOOSE': {
        const index = ev(a[0], env);
        if (!isArray(index)) {
          const i = Math.floor(num(index));
          if (isError(i)) return i;
          return i >= 1 && i < a.length ? ev(a[i], env) : '#VALUE!';
        }
        const options = a.slice(1).map((x) => ev(x, env));
        return lift(
          (i, ...xs) => {
            const k = Math.floor(num(i));
            return k >= 1 && k <= xs.length ? xs[k - 1] : '#VALUE!';
          },
          index,
          ...options
        );
      }
      case 'IFERROR':
      case 'IFNA': {
        const v = ev(a[0], env);
        const caught = (x) => isError(x) && (name === 'IFERROR' || x === '#N/A');
        if (!isArray(v)) return caught(v) ? (a[1] ? ev(a[1], env) : '') : v;
        const alt = a[1] ? ev(a[1], env) : '';
        return lift((x, y) => (caught(x) ? y : x), v, alt);
      }
      case 'AND':
      case 'OR': {
        const list = evAll(node, env)
          .flatMap(flat)
          .filter((v) => !blank(v));
        const bad = list.find(isError);
        if (bad) return bad;
        const bools = list.map(truthy);
        return name === 'AND' ? bools.every((x) => x === true) : bools.some((x) => x === true);
      }
      case 'NOT':
        return lift(
          (v) => {
            const t = truthy(v);
            return isError(t) ? t : !t;
          },
          ev(a[0], env)
        );
      case 'ISBLANK':
        return lift((v) => blank(v), ev(a[0], env));
      case 'ISNUMBER':
        return lift((v) => typeof v === 'number' || v instanceof Date, ev(a[0], env));
      case 'ISTEXT':
        return lift((v) => typeof v === 'string' && !blank(v) && !isError(v), ev(a[0], env));
      case 'ISERROR':
        return lift((v) => isError(v), ev(a[0], env));
      case 'ISNA':
        return lift((v) => v === '#N/A', ev(a[0], env));
      case 'N':
        return lift(
          (v) => (typeof v === 'number' ? v : v instanceof Date ? toSerial(v) : v === true ? 1 : 0),
          ev(a[0], env)
        );
      case 'VALUE':
        return lift((v) => num(v), ev(a[0], env));
      case 'TEXT':
        return lift((v, f) => textFormat(v, text(f)), ev(a[0], env), ev(a[1], env));
      case 'CONCATENATE': {
        const list = evAll(node, env).flatMap(flat);
        return list.find(isError) || list.map(text).join('');
      }
      case 'CONCAT':
        return lift((x, y) => arithmetic('&', x, y), ev(a[0], env), ev(a[1], env));
      case 'TEXTJOIN': {
        const [sep, skip, ...rest] = evAll(node, env);
        const list = rest.flatMap(flat);
        const bad = list.find(isError);
        if (bad) return bad;
        return list
          .filter((v) => !(truthy(first(skip)) === true && blank(v)))
          .map(text)
          .join(text(first(sep)));
      }
      case 'CHAR':
        return lift((x) => String.fromCharCode(num(x)), ev(a[0], env));
      case 'FIND':
      case 'SEARCH':
        return lift(
          (needle, hay, start = 1) => {
            const h = name === 'SEARCH' ? text(hay).toLowerCase() : text(hay);
            const n = name === 'SEARCH' ? text(needle).toLowerCase() : text(needle);
            const i = h.indexOf(n, num(start) - 1);
            return i < 0 ? '#VALUE!' : i + 1;
          },
          ...evAll(node, env)
        );
      case 'DATEVALUE':
        return lift(
          (s) => {
            const t = Date.parse(
              text(s) + (/\d{4}-\d{2}-\d{2}$/.test(text(s)) ? 'T00:00:00Z' : '')
            );
            return Number.isFinite(t) ? new Date(t) : '#VALUE!';
          },
          ev(a[0], env)
        );
      case 'DAYS':
        return lift(
          (end, start) => {
            const e = num(end),
              s = num(start);
            return firstError(e, s) || Math.floor(e) - Math.floor(s);
          },
          ev(a[0], env),
          ev(a[1], env)
        );
      case 'DATEDIF':
        return lift(
          (start, end, unit) => {
            const s = num(start),
              e = num(end);
            if (firstError(s, e)) return firstError(s, e);
            if (e < s) return '#NUM!';
            const u = text(unit).toUpperCase();
            if (u === 'D') return Math.floor(e) - Math.floor(s);
            const ds = fromSerial(s),
              de = fromSerial(e);
            let months =
              (de.getUTCFullYear() - ds.getUTCFullYear()) * 12 +
              de.getUTCMonth() -
              ds.getUTCMonth();
            if (de.getUTCDate() < ds.getUTCDate()) months--;
            if (u === 'M') return months;
            if (u === 'Y') return Math.floor(months / 12);
            throw UNSUPPORTED;
          },
          ev(a[0], env),
          ev(a[1], env),
          ev(a[2], env)
        );
      case 'SUM':
        return aggregate(node, env, (l) => l.reduce((x, y) => x + y, 0));
      case 'PRODUCT':
        return aggregate(node, env, (l) => l.reduce((x, y) => x * y, 1));
      case 'AVERAGE':
        return aggregate(node, env, (l) =>
          l.length ? l.reduce((x, y) => x + y, 0) / l.length : '#DIV/0!'
        );
      case 'MIN':
        return aggregate(node, env, (l) => (l.length ? minOf(l) : 0), { dates: true });
      case 'MAX':
        return aggregate(node, env, (l) => (l.length ? maxOf(l) : 0), { dates: true });
      case 'MEDIAN':
        return aggregate(node, env, (l) => {
          if (!l.length) return '#NUM!';
          const s = l.slice().sort((x, y) => x - y),
            m = s.length >> 1;
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
        });
      case 'COUNT':
        return aggregate(node, env, (l) => l.length, { direct: false });
      case 'COUNTA':
        return evAll(node, env)
          .flatMap(flat)
          .filter((v) => !blank(v)).length;
      case 'COUNTBLANK':
        return evAll(node, env).flatMap(flat).filter(blank).length;
      case 'COUNTUNIQUE':
        return new Set(
          evAll(node, env)
            .flatMap(flat)
            .filter((v) => !blank(v))
            .map(keyOf)
        ).size;
      case 'LARGE':
      case 'SMALL':
      case 'PERCENTILE':
      case 'PERCENTILE.INC':
      case 'QUARTILE':
      case 'QUARTILE.INC': {
        const list = numericOf(flat(ev(a[0], env))).sort((x, y) => x - y);
        const k = n0(ev(a[1], env));
        if (!list.length) return '#NUM!';
        if (name === 'LARGE' || name === 'SMALL') {
          const i = Math.floor(k) - 1;
          if (i < 0 || i >= list.length) return '#NUM!';
          return name === 'SMALL' ? list[i] : list[list.length - 1 - i];
        }
        const p = name.startsWith('QUARTILE') ? k / 4 : k;
        if (p < 0 || p > 1) return '#NUM!';
        const pos = p * (list.length - 1),
          lo = Math.floor(pos);
        return list[lo] + (pos - lo) * ((list[lo + 1] ?? list[lo]) - list[lo]);
      }
      case 'PERCENTRANK':
      case 'PERCENTRANK.INC': {
        const list = numericOf(flat(ev(a[0], env))).sort((x, y) => x - y);
        return lift(
          (x) => {
            const v = num(x);
            if (isError(v)) return v;
            if (!list.length || v < list[0] || v > list[list.length - 1]) return '#N/A';
            const below = list.filter((y) => y < v).length;
            return Math.floor((below / (list.length - 1 || 1)) * 1000) / 1000;
          },
          ev(a[1], env)
        );
      }
      case 'RANK':
      case 'RANK.EQ': {
        const list = numericOf(flat(ev(a[1], env)));
        const asc = a[2] ? truthy(first(ev(a[2], env))) === true : false;
        return lift(
          (x) => {
            const v = num(x);
            if (isError(v)) return v;
            if (!list.includes(v)) return '#N/A';
            return 1 + list.filter((y) => (asc ? y < v : y > v)).length;
          },
          ev(a[0], env)
        );
      }
      case 'SUMPRODUCT': {
        const arrays = evAll(node, env).map(grid);
        const rows = arrays[0].length,
          cols = arrays[0][0].length;
        if (arrays.some((g) => g.length !== rows || g[0].length !== cols)) return '#VALUE!';
        let total = 0;
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            let p = 1;
            for (const g of arrays) {
              const v = g[r][c];
              if (isError(v)) return v;
              p *=
                typeof v === 'number'
                  ? v
                  : v instanceof Date
                    ? toSerial(v)
                    : typeof v === 'boolean'
                      ? Number(v)
                      : 0;
            }
            total += p;
          }
        return total;
      }
      case 'COUNTIF':
      case 'SUMIF':
      case 'AVERAGEIF': {
        const range = ev(a[0], env),
          crit = ev(a[1], env),
          target = name === 'COUNTIF' ? null : a[2] ? ev(a[2], env) : range;
        return conditional(
          target,
          [[range, crit]],
          (vals, n) =>
            name === 'COUNTIF'
              ? n
              : name === 'SUMIF'
                ? sumOf(vals)
                : numericOf(vals).length
                  ? sumOf(vals) / numericOf(vals).length
                  : '#DIV/0!',
          true
        );
      }
      case 'COUNTIFS':
      case 'SUMIFS':
      case 'AVERAGEIFS':
      case 'MAXIFS':
      case 'MINIFS':
      case 'COUNTUNIQUEIFS': {
        const values = evAll(node, env);
        const target = name === 'COUNTIFS' ? null : values[0];
        const rest = name === 'COUNTIFS' ? values : values.slice(1);
        const pairs = [];
        for (let i = 0; i + 1 < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
        if (!pairs.length) return '#N/A';
        const reduce = (vals, n) => {
          if (name === 'COUNTIFS') return n;
          if (name === 'SUMIFS') return sumOf(vals);
          if (name === 'COUNTUNIQUEIFS')
            return new Set(vals.filter((v) => !blank(v)).map(keyOf)).size;
          const nums = numericOf(vals);
          if (name === 'AVERAGEIFS')
            return nums.length ? nums.reduce((x, y) => x + y, 0) / nums.length : '#DIV/0!';
          if (!nums.length) return 0;
          const out = name === 'MAXIFS' ? maxOf(nums) : minOf(nums);
          return datesOnly(vals) ? fromSerial(out) : out;
        };
        return conditional(target, pairs, reduce, name === 'COUNTIFS' || name === 'SUMIFS');
      }
      case 'INDEX': {
        const g = grid(ev(a[0], env));
        let r = a[1] ? n0(ev(a[1], env)) : 0,
          c = a[2] ? n0(ev(a[2], env)) : 0;
        if (isError(r) || isError(c)) return firstError(r, c);
        if (g.length === 1 && !a[2] && r) {
          c = r;
          r = 1;
        } else if (g[0].length === 1 && !a[2] && r) c = 1;
        if (r < 0 || c < 0 || r > g.length || c > g[0].length) return '#REF!';
        if (r && c) return g[r - 1][c - 1];
        if (r) return [g[r - 1]];
        if (c) return g.map((row) => [row[c - 1]]);
        return g;
      }
      case 'MATCH': {
        const key = first(ev(a[0], env)),
          list = flat(ev(a[1], env)),
          type = a[2] ? n0(ev(a[2], env)) : 1;
        if (type === 0) {
          const i = list.findIndex((v) => !blank(v) && compare(v, key) === 0);
          return i < 0 ? '#N/A' : i + 1;
        }
        let found = -1;
        for (let i = 0; i < list.length; i++)
          if (
            !blank(list[i]) &&
            (type > 0 ? compare(list[i], key) <= 0 : compare(list[i], key) >= 0)
          )
            found = i;
        return found < 0 ? '#N/A' : found + 1;
      }
      case 'XLOOKUP': {
        const keys = ev(a[0], env),
          look = flat(ev(a[1], env)),
          result = grid(ev(a[2], env)),
          missing = a[3] && a[3].type !== 'empty' ? ev(a[3], env) : '#N/A';
        const index = indexOf(look.map((v) => [v]));
        const column = result.length === look.length;
        return lift((k) => {
          const hit = (index.get(keyOf(k)) || [])[0];
          if (hit === undefined) return first(missing);
          return column ? result[hit][0] : result[0][hit];
        }, keys);
      }
      case 'VLOOKUP': {
        const keys = ev(a[0], env),
          table = grid(ev(a[1], env)),
          col = n0(ev(a[2], env)),
          sorted = a[3] ? truthy(first(ev(a[3], env))) === true : true;
        const index = sorted ? null : indexOf(table.map((row) => [row[0]]));
        return lift((k) => {
          if (col < 1 || col > table[0].length) return '#REF!';
          if (!sorted) {
            const hit = (index.get(keyOf(k)) || [])[0];
            return hit === undefined ? '#N/A' : table[hit][col - 1];
          }
          let found = -1;
          for (let i = 0; i < table.length; i++)
            if (!blank(table[i][0]) && compare(table[i][0], k) <= 0) found = i;
          return found < 0 ? '#N/A' : table[found][col - 1];
        }, keys);
      }
      case 'UNIQUE': {
        const g = grid(ev(a[0], env));
        const once = a[2] ? truthy(first(ev(a[2], env))) === true : false;
        const counts = new Map(),
          order = [];
        for (const row of g) {
          const k = JSON.stringify(
            row.map((v) => (v instanceof Date ? 'd' + toSerial(v) : typeof v + ':' + v))
          );
          if (!counts.has(k)) {
            counts.set(k, 0);
            order.push([k, row]);
          }
          counts.set(k, counts.get(k) + 1);
        }
        const out = order.filter(([k]) => !once || counts.get(k) === 1).map(([, row]) => row);
        return out.length ? out : '#N/A';
      }
      case 'FILTER': {
        const g = grid(ev(a[0], env));
        const conds = a.slice(1).map((x) => grid(ev(x, env)));
        const byRow = conds.every((c) => c.length === g.length && c[0].length === 1);
        const byCol = !byRow && conds.every((c) => c.length === 1 && c[0].length === g[0].length);
        if (!byRow && !byCol) return '#VALUE!';
        const keep = (i) =>
          conds.every((c) => {
            const v = byRow ? c[i][0] : c[0][i];
            if (isError(v)) return false;
            const t = truthy(v);
            return t === true;
          });
        const out = byRow
          ? g.filter((_, i) => keep(i))
          : g.map((row) => row.filter((_, i) => keep(i)));
        return out.length && out[0].length ? out : '#N/A';
      }
      case 'SORT': {
        const values = evAll(node, env);
        const g = grid(values[0]);
        return sortRows(g, sortSpecs(g, values.slice(1)));
      }
      case 'SORTN': {
        const values = evAll(node, env);
        const g = grid(values[0]);
        const n = values[1] === undefined || blank(first(values[1])) ? 1 : n0(values[1]);
        return sortRows(g, sortSpecs(g, values.slice(3))).slice(0, n);
      }
      case 'HSTACK':
      case 'VSTACK': {
        const blocks = evAll(node, env).map(grid);
        if (name === 'VSTACK') {
          const width = maxOf(blocks.map((b) => b[0].length));
          return blocks.flatMap((b) =>
            b.map((row) => row.concat(Array(width - row.length).fill('#N/A')))
          );
        }
        const height = maxOf(blocks.map((b) => b.length));
        return Array.from({ length: height }, (_, r) =>
          blocks.flatMap((b) => (r < b.length ? b[r] : b[0].map(() => '#N/A')))
        );
      }
      case 'CHOOSECOLS':
      case 'CHOOSEROWS': {
        const [g0, ...picks] = evAll(node, env);
        const g = grid(g0);
        const indexes = picks.flatMap(flat).map(num);
        const size = name === 'CHOOSECOLS' ? g[0].length : g.length;
        const at2 = (i) => (i < 0 ? size + i : i - 1);
        if (indexes.some((i) => at2(i) < 0 || at2(i) >= size)) return '#VALUE!';
        return name === 'CHOOSECOLS'
          ? g.map((row) => indexes.map((i) => row[at2(i)]))
          : indexes.map((i) => g[at2(i)]);
      }
      case 'TRANSPOSE': {
        const g = grid(ev(a[0], env));
        return g[0].map((_, c) => g.map((row) => row[c]));
      }
      case 'TOCOL':
      case 'FLATTEN': {
        const ignore = name === 'TOCOL' && a[1] ? n0(ev(a[1], env)) : 0;
        const list = (name === 'FLATTEN' ? evAll(node, env) : [ev(a[0], env)]).flatMap(flat);
        const kept = list.filter(
          (v) =>
            !((ignore === 1 || ignore === 3) && blank(v)) &&
            !((ignore === 2 || ignore === 3) && isError(v))
        );
        return kept.length ? kept.map((v) => [v]) : '#N/A';
      }
      case 'TOROW':
        return [flat(ev(a[0], env))];
      case 'ARRAY_CONSTRAIN': {
        const g = grid(ev(a[0], env));
        const r = n0(ev(a[1], env)),
          c = n0(ev(a[2], env));
        return g.slice(0, r).map((row) => row.slice(0, c));
      }
      case 'QUERY': {
        if (!a[0] || a[0].type !== 'ref' || !a[1]) throw UNSUPPORTED;
        const q = first(ev(a[1], env));
        const headers = a[2] ? String(first(ev(a[2], env))) : undefined;
        const out = io.query(a[0].text, String(q), headers, at);
        if (!out) throw UNSUPPORTED;
        return out;
      }
      default:
        break;
    }
    if (SCALAR[name] || DATED[name]) {
      const f = SCALAR[name] || DATED[name];
      return lift(
        (...xs) => {
          const ns = xs.map(num);
          const bad = firstError(...ns);
          if (bad) return bad;
          const out = f(...ns);
          return typeof out === 'number' && !Number.isFinite(out) ? '#NUM!' : out;
        },
        ...evAll(node, env).map((v) => v)
      );
    }
    if (TEXTUAL[name])
      return lift(
        (s, ...rest) => {
          const bad = firstError(s, ...rest);
          return bad || TEXTUAL[name](text(s), ...rest);
        },
        ...evAll(node, env)
      );
    throw UNSUPPORTED;
  }

  // Scopes of LET and LAMBDA names: objects chained to their parent scope.
  const value = evaluate(tree, Object.create(null));
  if (value && value.lambda) return '#VALUE!';
  return value;
}
