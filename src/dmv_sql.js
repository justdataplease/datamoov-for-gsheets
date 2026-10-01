/** Conservative shared SELECT grammar boundary; the database still parses SQL. */
function dmvReadOnlySql_(value, options) {
  var sql = String(value || '').trim();
  if (!sql || sql.length > 64000)
    throw new Error('Enter one read-only SELECT or WITH query (at most 64,000 characters).');
  var out = '',
    quote = '',
    depth = 0,
    ended = false,
    tokens = [],
    word = '';
  function flush() {
    if (word) {
      tokens.push(word.toUpperCase());
      word = '';
    }
  }
  for (var index = 0; index < sql.length; index++) {
    var char = sql[index],
      next = sql[index + 1];
    if (quote) {
      if (char === '\\')
        throw new Error(
          'Backslash-escaped SQL literals are not supported. Use ordinary SQL literals.'
        );
      out += char;
      if (char === quote) {
        if (next === quote) {
          out += next;
          index++;
        } else quote = '';
      }
      continue;
    }
    if ((char === '-' && next === '-') || (char === '#' && options && options.hashComments)) {
      flush();
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
      out += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      flush();
      var end = sql.indexOf('*/', index + 2);
      if (end < 0 || sql.slice(index + 2, end).indexOf('/*') >= 0)
        throw new Error('Close SQL comments and avoid nested block comments.');
      index = end + 1;
      out += ' ';
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      out += char;
      continue;
    }
    if (ended) throw new Error('Only one SQL statement is allowed.');
    if (char === "'" || char === '"' || char === '`') {
      if (sql.slice(index, index + 3) === char + char + char || /^[RB]{1,2}$/i.test(word)) {
        throw new Error(
          'Use ordinary quoted SQL literals; raw, bytes, and triple-quoted literals are not supported.'
        );
      }
      flush();
      quote = char;
      out += char;
      continue;
    }
    if (char === '$' && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index)))
      throw new Error('Dollar-quoted SQL literals are not supported.');
    if (/[A-Za-z0-9_]/.test(char)) {
      word += char;
      out += char;
      continue;
    }
    flush();
    if (char === '(') depth++;
    if (char === ')' && --depth < 0) throw new Error('SQL parentheses must be balanced.');
    if (char === ';') {
      if (depth !== 0) throw new Error('Only one SQL statement is allowed.');
      ended = true;
      continue;
    }
    out += char;
  }
  flush();
  if (quote || depth !== 0) throw new Error('Close SQL quotes and balance parentheses.');
  if (tokens[0] !== 'SELECT' && tokens[0] !== 'WITH')
    throw new Error('Enter one read-only SELECT or WITH query.');
  var writes = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'UPSERT',
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'COPY',
    'CALL',
    'EXECUTE',
    'DO',
    'EXPORT',
    'LOAD',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'INTO',
  ];
  if (
    tokens.some(function (token) {
      return writes.indexOf(token) >= 0;
    })
  )
    throw new Error('Write statements, scripts, and SELECT INTO are not supported.');
  return out.trim();
}

// Keep the top rows of a SQL report (config top with rankBy): the database orders the query's
// result by one of its columns, highest first with blanks last, and keeps that many rows. quote
// is the dialect's identifier quoting, which escapes the name or refuses one it cannot quote.
// Null when both are blank: every row is kept and the report fails over the row limit as before.
// A top without a rank column, or a rank column without a top, is refused before any request
// rather than guessed or ignored.
function dmvSqlTop_(ctx, quote) {
  var value = (ctx.config || {}).rankBy;
  var name = value === undefined || value === null ? '' : String(value).trim();
  var top = dmvTopRows_(
    ctx,
    name
      ? ''
      : 'Keep the top rows needs a Rank by column: the result column whose highest values come first, such as spend.'
  );
  if (!top) {
    if (name)
      throw new Error(
        'Rank by column orders the rows Keep the top rows keeps. Set Keep the top rows or clear Rank by column.'
      );
    return null;
  }
  if (name.length > 255 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error("Rank by column must name one column of the query's result.");
  var rank = { top: top, name: name, quote: quote };
  rank.order = dmvSqlTopOrder_(rank, name);
  return rank;
}

// The ranking appended to the wrapped query: by key, quoted by the dialect, highest first.
function dmvSqlTopOrder_(rank, key) {
  return ' ORDER BY ' + rank.quote(key) + ' DESC NULLS LAST LIMIT ' + rank.top;
}

// Checks a ranked result once its columns are known, each {key, numeric, dated} as the dialect
// types it (dated: a date or time type). A period column makes the rows a trend whose periods
// each need every row, so a top is refused naming it, as ad reports refuse one beside Date: one
// named date, day, week, month, quarter or year whatever its type, or a dated one whose name
// holds such a word (order_date, week_start). Another dated column, such as last_ordered, is an
// attribute of each item and stays. The rank column must hold numbers. Returns its key: the
// name as given or, where it differs only in case, the one column that matches it so; the
// connectors rank by that key, so a name typed in another case still finds its column.
function dmvSqlTopColumn_(rank, columns) {
  var period = columns.filter(function (column) {
    var words = column.key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/);
    return (
      /^(date|day|week|month|quarter|year)$/i.test(column.key) ||
      (column.dated &&
        words.some(function (word) {
          return /^(date|day|week|month|quarter|year|period)$/.test(word);
        }))
    );
  })[0];
  if (period)
    throw new Error(
      'Keep the top rows ranks one row per item, so it cannot be combined with the period column ' +
        period.key +
        '. Remove ' +
        period.key +
        ' from the query or clear Keep the top rows; if it describes each item, not a period, give it an alias such as last_seen.'
    );
  var named = function (exact) {
    return columns.filter(function (column) {
      return exact
        ? column.key === rank.name
        : column.key.toLowerCase() === rank.name.toLowerCase();
    });
  };
  var found = named(true);
  if (!found.length) found = named(false);
  if (found.length !== 1)
    throw new Error(
      'Rank by column (' +
        rank.name +
        ") is not a column of the query's result. Enter it as the result names it: " +
        columns
          .slice(0, 8)
          .map(function (column) {
            return column.key;
          })
          .join(', ') +
        (columns.length > 8 ? '…' : '.')
    );
  if (!found[0].numeric)
    throw new Error(
      'Rank by column (' +
        found[0].key +
        ') must be a numeric column: the top rows have its highest values.'
    );
  return found[0].key;
}

// The rows of a ranked result, labelled as a cut list (metadata.topRows, and "Top 300 by spend"
// before the connector's own note) only when exactly the top rows came back: fewer rows are the
// whole list. The database ranked them; dmvKeepTopRows_ keeps that order and checks the values.
function dmvSqlTopRows_(rank, key, rows, metadata) {
  var kept = dmvKeepTopRows_(rows, rank.top, key, key);
  if (kept.topRows) {
    metadata.topRows = kept.topRows;
    metadata.note =
      kept.note +
      (metadata.note ? '; ' + metadata.note.charAt(0).toLowerCase() + metadata.note.slice(1) : '');
  }
  return kept.rows;
}

// A SQL report over the row limit fails: a LIMIT in the query would keep part of the rows
// without saying so, while Keep the top rows labels the list it cuts. Kept short, so a
// dashboard's message around it fits the 400 characters dmvSafeError_ keeps.
function dmvSqlOverLimit_(subject) {
  return new Error(
    subject +
      ' exceeds the row limit. Aggregate or filter it, or rank a list with Keep the top rows (not a LIMIT).'
  );
}
