// node cash-flow/tests/monthly.test.js — fake Sheets/Drive/Mail services
const fs = require('fs'), path = require('path'), vm = require('vm');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.error('FAIL: ' + msg); } };

function fmt(d) { // yyyy-MM-dd in Amsterdam ~ use UTC noon dates in tests
  return d.toISOString().slice(0, 10);
}
function makeSheet(rows) {
  const data = rows.map(r => r.slice());
  const ensure = (r, c) => { while (data.length < r) data.push([]); while (data[r - 1].length < c) data[r - 1].push(''); };
  return {
    data,
    getLastRow: () => { for (let i = data.length; i > 0; i--) if (data[i - 1].some(v => v !== '' && v !== null)) return i; return 0; },
    getRange(a, b, h = 1, w = 1) {
      if (typeof a === 'string') { const m = a.match(/([A-Z])(\d+)/); b = m[1].charCodeAt(0) - 64; a = Number(m[2]); }
      const r0 = a, c0 = b;
      return {
        getValues: () => { const out = []; for (let i = 0; i < h; i++) { ensure(r0 + i, c0 + w - 1); out.push(data[r0 + i - 1].slice(c0 - 1, c0 - 1 + w)); } return out; },
        getValue: () => { ensure(r0, c0); return data[r0 - 1][c0 - 1]; },
        getDisplayValue: () => { ensure(r0, c0); return String(data[r0 - 1][c0 - 1]); },
        setValue: v => { ensure(r0, c0); data[r0 - 1][c0 - 1] = v; },
        setValues: vs => vs.forEach((row, i) => row.forEach((v, j) => { ensure(r0 + i, c0 + j); data[r0 + i - 1][c0 + j - 1] = v; })),
      };
    },
  };
}
const D = s => new Date(s + 'T12:00:00Z');

function env(files, opts = {}) {
  const props = {};
  const sent = [];
  const placements = makeSheet([
    ['Invoice', 'Client', 'Candidate', 'Type', 'Status', 'Fee', 'VAT', 'Inv date', 'Pay date', 'Prob'],
    ['INV-30', 'Acme', 'X', 'Perm', 'Paid', 7500, 0, D('2026-08-18'), D('2026-08-24'), ''],
    ['INV-31', 'Beta', 'Y', 'Perm', 'Open', 15000, 0, D('2026-10-07'), D('2026-10-14'), ''],
    ['INV-22', 'Gamma', 'Z', 'Perm', 'Check', 22417.38, 0, D('2026-01-10'), '', ''],
  ]);
  const months = ['Month']; for (let i = 0; i < 24; i++) months.push(D(`2026-${String(12).padStart(2,'0')}-01`));
  const cfRows = Array.from({ length: 20 }, () => Array(25).fill(''));
  for (let i = 0; i < 24; i++) { const d = new Date(Date.UTC(2026, 11 + i, 1, 12)); cfRows[0][i + 1] = d; cfRows[19][i + 1] = 150000 - 6000 * (i + 1); }
  const sheets = {
    Placements: placements,
    'Monthly check-ins': makeSheet([['Month', 'Actual', 'Forecast', 'Diff', 'Paid', 'Notes', 'By']]),
    'Cash flow': makeSheet(cfRows),
    Summary: makeSheet(Array.from({ length: 20 }, (_, i) => i === 11 ? ['', '18'] : i === 14 ? ['', '€195,682'] : i === 5 ? ['', '€8,200'] : ['', ''])),
    Inputs: makeSheet([[''], [''], [''], [''], ['', opts.balanceDate || D('2026-11-20')], ['', 150000]]),
  };
  const fileObjs = files.map((f, i) => ({ getId: () => 'f' + i, getName: () => f.name, getUrl: () => 'https://drive/' + i,
    getBlob: () => ({ getDataAsString: () => f.body }) }));
  const ctx = {
    console: { log() {}, error() {} },
    module: { exports: {} },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n], getUrl: () => 'https://sheet' }), flush() {} },
    DriveApp: { getFolderById: () => ({ getName: () => 'GTM Talent - Invoices', searchFiles: () => { let i = 0; return { hasNext: () => i < fileObjs.length, next: () => fileObjs[i++] }; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: m => sent.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => { const t = { timeBased: () => t, onMonthDay: () => t, atHour: () => t, inTimezone: () => t, create: () => {} }; return t; } },
    Utilities: {
      formatDate: d => fmt(d),
      parseDate: s => D(s),
    },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(opts.now || '2026-12-01T08:00:00Z'); } },
  };
  ctx.Date.UTC = Date.UTC; ctx.Date.parse = Date.parse; ctx.Date.now = Date.now;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'cashflow-monthly.gs'), 'utf8'), ctx);
  return { ctx, m: ctx.module.exports, sheets, sent, props };
}

const issuedBody = (inv, amt, date, due) => `Subject: ${amt} invoice from GTM Talent B.V.\n----- Email body -----\nFrom\nGTM Talent B.V.\nInvoice number  \n${inv}\nInvoice date  \n${date}\nDue date  \n${due}\nTotal amount due  \n${amt}\nPay invoice`;
const paidNew = (inv, amt, created, paid) => `Hi\nAmount:\n${amt}\nInvoice number:\n${inv}\nInvoice created:\n${created} 12:00 AM GMT\nInvoice paid:\n${paid} 7:19 AM GMT\n`;
const paidOld = (inv, amt, created, paid) => `You received ${amt}\nAmount  \n${amt}\nInvoice number  \n${inv}\nDescription  \nVAT reverse charge applies.\nDate invoice created  \n${created} 12:00 AM GMT\nDate invoice paid  \n${paid} 7:25 PM GMT\n`;

// --- parsers
{
  const { m } = env([]);
  ok(m.parseAmount_('€ 15.000') === 15000, 'euro dots');
  ok(m.parseAmount_('€15,000') === 15000, 'euro commas');
  ok(m.parseAmount_('€43,654.40') === 43654.4, 'decimals');
  ok(m.parseAmount_('€ 1.250,50') === 1250.5, 'continental decimals');
  ok(m.parseAmount_('€7,500') === 7500, '7,500');
  ok(m.parseAmount_('') === null, 'blank amount');
  ok(m.parseLongDate_('7 October 2026') === '2026-10-07', 'day month year');
  ok(m.parseLongDate_('5 November 2026 7:19 AM GMT') === '2026-11-05', 'with time');
  ok(m.parseLongDate_('June 6, 2025 7:25 PM GMT') === '2025-06-06', 'US format');
  ok(m.parseLongDate_('April 25, 2025 12:00 AM GMT') === '2025-04-25', 'US format 2');
  ok(m.parseLongDate_('soon') === '', 'not a date');
  const a = m.parseRevolutEmail_('issued', '2026-12-03 - Revolut Business - €9,000 invoice from GTM Talent B.V..txt', issuedBody('INV-32', '€9,000', '3 December 2026', '10 December 2026'));
  ok(a.invoice === 'INV-32' && a.amount === 9000 && a.invoiceDate === '2026-12-03' && a.dueDate === '2026-12-10', 'issued parse ' + JSON.stringify(a));
  const b = m.parseRevolutEmail_('paid', 'x', paidNew('INV-31', '€ 15.000', '7 October 2026', '5 November 2026'));
  ok(b.invoice === 'INV-31' && b.amount === 15000 && b.paidDate === '2026-11-05' && b.invoiceDate === '2026-10-07', 'paid new parse ' + JSON.stringify(b));
  const c = m.parseRevolutEmail_('paid', 'x', paidOld('INV-13', '€10,000', 'April 25, 2025', 'June 6, 2025'));
  ok(c.invoice === 'INV-13' && c.amount === 10000 && c.paidDate === '2025-06-06' && c.invoiceDate === '2025-04-25', 'paid old parse ' + JSON.stringify(c));
  const e = m.parseRevolutEmail_('paid', '2026-12-05 - Revolut Business - Your Invoice for €5,000 was paid.txt', 'garbled');
  ok(e.invoice === '' && e.amount === 5000 && e.paidDate === '2026-12-05', 'fallbacks from title');
  const esc = m.parseRevolutEmail_('paid', 'x', paidNew('INV\\-33', '€ 1.000', '1 December 2026', '2 December 2026'));
  ok(esc.invoice === 'INV-33', 'markdown-escaped invoice number');
}

// --- full run
const files = [
  { name: '2025-06-06 - Revolut Business - An invoice for €10,000 was paid.txt', body: paidOld('INV-13', '€10,000', 'April 25, 2025', 'June 6, 2025') },
  { name: '2026-11-25 - Revolut Business - Your Invoice for € 15.000 was paid.txt', body: paidNew('INV-31', '€ 15.000', '7 October 2026', '25 November 2026') },
  { name: '2026-11-27 - Revolut Business - Your Invoice for €12,000 was paid.txt', body: paidNew('INV-32', '€12,000', '20 November 2026', '27 November 2026') },
  { name: '2026-11-21 - Revolut Business - €12,000 invoice from GTM Talent B.V..txt', body: issuedBody('INV-32', '€12,000', '20 November 2026', '27 November 2026') },
  { name: '2026-11-28 - Revolut Business - €8,000 invoice from GTM Talent B.V..txt', body: issuedBody('INV-33', '€8,000', '28 November 2026', '5 December 2026') },
  { name: '2026-11-29 - Revolut Business - Your Invoice for €100 was paid.txt', body: 'nothing useful' },
  { name: '2026-11-29 - Revolut Business - Your card payment failed.txt', body: 'x' },
  { name: '2026-11-30 - Revolut Business - €7,500 invoice from GTM Talent B.V..txt', body: issuedBody('INV-30', '€7,500', '18 August 2026', '25 August 2026') },
];
{
  const { m, sheets, sent, props } = env(files);
  m.monthlyUpdate();
  const P = sheets.Placements.data;
  const row = inv => P.find(r => r[0] === inv);
  ok(!row('INV-13'), 'old email before START_DATE ignored');
  ok(row('INV-31')[4] === 'Paid' && fmt(row('INV-31')[8]) === '2026-11-25', 'INV-31 marked paid');
  ok(row('INV-32') && row('INV-32')[4] === 'Paid' && fmt(row('INV-32')[8]) === '2026-11-27', 'INV-32 issued then paid ends Paid');
  ok(P.filter(r => r[0] === 'INV-32').length === 1, 'INV-32 one row');
  ok(row('INV-33')[4] === 'Open' && row('INV-33')[5] === 8000 && fmt(row('INV-33')[8]) === '2026-12-05', 'INV-33 added Open with due date');
  ok(row('INV-33')[12] && row('INV-33')[12].startsWith('https://drive/'), 'source link in M');
  ok(row('INV-33')[10] === undefined || row('INV-33')[10] === '', 'K left for formula');
  ok(row('INV-30')[4] === 'Paid' && P.filter(r => r[0] === 'INV-30').length === 1, 'existing INV-30 untouched');
  ok(row('INV-22')[4] === 'Check', 'Check untouched');
  const C = sheets['Monthly check-ins'].data;
  ok(C.length === 2 && fmt(C[1][0]) === '2026-12-01' && C[1][2] === 144000, 'check-in row with forecast ' + JSON.stringify(C[1]));
  ok(String(C[1][3]).startsWith('=IF(') && String(C[1][4]).startsWith('=COUNTIFS('), 'check-in formulas');
  ok(sent.length === 1, 'one email');
  const t = sent[0].body;
  ok(/INV-31 €15,000 paid 2026-11-25/.test(t), 'email lists INV-31');
  ok(/New invoice: INV-33 €8,000/.test(t), 'email lists INV-33');
  ok(/no invoice number found/.test(t), 'email lists skipped garbled');
  ok(/INV-30: already on Placements/.test(t), 'email lists skip of known issued');
  ok(/INV-22/.test(t) && /Check/.test(t), 'email lists Check invoices');
  ok(/Forecast closing cash for December 2026: €144,000/.test(t), 'email forecast');
  ok(/monthly update, 2 payment/.test(sent[0].subject), 'subject: balance 11 days old is fresh, 2 payments');
  ok(sent[0].to === 'me@example.com', 'default recipient');
  ok(!/<script/i.test(sent[0].htmlBody), 'html escaped');
  // second run: idempotent
  m.monthlyUpdate();
  ok(sheets['Monthly check-ins'].data.length === 2, 'no duplicate check-in');
  ok(sheets.Placements.data.length === P.length, 'no duplicate placements');
  ok(/No new Revolut invoice emails/.test(sent[1].body), 'second email says nothing new');
  ok(Object.keys(JSON.parse(props.doneFiles)).length === 6, 'done files tracked (6 invoice emails after start date)');
}
// stale balance flag
{
  const { m, sent } = env([], { balanceDate: D('2026-10-01'), now: '2026-12-01T08:00:00Z' });
  m.monthlyUpdate();
  ok(/update the bank balance/.test(sent[0].subject), 'stale subject');
  ok(/61 days ago/.test(sent[0].body), 'balance age shown');
}
{
  const { m, sent } = env([], { balanceDate: D('2026-11-30'), now: '2026-12-01T08:00:00Z' });
  m.monthlyUpdate();
  ok(/monthly update/.test(sent[0].subject) && !/update the bank balance/.test(sent[0].subject), 'fresh balance subject');
}
// Drive failure still sends email with problem, still adds check-in
{
  const e = env([]);
  e.ctx.DriveApp.getFolderById = () => { throw new Error('No access'); };
  e.m.monthlyUpdate();
  ok(e.sent.length === 1 && /Reading Revolut emails failed: No access/.test(e.sent[0].body), 'drive failure reported');
  ok(e.sheets['Monthly check-ins'].data.length === 2, 'check-in still added');
}
// month before forecast window
{
  const e = env([], { now: '2026-11-20T08:00:00Z' });
  e.m.monthlyUpdate();
  const r = e.sheets['Monthly check-ins'].data[1];
  ok(r[2] === '' && /before the forecast starts/.test(r[5]), 'pre-forecast month note');
}
// setup checks tabs
{
  const e = env([]);
  delete e.sheets.Summary;
  let err = '';
  try { e.m.setup(); } catch (x) { err = x.message; }
  ok(/Tab "Summary" not found/.test(err), 'setup missing tab');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
