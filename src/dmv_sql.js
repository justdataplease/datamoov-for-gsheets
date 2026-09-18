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
