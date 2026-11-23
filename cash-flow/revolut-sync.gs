/**
 * GTM Talent - Revolut Business sync (Google Apps Script, bound to the
 * "GTM Talent - Cash Flow Model" sheet)                         version 0.1.0
 *
 * Every morning it reads the Revolut Business API (read-only calls only:
 * accounts, transactions, exchange rate) and:
 *   1. writes every account's balance to the Bank tab. Inputs then takes the
 *      cash balance and its date from there, so the forecast always starts
 *      from today's real balance;
 *   2. writes the last 13 months of transactions to "Bank transactions", each
 *      with a category from the "Bank rules" tab. The Actuals tab sums them by
 *      month and compares them with the model's costs;
 *   3. marks invoices Paid on Placements when the money arrives (by invoice
 *      number in the payment reference, or by a unique exact amount);
 *   4. fills in the real month-end balance on "Monthly check-ins".
 *
 * It never makes a payment or changes anything in Revolut: it only sends GET
 * requests to /accounts, /transactions and /rate.
 *
 * The Revolut key and tokens are kept in this Google account's private user
 * properties for this script, not in the sheet or the code, so other editors
 * of the sheet cannot read them. Setup: see README.md, "Connect Revolut".
 */

const RV = {
  API: 'https://b2b.revolut.com/api/1.0',
  TIMEZONE: 'Europe/Amsterdam',
  RUN_HOUR: 6,
  HISTORY_MONTHS: 13,           // first sync: this far back
  OVERLAP_DAYS: 10,             // later syncs: re-read this many days, to catch late completions
  NOTIFY: [],                   // empty = the account that runs the script
  TABS: { BANK: 'Bank', TX: 'Bank transactions', RULES: 'Bank rules', PLACEMENTS: 'Placements',
          CHECKINS: 'Monthly check-ins', SOFTWARE: 'Software (from inventory)', INPUTS: 'Inputs' },
};

const TX_HEADER = ['Date', 'Type', 'State', 'Account', 'Counterparty or merchant', 'Description', 'Reference',
  'Amount', 'Currency', 'Amount (EUR)', 'Category', 'Invoice', 'Transaction id'];

// ---------------------------------------------------------------------------
// Menu and connection
// ---------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Revolut')
    .addItem('Connect Revolut…', 'showConnectDialog')
    .addItem('Sync now', 'syncRevolut')
    .addItem('Disconnect', 'disconnectRevolut')
    .addToUi();
}

function showConnectDialog() {
  const html = HtmlService.createHtmlOutput(CONNECT_HTML).setWidth(520).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connect Revolut Business');
}

/** Called from the dialog. Exchanges the one-time code for tokens and saves everything privately. */
function saveRevolutConnection(form) {
  const clientId = String(form.clientId || '').trim();
  const issuer = String(form.issuer || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const key = String(form.privateKey || '').trim();
  let code = String(form.code || '').trim();
  const m = code.match(/[?&]code=([^&#\s]+)/);
  if (m) code = decodeURIComponent(m[1]);                 // whole redirect URL pasted
  if (!clientId || !issuer || !key || !code) throw new Error('Fill in all four fields.');
  if (!/-----BEGIN PRIVATE KEY-----/.test(key)) {
    throw new Error('The private key must start with -----BEGIN PRIVATE KEY----- (PKCS#8). ' +
      'If yours says BEGIN RSA PRIVATE KEY, convert it: openssl pkcs8 -topk8 -nocrypt -in privatecert.pem -out privatekey-pkcs8.pem');
  }
  const props = PropertiesService.getUserProperties();
  props.setProperties({ RV_CLIENT_ID: clientId, RV_ISSUER: issuer, RV_PRIVATE_KEY: key });
  const tok = tokenRequest_({ grant_type: 'authorization_code', code });
  if (!tok.refresh_token) throw new Error('Revolut did not return a refresh token. Try again with a new code.');
  props.setProperty('RV_REFRESH_TOKEN', tok.refresh_token);
  cacheAccessToken_(tok);
  installTrigger_();
  const result = syncRevolut();
  return `Connected. ${result}`;
}

function disconnectRevolut() {
  const props = PropertiesService.getUserProperties();
  ['RV_CLIENT_ID', 'RV_ISSUER', 'RV_PRIVATE_KEY', 'RV_REFRESH_TOKEN'].forEach(k => props.deleteProperty(k));
  CacheService.getUserCache().remove('RV_ACCESS_TOKEN');
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRevolut')
    .forEach(t => ScriptApp.deleteTrigger(t));
  setStatus_('Disconnected. The sheet keeps the last synced figures; Inputs falls back to the typed balance.', false);
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRevolut')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncRevolut').timeBased().everyDays(1).atHour(RV.RUN_HOUR)
    .inTimezone(RV.TIMEZONE).create();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function base64url_(bytesOrString) {
  return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, '');
}

/** Client assertion JWT that Revolut asks for, signed with the private key (RS256). */
function clientAssertion_(nowSec) {
  const p = PropertiesService.getUserProperties();
  const header = base64url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url_(JSON.stringify({
    iss: p.getProperty('RV_ISSUER'), sub: p.getProperty('RV_CLIENT_ID'),
    aud: 'https://revolut.com', exp: nowSec + 300,
  }));
  const sig = Utilities.computeRsaSha256Signature(`${header}.${payload}`, p.getProperty('RV_PRIVATE_KEY'));
  return `${header}.${payload}.${base64url_(sig)}`;
}

function tokenRequest_(grant) {
  const p = PropertiesService.getUserProperties();
  const res = UrlFetchApp.fetch(`${RV.API}/auth/token`, {
    method: 'post', muteHttpExceptions: true,
    payload: Object.assign({
      client_id: p.getProperty('RV_CLIENT_ID'),
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion_(Math.floor(Date.now() / 1000)),
    }, grant),
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code !== 200) {
    const err = new Error(`Revolut refused the sign-in (${code}): ${body.slice(0, 300)}`);
    err.auth = true;
    throw err;
  }
  return JSON.parse(body);
}

function cacheAccessToken_(tok) {
  const ttl = Math.max(60, Math.min(21600, Number(tok.expires_in || 2400) - 120));
  CacheService.getUserCache().put('RV_ACCESS_TOKEN', tok.access_token, ttl);
}

function accessToken_() {
  const cached = CacheService.getUserCache().get('RV_ACCESS_TOKEN');
  if (cached) return cached;
  const p = PropertiesService.getUserProperties();
  const refresh = p.getProperty('RV_REFRESH_TOKEN');
  if (!refresh) { const e = new Error('Revolut is not connected. Use the Revolut menu, Connect Revolut.'); e.auth = true; throw e; }
  const tok = tokenRequest_({ grant_type: 'refresh_token', refresh_token: refresh });
  if (tok.refresh_token) p.setProperty('RV_REFRESH_TOKEN', tok.refresh_token);
  cacheAccessToken_(tok);
  return tok.access_token;
}

/** GET only. Retries once on a 401 (stale token) and on 429/5xx. */
function apiGet_(path, query) {
  const qs = query ? '?' + Object.keys(query).filter(k => query[k] !== undefined && query[k] !== '')
    .map(k => `${k}=${encodeURIComponent(query[k])}`).join('&') : '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(`${RV.API}${path}${qs}`, {
      method: 'get', muteHttpExceptions: true, headers: { Authorization: `Bearer ${accessToken_()}` },
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if (code === 401 && attempt === 0) { CacheService.getUserCache().remove('RV_ACCESS_TOKEN'); continue; }
    if ((code === 429 || code >= 500) && attempt < 2) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    const err = new Error(`Revolut ${path} answered ${code}: ${res.getContentText().slice(0, 300)}`);
    err.status = code;
    err.auth = code === 401 || code === 403;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function syncRevolut() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return 'Another sync is running.';
  try {
    const now = new Date();
    const accounts = apiGet_('/accounts').filter(a => a.state !== 'inactive');
    const rates = eurRates_(accounts.map(a => a.currency));
    writeBank_(accounts, rates, now);

    const known = readTransactions_();
    const fromDate = known.length && PropertiesService.getUserProperties().getProperty('RV_LAST_SYNC')
      ? new Date(Date.parse(PropertiesService.getUserProperties().getProperty('RV_LAST_SYNC')) - RV.OVERLAP_DAYS * 86400000)
      : addMonths_(now, -RV.HISTORY_MONTHS);
    let fresh, note = '';
    try {
      fresh = fetchTransactions_(fromDate, now);
    } catch (e) {
      // Revolut can limit history to the last 90 days without fresh consent.
      if (e.auth || e.status === 400 || e.status === 403) {
        fresh = fetchTransactions_(new Date(now.getTime() - 89 * 86400000), now);
        note = ' Revolut only gave the last 90 days of transactions.';
      } else throw e;
    }
    const accName = Object.fromEntries(accounts.map(a => [a.id, a.name || a.currency]));
    const rows = mergeRows_(known, fresh.flatMap(t => toRows_(t, accName, rates)));
    const rules = readRules_();
    const softwareNames = readSoftwareNames_();
    rows.forEach(r => { r.category = categorise_(r, rules, softwareNames); r.invoice = invoiceRef_(r); });
    writeTransactions_(rows);

    const paid = matchInvoices_(rows);
    const filled = fillCheckIns_(accounts, rates, rows, now);
    PropertiesService.getUserProperties().setProperty('RV_LAST_SYNC', now.toISOString());
    const msg = `${accounts.length} accounts, ${rows.length} transactions, ${paid.confirmed.length} invoice(s) marked Paid, ` +
      `${filled} month-end balance(s) filled.${note}`;
    setStatus_(`OK ${fmt_(now, 'd MMM yyyy HH:mm')}: ${msg}`, false);
    if (paid.confirmed.length || paid.possible.length) notify_('Revolut: invoice payments found', [
      ...paid.confirmed.map(l => `Marked Paid: ${l}`),
      ...paid.possible.map(l => `Possible match, not changed: ${l}`),
    ]);
    return msg;
  } catch (e) {
    const text = e.auth
      ? `Revolut access stopped working: ${e.message}. Reconnect: Revolut menu, Connect Revolut (a new code from Revolut Business, Settings, APIs).`
      : `Sync failed: ${e.message}`;
    setStatus_(text, true);
    notify_('Revolut sync needs attention', [text, 'Until it is fixed the model keeps the last synced balance.']);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** EUR per unit of each currency. Uses Revolut's rate; falls back to Inputs B35 for USD. */
function eurRates_(currencies) {
  const rates = { EUR: 1 };
  for (const c of [...new Set(currencies)].filter(c => c && c !== 'EUR')) {
    try {
      const r = apiGet_('/rate', { from: c, to: 'EUR', amount: 1 });
      rates[c] = Number(r.rate);
    } catch (e) {
      if (c === 'USD') {
        const usd = Number(sheet_(RV.TABS.INPUTS).getRange('B35').getValue());
        if (usd > 0) rates.USD = 1 / usd;
      }
    }
  }
  return rates;
}

/** All transactions created between from and to, following Revolut's 1000-per-page limit. */
function fetchTransactions_(from, to) {
  const out = {};
  let upper = to.toISOString();
  for (let page = 0; page < 50; page++) {
    const batch = apiGet_('/transactions', { from: from.toISOString(), to: upper, count: 1000 });
    if (!batch.length) break;
    batch.forEach(t => { out[t.id] = t; });
    if (batch.length < 1000) break;
    const oldest = batch.reduce((m, t) => (t.created_at < m ? t.created_at : m), batch[0].created_at);
    if (oldest === upper) break;
    upper = oldest;
  }
  return Object.values(out);
}

/** One row per leg (an internal transfer has a leg on each account). */
function toRows_(t, accName, rates) {
  const legs = t.legs && t.legs.length ? t.legs : [];
  return legs.map(l => {
    const amount = Number(l.amount) || 0;
    const fee = Math.abs(Number(l.fee) || 0);     // Revolut lists a fee apart from the amount
    const net = amount - fee;
    const rate = rates[l.currency] || null;
    const cp = (t.merchant && t.merchant.name) || (l.counterparty && (l.counterparty.name || '')) || '';
    return {
      date: String(t.completed_at || t.created_at || '').slice(0, 10),
      type: t.type || '', state: t.state || '', account: accName[l.account_id] || l.currency || '',
      counterparty: cp, description: l.description || '', reference: t.reference || '',
      amount: round2_(net), currency: l.currency || '',
      eur: rate ? round2_(net * rate) : '',
      selfTransfer: t.type === 'exchange' || !!(l.counterparty && l.counterparty.account_type === 'self'),
      id: `${t.id}:${l.leg_id || l.account_id || ''}`,
      category: '', invoice: '',
    };
  });
}

function mergeRows_(known, fresh) {
  const byId = {};
  known.forEach(r => { byId[r.id] = r; });
  fresh.forEach(r => { byId[r.id] = r; });
  return Object.values(byId).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** Bank rules tab: Category | Text contains | Money in or out (In / Out / Any). First match wins. */
function readRules_() {
  const sh = sheet_(RV.TABS.RULES, true);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .filter(r => r[0] && r[1])
    .map(r => ({ category: String(r[0]).trim(), text: String(r[1]).trim().toLowerCase(),
                 dir: String(r[2] || 'Any').trim().toLowerCase() }));
}

function readSoftwareNames_() {
  const sh = sheet_(RV.TABS.SOFTWARE, true);
  if (!sh || sh.getLastRow() < 2) return [];
  return [...new Set(sh.getRange(2, 4, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim()).filter(Boolean))];
}

/** Words of a tool name that are distinctive enough to find in a card statement line. */
function softwareKeys_(name) {
  const stop = new Set(['the', 'and', 'pro', 'plus', 'team', 'business', 'inc', 'ltd', 'app', 'ai']);
  return String(name).toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !stop.has(w));
}

function categorise_(r, rules, softwareNames) {
  if (r.selfTransfer) return 'Internal transfer';
  const hay = `${r.counterparty} ${r.description} ${r.reference}`.toLowerCase();
  const dir = r.amount >= 0 ? 'in' : 'out';
  for (const rule of rules) {
    if ((rule.dir === 'any' || rule.dir === dir) && hay.includes(rule.text)) return rule.category;
  }
  if (r.type === 'fee') return 'Bank fees';
  if (dir === 'in') return /\bINV-?\d+/i.test(hay) ? 'Client payment' : 'Money in (other)';
  if (/card/.test(r.type)) {
    for (const n of softwareNames) if (softwareKeys_(n).some(k => hay.includes(k))) return 'Software';
  }
  return 'Other costs';
}

function invoiceRef_(r) {
  const m = `${r.reference} ${r.description}`.match(/\bINV-?\s?(\d+)\b/i);
  return m ? `INV-${m[1]}` : '';
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Marks Open or Check invoices Paid. By invoice number in the payment first;
 * then by exact amount (±€1) when exactly one open invoice and one unclaimed
 * payment on or after its invoice date share that amount. Anything less
 * certain is only reported.
 */
function matchInvoices_(rows) {
  const sh = sheet_(RV.TABS.PLACEMENTS);
  const out = { confirmed: [], possible: [] };
  if (sh.getLastRow() < 2) return out;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues();
  const open = vals.map((r, i) => ({ row: i + 2, inv: String(r[0]).trim().toUpperCase(), status: String(r[4]),
    fee: Number(r[5]) || 0, vat: 0, invDate: rvIsDate_(r[7]) ? rvDay_(r[7]) : '' }))
    .filter(p => p.inv && (p.status === 'Open' || p.status === 'Check'));
  if (!open.length) return out;
  const incoming = rows.filter(r => r.state === 'completed' && r.amount > 0 && r.category !== 'Internal transfer');
  const used = new Set();
  const mark = (p, r, how) => {
    sh.getRange(p.row, 5).setValue('Paid');
    sh.getRange(p.row, 9).setValue(Utilities.parseDate(r.date, RV.TIMEZONE, 'yyyy-MM-dd'));
    sh.getRange(p.row, 13).setValue(`Revolut: ${r.counterparty || r.description} ${r.date} (${how})`);
    used.add(r.id);
    out.confirmed.push(`${p.inv} ${rvEuro_(r.amount)} received ${r.date} from ${r.counterparty || r.description || 'unknown'} (was ${p.status}; ${how})`);
  };
  for (const p of open) {
    const r = incoming.find(x => !used.has(x.id) && x.invoice === p.inv);
    if (r) { mark(p, r, 'invoice number in the payment'); p.done = true; }
  }
  for (const p of open.filter(q => !q.done)) {
    const cands = incoming.filter(x => !used.has(x.id) && !x.invoice && Math.abs(x.amount - p.fee) <= 1 &&
      (!p.invDate || x.date >= p.invDate));
    const rivals = open.filter(q => !q.done && q !== p && Math.abs(q.fee - p.fee) <= 1);
    if (cands.length === 1 && !rivals.length) { mark(p, cands[0], 'same amount'); p.done = true; }
    else if (cands.length) out.possible.push(`${p.inv} ${rvEuro_(p.fee)}: ${cands.length} payment(s) of that amount, ` +
      `${rivals.length} other open invoice(s) of that amount. Check Placements by hand.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Monthly check-ins: real month-end balance
// ---------------------------------------------------------------------------

/**
 * Balance at the end of a month = today's balance minus every completed
 * transaction after that month. Fills column B where it is empty and the
 * month is over and inside the synced history.
 */
function fillCheckIns_(accounts, rates, rows, now) {
  const sh = sheet_(RV.TABS.CHECKINS, true);
  if (!sh || sh.getLastRow() < 2) return 0;
  const total = accounts.reduce((s, a) => s + (Number(a.balance) || 0) * (rates[a.currency] || 0), 0);
  const oldest = rows.length ? rows[rows.length - 1].date : rvDay_(now);
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  let filled = 0;
  vals.forEach((r, i) => {
    if (!rvIsDate_(r[0]) || r[1] !== '') return;
    const monthStart = rvDay_(r[0]).slice(0, 7) + '-01';
    const next = nextMonth_(monthStart);
    if (next > rvDay_(now) || oldest > next) return;    // month not over, or history too short
    const after = rows.filter(x => x.state === 'completed' && x.date >= next && x.eur !== '')
      .reduce((s, x) => s + Number(x.eur), 0);
    sh.getRange(i + 2, 2).setValue(round2_(total - after));
    filled++;
  });
  return filled;
}

// ---------------------------------------------------------------------------
// Sheet I/O
// ---------------------------------------------------------------------------

function sheet_(name, optional) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh && !optional) throw new Error(`Tab "${name}" not found.`);
  return sh;
}

function writeBank_(accounts, rates, now) {
  const sh = sheet_(RV.TABS.BANK);
  const total = accounts.reduce((s, a) => s + (Number(a.balance) || 0) * (rates[a.currency] || 0), 0);
  sh.getRange('B1').setValue(now);
  sh.getRange('B2').setValue(round2_(total));
  const last = Math.max(sh.getLastRow(), 6);
  sh.getRange(7, 1, last - 6 + 20, 6).clearContent();
  const table = accounts.map(a => [a.name || a.currency, a.currency, Number(a.balance) || 0,
    rates[a.currency] ? round2_((Number(a.balance) || 0) * rates[a.currency]) : '',
    rates[a.currency] || '', a.state || '']);
  if (table.length) sh.getRange(7, 1, table.length, 6).setValues(table);
}

function setStatus_(text, isError) {
  const sh = sheet_(RV.TABS.BANK, true);
  if (!sh) return;
  sh.getRange('B3').setValue(text);
  if (isError) sh.getRange('B4').setValue(new Date());
}

function readTransactions_() {
  const sh = sheet_(RV.TABS.TX);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, TX_HEADER.length).getValues()
    .filter(r => r[12])
    .map(r => ({ date: rvIsDate_(r[0]) ? rvDay_(r[0]) : String(r[0]), type: r[1], state: r[2], account: r[3],
      counterparty: r[4], description: r[5], reference: r[6], amount: Number(r[7]), currency: r[8],
      eur: r[9] === '' ? '' : Number(r[9]), category: r[10], invoice: r[11], id: String(r[12]),
      selfTransfer: r[10] === 'Internal transfer' }));
}

function writeTransactions_(rows) {
  const sh = sheet_(RV.TABS.TX);
  const old = sh.getLastRow();
  if (old > 1) sh.getRange(2, 1, old - 1, TX_HEADER.length).clearContent();
  sh.getRange(1, 1, 1, TX_HEADER.length).setValues([TX_HEADER]);
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, TX_HEADER.length).setValues(rows.map(r => [
    r.date ? Utilities.parseDate(r.date, RV.TIMEZONE, 'yyyy-MM-dd') : '', r.type, r.state, r.account,
    r.counterparty, r.description, r.reference, r.amount, r.currency, r.eur, r.category, r.invoice, r.id]));
}

function notify_(subject, lines) {
  const to = (RV.NOTIFY.length ? RV.NOTIFY : [Session.getEffectiveUser().getEmail()]).join(',');
  const url = SpreadsheetApp.getActive().getUrl();
  MailApp.sendEmail({ to, subject, body: lines.map(l => `- ${l}`).join('\n') + `\n\nCash flow model: ${url}` });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rvIsDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function rvDay_(d) { return Utilities.formatDate(d, RV.TIMEZONE, 'yyyy-MM-dd'); }
function fmt_(d, f) { return Utilities.formatDate(d, RV.TIMEZONE, f); }
function round2_(n) { return Math.round(n * 100) / 100; }
function addMonths_(d, n) { const x = new Date(d.getTime()); x.setMonth(x.getMonth() + n); return x; }
function nextMonth_(monthStart) {
  const [y, m] = monthStart.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function rvEuro_(n) {
  const s = Math.abs(n).toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-' : '') + '€' + s;
}

const CONNECT_HTML = `
<style>body{font:13px Arial,sans-serif;color:#222}label{display:block;margin:10px 0 4px;font-weight:bold}
input,textarea{width:100%;box-sizing:border-box;font:12px monospace;padding:6px}textarea{height:110px}
button{margin-top:14px;padding:8px 14px}#msg{margin-top:10px;white-space:pre-wrap}p{margin:4px 0;color:#555}</style>
<p>Revolut Business, Settings, APIs, Business API. Steps are in the README.</p>
<label for="clientId">Client ID</label><input id="clientId">
<label for="issuer">OAuth redirect URI you entered in Revolut (for example https://example.com)</label><input id="issuer">
<label for="privateKey">Private key (privatekey.pem, starts with -----BEGIN PRIVATE KEY-----)</label><textarea id="privateKey"></textarea>
<label for="code">Code: after Enable access, paste the address Revolut sent you to (or just the code)</label><input id="code">
<button id="go">Connect and sync</button><div id="msg"></div>
<script>
document.getElementById('go').onclick = function () {
  var b = this; b.disabled = true; document.getElementById('msg').textContent = 'Connecting…';
  google.script.run.withSuccessHandler(function (m) { document.getElementById('msg').textContent = m; b.disabled = false; })
    .withFailureHandler(function (e) { document.getElementById('msg').textContent = 'Not connected: ' + e.message; b.disabled = false; })
    .saveRevolutConnection({clientId: clientId.value, issuer: issuer.value, privateKey: privateKey.value, code: code.value});
};
</script>`;

if (typeof module !== 'undefined') {   // Node test harness only; ignored by Apps Script
  module.exports = { RV, toRows_, mergeRows_, categorise_, invoiceRef_, softwareKeys_, matchInvoices_,
    fillCheckIns_, clientAssertion_, fetchTransactions_, syncRevolut, saveRevolutConnection, apiGet_ };
}
