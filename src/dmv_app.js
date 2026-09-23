/** Entry points. Runs as a Google Workspace Marketplace add-on or as a script bound to one spreadsheet. */
function onOpen(e) {
  // Add-ons open before authorization (AuthMode.NONE), so only the Extensions menu is built here.
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem('Launch Sidebar', 'showSidebar')
    .addItem('Launch Window', 'showWindow')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  var html = HtmlService.createTemplateFromFile('dmv_sidebar')
    .evaluate()
    .setTitle('DataMoov by JustDataPlease');
  SpreadsheetApp.getUi().showSidebar(html);
}

// Sheets sidebars are fixed at 300 px; the same UI in a modeless window keeps the sheet usable.
function showWindow() {
  var html = HtmlService.createTemplateFromFile('dmv_sidebar')
    .evaluate()
    .setTitle('DataMoov by JustDataPlease')
    .setWidth(520)
    .setHeight(760);
  SpreadsheetApp.getUi().showModelessDialog(html, 'DataMoov by JustDataPlease');
}

function include(filename) {
  if (['dmv_styles', 'dmv_client', 'dmv_client_chat'].indexOf(filename) < 0) {
    throw new Error('Unknown DataMoov template.');
  }
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
