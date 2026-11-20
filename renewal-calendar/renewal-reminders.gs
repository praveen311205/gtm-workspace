/**
 * GTM Talent - Renewal reminders (Google Apps Script, bound to the
 * "GTM Talent - Software Inventory" sheet)                       version 0.1.0
 *
 * Every morning it reads the "Charge calendar" tab (every expected bank charge
 * for the next 12 months, built by formulas from the Inventory tab) and:
 *   1. keeps a Google Calendar "GTM Talent - Renewals" in step with it: an
 *      all-day event on each charge date, and a 09:00 reminder event the
 *      lead time (30 days, cell K1 of the tab) before it. Tools that are
 *      cancelled or change amount or date are updated or removed;
 *   2. emails a reminder when charges enter the 30-day window: one email
 *      per day at most, listing each charge once, with the total to have on
 *      the card. The first run sends one catch-up email for everything
 *      already inside the window.
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
};

// Column positions on the Charge calendar tab (1-based).
const COL = { DATE: 1, REMINDER: 3, TOOL: 4, AMOUNT: 5, STATUS: 6, METHOD: 7 };

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Run once by hand: checks the tab, creates the daily trigger, runs once. */
function setup() {
  readCharges_();                                   // fails early if the tab is missing
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyRun')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1)
    .atHour(CONFIG.RUN_HOUR).inTimezone(CONFIG.TIMEZONE).create();
  dailyRun();
}

/** Run by the daily trigger. Safe to run any number of times. */
function dailyRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const { charges, lead } = readCharges_();
    const today = dayKey_(new Date());
    const result = syncCalendar_(charges, today);
    const sent = sendReminders_(charges, lead, today);
    console.log(`Calendar: ${result.created} created, ${result.updated} updated, ` +
                `${result.deleted} removed. Reminder email: ${sent} charge(s).`);
  } finally {
    lock.releaseLock();
  }
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

/** Create, update or remove this script's events so they match the charges from today on. */
function syncCalendar_(charges, today) {
  const cal = getCalendar_();
  const from = parseDay_(today);
  const until = parseDay_(addDays_(today, 400));
  const existing = {};
  for (const ev of cal.getEvents(from, until)) {
    const id = tagOf_(ev.getDescription());
    if (id) {
      if (existing[id]) existing[id].deleteEvent();         // stray duplicate
      existing[id] = ev;
    }
  }
  const wanted = {};
  for (const c of charges) {
    if (c.date < today) continue;
    wanted[`${c.key}|charge`] = { c, kind: 'charge' };
    if (c.reminder >= today) wanted[`${c.key}|reminder`] = { c, kind: 'reminder' };
  }
  const result = { created: 0, updated: 0, deleted: 0 };
  for (const id of Object.keys(wanted)) {
    const { c, kind } = wanted[id];
    const spec = eventSpec_(c, kind, id);
    const ev = existing[id];
    if (!ev) {
      const created = kind === 'charge'
        ? cal.createAllDayEvent(spec.title, parseDay_(c.date), { description: spec.description })
        : cal.createEvent(spec.title, spec.start, spec.end, { description: spec.description });
      created.removeAllReminders();
      if (kind === 'reminder') created.addPopupReminder(0);
      result.created++;
      continue;
    }
    let changed = false;
    if (ev.getTitle() !== spec.title) { ev.setTitle(spec.title); changed = true; }
    if (ev.getDescription() !== spec.description) { ev.setDescription(spec.description); changed = true; }
    if (kind === 'reminder' && ev.getStartTime().getTime() !== spec.start.getTime()) {
      ev.setTime(spec.start, spec.end); changed = true;
    }
    if (changed) result.updated++;
  }
  for (const id of Object.keys(existing)) {
    if (!wanted[id]) { existing[id].deleteEvent(); result.deleted++; }
  }
  return result;
}

function eventSpec_(c, kind, id) {
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
  module.exports = { CONFIG, parseCharges_, syncCalendar_, sendReminders_, buildEmail_, dailyRun, setup,
                     addDays_, daysBetween_, longDate_, euro_ };
}
