// What a sheet shows, for tests and tools: the number patterns the app writes, and the formulas a
// dashboard enters over its data tabs, evaluated the way Sheets does for exactly those functions.
// Anything else throws, so a test notices a formula this evaluator cannot vouch for.

const FORMAT_COLORS = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

// Automatic format: up to ten significant digits, no grouping.
export function generalNumber(value) {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = String(Number(value.toPrecision(10)));
  return text.includes('e') ? value.toExponential(2).toUpperCase() : text;
}

function splitSections(pattern) {
  const sections = [];
  let current = '',
    quoted = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') quoted = !quoted;
    if (ch === '\\' && !quoted) {
      current += ch + (pattern[++i] ?? '');
      continue;
    }
    if (ch === ';' && !quoted) {
      sections.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return sections.concat([current]);
}

// Sheets rounds the decimal a number reads as (15 significant digits) half away from zero, so
// 423.385 shows 423.39 where toFixed, working on the binary value, would print 423.38.
function fixed(number, digits) {
  const [mantissa, exponent] = Number(number.toPrecision(15)).toExponential().split('e');
  return (Math.round(Number(mantissa + 'e' + (Number(exponent) + digits))) / 10 ** digits).toFixed(digits);
}

// The Sheets patterns the app writes: sections (positive;negative;zero), quoted text, 0 # ?
// digits, grouping, %, @ and [Color]. A decimal point always prints, so '#,##0.###' shows a
// whole number as "2,494." exactly like Sheets does.
export function formatNumber(value, pattern) {
  const sections = splitSections(pattern);
  let section = sections[0],
    number = value,
    sign = '';
  if (value < 0 && sections.length > 1) {
    section = sections[1];
    number = -value;
  } else if (value === 0 && sections.length > 2) section = sections[2];
  else if (value < 0) {
    sign = '-';
    number = -value;
  }
  let color = null;
  section = section.replace(/\[([^\]]*)\]/g, (_, name) => {
    color = FORMAT_COLORS[name.toLowerCase()] || color;
    return '';
  });
  const tokens = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      tokens.push({ kind: 'text', text: section.slice(i + 1, end < 0 ? undefined : end) });
      i = end < 0 ? section.length : end;
    } else if (ch === '\\') tokens.push({ kind: 'text', text: section[++i] ?? '' });
    else if (ch === '_' || ch === '*') i++;
    else if ('0#?'.includes(ch)) tokens.push({ kind: 'digit', ch });
    else if (ch === '.' && !tokens.some((token) => token.kind === 'dot'))
      tokens.push({ kind: 'dot' });
    else if (ch === ',') tokens.push({ kind: 'comma' });
    else if (ch === '%') tokens.push({ kind: 'text', text: '%', percent: true });
    else if (ch === '@') tokens.push({ kind: 'at' });
    else tokens.push({ kind: 'text', text: ch });
  }
  const dot = tokens.findIndex((token) => token.kind === 'dot');
  const integerEnd = dot < 0 ? tokens.length : dot;
  const digits = tokens.filter((token) => token.kind === 'digit');
  if (!digits.length) {
    const text = tokens
      .map((token) => (token.kind === 'at' ? generalNumber(value) : token.text || ''))
      .join('');
    return { text: sign && text ? sign + text : text, color };
  }
  const integer = tokens.slice(0, integerEnd).filter((token) => token.kind === 'digit');
  const fraction = dot < 0 ? [] : tokens.slice(dot + 1).filter((token) => token.kind === 'digit');
  const lastIntegerDigit = tokens
    .slice(0, integerEnd)
    .map((token) => token.kind)
    .lastIndexOf('digit');
  const grouped = tokens.slice(0, lastIntegerDigit).some((token) => token.kind === 'comma');
  const scaling = tokens
    .slice(lastIntegerDigit + 1, integerEnd)
    .filter((token) => token.kind === 'comma').length;
  const percents = tokens.filter((token) => token.percent).length;
  number = (number * 100 ** percents) / 1000 ** scaling;
  const required = fraction.filter((token) => token.ch !== '#').length;
  let [whole, part = ''] = fixed(number, fraction.length).split('.');
  while (part.length > required && part.endsWith('0')) part = part.slice(0, -1);
  const minimum = integer.filter((token) => token.ch === '0').length;
  if (whole === '0' && !minimum) whole = '';
  whole = whole.padStart(minimum, '0');
  if (grouped) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (sign && !/[1-9]/.test(whole + part)) sign = '';
  let text = '',
    placed = false;
  tokens.forEach((token, index) => {
    if (token.kind === 'text') text += token.text;
    else if (token.kind === 'at') text += generalNumber(value);
    else if (token.kind === 'digit' && !placed && index < integerEnd) {
      text += whole;
      placed = true;
    } else if (token.kind === 'dot') {
      if (!placed) {
        text += whole;
        placed = true;
      }
      text += '.' + part;
    }
  });
  return { text: sign + text, color };
}

// ---------------------------------------------------------------------------------------------
// Formulas. Values are numbers, text, booleans, null (an empty cell), { error }, ranges and
// arrays ({ list }: what an array literal or FILTER and VSTACK give, its values in order).

const ERROR = (code) => ({ error: code });
const isError = (value) => !!value && typeof value === 'object' && 'error' in value;
const isRange = (value) => !!value && typeof value === 'object' && 'rows' in value;
const isList = (value) => !!value && typeof value === 'object' && 'list' in value;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const TOKEN =
  /\s*(?:("(?:[^"]|"")*")|('(?:[^']|'')*'!|[A-Za-z_][A-Za-z0-9_.]*!)?(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)(?![A-Za-z0-9_(])|(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_.]*)(?=\s*\()|([A-Za-z_][A-Za-z0-9_]*)|(<>|<=|>=|[-+*/&=<>(),{};]))/iy;

function tokens(text) {
  const out = [];
  let at = 0;
  while (!/^\s*$/.test(text.slice(at))) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(text);
    if (!match) throw new Error(`Cannot read the formula at "${text.slice(at, at + 20)}"`);
    at = TOKEN.lastIndex;
    if (match[1]) out.push({ kind: 'string', value: match[1].slice(1, -1).replace(/""/g, '"') });
    else if (match[3]) {
      const sheet = match[2] ? match[2].slice(0, -1).replace(/^'([\s\S]*)'$/, '$1').replace(/''/g, "'") : null;
      out.push({ kind: 'ref', sheet, a1: match[3].replace(/\$/g, '') });
    } else if (match[4]) out.push({ kind: 'number', value: Number(match[4]) });
    else if (match[5]) out.push({ kind: 'name', value: match[5].toUpperCase() });
    else if (match[6]) out.push({ kind: 'local', value: match[6].toUpperCase() });
    else out.push({ kind: 'op', value: match[7] });
  }
  return out;
}

function cellOf(a1) {
  const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(a1);
  return { row: Number(digits), column: [...letters].reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0) };
}

function parse(text) {
  const list = tokens(text);
  let at = 0;
  const peek = () => list[at];
  const take = (value) => {
    const token = list[at];
    if (!token || (value !== undefined && token.value !== value)) throw new Error(`Expected ${value} in ${text}`);
    at++;
    return token;
  };
  const binary = (next, ops) => () => {
    let left = next();
    while (peek()?.kind === 'op' && ops.includes(peek().value)) left = { op: take().value, left, right: next() };
    return left;
  };
  const primary = () => {
    const token = take();
    if (token.kind === 'number' || token.kind === 'string') return { value: token.value };
    if (token.kind === 'local') return ['TRUE', 'FALSE'].includes(token.value) ? { value: token.value === 'TRUE' } : { local: token.value };
    if (token.kind === 'ref') {
      const [from, to = from] = token.a1.split(':').map(cellOf);
      return { range: { sheet: token.sheet, row: from.row, column: from.column, rows: to.row - from.row + 1, columns: to.column - from.column + 1 } };
    }
    if (token.kind === 'name') {
      take('(');
      const args = [];
      if (peek()?.value !== ')') do args.push(comparison()); while (peek()?.value === ',' && take(','));
      take(')');
      return { call: token.value, args };
    }
    if (token.value === '(') {
      const inner = comparison();
      take(')');
      return inner;
    }
    if (token.value === '-' || token.value === '+') return { op: token.value === '-' ? 'neg' : 'pos', arg: primary() };
    // An array literal of constants, its rows split by ; and its columns by ,: {"=a";"=b"}.
    if (token.value === '{') {
      const values = [];
      do {
        const item = take();
        if (item.kind !== 'string' && item.kind !== 'number') throw new Error(`The test evaluator reads only constants in an array, in ${text}`);
        values.push(item.value);
      } while ([',', ';'].includes(peek()?.value) && take());
      take('}');
      return { list: values };
    }
    throw new Error(`Unexpected ${token.value} in ${text}`);
  };
  const term = binary(primary, ['*', '/']);
  const sum = binary(term, ['+', '-']);
  const concat = binary(sum, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);
  const tree = comparison();
  if (at !== list.length) throw new Error(`Unread formula text in ${text}`);
  return tree;
}

// The cells of a range, row by row; read(sheet, row, column) gives a cell's shown value. A memo
// (a Map) keeps the cells of every range a tab name qualifies, so formulas evaluated with one memo
// read a large data tab once.
function cells(range, read, memo) {
  const key = range.sheet === null ? null : JSON.stringify(['cells', range.sheet, range.row, range.column, range.rows, range.columns]);
  if (key && memo?.has(key)) return memo.get(key);
  const out = [];
  for (let r = 0; r < range.rows; r++)
    for (let c = 0; c < range.columns; c++) out.push(read(range.sheet, range.row + r, range.column + c));
  if (key && memo) memo.set(key, out);
  return out;
}

// A single value: an array or a range of several cells is #VALUE!, as outside an array function.
function scalar(value, read) {
  if (isList(value)) return ERROR('#VALUE!');
  if (!isRange(value)) return value;
  if (value.rows !== 1 || value.columns !== 1) return ERROR('#VALUE!');
  return read(value.sheet, value.row, value.column);
}

// Whether a value holds several values (an array, or a range of more than one cell), and its
// values in order.
const many = (value) => isList(value) || (isRange(value) && value.rows * value.columns > 1);
const flat = (value, read, memo) => (isList(value) ? value.list : isRange(value) ? cells(value, read, memo) : [value]);

// fn over the values at each position of the arguments that hold several, an argument with one
// value taken at every position: an array, or #VALUE! when their sizes differ.
function each(values, fn, read, memo) {
  const lists = values.map((value) => (many(value) ? flat(value, read, memo) : null));
  const size = lists.find(Boolean).length;
  if (lists.some((list) => list && list.length !== size)) return ERROR('#VALUE!');
  const singles = values.map((value) => scalar(value, read));
  return { list: Array.from({ length: size }, (_, index) => fn(...lists.map((list, at) => (list ? list[index] : singles[at])))) };
}

// Arithmetic takes numbers, numeric text and empty cells (as 0). Other text is #VALUE!, and so
// is "", so a formula that would lean on Sheets coercing an empty string fails here first.
function number(value) {
  if (isError(value)) return value;
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (NUMBER.test(value.trim())) return Number(value);
  return ERROR('#VALUE!');
}

function text(value) {
  if (value === null) return '';
  if (typeof value === 'number') return generalNumber(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
}

// Numbers sort before text and text before booleans, so values of two types are never equal;
// text compares without regard to case; an empty cell equals 0, "" and FALSE.
function compare(op, left, right) {
  const rank = (value) => ({ number: 0, string: 1, boolean: 2 })[typeof value];
  const order = (a, b) => {
    if (rank(a) !== rank(b)) return Math.sign(rank(a) - rank(b));
    if (typeof a !== 'string') return Math.sign(a - b);
    const x = a.toLowerCase(),
      y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const fill = (value, other) => (value !== null ? value : typeof other === 'number' ? 0 : typeof other === 'boolean' ? false : '');
  const sign = order(fill(left, right), fill(right, left));
  return { '=': sign === 0, '<>': sign !== 0, '<': sign < 0, '>': sign > 0, '<=': sign <= 0, '>=': sign >= 0 }[op];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const daySerial = (year, month, day) => (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000;

// What Sheets reads a criterion's operand as, like text typed into a cell: a number, also from a
// percentage, an amount, a date or a time ("50%", "$5", "2026-09", "1/2", "Sep 2026", "10:00"),
// a boolean, or else text. A day without a year falls in the sandbox's year, 2026.
function operandValue(operand) {
  const text = operand.trim();
  let match;
  if (NUMBER.test(text)) return Number(text);
  if (/^(true|false)$/i.test(text)) return text.toUpperCase() === 'TRUE';
  if ((match = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(text))) return Number(match[1]) / 100;
  if ((match = /^[$€£¥]([+-]?(?:\d+\.?\d*|\.\d+))$/.exec(text))) return Number(match[1]);
  if ((match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text))) return daySerial(+match[1], +match[2], +(match[3] || 1));
  if ((match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text))) return daySerial(+(match[3] || 2026), +match[1], +match[2]);
  if ((match = /^([a-z]{3})[a-z]* (\d{4})$/i.exec(text)) && MONTHS.includes(match[1].toLowerCase()))
    return daySerial(+match[2], MONTHS.indexOf(match[1].toLowerCase()) + 1, 1);
  if ((match = /^(\d{1,2}):(\d{2})$/.exec(text))) return (+match[1] * 60 + +match[2]) / 1440;
  return operand;
}

// A criterion of the IFS functions: an optional operator, then an operand Sheets reads as a
// number, a boolean or text (operandValue). A number compares with numbers only, a boolean with
// booleans. Text after =, <> or nothing matches whole cells of text with * and ? wildcards (~
// escapes them) without regard to case. An empty operand matches blank cells.
function matcher(criterion) {
  if (typeof criterion === 'number') return (cell) => cell === criterion;
  const [, op = '', operand] = /^(<>|<=|>=|<|>|=)?([\s\S]*)$/.exec(String(criterion));
  // An error literal or a second operator may read as something other than text.
  if (/^\s*[<>=#]/.test(operand)) throw new Error(`The test evaluator does not know how Sheets reads the criterion ${criterion}`);
  const blank = (cell) => cell === null || cell === '';
  if (operand === '') return op === '<>' ? (cell) => !blank(cell) : blank;
  const goal = operandValue(operand);
  if (typeof goal === 'number')
    return (cell) => (typeof cell === 'number' ? compare(op || '=', cell, goal) : op === '<>');
  if (!['', '=', '<>'].includes(op)) throw new Error(`The test evaluator does not compare text with ${op}`);
  if (typeof goal === 'boolean') return (cell) => (cell === goal) !== (op === '<>');
  const escape = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let source = '';
  for (let i = 0; i < operand.length; i++) {
    const ch = operand[i];
    if (ch === '~' && i + 1 < operand.length) source += escape(operand[++i]);
    else source += ch === '*' ? '[\\s\\S]*' : ch === '?' ? '[\\s\\S]' : escape(ch);
  }
  const pattern = new RegExp('^' + source + '$', 'i');
  const equal = (cell) => typeof cell === 'string' && pattern.test(cell);
  return op === '<>' ? (cell) => !equal(cell) : equal;
}

// The cells of a range one criterion keeps: a mask by position and the list of kept positions,
// indexed in the memo by range and criterion.
function matched(range, criterion, read, memo) {
  const key = range.sheet === null ? null : JSON.stringify(['match', range.sheet, range.row, range.column, range.rows, range.columns, typeof criterion, criterion]);
  if (key && memo?.has(key)) return memo.get(key);
  const test = matcher(criterion),
    list = cells(range, read, memo),
    mask = new Uint8Array(list.length),
    positions = [];
  list.forEach((cell, index) => {
    if (!test(cell)) return;
    mask[index] = 1;
    positions.push(index);
  });
  const found = { mask, positions };
  if (key && memo) memo.set(key, found);
  return found;
}

// The positions of the ranges every criterion pair from args[first] on keeps, in order; null when
// the ranges differ in size (#VALUE! in Sheets).
function kept(args, first, read, memo) {
  const found = [];
  for (let i = first; i < args.length; i += 2) found.push(matched(args[i], scalar(args[i + 1], read), read, memo));
  if (found.some((item) => item.mask.length !== found[0].mask.length)) return null;
  const fewest = found.reduce((least, item) => (item.positions.length < least.positions.length ? item : least));
  return fewest.positions.filter((index) => found.every((item) => item.mask[index]));
}

const numbers = (list) => list.filter((value) => typeof value === 'number');
const distinct = (list) => new Set(list.filter((value) => value !== null && value !== '').map((value) => typeof value + ':' + value)).size;

// A SUMIFS, MINIFS, MAXIFS, COUNTUNIQUEIFS or COUNTIFS over single criteria.
function ifs(name, args, read, memo) {
  if (name === 'COUNTIFS') {
    const keep = kept(args, 0, read, memo);
    return keep ? keep.length : ERROR('#VALUE!');
  }
  const keep = kept(args, 1, read, memo),
    values = cells(args[0], read, memo);
  if (!keep || values.length !== cells(args[1], read, memo).length) return ERROR('#VALUE!');
  const list = keep.map((index) => values[index]);
  if (name === 'COUNTUNIQUEIFS') return distinct(list);
  const found = numbers(list);
  if (name === 'SUMIFS') return found.reduce((sum, value) => sum + value, 0);
  return found.length ? Math[name === 'MINIFS' ? 'min' : 'max'](...found) : 0;
}

// What a TEXT pattern prints: the number patterns of formatNumber, or a date as yyyy-mm-dd.
function textPattern(value, pattern) {
  if (/[dmy]/i.test(pattern.replace(/"[^"]*"/g, ''))) {
    if (pattern !== 'yyyy-mm-dd') throw new Error(`The test evaluator does not know the pattern ${pattern}`);
    return serialDate(value);
  }
  return formatNumber(value, pattern).text;
}

// Functions that read their arguments as arrays: operators and the text functions inside them
// work position by position, as they do in Sheets.
const ARRAY_FUNCTIONS = ['SUMPRODUCT', 'FILTER'];

function call(name, nodes, read, evaluate, memo, arrays) {
  if (name === 'IFERROR') {
    const value = scalar(evaluate(nodes[0]), read);
    return isError(value) ? scalar(evaluate(nodes[1]), read) : value;
  }
  // Inside an array function IF picks position by position.
  if (name === 'IF' && arrays) {
    const args = nodes.map(evaluate);
    if (args.some(many))
      return each(
        args,
        (test, yes, no = false) => {
          if (typeof test === 'string') throw new Error('IF takes a logical test');
          return isError(test) ? test : test ? yes : no;
        },
        read,
        memo
      );
  }
  if (name === 'IF') {
    const test = scalar(evaluate(nodes[0]), read);
    if (isError(test)) return test;
    if (typeof test === 'string') throw new Error('IF takes a logical test');
    return test ? scalar(evaluate(nodes[1]), read) : nodes.length > 2 ? scalar(evaluate(nodes[2]), read) : false;
  }
  const args = nodes.map(evaluate);
  // A function of single values, by position over arrays inside an array function.
  const byValue = (fn) => (arrays && args.some(many) ? each(args, fn, read, memo) : fn(...args.map((value) => scalar(value, read))));
  const pure = (fn) => byValue((...values) => values.find(isError) || fn(...values));
  if (name === 'ISNUMBER') return byValue((value) => typeof value === 'number');
  if (name === 'ISTEXT') return byValue((value) => typeof value === 'string');
  if (name === 'ISLOGICAL') return byValue((value) => typeof value === 'boolean');
  const failed = args.find((value) => !isRange(value) && isError(value));
  if (failed) return failed;
  const one = (index) => number(scalar(args[index], read));
  switch (name) {
    case 'NA':
      return ERROR('#N/A');
    case 'LOWER':
      return pure((value) => text(value).toLowerCase());
    case 'EXACT':
      return pure((a, b) => text(a) === text(b));
    case 'FIND':
      return pure((part, whole) => {
        const at = text(whole).indexOf(text(part));
        return at < 0 ? ERROR('#VALUE!') : at + 1;
      });
    case 'SUMPRODUCT': {
      // Values that are not numbers count as 0.
      const lists = args.map((value) => flat(value, read, memo));
      if (lists.some((list) => list.length !== lists[0].length)) return ERROR('#VALUE!');
      let total = 0;
      for (let index = 0; index < lists[0].length; index++) {
        let product = 1;
        for (const list of lists) {
          if (isError(list[index])) return list[index];
          product *= typeof list[index] === 'number' ? list[index] : 0;
        }
        total += product;
      }
      return total;
    }
    case 'FILTER': {
      const values = flat(args[0], read, memo),
        tests = args.slice(1).map((value) => flat(value, read, memo));
      if (tests.some((list) => list.length !== values.length)) return ERROR('#VALUE!');
      const keep = values.filter((_, index) =>
        tests.every((list) => {
          const value = list[index];
          if (typeof value !== 'number' && typeof value !== 'boolean') throw new Error('FILTER takes conditions of TRUE, FALSE or numbers');
          return !!value;
        })
      );
      return keep.length ? { list: keep } : ERROR('#N/A');
    }
    case 'VSTACK':
      return { list: args.flatMap((value) => flat(value, read, memo)) };
    case 'SUM':
    case 'MIN':
    case 'MAX': {
      const list = args.flatMap((value) => (many(value) ? numbers(flat(value, read, memo)) : [number(scalar(value, read))]));
      if (list.some(isError)) return list.find(isError);
      if (name === 'SUM') return list.reduce((sum, value) => sum + value, 0);
      return list.length ? Math[name.toLowerCase()](...list) : 0;
    }
    case 'ABS':
      return isError(one(0)) ? one(0) : Math.abs(one(0));
    case 'ROUND': {
      const value = one(0),
        scale = 10 ** (args.length > 1 ? one(1) : 0);
      if (isError(value)) return value;
      return (Math.sign(value) * Math.round(Number((Math.abs(value) * scale).toPrecision(15)))) / scale;
    }
    case 'AND':
      return args.every((value) => !!scalar(value, read));
    case 'OR':
      return args.some((value) => !!scalar(value, read));
    case 'TEXT':
      return pure((value, pattern) => {
        const amount = number(value);
        return isError(amount) ? amount : textPattern(amount, text(pattern));
      });
    case 'COUNTIFS':
    case 'SUMIFS':
    case 'MINIFS':
    case 'MAXIFS':
    case 'COUNTUNIQUEIFS': {
      // An array criterion gives one result per criterion, inside SUMPRODUCT, which adds them up.
      const first = name === 'COUNTIFS' ? 0 : 1;
      const listed = args.map((value, index) => (index > first && (index - first) % 2 && isList(value) ? index : -1)).filter((index) => index >= 0);
      if (!listed.length) return ifs(name, args, read, memo);
      if (!arrays) throw new Error('The test evaluator reads an array criterion only inside SUMPRODUCT');
      if (listed.length > 1 || !['SUMIFS', 'COUNTIFS'].includes(name)) throw new Error('The test evaluator takes one array criterion, in SUMIFS or COUNTIFS');
      return { list: args[listed[0]].list.map((criterion) => ifs(name, args.map((value, index) => (index === listed[0] ? criterion : value)), read, memo)) };
    }
    case 'COUNTUNIQUE':
      return distinct(args.flatMap((value) => flat(value, read, memo)));
  }
  throw new Error(`The test evaluator does not know ${name}`);
}

// An operator over single values: -x, +x, &, a comparison or arithmetic.
function operate(op, left, right) {
  if (op === 'neg' || op === 'pos') {
    const value = number(left);
    return isError(value) || op === 'pos' ? value : -value;
  }
  if (isError(left)) return left;
  if (isError(right)) return right;
  if (op === '&') return text(left) + text(right);
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compare(op, left, right);
  const a = number(left),
    b = number(right);
  if (isError(a)) return a;
  if (isError(b)) return b;
  if (op === '/') return b === 0 ? ERROR('#DIV/0!') : a / b;
  return op === '+' ? a + b : op === '-' ? a - b : a * b;
}

// Evaluates "=..." with read(sheet, row, column) giving the shown value of any cell it reads (sheet
// is null for the formula's own tab). Returns a number, text, boolean or { error }. Formulas
// evaluated with one memo share their range reads, so nothing may change cells meanwhile.
export function evaluateFormula(formula, read, memo) {
  // The names LET binds, innermost last.
  let names = new Map();
  const evaluate = (node) => {
    if ('value' in node) return node.value;
    if (node.local) {
      if (!names.has(node.local)) throw new Error(`The formula names nothing called ${node.local}`);
      return names.get(node.local);
    }
    if (node.range) return node.range;
    if (node.call === 'LET') {
      const outer = names;
      names = new Map(names);
      try {
        for (let i = 0; i + 1 < node.args.length; i += 2) {
          if (!node.args[i].local) throw new Error('LET takes a name, then its value');
          names.set(node.args[i].local, evaluate(node.args[i + 1]));
        }
        return evaluate(node.args.at(-1));
      } finally {
        names = outer;
      }
    }
    if (node.list) return node;
    if (node.call) {
      const array = ARRAY_FUNCTIONS.includes(node.call);
      if (array) depth++;
      try {
        return call(node.call, node.args, read, evaluate, memo, depth > 0);
      } finally {
        if (array) depth--;
      }
    }
    // Inside an array function an operator works position by position over arrays and ranges.
    const values = node.op === 'neg' || node.op === 'pos' ? [evaluate(node.arg)] : [evaluate(node.left), evaluate(node.right)];
    if (depth > 0 && values.some(many)) return each(values, (...items) => operate(node.op, ...items), read, memo);
    return operate(node.op, ...values.map((value) => scalar(value, read)));
  };
  // How many array functions the node being evaluated sits in.
  let depth = 0;
  const value = scalar(evaluate(parse(String(formula).replace(/^=/, ''))), read);
  return value === null ? 0 : value;
}

// A date serial (days since 1899-12-30) as yyyy-mm-dd.
export function serialDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000)).toISOString().slice(0, 10);
}

// The text a cell shows for its value and its userEnteredFormat.numberFormat.
export function shownText(value, numberFormat) {
  if (value === null || value === undefined || value === '') return '';
  if (isError(value)) return value.error;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'number') return String(value);
  if (numberFormat?.type === 'DATE') return serialDate(value);
  const pattern = numberFormat?.pattern || { NUMBER: '#,##0.00', PERCENT: '0.00%' }[numberFormat?.type];
  return !pattern || pattern === '@' ? generalNumber(value) : formatNumber(value, pattern).text;
}
