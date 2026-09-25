/* One hourly trigger per user and spreadsheet drives hourly, daily and weekly refreshes of
   reports and dashboards. */
function dmvSchedule_(value) {
  var schedule = value || 'manual';
  if (['manual', 'hourly', 'daily', 'weekly'].indexOf(schedule) < 0)
    throw new Error('Choose a supported refresh schedule.');
  return schedule;
}

// A daily or weekly schedule names the hour of the spreadsheet's day it runs in, a weekly one
// also its weekday (1 Monday to 7 Sunday). The hourly trigger then runs it within that hour.
function dmvScheduleAt_(schedule, value) {
  if (schedule !== 'daily' && schedule !== 'weekly') return null;
  var at = value && typeof value === 'object' ? value : {};
  var result = { hour: dmvInteger_(at.hour === undefined ? 6 : at.hour, 0, 23, 'Refresh hour') };
  if (schedule === 'weekly')
    result.weekday = dmvInteger_(
      at.weekday === undefined ? 1 : at.weekday,
      1,
      7,
      'Refresh weekday'
    );
  return result;
}

function dmvNextRun_(schedule, at, timezone) {
  var hours = { hourly: 1, daily: 24, weekly: 168 }[schedule];
  if (!hours) return null;
  if (!at || !timezone) return Date.now() + hours * 3600000;
  // The first top of an hour after now whose local hour (and weekday) match.
  var time = (Math.floor(Date.now() / 3600000) + 1) * 3600000;
  for (var i = 0; i < 168; i++, time += 3600000) {
    var local = Utilities.formatDate(new Date(time), timezone, 'yyyy-MM-dd H').split(' ');
    var weekday = ((new Date(local[0] + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
    if (Number(local[1]) === at.hour && (at.weekday === undefined || weekday === at.weekday))
      return time;
  }
  return Date.now() + hours * 3600000;
}

// When a schedule is saved: hourly starts at the next tick, daily and weekly at their hour.
function dmvFirstRun_(schedule, at, timezone) {
  return schedule === 'hourly' ? Date.now() : dmvNextRun_(schedule, at, timezone);
}

// In a Marketplace add-on, triggers and the active spreadsheet belong to the document where the
// trigger was created, so scheduling is decided and executed per spreadsheet.
function dmvScheduledReports_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  return dmvList_('report').filter(function (report) {
    return !active || report.spreadsheetId === active.getId();
  });
}

function dmvScheduledDashboards_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  return dmvList_('dashboard').filter(function (dashboard) {
    return (!active || dashboard.spreadsheetId === active.getId()) && dashboard.schedule;
  });
}

function dmvEnsureSchedule_() {
  var enabled =
    dmvScheduledReports_().some(function (report) {
      return report.schedule !== 'manual' || dmvPendingReport_(report);
    }) ||
    dmvScheduledDashboards_().some(function (dashboard) {
      return dashboard.schedule !== 'manual';
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
  // A dashboard refresh may use its whole budget, so one runs per tick, and only when the
  // reports left enough of the execution; the others wait for the next hour.
  var dashboards = dmvScheduledDashboards_()
    .filter(function (dashboard) {
      return dashboard.schedule !== 'manual' && !(dashboard.nextRunAt > started);
    })
    .sort(function (a, b) {
      return (a.nextRunAt || 0) - (b.nextRunAt || 0);
    });
  if (dashboards.length && Date.now() - started < 60000) {
    try {
      dmvRunDashboard(dashboards[0].id);
    } catch (error) {
      /* Sanitized failure is stored with the dashboard. */
    }
  }
  dmvLocked_(dmvEnsureSchedule_);
}
