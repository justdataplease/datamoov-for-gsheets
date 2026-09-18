/* One hourly trigger per user drives hourly, daily and weekly refreshes. */
function dmvNextRun_(schedule) {
  var hours = { hourly: 1, daily: 24, weekly: 168 }[schedule];
  return hours ? Date.now() + hours * 3600000 : null;
}

function dmvEnsureSchedule_() {
  var enabled = dmvList_('report').some(function (report) {
    return report.schedule !== 'manual';
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
  var due = dmvList_('report')
    .filter(function (report) {
      return report.schedule !== 'manual' && (!report.nextRunAt || report.nextRunAt <= started);
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
}
