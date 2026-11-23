/**
 * GTM Talent - Revolut Business sync (Google Apps Script, bound to the
 * "GTM Talent - Cash Flow Model" sheet)                         version 0.3.0
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
 * Access is a Revolut API key made in Revolut's API Console with read-only
 * permissions, plus an Ed25519 signing key. The signing key is made here, in
 * the Connect dialog: only its public half is shown (to paste into the API
 * Console); the private half never leaves this Google account. The API key and
 * signing key are kept in this Google account's private user properties for
 * this script, so other editors of the sheet cannot read them. Setup: README.md.
 *
 * It only ever sends GET requests to /accounts, /transactions and /rate.
 */

const RV = {
  HOST: 'https://b2b.revolut.com',
  API_PATH: '/api/1.0',
  TIMEZONE: 'Europe/Amsterdam',
  RUN_HOUR: 6,
  HISTORY_MONTHS: 13,           // first sync: this far back
  OVERLAP_DAYS: 10,             // later syncs: re-read this many days, to catch late completions
  NOTIFY: [],                   // empty = the account that runs the script
  // Revolut savings fund that the API does not report as an account balance.
  // Its moves show as "To Compound" / "From Compound" and daily
  // "Interest earned - Compound". Its balance is typed once on Inputs
  // (date in B44, amount in B45) and followed from these moves after that.
  FUND: 'Compound',
  FUND_ANCHOR: { DATE: 'B44', AMOUNT: 'B45' },
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
  const html = HtmlService.createHtmlOutput(CONNECT_HTML).setWidth(560).setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connect Revolut Business');
}

/**
 * Step 1 of the dialog. Makes a new Ed25519 signing key (or keeps the one made
 * earlier, unless fresh is true) and returns its public half as PEM text.
 */
function getSigningPublicKey(fresh) {
  const props = PropertiesService.getUserProperties();
  let seedB64 = props.getProperty('RV_SIGNING_SEED');
  if (!seedB64 || fresh) {
    seedB64 = bytesToB64_(randomSeed_());
    props.setProperty('RV_SIGNING_SEED', seedB64);
  }
  return publicKeyPem_(ed25519PublicKey_(b64ToBytes_(seedB64)));
}

/** Optional: use a private.pem made with OpenSSL instead of the one made here. */
function usePrivateKeyPem(pem) {
  const seed = seedFromPem_(pem);
  PropertiesService.getUserProperties().setProperty('RV_SIGNING_SEED', bytesToB64_(seed));
  return publicKeyPem_(ed25519PublicKey_(seed));
}

/** Step 2 of the dialog: saves the API key, checks it, installs the daily run and syncs. */
function saveRevolutConnection(form) {
  const key = String(form.apiKey || '').trim().replace(/^Bearer\s+/i, '');
  if (!key) throw new Error('Paste the API key from Revolut\'s API Console.');
  const props = PropertiesService.getUserProperties();
  if (!props.getProperty('RV_SIGNING_SEED')) throw new Error('Make the signing key first (step 1).');
  const previous = props.getProperty('RV_API_KEY');
  props.setProperty('RV_API_KEY', key);
  try {
    apiGet_('/accounts');
  } catch (e) {
    if (previous) props.setProperty('RV_API_KEY', previous); else props.deleteProperty('RV_API_KEY');
    throw new Error(`Revolut did not accept it: ${e.message}. Check that the API Console key has the public ` +
      'signing key from step 1 and Accounts read access.');
  }
  installTrigger_();
  return `Connected. ${syncRevolut()}`;
}

function disconnectRevolut() {
  const props = PropertiesService.getUserProperties();
  ['RV_API_KEY', 'RV_SIGNING_SEED', 'RV_LAST_SYNC', 'RV_NOTIFIED'].forEach(k => props.deleteProperty(k));
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRevolut')
    .forEach(t => ScriptApp.deleteTrigger(t));
  setStatus_('Disconnected. The sheet keeps the last synced figures. Revoke the key in Revolut\'s API Console too.', false);
}

function installTrigger_() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncRevolut')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncRevolut').timeBased().everyDays(1).atHour(RV.RUN_HOUR)
    .inTimezone(RV.TIMEZONE).create();
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * GET only. Signs each request as Revolut's API Console asks: Ed25519 over
 * timestamp + "GET" + path from /api + query string (as sent) + body (none).
 * Retries on 429/5xx.
 */
function apiGet_(path, query) {
  const props = PropertiesService.getUserProperties();
  const key = props.getProperty('RV_API_KEY');
  const seedB64 = props.getProperty('RV_SIGNING_SEED');
  if (!key || !seedB64) { const e = new Error('Revolut is not connected. Use the Revolut menu, Connect Revolut.'); e.auth = true; throw e; }
  const seed = b64ToBytes_(seedB64);
  const qs = query ? Object.keys(query).filter(k => query[k] !== undefined && query[k] !== '')
    .map(k => `${k}=${encodeURIComponent(query[k])}`).join('&') : '';
  const fullPath = RV.API_PATH + path;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ts = String(Date.now());
    const sig = bytesToB64_(ed25519Sign_(seed, utf8_(ts + 'GET' + fullPath + qs)));
    const res = UrlFetchApp.fetch(`${RV.HOST}${fullPath}${qs ? '?' + qs : ''}`, {
      method: 'get', muteHttpExceptions: true,
      headers: { Authorization: `Bearer ${key}`, 'Revolut-Api-Timestamp': ts, 'Revolut-Api-Signature': sig },
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    if ((code === 429 || code >= 500) && attempt < 2) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    const err = new Error(`Revolut ${path} answered ${code}: ${res.getContentText().slice(0, 300)}`);
    err.status = code;
    err.auth = code === 401;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Ed25519 (RFC 8032), for signing requests. Apps Script has no Ed25519, so it
// is done here with plain numbers, following TweetNaCl (public domain): a
// field element is 16 limbs of 16 bits. SHA-512 comes from Utilities.
// ---------------------------------------------------------------------------

function gf_(init) { const r = new Float64Array(16); if (init) for (let i = 0; i < init.length; i++) r[i] = init[i]; return r; }
const ED_D2 = gf_([0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406]);
const ED_X = gf_([0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169]);
const ED_Y = gf_([0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666]);
const ED_L = [0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10];

function car_(o) {
  let c = 1;
  for (let i = 0; i < 16; i++) { const v = o[i] + c + 65535; c = Math.floor(v / 65536); o[i] = v - c * 65536; }
  o[0] += c - 1 + 37 * (c - 1);
}
function sel_(p, q, b) {
  const c = ~(b - 1);
  for (let i = 0; i < 16; i++) { const t = c & (p[i] ^ q[i]); p[i] ^= t; q[i] ^= t; }
}
function pack25519_(o, n) {
  const m = gf_(), t = gf_(n);
  car_(t); car_(t); car_(t);
  for (let j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (let i = 1; i < 15; i++) { m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1); m[i - 1] &= 0xffff; }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    const b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel_(t, m, 1 - b);
  }
  for (let i = 0; i < 16; i++) { o[2 * i] = t[i] & 0xff; o[2 * i + 1] = t[i] >> 8; }
}
function fA_(o, a, b) { for (let i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
function fZ_(o, a, b) { for (let i = 0; i < 16; i++) o[i] = a[i] - b[i]; }
function fM_(o, a, b) {
  const t = new Float64Array(31);
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
  for (let i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (let i = 0; i < 16; i++) o[i] = t[i];
  car_(o); car_(o);
}
function inv25519_(o, i) {
  const c = gf_(i);
  for (let a = 253; a >= 0; a--) { fM_(c, c, c); if (a !== 2 && a !== 4) fM_(c, c, i); }
  for (let a = 0; a < 16; a++) o[a] = c[a];
}
function edAdd_(p, q) {
  const a = gf_(), b = gf_(), c = gf_(), d = gf_(), e = gf_(), f = gf_(), g = gf_(), h = gf_(), t = gf_();
  fZ_(a, p[1], p[0]); fZ_(t, q[1], q[0]); fM_(a, a, t);
  fA_(b, p[0], p[1]); fA_(t, q[0], q[1]); fM_(b, b, t);
  fM_(c, p[3], q[3]); fM_(c, c, ED_D2);
  fM_(d, p[2], q[2]); fA_(d, d, d);
  fZ_(e, b, a); fZ_(f, d, c); fA_(g, d, c); fA_(h, b, a);
  fM_(p[0], e, f); fM_(p[1], h, g); fM_(p[2], g, f); fM_(p[3], e, h);
}
function edPack_(p) {
  const tx = gf_(), ty = gf_(), zi = gf_(), r = new Array(32).fill(0), px = new Array(32).fill(0);
  inv25519_(zi, p[2]); fM_(tx, p[0], zi); fM_(ty, p[1], zi);
  pack25519_(r, ty); pack25519_(px, tx);
  r[31] ^= (px[0] & 1) << 7;
  return r;
}
/** s (32 little-endian bytes) times the base point, packed. */
function edBase_(s) {
  const p = [gf_(), gf_([1]), gf_([1]), gf_()];
  const q = [gf_(ED_X), gf_(ED_Y), gf_([1]), gf_()];
  fM_(q[3], ED_X, ED_Y);
  for (let i = 255; i >= 0; --i) {
    const b = (s[(i / 8) | 0] >> (i & 7)) & 1;
    for (let k = 0; k < 4; k++) sel_(p[k], q[k], b);
    edAdd_(q, p); edAdd_(p, p);
    for (let k = 0; k < 4; k++) sel_(p[k], q[k], b);
  }
  return edPack_(p);
}
function modL_(r, x) {
  let carry, j;
  for (let i = 63; i >= 32; --i) {
    carry = 0;
    const k = i - 12;
    for (j = i - 32; j < k; ++j) {
      x[j] += carry - 16 * x[i] * ED_L[j - (i - 32)];
      carry = Math.floor((x[j] + 128) / 256);
      x[j] -= carry * 256;
    }
    x[j] += carry;
    x[i] = 0;
  }
  carry = 0;
  for (j = 0; j < 32; j++) { x[j] += carry - (x[31] >> 4) * ED_L[j]; carry = x[j] >> 8; x[j] &= 255; }
  for (j = 0; j < 32; j++) x[j] -= carry * ED_L[j];
  for (let i = 0; i < 32; i++) { x[i + 1] += x[i] >> 8; r[i] = x[i] & 255; }
}
/** 64 bytes, read as a little-endian number, reduced mod L to 32 bytes. */
function reduceL_(h) {
  const x = new Float64Array(64);
  for (let i = 0; i < 64; i++) x[i] = h[i];
  const r = new Array(32).fill(0);
  modL_(r, x);
  return r;
}
function edExpand_(seed) {
  const h = sha512_(seed);
  h[0] &= 248; h[31] &= 127; h[31] |= 64;
  return { a: h.slice(0, 32), prefix: h.slice(32) };
}
function ed25519PublicKey_(seed) { return edBase_(edExpand_(seed).a); }
function ed25519Sign_(seed, msg) {
  const { a, prefix } = edExpand_(seed);
  const A = edBase_(a);
  const r = reduceL_(sha512_(prefix.concat(msg)));
  const R = edBase_(r);
  const k = reduceL_(sha512_(R.concat(A, msg)));
  const x = new Float64Array(64);
  for (let i = 0; i < 32; i++) x[i] = r[i];
  for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) x[i + j] += k[i] * a[j];
  const S = new Array(32).fill(0);
  modL_(S, x);
  return R.concat(S);
}

// Byte helpers. Apps Script's Utilities work with signed Java bytes (-128..127).
function toSigned_(bytes) { return bytes.map(b => (b > 127 ? b - 256 : b)); }
function toUnsigned_(bytes) { return Array.from(bytes, b => (b < 0 ? b + 256 : b)); }
function sha512_(bytes) { return toUnsigned_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_512, toSigned_(bytes))); }
function utf8_(s) { return toUnsigned_(Utilities.newBlob(s).getBytes()); }
function bytesToB64_(bytes) { return Utilities.base64Encode(toSigned_(bytes)); }
function b64ToBytes_(s) { return toUnsigned_(Utilities.base64Decode(s)); }

/** 32 random bytes: four random UUIDs and the time, hashed. */
function randomSeed_() {
  const material = [1, 2, 3, 4].map(() => Utilities.getUuid()).join('') + Date.now() + Math.random();
  return toUnsigned_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, material));
}

const SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const PKCS8_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

function publicKeyPem_(pub) {
  const b64 = bytesToB64_(SPKI_PREFIX.concat(pub));
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

function seedFromPem_(pem) {
  const body = String(pem || '').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = body ? b64ToBytes_(body) : [];
  const ok = der.length === 48 && PKCS8_PREFIX.every((b, i) => der[i] === b);
  if (!/BEGIN PRIVATE KEY/.test(pem) || !ok) {
    throw new Error('That is not an Ed25519 private key (private.pem from "openssl genpkey -algorithm ed25519").');
  }
  return der.slice(16);
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

    const known = readTransactions_();
    const fromDate = known.length && PropertiesService.getUserProperties().getProperty('RV_LAST_SYNC')
      ? new Date(Date.parse(PropertiesService.getUserProperties().getProperty('RV_LAST_SYNC')) - RV.OVERLAP_DAYS * 86400000)
      : addMonths_(now, -RV.HISTORY_MONTHS);
    let fresh, note = '';
    try {
      fresh = fetchTransactions_(fromDate, now);
    } catch (e) {
      // In case Revolut limits how far back transactions can be read.
      if (e.status === 400 || e.status === 403) {
        fresh = fetchTransactions_(new Date(now.getTime() - 89 * 86400000), now);
        note = ' Revolut only gave the last 90 days of transactions.';
      } else throw e;
    }
    const accName = {};
    accounts.forEach(a => { accName[a.id] = a.name || a.currency; });
    const freshRows = [];
    fresh.forEach(t => { toRows_(t, accName, rates).forEach(r => freshRows.push(r)); });
    const rows = mergeRows_(known, freshRows);
    const rules = readRules_();
    const softwareNames = readSoftwareNames_();
    rows.forEach(r => { r.category = categorise_(r, rules, softwareNames); r.invoice = invoiceRef_(r); });
    markInternal_(rows);
    writeTransactions_(rows);

    const fund = fundBalance_(rows);
    writeBank_(accounts, rates, now, fund);
    const paid = matchInvoices_(rows);
    const filled = fund === null ? 0 : fillCheckIns_(accounts, rates, rows, now, fund);
    PropertiesService.getUserProperties().setProperty('RV_LAST_SYNC', now.toISOString());
    const msg = `${accounts.length} accounts, ${rows.length} transactions, ${paid.confirmed.length} invoice(s) marked Paid, ` +
      `${filled} month-end balance(s) filled.${note}` +
      (fund === null ? ` Savings fund (${RV.FUND}) balance not set yet: type it on Inputs ${RV.FUND_ANCHOR.DATE}:${RV.FUND_ANCHOR.AMOUNT}.` : '');
    setStatus_(`OK ${fmt_(now, 'd MMM yyyy HH:mm')}: ${msg}`, false);
    const seen = JSON.parse(PropertiesService.getUserProperties().getProperty('RV_NOTIFIED') || '{}');
    const newPossible = paid.possible.filter(l => !seen[l]);
    newPossible.forEach(l => { seen[l] = 1; });
    PropertiesService.getUserProperties().setProperty('RV_NOTIFIED', JSON.stringify(seen));
    if (paid.confirmed.length || newPossible.length) notify_('Revolut: invoice payments found', [
      ...paid.confirmed.map(l => `Marked Paid: ${l}`),
      ...newPossible.map(l => `Possible match, not changed: ${l}`),
    ]);
    return msg;
  } catch (e) {
    const text = e.auth
      ? `Revolut refused the API key: ${e.message}. It may have expired or been revoked in Revolut's API Console. ` +
        'Make a new key there (same signing key, read-only permissions) and paste it in Revolut menu, Connect Revolut, step 2.'
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
 * Balance at the end of a month = accounts today minus every completed account
 * movement since, plus the savings fund then. Fills column B where it is empty,
 * the month is over and inside the synced history.
 */
function fillCheckIns_(accounts, rates, rows, now, fundNow) {
  const sh = sheet_(RV.TABS.CHECKINS, true);
  if (!sh || sh.getLastRow() < 2) return 0;
  const total = accountsTotal_(accounts, rates);
  const oldest = rows.length ? rows[rows.length - 1].date : rvDay_(now);
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  let filled = 0;
  vals.forEach((r, i) => {
    if (!rvIsDate_(r[0]) || r[1] !== '') return;
    const monthStart = rvDay_(r[0]).slice(0, 7) + '-01';
    const next = nextMonth_(monthStart);
    if (next > rvDay_(now) || oldest > next) return;    // month not over, or history too short
    let accAfter = 0, fundAfter = 0;
    rows.forEach(x => {
      if (x.state !== 'completed' || x.date < next || x.eur === '') return;
      if (!isFundLeg_(x)) accAfter += Number(x.eur);
      fundAfter += fundFlow_(x);
    });
    sh.getRange(i + 2, 2).setValue(round2_(total - accAfter + fundNow - fundAfter));
    filled++;
  });
  return filled;
}

// ---------------------------------------------------------------------------
// Savings fund and transfers between own money
// ---------------------------------------------------------------------------

function fundRe_(prefix) { return new RegExp('^' + prefix + RV.FUND + '$', 'i'); }

/** Legs that happen inside the fund (withdrawals out of it, interest): not account movements. */
function isFundLeg_(r) {
  const d = String(r.description || '').trim();
  return fundRe_('from ').test(d) || fundRe_('interest earned - ').test(d);
}

/** How much a leg moves the fund's balance (EUR). */
function fundFlow_(r) {
  if (r.state !== 'completed' || r.eur === '') return 0;
  const d = String(r.description || '').trim();
  const eur = Number(r.eur) || 0;
  if (fundRe_('to ').test(d)) return -eur;          // Main -X: fund +X
  if (fundRe_('from ').test(d)) return eur;         // -X: fund -X
  if (fundRe_('interest earned - ').test(d)) return eur;
  return 0;
}

/** Fund balance now: the typed balance on Inputs plus every move after that day; null if not typed. */
function fundBalance_(rows) {
  const inputs = sheet_(RV.TABS.INPUTS, true);
  if (!inputs) return null;
  const day = inputs.getRange(RV.FUND_ANCHOR.DATE).getValue();
  const amount = inputs.getRange(RV.FUND_ANCHOR.AMOUNT).getValue();
  if (!rvIsDate_(day) || amount === '' || amount === null || isNaN(Number(amount))) return null;
  const from = rvDay_(day);
  return rows.filter(r => r.date > from).reduce((s, r) => s + fundFlow_(r), Number(amount));
}

/** A transaction is internal when any of its legs is (exchange, own account, savings fund). */
function markInternal_(rows) {
  const tx = r => String(r.id).split(':')[0];
  const internal = {};
  rows.forEach(r => {
    const d = String(r.description || '').trim();
    if (r.category === 'Internal transfer' || fundRe_('to ').test(d) || fundRe_('from ').test(d)) internal[tx(r)] = 1;
  });
  rows.forEach(r => { if (internal[tx(r)]) r.category = 'Internal transfer'; });
}

function accountsTotal_(accounts, rates) {
  return accounts.reduce((s, a) => s + (Number(a.balance) || 0) * (rates[a.currency] || 0), 0);
}

// ---------------------------------------------------------------------------
// Sheet I/O
// ---------------------------------------------------------------------------

function sheet_(name, optional) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh && !optional) throw new Error(`Tab "${name}" not found.`);
  return sh;
}

function writeBank_(accounts, rates, now, fund) {
  const sh = sheet_(RV.TABS.BANK);
  const total = accountsTotal_(accounts, rates);
  sh.getRange('B1').setValue(now);
  sh.getRange('B2').setValue(round2_(total + (fund || 0)));
  sh.getRange('H1:I2').setValues([
    ['Revolut accounts (EUR)', round2_(total)],
    [`Savings fund (${RV.FUND}), followed from the typed balance on Inputs`, fund === null ? 'Not set' : round2_(fund)],
  ]);
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
<style>body{font:13px Arial,sans-serif;color:#222}h3{margin:14px 0 6px;font-size:14px}p{margin:4px 0;color:#444}
textarea,input{width:100%;box-sizing:border-box;font:12px monospace;padding:6px}textarea{height:84px}
button{margin:8px 8px 0 0;padding:7px 12px}#msg1,#msg2{margin-top:8px;white-space:pre-wrap}details{margin-top:6px;color:#555}</style>
<h3>Step 1: signing key</h3>
<p>Copy this public key and give it to whoever creates the API key in Revolut's API Console (it is safe to share).
The private half stays in your Google account.</p>
<textarea id="pub" readonly placeholder="Loading…"></textarea>
<button id="copy">Copy public key</button><button id="fresh">Make a new one</button>
<details><summary>Use my own private.pem instead</summary>
<textarea id="pem" placeholder="-----BEGIN PRIVATE KEY-----"></textarea><button id="usepem">Use this key</button></details>
<div id="msg1"></div>
<h3>Step 2: API key</h3>
<p>Paste the API key Revolut's API Console showed after "Create API key".</p>
<input id="apiKey" autocomplete="off">
<button id="go">Connect and sync</button><div id="msg2"></div>
<script>
function $(id){return document.getElementById(id);}
function show(pem){$('pub').value=pem;}
function fail(where){return function(e){$(where).textContent='Not done: '+e.message;};}
google.script.run.withSuccessHandler(show).withFailureHandler(fail('msg1')).getSigningPublicKey(false);
$('copy').onclick=function(){$('pub').select();
  try{navigator.clipboard.writeText($('pub').value).then(function(){$('msg1').textContent='Copied.';},function(){document.execCommand('copy');$('msg1').textContent='Copied.';});}
  catch(e){document.execCommand('copy');$('msg1').textContent='Copied.';}};
$('fresh').onclick=function(){$('msg1').textContent='A new key replaces the old one: any API key made with the old public key stops working. Making it…';
  google.script.run.withSuccessHandler(function(p){show(p);$('msg1').textContent='New key made. Give this public key to Revolut.';}).withFailureHandler(fail('msg1')).getSigningPublicKey(true);};
$('usepem').onclick=function(){google.script.run.withSuccessHandler(function(p){show(p);$('pem').value='';$('msg1').textContent='Using your key.';}).withFailureHandler(fail('msg1')).usePrivateKeyPem($('pem').value);};
$('go').onclick=function(){var b=this;b.disabled=true;$('msg2').textContent='Connecting and reading 13 months of transactions…';
  google.script.run.withSuccessHandler(function(m){$('msg2').textContent=m;$('apiKey').value='';b.disabled=false;})
    .withFailureHandler(function(e){$('msg2').textContent='Not connected: '+e.message;b.disabled=false;})
    .saveRevolutConnection({apiKey:$('apiKey').value});};
</script>`;

if (typeof module !== 'undefined') {   // Node test harness only; ignored by Apps Script
  module.exports = { RV, toRows_, mergeRows_, categorise_, invoiceRef_, softwareKeys_, matchInvoices_,
    fillCheckIns_, fetchTransactions_, fundBalance_, fundFlow_, markInternal_, syncRevolut, saveRevolutConnection, apiGet_, getSigningPublicKey,
    usePrivateKeyPem, ed25519Sign_, ed25519PublicKey_, seedFromPem_, disconnectRevolut };
}
