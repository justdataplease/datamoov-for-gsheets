/* Calculated metrics ("formulas"): arithmetic over per-group sums, evaluated after aggregation
   like ratios. A small hand-written tokenizer and recursive-descent parser builds a tree that is
   walked directly; expressions never become code. */
var DMV_FORMULAS = {
  maxChars: 300,
  maxTokens: 60,
  maxDepth: 12,
  maxFormulas: 10,
  functions: { abs: [1, 1], min: [2, Infinity], max: [2, Infinity], round: [1, 2] },
};

function dmvFormulaHas_(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

// After an unknown column, what a metric's key (column__agg) in a formula should be: a formula
// sums each column itself, so the summed column is named bare; other aggregates are metrics, and
// a count is what a ratio divides by.
function dmvFormulaKeyHint_(name, summable) {
  var parts = /^(.+?)__(sum|avg|min|max|count_distinct|count)$/i.exec(String(name));
  if (!parts) return '';
  var stem = dmvNameMatches_(parts[1], summable, function (key) {
    return [key];
  });
  if (parts[2].toLowerCase() === 'sum')
    return stem.length === 1 ? '; a formula sums each column itself, so write ' + stem[0] : '';
  var agg = parts[2].toLowerCase();
  return (
    '; a formula reads summed columns only: a count, average, minimum or maximum is a metric of its own' +
    (agg === 'count' || agg === 'count_distinct'
      ? '; to divide by a count, use a ratio with denominator ' + parts[1] + '__' + agg
      : '')
  );
}

function dmvFormulaError_(problem, position, hint) {
  var error = new Error(problem + ' at position ' + position + (hint ? '; ' + hint : ''));
  error.position = position;
  return error;
}

// Tokens carry their 1-based position so every error can point at the character it is about.
function dmvFormulaTokens_(expression) {
  var tokens = [],
    index = 0;
  while (index < expression.length) {
    var char = expression.charAt(index),
      rest = expression.slice(index),
      match;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if ((match = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(rest))) {
      if (/^[A-Za-z0-9_.]/.test(rest.slice(match[0].length)))
        throw dmvFormulaError_('malformed number', index + 1);
      if (!isFinite(Number(match[0]))) throw dmvFormulaError_('the number is too large', index + 1);
      tokens.push({ kind: 'number', text: match[0], value: Number(match[0]), position: index + 1 });
    } else if ((match = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*/.exec(rest))) {
      if (rest.charAt(match[0].length) === '.')
        throw dmvFormulaError_('malformed name "' + match[0] + '."', index + 1);
      tokens.push({ kind: 'name', text: match[0], position: index + 1 });
    } else if ('+-*/(),'.indexOf(char) >= 0) {
      tokens.push({ kind: char, text: char, position: index + 1 });
      match = [char];
    } else {
      throw dmvFormulaError_('unexpected character "' + char + '"', index + 1);
    }
    if (tokens.length > DMV_FORMULAS.maxTokens)
      throw dmvFormulaError_(
        'too many parts (at most ' + DMV_FORMULAS.maxTokens + ' numbers, names and symbols)',
        index + 1
      );
    index += match[0].length;
  }
  return tokens;
}

/** Parses one expression into a tree of num, ref, neg, bin and call nodes; throws with a position. */
function dmvFormulaParse_(expression) {
  if (typeof expression !== 'string' || !expression.trim())
    throw dmvFormulaError_('the expression is empty', 1);
  if (expression.length > DMV_FORMULAS.maxChars)
    throw dmvFormulaError_(
      'the expression is longer than ' + DMV_FORMULAS.maxChars + ' characters',
      DMV_FORMULAS.maxChars + 1
    );
  var tokens = dmvFormulaTokens_(expression),
    at = 0,
    depth = 0,
    end = expression.length + 1;
  function peek() {
    return tokens[at] || { kind: 'end', text: '', position: end };
  }
  function nest(position) {
    if (++depth > DMV_FORMULAS.maxDepth)
      throw dmvFormulaError_(
        'nesting deeper than ' + DMV_FORMULAS.maxDepth + ' levels of parentheses or functions',
        position
      );
  }
  function close(open) {
    var token = peek();
    if (token.kind === ')') {
      at++;
      depth--;
      return;
    }
    if (token.kind === 'end')
      throw dmvFormulaError_(
        'unbalanced parenthesis: "(" at position ' + open.position + ' is never closed',
        token.position
      );
    throw dmvFormulaError_('expected ")" but found "' + token.text + '"', token.position);
  }
  function primary() {
    var token = peek();
    if (token.kind === 'number') {
      at++;
      return { type: 'num', value: token.value, position: token.position };
    }
    if (token.kind === '(') {
      at++;
      nest(token.position);
      var inner = sum();
      close(token);
      return inner;
    }
    if (token.kind === 'name') {
      at++;
      if (peek().kind !== '(') return { type: 'ref', name: token.text, position: token.position };
      var name = token.text.toLowerCase();
      if (!dmvFormulaHas_(DMV_FORMULAS.functions, name))
        throw dmvFormulaError_(
          'unknown function "' + token.text + '"',
          token.position,
          'use abs, min, max or round'
        );
      var open = peek();
      at++;
      nest(open.position);
      var args = [sum()];
      while (peek().kind === ',') {
        at++;
        args.push(sum());
      }
      close(open);
      var arity = DMV_FORMULAS.functions[name];
      if (args.length < arity[0] || args.length > arity[1])
        throw dmvFormulaError_(
          name +
            (arity[1] === Infinity
              ? ' takes at least ' + arity[0] + ' arguments'
              : arity[0] === arity[1]
                ? ' takes ' + arity[0] + ' argument'
                : ' takes ' + arity[0] + ' or ' + arity[1] + ' arguments') +
            ', not ' +
            args.length,
          token.position
        );
      if (
        name === 'round' &&
        args[1] &&
        (args[1].type !== 'num' || args[1].value % 1 !== 0 || args[1].value > 6)
      )
        throw dmvFormulaError_('round digits must be a whole number from 0 to 6', args[1].position);
      return { type: 'call', name: name, args: args, position: token.position };
    }
    if (token.kind === 'end')
      throw dmvFormulaError_(
        'the expression ends early; expected a number, a column or "("',
        token.position
      );
    if (token.kind === ')')
      throw dmvFormulaError_(
        depth
          ? 'expected a number, a column or "(" before ")"'
          : 'unbalanced parenthesis: ")" has no opening "("',
        token.position
      );
    throw dmvFormulaError_(
      'expected a number, a column or "(" but found "' + token.text + '"',
      token.position
    );
  }
  function unary() {
    var token = peek();
    if (token.kind !== '-') return primary();
    at++;
    return { type: 'neg', arg: unary(), position: token.position };
  }
  function product() {
    var left = unary();
    while (peek().kind === '*' || peek().kind === '/') {
      var op = tokens[at++];
      left = { type: 'bin', op: op.kind, left: left, right: unary(), position: op.position };
    }
    return left;
  }
  function sum() {
    var left = product();
    while (peek().kind === '+' || peek().kind === '-') {
      var op = tokens[at++];
      left = { type: 'bin', op: op.kind, left: left, right: product(), position: op.position };
    }
    return left;
  }
  var tree = sum();
  var extra = peek();
  if (extra.kind === ')')
    throw dmvFormulaError_('unbalanced parenthesis: ")" has no opening "("', extra.position);
  if (extra.kind !== 'end')
    throw dmvFormulaError_(
      'unexpected "' + extra.text + '" after the end of the expression',
      extra.position
    );
  return tree;
}

// A column a formula may reference: numeric and additive, unless the caller says otherwise.
function dmvFormulaSummable_(column) {
  if (typeof column.summable === 'boolean') return column.summable;
  return dmvChatNumeric_(column) && dmvChatAdditive_(column);
}

/**
 * Validates formulas against a result's columns and the request's ratios, in order.
 * columns: [{ key, type, label?, additive?, summable? }]; ratios: [{ key, type, numerator?,
 * denominator? }] with type currency, number or percent. Returns one entry per formula:
 * { key, label, expression, percent, type, tree, columns, ratios, formulas, sums, money } where
 * sums lists every column key whose per-group sum the formula needs (through ratios and earlier
 * formulas too) and money says whether any of them is an amount of money.
 */
function dmvFormulaCompile_(formulas, columns, ratios) {
  if (formulas === undefined || formulas === null) return [];
  if (!Array.isArray(formulas)) throw new Error('formulas must be a list.');
  if (formulas.length > DMV_FORMULAS.maxFormulas)
    throw new Error('Choose at most ' + DMV_FORMULAS.maxFormulas + ' formulas.');
  var columnMap = Object.create(null),
    ratioMap = Object.create(null),
    formulaMap = Object.create(null),
    pending = Object.create(null),
    summable = [];
  (columns || []).forEach(function (column) {
    var lower = column.key.toLowerCase();
    if (!dmvFormulaHas_(columnMap, lower) || column.key === lower) columnMap[lower] = column;
    if (dmvFormulaSummable_(column)) summable.push(column.key);
  });
  (ratios || []).forEach(function (ratio) {
    ratioMap[ratio.key.toLowerCase()] = ratio;
  });
  formulas.forEach(function (formula) {
    if (
      !formula ||
      typeof formula !== 'object' ||
      typeof formula.key !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(formula.key)
    )
      throw new Error(
        'Each formula needs a short key (a letter, then letters, digits or underscores) and an expression.'
      );
    var lower = formula.key.toLowerCase();
    if (
      lower === 'source' ||
      lower === 'currency' ||
      dmvFormulaHas_(columnMap, lower) ||
      dmvFormulaHas_(ratioMap, lower) ||
      dmvFormulaHas_(pending, lower)
    )
      throw new Error(
        'Formula key "' +
          formula.key +
          '" is already a column, ratio or formula name; choose a different key.'
      );
    pending[lower] = true;
  });
  var compiled = [];
  formulas.forEach(function (formula) {
    var prefix = 'Formula "' + formula.key + '": ';
    var own = formula.key.toLowerCase();
    var entry = {
      key: formula.key,
      label:
        typeof formula.label === 'string' && formula.label
          ? formula.label.slice(0, 80)
          : formula.key,
      expression: formula.expression,
      percent: formula.percent === true,
      columns: [],
      ratios: [],
      formulas: [],
      sums: [],
      money: false,
    };
    var addSum = function (key) {
      if (entry.sums.indexOf(key) < 0) entry.sums.push(key);
      var column = columnMap[key.toLowerCase()];
      if (column && column.type === 'currency') entry.money = true;
    };
    var unit = function (node) {
      if (node.type === 'num') return 'literal';
      if (node.type === 'ref') {
        var lower = node.name.toLowerCase();
        if (lower === own) throw dmvFormulaError_('refers to itself', node.position);
        if (dmvFormulaHas_(formulaMap, lower)) {
          var earlier = formulaMap[lower];
          node.key = earlier.key;
          if (entry.formulas.indexOf(earlier.key) < 0) entry.formulas.push(earlier.key);
          earlier.sums.forEach(addSum);
          if (earlier.money) entry.money = true;
          return earlier.type === 'currency' ? 'money' : 'plain';
        }
        if (dmvFormulaHas_(pending, lower))
          throw dmvFormulaError_(
            'refers to formula "' + node.name + '", which comes later; list it before this one',
            node.position
          );
        if (dmvFormulaHas_(ratioMap, lower)) {
          if (dmvFormulaHas_(columnMap, lower))
            throw dmvFormulaError_(
              '"' + node.name + '" is both a column and a ratio key; rename the ratio',
              node.position
            );
          var ratio = ratioMap[lower];
          node.key = ratio.key;
          if (entry.ratios.indexOf(ratio.key) < 0) entry.ratios.push(ratio.key);
          [ratio.numerator, ratio.denominator].forEach(function (part) {
            if (typeof part === 'string' && dmvFormulaHas_(columnMap, part.toLowerCase()))
              addSum(columnMap[part.toLowerCase()].key);
          });
          return ratio.type === 'currency' ? 'money' : 'plain';
        }
        if (!dmvFormulaHas_(columnMap, lower))
          throw dmvFormulaError_(
            'unknown column "' + node.name + '"',
            node.position,
            (summable.length
              ? 'summable columns are ' + summable.join(', ')
              : 'this result has no summable columns') + dmvFormulaKeyHint_(node.name, summable)
          );
        var column = columnMap[lower];
        if (!dmvFormulaSummable_(column))
          throw dmvFormulaError_(
            'column "' +
              column.key +
              '" is not summable (a rate, average or text column); use the counts or amounts it comes from',
            node.position
          );
        node.key = column.key;
        if (entry.columns.indexOf(column.key) < 0) entry.columns.push(column.key);
        addSum(column.key);
        return column.type === 'currency' ? 'money' : 'plain';
      }
      if (node.type === 'neg') return unit(node.arg);
      if (node.type === 'call') {
        var units = node.args.map(unit);
        if (node.name === 'round' || node.name === 'abs') return units[0];
        return units.reduce(function (left, right) {
          if (left === right || right === 'literal') return left;
          if (left === 'literal') return right;
          throw dmvFormulaError_(
            node.name + ' compares money with a non-money column',
            node.position
          );
        });
      }
      var left = unit(node.left),
        right = unit(node.right);
      if (node.op === '+' || node.op === '-') {
        if (left === right || right === 'literal') return left;
        if (left === 'literal') return right;
        throw dmvFormulaError_('"' + node.op + '" adds money to a non-money column', node.position);
      }
      if (node.op === '*') {
        if (left === 'money' && right === 'money')
          throw dmvFormulaError_('"*" multiplies two amounts of money', node.position);
        if (left === 'money' || right === 'money') return 'money';
        return left === 'literal' ? right : left;
      }
      if (left === 'money') return right === 'money' ? 'plain' : 'money';
      if (right === 'money') return 'plain';
      return left === 'literal' ? right : left;
    };
    var result;
    try {
      entry.tree = dmvFormulaParse_(formula.expression);
      result = unit(entry.tree);
    } catch (error) {
      throw new Error(prefix + error.message + '.');
    }
    if (result === 'literal')
      throw new Error(prefix + 'it references no column; use a column, ratio or earlier formula.');
    if (result === 'money' && entry.percent)
      throw new Error(prefix + 'the result is an amount of money, so it cannot be a percent.');
    entry.type = result === 'money' ? 'currency' : entry.percent ? 'percent' : 'number';
    formulaMap[own] = entry;
    compiled.push(entry);
  });
  return compiled;
}

// The 15-digit correction only fits values with room for it: from 1e15 on it would drop real
// digits, and from 2^53 on there is nothing left to round (and scaling could overflow).
function dmvFormulaRoundTo_(value, digits) {
  var scale = Math.pow(10, digits),
    raw = Math.abs(value) * scale;
  if (!(raw < 9007199254740992)) return value;
  var scaled = raw < 1e15 ? Number(raw.toPrecision(15)) : raw;
  return ((value < 0 ? -1 : 1) * Math.round(scaled)) / scale;
}

function dmvFormulaNode_(node, values) {
  var value;
  if (node.type === 'num') return node.value;
  if (node.type === 'ref') {
    if (!dmvFormulaHas_(values, node.key)) return null;
    value = values[node.key];
    return typeof value === 'number' && isFinite(value) ? value : null;
  }
  if (node.type === 'neg') {
    value = dmvFormulaNode_(node.arg, values);
    return value === null ? null : -value;
  }
  if (node.type === 'call') {
    var args = [];
    for (var index = 0; index < node.args.length; index++) {
      value = dmvFormulaNode_(node.args[index], values);
      if (value === null) return null;
      args.push(value);
    }
    if (node.name === 'abs') return Math.abs(args[0]);
    if (node.name === 'min') return Math.min.apply(null, args);
    if (node.name === 'max') return Math.max.apply(null, args);
    return dmvFormulaRoundTo_(args[0], args.length > 1 ? args[1] : 0);
  }
  var left = dmvFormulaNode_(node.left, values);
  if (left === null) return null;
  var right = dmvFormulaNode_(node.right, values);
  if (right === null) return null;
  if (node.op === '+') value = left + right;
  else if (node.op === '-') value = left - right;
  else if (node.op === '*') value = left * right;
  else value = right === 0 ? null : left / right;
  return value !== null && isFinite(value) ? value : null;
}

/**
 * One compiled formula over a map of values keyed by column key (the group's sum), ratio key and
 * earlier formula key. A missing or blank value, a division by zero or a result that is not
 * finite gives null. The result is not rounded.
 */
function dmvFormulaEvaluate_(compiled, values) {
  var value = dmvFormulaNode_(compiled.tree, values || Object.create(null));
  return value !== null && isFinite(value) ? value : null;
}

/** Every compiled formula in order over one group; returns a map of formula key to value. */
function dmvFormulaEvaluateAll_(compiled, values) {
  var scope = Object.create(null),
    out = Object.create(null);
  Object.keys(values || {}).forEach(function (key) {
    scope[key] = values[key];
  });
  compiled.forEach(function (formula) {
    out[formula.key] = scope[formula.key] = dmvFormulaEvaluate_(formula, scope);
  });
  return out;
}
