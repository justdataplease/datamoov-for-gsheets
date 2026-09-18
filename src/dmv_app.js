/** Production entry points for the DataMoov Sheets interface. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DataMoov')
    .addItem('Open DataMoov', 'showSidebar')
    .addItem('Refresh reports', 'dmvRefreshAll')
    .addToUi();
}

function onInstall() {
  onOpen();
}

function showSidebar() {
  var html = HtmlService.createTemplateFromFile('dmv_sidebar').evaluate().setTitle('DataMoov');
  SpreadsheetApp.getUi().showSidebar(html);
}

function include(filename) {
  if (['dmv_styles', 'dmv_client'].indexOf(filename) < 0) {
    throw new Error('Unknown DataMoov template.');
  }
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
