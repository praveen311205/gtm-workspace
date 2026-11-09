/**
 * Tests for scripts/invoice-archiver.gs, run with Node (no Google account needed):
 *
 *     node plugins/gtm-software-inventory/tests/archiver.test.js
 *
 * The Apps Script services (GmailApp, DriveApp, Utilities, ...) are replaced by
 * small in-memory fakes, and the real script runs against simulated mailboxes.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SCRIPT = path.join(__dirname, '..', 'skills', 'software-inventory', 'scripts', 'invoice-archiver.gs');
let passed = 0;
function check(cond, what) {
  if (!cond) { console.error(`FAIL: ${what}`); process.exit(1); }
  passed++;
  console.log(`  ok  ${what}`);
}

// ---------------------------------------------------------------- fakes

const PDF = (text) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);
const signed = (buf) => Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length));

class Blob {
  constructor(bytes, name, type, extra = {}) {
    this.bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
    this.name = name; this.type = type; Object.assign(this, extra);
  }
  getBytes() { return signed(this.bytes); }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getContentType() { return this.type; }
  getSize() { return this.bytes.length; }
  getDataAsString() { return this.bytes.toString('utf8'); }
  copyBlob() { return new Blob(this.bytes, this.name, this.type, { zipFiles: this.zipFiles }); }
  getAs(type) { return new Blob(PDF(this.getDataAsString()), 'converted.pdf', type); }
}

class File {
  constructor(name, blob) { this.name = name; this.blob = blob; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getBlob() { return this.blob; }
  setContent(t) { this.blob = new Blob(t, this.name, 'text/plain'); }
}
const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };

class Folder {
  constructor() { this.files = []; }
  getName() { return 'GTM Talent - Invoices'; }
  createFile(a, content) {
    const f = typeof a === 'string' ? new File(a, new Blob(content, a, 'text/plain')) : new File(a.getName(), a);
    this.files.push(f);
    return f;
  }
  // Drive matches word prefixes; the fake is looser (substring) so the script's exact check is exercised.
  searchFiles(q) {
    const term = q.match(/title contains '([^']+)'/)[1];
    return iter(this.files.filter(f => f.name.includes(term)));
  }
  getFilesByName(n) { return iter(this.files.filter(f => f.name === n)); }
  names() { return this.files.map(f => f.name); }
  text(prefix) { return this.files.find(f => f.name.startsWith(prefix) && f.name.endsWith('.txt')).blob.getDataAsString(); }
}

function message(o) {
  const atts = o.attachments || [];
  return {
    getId: () => o.id,
    getFrom: () => o.from,
    getTo: () => o.to || 'nav@gtmtalent.tech',
    getCc: () => '',
    getDate: () => new Date(o.date || '2026-10-01T10:00:00Z'),
    getSubject: () => o.subject,
    getPlainBody: () => o.body || '',
    getBody: () => o.html || `<p>${o.body || ''}</p>`,
    getAttachments: () => { if (o.throws) throw new Error(o.throws); return atts.map(a => a.copyBlob()); },
    getHeader: (h) => ({ 'Message-ID': o.rfcId || `<${o.id}@mail>`,
                         'Authentication-Results': o.auth || 'mx.google.com; dkim=pass; spf=pass; dmarc=pass' })[h] || '',
    isInTrash: () => !!o.trash,
  };
}

function makeEnv({ mailbox = 'nav@gtmtalent.tech', threads = [], folder = new Folder(), urls = {},
                   lockFree = true, props = {}, aliases = [], spam = 0 } = {}) {
  const labels = [];
  const fetched = [];
  const queries = [];
  const store = Object.assign({}, props);
  const threadObjs = threads.map((msgs, i) => ({
    getId: () => `t${i}`, getMessages: () => msgs.map(message), addLabel: () => labels.push(`t${i}`),
  }));
  const env = {
    console: { log() {}, warn() {}, error() {} },
    MimeType: { PLAIN_TEXT: 'text/plain', HTML: 'text/html', PDF: 'application/pdf' },
    Session: { getEffectiveUser: () => ({ getEmail: () => mailbox }) },
    LockService: { getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; },
      deleteProperty: k => { delete store[k]; } }) },
    DriveApp: { getFolderById: () => folder },
    GmailApp: {
      search: (q, start) => { queries.push(q); if (q.startsWith('in:spam')) return new Array(spam).fill({}); return start ? [] : threadObjs; },
      getUserLabelByName: () => null, createLabel: () => ({}), getAliases: () => aliases,
    },
    UrlFetchApp: { fetch: (u) => { fetched.push(u); const r = urls[u];
      if (!r) return { getResponseCode: () => 404, getBlob: () => new Blob('', 'x', 'text/html') };
      return { getResponseCode: () => 200, getBlob: () => r }; } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, v) => signed(crypto.createHash('sha256').update(Array.isArray(v) ? Buffer.from(v.map(b => (b + 256) % 256)) : String(v)).digest()),
      formatDate: (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
      unzip: (b) => b.zipFiles || [],
      newBlob: (data, type, name) => new Blob(data, name, type),
    },
    ScriptApp: { getProjectTriggers: () => [] },
  };
  env.module = { exports: {} };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), env);
  env.module.exports.CONFIG.FOLDER_ID = 'folder';
  return { api: env.module.exports, folder, store, fetched, labels, queries };
}

// ---------------------------------------------------------------- tests

console.log('Pure helpers');
{
  const { api } = makeEnv();
  const q = api.buildQuery_();
  check(/in:anywhere -in:spam/.test(q), 'searches Trash too (bills deleted after paying), never Spam');
  check(/factuur/.test(q) && /rechnung/.test(q), 'Dutch and German invoice words in the query');
  check(api.vendorName_('Stripe <invoice+statements@stripe.com>', 'Your receipt from Anthropic, PBC #2291-0042') === 'Anthropic, PBC',
        'vendor from "receipt from X" subject (Stripe sends for many vendors)');
  check(api.vendorName_('"Loxo Billing" <billing@loxo.co>', 'Invoice LX-1043') === 'Loxo Billing', 'vendor from display name');
  check(api.vendorName_('no-reply@revolut.com', 'Your plan fee') === 'revolut', 'vendor from domain when the name is generic');
  check(api.forwardedOriginal_('Fwd: Invoice', '---------- Forwarded message ---------\nFrom: Loxo <billing@loxo.co>\nDate: ...').from === 'Loxo <billing@loxo.co>',
        'forwarded bill: original sender found');
  check(api.forwardedOriginal_('Doorgestuurd: factuur', 'Van: KPN <factuur@kpn.com>\nDatum:').from === 'KPN <factuur@kpn.com>', 'Dutch forward header');
  check(api.forwardedOriginal_('Invoice', 'From the team at Loxo') === null, 'normal email is not a forward');
  check(api.isOwnMessage_('Navin <NAV@gtmtalent.tech>', ['nav@gtmtalent.tech']), 'own message recognised (case-insensitive)');
  check(api.isQuotaError_('Service invoked too many times for one day: gmail.'), 'quota error recognised');
  check(api.maskCardNumbers_('Card 4111 1111 1111 1111 charged') === 'Card •••• 1111 charged', 'full card number masked');
  check(api.maskCardNumbers_('Order 1234567890123456') === 'Order 1234567890123456', 'long non-card number kept (Luhn check)');
  check(api.isReceiptEmail_('Your receipt from Slack', 'Total €12.50'), 'receipt email with amount is a receipt');
  check(!api.isReceiptEmail_('Your payment failed', 'Amount €180.00'), 'failed-payment notice is not a receipt');
  check(!api.isReceiptEmail_('Your subscription renews on 1 Dec', 'Amount €180.00'), 'renewal reminder is not a receipt');
  check(!api.isReceiptEmail_('Your receipt', 'no amount here'), 'receipt wording without an amount is not enough');
  check(api.isEInvoiceXml_('<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl">'), 'UBL e-invoice XML recognised');
  check(api.fetchableLinks_('see https://pay.stripe.com/invoice/acct_1/invst_2/pdf and https://evil.example/pay.stripe.com/x')
          .join() === 'https://pay.stripe.com/invoice/acct_1/invst_2/pdf', 'only allow-listed invoice hosts are fetched');
  check(api.senderCheck_('mx.google.com; dkim=fail; spf=pass; dmarc=fail') === 'dmarc=fail dkim=fail spf=pass', 'sender check summarised');
  check(api.clean_('a/b: c?#[x]') === 'a b c x', 'file names cleaned');
}

console.log('Archiving: retrieval paths');
{
  const zip = new Blob('zip', 'invoices.zip', 'application/zip', { zipFiles: [new Blob(PDF('in zip'), 'inv-9.pdf', 'application/pdf')] });
  const { api, folder, fetched, store } = makeEnv({
    urls: { 'https://pay.stripe.com/invoice/acct_1/invst_2/pdf': new Blob(PDF('stripe'), 'x', 'application/pdf') },
    threads: [
      [{ id: 'a1', from: 'Stripe <invoice@stripe.com>', subject: 'Your receipt from Anthropic, PBC #1',
         attachments: [new Blob(PDF('anthropic'), 'Receipt-1.pdf', 'application/pdf'),
                       new Blob(Buffer.alloc(500, 1), 'logo.png', 'image/png')] }],
      [{ id: 'a2', from: 'Stripe <invoice@stripe.com>', subject: 'Your receipt from Anthropic, PBC #1',
         attachments: [new Blob(PDF('anthropic second'), 'Receipt-1.pdf', 'application/pdf')] }],
      [{ id: 'b1', from: 'Lemlist <billing@lemlist.com>', subject: 'Your invoice is ready',
         body: 'Download: https://pay.stripe.com/invoice/acct_1/invst_2/pdf\nOr https://lemlist.com/billing/invoices' }],
      [{ id: 'c1', from: 'Slack <feedback@slack.com>', subject: 'Your receipt from Slack', body: 'Total charged: €12.50' }],
      [{ id: 'd1', from: 'LinkedIn <billing@linkedin.com>', subject: 'Your payment failed',
         body: 'Update your card at https://www.linkedin.com/premium/billing/manage' }],
      [{ id: 'e1', from: 'KPN <factuur@kpn.com>', subject: 'Uw factuur', attachments: [zip] }],
      [{ id: 'f1', from: 'Supplier <f@sup.nl>', subject: 'Factuur 2026-118',
         attachments: [new Blob('<?xml version="1.0"?><Invoice xmlns="urn:oasis">', 'factuur.xml', 'application/xml'),
                       new Blob(PDF('octet'), 'download', 'application/octet-stream'),
                       new Blob('<html>not a pdf</html>', 'fake.pdf', 'application/pdf')] }],
      [{ id: 'g1', from: 'Uber <noreply@uber.com>', subject: 'Your receipt', body: 'Total €23.10',
         attachments: [new Blob(Buffer.alloc(40 * 1024, 7), 'receipt.jpg', 'image/jpeg')] }],
      [{ id: 'h1', from: 'Shop <s@shop.com>', subject: 'Receipt', body: 'Card 4111 1111 1111 1111, total €5.00', date: '2026-10-31T23:30:00Z' }],
    ],
  });
  api.archiveInvoices();
  const names = folder.names();
  const txt = (id) => folder.files.find(f => f.name.endsWith('.txt') && f.blob.getDataAsString().includes(`Message ID: ${id}`)).blob.getDataAsString();
  check(/Retrieval: attachment/.test(txt('a1')) && names.some(n => /Anthropic, PBC.*Receipt-1 h[0-9a-f]{12}\.pdf$/.test(n)),
        'PDF attachment saved; Retrieval: attachment');
  check(!names.some(n => /logo/.test(n)), 'small logo image not saved');
  const anthropicTxts = names.filter(n => /Anthropic/.test(n) && n.endsWith('.txt'));
  check(anthropicTxts.length === 2 && anthropicTxts[0] !== anthropicTxts[1], 'two receipts with the same date and subject get distinct names');
  const pdfs = names.filter(n => n.endsWith('.pdf'));
  check(pdfs.every(p => names.some(t => t.endsWith('.txt') && p.startsWith(t.slice(0, -4)))), 'every saved file starts with its email\'s .txt name');
  check(/Retrieval: link/.test(txt('b1')) && fetched.length === 1, 'invoice behind a Stripe link downloaded; lemlist portal link not fetched');
  check(/Retrieval: email-body/.test(txt('c1')), 'receipt that is only the email body saved as PDF');
  check(/Retrieval: none/.test(txt('d1')) && /Portal links: https:\/\/www\.linkedin\.com\/premium\/billing\/manage/.test(txt('d1')),
        'failed-payment notice: nothing retrieved, portal link listed for a human');
  check(names.some(n => /inv-9 h[0-9a-f]+\.pdf$/.test(n)), 'PDF inside a .zip saved');
  check(names.some(n => /factuur h[0-9a-f]+\.xml$/.test(n)), 'XML e-invoice saved');
  check(names.some(n => /download h[0-9a-f]+\.pdf$/.test(n)), 'PDF without extension or type (octet-stream) saved');
  check(!names.some(n => /fake/.test(n)), 'HTML file named .pdf rejected');
  check(names.some(n => /receipt h[0-9a-f]+\.jpg$/.test(n)), 'photo receipt saved when there is no PDF');
  check(/•••• 1111/.test(txt('h1')) && !/4111 1111 1111 1111/.test(txt('h1')), 'card number masked in the saved body');
  check(names.some(n => n.startsWith('2026-11-01 - Shop')), 'date in Amsterdam time (23:30 UTC on 31 Oct = 1 Nov)');
  check(/Sender check: dmarc=pass/.test(txt('a1')), 'sender check recorded');
  check(Object.values(store).every(v => v === '1'), 'every message marked done');

  // Same run again: nothing new.
  const before = folder.files.length;
  api.archiveInvoices();
  check(folder.files.length === before, 're-run saves nothing twice');
  const status = folder.files.find(f => f.name.startsWith('_archiver-status')).blob.getDataAsString();
  check(/New emails saved: 0/.test(status) && /Last run: /.test(status), 'status file updated every run');
}

console.log('Archiving: duplicates, own mail, forwards, exclusions');
{
  const shared = new Folder();
  const bill = { id: 'n1', rfcId: '<same@loxo>', from: 'Loxo <billing@loxo.co>', subject: 'Invoice LX-1',
                 attachments: [new Blob(PDF('loxo'), 'LX-1.pdf', 'application/pdf')] };
  makeEnv({ folder: shared, threads: [[bill]] }).api.archiveInvoices();
  const n = shared.files.length;
  makeEnv({ mailbox: 'praveen@gtmtalent.tech', folder: shared, threads: [[Object.assign({}, bill, { id: 'p1' })]] }).api.archiveInvoices();
  check(n === 3 && shared.files.length === 4 &&                       // .txt + .pdf + 2 status files
        shared.files.filter(f => /LX-1/.test(f.name)).length === 2, 'same email reaching two inboxes saved once');
  makeEnv({ mailbox: 'praveen@gtmtalent.tech', folder: shared, threads: [[{ id: 'p2', from: 'Loxo <billing@loxo.co>',
    subject: 'Fwd: copy of invoice', attachments: [new Blob(PDF('loxo'), 'copy.pdf', 'application/pdf')] }]] }).api.archiveInvoices();
  check(shared.files.filter(f => f.name.endsWith('.pdf')).length === 1, 'identical PDF from a different email is not stored twice');
  const t = shared.files.find(f => /copy of invoice/.test(f.name)).blob.getDataAsString();
  check(/same file as/.test(t), '...and its .txt points to the file already saved');

}
{
  const { api, folder, store } = makeEnv({ aliases: ['navin@gtmtalent.tech'], threads: [[
    { id: 'o1', from: 'Loxo <billing@loxo.co>', subject: 'Invoice LX-2', attachments: [new Blob(PDF('lx2'), 'LX-2.pdf', 'application/pdf')] },
    { id: 'o2', from: 'Navin <navin@gtmtalent.tech>', subject: 'Re: Invoice LX-2', body: 'thanks, paid' },
    { id: 'o3', from: 'Rohan <rohan@gtmtalent.tech>', subject: 'Fwd: Invoice from Folk',
      body: '---------- Forwarded message ---------\nFrom: Folk Billing <billing@folk.app>\nSubject: Invoice',
      attachments: [new Blob(PDF('folk'), 'folk.pdf', 'application/pdf')] },
    { id: 'o4', from: 'Amazon <order@amazon.nl>', subject: 'Your receipt', body: 'Total €9.99' },
  ]] });
  api.EXCLUDE_SENDERS.push('amazon.nl');
  api.archiveInvoices();
  check(store.o2 === undefined && store.m_o2 === 'own' && !folder.names().some(n => /Re Invoice/.test(n)), 'own reply in a billing thread skipped');
  check(folder.names().some(n => /- Folk - Fwd Invoice from Folk/.test(n)) && !folder.names().some(n => /Rohan/.test(n)),
        'forwarded bill filed under the vendor, not the colleague who forwarded it');
  check(store.m_o4 === 'excluded' && !folder.names().some(n => /Amazon|amazon/.test(n)), 'excluded (personal) sender not archived');
}

console.log('Archiving: failures, quota, lock');
{
  const threads = [[{ id: 'bad', from: 'X <x@x.com>', subject: 'Invoice 1', throws: 'Invalid argument' },
                    { id: 'ok', from: 'Y <y@y.com>', subject: 'Invoice 2', attachments: [new Blob(PDF('y'), 'y.pdf', 'application/pdf')] }]];
  const folder = new Folder();
  const props = {};
  let env;
  for (let run = 1; run <= 3; run++) {
    env = makeEnv({ folder, threads, props });
    env.api.archiveInvoices();
    Object.assign(props, env.store);
    for (const k of Object.keys(props)) if (!(k in env.store)) delete props[k];
  }
  check(env.store.m_ok === '1', 'one broken email does not stop the others');
  check(env.store.m_bad === 'gave-up' && env.labels.length === 1, 'broken email retried, given up after 3 runs');
  const status = folder.files.find(f => f.name.startsWith('_archiver-status')).blob.getDataAsString();
  check(/Gave up: .*Invoice 1.*Invalid argument/.test(status), 'given-up email listed in the status file for a human');

  const q = makeEnv({ threads: [[{ id: 'q', from: 'Z <z@z.com>', subject: 'Invoice', throws: 'Service invoked too many times for one day: gmail.' }]] });
  q.api.archiveInvoices();
  check(!('f_q' in q.store) && !('m_q' in q.store), 'quota error: no failure counted, retried next run');
  check(/quota/.test(q.folder.files.find(f => f.name.startsWith('_archiver-status')).blob.getDataAsString()), 'quota stop noted in status');

  const locked = makeEnv({ lockFree: false, threads: [[{ id: 'l', from: 'Z <z@z.com>', subject: 'Invoice' }]] });
  locked.api.archiveInvoices();
  check(locked.folder.files.length === 0 && locked.queries.length === 0, 'overlapping run does nothing');

  const spam = makeEnv({ spam: 2, threads: [] });
  spam.api.archiveInvoices();
  check(/in spam .*: 2/.test(spam.folder.files[0].blob.getDataAsString()), 'possible invoices in spam counted, not archived');
}

console.log(`\nAll ${passed} checks passed.`);
