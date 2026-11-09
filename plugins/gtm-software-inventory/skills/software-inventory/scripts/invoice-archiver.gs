/**
 * GTM Talent - Invoice Archiver (Google Apps Script)
 *
 * Runs inside the Gmail account that receives software bills (e.g. Navin's).
 * Every hour it copies invoice/receipt emails into a shared Drive folder:
 *   - one .txt per email: sender, recipient, date, subject, Gmail link, plain-text body
 *   - every PDF attached to that email
 * On its first runs it also works through the last 18 months (the backlog).
 * The software-inventory skill reads this folder, including the PDFs.
 *
 * Nothing is forwarded, deleted or changed in Gmail. The script only adds the label
 * "Invoice-archived" to threads it has saved.
 *
 * Setup: see setup/invoice-archiver-setup.md. In short:
 *   paste this file into script.google.com, set FOLDER_ID, run setup() once.
 */

const CONFIG = {
  // ID of the shared "GTM Talent - Invoices" folder: the part of its URL after /folders/
  FOLDER_ID: 'PASTE_FOLDER_ID_HERE',
  LOOKBACK: '18m',              // how far back the backlog goes
  LABEL: 'Invoice-archived',    // added to threads that have been saved
  MAX_RUNTIME_MS: 4.5 * 60 * 1000, // Apps Script stops runs at 6 min; leave headroom
};

// Senders whose billing emails we want. Add a domain here when a new tool's bills slip through.
const VENDOR_SENDERS = [
  'anthropic.com', 'claude.com', 'slack.com', 'metaview.ai', 'loxo.co', 'linkedin.com',
  'lemlist.com', 'zapmail.ai', 'clay.com', 'lovable.dev', 'canva.com', 'pin.com',
  'juicebox.ai', 'adobe.com', 'revolut.com', 'odido.nl', 'cal.com', 'wework.com',
  'stripe.com', 'paddle.com', 'payments-noreply@google.com', 'signalbase',
];

const BILLING_WORDS =
  'invoice OR receipt OR renewal OR renews OR payment OR subscription OR charge OR "trial ends"';

function buildQuery_() {
  const labelSlug = CONFIG.LABEL.toLowerCase().replace(/\s+/g, '-');
  // (known vendor AND billing word in subject) OR (any sender with invoice/receipt in subject)
  const match =
    `((from:(${VENDOR_SENDERS.join(' OR ')}) subject:(${BILLING_WORDS})) ` +
    `OR subject:(invoice OR receipt))`;
  // Skip threads already archived, but keep re-checking recent ones for new replies/renewals.
  return `${match} newer_than:${CONFIG.LOOKBACK} (-label:${labelSlug} OR newer_than:30d) -in:drafts`;
}

/** Run once by hand: checks the folder, creates the hourly trigger, starts the backlog. */
function setup() {
  if (CONFIG.FOLDER_ID === 'PASTE_FOLDER_ID_HERE') {
    throw new Error('Set CONFIG.FOLDER_ID to the shared Invoices folder ID first.');
  }
  DriveApp.getFolderById(CONFIG.FOLDER_ID).getName(); // fails early if no access
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'archiveInvoices')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('archiveInvoices').timeBased().everyHours(1).create();
  archiveInvoices();
}

/** Run by the hourly trigger. Safe to run any number of times; never saves an email twice. */
function archiveInvoices() {
  const started = Date.now();
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);
  const props = PropertiesService.getScriptProperties();
  const mailbox = Session.getEffectiveUser().getEmail();
  const query = buildQuery_();

  // Collect matches first: labelling while paging would shift the result pages.
  const threads = [];
  for (let start = 0; ; start += 100) {
    const page = GmailApp.search(query, start, 100);
    threads.push(...page);
    if (page.length < 100) break;
  }

  let saved = 0;
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      if (Date.now() - started > CONFIG.MAX_RUNTIME_MS) {
        console.log(`Time limit reached. Saved ${saved}; the next run continues.`);
        return;
      }
      const key = 'm_' + msg.getId();
      if (props.getProperty(key)) continue;
      saveMessage_(msg, thread, folder, mailbox);
      props.setProperty(key, '1');
      saved++;
    }
    thread.addLabel(label);
  }
  console.log(`Done. ${threads.length} matching threads, ${saved} new emails saved.`);
}

function saveMessage_(msg, thread, folder, mailbox) {
  const tz = Session.getScriptTimeZone();
  const date = Utilities.formatDate(msg.getDate(), tz, 'yyyy-MM-dd');
  const vendor = vendorName_(msg.getFrom());
  const base = clean_(`${date} - ${vendor} - ${msg.getSubject() || 'no subject'}`).slice(0, 120);

  const pdfs = msg.getAttachments({ includeInlineImages: false })
    .filter(a => a.getContentType() === 'application/pdf' || /\.pdf$/i.test(a.getName()));

  const text = [
    `Mailbox: ${mailbox}`,
    `From: ${msg.getFrom()}`,
    `To: ${msg.getTo()}`,
    `Cc: ${msg.getCc()}`,
    `Date: ${msg.getDate().toISOString()}`,
    `Subject: ${msg.getSubject()}`,
    `Gmail link: https://mail.google.com/mail/?authuser=${mailbox}#all/${thread.getId()}`,
    `Message ID: ${msg.getId()}`,
    `PDF attachments: ${pdfs.map(a => a.getName()).join(', ') || 'none'}`,
    '',
    '----- Email body -----',
    '',
    msg.getPlainBody(),
  ].join('\n');

  folder.createFile(`${base}.txt`, text, MimeType.PLAIN_TEXT);

  pdfs.forEach(a => {
    let name = clean_(`${base} - ${a.getName()}`);
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    folder.createFile(a.copyBlob()).setName(name);
  });
}

/** "Anthropic, PBC <invoice@stripe.com>" -> "Anthropic, PBC"; "billing@loxo.co" -> "loxo". */
function vendorName_(from) {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const display = m ? m[1].trim() : '';
  const address = m ? m[2] : from.trim();
  const generic = /^(no-?reply|billing|invoices?|receipts?|payments?|support|team|stripe|paddle)$/i;
  if (display && !generic.test(display)) return display;
  const domain = (address.split('@')[1] || address).toLowerCase();
  const parts = domain.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : domain;
}

function clean_(s) {
  return s.replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}
