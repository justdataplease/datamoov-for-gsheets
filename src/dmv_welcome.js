/* The page a first-time user lands on: what DataMoov does, and the order to do it in. */
var DMV_WELCOME_SHEET = 'Start here';

// Deliberately names no data source. The sidebar already lists what is connectable, and that
// list changes; these steps do not.
function dmvWelcomeRows_() {
  return [
    ['title', 'DataMoov'],
    ['tagline', 'YOUR DATA, IN SHEETS  ·  by JustDataPlease'],
    ['blank', ''],
    [
      'body',
      'DataMoov brings the numbers you report on into this spreadsheet, and lets you ask ' +
        'questions about them in plain language.',
    ],
    [
      'body',
      'There is no DataMoov server. You connect an account with your own credentials, and every ' +
        'request goes straight from this spreadsheet to that service. Your keys and your data ' +
        'stay inside your Google account.',
    ],
    ['blank', ''],
    ['section', '1  ·  Connect an account'],
    [
      'body',
      'Open the Connections tab in the sidebar and press +. Choose a data source, name the ' +
        'connection, and supply the credential it asks for. Each source carries a “How to get ' +
        'these credentials” guide that links straight to the right console. DataMoov tests the ' +
        'connection before it saves it.',
    ],
    [
      'body',
      'A credential is saved once under Settings and reused by as many connections as you like, ' +
        'so an agency key is entered a single time.',
    ],
    ['blank', ''],
    ['section', '2  ·  Build a report'],
    [
      'body',
      'Reports ▸ New report. Choose the source, the connection, the report and the date range, ' +
        'tick the columns you want, then say which tab and cell it should land on. Preview data ' +
        'shows you the first rows before anything is written.',
    ],
    ['blank', ''],
    ['section', '3  ·  Keep it up to date'],
    [
      'body',
      'Give the report a refresh: on demand, hourly, daily or weekly. A refresh replaces exactly ' +
        'the cells that report wrote last time and leaves every other cell alone. Edit a cell ' +
        'inside that range and DataMoov stops rather than overwrite your work.',
    ],
    ['blank', ''],
    ['section', '4  ·  Ask instead of building'],
    [
      'body',
      'Add an AI key under Settings, then open the Chat tab and ask in plain language — for ' +
        'example, “which campaign had the highest spend last month?”. Chat runs a real report to ' +
        'answer, shows you what it ran, and can write the result to its own tab.',
    ],
    ['blank', ''],
    ['section', '5  ·  Turn it into a dashboard'],
    [
      'body',
      'Ask chat for a dashboard. It saves the datasets and tiles as a plan, writes a laid-out ' +
        'page with scorecards, tables and native charts, and refreshes all of it in one go.',
    ],
    ['blank', ''],
    ['section', 'Worth knowing'],
    [
      'body',
      '·  Your connections, reports and dashboards are private to you. Sharing this spreadsheet ' +
        'shares the output, never your credentials or your schedules.',
    ],
    [
      'body',
      '·  A report too large to fetch in one run pauses and resumes by itself rather than ' +
        'writing half the data.',
    ],
    ['body', '·  You can delete this tab whenever you like. DataMoov will not put it back.'],
    ['blank', ''],
    ['muted', 'Created with ♥ by justdataplease.com'],
  ];
}

var DMV_WELCOME_STYLES = {
  title: { size: 20, bold: true, color: '#5146d6' },
  tagline: { size: 9, bold: true, color: '#6c7488' },
  section: { size: 12, bold: true, color: '#172033' },
  body: { size: 10, bold: false, color: '#3c4457' },
  muted: { size: 9, bold: false, color: '#9a9faf' },
  blank: { size: 10, bold: false, color: '#3c4457' },
};

function dmvWelcomeKey_(spreadsheetId) {
  return 'dmv:v1:welcome:' + spreadsheetId;
}

// Tab titles straight from the server. A Spreadsheet object this execution already holds
// never learns about tabs another session created, and would report the page as missing.
function dmvSheetTitles_(spreadsheetId) {
  var response = Sheets.Spreadsheets.get(spreadsheetId, { fields: 'sheets.properties.title' });
  return ((response && response.sheets) || []).map(function (item) {
    return String((item.properties || {}).title || '');
  });
}

// Offered once per user per spreadsheet. Someone who deletes the tab is not given it again,
// and a workbook that already carries the page - a colleague opened DataMoov first - is left
// alone. The record is written only once the page exists, so a failed write is retried.
function dmvEnsureWelcome_(spreadsheet) {
  var properties = dmvStore_();
  var key = dmvWelcomeKey_(spreadsheet.getId());
  if (properties.getProperty(key)) return null;
  return dmvWorkbookLocked_(function () {
    if (dmvSheetTitles_(spreadsheet.getId()).indexOf(DMV_WELCOME_SHEET) >= 0) {
      properties.setProperty(key, 'existing');
      return null;
    }
    var written = dmvWriteWelcome_(spreadsheet);
    properties.setProperty(key, new Date().toISOString());
    return written;
  });
}

// Bootstrap is a read. It only says whether this user has been offered the page in this
// workbook, so opening the sidebar never writes a cell or a private record.
function dmvWelcomeOffer_(spreadsheet) {
  try {
    return {
      offer: !dmvStore_().getProperty(dmvWelcomeKey_(spreadsheet.getId())),
      sheetName: DMV_WELCOME_SHEET,
    };
  } catch (ignored) {
    return { offer: false, sheetName: DMV_WELCOME_SHEET };
  }
}

// Called by the sidebar on a first open. Returns the page it wrote, or null when there was
// nothing to do; guidance is never worth a failed boot, so it does not throw.
function dmvCreateWelcome() {
  try {
    return dmvEnsureWelcome_(dmvSpreadsheet_());
  } catch (ignored) {
    return null;
  }
}

// One batchUpdate: the tab, its width, its gridlines and every styled line arrive together,
// so a failure leaves no half-written page behind.
function dmvWriteWelcome_(spreadsheet) {
  var rows = dmvWelcomeRows_();
  var grids = dmvGridSizes_(spreadsheet.getId());
  var sheetId = parseInt(dmvOutputDigest_(Utilities.getUuid()).slice(0, 7), 16);
  while (grids[sheetId]) sheetId++;
  var requests = [
    {
      addSheet: {
        properties: {
          sheetId: sheetId,
          title: DMV_WELCOME_SHEET,
          tabColor: dmvWelcomeColor_('#5146d6'),
          gridProperties: {
            rowCount: rows.length + 10,
            columnCount: 4,
            hideGridlines: true,
          },
        },
      },
    },
    {
      updateDimensionProperties: {
        range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 760 },
        fields: 'pixelSize',
      },
    },
  ];
  rows.forEach(function (row, index) {
    var style = DMV_WELCOME_STYLES[row[0]] || DMV_WELCOME_STYLES.body;
    requests.push({
      updateCells: {
        start: { sheetId: sheetId, rowIndex: index, columnIndex: 0 },
        rows: [
          {
            values: [
              {
                userEnteredValue: { stringValue: row[1] },
                userEnteredFormat: {
                  wrapStrategy: 'WRAP',
                  verticalAlignment: 'MIDDLE',
                  textFormat: {
                    fontSize: style.size,
                    bold: style.bold,
                    foregroundColor: dmvWelcomeColor_(style.color),
                  },
                },
              },
            ],
          },
        ],
        fields: 'userEnteredValue,userEnteredFormat(wrapStrategy,verticalAlignment,textFormat)',
      },
    });
  });
  Sheets.Spreadsheets.batchUpdate({ requests: requests }, spreadsheet.getId());
  // The tab exists on the server; the Spreadsheet object this execution holds has not seen it.
  dmvTry_(function () {
    var reopened = dmvReopen_(spreadsheet);
    var sheet = reopened.getSheetByName(DMV_WELCOME_SHEET);
    if (sheet) reopened.setActiveSheet(sheet);
  });
  return {
    sheetName: DMV_WELCOME_SHEET,
    url: dmvSheetUrl_(spreadsheet, sheetId, 'A1'),
  };
}

function dmvWelcomeColor_(hex) {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255,
  };
}

function dmvTry_(callback) {
  try {
    callback();
  } catch (ignored) {
    // Cosmetic only.
  }
}
