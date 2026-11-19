/**
 * Comfort Hands finance portal: storage backend.
 *
 * Paste this into an Apps Script project attached to the finance Google Sheet
 * (Extensions > Apps Script), set CLIENT_ID below, then deploy as a web app:
 *   Execute as: Me      Who has access: Anyone
 * The page address is public, but every request must carry a Google sign-in
 * token that belongs to the owner or to one of ALLOWED_EMAILS. See SETUP.md.
 */

// The same Google Client ID you enter on the portal sign-in screen.
const CLIENT_ID = 'PASTE_YOUR_GOOGLE_CLIENT_ID_HERE';

// Everyone allowed in, besides the Google account that owns this script.
const ALLOWED_EMAILS = ['abigail@comforthands.net'];

const TABS = ['Claims', 'Remits', 'Files', 'Bills', 'Payroll', 'Accounts', 'Txns', 'Rules', 'Owners', 'Draws', 'Receipts'];
const RECEIPT_FOLDER_NAME = 'Comfort Hands finance receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

function doGet() {
  return json_({ ok: true, service: 'Comfort Hands finance' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    verify_(req.token);
    switch (req.action) {
      case 'load': return json_(load_());
      case 'save': return json_(save_(req));
      case 'upload': return json_(upload_(req));
      case 'delete': return json_(delete_(req));
      default: throw new Error('Unknown request.');
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err), auth: !!(err && err.auth) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authError_(msg) {
  const e = new Error(msg);
  e.auth = true;
  return e;
}

function allowed_() {
  const list = ALLOWED_EMAILS.slice();
  list.push(Session.getEffectiveUser().getEmail());
  return list.map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean);
}

// Checks the Google access token the portal sends and returns the signed-in email.
function verify_(token) {
  if (!token) throw authError_('Sign in with Google first.');
  if (CLIENT_ID.indexOf('PASTE_') === 0) throw new Error('The script has no Client ID yet. Open Code.gs and set CLIENT_ID.');
  const cache = CacheService.getScriptCache();
  const key = 't' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return hit;
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw authError_('Your Google sign-in is not valid or has expired. Sign in again.');
  const info = JSON.parse(r.getContentText());
  if (info.azp !== CLIENT_ID && info.aud !== CLIENT_ID) throw authError_('This sign-in is for a different app.');
  if (String(info.email_verified) !== 'true' || !info.email) throw authError_('Your Google account email is not verified.');
  const email = String(info.email).toLowerCase();
  if (allowed_().indexOf(email) < 0) throw authError_(email + ' is not allowed to use the finance portal.');
  cache.put(key, email, 300);
  return email;
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function version_(ss) {
  return Number(sheet_(ss, 'Meta').getRange(1, 1).getValue()) || 0;
}

function load_() {
  const ss = ss_();
  const tabs = {};
  TABS.forEach(function (name) {
    const sh = sheet_(ss, name);
    tabs[name] = sh.getLastRow() ? sh.getDataRange().getDisplayValues() : [];
  });
  return { tabs: tabs, version: version_(ss) };
}

function writeTab_(ss, name, rows) {
  const sh = sheet_(ss, name);
  sh.clearContents();
  if (!rows || !rows.length) return;
  const width = Math.max.apply(null, rows.map(function (r) { return r.length; }));
  const vals = rows.map(function (r) {
    const o = r.map(function (v) { return v == null ? '' : String(v); });
    while (o.length < width) o.push('');
    return o;
  });
  const rg = sh.getRange(1, 1, vals.length, width);
  rg.setNumberFormat('@');
  rg.setValues(vals);
}

function save_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = ss_();
    const cur = version_(ss);
    if (!req.force && Number(req.expected) !== cur) return { conflict: true, version: cur };
    (req.changes || []).forEach(function (c) {
      if (TABS.indexOf(c.name) < 0) throw new Error('Unknown tab: ' + c.name);
      writeTab_(ss, c.name, c.rows);
    });
    const next = cur + 1;
    sheet_(ss, 'Meta').getRange(1, 1).setValue(next);
    SpreadsheetApp.flush();
    return { version: next };
  } finally {
    lock.releaseLock();
  }
}

function receiptFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('RECEIPT_FOLDER');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* create a new one below */ }
  }
  const f = DriveApp.createFolder(RECEIPT_FOLDER_NAME);
  const others = ALLOWED_EMAILS.filter(Boolean);
  if (others.length) f.addViewers(others);
  props.setProperty('RECEIPT_FOLDER', f.getId());
  return f;
}

function upload_(req) {
  const mime = String(req.mime || '');
  if (!/^image\//.test(mime) && mime !== 'application/pdf') throw new Error('Only photos and PDFs can be attached.');
  const bytes = Utilities.base64Decode(req.b64 || '');
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('The file is larger than 10 MB.');
  const name = String(req.name || 'receipt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const file = receiptFolder_().createFile(Utilities.newBlob(bytes, mime, name));
  return { id: file.getId(), link: file.getUrl() };
}

function delete_(req) {
  const folder = receiptFolder_();
  const file = DriveApp.getFileById(String(req.id || ''));
  const parents = file.getParents();
  let inside = false;
  while (parents.hasNext()) { if (parents.next().getId() === folder.getId()) inside = true; }
  if (!inside) throw new Error('That file is not in the receipts folder.');
  file.setTrashed(true);
  return { ok: true };
}
