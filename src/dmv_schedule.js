/* One hourly trigger per user and spreadsheet drives hourly, daily and weekly refreshes. */
function dmvNextRun_(schedule) {
  var hours = { hourly: 1, daily: 24, weekly: 168 }[schedule];
  return hours ? Date.now() + hours * 3600000 : null;
}

// In a Marketplace add-on, triggers and the active spreadsheet belong to the document where the
// trigger was created, so scheduling is decided and executed per spreadsheet.
function dmvScheduledReports_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  return dmvList_('report').filter(function (report) {
    return !active || report.spreadsheetId === active.getId();
  });
}

function dmvEnsureSchedule_() {
  var enabled = dmvScheduledReports_().some(function (report) {
    return report.schedule !== 'manual' || dmvPendingReport_(report);
  });
  var triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'dmvRefreshScheduled';
  });
  if (enabled && !triggers.length)
    ScriptApp.newTrigger('dmvRefreshScheduled').timeBased().everyHours(1).create();
  triggers.forEach(function (trigger, index) {
    if (!enabled || index > 0) ScriptApp.deleteTrigger(trigger);
  });
}

function dmvRefreshScheduled() {
  var started = Date.now();
  var due = dmvScheduledReports_()
    .filter(function (report) {
      return (
        (report.schedule !== 'manual' || dmvPendingReport_(report)) &&
        (!report.nextRunAt || report.nextRunAt <= started)
      );
    })
    .sort(function (a, b) {
      return (a.nextRunAt || 0) - (b.nextRunAt || 0);
    });
  // Leave enough execution budget for a complete report; remaining due reports wait for the next tick.
  for (var i = 0; i < due.length && Date.now() - started < 45000; i++) {
    try {
      dmvExecuteReport_(due[i]);
    } catch (error) {
      /* Sanitized failure is stored with the report. */
    }
  }
  dmvLocked_(dmvEnsureSchedule_);
}
