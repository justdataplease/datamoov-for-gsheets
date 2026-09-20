/** Entry points. Runs as a Google Workspace Marketplace add-on or as a script bound to one spreadsheet. */
function onOpen(e) {
  // Add-ons open before authorization (AuthMode.NONE), so only the Extensions menu is built here.
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem('Open DataMoov', 'showSidebar')
    .addItem('Refresh reports', 'dmvRefreshAll')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  var html = HtmlService.createTemplateFromFile('dmv_sidebar').evaluate().setTitle('DataMoov');
  SpreadsheetApp.getUi().showSidebar(html);
}

function include(filename) {
  if (['dmv_styles', 'dmv_client', 'dmv_client_chat'].indexOf(filename) < 0) {
    throw new Error('Unknown DataMoov template.');
  }
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
