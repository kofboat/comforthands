/**
 * Comfort Hands finance portal: storage backend, users and activity log.
 *
 * Paste this into an Apps Script project attached to the finance Google Sheet
 * (Extensions > Apps Script), set CLIENT_ID below, then deploy as a web app:
 *   Execute as: Me      Who has access: Anyone
 * The page address is public, but every request must carry a Google sign-in
 * token for someone on the Users tab (or the owner of this script).
 * Roles are checked here, on every request. See SETUP.md.
 */

// The same Google Client ID you enter on the portal sign-in screen.
const CLIENT_ID = 'PASTE_YOUR_GOOGLE_CLIENT_ID_HERE';

// Seeds the Users tab with these Owners the first time the script runs. After that, manage
// people from the Users tab in the portal. The Google account that owns this script is always an Owner.
const ALLOWED_EMAILS = ['abigail@comforthands.net'];

// Data tabs and who can use them. Owners can edit all; bookkeepers cannot see OWNER_ONLY tabs.
const TABS = ['Claims', 'Remits', 'Files', 'Bills', 'Payroll', 'Accounts', 'Txns', 'Rules', 'Owners', 'Draws', 'Receipts'];
const OWNER_ONLY = ['Owners', 'Draws'];
const ROLES = ['owner', 'bookkeeper', 'viewer'];
const RECEIPT_FOLDER_NAME = 'Comfort Hands finance receipts';
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const MAX_LOG_ROWS = 20000;

function doGet() {
  return json_({ ok: true, service: 'Comfort Hands finance' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const who = identify_(req.token);
    switch (req.action) {
      case 'load': return json_(load_(who));
      case 'save': return json_(save_(who, req));
      case 'upload': return json_(upload_(who, req));
      case 'delete': return json_(delete_(who, req));
      case 'users_load': return json_(usersLoad_(who));
      case 'users_save': return json_(usersSave_(who, req));
      case 'log': return json_(logLoad_(who, req));
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

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
function version_(ss) { return Number(sheet_(ss, 'Meta').getRange(1, 1).getValue()) || 0; }
function ownerEmail_() { return String(Session.getEffectiveUser().getEmail()).trim().toLowerCase(); }

/* ---------- sign-in, users and roles ---------- */

// Checks the Google access token and returns the verified email (cached briefly).
function verifiedEmail_(token) {
  if (!token) throw authError_('Sign in with Google first.');
  if (CLIENT_ID.indexOf('PASTE_') === 0) throw new Error('The script has no Client ID yet. Open Code.gs and set CLIENT_ID.');
  const cache = CacheService.getScriptCache();
  const key = 't' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  const hit = cache.get(key);
  if (hit) return { email: hit, fresh: false };
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw authError_('Your Google sign-in is not valid or has expired. Sign in again.');
  const info = JSON.parse(r.getContentText());
  if (info.azp !== CLIENT_ID && info.aud !== CLIENT_ID) throw authError_('This sign-in is for a different app.');
  if (String(info.email_verified) !== 'true' || !info.email) throw authError_('Your Google account email is not verified.');
  const email = String(info.email).toLowerCase();
  cache.put(key, email, 300);
  return { email: email, fresh: true };
}

// Users tab rows: email, name, role, added. Seeded on first use.
function usersRead_(ss) {
  const sh = sheet_(ss, 'Users');
  if (sh.getLastRow() < 2) {
    const seed = [['email', 'name', 'role', 'added']];
    const today = new Date().toISOString().slice(0, 10);
    ALLOWED_EMAILS.forEach(function (e) {
      const em = String(e).trim().toLowerCase();
      if (em && em !== ownerEmail_()) seed.push([em, '', 'owner', today]);
    });
    writeRows_(sh, seed);
  }
  const rows = sh.getDataRange().getDisplayValues().slice(1);
  return rows.filter(function (r) { return r[0]; }).map(function (r) {
    return { email: String(r[0]).trim().toLowerCase(), name: String(r[1] || ''), role: String(r[2] || 'viewer').toLowerCase(), added: String(r[3] || '') };
  });
}

function identify_(token) {
  const v = verifiedEmail_(token);
  const ss = ss_();
  let role = null;
  if (v.email === ownerEmail_()) role = 'owner';
  else {
    const u = usersRead_(ss).filter(function (x) { return x.email === v.email; })[0];
    if (u && ROLES.indexOf(u.role) >= 0) role = u.role;
  }
  if (!role) {
    const cache = CacheService.getScriptCache();
    if (!cache.get('d' + v.email)) { cache.put('d' + v.email, '1', 600); log_(ss, v.email, 'Sign-in refused', 'Not on the Users tab'); }
    throw authError_(v.email + ' is not allowed to use the finance portal. Ask an owner to add you.');
  }
  if (v.fresh) log_(ss, v.email, 'Signed in', role);
  return { email: v.email, role: role };
}

function canSee_(role, tab) { return role === 'owner' || OWNER_ONLY.indexOf(tab) < 0; }
function canEdit_(role) { return role === 'owner' || role === 'bookkeeper'; }

/* ---------- activity log ---------- */

function log_(ss, email, action, detail) {
  const sh = sheet_(ss, 'Log');
  if (sh.getLastRow() === 0) {
    const head = sh.getRange(1, 1, 1, 4);
    head.setNumberFormat('@');
    head.setValues([['time (UTC)', 'user', 'action', 'detail']]);
  }
  const row = sh.getLastRow() + 1;
  const rg = sh.getRange(row, 1, 1, 4);
  rg.setNumberFormat('@');
  rg.setValues([[new Date().toISOString(), String(email), String(action), String(detail || '').slice(0, 500)]]);
  if (row > MAX_LOG_ROWS) sh.deleteRows(2, 1000);
}

function logLoad_(who, req) {
  if (who.role !== 'owner') throw new Error('Only owners can see the activity log.');
  const sh = sheet_(ss_(), 'Log');
  const n = sh.getLastRow() - 1;
  if (n < 1) return { rows: [] };
  const rows = sh.getRange(2, 1, n, 4).getDisplayValues();
  const limit = Math.min(Number(req.limit) || 300, 2000);
  return { rows: rows.reverse().slice(0, limit) };
}

/* ---------- data ---------- */

function load_(who) {
  const ss = ss_();
  const tabs = {};
  TABS.forEach(function (name) {
    if (!canSee_(who.role, name)) return;
    const sh = sheet_(ss, name);
    tabs[name] = sh.getLastRow() ? sh.getDataRange().getDisplayValues() : [];
  });
  return { tabs: tabs, version: version_(ss), role: who.role, email: who.email };
}

function writeRows_(sh, rows) {
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

function norm_(r) {
  const a = r.map(function (v) { return v == null ? '' : String(v); });
  while (a.length && a[a.length - 1] === '') a.pop();
  return a.join('\u0001');
}

// Counts rows added, changed and removed (by the first column), without recording any contents.
function diff_(oldRows, newRows) {
  const old = {};
  (oldRows || []).slice(1).forEach(function (r) { if (r.some(function (v) { return v !== ''; })) old[String(r[0])] = norm_(r); });
  let add = 0, chg = 0, rem = 0;
  const seen = {};
  (newRows || []).slice(1).forEach(function (r) {
    const k = String(r[0]);
    seen[k] = 1;
    if (!(k in old)) add++; else if (old[k] !== norm_(r)) chg++;
  });
  Object.keys(old).forEach(function (k) { if (!seen[k]) rem++; });
  const parts = [];
  if (add) parts.push(add + ' added');
  if (chg) parts.push(chg + ' changed');
  if (rem) parts.push(rem + ' removed');
  return parts.join(', ');
}

function save_(who, req) {
  if (!canEdit_(who.role)) throw new Error('Your role can view but not change data.');
  const changes = req.changes || [];
  changes.forEach(function (c) {
    if (TABS.indexOf(c.name) < 0) throw new Error('Unknown tab: ' + c.name);
    if (!canSee_(who.role, c.name)) throw new Error('Your role cannot change ' + c.name + '.');
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = ss_();
    const cur = version_(ss);
    if (!req.force && Number(req.expected) !== cur) return { conflict: true, version: cur };
    const notes = [];
    changes.forEach(function (c) {
      const sh = sheet_(ss, c.name);
      const before = sh.getLastRow() ? sh.getDataRange().getDisplayValues() : [];
      const d = diff_(before, c.rows);
      writeRows_(sh, c.rows);
      if (d) notes.push(c.name + ': ' + d);
    });
    const next = cur + 1;
    sheet_(ss, 'Meta').getRange(1, 1).setValue(next);
    if (notes.length) log_(ss, who.email, req.force ? 'Saved changes (overwrote newer changes)' : 'Saved changes', notes.join('; '));
    SpreadsheetApp.flush();
    return { version: next };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- users ---------- */

function usersLoad_(who) {
  if (who.role !== 'owner') throw new Error('Only owners can manage users.');
  return { users: usersRead_(ss_()), owner: ownerEmail_() };
}

function usersSave_(who, req) {
  if (who.role !== 'owner') throw new Error('Only owners can manage users.');
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = ss_();
    const before = usersRead_(ss);
    const seen = {};
    const list = (req.users || []).map(function (u) {
      const email = String(u.email || '').trim().toLowerCase();
      const role = String(u.role || '').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('"' + email + '" is not a valid email address.');
      if (ROLES.indexOf(role) < 0) throw new Error('Unknown role for ' + email + '.');
      if (seen[email]) throw new Error(email + ' is listed twice.');
      seen[email] = 1;
      const prev = before.filter(function (b) { return b.email === email; })[0];
      return { email: email, name: String(u.name || '').trim().slice(0, 80), role: role, added: prev ? prev.added : new Date().toISOString().slice(0, 10) };
    }).filter(function (u) { return u.email !== ownerEmail_(); });
    const rows = [['email', 'name', 'role', 'added']].concat(list.map(function (u) { return [u.email, u.name, u.role, u.added]; }));
    writeRows_(sheet_(ss, 'Users'), rows);
    list.forEach(function (u) {
      const prev = before.filter(function (b) { return b.email === u.email; })[0];
      if (!prev) log_(ss, who.email, 'User added', u.email + ' as ' + u.role);
      else if (prev.role !== u.role) log_(ss, who.email, 'Role changed', u.email + ': ' + prev.role + ' to ' + u.role);
    });
    before.forEach(function (b) { if (!seen[b.email]) log_(ss, who.email, 'User removed', b.email); });
    try { shareFolder_(receiptFolder_(), ss); } catch (e) { /* sharing is retried on the next upload */ }
    return { users: list, owner: ownerEmail_() };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- receipts ---------- */

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
  props.setProperty('RECEIPT_FOLDER', f.getId());
  return f;
}

// Everyone on the Users tab can open receipts, so the folder is shared with them all as viewers.
function shareFolder_(folder, ss) {
  const emails = usersRead_(ss).map(function (u) { return u.email; });
  if (emails.length) folder.addViewers(emails);
}

function upload_(who, req) {
  if (!canEdit_(who.role)) throw new Error('Your role can view but not change data.');
  const mime = String(req.mime || '');
  if (!/^image\//.test(mime) && mime !== 'application/pdf') throw new Error('Only photos and PDFs can be attached.');
  const bytes = Utilities.base64Decode(req.b64 || '');
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('The file is larger than 10 MB.');
  const name = String(req.name || 'receipt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const ss = ss_();
  const folder = receiptFolder_();
  shareFolder_(folder, ss);
  const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  log_(ss, who.email, 'Receipt added', name);
  return { id: file.getId(), link: file.getUrl() };
}

function delete_(who, req) {
  if (!canEdit_(who.role)) throw new Error('Your role can view but not change data.');
  const folder = receiptFolder_();
  const file = DriveApp.getFileById(String(req.id || ''));
  const parents = file.getParents();
  let inside = false;
  while (parents.hasNext()) { if (parents.next().getId() === folder.getId()) inside = true; }
  if (!inside) throw new Error('That file is not in the receipts folder.');
  file.setTrashed(true);
  log_(ss_(), who.email, 'Receipt deleted', file.getName ? file.getName() : '');
  return { ok: true };
}
