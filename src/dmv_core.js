/* DataMoov's shared report contract. Provider behavior lives in connectors/. */
var DMV_CONNECTORS;
var DMV_LIMITS = {
  maxRows: 20000,
  defaultRows: 1000,
  // Chat fetches whole accounts and aggregates server-side, so its initial cap is higher.
  chatDefaultRows: 10000,
  maxColumns: 80,
  maxReports: 30,
  maxConnections: 20,
  maxCredentials: 20,
  maxBytes: 8000000,
};

function dmvRegisterConnector_(definition) {
  if (!DMV_CONNECTORS) DMV_CONNECTORS = Object.create(null);
  if (!definition || !/^[a-z][a-z0-9_]+$/.test(definition.id) || !Array.isArray(definition.reports))
    throw new Error('Invalid connector declaration.');
  if (DMV_CONNECTORS[definition.id]) throw new Error('Duplicate connector: ' + definition.id);
  // A source kept in the code but not offered yet: it is not registered, so no list shows it.
  if (definition.hidden) return;
  DMV_CONNECTORS[definition.id] = definition;
}

function dmvConnector_(id) {
  if (!DMV_CONNECTORS || !Object.prototype.hasOwnProperty.call(DMV_CONNECTORS, id))
    throw new Error('Choose an available data source.');
  return DMV_CONNECTORS[id];
}

function dmvDefinition_(connector, reportType) {
  var report = connector.reports.filter(function (item) {
    return item.id === reportType;
  })[0];
  if (!report) throw new Error('Choose an available report.');
  return report;
}

function dmvCatalog_() {
  return Object.keys(DMV_CONNECTORS || {})
    .map(function (id) {
      var definition = dmvConnector_(id);
      return JSON.parse(
        JSON.stringify({
          id: id,
          label: definition.label,
          description: definition.description,
          category: definition.category,
          color: definition.color,
          authFields: definition.authFields || [],
          accountDiscovery: definition.accountDiscovery || null,
          supportsAccountDiscovery: typeof definition.discoverAccounts === 'function',
          guide: definition.guide || null,
          credentialFamily: dmvFamilyId_(definition),
          describesTables: typeof definition.describeTables === 'function',
          reports: definition.reports.map(function (report) {
            return {
              id: report.id,
              label: report.label,
              description: report.description,
              fields: report.fields || [],
              configFields: report.configFields || [],
              dateRange: !!report.dateRange,
              supportsDiscovery: typeof report.discoverFields === 'function',
              help: report.help || '',
              chat: report.chat !== false,
            };
          }),
        })
      );
    })
    .sort(function (a, b) {
      return a.label.localeCompare(b.label);
    });
}

// Sorted object keys make digests independent of JSON formatting and property order.
function dmvCanonical_(value) {
  if (Array.isArray(value)) return value.map(dmvCanonical_);
  if (value && typeof value === 'object') {
    var result = {};
    Object.keys(value)
      .sort()
      .forEach(function (key) {
        result[key] = dmvCanonical_(value[key]);
      });
    return result;
  }
  return value;
}

function dmvText_(value, label, maxLength, required) {
  var text = value === undefined || value === null ? '' : String(value).trim();
  if (required && !text) throw new Error(label + ' is required.');
  if (text.length > maxLength) throw new Error(label + ' is too long.');
  return text;
}

function dmvInteger_(value, minimum, maximum, label) {
  var number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum)
    throw new Error(label + ' must be between ' + minimum + ' and ' + maximum + '.');
  return number;
}

function dmvVisible_(field, values) {
  return !field.showWhen || values[field.showWhen.key] === field.showWhen.value;
}

function dmvFieldsInput_(definitions, values) {
  values = values || {};
  var result = {};
  (definitions || []).forEach(function (field) {
    var value = Object.prototype.hasOwnProperty.call(values, field.key)
      ? values[field.key]
      : field.default;
    // Objects and arrays are never valid field values; treat them as missing.
    if (value !== null && typeof value === 'object') value = undefined;
    if (value !== undefined && value !== null) result[field.key] = value;
  });
  (definitions || []).forEach(function (field) {
    if (!dmvVisible_(field, result)) return;
    var value = result[field.key];
    if (field.required && (value === undefined || value === null || String(value).trim() === ''))
      throw new Error(field.label + ' is required.');
    if (
      field.type === 'select' &&
      value !== undefined &&
      value !== '' &&
      !(field.options || []).some(function (option) {
        return (typeof option === 'string' ? option : option.value) === value;
      })
    )
      throw new Error('Choose a valid ' + field.label + '.');
    if (field.type === 'number' && value !== undefined && value !== '') {
      if (!Number.isFinite(Number(value))) throw new Error(field.label + ' must be a number.');
      result[field.key] = Number(value);
    }
  });
  return result;
}

function dmvDate_(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')))
    throw new Error('Use dates in YYYY-MM-DD format.');
  var date = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error('Choose a valid date.');
  return date;
}

function dmvDateRange_(range, today) {
  range = range || { preset: 'last30' };
  var day = dmvDate_(today);
  var end = new Date(day.getTime() - 86400000);
  var start;
  switch (range.preset || 'last30') {
    case 'yesterday':
      start = end;
      break;
    case 'last7':
      start = new Date(end.getTime() - 6 * 86400000);
      break;
    case 'last14':
      start = new Date(end.getTime() - 13 * 86400000);
      break;
    case 'last30':
      start = new Date(end.getTime() - 29 * 86400000);
      break;
    case 'last90':
      start = new Date(end.getTime() - 89 * 86400000);
      break;
    case 'lastWeek':
    case 'previousWeek':
      // Complete Monday-to-Sunday weeks: last week, or the week immediately before it.
      end = new Date(
        day.getTime() -
          (((day.getUTCDay() + 6) % 7) + 1 + (range.preset === 'previousWeek' ? 7 : 0)) * 86400000
      );
      start = new Date(end.getTime() - 6 * 86400000);
      break;
    case 'thisYear':
      start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1, 12));
      end = day;
      break;
    case 'lastYear':
      start = new Date(Date.UTC(day.getUTCFullYear() - 1, 0, 1, 12));
      end = new Date(Date.UTC(day.getUTCFullYear() - 1, 11, 31, 12));
      break;
    case 'thisMonth':
      start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1, 12));
      end = day;
      break;
    case 'lastMonth':
      start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1, 12));
      end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 0, 12));
      break;
    case 'custom':
      start = dmvDate_(range.startDate);
      end = dmvDate_(range.endDate);
      break;
    default:
      throw new Error('Choose a supported date range.');
  }
  if (start > end) throw new Error('The start date must be before the end date.');
  if ((end - start) / 86400000 > 365)
    throw new Error('Use a date range of one year or less for Sheets.');
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function dmvCell_(address) {
  var match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(String(address || 'A1').toUpperCase());
  if (!match) throw new Error('Choose a starting cell such as A1.');
  var column = 0;
  for (var i = 0; i < match[1].length; i++) column = column * 26 + match[1].charCodeAt(i) - 64;
  if (column > 18278) throw new Error('The starting column is outside Google Sheets.');
  return { row: Number(match[2]), column: column, a1: match[0] };
}

function dmvRectanglesOverlap_(a, b) {
  return (
    a.sheetId === b.sheetId &&
    a.row < b.row + b.rows &&
    b.row < a.row + a.rows &&
    a.column < b.column + b.columns &&
    b.column < a.column + a.columns
  );
}

function dmvSheetValue_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A report returned an invalid numeric value.');
    return value;
  }
  if (typeof value === 'boolean') return value;
  var text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (text.length > 49000) throw new Error('A report value is too large for a Sheets cell.');
  // The writer sends explicit stringValue cells, so formula-like text stays unchanged.
  return text;
}

function dmvNormalizeResult_(result, maxRows) {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows))
    throw new Error('The connector returned an invalid report.');
  if (!result.columns.length || result.columns.length > DMV_LIMITS.maxColumns)
    throw new Error('Choose between 1 and ' + DMV_LIMITS.maxColumns + ' output fields.');
  if (
    result.rows.length > maxRows ||
    result.truncated ||
    result.complete === false ||
    (result.metadata && (result.metadata.truncated || result.metadata.complete === false))
  )
    throw new Error(
      'The report exceeds the row limit. Narrow the date range or filters; existing data was kept.'
    );
  var seen = Object.create(null);
  result.columns.forEach(function (column) {
    if (!column.key || seen[column.key])
      throw new Error('The connector returned duplicate or missing column keys.');
    seen[column.key] = true;
  });
  var matrix = [
    result.columns.map(function (column) {
      return dmvSheetValue_(String(column.label || column.key));
    }),
  ];
  result.rows.forEach(function (row) {
    if (!row || Array.isArray(row) || typeof row !== 'object')
      throw new Error('The connector returned an invalid row.');
    matrix.push(
      result.columns.map(function (column) {
        return dmvSheetValue_(row[column.key]);
      })
    );
  });
  if (JSON.stringify(matrix).length > DMV_LIMITS.maxBytes)
    throw new Error(
      'This report is too large for one refresh. Select fewer fields or a shorter date range.'
    );
  return {
    columns: result.columns,
    rows: result.rows,
    matrix: matrix,
    metadata: result.metadata || {},
  };
}

function dmvSafeError_(error, credentials) {
  var message =
    error && error.message ? String(error.message) : 'The report could not be completed.';
  Object.keys(credentials || {}).forEach(function (key) {
    var value = credentials[key];
    if (typeof value === 'string' && value.length >= 6)
      message = message.split(value).join('[redacted]');
  });
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(access_token|token|password|key)=([^\s&]+)/gi, '$1=[redacted]')
    .slice(0, 400);
}

function dmvDefaultFields_(fields) {
  var marked = fields.some(function (field) {
    return typeof field.default === 'boolean';
  });
  return fields
    .filter(function (field) {
      return marked ? field.default === true : field.default !== false;
    })
    .map(function (field) {
      return field.key;
    });
}
