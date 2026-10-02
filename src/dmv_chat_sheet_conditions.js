/* Conditions shared by pivot filters and conditional formats, and the conditional_format tool:
   add, list and delete rules of one tab, run through dmvChatSheetRunAction_ so each add or delete
   gets an undo entry. Rules change no cell values, so like format they need no inspection.
   API contract: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/sheets#conditionalformatrule */
// Condition types of pivot filters and conditional formats, and the Sheets type of each.
// date_between has no Sheets type that formatting accepts, so it becomes a custom formula built
// here; custom_formula and date_between apply to conditional formats only.
var DMV_SHEET_CONDITIONS = {
  number_gt: 'NUMBER_GREATER',
  number_gte: 'NUMBER_GREATER_THAN_EQ',
  number_lt: 'NUMBER_LESS',
  number_lte: 'NUMBER_LESS_THAN_EQ',
  number_eq: 'NUMBER_EQ',
  number_ne: 'NUMBER_NOT_EQ',
  number_between: 'NUMBER_BETWEEN',
  number_not_between: 'NUMBER_NOT_BETWEEN',
  text_contains: 'TEXT_CONTAINS',
  text_not_contains: 'TEXT_NOT_CONTAINS',
  text_starts_with: 'TEXT_STARTS_WITH',
  text_ends_with: 'TEXT_ENDS_WITH',
  text_eq: 'TEXT_EQ',
  date_eq: 'DATE_EQ',
  date_before: 'DATE_BEFORE',
  date_after: 'DATE_AFTER',
  date_between: 'CUSTOM_FORMULA',
  blank: 'BLANK',
  not_blank: 'NOT_BLANK',
  custom_formula: 'CUSTOM_FORMULA',
};

var DMV_SHEET_RELATIVE_DATES = {
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  tomorrow: 'TOMORROW',
  past_week: 'PAST_WEEK',
  past_month: 'PAST_MONTH',
  past_year: 'PAST_YEAR',
};

var DMV_SHEET_MAX_LISTED_RULES = 50;

// The chat tools of this file, listed by dmvChatSheetExtraTools_.
function dmvChatSheetConditionTools_() {
  return [dmvChatSheetRuleTool_()];
}

/* Conditions */

function dmvChatSheetConditionTypes_(formatting) {
  return Object.keys(DMV_SHEET_CONDITIONS).filter(function (type) {
    return formatting || (type !== 'date_between' && type !== 'custom_formula');
  });
}

function dmvChatSheetConditionSchema_(formatting) {
  var scalar = [{ type: 'string' }, { type: 'number' }];
  return {
    type: 'object',
    properties: {
      type: { type: 'string', enum: dmvChatSheetConditionTypes_(formatting) },
      value: {
        anyOf: scalar,
        description:
          'Number for number_*; text for text_*; YYYY-MM-DD, today, yesterday, tomorrow, past_week, past_month or past_year for date_*' +
          (formatting
            ? '; for custom_formula the formula as for the top-left cell of range (=$E2>50).'
            : '.'),
      },
      value2: { anyOf: scalar, description: 'The upper bound of a between condition.' },
    },
    required: ['type'],
    additionalProperties: false,
  };
}

function dmvChatSheetNumber_(value, label) {
  if (typeof value === 'string' && /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/.test(value))
    value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(label + ' must be a number.');
  return value;
}

// A number as a ConditionValue or InterpolationPoint value. Sheets parses these as typed in the
// spreadsheet's locale, where 1.5 may need a comma; a formula always takes a dot, so a number
// that is not whole goes as one. Whole numbers read the same in every locale.
function dmvChatSheetNumberValue_(value) {
  return Number.isSafeInteger(value) ? String(value) : '=' + String(value);
}

// A YYYY-MM-DD date as a Sheets DATE formula, which reads the same in every spreadsheet locale.
function dmvChatSheetDateFormula_(value) {
  var match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  var date = match && new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (!match || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3])
    return null;
  return 'DATE(' + +match[1] + ',' + +match[2] + ',' + +match[3] + ')';
}

// A BooleanCondition from { type, value, value2 }. Text values never start with =, which Sheets
// would read as a formula; the only formulas are the numbers and dates built here and a custom
// formula, which passes the same checks as set_formulas.
// options: { formatting, session, sheet, grid } (the rule's range, for formulas).
function dmvChatSheetCondition_(condition, options) {
  dmvChatSheetObject_(condition, ['type', 'value', 'value2']);
  var types = dmvChatSheetConditionTypes_(options.formatting);
  if (types.indexOf(condition.type) < 0)
    throw new Error(
      (condition.type === 'date_between' || condition.type === 'custom_formula'
        ? 'A pivot filter cannot use ' + condition.type + '. '
        : '') +
        'Choose a condition type: ' +
        types.join(', ') +
        '.'
    );
  var type = condition.type,
    kind = type.split('_')[0],
    between = /between$/.test(type),
    output = { type: DMV_SHEET_CONDITIONS[type] };
  if (type === 'blank' || type === 'not_blank') {
    if (condition.value !== undefined || condition.value2 !== undefined)
      throw new Error(type + ' takes no value.');
    return output;
  }
  if (condition.value === undefined) throw new Error(type + ' needs a value.');
  if (between !== (condition.value2 !== undefined))
    throw new Error(
      between ? type + ' needs value and value2.' : 'value2 is for between conditions only.'
    );
  if (kind === 'number') {
    var low = dmvChatSheetNumber_(condition.value, 'The condition value');
    output.values = [{ userEnteredValue: dmvChatSheetNumberValue_(low) }];
    if (between) {
      var high = dmvChatSheetNumber_(condition.value2, 'value2');
      if (high < low) throw new Error('value2 must not be below value.');
      output.values.push({ userEnteredValue: dmvChatSheetNumberValue_(high) });
    }
    return output;
  }
  if (kind === 'text') {
    if (
      typeof condition.value !== 'string' ||
      !condition.value.length ||
      condition.value.length > 500
    )
      throw new Error('A text condition needs text of 1 to 500 characters.');
    // Sheets reads a condition value as typed, so text starting with = or + would be a formula
    // that the custom_formula checks never saw, and "+44" would be the number 44.
    if (/^[=+]/.test(condition.value.trim()))
      throw new Error(
        'A text condition value cannot start with = or +, which Sheets reads as a formula. ' +
          (options.formatting ? 'Use custom_formula instead.' : 'Choose other text.')
      );
    output.values = [{ userEnteredValue: condition.value }];
    return output;
  }
  if (type === 'custom_formula') {
    output.values = [
      {
        userEnteredValue: dmvChatSheetRuleFormula_(
          options.session,
          options.sheet,
          options.grid,
          condition.value
        ),
      },
    ];
    return output;
  }
  var dateHelp =
    'Dates are YYYY-MM-DD' +
    (between ? '.' : ', or today, yesterday, tomorrow, past_week, past_month or past_year.');
  if (between) {
    var from = dmvChatSheetDateFormula_(condition.value),
      to = dmvChatSheetDateFormula_(condition.value2);
    if (!from || !to) throw new Error(dateHelp);
    if (condition.value2 < condition.value) throw new Error('value2 must not be before value.');
    // Each cell is compared with the dates through a reference relative to the range's
    // top-left cell; the end day counts in full.
    var cell = dmvChatA1_(
      (options.grid.startRowIndex || 0) + 1,
      (options.grid.startColumnIndex || 0) + 1
    );
    output.values = [
      {
        userEnteredValue:
          '=AND(ISNUMBER(' + cell + '),' + cell + '>=' + from + ',' + cell + '<' + to + '+1)',
      },
    ];
    return output;
  }
  var date = dmvChatSheetDateFormula_(condition.value);
  if (date) output.values = [{ userEnteredValue: '=' + date }];
  else if (Object.prototype.hasOwnProperty.call(DMV_SHEET_RELATIVE_DATES, condition.value))
    output.values = [{ relativeDate: DMV_SHEET_RELATIVE_DATES[condition.value] }];
  else throw new Error(dateHelp);
  return output;
}

// The formula of a custom_formula rule, checked like set_formulas (built-ins except the denylist)
// but without other tabs, which conditional-format formulas cannot refer to. A rule never fills
// cells, so there is no spill check.
function dmvChatSheetRuleFormula_(session, sheet, grid, formula) {
  if (typeof formula !== 'string' || formula.charAt(0) !== '=')
    throw new Error('A custom formula is text beginning with =.');
  dmvChatSheetFormulaCheck_(session, formula, {
    sheet: sheet,
    cell: dmvChatA1_((grid.startRowIndex || 0) + 1, (grid.startColumnIndex || 0) + 1),
    otherTabs: false,
  });
  return formula;
}

function dmvChatSheetHex_(style, color) {
  var rgb = (style && style.rgbColor) || color;
  if (!rgb) return style && style.themeColor ? 'theme ' + style.themeColor : undefined;
  return (
    '#' +
    ['red', 'green', 'blue']
      .map(function (part) {
        return ('0' + Math.round((rgb[part] || 0) * 255).toString(16)).slice(-2);
      })
      .join('')
  );
}

/* Conditional formats */

// A rule range on one tab: one cell, a bounded range, columns to the last row (D2:D) or whole
// columns (D:F).
function dmvChatSheetRuleRange_(sheet, text) {
  var range = dmvChatSheetOpenRange_(sheet, text);
  if (!range)
    throw new Error(
      'Use an A1 range of this tab, such as D2:D500, D2:D (to the last row) or D:F (whole columns).'
    );
  return range;
}

// A1 text on sheet whose rows may be open, as rule ranges, dropdown sources and named ranges
// allow: one cell, a bounded range, D2:D or D:F, as { grid, a1 }. An open range has no end row, as
// in the Sheets API. null when the text is no such range.
function dmvChatSheetOpenRange_(sheet, text) {
  var match =
    typeof text === 'string' &&
    /^([A-Za-z]{1,3})([1-9][0-9]{0,6})?(?::([A-Za-z]{1,3})([1-9][0-9]{0,6})?)?$/.exec(text);
  if (!match || (!match[2] && (match[4] || !match[3]))) return null;
  var first = dmvCell_(match[1] + (match[2] || '1')),
    last = match[3] ? dmvCell_(match[3] + (match[4] || '1')) : first;
  var grid = {
    sheetId: sheet.getSheetId(),
    startColumnIndex: first.column - 1,
    endColumnIndex: last.column,
  };
  if (match[2]) grid.startRowIndex = first.row - 1;
  if (match[4] || !match[3]) grid.endRowIndex = last.row;
  if (
    last.column < first.column ||
    (grid.endRowIndex !== undefined && last.row < first.row) ||
    last.column > sheet.getMaxColumns() ||
    (grid.endRowIndex !== undefined ? last.row : first.row) > sheet.getMaxRows()
  )
    throw new Error('The range must run forward and fit inside the existing sheet grid.');
  return { grid: grid, a1: dmvChatSheetRuleA1_(grid) };
}

// The A1 of a GridRange whose rows may be open, such as D2:D or D:F.
function dmvChatSheetRuleA1_(grid) {
  if (grid.endRowIndex !== undefined && grid.endColumnIndex !== undefined)
    return dmvChatGridA1_(grid);
  function column(index) {
    return dmvChatA1_(1, index + 1).slice(0, -1);
  }
  return (
    column(grid.startColumnIndex || 0) +
    (grid.startRowIndex ? grid.startRowIndex + 1 : '') +
    ':' +
    (grid.endColumnIndex !== undefined ? column(grid.endColumnIndex - 1) : '') +
    (grid.endRowIndex !== undefined ? grid.endRowIndex : '')
  );
}

function dmvChatSheetRuleOverlap_(a, b) {
  function apart(low, high, otherLow, otherHigh) {
    return (
      (high !== undefined && high <= (otherLow || 0)) ||
      (otherHigh !== undefined && otherHigh <= (low || 0))
    );
  }
  return (
    // The API leaves out a zero sheetId.
    (a.sheetId || 0) === (b.sheetId || 0) &&
    !apart(a.startRowIndex, a.endRowIndex, b.startRowIndex, b.endRowIndex) &&
    !apart(a.startColumnIndex, a.endColumnIndex, b.startColumnIndex, b.endColumnIndex)
  );
}

function dmvChatSheetRuleFormat_(input) {
  dmvChatSheetObject_(input, ['backgroundColor', 'textColor', 'bold', 'italic', 'strikethrough']);
  if (!Object.keys(input).length)
    throw new Error(
      'Choose at least one of backgroundColor, textColor, bold, italic or strikethrough.'
    );
  var format = {},
    text = {};
  if (input.backgroundColor !== undefined)
    format.backgroundColorStyle = {
      rgbColor: dmvChatSheetColor_(input.backgroundColor, 'backgroundColor'),
    };
  if (input.textColor !== undefined)
    text.foregroundColorStyle = { rgbColor: dmvChatSheetColor_(input.textColor, 'textColor') };
  ['bold', 'italic', 'strikethrough'].forEach(function (key) {
    if (input[key] === undefined) return;
    if (typeof input[key] !== 'boolean') throw new Error(key + ' must be true or false.');
    text[key] = input[key];
  });
  if (Object.keys(text).length) format.textFormat = text;
  return format;
}

function dmvChatSheetRuleScale_(scale) {
  dmvChatSheetObject_(scale, ['min', 'mid', 'max']);
  if (!scale.min || !scale.max)
    throw new Error('A colour scale needs min and max points; mid is optional.');
  function point(input, name, types) {
    dmvChatSheetObject_(input, ['type', 'value', 'color']);
    if (types.indexOf(input.type) < 0)
      throw new Error('The ' + name + ' point type is one of ' + types.join(', ') + '.');
    var output = {
      colorStyle: { rgbColor: dmvChatSheetColor_(input.color, 'The ' + name + ' color') },
      type: input.type.toUpperCase(),
    };
    if (input.type === 'min' || input.type === 'max') {
      if (input.value !== undefined)
        throw new Error('The ' + name + ' point of type ' + input.type + ' takes no value.');
      return output;
    }
    var value = dmvChatSheetNumber_(input.value, 'The ' + name + ' point value');
    if (input.type !== 'number' && (value < 0 || value > 100))
      throw new Error('Percent and percentile points are from 0 to 100.');
    output.value = dmvChatSheetNumberValue_(value);
    return output;
  }
  var rule = { minpoint: point(scale.min, 'min', ['min', 'number', 'percent', 'percentile']) };
  if (scale.mid !== undefined)
    rule.midpoint = point(scale.mid, 'mid', ['number', 'percent', 'percentile']);
  rule.maxpoint = point(scale.max, 'max', ['max', 'number', 'percent', 'percentile']);
  return rule;
}

// The tab's conditional format rules in priority order, as the API returns them.
function dmvChatSheetRules_(session, sheet) {
  dmvChatSheetDeadline_(session);
  var result = Sheets.Spreadsheets.get(session.spreadsheetId, {
    ranges: ["'" + sheet.getName().replace(/'/g, "''") + "'!A1"],
    fields: 'sheets(properties(sheetId),conditionalFormats)',
  });
  var entry = ((result && result.sheets) || []).filter(function (item) {
    return item.properties && item.properties.sheetId === sheet.getSheetId();
  })[0];
  return (entry && entry.conditionalFormats) || [];
}

// A rule's id is a digest of the rule itself, so it stays valid while rules are added or
// reordered, and stops matching once the rule changes.
function dmvChatSheetRuleId_(rule) {
  return 'r' + dmvOutputDigest_(dmvCanonical_(rule)).slice(0, 12);
}

function dmvChatSheetRuleSummary_(rule, index) {
  var summary = {
    ruleId: dmvChatSheetRuleId_(rule),
    priority: index + 1,
    ranges: (rule.ranges || []).map(dmvChatSheetRuleA1_),
  };
  if (rule.booleanRule) {
    var condition = rule.booleanRule.condition || {},
      format = rule.booleanRule.format || {},
      text = format.textFormat || {};
    summary.condition = [condition.type]
      .concat(
        (condition.values || []).map(function (value) {
          return value.relativeDate || value.userEnteredValue;
        })
      )
      .join(' ')
      .slice(0, 200);
    summary.format = {
      backgroundColor: dmvChatSheetHex_(format.backgroundColorStyle, format.backgroundColor),
      textColor: dmvChatSheetHex_(text.foregroundColorStyle, text.foregroundColor),
      bold: text.bold,
      italic: text.italic,
      strikethrough: text.strikethrough,
    };
  } else if (rule.gradientRule) {
    summary.scale = ['minpoint', 'midpoint', 'maxpoint']
      .filter(function (key) {
        return rule.gradientRule[key];
      })
      .map(function (key) {
        var point = rule.gradientRule[key];
        return [
          String(point.type || '').toLowerCase(),
          point.value,
          dmvChatSheetHex_(point.colorStyle, point.color),
        ]
          .filter(function (item) {
            return item !== undefined && item !== '';
          })
          .join(' ');
      })
      .join(', ');
  }
  return summary;
}

function dmvChatSheetRuleAdd_(context) {
  var session = context.session,
    input = context.input,
    sheet = context.sheet;
  if (input.ruleId !== undefined) throw new Error('ruleId is for delete only.');
  var range = dmvChatSheetRuleRange_(sheet, input.range);
  if ((input.condition === undefined) === (input.scale === undefined))
    throw new Error('Give either a condition with a format, or a colour scale.');
  var rule = { ranges: [range.grid] };
  if (input.condition !== undefined) {
    if (input.format === undefined)
      throw new Error(
        'A condition needs a format: backgroundColor, textColor, bold, italic or strikethrough.'
      );
    rule.booleanRule = {
      condition: dmvChatSheetCondition_(input.condition, {
        formatting: true,
        session: session,
        sheet: sheet,
        grid: range.grid,
      }),
      format: dmvChatSheetRuleFormat_(input.format),
    };
  } else {
    if (input.format !== undefined)
      throw new Error('A colour scale sets its own colours; leave out format.');
    rule.gradientRule = dmvChatSheetRuleScale_(input.scale);
  }
  // A new rule goes last, as in the Sheets editor; earlier rules on the same cells win.
  var rules = dmvChatSheetRules_(session, sheet);
  var earlier = rules.filter(function (other) {
    return (other.ranges || []).some(function (grid) {
      return dmvChatSheetRuleOverlap_(grid, range.grid);
    });
  }).length;
  var summary = dmvChatSheetRuleSummary_(rule, rules.length);
  return {
    requests: [{ addConditionalFormatRule: { rule: rule, index: rules.length } }],
    touches: [],
    // Undo removes the rule at the position it was added in, while the tab's rules are as
    // this edit left them.
    undo: {
      reverse: [
        { deleteConditionalFormatRule: { sheetId: sheet.getSheetId(), index: rules.length } },
      ],
      verify: [],
      rules: sheet.getSheetId(),
    },
    range: range.a1,
    text: 'Added conditional formatting to ' + sheet.getName() + '!' + range.a1,
    details: [['Rule', summary.condition || 'colour scale ' + summary.scale]],
    result: {
      change: 'added',
      rule: summary.condition || 'colour scale ' + summary.scale,
      rulesOnTab: rules.length + 1,
      note: earlier
        ? earlier +
          ' earlier rule' +
          (earlier === 1 ? ' covers' : 's cover') +
          ' some of these cells and comes first where both apply.'
        : undefined,
    },
  };
}

function dmvChatSheetRuleDelete_(context) {
  var session = context.session,
    input = context.input,
    sheet = context.sheet;
  if (
    ['range', 'condition', 'format', 'scale'].some(function (key) {
      return input[key] !== undefined;
    })
  )
    throw new Error('delete takes sheetName and ruleId only.');
  if (typeof input.ruleId !== 'string' || !/^r[a-f0-9]{12}$/.test(input.ruleId))
    throw new Error('Use a ruleId exactly as list returns it.');
  var rules = dmvChatSheetRules_(session, sheet);
  var index = rules.map(dmvChatSheetRuleId_).indexOf(input.ruleId);
  if (index < 0)
    throw new Error(
      'No conditional format rule on "' +
        sheet.getName() +
        '" has that ruleId now. Use list to see the current rules.'
    );
  var summary = dmvChatSheetRuleSummary_(rules[index], index);
  var range = summary.ranges.join(', ');
  return {
    requests: [{ deleteConditionalFormatRule: { sheetId: sheet.getSheetId(), index: index } }],
    touches: [],
    undo: {
      reverse: [{ addConditionalFormatRule: { rule: rules[index], index: index } }],
      verify: [],
      rules: sheet.getSheetId(),
    },
    range: range,
    text: 'Removed a conditional format rule from ' + sheet.getName() + (range ? '!' + range : ''),
    details: [['Rule', summary.condition || 'colour scale ' + summary.scale]],
    result: { change: 'deleted', ruleId: input.ruleId, rulesOnTab: rules.length - 1 },
  };
}

function dmvChatConditionalFormat_(session, input) {
  dmvChatSheetObject_(input, [
    'action',
    'sheetName',
    'range',
    'condition',
    'format',
    'scale',
    'ruleId',
  ]);
  if (input.action === 'list') {
    if (
      ['range', 'condition', 'format', 'scale', 'ruleId'].some(function (key) {
        return input[key] !== undefined;
      })
    )
      throw new Error('list takes sheetName only.');
    dmvChatSheetDeadline_(session);
    var sheet = dmvChatSheetTarget_(session, input.sheetName);
    var rules = dmvChatSheetRules_(session, sheet);
    session.events.push({
      kind: 'summary',
      text: 'Listed conditional formatting on ' + sheet.getName(),
    });
    return {
      sheetName: sheet.getName(),
      total: rules.length,
      rules: rules.slice(0, DMV_SHEET_MAX_LISTED_RULES).map(dmvChatSheetRuleSummary_),
      note:
        rules.length > DMV_SHEET_MAX_LISTED_RULES
          ? 'Showing the first ' + DMV_SHEET_MAX_LISTED_RULES + ' rules.'
          : 'Rules apply in priority order; the first that matches a cell wins.',
    };
  }
  if (input.action !== 'add' && input.action !== 'delete')
    throw new Error('Choose add, list or delete.');
  // Add and delete run through the edit pipeline: the lock, an undo entry, the single batch,
  // the write event and the output link. They change no cell values, so like other formatting
  // they need no inspection and are allowed over report output, which a refresh keeps.
  var change = { action: 'conditional_format', sheetName: input.sheetName };
  ['range', 'condition', 'format', 'scale', 'ruleId'].forEach(function (key) {
    if (input[key] !== undefined) change[key] = input[key];
  });
  return dmvChatSheetRunAction_(session, change, {
    target: 'sheet',
    fields: ['range', 'condition', 'format', 'scale', 'ruleId'],
    plan: input.action === 'add' ? dmvChatSheetRuleAdd_ : dmvChatSheetRuleDelete_,
  });
}

function dmvChatSheetRuleTool_() {
  var color = { type: 'string', description: '#RRGGBB' };
  var point = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['min', 'max', 'number', 'percent', 'percentile'] },
      value: { type: 'number', description: 'For number, percent or percentile (0-100).' },
      color: color,
    },
    required: ['type', 'color'],
    additionalProperties: false,
  };
  return {
    name: 'conditional_format',
    label: 'Updating conditional formatting',
    description:
      'Add, list or delete conditional formatting rules of one tab. add colours a range by a condition (number, text or date compare, blank, or a custom formula checked like set_formulas) with a format, or by a 2- or 3-point colour scale; the rule follows the values as they change and goes after existing rules. list returns each rule with its ruleId; delete removes one by ruleId. No inspection needed; undo_sheet_edit reverses add and delete.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'delete'] },
        sheetName: { type: 'string' },
        range: {
          type: 'string',
          description: 'add: such as D2:D500, D2:D (to the last row) or D:F.',
        },
        condition: dmvChatSheetConditionSchema_(true),
        format: {
          type: 'object',
          properties: {
            backgroundColor: color,
            textColor: color,
            bold: { type: 'boolean' },
            italic: { type: 'boolean' },
            strikethrough: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        scale: {
          type: 'object',
          description: 'Instead of condition and format. mid is optional.',
          properties: { min: point, mid: point, max: point },
          required: ['min', 'max'],
          additionalProperties: false,
        },
        ruleId: { type: 'string', description: 'delete: an id from list.' },
      },
      required: ['action', 'sheetName'],
      additionalProperties: false,
    },
    run: dmvChatConditionalFormat_,
  };
}
