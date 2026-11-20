/**
 * Tests for renewal-reminders.gs, run with Node (no Google account needed):
 *
 *     node renewal-calendar/tests/reminders.test.js
 *
 * SpreadsheetApp, CalendarApp, MailApp and the other Apps Script services are
 * replaced by in-memory fakes, and the clock is set per scenario.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = path.join(__dirname, '..', 'renewal-reminders.gs');
let passed = 0;
function check(cond, what) {
  if (!cond) { console.error(`FAIL: ${what}`); process.exit(1); }
  passed++;
  console.log(`  ok  ${what}`);
}

// ---------------------------------------------------------------- time zone helpers

function wall(d, tz) {   // {y,m,d,H,M} of instant d in tz
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute };
}
function fromWall(y, m, d, H, M, tz) {   // the instant whose wall time in tz is y-m-d H:M
  let t = Date.UTC(y, m - 1, d, H, M);
  for (let i = 0; i < 3; i++) {
    const w = wall(new Date(t), tz);
    t += Date.UTC(y, m - 1, d, H, M) - Date.UTC(w.y, w.m - 1, w.d, w.H, w.M);
  }
  return t;
}
const AMS = 'Europe/Amsterdam';
const day = (s) => new Date(fromWall(...s.split('-').map(Number), 0, 0, AMS));   // sheet dates are local midnight

// ---------------------------------------------------------------- fakes

function makeEnv({ rows, lead = 30, now, props = {}, calendar = null, tab = true, lockFree = true,
                   writeLimit = Infinity, triggers = [] }) {
  let NOW = new Date(now).getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  }
  const mails = [];
  const logs = [];
  const store = Object.assign({}, props);
  const cal = calendar || { events: [], created: 0 };
  let nextId = cal.events.length + 1;
  let writes = 0;
  const limited = (fn) => (...args) => {     // Google's "too many" after writeLimit writes
    if (++writes > writeLimit) {
      throw new Error('You have been creating or deleting too many calendars or calendar events in a short time. Please try again later.');
    }
    return fn(...args);
  };
  const makeEvent = (title, start, end, desc, allDay) => {
    const ev = {
      id: nextId++, title, start, end, desc, allDay, reminders: [], deleted: false,
      getTitle() { return this.title; }, setTitle: limited(function (t) { ev.title = t; }),
      getDescription() { return this.desc; }, setDescription: limited(function (d) { ev.desc = d; }),
      getStartTime() { return this.start; }, setTime: limited(function (s, e) { ev.start = s; ev.end = e; }),
      deleteEvent: limited(function () { ev.deleted = true; }),
      removeAllReminders: limited(function () { ev.reminders = []; }),
      addPopupReminder: limited(function (m) { ev.reminders.push(m); }),
    };
    cal.events.push(ev);
    return ev;
  };
  const calendarApi = {
    getEvents: (from, until) => cal.events.filter(e => !e.deleted && e.start >= from && e.start < until),
    createAllDayEvent: limited((t, d, o) => makeEvent(t, d, new RealDate(d.getTime() + 864e5), o.description, true)),
    createEvent: limited((t, s, e, o) => makeEvent(t, s, e, o.description, false)),
  };
  const sheetRows = rows;
  const env = {
    console: { log: (m) => logs.push(m), warn() {}, error() {} },
    Date: FakeDate,
    Session: { getEffectiveUser: () => ({ getEmail: () => 'praveen@gtmtalent.tech' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; } }) },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: (n) => (tab && n === 'Charge calendar' ? {
      getRange: (a, b, c, d) => (typeof a === 'string'
        ? { getValue: () => lead }
        : { getValues: () => sheetRows.slice(a - 2, a - 2 + c).map(r => r.slice(0, d)) }),
      getLastRow: () => sheetRows.length + 1,
    } : null) }) },
    CalendarApp: {
      getCalendarsByName: () => (cal.exists ? [calendarApi] : []),
      createCalendar: () => { cal.exists = true; cal.created++; return calendarApi; },
    },
    MailApp: { sendEmail: (m) => mails.push(m) },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (handler) => {
        const t = { handler, getHandlerFunction: () => handler };
        const done = { create() { triggers.push(t); return t; } };
        return { timeBased: () => ({
          after: (ms) => { t.afterMs = ms; return done; },
          everyDays: () => ({ atHour: () => ({ inTimezone: () => done }) }) }) };
      },
    },
    Utilities: {
      sleep: () => {},
      formatDate: (d, tz, fmt) => {
        const w = wall(d, tz); const p = (n) => String(n).padStart(2, '0');
        return fmt === 'yyyy-MM-dd' ? `${w.y}-${p(w.m)}-${p(w.d)}` : `${w.y}-${p(w.m)}-${p(w.d)} ${p(w.H)}:${p(w.M)}`;
      },
      parseDate: (s, tz) => {
        const [dd, tt = '00:00'] = s.split(' ');
        const [y, m, d] = dd.split('-').map(Number); const [H, M] = tt.split(':').map(Number);
        return new RealDate(fromWall(y, m, d, H, M, tz));
      },
    },
  };
  env.module = { exports: {} };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), env);
  return { api: env.module.exports, mails, store, cal, triggers, logs,
           setNow: (t) => { NOW = new Date(t).getTime(); }, resetWrites: () => { writes = 0; writeLimit = Infinity; } };
}

const live = (cal) => cal.events.filter(e => !e.deleted);
const tag = (e) => ((e.desc.match(/gtm-renewal-key:(.+)/) || [])[1] || "").trim();

// Rows as the Charge calendar tab gives them: A date, B row, C reminder, D tool, E amount, F status, G method, H days.
const R = (date, tool, amount, status = 'Active', method = 'Mastercard •• 7672 (Revolut)') =>
  [day(date), 0, '', tool, amount, status, method, 0];
const ROWS = [
  R('2026-11-25', 'Claude (Anthropic)', 81.12),
  R('2026-11-30', 'Pin', 162.85, 'Payment failed'),
  R('2026-12-01', 'Google Workspace', 75.9),
  R('2026-12-10', 'Loxo', 190.14, 'Payment failed'),
  R('2026-12-21', 'Slack', 8.25),                 // reminder 21 Nov: tomorrow
  R('2027-01-14', 'LinkedIn', 4543.62, 'Active', 'Bank transfer'),
  ['', '', '', '', '', '', '', ''],                // blank row
  ['not a date', 0, '', 'Broken', 5, 'Active', '', 0],
];
const NOW = '2026-11-20T07:00:00Z';                // 08:00 in Amsterdam

console.log('Helpers');
{
  const { api } = makeEnv({ rows: [], now: NOW });
  check(api.addDays_('2026-03-28', 2) === '2026-03-30' && api.addDays_('2026-12-31', 1) === '2027-01-01', 'day arithmetic across DST and year end');
  check(api.daysBetween_('2026-11-20', '2026-12-20') === 30, 'days between');
  check(api.longDate_('2026-12-10') === 'Thu 10 Dec 2026', 'long date');
  check(api.euro_(4543.62) === '€4,543.62' && api.euro_(8.25) === '€8.25', 'euro formatting');
  const parsed = api.parseCharges_(ROWS, 30);
  check(parsed.length === 6, 'blank and non-date rows skipped');
  check(parsed[0].key === 'Claude (Anthropic)|2026-11-25' && parsed[0].reminder === '2026-10-26', 'key and reminder date (30 days before)');
  const dup = api.parseCharges_([R('2026-12-01', 'Pin', 1), R('2026-12-01', 'Pin', 2)], 30);
  check(dup[0].key !== dup[1].key, 'same tool twice on one day keeps both charges');
}

console.log('First run');
const cal = { events: [], created: 0 };
let env = makeEnv({ rows: ROWS, now: NOW, calendar: cal });
env.api.dailyRun();
{
  check(cal.created === 1, 'calendar "GTM Talent - Renewals" created');
  const charges = live(cal).filter(e => e.allDay);
  const reminders = live(cal).filter(e => !e.allDay);
  check(charges.length === 6, 'one all-day event per charge');
  check(reminders.length === 2 && reminders.every(e => e.reminders.join() === '0'),
        'reminder events only where the reminder date is still ahead (Slack, LinkedIn), with a popup');
  const linkedin = reminders.find(e => /LinkedIn/.test(e.title));
  check(linkedin.title === 'In 30 days: LinkedIn €4,543.62 on 14 Jan', 'reminder title');
  check(env.api.addDays_ && new Date(linkedin.start).toISOString() === '2026-12-15T08:00:00.000Z',
        'reminder at 09:00 Amsterdam (08:00 UTC in winter) on 15 Dec');
  check(charges.every(e => e.reminders.length === 0), 'charge-day events carry no notification');
  check(env.mails.length === 1, 'first run sends one catch-up email');
  const m = env.mails[0];
  check(m.to === 'praveen@gtmtalent.tech', 'email goes to the account running the script');
  check(/Renewals: €510\.01 will be charged 25 Nov - 10 Dec \(4 charges\)/.test(m.subject), `subject: ${m.subject}`);
  check(/LAST PAYMENT FAILED/.test(m.body) && /Pin, Loxo/.test(m.body), 'failed-payment tools called out');
  check(!/Slack|LinkedIn/.test(m.body), 'charges outside the window not in the email');
}

console.log('Same day again: nothing new');
{
  const before = cal.events.length;
  env.api.dailyRun();
  check(cal.events.length === before && env.mails.length === 1, 're-run creates no events and sends no email');
}

console.log('Next day: Slack enters the window');
env.setNow('2026-11-21T07:00:00Z');
env.api.dailyRun();
{
  check(env.mails.length === 2 && /Slack/.test(env.mails[1].body) && !/Pin|Loxo|Claude/.test(env.mails[1].body),
        'only the newly due charge is emailed');
  check(/€8\.25 will be charged 21 Dec \(1 charge\)/.test(env.mails[1].subject), 'single-charge subject');
  check(/next 30 days \(including charges already reminded\): €518\.26/.test(env.mails[1].body),
        'email also gives the total for the whole window');
}

console.log('Sheet changes flow into the calendar');
{
  const rows2 = ROWS.slice();
  rows2[2] = R('2026-12-01', 'Google Workspace', 101.2);    // seat added
  rows2.splice(3, 1);                                         // Loxo cancelled
  env = makeEnv({ rows: rows2, now: '2026-11-21T07:00:00Z', calendar: cal, props: env.store });
  const ids = live(cal).map(e => e.id).sort();
  env.api.dailyRun();
  const google = live(cal).find(e => tag(e) === 'Google Workspace|2026-12-01|charge');
  check(google.title === 'Charge: Google Workspace €101.20', 'amount change updates the existing event');
  check(!live(cal).some(e => /Loxo/.test(e.title)), 'a removed tool loses its future events');
  check(live(cal).filter(e => e.allDay).length === 5 && !live(cal).some(e => !ids.includes(e.id)),
        'no events re-created');
  check(env.mails.length === 0, 'no email: nothing new entered the window');
}

console.log('Lead time changed to 14 days');
{
  env = makeEnv({ rows: ROWS, lead: 14, now: '2026-11-21T07:00:00Z', calendar: cal, props: env.store });
  env.api.dailyRun();
  const r = live(cal).find(e => tag(e) === 'LinkedIn|2027-01-14|reminder');
  check(new Date(r.start).toISOString() === '2026-12-31T08:00:00.000Z' && r.title === 'In 14 days: LinkedIn €4,543.62 on 14 Jan',
        'reminder event moved and retitled');
}

console.log('Missed days, DST, failures');
{
  const c2 = { events: [], created: 0 };
  const rows = [R('2026-04-10', 'Adobe eSign', 15.12), R('2026-04-12', 'Canva', 12), R('2026-04-30', 'Slack', 8.25)];
  const e = makeEnv({ rows, now: '2026-03-01T07:00:00Z', calendar: c2 });
  e.api.dailyRun();
  check(e.mails.length === 0, 'nothing inside the window yet');
  const adobeReminder = live(c2).find(x => tag(x) === 'Adobe eSign|2026-04-10|reminder');
  check(new Date(adobeReminder.start).toISOString() === '2026-03-11T08:00:00.000Z', 'winter: 09:00 Amsterdam = 08:00 UTC');
  const slackReminder = live(c2).find(x => tag(x) === 'Slack|2026-04-30|reminder');
  check(new Date(slackReminder.start).toISOString() === '2026-03-31T07:00:00.000Z', 'summer time: 09:00 Amsterdam = 07:00 UTC');
  e.setNow('2026-03-14T07:00:00Z');                  // runs on 11-13 Mar missed
  e.api.dailyRun();
  check(e.mails.length === 1 && /Adobe/.test(e.mails[0].body) && /Canva/.test(e.mails[0].body),
        'charges whose reminder fell on missed days are still emailed');
  e.setNow('2026-05-01T07:00:00Z');
  e.api.dailyRun();
  check(!/Adobe|Canva/.test(e.store.sent), 'passed charges dropped from the sent list');

  const noTab = makeEnv({ rows: [], now: NOW, tab: false });
  let msg = '';
  try { noTab.api.setup(); } catch (err) { msg = err.message; }
  check(/Tab "Charge calendar" not found/.test(msg), 'missing tab gives a clear error');
  const badLead = makeEnv({ rows: [], now: NOW, lead: '' });
  msg = '';
  try { badLead.api.dailyRun(); } catch (err) { msg = err.message; }
  check(/K1 must be a number of days/.test(msg), 'blank lead time gives a clear error');
  const busy = makeEnv({ rows: ROWS, now: NOW, lockFree: false });
  busy.api.dailyRun();
  check(busy.mails.length === 0 && busy.cal.events.length === 0, 'overlapping run does nothing');
}

console.log("Google's calendar rate limit (the error seen on the first real run)");
{
  const c3 = { events: [], created: 0 };
  const e = makeEnv({ rows: ROWS, now: NOW, calendar: c3, writeLimit: 7 });
  e.api.setup();
  check(e.mails.length === 1, 'reminder email still sent: it goes out before the calendar sync');
  const made = live(c3).length;
  check(made > 0 && made < 8, `run stopped cleanly part-way (${made} events created) instead of crashing`);
  const cont = e.triggers.filter(t => t.handler === 'continueSync');
  check(cont.length === 1 && cont[0].afterMs === 20 * 60 * 1000, 'continuation scheduled 20 minutes later');
  check(/continuing in 20 minute/.test(e.logs.join(' ')), 'log says it will continue');
  check(e.triggers.filter(t => t.handler === 'dailyRun').length === 1, 'daily trigger still installed');
  check(live(c3).filter(x => !x.allDay)[0] === undefined || /Slack/.test(live(c3).find(x => !x.allDay).title),
        'soonest events are created first');

  e.resetWrites();                         // 20 minutes later Google allows writes again
  e.setNow('2026-11-20T07:21:00Z');
  const continuation = e.triggers.find(t => t.handler === 'continueSync');
  e.api.continueSync();
  check(live(c3).length === 8, 'continuation finishes the calendar: 6 charges + 2 reminders');
  const tags = live(c3).map(tag);
  check(new Set(tags).size === tags.length, 'no duplicate events after the interrupted run');
  check(!e.triggers.includes(continuation) && !e.triggers.some(t => t.handler === 'continueSync'),
        'continuation trigger removed once it has run');
  check(e.mails.length === 1, 'no second email');

  const other = makeEnv({ rows: ROWS, now: NOW, calendar: { events: [], created: 0 } });
  const realLimit = other.api.CONFIG.MAX_RUN_MS;
  other.api.CONFIG.MAX_RUN_MS = -1;        // as if the run had used up its time
  other.api.dailyRun();
  check(other.triggers.some(t => t.handler === 'continueSync' && t.afterMs === 60 * 1000),
        'time limit: continues after 1 minute');
  other.api.CONFIG.MAX_RUN_MS = realLimit;
}

console.log(`\nAll ${passed} checks passed.`);
