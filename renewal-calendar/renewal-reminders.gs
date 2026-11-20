/**
 * GTM Talent - Renewal reminders (Google Apps Script, bound to the
 * "GTM Talent - Software Inventory" sheet)                       version 0.3.0
 *
 * Every morning it reads the "Charge calendar" tab (every expected bank charge
 * for the next 12 months, built by formulas from the Inventory tab) and the
 * Inventory tab itself, and:
 *   1. keeps a Google Calendar "GTM Talent - Renewals" in step with it: an
 *      all-day event on each charge date, and a 09:00 reminder event the
 *      lead time (30 days, cell K1 of the tab) before it. Tools that are
 *      cancelled or change amount or date are updated or removed;
 *   2. emails a reminder when charges enter the 30-day window: one email
 *      per day at most, listing each charge once, with the total to have on
 *      the card. The first run sends one catch-up email for everything
 *      already inside the window;
 *   3. warns before contract deadlines, so a tool can be cancelled in time
 *      instead of only paid in time. For contracts that lock you in (annual
 *      or quarterly plans, or monthly billing on an annual commitment):
 *        - with a Cancel-by date: alerts 60, 30, 14, 7 and 1 days before it;
 *        - with an unknown notice period: alerts 90, 60, 30 and 14 days before
 *          the renewal date, to check the contract.
 *      Each deadline also gets a calendar event with pop-ups a week before and
 *      on the day. Setting the tool's Status to Cancelled stops its alerts.
 *
 * Google limits how fast a script may create calendar events. Writes are
 * paced, and if Google still says "too many", the run stops cleanly and a
 * one-off continuation runs RETRY_MINUTES later; events already created are
 * recognised by their tag, so nothing is duplicated. The email is sent before
 * the calendar is touched, so a calendar problem never blocks a reminder.
 *
 * Nothing in the sheet is changed. Setup: see README.md in this folder.
 */

const CONFIG = {
  TAB: 'Charge calendar',
  LEAD_CELL: 'K1',                         // reminder lead time in days, on the tab
  CALENDAR_NAME: 'GTM Talent - Renewals',
  TIMEZONE: 'Europe/Amsterdam',
  REMINDER_TIME: '09:00',                  // time of the reminder event
  RUN_HOUR: 7,                             // the daily run, before the reminder event
  RECIPIENTS: [],                          // empty = the account that runs the script
  TAG: 'gtm-renewal-key:',                 // marks events this script owns
  WRITE_PAUSE_MS: 700,                     // pause after each calendar write (Google rate limit)
  RETRY_MINUTES: 20,                       // continue this long after Google says "too many"
  MAX_RUN_MS: 4.5 * 60 * 1000,             // Apps Script stops runs at 6 min; continue later instead
  INVENTORY_TAB: 'Inventory',
  DEADLINE_ALERT_DAYS: [60, 30, 14, 7, 1],     // before a Cancel-by date
  UNKNOWN_NOTICE_ALERT_DAYS: [90, 60, 30, 14], // before a renewal whose notice period is unknown
};

// Inventory columns are found by their header text, so moving a column is safe.
const INV = {
  TOOL: 'Tool', CYCLE: 'Billing cycle', RENEWAL: 'Renewal date', NOTICE: 'Notice period',
  CANCEL_BY: 'Cancel-by', STATUS: 'Status', MONTHLY: 'Monthly cost (EUR)',
};

// Column positions on the Charge calendar tab (1-based).
const COL = { DATE: 1, REMINDER: 3, TOOL: 4, AMOUNT: 5, STATUS: 6, METHOD: 7 };

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Run once by hand: checks the tab, creates the daily trigger, runs once. */
function setup() {
  console.log('1/5 Reading the Charge calendar tab');
  readCharges_();                                   // fails early if the tab is missing
  console.log('2/5 Installing the daily trigger');
  try {
    removeTriggers_('dailyRun');
    ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1)
      .atHour(CONFIG.RUN_HOUR).inTimezone(CONFIG.TIMEZONE).create();
  } catch (e) {
    // Do not stop here: the reminders can still go out. Retry setup later.
    console.error(`Daily trigger not installed (${errorText_(e)}). Run setup again later; ` +
                  'until then, run dailyRun by hand.');
  }
  dailyRun();
}

/** Run by the daily trigger. Safe to run any number of times. */
function dailyRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const { charges, lead } = readCharges_();
    const today = dayKey_(new Date());
    console.log(`3/5 Reminder email (${charges.length} charges in the sheet, lead ${lead} days)`);
    let sent = 'failed';
    let failure = null;
    try {
      sent = sendReminders_(charges, lead, today);          // email first: never blocked by the calendar
    } catch (e) {
      failure = `Reminder email failed: ${errorText_(e)}`;
      console.error(failure);
    }
    console.log('4/5 Contract deadlines (Inventory tab)');
    let deadlines = [];
    let alerted = 'failed';
    try {
      deadlines = readDeadlines_();
      alerted = sendDeadlineAlerts_(deadlines, today);
    } catch (e) {
      failure = failure || `Deadline alerts failed: ${errorText_(e)}`;
      console.error(`Deadline alerts failed: ${errorText_(e)}`);
    }
    console.log('5/5 Calendar "' + CONFIG.CALENDAR_NAME + '"');
    let result = { created: 0, updated: 0, deleted: 0, stopped: '' };
    try {
      result = syncCalendar_(charges, today, deadlines);
    } catch (e) {
      // Google's unexplained "unknown error" is usually temporary: continue later.
      result.stopped = `calendar error: ${errorText_(e)}`;
      failure = failure || `Calendar failed: ${errorText_(e)}`;
    }
    let note = '';
    if (result.stopped) {
      const minutes = result.stopped === 'run time limit' ? 1 : CONFIG.RETRY_MINUTES;
      try {
        scheduleContinuation_(minutes);
        note = ` Calendar not finished (${result.stopped}); continuing in ${minutes} minute(s).`;
      } catch (e) {
        note = ` Calendar not finished (${result.stopped}); could not schedule the continuation ` +
               `(${errorText_(e)}): tomorrow's run continues.`;
      }
    }
    console.log(`Reminder email: ${sent} charge(s). Deadline alerts: ${alerted} ` +
                `(${deadlines.length} deadline(s) tracked). Calendar: ${result.created} created, ` +
                `${result.updated} updated, ${result.deleted} removed.${note}`);
    if (failure && (sent === 'failed' || alerted === 'failed')) {
      throw new Error(failure);                                   // so Google emails a failure notice
    }
  } finally {
    lock.releaseLock();
  }
}

/** One-off follow-up run after Google's calendar rate limit or the time limit. */
function continueSync() {
  removeTriggers_('continueSync');
  dailyRun();
}

function scheduleContinuation_(minutes) {
  removeTriggers_('continueSync');
  ScriptApp.newTrigger('continueSync').timeBased().after(minutes * 60 * 1000).create();
}

function removeTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ---------------------------------------------------------------------------
// Reading the sheet
// ---------------------------------------------------------------------------

function readCharges_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.TAB);
  if (!sheet) throw new Error(`Tab "${CONFIG.TAB}" not found in this spreadsheet.`);
  const lead = Number(sheet.getRange(CONFIG.LEAD_CELL).getValue());
  if (!(lead > 0)) throw new Error(`${CONFIG.TAB}!${CONFIG.LEAD_CELL} must be a number of days.`);
  const last = sheet.getLastRow();
  const rows = last >= 2 ? sheet.getRange(2, 1, last - 1, 8).getValues() : [];
  return { charges: parseCharges_(rows, lead), lead };
}

/** Rows -> [{key, date, reminder, tool, amount, status, method}], skipping blank or broken rows. */
function parseCharges_(rows, lead) {
  const seen = {};
  const out = [];
  for (const r of rows) {
    const d = r[COL.DATE - 1];
    const tool = String(r[COL.TOOL - 1] || '').trim();
    if (Object.prototype.toString.call(d) !== '[object Date]' || isNaN(d.getTime()) || !tool) continue;
    const date = dayKey_(d);
    let key = `${tool}|${date}`;
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] > 1) key += `#${seen[key]}`;     // same tool twice on one day
    const amount = Number(r[COL.AMOUNT - 1]);
    out.push({
      key, date, reminder: addDays_(date, -lead), tool,
      amount: isFinite(amount) ? amount : 0,
      status: String(r[COL.STATUS - 1] || ''),
      method: String(r[COL.METHOD - 1] || ''),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function getCalendar_() {
  const found = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME);
  return found.length ? found[0]
    : CalendarApp.createCalendar(CONFIG.CALENDAR_NAME, { timeZone: CONFIG.TIMEZONE });
}

function errorText_(e) {
  return String(e && e.message ? e.message : e);
}

function isRateLimit_(e) {
  return /too many|rate limit|quota|try again later|limit exceeded/i.test(String(e && e.message || e));
}

/**
 * Create, update or remove this script's events so they match the charges from
 * today on. Stops early, with result.stopped set, on Google's rate limit or
 * near the run time limit; the next run picks up where this one stopped.
 */
function syncCalendar_(charges, today, deadlines) {
  const started = Date.now();
  const result = { created: 0, updated: 0, deleted: 0, stopped: '' };
  const write = (fn) => {           // every calendar write goes through here
    const out = fn();
    Utilities.sleep(CONFIG.WRITE_PAUSE_MS);
    return out;
  };
  try {
    syncEvents_(charges, today, result, write, started, deadlines || []);
  } catch (e) {
    if (!isRateLimit_(e)) throw e;
    result.stopped = 'Google calendar rate limit';
  }
  return result;
}

function syncEvents_(charges, today, result, write, started, deadlines) {
  const cal = getCalendar_();
  const from = parseDay_(today);
  const until = parseDay_(addDays_(today, 400));
  const existing = {};
  for (const ev of cal.getEvents(from, until)) {
    const id = tagOf_(ev.getDescription());
    if (id) {
      if (existing[id]) write(() => existing[id].deleteEvent());   // stray duplicate
      existing[id] = ev;
    }
  }
  const wanted = {};
  for (const c of charges) {
    if (c.date < today) continue;
    wanted[`${c.key}|charge`] = { c, kind: 'charge', on: c.date };
    if (c.reminder >= today) wanted[`${c.key}|reminder`] = { c, kind: 'reminder', on: c.reminder };
  }
  for (const d of deadlines) {
    if (d.date >= today) wanted[d.key] = { c: d, kind: 'deadline', on: d.date };
  }
  // Soonest first, so the events that matter now exist even if a run stops early.
  const ids = Object.keys(wanted).sort((a, b) => (wanted[a].on < wanted[b].on ? -1 : wanted[a].on > wanted[b].on ? 1 : 0));
  for (const id of ids) {
    if (Date.now() - started > CONFIG.MAX_RUN_MS) { result.stopped = 'run time limit'; return; }
    const { c, kind } = wanted[id];
    const spec = eventSpec_(c, kind, id);
    const ev = existing[id];
    if (!ev) {
      const created = write(() => (kind === 'charge'
        ? cal.createAllDayEvent(spec.title, parseDay_(c.date), { description: spec.description })
        : cal.createEvent(spec.title, spec.start, spec.end, { description: spec.description })));
      result.created++;
      write(() => created.removeAllReminders());
      if (kind !== 'charge') write(() => created.addPopupReminder(0));
      if (kind === 'deadline') write(() => created.addPopupReminder(7 * 24 * 60));   // a week before
      continue;
    }
    let changed = false;
    if (ev.getTitle() !== spec.title) { write(() => ev.setTitle(spec.title)); changed = true; }
    if (ev.getDescription() !== spec.description) { write(() => ev.setDescription(spec.description)); changed = true; }
    if (kind !== 'charge' && ev.getStartTime().getTime() !== spec.start.getTime()) {
      write(() => ev.setTime(spec.start, spec.end)); changed = true;
    }
    if (changed) result.updated++;
  }
  for (const id of Object.keys(existing)) {
    if (Date.now() - started > CONFIG.MAX_RUN_MS) { result.stopped = 'run time limit'; return; }
    if (!wanted[id]) { write(() => existing[id].deleteEvent()); result.deleted++; }
  }
}

function eventSpec_(c, kind, id) {
  if (kind === 'deadline') return deadlineEventSpec_(c, id);
  const money = euro_(c.amount);
  const failed = /payment failed/i.test(c.status);
  const lines = [
    `${c.tool}: ${money} expected on ${longDate_(c.date)}.`,
    `Payment method: ${c.method || 'unknown'}.`,
    failed ? 'The last payment for this tool failed: check the card balance before then.' : `Status: ${c.status}.`,
    `Source: GTM Talent - Software Inventory, ${CONFIG.TAB} tab.`,
    '',
    CONFIG.TAG + id,
  ];
  if (kind === 'charge') {
    return { title: `Charge: ${c.tool} ${money}`, description: lines.join('\n') };
  }
  const start = parseDateTime_(c.reminder, CONFIG.REMINDER_TIME);
  return {
    title: `In ${daysBetween_(c.reminder, c.date)} days: ${c.tool} ${money} on ${shortDate_(c.date)}`,
    description: lines.join('\n'),
    start, end: new Date(start.getTime() + 15 * 60 * 1000),
  };
}

function tagOf_(description) {
  // The tag runs to the end of its line: tool names contain spaces.
  const m = String(description || '').match(new RegExp(CONFIG.TAG + '(.+)'));
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Contract deadlines
// ---------------------------------------------------------------------------

/** Deadlines from the Inventory tab; [] (with a log line) if the tab or a column is missing. */
function readDeadlines_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(CONFIG.INVENTORY_TAB);
  if (!sheet) {
    console.warn(`Tab "${CONFIG.INVENTORY_TAB}" not found: no contract deadline alerts.`);
    return [];
  }
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0].map(h => String(h).trim());
  const missing = Object.values(INV).filter(h => header.indexOf(h) === -1);
  if (missing.length) {
    console.warn(`Inventory columns not found (${missing.join(', ')}): no contract deadline alerts.`);
    return [];
  }
  return parseDeadlines_(values.slice(1), header);
}

/**
 * One deadline per contract that locks you in:
 *   kind 'cancel-by'      - Cancel-by date known: the last day to cancel;
 *   kind 'unknown-notice' - no Cancel-by but the notice period is unknown:
 *                           the renewal date, so someone checks the contract.
 * Monthly self-serve tools are left out: they can be cancelled any month.
 */
function parseDeadlines_(rows, header) {
  const col = (name) => header.indexOf(name);
  const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
  const out = [];
  for (const r of rows) {
    const tool = String(r[col(INV.TOOL)] || '').trim();
    const status = String(r[col(INV.STATUS)] || '').trim();
    if (!tool || /^cancelled$/i.test(status)) continue;
    const cycle = String(r[col(INV.CYCLE)] || '');
    if (!/annual|quarter|year|contract|commitment/i.test(cycle)) continue;
    const notice = String(r[col(INV.NOTICE)] || '').trim();
    const renewal = isDate(r[col(INV.RENEWAL)]) ? dayKey_(r[col(INV.RENEWAL)]) : '';
    const cancelBy = isDate(r[col(INV.CANCEL_BY)]) ? dayKey_(r[col(INV.CANCEL_BY)]) : '';
    const monthly = Number(r[col(INV.MONTHLY)]);
    const yearly = isFinite(monthly) && monthly > 0 ? Math.round(monthly * 12 * 100) / 100 : null;
    const base = { tool, status, cycle, notice, renewal, yearly };
    if (cancelBy) {
      out.push(Object.assign(base, { kind: 'cancel-by', date: cancelBy,
        key: `cancel-by|${tool}|${cancelBy}`, thresholds: CONFIG.DEADLINE_ALERT_DAYS }));
    } else if (renewal && /unknown/i.test(notice)) {
      out.push(Object.assign(base, { kind: 'unknown-notice', date: renewal,
        key: `unknown-notice|${tool}|${renewal}`, thresholds: CONFIG.UNKNOWN_NOTICE_ALERT_DAYS }));
    }
  }
  return out;
}

/**
 * Email the deadlines that crossed an alert threshold (e.g. 60 days) since the
 * last alert for them. A deadline found late (say 20 days out) gets one alert
 * at the nearest threshold, not a burst for every threshold it already passed.
 * Returns how many deadlines were in the email (0 = nothing sent).
 */
function sendDeadlineAlerts_(deadlines, today) {
  const props = PropertiesService.getScriptProperties();
  const sent = JSON.parse(props.getProperty('deadlineSent') || '{}');   // key -> smallest threshold alerted
  for (const k of Object.keys(sent)) {
    if ((k.split('|')[2] || '') < today) delete sent[k];               // passed deadlines
  }
  const due = [];
  for (const d of deadlines) {
    const days = daysBetween_(today, d.date);
    if (days < 0) continue;
    const crossed = d.thresholds.filter(t => days <= t);
    if (!crossed.length) continue;
    const threshold = Math.min(...crossed);
    if (sent[d.key] !== undefined && sent[d.key] <= threshold) continue;
    due.push(Object.assign({}, d, { days, threshold }));
  }
  if (!due.length) {
    props.setProperty('deadlineSent', JSON.stringify(sent));
    return 0;
  }
  due.sort((a, b) => a.days - b.days);
  const mail = buildDeadlineEmail_(due);
  const to = (CONFIG.RECIPIENTS.length ? CONFIG.RECIPIENTS : [Session.getEffectiveUser().getEmail()]).join(',');
  MailApp.sendEmail({ to, subject: mail.subject, body: mail.text, htmlBody: mail.html });
  for (const d of due) sent[d.key] = d.threshold;
  props.setProperty('deadlineSent', JSON.stringify(sent));
  return due.length;
}

function daysText_(n) {
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
}

function deadlineLine_(d) {
  const cost = d.yearly ? ` About ${euro_(d.yearly)} a year.` : '';
  if (d.kind === 'cancel-by') {
    const renews = d.renewal ? ` or it renews on ${longDate_(d.renewal)}` : '';
    return `${d.tool}: cancel by ${longDate_(d.date)} (${daysText_(d.days)})${renews}. ` +
           `Notice period: ${d.notice || 'not recorded'}.${cost}`;
  }
  return `${d.tool}: renews on ${longDate_(d.date)} (${daysText_(d.days)}) and the notice period is unknown. ` +
         `Check the contract now: if the notice period is longer than ${d.days} days, the deadline has already passed.${cost}`;
}

function buildDeadlineEmail_(due) {
  const first = due[0];
  const subject = due.length === 1
    ? (first.kind === 'cancel-by'
      ? `Decision needed: cancel ${first.tool} by ${shortDate_(first.date)} (${daysText_(first.days)})`
      : `Decision needed: ${first.tool} renews ${shortDate_(first.date)}, notice period unknown`)
    : `Decision needed: ${due.length} contract deadlines, first ${first.tool} ${daysText_(first.days)}`;
  const intro = 'These contracts renew automatically unless they are cancelled in time. ' +
                'Decide now whether to keep them.';
  const outro = 'Already cancelled or decided to keep it? Set the Status on the Inventory tab ' +
                '(Cancelled stops these alerts) and add the confirmation to Notes. ' +
                'Source: GTM Talent - Software Inventory, Inventory tab.';
  const lines = due.map(deadlineLine_);
  const text = [intro, '', ...lines.map(l => `- ${l}`), '', outro].join('\n');
  const html = `<p>${escape_(intro)}</p><ul style="font-family:Arial;font-size:13px">` +
    lines.map(l => `<li style="margin-bottom:6px">${escape_(l)}</li>`).join('') +
    `</ul><p style="font-size:12px;color:#555">${escape_(outro)}</p>`;
  return { subject, text, html };
}

function deadlineEventSpec_(d, id) {
  const start = parseDateTime_(d.date, CONFIG.REMINDER_TIME);
  const title = d.kind === 'cancel-by'
    ? `Cancel-by: ${d.tool}` + (d.renewal ? ` (renews ${shortDate_(d.renewal)})` : '')
    : `Renews, notice unknown: ${d.tool}`;
  const lines = [
    deadlineLine_(Object.assign({}, d, { days: daysBetween_(d.date, d.date) }))
      .replace(/ \(today\)/, ''),
    'Set the Status on the Inventory tab to Cancelled once it is cancelled.',
    '',
    CONFIG.TAG + id,
  ];
  return { title, description: lines.join('\n'), start, end: new Date(start.getTime() + 15 * 60 * 1000) };
}

// ---------------------------------------------------------------------------
// Reminder email
// ---------------------------------------------------------------------------

/**
 * Email the charges whose reminder date has arrived and that were not emailed
 * before. On the first run that is everything already inside the window.
 * Returns how many charges were in the email (0 = nothing sent).
 */
function sendReminders_(charges, lead, today) {
  const props = PropertiesService.getScriptProperties();
  const sent = JSON.parse(props.getProperty('sent') || '{}');
  const due = charges.filter(c => c.date >= today && c.reminder <= today && !sent[c.key]);
  // Forget charges that have passed so the store stays small.
  for (const k of Object.keys(sent)) if (sent[k] < today) delete sent[k];
  if (!due.length) {
    props.setProperty('sent', JSON.stringify(sent));
    return 0;
  }
  const windowEnd = addDays_(today, lead);
  const inWindow = charges.filter(c => c.date >= today && c.date <= windowEnd);
  const mail = buildEmail_(due, inWindow, lead, today);
  const to = (CONFIG.RECIPIENTS.length ? CONFIG.RECIPIENTS : [Session.getEffectiveUser().getEmail()]).join(',');
  MailApp.sendEmail({ to, subject: mail.subject, body: mail.text, htmlBody: mail.html });
  for (const c of due) sent[c.key] = c.date;
  props.setProperty('sent', JSON.stringify(sent));
  return due.length;
}

function buildEmail_(due, inWindow, lead, today) {
  const total = sum_(due.map(c => c.amount));
  const windowTotal = sum_(inWindow.map(c => c.amount));
  const failed = due.filter(c => /payment failed/i.test(c.status));
  const first = due[0].date;
  const last = due[due.length - 1].date;
  const when = first === last ? shortDate_(first) : `${shortDate_(first)} - ${shortDate_(last)}`;
  const subject = `Renewals: ${euro_(total)} will be charged ${when} (${due.length} ${due.length === 1 ? 'charge' : 'charges'})`;
  const sorted = due.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const rowsText = sorted.map(c =>
    `- ${longDate_(c.date)}  ${c.tool}  ${euro_(c.amount)}  (${c.method || 'payment method unknown'})` +
    (/payment failed/i.test(c.status) ? '  LAST PAYMENT FAILED' : ''));
  const intro = `These charges are due within the next ${lead} days. Make sure the account or card has the money.`;
  const outro = [
    `Total of these: ${euro_(total)}.`,
    `Everything due in the next ${lead} days (including charges already reminded): ${euro_(windowTotal)}.`,
    failed.length ? `${failed.length} of these tools had a failed payment last time: ${failed.map(c => c.tool).join(', ')}.` : '',
    'Source: GTM Talent - Software Inventory, Charge calendar tab. Change the lead time in cell K1.',
  ].filter(Boolean);
  const text = [intro, '', ...rowsText, '', ...outro].join('\n');
  const td = 'style="padding:4px 10px;border-bottom:1px solid #ddd"';
  const html =
    `<p>${escape_(intro)}</p><table style="border-collapse:collapse;font-family:Arial;font-size:13px">` +
    `<tr><th ${td} align="left">Charge date</th><th ${td} align="left">Tool</th>` +
    `<th ${td} align="right">Amount</th><th ${td} align="left">Paid with</th><th ${td} align="left">Note</th></tr>` +
    sorted.map(c => `<tr><td ${td}>${longDate_(c.date)}</td><td ${td}>${escape_(c.tool)}</td>` +
      `<td ${td} align="right">${euro_(c.amount)}</td><td ${td}>${escape_(c.method || 'unknown')}</td>` +
      `<td ${td}>${/payment failed/i.test(c.status) ? '<b style="color:#c00">Last payment failed</b>' : ''}</td></tr>`).join('') +
    `</table><p>${outro.map(escape_).join('<br>')}</p>`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Date and money helpers (days are 'yyyy-MM-dd' strings in CONFIG.TIMEZONE)
// ---------------------------------------------------------------------------

function dayKey_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function parseDay_(day) {
  return Utilities.parseDate(day, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function parseDateTime_(day, time) {
  return Utilities.parseDate(`${day} ${time}`, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
}

/** Calendar arithmetic on day strings, independent of time zones and DST. */
function addDays_(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

function daysBetween_(a, b) {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shortDate_(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

function longDate_(day) {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]} ${d} ${MONTHS[m - 1]} ${y}`;
}

function euro_(n) {
  const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '€' + s;
}

function sum_(xs) {
  return Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
}

function escape_(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

if (typeof module !== 'undefined') {   // Node test harness only; ignored by Apps Script
  module.exports = { CONFIG, parseCharges_, syncCalendar_, sendReminders_, buildEmail_, dailyRun, setup, continueSync,
                     parseDeadlines_, sendDeadlineAlerts_, buildDeadlineEmail_,
                     addDays_, daysBetween_, longDate_, euro_ };
}
