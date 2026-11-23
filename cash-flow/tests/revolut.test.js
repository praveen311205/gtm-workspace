// node cash-flow/tests/revolut.test.js — fake Revolut API, Sheets, cache and properties
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.error('FAIL: ' + msg); } };
const D = s => new Date(s + 'T12:00:00Z');
const key = (d) => d.toISOString().slice(0, 10);

function makeSheet(rows) {
  const data = rows.map(r => r.slice());
  const ensure = (r, c) => { while (data.length < r) data.push([]); while (data[r - 1].length < c) data[r - 1].push(''); };
  return { data,
    getLastRow: () => { for (let i = data.length; i > 0; i--) if (data[i - 1].some(v => v !== '' && v !== null && v !== undefined)) return i; return 0; },
    getRange(a, b, h = 1, w = 1) {
      if (typeof a === 'string') { const m = a.match(/([A-Z])(\d+)/); b = m[1].charCodeAt(0) - 64; a = Number(m[2]); }
      const r0 = a, c0 = b;
      return {
        getValues: () => { const o = []; for (let i = 0; i < h; i++) { ensure(r0 + i, c0 + w - 1); o.push(data[r0 + i - 1].slice(c0 - 1, c0 - 1 + w)); } return o; },
        getValue: () => { ensure(r0, c0); return data[r0 - 1][c0 - 1]; },
        setValue: v => { ensure(r0, c0); data[r0 - 1][c0 - 1] = v; },
        setValues: vs => vs.forEach((row, i) => row.forEach((v, j) => { ensure(r0 + i, c0 + j); data[r0 + i - 1][c0 + j - 1] = v; })),
        clearContent: () => { for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) { ensure(r0 + i, c0 + j); data[r0 + i - 1][c0 + j - 1] = ''; } },
      };
    } };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const seedOf = pem => crypto.createPrivateKey(pem).export({ format: 'der', type: 'pkcs8' }).slice(16);

function env(opts = {}) {
  const userProps = Object.assign({}, opts.props || {});
  const sent = [], calls = [], sigChecks = [];
  const sheets = {
    Bank: makeSheet([['Last synced', ''], ['Balance', ''], ['Status', ''], ['', ''], [''], ['Account', 'Currency', 'Balance', 'EUR', 'Rate', 'State']]),
    'Bank transactions': makeSheet([[]]),
    'Bank rules': makeSheet([['Category', 'Text contains', 'In or out'], ['Accountant', 'dkb', 'Out'], ['Salary', 'premkumar', 'Out'], ['Tax', 'belastingdienst', 'Any']]),
    Placements: makeSheet([
      ['Invoice', 'Client', 'Cand', 'Type', 'Status', 'Fee', 'VAT', 'Inv date', 'Pay date'],
      ['INV-22', 'Seq', '', 'Placement', 'Check', 22417.38, 0, D('2026-03-20'), ''],
      ['INV-23', 'Light', '', 'Placement', 'Check', 34460.85, 0, D('2026-04-09'), ''],
      ['INV-31', 'X', '', 'Placement', 'Open', 15000, 0, D('2026-10-07'), D('2026-10-14')],
      ['INV-40', 'Y', '', 'Retainer', 'Open', 5000, 0, D('2026-11-01'), D('2026-11-10')],
      ['INV-41', 'Z', '', 'Retainer', 'Open', 5000, 0, D('2026-11-01'), D('2026-11-10')],
    ]),
    'Monthly check-ins': makeSheet([['Month', 'Actual'], [D('2026-10-01'), ''], [D('2026-11-01'), ''], [D('2025-01-01'), '']]),
    'Software (from inventory)': makeSheet([['Date', 'Row', 'Rem', 'Tool'], ['', '', '', 'Slack'], ['', '', '', 'LinkedIn Recruiter Lite'], ['', '', '', 'Claude (Anthropic)']]),
    Inputs: makeSheet(Array.from({ length: 35 }, (_, i) => i === 34 ? ['', 1.0992] : [''])),
  };
  const accounts = opts.accounts || [
    { id: 'a1', name: 'Main', currency: 'EUR', balance: 140000, state: 'active' },
    { id: 'a2', name: 'USD', currency: 'USD', balance: 1100, state: 'active' },
    { id: 'a3', name: 'Old', currency: 'EUR', balance: 0, state: 'inactive' },
  ];
  const tx = opts.tx || [
    { id: 't1', type: 'transfer', state: 'completed', created_at: '2026-11-05T09:00:00Z', completed_at: '2026-11-05T09:01:00Z', reference: 'Payment INV-31',
      legs: [{ leg_id: 'l1', account_id: 'a1', amount: 15000, currency: 'EUR', description: 'Payment from Acme Ltd', counterparty: { account_type: 'external' } }] },
    { id: 't2', type: 'transfer', state: 'completed', created_at: '2026-10-20T09:00:00Z', completed_at: '2026-10-20T09:00:00Z', reference: '',
      legs: [{ leg_id: 'l2', account_id: 'a1', amount: 22417.38, currency: 'EUR', description: 'From SequenceHQ Ltd', counterparty: { account_type: 'external' } }] },
    { id: 't3', type: 'card_payment', state: 'completed', created_at: '2026-11-03T09:00:00Z', completed_at: '2026-11-04T09:00:00Z', merchant: { name: 'SLACK T0123' },
      legs: [{ leg_id: 'l3', account_id: 'a1', amount: -8.25, currency: 'EUR', description: 'Slack' }] },
    { id: 't4', type: 'transfer', state: 'completed', created_at: '2026-10-25T09:00:00Z', reference: 'Salaris okt',
      legs: [{ leg_id: 'l4', account_id: 'a1', amount: -4833, fee: 0, currency: 'EUR', description: 'To Navin Premkumar', counterparty: { account_type: 'external' } }] },
    { id: 't5', type: 'exchange', state: 'completed', created_at: '2026-11-10T09:00:00Z',
      legs: [{ leg_id: 'l5a', account_id: 'a1', amount: -1000, currency: 'EUR', description: 'Exchanged to USD' },
             { leg_id: 'l5b', account_id: 'a2', amount: 1100, currency: 'USD', description: 'Exchanged from EUR' }] },
    { id: 't6', type: 'card_payment', state: 'declined', created_at: '2026-11-12T09:00:00Z', merchant: { name: 'PIN.COM' },
      legs: [{ leg_id: 'l6', account_id: 'a1', amount: -162.85, currency: 'EUR', description: 'Pin' }] },
    { id: 't7', type: 'fee', state: 'completed', created_at: '2026-11-01T09:00:00Z',
      legs: [{ leg_id: 'l7', account_id: 'a1', amount: -30, currency: 'EUR', description: 'Grow plan fee' }] },
    { id: 't8', type: 'transfer', state: 'completed', created_at: '2026-11-15T09:00:00Z', reference: 'Retainer',
      legs: [{ leg_id: 'l8', account_id: 'a1', amount: 5000, currency: 'EUR', description: 'From Y GmbH', counterparty: { account_type: 'external' } }] },
    { id: 't9', type: 'card_payment', state: 'completed', created_at: '2026-11-16T09:00:00Z', merchant: { name: 'LINKEDIN 123' },
      legs: [{ leg_id: 'l9', account_id: 'a2', amount: -110, fee: 1.5, currency: 'USD', description: 'LinkedIn' }] },
  ];
  const fetch = (url, o) => {
    calls.push({ url, o });
    if (opts.fail && opts.fail(url)) return { getResponseCode: () => opts.failCode || 500, getContentText: () => '{"message":"nope"}' };
    sigChecks.push(verifySig(url, o, userProps));
    if (o.method !== 'get') throw new Error('non-GET API call ' + url);
    if (url.includes('/accounts')) return { getResponseCode: () => 200, getContentText: () => JSON.stringify(accounts) };
    if (url.includes('/rate')) return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ rate: 0.91 }) };
    if (url.includes('/transactions')) {
      const q = Object.fromEntries(url.split('?')[1].split('&').map(kv => kv.split('=').map(decodeURIComponent)));
      const list = (opts.pages ? opts.pages(q) : tx.filter(t => t.created_at >= q.from && t.created_at <= q.to));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(list) };
    }
    return { getResponseCode: () => 404, getContentText: () => '' };
  };
  const ctx = {
    console, module: { exports: {} }, JSON, Math, Number, String, Object, Array, Set, Date, Float64Array, encodeURIComponent, decodeURIComponent,
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n], getUrl: () => 'https://sheet' }), getUi: () => ({}) },
    PropertiesService: { getUserProperties: () => ({ getProperty: k => userProps[k] ?? null, setProperty: (k, v) => { userProps[k] = v; },
      setProperties: o => Object.assign(userProps, o), deleteProperty: k => { delete userProps[k]; } }) },
    UrlFetchApp: { fetch },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: m => sent.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => { const t = { timeBased: () => t, everyDays: () => t, atHour: () => t, inTimezone: () => t, create: () => {} }; return t; } },
    Utilities: {
      formatDate: (d, tz, f) => f === 'yyyy-MM-dd' ? key(d) : d.toISOString(),
      parseDate: s => D(s),
      DigestAlgorithm: { SHA_512: 'sha512', SHA_256: 'sha256' },
      computeDigest: (alg, input) => signed(crypto.createHash(alg).update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input.map(b => b & 255))).digest()),
      newBlob: str => ({ getBytes: () => signed(Buffer.from(str, 'utf8')) }),
      base64Encode: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64'),
      base64Decode: str => signed(Buffer.from(str, 'base64')),
      getUuid: () => crypto.randomUUID(),
      sleep() {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'revolut-sync.gs'), 'utf8'), ctx);
  return { m: ctx.module.exports, sheets, sent, calls, userProps, sigChecks, ctx };
}
const signed = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
const connected = { RV_API_KEY: 'key-1', RV_SIGNING_SEED: seedOf(privateKey).toString('base64') };
// Checks a request the way Revolut does: Ed25519 over ts + method + path + query, with the uploaded public key.
function verifySig(url, o, props) {
  const u = new URL(url);
  const ts = o.headers['Revolut-Api-Timestamp'];
  const msg = ts + 'GET' + u.pathname + (u.search ? u.search.slice(1) : '');
  const seed = Buffer.from(props.RV_SIGNING_SEED, 'base64');
  const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }));
  return o.headers.Authorization === 'Bearer ' + props.RV_API_KEY &&
    crypto.verify(null, Buffer.from(msg), pub, Buffer.from(o.headers['Revolut-Api-Signature'], 'base64'));
}

// Ed25519 matches Node's implementation
{
  const e = env({ props: connected });
  const seed = [...seedOf(privateKey)];
  const msg = [...Buffer.from('1783616701644GET/api/1.0/accountsfrom=x')];
  const ours = Buffer.from(e.m.ed25519Sign_(seed, msg));
  const nodes = crypto.sign(null, Buffer.from(msg), privateKey);
  ok(ours.equals(nodes), 'signature identical to Node crypto');
  const pubDer = crypto.createPublicKey(publicKey).export({ format: 'der', type: 'spki' }).slice(12);
  ok(Buffer.from(e.m.ed25519PublicKey_(seed)).equals(pubDer), 'public key identical to Node crypto');
  ok(e.m.usePrivateKeyPem(privateKey).replace(/\s/g, '') === publicKey.replace(/\s/g, ''), 'own private.pem gives the matching public.pem');
  let err = ''; try { e.m.seedFromPem_('-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'); } catch (x) { err = x.message; }
  ok(/not an Ed25519 private key/.test(err), 'wrong key type refused');
}
// key made in the dialog
{
  const e = env({ props: {} });
  const pem = e.m.getSigningPublicKey(false);
  ok(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]{60}\n-----END PUBLIC KEY-----$/.test(pem), 'public key PEM shape');
  const k = crypto.createPublicKey(pem);
  ok(k.asymmetricKeyType === 'ed25519', 'Node reads it as an Ed25519 public key');
  ok(e.m.getSigningPublicKey(false) === pem, 'same key on reopening the dialog');
  ok(e.m.getSigningPublicKey(true) !== pem, 'new key on request');
  ok(env({ props: {} }).m.getSigningPublicKey(false) !== pem, 'different accounts get different keys');
}
// categorise
{
  const { m } = env();
  const rules = [{ category: 'Accountant', text: 'dkb', dir: 'out' }, { category: 'Salary', text: 'premkumar', dir: 'out' }];
  const sw = ['Slack', 'LinkedIn Recruiter Lite', 'Claude (Anthropic)'];
  const r = (o) => Object.assign({ counterparty: '', description: '', reference: '', type: 'transfer', amount: -1, selfTransfer: false }, o);
  ok(m.categorise_(r({ selfTransfer: true }), rules, sw) === 'Internal transfer', 'internal');
  ok(m.categorise_(r({ description: 'To DKB-finance B.V.' }), rules, sw) === 'Accountant', 'rule');
  ok(m.categorise_(r({ description: 'From DKB refund', amount: 10 }), rules, sw) === 'Money in (other)', 'rule direction respected');
  ok(m.categorise_(r({ type: 'card_payment', counterparty: 'LINKEDIN 8812' }), rules, sw) === 'Software', 'software by inventory name');
  ok(m.categorise_(r({ type: 'card_payment', counterparty: 'ANTHROPIC' }), rules, sw) === 'Software', 'software from bracket name');
  ok(m.categorise_(r({ type: 'card_payment', counterparty: 'Albert Heijn' }), rules, sw) === 'Other costs', 'other card');
  ok(m.categorise_(r({ type: 'fee' }), rules, sw) === 'Bank fees', 'fee');
  ok(m.categorise_(r({ amount: 100, reference: 'INV-12' }), rules, sw) === 'Client payment', 'client payment by INV');
  ok(m.invoiceRef_({ reference: 'inv 31', description: '' }) === 'INV-31' && m.invoiceRef_({ reference: 'invoice 31', description: '' }) === '' && m.invoiceRef_({ reference: 'Inv-31 thanks', description: '' }) === 'INV-31' && m.invoiceRef_({ reference: '', description: 'INV 7' }) === 'INV-7', 'invoice refs');
}
// full sync
{
  const e = env({ props: connected });
  const msg = e.m.syncRevolut();
  const S = e.sheets;
  ok(S.Bank.data[1][1] === Math.round((140000 + 1100 * 0.91) * 100) / 100, 'total EUR balance ' + S.Bank.data[1][1]);
  ok(S.Bank.data[6][0] === 'Main' && S.Bank.data[7][1] === 'USD' && !S.Bank.data.some(r => r[0] === 'Old'), 'accounts table, inactive left out');
  ok(/^OK /.test(S.Bank.data[2][1]), 'status OK');
  const T = S['Bank transactions'].data;
  ok(T[0][0] === 'Date' && T.length === 1 + 10, 'header and 10 leg rows (' + T.length + ')');
  const row = id => T.find(r => r[12] === id);
  ok(row('t1:l1')[10] === 'Client payment' && row('t1:l1')[11] === 'INV-31', 't1 client payment INV-31');
  ok(row('t3:l3')[10] === 'Software', 'slack software');
  ok(row('t4:l4')[10] === 'Salary', 'salary rule');
  ok(row('t5:l5a')[10] === 'Internal transfer' && row('t5:l5b')[10] === 'Internal transfer', 'exchange legs internal');
  ok(row('t6:l6')[2] === 'declined', 'declined kept with state');
  ok(row('t7:l7')[10] === 'Bank fees', 'fee category');
  ok(row('t9:l9')[7] === -111.5 && row('t9:l9')[9] === Math.round(-111.5 * 0.91 * 100) / 100, 'USD leg with fee, EUR converted');
  ok(key(T[1][0]) >= key(T[T.length - 1][0]), 'newest first');
  const P = S.Placements.data;
  const p = inv => P.find(r => r[0] === inv);
  ok(p('INV-31')[4] === 'Paid' && key(p('INV-31')[8]) === '2026-11-05', 'INV-31 paid by reference');
  ok(p('INV-22')[4] === 'Paid' && key(p('INV-22')[8]) === '2026-10-20', 'INV-22 paid by unique amount');
  ok(p('INV-23')[4] === 'Check', 'INV-23 untouched');
  ok(p('INV-40')[4] === 'Open' && p('INV-41')[4] === 'Open', 'two €5,000 invoices: ambiguous, untouched');
  ok(e.sent.length === 1 && /Marked Paid: INV-31/.test(e.sent[0].body) && /Marked Paid: INV-22/.test(e.sent[0].body) && /Possible match.*INV-40/.test(e.sent[0].body), 'email lists matches');
  const C = S['Monthly check-ins'].data;
  // Oct end = total - completed EUR after 2026-11-01 (t1 15000, t3 -8.25, t5 -1000 and +1001, t7 -30, t8 5000, t9 -101.47)
  const total = 140000 + 1100 * 0.91;
  const after = 15000 - 8.25 - 1000 + Math.round(1100 * 0.91 * 100) / 100 - 30 + 5000 + Math.round(-111.5 * 0.91 * 100) / 100;
  ok(Math.abs(C[1][1] - (total - after)) < 0.02, 'October month-end balance ' + C[1][1] + ' vs ' + (total - after));
  ok(C[2][1] === '', 'November not over: left empty');
  ok(C[3][1] === '', 'month before synced history: left empty');
  ok(e.calls.every(c => c.o.method === 'get'), 'only GET calls to the API');
  ok(e.sigChecks.length === e.calls.length && e.sigChecks.every(Boolean), 'every request carries the API key and a valid signature (' + e.sigChecks.length + ')');
  ok(e.calls.some(c => /\/transactions\?from=.*&to=.*&count=1000/.test(c.url)), 'transactions query signed as sent');
  ok(e.userProps.RV_LAST_SYNC, 'last sync stored');
  // second sync: idempotent
  e.sent.length = 0;
  e.m.syncRevolut();
  ok(S['Bank transactions'].data.filter(r => r[12]).length === 11, 'no duplicate rows on re-sync');
  ok(e.sent.length === 0, 'no repeated emails on re-sync');
}
// pagination
{
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: 'p' + i, type: 'card_payment', state: 'completed',
    created_at: new Date(Date.UTC(2026, 10, 1) - i * 60000).toISOString(),
    legs: [{ leg_id: 'x', account_id: 'a1', amount: -1, currency: 'EUR', description: 'thing' }] }));
  const e = env({ props: connected, pages: q => many.filter(t => t.created_at >= q.from && t.created_at <= q.to).slice(0, 1000) });
  const got = e.m.fetchTransactions_(new Date('2025-01-01'), new Date('2026-12-01'));
  ok(got.length === 2500, 'pagination collects all 2500 (' + got.length + ')');
}
// auth failure
{
  const e = env({ props: Object.assign({}, connected), failCode: 401, fail: u => true });
  let threw = false;
  try { e.m.syncRevolut(); } catch (x) { threw = true; }
  ok(threw && /Revolut refused the API key/.test(e.sheets.Bank.data[2][1]), 'revoked key status');
  ok(e.sent.length === 1 && /API Console/.test(e.sent[0].body), 'revoked key emailed');
}
// API 500 retried then reported
{
  let n = 0;
  const e = env({ props: connected, fail: u => u.includes('/accounts') && n++ < 1 });
  e.m.syncRevolut();
  ok(/^OK/.test(e.sheets.Bank.data[2][1]), 'transient 500 retried');
}
// history limited to 90 days
{
  const e = env({ props: connected, failCode: 403, fail: u => u.includes('/transactions') && /from=2025/.test(u) });
  e.m.syncRevolut();
  ok(/last 90 days/.test(e.sheets.Bank.data[2][1]), '90-day fallback noted');
}
// connect dialog
{
  const e = env({ props: {} });
  let err = '';
  try { e.m.saveRevolutConnection({ apiKey: 'k' }); } catch (x) { err = x.message; }
  ok(/signing key first/.test(err), 'needs the signing key first');
  e.m.getSigningPublicKey(false);
  const r = e.m.saveRevolutConnection({ apiKey: 'Bearer key-9 ' });
  ok(e.userProps.RV_API_KEY === 'key-9' && /^Connected/.test(r), 'connect saves the key (Bearer and spaces trimmed) and syncs');
  ok(e.sigChecks.every(Boolean), 'requests signed with the key made in the dialog');
  const bad = env({ props: {}, failCode: 401, fail: u => u.includes('/accounts') });
  bad.m.getSigningPublicKey(false);
  err = ''; try { bad.m.saveRevolutConnection({ apiKey: 'wrong' }); } catch (x) { err = x.message; }
  ok(/did not accept it/.test(err) && !bad.userProps.RV_API_KEY, 'rejected key is not kept');
  e.m.disconnectRevolut();
  ok(!e.userProps.RV_API_KEY && !e.userProps.RV_SIGNING_SEED, 'disconnect deletes key and signing key');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
