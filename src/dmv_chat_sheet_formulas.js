/* Analyst formulas for set_formulas, and the read-only search_sheets tool.

   set_formulas accepts every Google Sheets built-in function except the denied ones below:
   nesting, LET and LAMBDA with its helpers, array literals, references to other tabs of this
   spreadsheet, whole and open ranges (A:A, 2:2, A2:A), named ranges of this spreadsheet and
   formulas up to 8,000 characters. A function that is not a built-in (custom, Apps Script and
   named functions) is refused by name, and a LET or LAMBDA name is called only when it is set
   to LAMBDA(...) and named unlike any built-in. Text inside string literals is data: a QUERY
   string that says IMPORTRANGE is not a call. When the size of a formula's result can be worked
   out from the formula alone (an array literal, a bounded range, SEQUENCE or MAKEARRAY with
   literal sizes, TRANSPOSE or ARRAYFORMULA over those), its spill area is guarded, kept for undo
   and refused when it holds data; other array results are left to Sheets, which never spills
   over data and shows #REF! instead, and the read-back reports it.

   dmvChatSheetFormulaCheck_(session, formula, options) is the same policy for one formula, for
   other formulas chat writes, such as custom conditional-format rules: it throws a message
   naming the problem, or returns { shape, functions, names, tabs }. options: sheet (the tab the
   formula belongs to), cell (a label for messages, such as "D2"), otherTabs (false refuses
   references to other tabs, as conditional formats need) and cache (an object shared across
   calls, so named ranges are read once). */
var DMV_FORMULA = {
  maxLength: 8000,
  maxDepth: 100,
  // Exact spills larger than this are left to Sheets rather than read for undo.
  maxSpillCells: 50000,
  // After writing, the window read below and right of the range when a result size is unknown.
  probeRows: 20,
  probeColumns: 8,
  maxErrors: 10,
  maxSamples: 8,
  maxSpills: 5,
};

// Refused anywhere outside string literals, as a call or a name: each reaches outside this
// spreadsheet or builds references chat cannot check.
var DMV_FORMULA_DENIED = {
  IMPORTRANGE: 'it reads another spreadsheet',
  IMPORTDATA: 'it fetches data from the web',
  IMPORTHTML: 'it fetches data from the web',
  IMPORTXML: 'it fetches data from the web',
  IMPORTFEED: 'it fetches data from the web',
  IMAGE: 'it loads an image from the web',
  GOOGLEFINANCE: 'it fetches market data from Google Finance',
  GOOGLETRANSLATE: 'it sends cell text to Google Translate',
  DETECTLANGUAGE: 'it sends cell text to a language service',
  INDIRECT: 'it builds references from text, which chat cannot check',
  AI: 'it sends cell contents to an AI model',
};

// Google Sheets built-in functions (support.google.com/docs/table/25273) except the denied ones.
// Keep in step when Sheets adds functions; an unlisted one is refused by name until then.
var DMV_FORMULA_BUILTINS = [
  // Array
  'ARRAY_CONSTRAIN BYCOL BYROW CHOOSECOLS CHOOSEROWS FLATTEN FREQUENCY GROWTH HSTACK LINEST LOGEST MAKEARRAY MAP MDETERM MINVERSE MMULT REDUCE SCAN SUMPRODUCT SUMX2MY2 SUMX2PY2 SUMXMY2 TOCOL TOROW TRANSPOSE TREND VSTACK WRAPCOLS WRAPROWS',
  // Database
  'DAVERAGE DCOUNT DCOUNTA DGET DMAX DMIN DPRODUCT DSTDEV DSTDEVP DSUM DVAR DVARP',
  // Date
  'DATE DATEDIF DATEVALUE DAY DAYS DAYS360 EDATE EOMONTH EPOCHTODATE HOUR ISOWEEKNUM MINUTE MONTH NETWORKDAYS NETWORKDAYS.INTL NOW SECOND TIME TIMEVALUE TODAY WEEKDAY WEEKNUM WORKDAY WORKDAY.INTL YEAR YEARFRAC',
  // Engineering
  'BIN2DEC BIN2HEX BIN2OCT BITAND BITLSHIFT BITOR BITRSHIFT BITXOR COMPLEX DEC2BIN DEC2HEX DEC2OCT DELTA ERF ERF.PRECISE ERFC ERFC.PRECISE GESTEP HEX2BIN HEX2DEC HEX2OCT IMABS IMAGINARY IMARGUMENT IMCONJUGATE IMCOS IMCOSH IMCOT IMCOTH IMCSC IMCSCH IMDIV IMEXP IMLN IMLOG IMLOG10 IMLOG2 IMPOWER IMPRODUCT IMREAL IMSEC IMSECH IMSIN IMSINH IMSQRT IMSUB IMSUM IMTAN IMTANH OCT2BIN OCT2DEC OCT2HEX',
  // Filter
  'FILTER SORT SORTN UNIQUE',
  // Financial
  'ACCRINT ACCRINTM AMORLINC COUPDAYBS COUPDAYS COUPDAYSNC COUPNCD COUPNUM COUPPCD CUMIPMT CUMPRINC DB DDB DISC DOLLARDE DOLLARFR DURATION EFFECT FV FVSCHEDULE INTRATE IPMT IRR ISPMT MDURATION MIRR NOMINAL NPER NPV PDURATION PMT PPMT PRICE PRICEDISC PRICEMAT PV RATE RECEIVED RRI SLN SYD TBILLEQ TBILLPRICE TBILLYIELD VDB XIRR XNPV YIELD YIELDDISC YIELDMAT',
  // Google
  'ARRAYFORMULA QUERY SPARKLINE',
  // Info
  'CELL ERROR.TYPE ISBLANK ISDATE ISEMAIL ISERR ISERROR ISFORMULA ISLOGICAL ISNA ISNONTEXT ISNUMBER ISREF ISTEXT N NA SHEETS TYPE',
  // Logical
  'AND FALSE IF IFERROR IFNA IFS LAMBDA LET NOT OR SWITCH TRUE XOR',
  // Lookup
  'ADDRESS CHOOSE COLUMN COLUMNS FORMULATEXT GETPIVOTDATA HLOOKUP INDEX LOOKUP MATCH OFFSET ROW ROWS SHEET VLOOKUP XLOOKUP XMATCH',
  // Math
  'ABS ACOS ACOSH ACOT ACOTH ASIN ASINH ATAN ATAN2 ATANH BASE CEILING CEILING.MATH CEILING.PRECISE COMBIN COMBINA COS COSH COT COTH COUNTBLANK COUNTIF COUNTIFS COUNTUNIQUE COUNTUNIQUEIFS CSC CSCH DECIMAL DEGREES EVEN EXP FACT FACTDOUBLE FLOOR FLOOR.MATH FLOOR.PRECISE GAMMALN GAMMALN.PRECISE GCD INT ISEVEN ISO.CEILING ISODD LCM LN LOG LOG10 MOD MROUND MULTINOMIAL MUNIT ODD PI POWER PRODUCT QUOTIENT RADIANS RAND RANDARRAY RANDBETWEEN ROUND ROUNDDOWN ROUNDUP SEC SECH SEQUENCE SERIESSUM SIGN SIN SINH SQRT SQRTPI SUBTOTAL SUM SUMIF SUMIFS SUMSQ TAN TANH TRUNC',
  // Operator
  'ADD CONCAT DIVIDE EQ GT GTE ISBETWEEN LT LTE MINUS MULTIPLY NE POW UMINUS UNARY_PERCENT UPLUS',
  // Parser
  'CONVERT TO_DATE TO_DOLLARS TO_PERCENT TO_PURE_NUMBER TO_TEXT',
  // Statistical
  'AVEDEV AVERAGE AVERAGE.WEIGHTED AVERAGEA AVERAGEIF AVERAGEIFS BETA.DIST BETA.INV BETADIST BETAINV BINOM.DIST BINOM.INV BINOMDIST CHIDIST CHIINV CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHITEST CONFIDENCE CONFIDENCE.NORM CONFIDENCE.T CORREL COUNT COUNTA COVAR COVARIANCE.P COVARIANCE.S CRITBINOM DEVSQ EXPON.DIST EXPONDIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FDIST FINV FISHER FISHERINV FORECAST FORECAST.LINEAR FTEST GAMMA GAMMA.DIST GAMMA.INV GAMMADIST GAMMAINV GAUSS GEOMEAN HARMEAN HYPGEOM.DIST HYPGEOMDIST INTERCEPT KURT LARGE LOGINV LOGNORM.DIST LOGNORM.INV LOGNORMDIST MARGINOFERROR MAX MAXA MAXIFS MEDIAN MIN MINA MINIFS MODE MODE.MULT MODE.SNGL NEGBINOM.DIST NEGBINOMDIST NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NORMDIST NORMINV NORMSDIST NORMSINV PEARSON PERCENTILE PERCENTILE.EXC PERCENTILE.INC PERCENTRANK PERCENTRANK.EXC PERCENTRANK.INC PERMUT PERMUTATIONA PHI POISSON POISSON.DIST PROB QUARTILE QUARTILE.EXC QUARTILE.INC RANK RANK.AVG RANK.EQ RSQ SKEW SKEW.P SLOPE SMALL STANDARDIZE STDEV STDEV.P STDEV.S STDEVA STDEVP STDEVPA STEYX T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TDIST TINV TRIMMEAN TTEST VAR VAR.P VAR.S VARA VARP VARPA WEIBULL WEIBULL.DIST Z.TEST ZTEST',
  // Text
  'ARABIC ASC CHAR CLEAN CODE CONCATENATE DOLLAR EXACT FIND FINDB FIXED JOIN LEFT LEFTB LEN LENB LOWER MID MIDB PROPER REGEXEXTRACT REGEXMATCH REGEXREPLACE REPLACE REPLACEB REPT RIGHT RIGHTB ROMAN SEARCH SEARCHB SPLIT SUBSTITUTE T TEXT TEXTJOIN TRIM UNICHAR UNICODE UPPER VALUE',
  // Web
  'ENCODEURL HYPERLINK ISURL',
].join(' ');

// Functions whose result can be an array of a size the formula alone does not tell.
var DMV_FORMULA_ARRAYS =
  ' ARRAY_CONSTRAIN BYCOL BYROW CHOOSECOLS CHOOSEROWS FILTER FLATTEN FREQUENCY GROWTH HSTACK INDEX LINEST LOGEST LOOKUP MAKEARRAY MAP MINVERSE MMULT MUNIT OFFSET QUERY RANDARRAY REDUCE REGEXEXTRACT SCAN SEQUENCE SORT SORTN SPLIT TOCOL TOROW TRANSPOSE TREND UNIQUE VSTACK WRAPCOLS WRAPROWS XLOOKUP ';
// Functions that reduce ranges to one value.
var DMV_FORMULA_AGGREGATES =
  ' AND AVERAGE AVERAGE.WEIGHTED AVERAGEA AVERAGEIF AVERAGEIFS COLUMNS CORREL COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS COUNTUNIQUE COUNTUNIQUEIFS COVAR HLOOKUP INTERCEPT JOIN LARGE MATCH MAX MAXA MAXIFS MEDIAN MIN MINA MINIFS MODE OR PEARSON PERCENTILE PRODUCT QUARTILE RANK RANK.AVG RANK.EQ ROWS RSQ SLOPE SMALL STDEV STDEV.P STDEV.S STDEVA STDEVP STDEVPA SUM SUMIF SUMIFS SUMPRODUCT SUMSQ TEXTJOIN VAR VAR.P VAR.S VARA VARP VARPA VLOOKUP XMATCH XOR ';
// Lookups and conditional counts that reduce to one value alone, but inside ARRAYFORMULA give one
// result per key when a key is a range (VLOOKUP(A2:A9, ...), COUNTIF(A:A, A2:A9)).
var DMV_FORMULA_PER_KEY =
  ' AVERAGEIF AVERAGEIFS COUNTIF COUNTIFS HLOOKUP LARGE MATCH MAXIFS MINIFS PERCENTILE QUARTILE RANK RANK.AVG RANK.EQ SMALL SUMIF SUMIFS VLOOKUP XMATCH ';
// Functions that work cell by cell inside ARRAYFORMULA, so the result has the size of their inputs.
var DMV_FORMULA_ELEMENTWISE =
  ' ABS CONCAT DATE DATEVALUE DAY EDATE EOMONTH EXACT IF IFERROR IFNA INT ISBLANK ISERROR ISNA ISNUMBER ISTEXT LEFT LEN LOWER MID MONTH N NOT PROPER REGEXMATCH REGEXREPLACE RIGHT ROUND ROUNDDOWN ROUNDUP SUBSTITUTE TEXT TO_TEXT TRIM UPPER VALUE WEEKDAY YEAR ';

var DMV_FORMULA_ERRORS = {
  ERROR: '#ERROR!',
  NULL_VALUE: '#NULL!',
  DIVIDE_BY_ZERO: '#DIV/0!',
  VALUE: '#VALUE!',
  REF: '#REF!',
  NAME: '#NAME?',
  NUM: '#NUM!',
  N_A: '#N/A',
  LOADING: 'Loading...',
};

var dmvFormulaBuiltinSet_ = null;

function dmvChatFormulaBuiltin_(name) {
  if (!dmvFormulaBuiltinSet_) {
    dmvFormulaBuiltinSet_ = Object.create(null);
    DMV_FORMULA_BUILTINS.split(' ').forEach(function (item) {
      if (item) dmvFormulaBuiltinSet_[item] = true;
    });
  }
  return !!dmvFormulaBuiltinSet_[name];
}

// Splits a formula (after its =) into tokens. References carry their tab and size; a name
// followed by ( is a function, any other name is a LET or LAMBDA name or a named range.
function dmvChatFormulaTokens_(formula, fail) {
  var tokens = [],
    position = 1,
    cell = '\\$?[A-Za-z]{1,3}\\$?[1-9][0-9]{0,6}',
    column = '\\$?[A-Za-z]{1,3}',
    row = '\\$?[1-9][0-9]{0,6}';
  var reference = new RegExp(
    "^(?:('(?:[^']|'')+'|[\\p{L}\\p{N}_.]+)!)?(" +
      [
        cell + '(?::(?:' + cell + '|' + column + '|' + row + '))?',
        column + ':' + column,
        row + ':' + row,
      ].join('|') +
      ')(?![\\p{L}\\p{N}_.!$\\[]|\\s*\\()',
    'u'
  );
  var name = /^[\p{L}_][\p{L}\p{N}_.]*/u;
  while (position < formula.length) {
    var tail = formula.slice(position),
      start = position,
      match;
    if (/^\s/.test(tail)) {
      position++;
      continue;
    }
    var first = tail.charAt(0);
    if (first === '"') {
      match = /^"(?:[^"]|"")*"/.exec(tail);
      if (!match) fail('a text value is missing its closing quote', start);
      tokens.push({ type: 'string', text: match[0], at: start });
    } else if (first === '#') {
      match = /^#(?:N\/A|REF!|NAME\?|DIV\/0!|VALUE!|NUM!|NULL!|ERROR!|GETTING_DATA)/i.exec(tail);
      if (!match) fail('"' + tail.slice(0, 10) + '" is not a Sheets error value', start);
      tokens.push({ type: 'error', text: match[0], at: start });
    } else if ((match = reference.exec(tail))) {
      tokens.push(dmvChatFormulaReference_(match, start, fail));
    } else if ((match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(tail))) {
      tokens.push({ type: 'number', text: match[0], at: start });
    } else if ((match = name.exec(tail))) {
      var after = tail.slice(match[0].length);
      var table = /^\[(?:[^[\]"]|\[[^[\]"]*\])*\]/.exec(after);
      if (/^\s*\(/.test(after)) tokens.push({ type: 'function', text: match[0], at: start });
      else if (table) {
        tokens.push({
          type: 'ref',
          text: match[0] + table[0],
          table: match[0],
          sheet: null,
          shape: null,
          at: start,
        });
        position += table[0].length;
      } else tokens.push({ type: 'name', text: match[0], at: start });
    } else if ((match = /^(?:<>|<=|>=|[-+*/^&=<>%(),;{}:])/.exec(tail))) {
      tokens.push({ type: 'op', text: match[0], at: start });
    } else fail('"' + first + '" is not something Sheets formulas use', start);
    position += match[0].length;
  }
  return tokens;
}

function dmvChatFormulaReference_(match, at, fail) {
  var token = { type: 'ref', text: match[0], at: at, sheet: null, shape: null };
  if (match[1])
    token.sheet = match[1].charAt(0) === "'" ? match[1].slice(1, -1).replace(/''/g, "'") : match[1];
  var parts = match[2].replace(/\$/g, '').toUpperCase().split(':');
  var cells = /^[A-Z]+[0-9]+$/;
  if (cells.test(parts[0]) && (parts.length === 1 || cells.test(parts[1]))) {
    var start, end;
    try {
      start = dmvCell_(parts[0]);
      end = dmvCell_(parts[1] || parts[0]);
    } catch (error) {
      fail(match[2] + ' is outside Google Sheets', at);
    }
    token.shape = {
      rows: Math.abs(end.row - start.row) + 1,
      columns: Math.abs(end.column - start.column) + 1,
    };
  }
  return token;
}

// Checks one formula against the chat formula policy; see the top of this file.
function dmvChatSheetFormulaCheck_(session, formula, options) {
  options = options || {};
  var cache = options.cache || {},
    label = options.cell ? options.cell + ': ' : '';
  function fail(message, at) {
    var where =
      at === undefined
        ? ''
        : ' (at character ' + (at + 1) + ', near "' + formula.slice(at, at + 20) + '")';
    throw new Error(label + message + where + '.');
  }
  if (typeof formula !== 'string' || formula.charAt(0) !== '=')
    throw new Error(label + 'Each formula must be text beginning with =.');
  if (formula.length > DMV_FORMULA.maxLength)
    fail('a formula can be at most ' + DMV_FORMULA.maxLength + ' characters');
  var tokens = dmvChatFormulaTokens_(formula, fail);
  if (!tokens.length) fail('the formula is empty');
  var index = 0,
    depth = 0,
    used = { functions: [], names: [], tabs: [] };
  var SCALAR = { rows: 1, columns: 1 };
  function scalar(shape) {
    return !!shape && shape.rows === 1 && shape.columns === 1;
  }
  function peek() {
    return tokens[index];
  }
  function is(token, text) {
    return !!token && token.type === 'op' && token.text === text;
  }
  function expect(text) {
    var token = tokens[index++];
    if (!is(token, text))
      fail(
        token ? 'expected "' + text + '"' : 'the formula ends early; expected "' + text + '"',
        token ? token.at : undefined
      );
  }
  function deny(token) {
    var upper = token.text.toUpperCase();
    if (DMV_FORMULA_DENIED[upper])
      fail(
        upper +
          ' is not allowed in chat formulas: ' +
          DMV_FORMULA_DENIED[upper] +
          '. Chat formulas stay inside this spreadsheet',
        token.at
      );
    return upper;
  }
  function nest(at) {
    if (++depth > DMV_FORMULA.maxDepth) fail('the formula is nested too deeply', at);
  }
  function combine(left, right, arrays) {
    if (scalar(left) && scalar(right)) return SCALAR;
    if (!arrays || !left || !right) return null;
    if (scalar(left)) return right;
    if (scalar(right) || (left.rows === right.rows && left.columns === right.columns)) return left;
    return null;
  }
  function expression(scope, arrays) {
    var shape = unary(scope, arrays);
    while (
      peek() &&
      peek().type === 'op' &&
      ['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>', '<=', '>=', ':'].indexOf(peek().text) >= 0
    ) {
      var operator = tokens[index++].text;
      var right = unary(scope, arrays);
      shape = operator === ':' ? null : combine(shape, right, arrays);
    }
    return shape;
  }
  function unary(scope, arrays) {
    var token = peek(),
      shape;
    if (is(token, '+') || is(token, '-')) {
      index++;
      nest(token.at);
      shape = unary(scope, arrays);
      depth--;
      return arrays || scalar(shape) ? shape : null;
    }
    shape = primary(scope, arrays);
    while (is(peek(), '%')) {
      index++;
      if (!arrays && !scalar(shape)) shape = null;
    }
    return shape;
  }
  function primary(scope, arrays) {
    var token = tokens[index++],
      shape;
    if (!token) fail('the formula ends early');
    if (token.type === 'string' || token.type === 'number' || token.type === 'error') return SCALAR;
    if (token.type === 'ref') return reference(token);
    if (token.type === 'name') {
      var upper = deny(token);
      if (upper === 'TRUE' || upper === 'FALSE' || scope[upper])
        return scope[upper] ? null : SCALAR;
      if (used.names.indexOf(upper) < 0) used.names.push(upper);
      return null;
    }
    if (token.type === 'function') return invoke(call(token, scope, arrays), scope);
    if (is(token, '(')) {
      nest(token.at);
      shape = expression(scope, arrays);
      expect(')');
      depth--;
      return invoke(shape, scope);
    }
    if (is(token, '{')) return array(token, scope, arrays);
    fail('unexpected "' + token.text + '"', token.at);
  }
  // LAMBDA(x, x + 1)(5) calls the lambda a call or parenthesis returned.
  function invoke(shape, scope) {
    if (!is(peek(), '(')) return shape;
    nest(peek().at);
    index++;
    if (!is(peek(), ')'))
      do {
        expression(scope, false);
      } while (is(peek(), ',') && ++index);
    expect(')');
    depth--;
    return null;
  }
  function reference(token) {
    if (token.sheet !== null) {
      var current = options.sheet ? options.sheet.getName() : null;
      if (options.otherTabs === false && token.sheet !== current)
        fail(
          'this formula can refer only to cells of its own tab' +
            (current ? ' ("' + current + '")' : ''),
          token.at
        );
      if (token.sheet !== current) {
        // Sheets matches tab names in formulas without regard to case.
        cache.tabs = cache.tabs || Object.create(null);
        var key = token.sheet.toLowerCase();
        if (
          !cache.tabs[key] &&
          !session.spreadsheet.getSheets().some(function (sheet) {
            return !dmvChatUndoCopy_(sheet) && sheet.getName().toLowerCase() === key;
          })
        ) {
          try {
            dmvChatSheetTarget_(session, token.sheet);
          } catch (error) {
            fail(String(error.message || error).replace(/\.$/, ''), token.at);
          }
        }
        cache.tabs[key] = true;
        if (used.tabs.indexOf(token.sheet) < 0) used.tabs.push(token.sheet);
      }
    }
    if (token.table) deny({ text: token.table, at: token.at });
    return token.shape;
  }
  function array(open, scope, arrays) {
    nest(open.at);
    var rows = [[]],
      plain = true;
    if (is(peek(), '}')) fail('an array literal needs at least one value', open.at);
    do {
      var shape = expression(scope, arrays);
      if (!scalar(shape)) plain = false;
      rows[rows.length - 1].push(shape);
      var token = tokens[index++];
      if (is(token, ';')) rows.push([]);
      else if (is(token, '}')) break;
      else if (!is(token, ','))
        fail(
          token
            ? 'unexpected "' + token.text + '" in an array literal'
            : 'an array literal is not closed',
          token ? token.at : open.at
        );
    } while (true);
    depth--;
    var width = rows[0].length;
    if (
      !plain ||
      rows.some(function (row) {
        return row.length !== width;
      })
    )
      return null;
    return { rows: rows.length, columns: width };
  }
  // Arguments: { shape, from, to } with the token range, so literal arguments can be read.
  function argumentsOf(scope, arrays) {
    var list = [];
    if (is(peek(), ')')) {
      index++;
      return list;
    }
    do {
      var from = index;
      var shape = is(peek(), ',') || is(peek(), ')') ? SCALAR : expression(scope, arrays);
      list.push({ shape: shape, from: from, to: index });
      var token = tokens[index++];
      if (is(token, ')')) return list;
      if (!is(token, ','))
        fail(
          token ? 'unexpected "' + token.text + '"' : 'a function call is not closed',
          token ? token.at : undefined
        );
    } while (true);
  }
  function literal(argument) {
    var token = argument && argument.to - argument.from === 1 && tokens[argument.from];
    return token && token.type === 'number' ? Number(token.text) : null;
  }
  function call(token, scope, arrays) {
    var upper = deny(token);
    // Whether Sheets runs a bound name's value or a function of that name (a custom function,
    // HYPERLINK) is not documented, so only names that hold a LAMBDA and no function's name are
    // called.
    if (scope[upper] && (scope[upper] !== 'lambda' || dmvChatFormulaBuiltin_(upper)))
      fail(
        token.text +
          '(...) calls a LET or LAMBDA name; only a LET name set to LAMBDA(...) can be called, and not one named like a Sheets function',
        token.at
      );
    if (!scope[upper] && !dmvChatFormulaBuiltin_(upper))
      fail(
        'unknown function ' +
          token.text +
          '. Chat formulas use Google Sheets built-in functions only; custom, Apps Script and named functions are not supported',
        token.at
      );
    if (!scope[upper] && used.functions.indexOf(upper) < 0) used.functions.push(upper);
    nest(token.at);
    expect('(');
    var shape;
    if (scope[upper]) {
      argumentsOf(scope, false);
      shape = null;
    } else if (upper === 'LET') shape = letCall(token, scope, arrays);
    else if (upper === 'LAMBDA') shape = lambdaCall(token, scope);
    else shape = builtin(token, upper, scope, arrays);
    depth--;
    return shape;
  }
  // A bound name holds 'lambda' when its value is exactly LAMBDA(...), so it may be called, or
  // 'value' otherwise.
  function bind(scope, token, kind) {
    var upper = deny(token);
    if (upper === 'TRUE' || upper === 'FALSE') fail(upper + ' cannot be a name', token.at);
    scope[upper] = kind;
  }
  // True when tokens from..to are one LAMBDA(...) and nothing more, not a call of its result.
  function lambdaOnly(from, to) {
    if (!tokens[from] || tokens[from].type !== 'function') return false;
    if (tokens[from].text.toUpperCase() !== 'LAMBDA') return false;
    for (var i = from + 1, open = 0; i < to; i++) {
      if (is(tokens[i], '(')) open++;
      else if (is(tokens[i], ')') && --open === 0) return i === to - 1;
    }
    return false;
  }
  function letCall(token, scope, arrays) {
    var inner = Object.assign(Object.create(null), scope),
      bindings = 0;
    // A name is defined only after its value: inside its own value, NAME(...) is the global
    // function of that name, so the value is checked before the name is bound.
    while (peek() && peek().type === 'name' && is(tokens[index + 1], ',')) {
      var name = tokens[index];
      index += 2;
      var from = index;
      expression(inner, arrays);
      bind(inner, name, lambdaOnly(from, index) ? 'lambda' : 'value');
      expect(',');
      bindings++;
    }
    if (!bindings)
      fail('LET needs names and values before its result, such as LET(x, A1, x * 2)', token.at);
    var shape = expression(inner, arrays);
    expect(')');
    return shape;
  }
  function lambdaCall(token, scope) {
    var inner = Object.assign(Object.create(null), scope);
    while (peek() && peek().type === 'name' && is(tokens[index + 1], ',')) {
      bind(inner, tokens[index], 'value');
      index += 2;
    }
    expression(inner, false);
    expect(')');
    return null;
  }
  function builtin(token, upper, scope, arrays) {
    var list = argumentsOf(scope, arrays || upper === 'ARRAYFORMULA');
    if (upper === 'HYPERLINK') {
      var url = list[0] && list[0].to - list[0].from === 1 && tokens[list[0].from];
      if (!url || url.type !== 'string' || !/^"https:\/\/[^\s"]+"$/i.test(url.text))
        fail(
          'HYPERLINK takes a literal https:// address in chat formulas, such as HYPERLINK("https://example.com", "Label")',
          token.at
        );
    }
    var shapes = list.map(function (argument) {
      return argument.shape;
    });
    if (upper === 'ARRAYFORMULA') return list.length === 1 ? shapes[0] : null;
    if (upper === 'TRANSPOSE')
      return shapes[0] && list.length === 1
        ? { rows: shapes[0].columns, columns: shapes[0].rows }
        : null;
    if (upper === 'SEQUENCE' || upper === 'MAKEARRAY') {
      var rows = literal(list[0]),
        columns =
          list.length > 1 && !(upper === 'SEQUENCE' && list[1].to === list[1].from)
            ? literal(list[1])
            : 1;
      return Number.isInteger(rows) && Number.isInteger(columns) && rows > 0 && columns > 0
        ? { rows: rows, columns: columns }
        : null;
    }
    // Their size then is not known here, so the result is probed after writing.
    if (arrays && DMV_FORMULA_PER_KEY.indexOf(' ' + upper + ' ') >= 0 && !shapes.every(scalar))
      return null;
    if (DMV_FORMULA_AGGREGATES.indexOf(' ' + upper + ' ') >= 0) return SCALAR;
    if (DMV_FORMULA_ARRAYS.indexOf(' ' + upper + ' ') >= 0) return null;
    if (arrays && DMV_FORMULA_ELEMENTWISE.indexOf(' ' + upper + ' ') >= 0)
      return shapes.reduce(function (shape, next) {
        return combine(shape, next, true);
      }, SCALAR);
    return shapes.every(scalar) ? SCALAR : null;
  }
  var shape = expression(Object.create(null), false);
  if (index < tokens.length) fail('unexpected "' + tokens[index].text + '"', tokens[index].at);
  if (used.names.length) dmvChatFormulaNames_(session, used.names, cache, fail);
  return {
    shape: shape,
    functions: used.functions,
    names: used.names,
    tabs: used.tabs,
  };
}

// Names that are not LET or LAMBDA names must be named ranges of this spreadsheet. The list is
// read once per cache; when it cannot be read, Sheets reports an unknown name as #NAME?.
function dmvChatFormulaNames_(session, names, cache, fail) {
  if (cache.namedRanges === undefined) {
    cache.namedRanges = null;
    try {
      var result = Sheets.Spreadsheets.get(session.spreadsheetId, { fields: 'namedRanges(name)' });
      cache.namedRanges = ((result && result.namedRanges) || []).map(function (item) {
        return String(item.name || '');
      });
    } catch (ignored) {
      /* Checked by Sheets instead. */
    }
  }
  if (!cache.namedRanges) return;
  var known = cache.namedRanges.map(function (name) {
    return name.toUpperCase();
  });
  names.forEach(function (name) {
    if (known.indexOf(name) >= 0) return;
    fail(
      'unknown name ' +
        name +
        ': it is not a function call, a LET or LAMBDA name, or a named range of this spreadsheet' +
        (cache.namedRanges.length
          ? ' (named ranges: ' + cache.namedRanges.slice(0, 20).join(', ') + ')'
          : ' (it has none)') +
        '. Put text in double quotes'
    );
  });
}

function dmvChatSheetFormulaTools_() {
  return [
    {
      name: 'search_sheets',
      label: 'Searching the spreadsheet',
      description:
        'Read-only. mode find (default): find text, a number or a regular expression in cell values (what cells show) or formulas across every visible tab or chosen tabs; returns up to 200 matches as Tab!cell with value and formula, and the total. mode duplicates: report duplicate rows of one tab range by key columns (groups, counts, first rows), ignoring case and surrounding spaces unless matchCase. Changes nothing. Scans at most 200,000 cells per call.',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['find', 'duplicates'] },
          query: { type: 'string', description: 'find: text, number or regular expression.' },
          regex: { type: 'boolean' },
          matchCase: { type: 'boolean' },
          wholeCell: { type: 'boolean' },
          lookIn: {
            type: 'string',
            enum: ['values', 'formulas'],
            description: 'formulas searches formula text; default values.',
          },
          sheetName: { type: 'string', description: 'One tab; required for duplicates.' },
          sheetNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'find: tabs to search; default every visible tab.',
          },
          range: {
            type: 'string',
            description: 'A1 range within one tab, such as A1:F5000, A:F or A2:F.',
          },
          columns: {
            type: 'array',
            items: { type: 'integer', minimum: 1 },
            description: 'duplicates: one-based key columns within the range; default all.',
          },
          headerRows: {
            type: 'integer',
            minimum: 0,
            maximum: 1,
            description: 'duplicates: header rows; default 1.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 200,
            description: 'Matches or groups to return; default 50.',
          },
        },
      },
      run: dmvChatSearchSheets_,
    },
  ];
}

// Called by set_formulas once the matrix has the inspected shape: every formula is checked, and
// the spill area of each exact array result is checked against the grid, the other written cells
// and the data already there. Returns the spill cells as touches (guarded and kept for undo).
function dmvChatSheetFormulaPolicy_(session, sheet, area, formulas) {
  var cache = {},
    grid = area.grid,
    spills = [],
    unknown = [];
  formulas.forEach(function (line, r) {
    line.forEach(function (formula, c) {
      if ((r * area.columns + c) % 50 === 0) dmvChatSheetDeadline_(session);
      var row = grid.startRowIndex + r,
        column = grid.startColumnIndex + c,
        cell = dmvChatA1_(row + 1, column + 1);
      var shape = dmvChatSheetFormulaCheck_(session, formula, {
        sheet: sheet,
        cell: cell,
        cache: cache,
      }).shape;
      if (!shape) {
        unknown.push([row, column]);
        return;
      }
      if (shape.rows === 1 && shape.columns === 1) return;
      var spill = {
        cell: cell,
        sheetId: grid.sheetId,
        startRowIndex: row,
        endRowIndex: row + shape.rows,
        startColumnIndex: column,
        endColumnIndex: column + shape.columns,
      };
      if (spill.endRowIndex > sheet.getMaxRows() || spill.endColumnIndex > sheet.getMaxColumns())
        throw new Error(
          cell +
            ': the result fills ' +
            shape.rows +
            ' rows × ' +
            shape.columns +
            ' columns from ' +
            cell +
            ', past the end of the tab (' +
            sheet.getMaxRows() +
            ' rows × ' +
            sheet.getMaxColumns() +
            ' columns). Start it higher or add rows or columns first.'
        );
      if (shape.rows * shape.columns > DMV_FORMULA.maxSpillCells) {
        unknown.push([row, column]);
        return;
      }
      // Results start at their own cell and grow right and down, so two of them can only meet
      // over a cell this edit writes.
      if (dmvChatFormulaOverlap_(spill, grid, row, column))
        throw new Error(
          cell +
            ': the result fills ' +
            dmvChatGridA1_(spill) +
            ', which overlaps other cells this edit writes. Sheets would show #REF!. Leave room for the result or write fewer formulas.'
        );
      spills.push(spill);
    });
  });
  // The cells each result fills besides its own: the rest of its first row, then the rows below.
  var touches = [];
  spills.forEach(function (spill) {
    spill.grids = [];
    if (spill.endColumnIndex - spill.startColumnIndex > 1)
      spill.grids.push({
        sheetId: spill.sheetId,
        startRowIndex: spill.startRowIndex,
        endRowIndex: spill.startRowIndex + 1,
        startColumnIndex: spill.startColumnIndex + 1,
        endColumnIndex: spill.endColumnIndex,
      });
    if (spill.endRowIndex - spill.startRowIndex > 1)
      spill.grids.push({
        sheetId: spill.sheetId,
        startRowIndex: spill.startRowIndex + 1,
        endRowIndex: spill.endRowIndex,
        startColumnIndex: spill.startColumnIndex,
        endColumnIndex: spill.endColumnIndex,
      });
    touches = touches.concat(spill.grids);
  });
  if (touches.length) {
    var read = dmvChatSheetCells_(session, touches),
      at = 0;
    spills.forEach(function (spill) {
      var taken = [];
      spill.grids.forEach(function (part) {
        read[at++].cells.forEach(function (line, r) {
          line.forEach(function (cell, c) {
            if (cell.userEnteredValue && Object.keys(cell.userEnteredValue).length)
              taken.push(dmvChatA1_(part.startRowIndex + r + 1, part.startColumnIndex + c + 1));
          });
        });
      });
      if (taken.length)
        throw new Error(
          spill.cell +
            ': the result fills ' +
            dmvChatGridA1_(spill) +
            ', but ' +
            taken.length +
            (taken.length === 1 ? ' cell there holds' : ' cells there hold') +
            ' data (' +
            taken.slice(0, 5).join(', ') +
            (taken.length > 5 ? ', …' : '') +
            '). Sheets would show #REF! instead of overwriting it. Clear those cells or put the formula elsewhere.'
        );
    });
  }
  return {
    touches: touches,
    spills: spills.map(function (spill) {
      return {
        cell: spill.cell,
        row: spill.startRowIndex,
        column: spill.startColumnIndex,
        rows: spill.endRowIndex - spill.startRowIndex,
        columns: spill.endColumnIndex - spill.startColumnIndex,
      };
    }),
    // Results of unknown size are looked for in a window below and right of the range.
    unknown: unknown,
    probe: unknown.length
      ? {
          sheetId: grid.sheetId,
          startRowIndex: grid.startRowIndex,
          endRowIndex: Math.min(sheet.getMaxRows(), grid.endRowIndex + DMV_FORMULA.probeRows),
          startColumnIndex: grid.startColumnIndex,
          endColumnIndex: Math.min(
            sheet.getMaxColumns(),
            grid.endColumnIndex + DMV_FORMULA.probeColumns
          ),
        }
      : null,
  };
}

// Whether a spill overlaps another grid, apart from the formula's own cell.
function dmvChatFormulaOverlap_(spill, other, row, column) {
  for (
    var r = Math.max(spill.startRowIndex, other.startRowIndex);
    r < Math.min(spill.endRowIndex, other.endRowIndex);
    r++
  )
    for (
      var c = Math.max(spill.startColumnIndex, other.startColumnIndex);
      c < Math.min(spill.endColumnIndex, other.endColumnIndex);
      c++
    )
      if (r !== row || c !== column) return true;
  return false;
}

function dmvChatFormulaValue_(cell) {
  var value = cell && cell.effectiveValue;
  if (!value) return null;
  if (value.errorValue) return DMV_FORMULA_ERRORS[value.errorValue.type] || '#ERROR!';
  if (value.numberValue !== undefined) return value.numberValue;
  if (value.boolValue !== undefined) return value.boolValue;
  return dmvChatCell_(value.stringValue);
}

// Called after set_formulas wrote, with { sheet, area, formulas, policy, after }: after holds the
// range and the exact spill areas read back. Returns the errors the formulas produced (cell,
// error and Sheets' message), a sample of results and where array results spilled.
function dmvChatSheetFormulaReadBack_(session, written) {
  var policy = written.policy || {},
    area = written.area,
    tab = written.sheet.getName();
  var known = Object.create(null);
  function keep(grid, cells) {
    cells.forEach(function (line, r) {
      line.forEach(function (cell, c) {
        known[grid.startRowIndex + r + ':' + (grid.startColumnIndex + c)] = cell;
      });
    });
  }
  (written.after || []).forEach(function (item) {
    keep(item.grid, item.cells);
  });
  var probed = false;
  if (policy.probe) {
    try {
      var probe = dmvChatSheetCells_(session, [policy.probe])[0];
      // The written range and exact spills keep what was read with them.
      var saved = known;
      known = Object.create(null);
      keep(probe.grid, probe.cells);
      Object.keys(saved).forEach(function (key) {
        known[key] = saved[key];
      });
      probed = true;
    } catch (ignored) {
      /* The written cells are still reported. */
    }
  }
  function at(row, column) {
    return known[row + ':' + column];
  }
  function spilled(row, column) {
    var cell = at(row, column);
    return (
      !!cell &&
      !!cell.effectiveValue &&
      !(cell.userEnteredValue && Object.keys(cell.userEnteredValue).length)
    );
  }
  var errors = [],
    errorCount = 0,
    loading = [],
    samples = [],
    seen = Object.create(null);
  function check(row, column) {
    var key = row + ':' + column,
      cell = at(row, column);
    if (seen[key] || !cell || !cell.effectiveValue) return;
    seen[key] = true;
    var error = cell.effectiveValue.errorValue;
    if (!error) return;
    var name = tab + '!' + dmvChatA1_(row + 1, column + 1);
    if (error.type === 'LOADING') {
      if (loading.length < DMV_FORMULA.maxErrors) loading.push(name);
      return;
    }
    errorCount++;
    if (errors.length < DMV_FORMULA.maxErrors)
      errors.push({
        cell: name,
        error: DMV_FORMULA_ERRORS[error.type] || '#ERROR!',
        message: String(error.message || '').slice(0, 300),
      });
  }
  function block(row, column, rows, columns) {
    var lines = [];
    for (var r = 0; r < Math.min(rows, 3); r++) {
      var line = [];
      for (var c = 0; c < Math.min(columns, 6); c++)
        line.push(dmvChatFormulaValue_(at(row + r, column + c)));
      lines.push(line);
    }
    return lines;
  }
  var grid = area.grid;
  for (var r = grid.startRowIndex; r < grid.endRowIndex; r++)
    for (var c = grid.startColumnIndex; c < grid.endColumnIndex; c++) {
      check(r, c);
      var cell = at(r, c);
      if (samples.length < DMV_FORMULA.maxSamples && cell && cell.effectiveValue)
        samples.push({ cell: dmvChatA1_(r + 1, c + 1), value: dmvChatFormulaValue_(cell) });
    }
  var spills = [];
  (policy.spills || []).forEach(function (spill) {
    for (var r = 0; r < spill.rows; r++)
      for (var c = 0; c < spill.columns; c++) check(spill.row + r, spill.column + c);
    if (spills.length < DMV_FORMULA.maxSpills)
      spills.push({
        cell: spill.cell,
        range: dmvChatGridA1_({
          startRowIndex: spill.row,
          endRowIndex: spill.row + spill.rows,
          startColumnIndex: spill.column,
          endColumnIndex: spill.column + spill.columns,
        }),
        rows: spill.rows,
        columns: spill.columns,
        sample_rows: block(spill.row, spill.column, spill.rows, spill.columns),
      });
  });
  if (probed) {
    // A result of unknown size: the run of spilled cells right of and below its formula.
    (policy.unknown || []).forEach(function (origin) {
      var row = origin[0],
        column = origin[1],
        right = 0,
        down = 0;
      while (spilled(row, column + right + 1)) right++;
      while (spilled(row + down + 1, column)) down++;
      if (!right && !down) return;
      for (var y = 0; y <= down; y++)
        for (var x = 0; x <= right; x++) if (y || x) check(row + y, column + x);
      if (spills.length >= DMV_FORMULA.maxSpills) return;
      var item = {
        cell: dmvChatA1_(row + 1, column + 1),
        range: dmvChatGridA1_({
          startRowIndex: row,
          endRowIndex: row + down + 1,
          startColumnIndex: column,
          endColumnIndex: column + right + 1,
        }),
        rows: down + 1,
        columns: right + 1,
        sample_rows: block(row, column, down + 1, right + 1),
      };
      if (
        row + down + 1 >= policy.probe.endRowIndex ||
        column + right + 1 >= policy.probe.endColumnIndex
      )
        item.note = 'Continues past the cells read back.';
      spills.push(item);
    });
  }
  var result = { results: samples };
  if (spills.length) result.spills = spills;
  if (loading.length) result.stillLoading = loading;
  if (errorCount) {
    result.formulaErrors = errors;
    result.errorCount = errorCount;
    result.next =
      'Some formulas returned errors. Nothing was rolled back: inspect the range again and fix them with set_formulas, or undo the edit with undo_sheet_edit.';
  }
  return result;
}

/* search_sheets */

var DMV_SHEET_SEARCH = {
  maxCells: 200000,
  maxMatches: 200,
  defaultLimit: 50,
  maxQuery: 200,
  maxTabs: 30,
  maxKeyColumns: 30,
  regexText: 5000,
  groupRows: 10,
};

// A range within one tab for search_sheets: A1:F5000, A:F, A2:F or one cell, ending at the last
// row with data when it gives no end row.
function dmvChatSearchArea_(sheet, text, data) {
  var match = /^([A-Z]{1,3})([1-9][0-9]{0,6})?(?::([A-Z]{1,3})([1-9][0-9]{0,6})?)?$/.exec(
    String(text || '')
      .replace(/\$/g, '')
      .toUpperCase()
  );
  if (!match || (!match[3] && !match[2]))
    throw new Error('Use a range such as A1:F5000, A:F or A2:F.');
  var start = dmvCell_(match[1] + (match[2] || 1)),
    end = dmvCell_((match[3] || match[1]) + (match[4] || match[2] || 1));
  var last = match[4] || (!match[3] && match[2]) ? end.row : Math.max(start.row, data.rows);
  if (end.column < start.column || last < start.row)
    throw new Error('The range must end after it starts.');
  if (last > sheet.getMaxRows() || end.column > sheet.getMaxColumns())
    throw new Error('The range is outside the tab "' + sheet.getName() + '".');
  return {
    sheetId: sheet.getSheetId(),
    startRowIndex: start.row - 1,
    endRowIndex: last,
    startColumnIndex: start.column - 1,
    endColumnIndex: end.column,
  };
}

// The cells of whole tabs or ranges in one request, lean: shown value, typed value and, for
// formulas, the formula. Calls visit(sheetIndex, row, column, cell) with 0-based positions.
// values names other cell fields to read instead.
function dmvChatSearchRead_(session, plan, visit, values) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    ranges: plan.map(function (item) {
      return "'" + item.sheet.getName().replace(/'/g, "''") + "'!" + dmvChatGridA1_(item.grid);
    }),
    fields:
      'sheets(properties(sheetId),data(startRow,startColumn,rowData(values(' +
      (values || 'formattedValue,effectiveValue,userEnteredValue') +
      '))))',
  });
  var used = Object.create(null),
    count = 0;
  plan.forEach(function (item, number) {
    var id = item.grid.sheetId;
    var read = ((result && result.sheets) || []).filter(function (entry) {
      return entry.properties && entry.properties.sheetId === id;
    })[0];
    var position = (used[id] = (used[id] || 0) + 1) - 1;
    var block = read && (read.data || [])[position];
    ((block && block.rowData) || []).forEach(function (line, r) {
      (line.values || []).forEach(function (cell, c) {
        if (++count % 5000 === 0) dmvChatSheetDeadline_(session);
        var row = (block.startRow || 0) + r,
          column = (block.startColumn || 0) + c;
        if (
          row >= item.grid.startRowIndex &&
          row < item.grid.endRowIndex &&
          column >= item.grid.startColumnIndex &&
          column < item.grid.endColumnIndex
        )
          visit(number, row, column, cell);
      });
    });
  });
}

function dmvChatSearchShown_(cell) {
  if (cell.formattedValue !== undefined && cell.formattedValue !== null)
    return String(cell.formattedValue);
  var value = cell.effectiveValue || {};
  if (value.errorValue) return DMV_FORMULA_ERRORS[value.errorValue.type] || '#ERROR!';
  if (value.numberValue !== undefined) return String(value.numberValue);
  if (value.boolValue !== undefined) return value.boolValue ? 'TRUE' : 'FALSE';
  return value.stringValue === undefined ? '' : String(value.stringValue);
}

function dmvChatSearchSheets_(session, input) {
  input = input || {};
  dmvChatSheetObject_(input, [
    'mode',
    'query',
    'regex',
    'matchCase',
    'wholeCell',
    'lookIn',
    'sheetName',
    'sheetNames',
    'range',
    'columns',
    'headerRows',
    'limit',
  ]);
  var mode = input.mode === undefined ? 'find' : input.mode;
  if (mode !== 'find' && mode !== 'duplicates') throw new Error('Choose mode find or duplicates.');
  ['regex', 'matchCase', 'wholeCell'].forEach(function (key) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new Error(key + ' must be true or false.');
  });
  var limit =
    input.limit === undefined
      ? DMV_SHEET_SEARCH.defaultLimit
      : dmvChatSheetInteger_(input.limit, 1, DMV_SHEET_SEARCH.maxMatches, 'limit');
  if (input.sheetName !== undefined && input.sheetNames !== undefined)
    throw new Error('Pass sheetName for one tab or sheetNames for several, not both.');
  var names =
    input.sheetName !== undefined
      ? [input.sheetName]
      : input.sheetNames === undefined
        ? null
        : input.sheetNames;
  if (
    names !== null &&
    (!Array.isArray(names) || !names.length || names.length > DMV_SHEET_SEARCH.maxTabs)
  )
    throw new Error('sheetNames must list between 1 and ' + DMV_SHEET_SEARCH.maxTabs + ' tabs.');
  var sheets = names
    ? names.map(function (name) {
        return dmvChatSheetTarget_(session, name);
      })
    : session.spreadsheet.getSheets().filter(function (sheet) {
        return !sheet.isSheetHidden();
      });
  if (input.range !== undefined && sheets.length !== 1)
    throw new Error('A range needs exactly one tab: pass sheetName with it.');
  return mode === 'duplicates'
    ? dmvChatSearchDuplicates_(session, input, sheets, limit)
    : dmvChatSearchFind_(session, input, sheets, limit);
}

// The tabs or range to read, whole tabs in order while they fit the cell cap.
function dmvChatSearchPlan_(sheets, input) {
  var plan = [],
    skipped = [],
    cells = 0;
  sheets.forEach(function (sheet) {
    var data = sheet.getDataRange();
    var extent = { rows: data.getNumRows(), columns: data.getNumColumns() };
    var grid =
      input.range !== undefined
        ? dmvChatSearchArea_(sheet, input.range, extent)
        : {
            sheetId: sheet.getSheetId(),
            startRowIndex: 0,
            endRowIndex: extent.rows,
            startColumnIndex: 0,
            endColumnIndex: extent.columns,
          };
    var size = dmvChatGridCells_(grid);
    if (skipped.length || cells + size > DMV_SHEET_SEARCH.maxCells) {
      skipped.push({ sheetName: sheet.getName(), cells: size });
      return;
    }
    cells += size;
    plan.push({ sheet: sheet, grid: grid });
  });
  if (!plan.length)
    throw new Error(
      'Tab "' +
        skipped[0].sheetName +
        '" has ' +
        skipped[0].cells +
        ' cells to scan; one search reads at most ' +
        DMV_SHEET_SEARCH.maxCells +
        '. Narrow the search with sheetName and a range.'
    );
  return { plan: plan, skipped: skipped, cells: cells };
}

function dmvChatSearchFind_(session, input, sheets, limit) {
  var query = typeof input.query === 'number' ? String(input.query) : input.query;
  if (typeof query !== 'string' || !query.length || query.length > DMV_SHEET_SEARCH.maxQuery)
    throw new Error('query must be text of 1 to ' + DMV_SHEET_SEARCH.maxQuery + ' characters.');
  if (input.lookIn !== undefined && input.lookIn !== 'values' && input.lookIn !== 'formulas')
    throw new Error('Choose lookIn values or formulas.');
  if (input.columns !== undefined || input.headerRows !== undefined)
    throw new Error('columns and headerRows belong to mode duplicates.');
  var formulas = input.lookIn === 'formulas',
    matchCase = input.matchCase === true,
    whole = input.wholeCell === true;
  var test,
    longCells = 0;
  if (input.regex) {
    // Nested repetition such as (a+)+ or (a|a)+ can take exponential time.
    if (dmvChatRegexNested_(query))
      throw new Error(
        'Avoid repeating a group that itself repeats or has alternatives, such as (a+)+ or (a|b)+; write the pattern without nested repetition.'
      );
    var pattern;
    try {
      pattern = new RegExp(whole ? '^(?:' + query + ')$' : query, matchCase ? '' : 'i');
    } catch (error) {
      throw new Error('The regular expression is not valid: ' + error.message);
    }
    // A long cell can still take long, so it is left out and counted, as find_replace refuses it.
    test = function (text) {
      if (text.length > DMV_SHEET_SEARCH.regexText) {
        longCells++;
        return false;
      }
      return pattern.test(text);
    };
  } else {
    var wanted = matchCase ? query : query.toLowerCase(),
      number = /^\s*-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(query) ? Number(query) : null;
    test = function (text, cell) {
      var value = cell.effectiveValue;
      if (number !== null && value && value.numberValue === number && !formulas) return true;
      var have = matchCase ? text : text.toLowerCase();
      return whole ? have === wanted : have.indexOf(wanted) >= 0;
    };
  }
  var planned = dmvChatSearchPlan_(sheets, input);
  var matches = [],
    total = 0,
    byTab = Object.create(null),
    first = Object.create(null);
  dmvChatSearchRead_(session, planned.plan, function (number, row, column, cell) {
    var formula = cell.userEnteredValue && cell.userEnteredValue.formulaValue;
    var text = formulas && formula ? String(formula) : dmvChatSearchShown_(cell);
    if (text === '' && !formula) return;
    if (!test(text, cell)) return;
    var name = planned.plan[number].sheet.getName(),
      a1 = dmvChatA1_(row + 1, column + 1);
    total++;
    byTab[name] = (byTab[name] || 0) + 1;
    if (!first[name]) first[name] = { sheet: planned.plan[number].sheet, a1: a1 };
    if (matches.length >= limit) return;
    var match = { cell: name + '!' + a1, value: dmvChatCell_(dmvChatSearchShown_(cell)) };
    if (formula) match.formula = String(formula).slice(0, 300);
    matches.push(match);
  });
  var links = Object.keys(first)
    .slice(0, 3)
    .map(function (name) {
      return {
        label: name,
        url: dmvSheetUrl_(session.spreadsheet, first[name].sheet.getSheetId(), first[name].a1),
      };
    })
    .filter(function (link) {
      return link.url;
    });
  session.events.push({
    kind: 'summary',
    text:
      'Searched ' +
      planned.plan.length +
      (planned.plan.length === 1 ? ' tab' : ' tabs') +
      ' for "' +
      query.slice(0, 40) +
      '": ' +
      total +
      (total === 1 ? ' match' : ' matches'),
    links: links,
    details: dmvChatDetails_([
      [
        'Tabs',
        planned.plan.map(function (item) {
          return item.sheet.getName();
        }),
      ],
      ['Cells scanned', planned.cells],
    ]),
  });
  var result = {
    query: query,
    lookIn: formulas ? 'formulas' : 'values',
    total: total,
    returned: matches.length,
    matches: matches,
    byTab: byTab,
    scannedCells: planned.cells,
    searchedTabs: planned.plan.map(function (item) {
      return item.sheet.getName();
    }),
  };
  if (total > matches.length)
    result.note =
      'Only the first ' + matches.length + ' matches are listed; narrow the search to see others.';
  if (longCells) {
    result.longCells = longCells;
    result.note =
      (result.note ? result.note + ' ' : '') +
      longCells +
      (longCells === 1
        ? ' cell longer than 5,000 characters was'
        : ' cells longer than 5,000 characters were') +
      ' not searched with the regular expression; search them without regex.';
  }
  if (planned.skipped.length) {
    result.skippedTabs = planned.skipped.map(function (item) {
      return item.sheetName;
    });
    result.incomplete =
      'Stopped at ' +
      DMV_SHEET_SEARCH.maxCells +
      ' cells: the skipped tabs were not searched. Narrow the search with sheetNames.';
  }
  return result;
}

function dmvChatSearchDuplicates_(session, input, sheets, limit) {
  if (sheets.length !== 1) throw new Error('duplicates checks one tab: pass sheetName.');
  ['query', 'regex', 'wholeCell', 'lookIn'].forEach(function (key) {
    if (input[key] !== undefined) throw new Error(key + ' belongs to mode find.');
  });
  var headers =
    input.headerRows === undefined ? 1 : dmvChatSheetInteger_(input.headerRows, 0, 1, 'headerRows');
  var planned = dmvChatSearchPlan_(sheets, input);
  if (planned.skipped.length)
    throw new Error('The range is too large to check at once. Use a smaller range.');
  var sheet = planned.plan[0].sheet,
    grid = planned.plan[0].grid,
    width = grid.endColumnIndex - grid.startColumnIndex;
  var keys;
  if (input.columns === undefined)
    keys = Array.from({ length: width }, function (_, index) {
      return index;
    });
  else {
    if (
      !Array.isArray(input.columns) ||
      !input.columns.length ||
      input.columns.length > DMV_SHEET_SEARCH.maxKeyColumns
    )
      throw new Error(
        'columns must list 1 to ' + DMV_SHEET_SEARCH.maxKeyColumns + ' column numbers.'
      );
    keys = input.columns.map(function (value) {
      return dmvChatSheetInteger_(value, 1, width, 'Key column') - 1;
    });
    if (
      keys.some(function (value, index) {
        return keys.indexOf(value) !== index;
      })
    )
      throw new Error('List each key column once.');
  }
  if (grid.endRowIndex - grid.startRowIndex <= headers)
    throw new Error('The range needs at least one row below its header.');
  var matchCase = input.matchCase === true;
  var rows = Object.create(null);
  dmvChatSearchRead_(session, planned.plan, function (number, row, column, cell) {
    var index = keys.indexOf(column - grid.startColumnIndex);
    if (index < 0) return;
    (rows[row] = rows[row] || [])[index] = cell;
  });
  var header = rows[grid.startRowIndex] || [];
  var labels = keys.map(function (key, index) {
    var text = headers && header[index] ? dmvChatSearchShown_(header[index]) : '';
    return text || dmvChatA1_(1, grid.startColumnIndex + key + 1).replace(/[0-9]+$/, '');
  });
  var groups = Object.create(null),
    order = [],
    blank = 0,
    checked = 0;
  for (var row = grid.startRowIndex + headers; row < grid.endRowIndex; row++) {
    var line = rows[row] || [];
    var shown = keys.map(function (key, index) {
      return line[index] ? dmvChatSearchShown_(line[index]) : '';
    });
    checked++;
    if (
      shown.every(function (text) {
        return text.trim() === '';
      })
    ) {
      blank++;
      continue;
    }
    var key = JSON.stringify(
      shown.map(function (text) {
        text = text.trim();
        return matchCase ? text : text.toLowerCase();
      })
    );
    if (!groups[key]) {
      groups[key] = { values: shown.map(dmvChatCell_), count: 0, rows: [] };
      order.push(key);
    }
    groups[key].count++;
    if (groups[key].rows.length < DMV_SHEET_SEARCH.groupRows) groups[key].rows.push(row + 1);
  }
  var duplicates = order
    .map(function (key) {
      return groups[key];
    })
    .filter(function (group) {
      return group.count > 1;
    });
  duplicates.sort(function (a, b) {
    return b.count - a.count || a.rows[0] - b.rows[0];
  });
  var extra = 0;
  duplicates.forEach(function (group) {
    extra += group.count - 1;
  });
  var range = dmvChatGridA1_(grid);
  var url = dmvSheetUrl_(session.spreadsheet, sheet.getSheetId(), range);
  session.events.push({
    kind: 'summary',
    text:
      'Found ' +
      duplicates.length +
      ' duplicate ' +
      (duplicates.length === 1 ? 'group' : 'groups') +
      ' in ' +
      sheet.getName() +
      '!' +
      range,
    links: url ? [{ label: sheet.getName(), url: url }] : [],
    details: dmvChatDetails_([
      ['Range', range],
      ['Key columns', labels],
      ['Rows checked', checked],
    ]),
  });
  var result = {
    sheetName: sheet.getName(),
    range: range,
    url: url,
    keyColumns: labels,
    rowsChecked: checked,
    blankRowsSkipped: blank,
    duplicateGroups: duplicates.length,
    duplicateRows: extra,
    compared: matchCase
      ? 'exact text, surrounding spaces ignored'
      : 'ignoring case and surrounding spaces',
    groups: duplicates.slice(0, limit),
  };
  if (duplicates.length > limit) result.note = 'Only the ' + limit + ' largest groups are listed.';
  return result;
}
