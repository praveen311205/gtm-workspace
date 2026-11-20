/**
 * GTM Talent - Cash flow monthly update (Google Apps Script, bound to the
 * "GTM Talent - Cash Flow Model" sheet)                         version 0.1.0
 *
 * On the 1st of every month it:
 *   1. reads the Revolut Business emails that the Invoice Archiver saved in the
 *      "GTM Talent - Invoices" Drive folder since the last run:
 *        "€ 15.000 invoice from GTM Talent B.V."   -> invoice sent: added to
 *            Placements as Open, expected on its due date;
 *        "Your Invoice for € 15.000 was paid"      -> that invoice becomes Paid,
 *            with the date it was paid (added as a new row if it was missing);
 *   2. adds this month's row to "Monthly check-ins" with the model's forecast
 *      closing cash, so it can be compared with the real balance later;
 *   3. emails what changed, which invoices are overdue, the runway, and the
 *      one thing a person must do: type the Revolut balance into Inputs.
 *
 * It only writes Placements columns A-J and M (K and L are formulas) and new
 * Monthly check-ins rows. Each email is read once. Setup: see README.md.
 */

const CONFIG = {
  ARCHIVE_FOLDER_ID: '1CUi1BqqDm4nopfl1PmiM3FoZQtPRuJeD',   // "GTM Talent - Invoices"
  TIMEZONE: 'Europe/Amsterdam',
  RUN_DAY: 1,                    // day of the month
  RUN_HOUR: 8,
  RECIPIENTS: [],                // empty = the account that runs the script
  STALE_BALANCE_DAYS: 35,        // warn when the bank balance on Inputs is older than this
  // Emails archived before this day are already in Placements (entered by hand
  // when the model was built). Only later ones are read.
  START_DATE: '2026-11-20',
};

const TABS = { PLACEMENTS: 'Placements', CHECKINS: 'Monthly check-ins', CASHFLOW: 'Cash flow',
               SUMMARY: 'Summary', INPUTS: 'Inputs' };

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Run once by hand: installs the monthly trigger and does a first update. */
function setup() {
  for (const name of Object.values(TABS)) {
    if (!SpreadsheetApp.getActive().getSheetByName(name)) throw new Error(`Tab "${name}" not found.`);
  }
  DriveApp.getFolderById(CONFIG.ARCHIVE_FOLDER_ID).getName();   // fails early without access
  try {
    ScriptApp.getProjectTriggers()
      .filter(t => t.getHandlerFunction() === 'monthlyUpdate')
      .forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('monthlyUpdate').timeBased().onMonthDay(CONFIG.RUN_DAY)
      .atHour(CONFIG.RUN_HOUR).inTimezone(CONFIG.TIMEZONE).create();
  } catch (e) {
    console.error(`Monthly trigger not installed (${errorText_(e)}). Run setup again later.`);
  }
  monthlyUpdate();
}

function monthlyUpdate() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const today = dayKey_(new Date());
    console.log('1/3 Revolut invoice emails in the archive');
    let changes = { added: [], paid: [], skipped: [] };
    let failure = '';
    try {
      const events = readArchive_();
      changes = applyToPlacements_(events, today);
      markDone_(events);
    } catch (e) {
      failure = `Reading Revolut emails failed: ${errorText_(e)}`;
      console.error(failure);
    }
    console.log('2/3 Monthly check-in row');
    let checkin = null;
    try {
      checkin = addCheckIn_(today);
    } catch (e) {
      failure = failure || `Check-in row failed: ${errorText_(e)}`;
      console.error(`Check-in row failed: ${errorText_(e)}`);
    }
    console.log('3/3 Summary email');
    SpreadsheetApp.flush();                                   // let formulas catch up
    const mail = buildEmail_(changes, checkin, readState_(today), today, failure);
    const to = (CONFIG.RECIPIENTS.length ? CONFIG.RECIPIENTS : [Session.getEffectiveUser().getEmail()]).join(',');
    MailApp.sendEmail({ to, subject: mail.subject, body: mail.text, htmlBody: mail.html });
    console.log(`Done: ${changes.paid.length} paid, ${changes.added.length} added, ` +
                `${changes.skipped.length} skipped. ${failure}`);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 1. Revolut emails -> Placements
// ---------------------------------------------------------------------------

const ISSUED_RE = /Revolut Business - .*invoice from GTM Talent/i;
const PAID_RE = /Revolut Business - .*(invoice for .* was paid|invoice .* was paid)/i;

/** New Revolut invoice emails in the archive, oldest first, as events. */
function readArchive_() {
  const done = JSON.parse(PropertiesService.getScriptProperties().getProperty('doneFiles') || '{}');
  const folder = DriveApp.getFolderById(CONFIG.ARCHIVE_FOLDER_ID);
  const it = folder.searchFiles("title contains 'Revolut' and mimeType = 'text/plain' and trashed = false");
  const events = [];
  while (it.hasNext()) {
    const f = it.next();
    const name = f.getName();
    if (done[f.getId()]) continue;
    const fileDay = (name.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    if (!fileDay || fileDay < CONFIG.START_DATE) continue;
    const kind = PAID_RE.test(name) ? 'paid' : ISSUED_RE.test(name) ? 'issued' : null;
    if (!kind) continue;
    const ev = parseRevolutEmail_(kind, name, f.getBlob().getDataAsString());
    ev.fileId = f.getId();
    ev.link = f.getUrl();
    events.push(ev);
  }
  // Issued before paid, then by date, so an invoice sent and paid in one month ends Paid.
  return events.sort((a, b) => (a.sortDate < b.sortDate ? -1 : a.sortDate > b.sortDate ? 1 :
                                a.kind === 'issued' ? -1 : 1));
}

/** Pull invoice number, amount and dates out of one archived email. */
function parseRevolutEmail_(kind, title, text) {
  const body = String(text || '').replace(/\\([<>_*~#\[\]-])/g, '$1');   // tolerate markdown-escaped copies
  const label = (name) => {
    const m = body.match(new RegExp(name + '\\s*:?\\s*\\n\\s*([^\\n]+)', 'i'));
    return m ? m[1].trim() : '';
  };
  const invoice = (label('Invoice number').match(/INV-?\d+/i) || body.match(/\bINV-\d+\b/i) || [''])[0].toUpperCase();
  const amountText = label(kind === 'paid' ? 'Amount' : 'Total amount due') ||
                     (title.match(/€\s?[\d.,]+/) || [''])[0];
  const titleDay = (title.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const ev = { kind, invoice, amount: parseAmount_(amountText), title };
  if (kind === 'paid') {
    ev.paidDate = parseLongDate_(label('Invoice paid')) || titleDay;
    ev.invoiceDate = parseLongDate_(label('Invoice created')) || '';
    ev.sortDate = ev.paidDate;
  } else {
    ev.invoiceDate = parseLongDate_(label('Invoice date')) || titleDay;
    ev.dueDate = parseLongDate_(label('Due date')) || '';
    ev.sortDate = ev.invoiceDate;
  }
  return ev;
}

/** "€ 15.000" -> 15000, "€7,500" -> 7500, "€43,654.40" -> 43654.4, "€ 1.250,50" -> 1250.5 */
function parseAmount_(text) {
  const s = String(text || '').replace(/[€\s]|EUR/gi, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
    return Number(s.replace(/\./g, '').replace(',', '.'));
  }
  const n = Number(s.replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

const MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
                     'september', 'october', 'november', 'december'];

/**
 * "7 October 2026", "5 November 2026 7:19 AM GMT" or (older Revolut emails)
 * "June 6, 2025 7:25 PM GMT" -> "2026-10-07"; '' if not a date.
 */
function parseLongDate_(text) {
  const s = String(text || '');
  let d, mon, y;
  let m = s.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) { [, d, mon, y] = m; } else {
    m = s.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (!m) return '';
    [, mon, d, y] = m;
  }
  const i = MONTHS_LONG.findIndex(x => x.startsWith(mon.toLowerCase().slice(0, 3)));
  if (i < 0 || Number(d) < 1 || Number(d) > 31) return '';
  return `${y}-${String(i + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Apply events to the Placements tab. Returns what changed:
 * {added: [...], paid: [...], skipped: [...]} with one line per event.
 */
function applyToPlacements_(events, today) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.PLACEMENTS);
  const last = Math.max(sheet.getLastRow(), 1);
  const values = last >= 2 ? sheet.getRange(2, 1, last - 1, 10).getValues() : [];
  const rowOf = {};
  let firstEmpty = 2;
  values.forEach((r, i) => {
    const inv = String(r[0] || '').trim().toUpperCase();
    if (inv) { rowOf[inv] = i + 2; firstEmpty = i + 3; }
  });
  const changes = { added: [], paid: [], skipped: [] };
  for (const ev of events) {
    if (!ev.invoice) { changes.skipped.push(`${ev.title}: no invoice number found`); continue; }
    const row = rowOf[ev.invoice];
    if (ev.kind === 'issued') {
      if (row) { changes.skipped.push(`${ev.invoice}: already on Placements`); continue; }
      writeRow_(sheet, firstEmpty, [ev.invoice, 'Unknown: see Revolut Merchant > Invoices', '', 'Unknown',
        'Open', ev.amount, 0, day_(ev.invoiceDate), day_(ev.dueDate), ''], ev.link);
      rowOf[ev.invoice] = firstEmpty++;
      changes.added.push(`${ev.invoice} ${euro_(ev.amount)} sent ${ev.invoiceDate}, due ${ev.dueDate || 'unknown'}`);
      continue;
    }
    // paid
    if (row) {
      const status = String(sheet.getRange(row, 5).getValue());
      if (status === 'Paid') { changes.skipped.push(`${ev.invoice}: already Paid`); continue; }
      sheet.getRange(row, 5).setValue('Paid');
      sheet.getRange(row, 9).setValue(day_(ev.paidDate));
      changes.paid.push(`${ev.invoice} ${euro_(ev.amount)} paid ${ev.paidDate} (was ${status || 'blank'})`);
    } else {
      writeRow_(sheet, firstEmpty, [ev.invoice, 'Unknown: see Revolut Merchant > Invoices', '', 'Unknown',
        'Paid', ev.amount, 0, day_(ev.invoiceDate || ev.paidDate), day_(ev.paidDate), ''], ev.link);
      rowOf[ev.invoice] = firstEmpty++;
      changes.paid.push(`${ev.invoice} ${euro_(ev.amount)} paid ${ev.paidDate} (new row)`);
    }
  }
  return changes;
}

function writeRow_(sheet, row, aToJ, link) {
  sheet.getRange(row, 1, 1, 10).setValues([aToJ]);
  sheet.getRange(row, 13).setValue(link || '');
}

function markDone_(events) {
  const props = PropertiesService.getScriptProperties();
  const done = JSON.parse(props.getProperty('doneFiles') || '{}');
  for (const ev of events) done[ev.fileId] = 1;
  props.setProperty('doneFiles', JSON.stringify(done));
}

// ---------------------------------------------------------------------------
// 2. Monthly check-in row
// ---------------------------------------------------------------------------

/** Adds this month's row (once). Returns {month, forecast} or null if it already existed. */
function addCheckIn_(today) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(TABS.CHECKINS);
  const month = today.slice(0, 7) + '-01';
  const last = sheet.getLastRow();
  const months = last >= 2 ? sheet.getRange(2, 1, last - 1, 1).getValues().map(r => r[0]) : [];
  if (months.some(m => isDate_(m) && dayKey_(m).slice(0, 7) === month.slice(0, 7))) return null;
  const cf = ss.getSheetByName(TABS.CASHFLOW).getRange(1, 2, 20, 24).getValues();
  const col = cf[0].findIndex(m => isDate_(m) && dayKey_(m).slice(0, 7) === month.slice(0, 7));
  const forecast = col >= 0 ? cf[19][col] : '';
  const row = last + 1;
  sheet.getRange(row, 1, 1, 7).setValues([[day_(month), '', forecast,
    `=IF(OR(B${row}="",C${row}=""),"",B${row}-C${row})`,
    `=COUNTIFS(Placements!E2:E,"Paid",Placements!I2:I,">="&A${row},Placements!I2:I,"<"&EDATE(A${row},1))`,
    col >= 0 ? 'Added by the monthly update. Type the real month-end balance in column B.'
             : 'Added by the monthly update. This month is before the forecast starts: update the cash on Inputs.',
    'monthly update']]);
  return { month, forecast };
}

// ---------------------------------------------------------------------------
// 3. Summary email
// ---------------------------------------------------------------------------

function readState_(today) {
  const ss = SpreadsheetApp.getActive();
  const inputs = ss.getSheetByName(TABS.INPUTS);
  const summary = ss.getSheetByName(TABS.SUMMARY);
  const balanceDate = inputs.getRange('B5').getValue();
  const p = ss.getSheetByName(TABS.PLACEMENTS);
  const last = p.getLastRow();
  const rows = last >= 2 ? p.getRange(2, 1, last - 1, 9).getValues() : [];
  const overdue = rows.filter(r => r[4] === 'Open' && isDate_(r[8]) && dayKey_(r[8]) < today)
    .map(r => `${r[0]} ${euro_(Number(r[5]))} (${r[1]}), expected ${dayKey_(r[8])}`);
  const check = rows.filter(r => r[4] === 'Check').map(r => `${r[0]} ${euro_(Number(r[5]))} (${r[1]})`);
  return {
    url: ss.getUrl(),
    cash: inputs.getRange('B6').getValue(),
    balanceDate: isDate_(balanceDate) ? dayKey_(balanceDate) : '',
    balanceAge: isDate_(balanceDate) ? daysBetween_(dayKey_(balanceDate), today) : null,
    runwayNoDeals: summary.getRange('B12').getDisplayValue(),
    cash12: summary.getRange('B15').getDisplayValue(),
    monthlyOut: summary.getRange('B6').getDisplayValue(),
    overdue, check,
  };
}

function buildEmail_(changes, checkin, st, today, failure) {
  const monthName = longMonth_(today);
  const stale = st.balanceAge === null || st.balanceAge > CONFIG.STALE_BALANCE_DAYS;
  const subject = `Cash flow ${monthName}: ` +
    (stale ? 'update the bank balance' : 'monthly update') +
    (changes.paid.length ? `, ${changes.paid.length} payment(s) recorded` : '');
  const sections = [];
  sections.push(['Do this now (2 minutes)', [
    `Type today's Revolut balance (all accounts) on Inputs: date in B5, amount in B6.` +
      (st.balanceDate ? ` It now says ${euro_(Number(st.cash))} on ${st.balanceDate}` +
        (st.balanceAge !== null ? ` (${st.balanceAge} days ago).` : '.') : ''),
    'On Monthly check-ins, type last month\'s real month-end balance in column B so it can be compared with the forecast.',
  ]]);
  sections.push(['Recorded from Revolut', [
    ...changes.paid.map(l => `Paid: ${l}`),
    ...changes.added.map(l => `New invoice: ${l}`),
  ].concat(changes.paid.length || changes.added.length ? [] : ['No new Revolut invoice emails since the last update.'])]);
  if (st.overdue.length || st.check.length) {
    sections.push(['Money not in yet', [
      ...st.overdue.map(l => `Overdue: ${l}`),
      ...st.check.map(l => `No payment seen (status Check, not counted as cash): ${l}`),
    ]]);
  }
  sections.push(['Where the cash stands (from the model)', [
    `Average monthly cash out: ${st.monthlyOut}.`,
    `Months the cash lasts with no new deals: ${st.runwayNoDeals}.`,
    `Base case, cash in 12 months: ${st.cash12}.`,
    checkin && checkin.forecast !== '' ? `Forecast closing cash for ${monthName}: ${euro_(Number(checkin.forecast))}.` : '',
  ].filter(Boolean)]);
  if (changes.skipped.length) sections.push(['Skipped', changes.skipped]);
  if (failure) sections.push(['Problem', [failure]]);
  const text = sections.map(([h, lines]) => `${h}\n${lines.map(l => `- ${l}`).join('\n')}`).join('\n\n') +
    `\n\nOpen the model: ${st.url}`;
  const html = sections.map(([h, lines]) =>
    `<p style="font-family:Arial;font-size:13px"><b>${escape_(h)}</b></p><ul style="font-family:Arial;font-size:13px">` +
    lines.map(l => `<li>${escape_(l)}</li>`).join('') + '</ul>').join('') +
    `<p style="font-family:Arial;font-size:13px"><a href="${st.url}">Open the cash flow model</a></p>`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function dayKey_(d) {
  return Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

/** 'yyyy-MM-dd' -> Date at local midnight, or '' for a blank day. */
function day_(day) {
  return day ? Utilities.parseDate(day, CONFIG.TIMEZONE, 'yyyy-MM-dd') : '';
}

function daysBetween_(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function longMonth_(day) {
  const [y, m] = day.split('-').map(Number);
  return `${MONTHS_LONG[m - 1][0].toUpperCase()}${MONTHS_LONG[m - 1].slice(1)} ${y}`;
}

function euro_(n) {
  if (n === null || n === undefined || !isFinite(n)) return '€?';
  const s = Math.abs(n).toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '€' + s;
}

function errorText_(e) {
  return String(e && e.message ? e.message : e);
}

function escape_(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

if (typeof module !== 'undefined') {   // Node test harness only; ignored by Apps Script
  module.exports = { CONFIG, parseRevolutEmail_, parseAmount_, parseLongDate_, applyToPlacements_,
                     addCheckIn_, buildEmail_, monthlyUpdate, setup, readArchive_ };
}
