/**
 * GTM Talent - Invoice Archiver (Google Apps Script)          version 0.2.0
 *
 * Runs inside each Gmail account that receives bills (Navin's first). Every hour
 * it copies billing emails into the shared Drive folder "GTM Talent - Invoices":
 *   - one .txt per email: mailbox, sender, date, subject, Gmail link, how the
 *     invoice was retrieved, sender check, and the plain-text body
 *   - the invoice itself, retrieved in this order:
 *       1. attachment   PDF (also inside .zip), XML e-invoice, or a photo receipt
 *       2. link         a PDF behind a known no-login invoice link (Stripe, Paddle...)
 *       3. email-body   the email itself, saved as PDF, when it IS the receipt
 *       4. none         nothing retrievable: the invoice must be fetched by hand
 *                       (the .txt lists any portal links found in the email)
 *   - "_archiver-status - <mailbox>.txt": last run, counts, errors, possible
 *     invoices in spam. The inventory skill reads it to notice a stopped archiver.
 *
 * Nothing is forwarded, deleted or changed in Gmail. The script only adds the
 * label "Invoice-archived" to threads it has saved.
 *
 * Setup: see setup/invoice-archiver-setup.md. In short: paste this file into
 * script.google.com, set FOLDER_ID, run setup() once.
 */

const CONFIG = {
  // ID of the shared "GTM Talent - Invoices" folder: the part of its URL after /folders/
  FOLDER_ID: 'PASTE_FOLDER_ID_HERE',
  TIMEZONE: 'Europe/Amsterdam',     // dates in file names; not the script's default zone
  LOOKBACK: '18m',                  // how far back the backlog goes
  RECHECK: '30d',                   // archived threads are re-checked this long for new messages
  LABEL: 'Invoice-archived',        // added to threads that have been saved
  MAX_RUNTIME_MS: 4.5 * 60 * 1000,  // Apps Script stops runs at 6 min; leave headroom
  MAX_FAILURES: 3,                  // an email that fails this often is logged and skipped
  MAX_BODY_CHARS: 100000,           // body text kept in the .txt
  MIN_IMAGE_BYTES: 30 * 1024,       // smaller images are logos/icons, not receipt photos
  MAX_LINK_FETCHES: 3,              // per email
};

// Senders whose billing emails we want. Add a domain when a tool's bills slip through.
const VENDOR_SENDERS = [
  // tools
  'anthropic.com', 'claude.com', 'slack.com', 'metaview.ai', 'loxo.co', 'linkedin.com',
  'lemlist.com', 'zapmail.ai', 'clay.com', 'lovable.dev', 'canva.com', 'pin.com',
  'juicebox.ai', 'adobe.com', 'revolut.com', 'odido.nl', 'cal.com', 'wework.com',
  'openai.com', 'notion.so', 'salesql.com', 'lusha.com', 'folk.app', 'wix.com',
  'fiverr.com', 'tellow.nl', 'spott.io', 'exali.com', 'signalbase',
  'payments-noreply@google.com',
  // billing platforms that send on behalf of many vendors
  'stripe.com', 'paddle.com', 'paddle.net', 'chargebee.com', 'recurly.com', 'fastspring.com',
  'lemonsqueezy.com', 'paypal.com', 'mollie.com', 'moneybird.nl', 'exactonline.nl',
  'e-boekhouden.nl', 'xero.com', 'intuit.com', 'zoho.com', 'invoice2go.com',
];

// Personal or irrelevant senders to never archive (e.g. 'amazon.nl' if only personal orders).
const EXCLUDE_SENDERS = [];

// Subject words that mark a billing email (English, Dutch, German, French).
const BILLING_WORDS = [
  'invoice', 'receipt', 'renewal', 'renews', 'payment', 'subscription', 'charge',
  '"trial ends"', 'factuur', 'nota', 'betaling', 'abonnement', 'rechnung', 'quittung',
  'zahlung', 'beleg', 'facture', 'reçu',
];
// Subject words that on their own make any sender's email worth archiving.
const INVOICE_WORDS = ['invoice', 'receipt', 'factuur', 'rechnung', 'quittung', 'facture'];

// Hosts whose invoice links give a PDF without logging in. Only these are ever fetched.
const LINK_HOSTS = [
  'pay.stripe.com', 'invoice.stripe.com', 'invoicedata.stripe.com', 'files.stripe.com',
  'receipts.paddle.com', 'my.paddle.com', 'checkout.paddle.com', 'app.lemonsqueezy.com',
];

const PORTAL_LINK_RE =
  /https?:\/\/[^\s<>"')\]]*(invoice|receipt|billing|factuur|rechnung|facture|payment)[^\s<>"')\]]*/gi;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Run once by hand: checks the folder, creates the hourly trigger, starts the backlog. */
function setup() {
  if (CONFIG.FOLDER_ID === 'PASTE_FOLDER_ID_HERE') {
    throw new Error('Set CONFIG.FOLDER_ID to the shared Invoices folder ID first.');
  }
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID); // fails early if no access
  folder.getName();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'archiveInvoices')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('archiveInvoices').timeBased().everyHours(1).create();
  archiveInvoices();
}

/** Run by the hourly trigger. Safe to run any number of times; never saves an email twice. */
function archiveInvoices() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Another run is still busy - skipping this one.');
    return;
  }
  const stats = { started: new Date(), threads: 0, saved: 0, skipped: 0, ownMessages: 0,
                  duplicates: 0, failed: 0, gaveUp: [], retrieval: {}, note: '', spam: 0 };
  let folder;
  try {
    folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
    runArchive_(folder, stats);
  } catch (e) {
    stats.note = `Run stopped: ${e && e.message ? e.message : e}`;
    console.error(stats.note);
  } finally {
    if (folder) {
      try { writeStatus_(folder, stats); } catch (e) { console.error(`Status not written: ${e}`); }
    }
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function runArchive_(folder, stats) {
  const started = Date.now();
  const label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  const props = PropertiesService.getScriptProperties();
  const mailbox = Session.getEffectiveUser().getEmail();
  const me = ownAddresses_(mailbox);

  // Collect matches first: labelling while paging would shift the result pages.
  const threads = searchAll_(buildQuery_());
  stats.threads = threads.length;
  stats.spam = countSpam_();

  for (const thread of threads) {
    let threadDone = true;
    for (const msg of thread.getMessages()) {
      if (Date.now() - started > CONFIG.MAX_RUNTIME_MS) {
        stats.note = 'Time limit reached; the next run continues.';
        return;
      }
      const id = msg.getId();
      if (props.getProperty('m_' + id)) continue;

      if (isOwnMessage_(msg.getFrom(), me)) {      // our own replies/forwards in the thread
        props.setProperty('m_' + id, 'own');
        stats.ownMessages++;
        continue;
      }
      if (isExcluded_(msg.getFrom())) {
        props.setProperty('m_' + id, 'excluded');
        stats.skipped++;
        continue;
      }

      try {
        const result = saveMessage_(msg, thread, folder, mailbox);
        props.setProperty('m_' + id, result.duplicate ? 'dup' : '1');
        props.deleteProperty('f_' + id);
        if (result.duplicate) stats.duplicates++;
        else {
          stats.saved++;
          stats.retrieval[result.retrieval] = (stats.retrieval[result.retrieval] || 0) + 1;
        }
      } catch (e) {
        const text = String(e && e.message ? e.message : e);
        if (isQuotaError_(text)) {                  // Google's daily limits: stop, retry later
          stats.note = `Google quota reached (${text}); the next run continues.`;
          return;
        }
        const failures = Number(props.getProperty('f_' + id) || 0) + 1;
        stats.failed++;
        if (failures >= CONFIG.MAX_FAILURES) {      // poison email: log it and move on
          props.setProperty('m_' + id, 'gave-up');
          props.deleteProperty('f_' + id);
          stats.gaveUp.push(`${safeDate_(msg)} | ${msg.getFrom()} | ${msg.getSubject()} | ${text}`);
        } else {
          props.setProperty('f_' + id, String(failures));
          threadDone = false;
        }
        console.error(`Message ${id} failed (${failures}x): ${text}`);
      }
    }
    if (threadDone) thread.addLabel(label);
  }
  console.log(`Done. ${stats.threads} matching threads, ${stats.saved} new emails saved.`);
}

function searchAll_(query) {
  const threads = [];
  for (let start = 0; ; start += 100) {
    const page = GmailApp.search(query, start, 100);
    threads.push(...page);
    if (page.length < 100) break;
  }
  return threads;
}

function buildQuery_() {
  const labelSlug = CONFIG.LABEL.toLowerCase().replace(/\s+/g, '-');
  const match =
    `((from:(${VENDOR_SENDERS.join(' OR ')}) subject:(${BILLING_WORDS.join(' OR ')})) ` +
    `OR subject:(${INVOICE_WORDS.join(' OR ')}) ` +
    `OR filename:xml subject:(${INVOICE_WORDS.join(' OR ')}))`;
  // in:anywhere -in:spam also finds bills that were deleted after paying (Trash).
  return `${match} in:anywhere -in:spam -in:drafts -in:chats newer_than:${CONFIG.LOOKBACK} ` +
         `(-label:${labelSlug} OR newer_than:${CONFIG.RECHECK})`;
}

/** Possible invoices in spam are never archived, only counted for a human to look at. */
function countSpam_() {
  try {
    return GmailApp.search(
      `in:spam subject:(${INVOICE_WORDS.join(' OR ')}) newer_than:30d`, 0, 50).length;
  } catch (e) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Saving one email
// ---------------------------------------------------------------------------

function saveMessage_(msg, thread, folder, mailbox) {
  const date = Utilities.formatDate(msg.getDate(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const subject = msg.getSubject() || 'no subject';
  const body = msg.getPlainBody() || '';
  const forwarded = forwardedOriginal_(subject, body);
  const vendor = vendorName_(forwarded ? forwarded.from : msg.getFrom(), subject);
  const rfcId = header_(msg, 'Message-ID') || msg.getId();
  const shortId = hex_(digest_(rfcId)).slice(0, 8);
  // File names end in plain-word markers (Drive's name search matches word prefixes):
  // m<id> = this email, h<hash> = this file's content.
  const base = clean_(`${date} - ${vendor} - ${subject}`).slice(0, 110) + ` m${shortId}`;

  // The same email in two inboxes (or re-sent) has the same Message-ID: save it once.
  if (findInFolder_(folder, `m${shortId}`)) return { duplicate: true };

  const files = [];
  let retrieval = 'none';

  for (const att of collectAttachments_(msg)) {
    const saved = saveFile_(folder, base, att.name, att.blob);
    files.push(saved);
    retrieval = 'attachment';
  }
  const portalLinks = portalLinks_(body);
  if (!files.length) {
    for (const url of fetchableLinks_(body).slice(0, CONFIG.MAX_LINK_FETCHES)) {
      const blob = fetchPdf_(url);
      if (blob) {
        files.push(saveFile_(folder, base, 'invoice.pdf', blob));
        retrieval = 'link';
        break;
      }
    }
  }
  if (!files.length && isReceiptEmail_(subject, body)) {
    const pdf = emailAsPdf_(msg, subject);
    if (pdf) {
      files.push(saveFile_(folder, base, 'email.pdf', pdf));
      retrieval = 'email-body';
    }
  }

  const text = [
    `Mailbox: ${mailbox}`,
    `From: ${msg.getFrom()}`,
    forwarded ? `Forwarded original from: ${forwarded.from}` : null,
    `To: ${msg.getTo()}`,
    `Cc: ${msg.getCc()}`,
    `Date: ${msg.getDate().toISOString()}`,
    `Subject: ${subject}`,
    `Gmail link: https://mail.google.com/mail/?authuser=${mailbox}#all/${thread.getId()}`,
    `Message ID: ${msg.getId()}`,
    `Retrieval: ${retrieval}`,
    `Saved files: ${files.map(f => f.name + (f.duplicateOf ? ` (same file as ${f.duplicateOf})` : '')).join(', ') || 'none'}`,
    `Portal links: ${retrieval === 'none' ? (portalLinks.join(' ') || 'none found') : '-'}`,
    `Sender check: ${senderCheck_(header_(msg, 'Authentication-Results'))}`,
    `In trash: ${msg.isInTrash() ? 'yes' : 'no'}`,
    '',
    '----- Email body -----',
    '',
    maskCardNumbers_(body).slice(0, CONFIG.MAX_BODY_CHARS),
  ].filter(l => l !== null).join('\n');

  folder.createFile(`${base}.txt`, text, MimeType.PLAIN_TEXT);
  return { duplicate: false, retrieval };
}

/** PDFs (also from inside .zip), XML e-invoices, and receipt photos when there is no PDF. */
function collectAttachments_(msg) {
  const out = [];
  const images = [];
  const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  for (const a of atts) {
    const name = a.getName() || 'attachment';
    const type = (a.getContentType() || '').toLowerCase();
    if (isPdf_(name, type, a)) {
      out.push({ name: /\.pdf$/i.test(name) ? name : name + '.pdf', blob: a.copyBlob() });
    } else if (/\.zip$/i.test(name) || type === 'application/zip') {
      try {
        Utilities.unzip(a.copyBlob()).forEach(f => {
          if (isPdf_(f.getName(), f.getContentType() || '', f)) out.push({ name: f.getName(), blob: f });
        });
      } catch (e) {
        console.warn(`Could not unzip ${name}: ${e}`);
      }
    } else if (/\.xml$/i.test(name) || /xml/.test(type)) {
      const head = a.getDataAsString().slice(0, 2000);
      if (isEInvoiceXml_(head)) out.push({ name, blob: a.copyBlob() });
    } else if (/^image\/(jpe?g|png|heic|heif|webp)$/.test(type) && a.getSize() >= CONFIG.MIN_IMAGE_BYTES) {
      images.push({ name, blob: a.copyBlob() });
    }
  }
  return out.length ? out : images;
}

function isPdf_(name, type, blob) {
  if (/\.pdf$/i.test(name) || /application\/pdf/i.test(type)) return startsWithPdf_(blob);
  if (/octet-stream|binary|^$/i.test(type)) return startsWithPdf_(blob);   // unlabelled files
  return false;
}

function startsWithPdf_(blob) {
  const bytes = blob.getBytes();
  return bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** Save as "<base> - <name> h<hash>.<ext>" (so it starts with its .txt's name); identical content is reused. */
function saveFile_(folder, base, name, blob) {
  const hash = hex_(digest_(blob.getBytes())).slice(0, 12);
  const existing = findInFolder_(folder, `h${hash}`);
  if (existing) return { name: existing, duplicateOf: existing };
  const ext = ((name.match(/\.[a-z0-9]{2,5}$/i) || ['.pdf'])[0]).toLowerCase();
  const stem = clean_(name.replace(/\.[a-z0-9]{2,5}$/i, '')).slice(0, 60) || 'attachment';
  const fileName = `${base} - ${stem} h${hash}${ext}`;
  folder.createFile(blob).setName(fileName);
  return { name: fileName };
}

/** A file whose name has `marker` as a whole word. The exact check guards Drive's prefix matching. */
function findInFolder_(folder, marker) {
  const it = folder.searchFiles(`title contains '${marker}' and trashed = false`);
  const word = new RegExp(`(^|\\s)${marker}(\\s|\\.|$)`);
  while (it.hasNext()) {
    const name = it.next().getName();
    if (word.test(name)) return name;
  }
  return null;
}

function fetchPdf_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() !== 200) return null;
    const blob = res.getBlob();
    return startsWithPdf_(blob) ? blob : null;
  } catch (e) {
    return null;
  }
}

function emailAsPdf_(msg, subject) {
  try {
    const html = `<html><head><meta charset="utf-8"></head><body>` +
      `<p><b>From:</b> ${escapeHtml_(msg.getFrom())}<br><b>Date:</b> ${msg.getDate()}<br>` +
      `<b>Subject:</b> ${escapeHtml_(subject)}</p><hr>` +
      maskCardNumbers_(msg.getBody() || escapeHtml_(msg.getPlainBody() || '')) + `</body></html>`;
    return Utilities.newBlob(html, MimeType.HTML, 'email.html').getAs(MimeType.PDF);
  } catch (e) {
    console.warn(`Email body not converted to PDF: ${e}`);
    return null;
  }
}

function writeStatus_(folder, stats) {
  const mailbox = Session.getEffectiveUser().getEmail();
  const name = `_archiver-status - ${mailbox}.txt`;
  const lines = [
    `Mailbox: ${mailbox}`,
    `Last run: ${stats.started.toISOString()}`,
    `Script version: 0.2.0`,
    `Matching threads: ${stats.threads}`,
    `New emails saved: ${stats.saved}`,
    `Retrieval this run: ${Object.keys(stats.retrieval).map(k => `${k} ${stats.retrieval[k]}`).join(', ') || '-'}`,
    `Duplicates (already saved from another inbox): ${stats.duplicates}`,
    `Own messages skipped: ${stats.ownMessages}`,
    `Excluded senders skipped: ${stats.skipped}`,
    `Failed this run (retried next hour): ${stats.failed}`,
    `Possible invoices in spam (last 30 days, not archived - check by hand): ${stats.spam}`,
    `Note: ${stats.note || '-'}`,
  ];
  const it = folder.getFilesByName(name);
  const file = it.hasNext() ? it.next() : null;
  let gaveUp = stats.gaveUp.map(l => `Gave up: ${l}`);
  if (file) {   // keep earlier give-ups so they stay visible
    gaveUp = file.getBlob().getDataAsString().split('\n').filter(l => l.startsWith('Gave up: ')).concat(gaveUp);
  }
  const content = lines.concat(gaveUp.length ? ['', ...gaveUp] : []).join('\n');
  if (file) file.setContent(content);
  else folder.createFile(name, content, MimeType.PLAIN_TEXT);
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in tests/archiver.test.js)
// ---------------------------------------------------------------------------

function ownAddresses_(mailbox) {
  let aliases = [];
  try { aliases = GmailApp.getAliases(); } catch (e) { /* no alias access */ }
  return [mailbox].concat(aliases).map(a => a.toLowerCase());
}

function emailAddress_(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

function isOwnMessage_(from, ownAddresses) {
  return ownAddresses.indexOf(emailAddress_(from)) !== -1;
}

function isExcluded_(from) {
  const address = emailAddress_(from);
  return EXCLUDE_SENDERS.some(s => address === s.toLowerCase() || address.endsWith('@' + s.toLowerCase()) ||
                                   address.endsWith('.' + s.toLowerCase()));
}

function isQuotaError_(text) {
  return /too many times|quota|rate limit|limit exceeded|bandwidth/i.test(text);
}

/** The original sender of a forwarded bill, from the forward header in the body. */
function forwardedOriginal_(subject, body) {
  const fwdSubject = /^\s*(fwd?|fw|wg|tr|doorgestuurd|weitergeleitet)\s*:/i.test(subject);
  const marker = body.search(/-{2,}\s*(forwarded message|doorgestuurd bericht|weitergeleitete nachricht|message transféré)|begin forwarded message/i);
  if (!fwdSubject && marker === -1) return null;
  const after = marker === -1 ? body : body.slice(marker);
  const m = after.match(/^\s*\*?(?:from|van|von|de)\*?\s*:\s*(.+)$/im);
  return m ? { from: m[1].trim() } : null;
}

const GENERIC_NAMES = /^(no-?reply|do-?not-?reply|billing|invoices?|receipts?|payments?|support|team|stripe|paddle|notifications?|accounts?|hello|info|mailer|service|finance|accounting|admin|sales|noreply)$/i;

/** "Your receipt from Anthropic, PBC #2291" -> "Anthropic, PBC"; else display name; else domain. */
function vendorName_(from, subject) {
  const s = String(subject || '').match(/\b(?:receipt|invoice|factuur|rechnung)\s+(?:from|van|von)\s+(.+?)(?:\s+#|\s+\(|\s+-\s|\s+for\s|$)/i);
  if (s) return s[1].trim();
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const display = m ? m[1].trim() : '';
  const address = m ? m[2] : String(from || '').trim();
  if (display && !GENERIC_NAMES.test(display) && !/@/.test(display)) return display;
  const domain = (address.split('@')[1] || address).toLowerCase();
  const parts = domain.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : domain;
}

/** Invoice links on hosts known to serve a PDF without login. */
function fetchableLinks_(body) {
  const urls = String(body || '').match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  return urls.filter(u => {
    const host = (u.match(/^https?:\/\/([^/:?#]+)/i) || [])[1] || '';
    return LINK_HOSTS.indexOf(host.toLowerCase()) !== -1;
  });
}

/** Links that look like an invoice/billing page (usually behind a login): listed for a human. */
function portalLinks_(body) {
  const found = String(body || '').match(PORTAL_LINK_RE) || [];
  const seen = {};
  return found.filter(u => (seen[u] ? false : (seen[u] = true))).slice(0, 5);
}

/** The email is itself the receipt: money taken, with an amount, and not a failure notice. */
function isReceiptEmail_(subject, body) {
  const s = String(subject || '');
  if (/fail|declin|unsuccessful|mislukt|fehlgeschlagen|reminder|herinnering|erinnerung|mahnung|overdue|upcoming|will renew|renews on|trial ends/i.test(s)) {
    return false;
  }
  const isReceipt = /receipt|invoice|payment (received|confirmation|successful)|thanks for your (payment|order)|factuur|betaling ontvangen|rechnung|quittung|zahlungsbestätigung/i.test(s);
  const hasAmount = /(€|EUR|\$|USD|£|GBP)\s?\d|\d[\d.,]*\s?(€|EUR|USD|GBP)/.test(String(body || ''));
  return isReceipt && hasAmount;
}

function isEInvoiceXml_(head) {
  return /<(\w+:)?(Invoice|CreditNote|CrossIndustryInvoice)\b/.test(head);
}

/** "dmarc=pass" etc. from Authentication-Results; "unknown" when the header is missing. */
function senderCheck_(authResults) {
  if (!authResults) return 'unknown';
  const out = [];
  ['dmarc', 'dkim', 'spf'].forEach(k => {
    const m = authResults.match(new RegExp(k + '=(\\w+)', 'i'));
    if (m) out.push(`${k}=${m[1].toLowerCase()}`);
  });
  return out.join(' ') || 'unknown';
}

/** Replace full card numbers (Luhn-valid, 13-19 digits) with •••• + last 4. */
function maskCardNumbers_(text) {
  return String(text || '').replace(/\b(?:\d[ -]?){12,18}\d\b/g, match => {
    const digits = match.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn_(digits)) return match;
    return '•••• ' + digits.slice(-4);
  });
}

function luhn_(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function header_(msg, name) {
  try { return msg.getHeader(name) || ''; } catch (e) { return ''; }
}

function safeDate_(msg) {
  try { return msg.getDate().toISOString().slice(0, 10); } catch (e) { return '?'; }
}

function digest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value);
}

function hex_(bytes) {
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function clean_(s) {
  return String(s).replace(/[\\/:*?"<>|\r\n\t#\[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
}

if (typeof module !== 'undefined') {   // Node test harness only; ignored by Apps Script
  module.exports = { buildQuery_, vendorName_, forwardedOriginal_, isOwnMessage_, isExcluded_,
    isQuotaError_, fetchableLinks_, portalLinks_, isReceiptEmail_, isEInvoiceXml_, senderCheck_,
    maskCardNumbers_, luhn_, clean_, hex_, archiveInvoices, CONFIG, EXCLUDE_SENDERS };
}
