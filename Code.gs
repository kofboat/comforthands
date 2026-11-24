/**
 * Comfort Hands onboarding portal — receiver.
 * Receives the signed admission packet from the portal, builds a PDF,
 * saves it to Google Drive and emails it to the office.
 *
 * SETUP (see SETUP.md): paste into a new Apps Script project, edit CONFIG,
 * deploy as Web app (Execute as: Me, Who has access: Anyone), then paste the
 * web-app URL into SUBMIT_URL in the portal. After pasting a new version: deploy a new version, then run upgrade() once.
 */
const CONFIG = {
  DRIVE_FOLDER_ID: 'PASTE_DRIVE_FOLDER_ID_HERE',   // the folder admissions are filed in
  OFFICE_EMAIL: 'PASTE_OFFICE_EMAIL_HERE',          // who receives the PDF (comma-separate for several)
  // Server-only key used to sign sign-in sessions. Never put this in the portal. Use a long random string.
  SHARED_SECRET: 'CHANGE-ME-TO-A-LONG-RANDOM-STRING',
  PASSWORD_SALT: 'CHANGE-ME-TO-ANOTHER-RANDOM-STRING',
  SESSION_HOURS: 12,
  TIMEZONE: 'America/New_York',   // the time zone the agency works in. Texts and due dates refuse to run if the Apps Script project is set to anything else
  // Staff who may sign in. hash = output of makeHash() below. roles: 'admin', 'nurse', 'patient' (nurse's phone needs 'patient' to collect signatures), 'aide' (employee portal: weekly activity sheets only).
  USERS: [
    // { email: 'you@comforthands.net', name: 'Your Name', hash: 'PASTE_HASH', roles: ['admin','nurse','patient'] },
  ],
  // New-aide onboarding: forms emailed to the applicant after the application review. Upload each to Drive and paste its file ID.
  ONBOARDING_FORMS: [
    { id: '', name: 'Onboarding Form 1.pdf' }
  ],
  // Agency details used on the insurers' PCA authorization forms. Served to the portal only after sign-in.
  AGENCY: {
    name: 'Comfort Hands Home Healthcare LLC', addr: '505 Hamilton Ave Ste 200', city: 'Linwood', state: 'NJ', zip: '08221', phone: '609-277-3032', fax: '609-479-5931',
    npi: '', tin: '', promise: '',
    email: '', medicaidId: '', carebridgeId: '',
    providerIds: { hnjh: '', uhc: '', wellpoint: '', aetna: '', hpp: '' }   // Aetna's form says not to give a provider ID
  },
  // Faxing PCA requests through MetroFax (email-to-fax), the same way the Physician Order Request is faxed: the form is emailed to
  // <number>@metrofax.com from the script's Google account, which is already allowed to send in MetroFax. Blank GATEWAY_DOMAIN switches PCA faxing off.
  FAX: {
    GATEWAY_DOMAIN: 'metrofax.com',
    NUMBERS: { 'Horizon': '6095833048', 'UnitedHealthcare': '8555834041', 'Aetna': '8609753293', 'Wellpoint': '8009643627', 'HealthPartners': '' }
  },
  // Google reCAPTCHA v3 on the public Apply page. Paste the SECRET key here (never in the web page). Blank = no check, so nothing breaks until you set it up.
  RECAPTCHA_SECRET: '',
  RECAPTCHA_MIN_SCORE: 0.5,   // 0 to 1. Google scores each visitor; below this the application is refused. Lower it (0.3) if real applicants get blocked
  RN_SIGNERS: [{ name: 'Abigail Ayitiah', title: 'ARN MSN, A-GNP-C' }],   // Nurses who can sign reports. They appear in the RN name and title dropdown. Add one per line; "Other…" is always offered too
  // Text messages through Twilio. Leave ENABLED false until you have tested with sendTestText(). Until then texts are only recorded in the TextLog tab.
  SMS: {
    ENABLED: false,
    TWILIO_SID: '', TWILIO_TOKEN: '',          // from your Twilio console. Keep them only here
    FROM: '',                                   // your Twilio number (+1...) or a Messaging Service SID (MG...)
    CLOCK_URL: '',                              // link aides open to clock in/out (Homebase or HHAeXchange)
    LEAD_MIN: 15,                               // clock-in reminder this many minutes before the shift
    TEST_TO: '',                                // your own mobile number, for sendTestText()
    OFFICE_PHONES: []                           // optional: numbers that get the weekly counts-only text
  },
  ONBOARDING_NOTE: '',          // optional extra line added to the applicant email
  STAFF_PORTAL_URL: '',         // optional: the employee portal address, included in the new-aide login email
  APPLY_URL: '',                // web address of the Apply page on your site, e.g. https://comforthands.net/apply/
  FCRA_SUMMARY_URL: '',         // link to "A Summary of Your Rights Under the Fair Credit Reporting Act" (ask your screening company for their copy)
  WELCOME_LETTER_FILE_ID: '',   // Drive file ID of Welcome_Letter_Comfort_Hands.pdf; attached to the welcome email
  // PDFs attached to the patient's pre-visit email. Upload each to Drive and paste its file ID.
  EXTRA_ATTACHMENTS: [
    { id: '', name: 'NJ Advance Directive.pdf' },
    { id: '', name: 'NJ Consumer Guide to Homemaker Home Health Aide Services.pdf' }
  ]
};

// ── SIGN-IN ─────────────────────────────────────────────────
function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join(''); }
function hash_(email, pw) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, CONFIG.PASSWORD_SALT + ':' + String(email).toLowerCase() + ':' + pw, Utilities.Charset.UTF_8));
}
// Stored passwords are stretched (many HMAC rounds) so a leaked Sheet cannot be guessed quickly. Format: v2$<hex>.
const PW_ITER_ = 600;
function stretch_(hexHash) {
  const key = Utilities.newBlob(CONFIG.PASSWORD_SALT).getBytes();
  let b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, hexHash, Utilities.Charset.UTF_8);
  for (let i = 0; i < PW_ITER_; i++) b = Utilities.computeHmacSha256Signature(b, key);
  return 'v2$' + hex_(b);
}
function pwHash_(email, pw) { return stretch_(hash_(email, pw)); }
function pwMatches_(u, pw) {
  const h = String(u.hash || ''); if (!h) return false;
  const base = hash_(u.email, pw);
  return h.indexOf('v2$') === 0 ? same_(stretch_(base), h) : same_(base, h);
}
function same_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function sign_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, CONFIG.SHARED_SECRET);
  return Utilities.base64EncodeWebSafe(sig);
}
// A session is tied to the current password: changing or resetting the password ends every older session.
function fp_(hash) { return sign_('fp:' + String(hash || '')).slice(0, 16); }
function makeToken_(user) {
  const exp = Date.now() + CONFIG.SESSION_HOURS * 3600 * 1000;
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ e: user.email.toLowerCase(), x: exp, f: fp_(user.hash) }));
  return { token: payload + '.' + sign_(payload), exp: exp };
}
// Accounts live in the "Users" tab of the Google Sheet (email, name, hash, roles, active, updatedAt).
// CONFIG.USERS still works as a starting list: a Users-tab row for the same email takes priority.
function usersSheet_() { return tab_('Users', ['email', 'name', 'hash', 'roles', 'active', 'updatedAt']); }
function findUser_(email) {
  email = String(email || '').trim().toLowerCase(); if (!email) return null;
  const sh = usersSheet_(), r = findRowCI_(sh, email);
  if (r) {
    const x = sh.getRange(r, 1, 1, 6).getValues()[0];
    if (x[4] === false || String(x[4]).toLowerCase() === 'false') return null;
    return { email: email, name: x[1] || email, hash: String(x[2] || ''), roles: String(x[3] || '').toLowerCase().split(/[\s,;]+/).filter(Boolean) };
  }
  const c = CONFIG.USERS.filter(function (u) { return u.email.toLowerCase() === email; })[0];
  return c ? { email: email, name: c.name || email, hash: String(c.hash || ''), roles: c.roles || [] } : null;
}
function findRowCI_(sh, email) {
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]).trim().toLowerCase() === email) return i + 1;
  return 0;
}
function setHash_(user, h) {
  return withLock_(function () {
    const sh = usersSheet_(), e = user.email.toLowerCase(), r = findRowCI_(sh, e), now = new Date().toISOString();
    if (r) { sh.getRange(r, 3).setValue(h); sh.getRange(r, 6).setValue(now); }
    else sh.appendRow([e, txt_(user.name || e), h, (user.roles || []).join(','), true, now]);
    user.hash = h; return h;
  });
}
function setPassword_(user, pw) { return setHash_(user, pwHash_(user.email, pw)); }
function pwOk_(pw) { pw = String(pw || ''); return pw.length >= 10 && pw.length <= 100; }
function signers_() { return (CONFIG.RN_SIGNERS || []).map(function (q) { return { name: String(q.name || '').slice(0, 80), title: String(q.title || '').slice(0, 80) }; }).filter(function (q) { return q.name; }); }
function session_(u) { const t = makeToken_(u); return { ok: true, token: t.token, exp: t.exp, name: u.name || u.email, roles: u.roles || [], signers: signers_() }; }

// Password reset by emailed 6-digit code (also used to set a first password for a new Users-tab row).
function resetRequest_(d) {
  const email = String(d.email || '').trim().toLowerCase(), cache = CacheService.getScriptCache();
  if (!/^\S+@\S+\.\S+$/.test(email)) return out_({ ok: true });
  const cool = 'rcool:' + email, cnt = 'rcnt:' + email;
  if (cache.get(cool) || Number(cache.get(cnt) || 0) >= 5) return out_({ ok: true }); // same reply either way
  cache.put(cool, '1', 60); cache.put(cnt, String(Number(cache.get(cnt) || 0) + 1), 3600);
  const u = findUser_(email);
  if (u) {
    const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 1000000).padStart(6, '0');
    cache.put('rcode:' + email, hash_(email, code), 900); cache.remove('ratt:' + email);
    MailApp.sendEmail({ to: email, subject: 'Your Comfort Hands portal code',
      body: 'Your code is ' + code + '. It expires in 15 minutes.\n\nIf you did not ask to reset your password, ignore this email.' });
  }
  return out_({ ok: true });
}
function resetConfirm_(d) {
  const email = String(d.email || '').trim().toLowerCase(), cache = CacheService.getScriptCache();
  const stored = cache.get('rcode:' + email), att = Number(cache.get('ratt:' + email) || 0);
  if (!stored || att >= 5) { cache.remove('rcode:' + email); return out_({ ok: false, error: 'invalid code' }); }
  cache.put('ratt:' + email, String(att + 1), 900);
  if (!same_(stored, hash_(email, String(d.code || '').trim()))) return out_({ ok: false, error: 'invalid code' });
  if (!pwOk_(d.password) || String(d.password).toLowerCase() === email) return out_({ ok: false, error: 'weak password' });
  const u = findUser_(email); if (!u) return out_({ ok: false, error: 'invalid code' });
  setPassword_(u, String(d.password));
  cache.remove('rcode:' + email); cache.remove('ratt:' + email); cache.remove('fail:' + email);
  return out_(session_(u));
}
function changePassword_(d, u) {
  if (!pwMatches_(u, String(d.oldPassword || ''))) return out_({ ok: false, error: 'wrong password' });
  if (!pwOk_(d.newPassword) || String(d.newPassword).toLowerCase() === u.email) return out_({ ok: false, error: 'weak password' });
  setPassword_(u, String(d.newPassword));
  return out_(session_(u)); // a fresh session: every older one stops working
}

function userFromToken_(t) {
  if (!t) return null;
  const p = String(t).split('.'); if (p.length !== 2 || !same_(sign_(p[0]), p[1])) return null;
  try {
    const o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p[0])).getDataAsString());
    if (o.x <= Date.now()) return null;
    const u = findUser_(o.e);
    return (u && same_(String(o.f || ''), fp_(u.hash))) ? u : null;
  } catch (e) { return null; }
}
function login_(d) {
  const email = String(d.email || '').trim().toLowerCase(), cache = CacheService.getScriptCache(), key = 'fail:' + email;
  if (Number(cache.get(key) || 0) >= 5) return out_({ ok: false, error: 'locked' });
  const u = findUser_(email);
  if (!u || !pwMatches_(u, String(d.password || ''))) {
    cache.put(key, String(Number(cache.get(key) || 0) + 1), 900);
    return out_({ ok: false, error: 'invalid' });
  }
  cache.remove(key);
  if (/^[0-9a-f]{64}$/.test(u.hash)) setHash_(u, stretch_(u.hash)); // upgrade an old-style stored password the first time it is used
  return out_(session_(u));
}
/** Run from the editor to make a password hash: edit the two values, select makeHash, Run, then read the Execution log. */
function makeHash() {
  Logger.log(pwHash_('you@comforthands.net', 'TYPE-A-STRONG-PASSWORD-HERE'));
}

// ── shared helpers ──
let LOCK_DEPTH_ = 0;
function withLock_(fn) {
  if (LOCK_DEPTH_) return fn();
  const lock = LockService.getScriptLock(); lock.waitLock(20000); LOCK_DEPTH_ = 1;
  try { return fn(); } finally { LOCK_DEPTH_ = 0; lock.releaseLock(); }
}
// Text typed by people is stored as plain text, never as a spreadsheet formula.
function txt_(s) { s = String(s == null ? '' : s); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
function safeRow_(r) { return r.map(function (v) { return typeof v === 'string' ? txt_(v) : v; }); }
function sig_(s) { s = String(s || ''); return (s.length < 600000 && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/=]+$/.test(s)) ? s : ''; }
function validDay_(s) { s = String(s || ''); const d = dparse_(s); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !!d && iso_(d) === s; }
// PDFs are built from page content sent by the portal. Strip anything active or remote before converting.
function safeHtml_(h) {
  return String(h || '')
    .replace(/<\s*(script|iframe|object|embed|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, function (tag) { // only inside tags, so typed text is never altered
      return tag.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\s(src|href|background)\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+)/gi, function (m, a, q, v1, v2) { const v = v1 != null ? v1 : (v2 != null ? v2 : q); return /^data:image\/(png|jpeg|gif);base64,/i.test(v) ? m : ''; })
        .replace(/url\s*\(/gi, 'x(');
    });
}
// The same request sent twice within 10 minutes (double tap, retry after a timeout) is filed once.
function once_(d, fn) {
  const c = {}; Object.keys(d).forEach(function (k) { if (k !== 'token' && k !== 'submittedAt') c[k] = d[k]; });
  const key = 'rid:' + hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(c), Utilities.Charset.UTF_8));
  const cache = CacheService.getScriptCache();
  const prev = withLock_(function () { const p = cache.get(key); if (!p) cache.put(key, 'P', 600); return p; });
  if (prev === 'P') return out_({ ok: false, error: 'This is already being processed. Wait a minute and check before sending it again.' });
  if (prev) { const o = JSON.parse(prev); o.duplicate = true; return out_(o); }
  try { const o = fn(); if (o && o.ok) cache.put(key, JSON.stringify(o), 600); else cache.remove(key); return out_(o); }
  catch (e) { cache.remove(key); throw e; }
}
function auditSheet_() { return tab_('Audit', ['time', 'user', 'action', 'subject', 'result']); }
function audit_(u, action, subject, result) {
  try { auditSheet_().appendRow([new Date().toISOString(), (u && u.email) || '', action, txt_(String(subject || '').slice(0, 120)), txt_(String(result || '').slice(0, 200))]); } catch (e) {}
}
function subjectOf_(d) { if (!d) return ''; return d.id || d.patientId || d.key || d.aideEmail || [d.patientLast, d.patientFirst].filter(Boolean).join(', ') || ''; }
const QUIET_ = ['applySubmit', 'applicantCode', 'applicantLogin', 'applicantGet', 'applicantSign', 'applicantUpload', 'home', 'plans', 'save', 'ptSave', 'draftSave', 'draftGet', 'onbList', 'resetRequest'];
function logCall_(d, user, res) {
  const a = d.action || 'packet'; if (QUIET_.indexOf(a) >= 0) return;
  if (!user) { user = findUser_(d.email); if (!user) return; } // sign-in attempts are logged only for real accounts
  let r = ''; try { const o = JSON.parse(res.getContent()); r = o.ok ? 'ok' : 'refused: ' + (o.error || ''); } catch (e) {}
  audit_(user, a, subjectOf_(d), r);
}

// ═══════════════════════════ AIDE WEEKLY ACTIVITY SHEETS ═══════════════════════════
// Data lives in a Google Sheet that this script creates in your admissions Drive folder the first time it is needed.
// Tabs: "CarePlan" (one row per patient: activities + assigned aide emails) and "Weeks" (one row per patient per week).
const DAYS_ = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function hasRole_(u, roles) { return (u.roles || []).some(function (r) { return roles.indexOf(r) >= 0; }); }

function db_() {
  if (DB_) return DB_;
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty('SHEET_ID');
  if (sid) return (DB_ = SpreadsheetApp.openById(sid));
  // Created in the owner's own My Drive (not the shared admissions folder): whoever can edit this Sheet controls the accounts.
  const ss = SpreadsheetApp.create(SHEET_NAME_);
  props.setProperty('SHEET_ID', ss.getId());
  try { ss.setSpreadsheetTimeZone(Session.getScriptTimeZone()); } catch (e) {}
  const p = ss.getSheets()[0]; p.setName('CarePlan');
  p.appendRow(['key', 'name', 'address', 'activities', 'aides', 'active', 'updatedAt']);
  const w = ss.insertSheet('Weeks');
  w.appendRow(['id', 'planKey', 'weekStart', 'data', 'submittedAt', 'pdfUrl']);
  return (DB_ = ss);
}
function findRow_(sh, col, val) {
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][col]) === String(val)) return i + 1;
  return 0;
}
function keyOf_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80); }
function emails_(s) { return String(s || '').toLowerCase().split(/[\s,;]+/).filter(function (x) { return /^\S+@\S+\.\S+$/.test(x); }); }
function seesPlan_(u, aides) { return hasRole_(u, ['admin', 'nurse']) || emails_(aides).indexOf(u.email.toLowerCase()) >= 0; }
function okWeek_(w) { return /^\d{4}-\d{2}-\d{2}$/.test(String(w || '')); }
function dayDate_(weekStart, i) {
  const p = weekStart.split('-'); const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + i);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MM/dd');
}
function hours_(a, b) {
  const m = function (t) { const x = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  const s = m(a), e = m(b); if (s === null || e === null) return '';
  let mins = e - s; if (mins < 0) mins += 1440;
  return (Math.round(mins / 6) / 10).toFixed(1);
}
function folderByName_(root, name) { const it = root.getFoldersByName(name); return it.hasNext() ? it.next() : root.createFolder(name); }
function nameFolder_(full) { const parts = String(full).split(/\s+/); return clean_(parts.slice(-1)[0]) + ', ' + clean_(parts.slice(0, -1).join(' ')); }

// One week of one patient's sheet, read fresh. Returns { err } or the context.
function weekCtx_(plans, weeks, key, weekStart, u) {
  const pr = findRow_(plans, 0, key); if (!pr) return { err: 'no such patient' };
  const prow = plans.getRange(pr, 1, 1, 7).getValues()[0];
  if (!seesPlan_(u, prow[4])) return { err: 'forbidden' };
  const c = { plan: { key: key, name: prow[1], address: prow[2], activities: JSON.parse(prow[3] || '[]') }, active: prow[5] !== false && String(prow[5]).toLowerCase() !== 'false',
              wid: key + '|' + weekStart, data: {}, submittedAt: '', pdfUrl: '' };
  c.wr = findRow_(weeks, 0, c.wid);
  if (c.wr) { const x = weeks.getRange(c.wr, 1, 1, 6).getValues()[0]; c.data = JSON.parse(x[3] || '{}'); c.submittedAt = x[4] ? String(x[4]) : ''; c.pdfUrl = x[5] || ''; }
  return c;
}

function aide_(act, d, u) {
  const ss = db_(), plans = carePlanTab_(), weeks = ss.getSheetByName('Weeks');
  const who = u.name || u.email, me = String(u.email).toLowerCase();
  if (act === 'publishPlan') {
    if (!hasRole_(u, ['admin', 'nurse'])) return out_({ ok: false, error: 'forbidden' });
    const key = keyOf_(d.key); if (!key || !d.patientName) return out_({ ok: false, error: 'missing patient' });
    const acts = JSON.stringify(d.activities || []); if (acts.length > CELL_MAX_) return out_({ ok: false, error: 'care plan too large' });
    return withLock_(function () {
      const psh = ptSheet_(), pt = ptRow_(psh, key);
      if (pt && psh.getRange(pt, 5).getValue() === 'discharged') return out_({ ok: false, error: 'This patient is discharged. Reopen the patient before publishing a care plan.' });
      const row = [key, txt_(d.patientName), txt_(d.address || ''), acts, emails_(d.aides).join(','), true, new Date().toISOString()];
      const r = findRow_(plans, 0, key);
      if (r) plans.getRange(r, 1, 1, 7).setValues([row]); else plans.appendRow(row);
      return out_({ ok: true, key: key, aides: emails_(d.aides).length });
    });
  }
  // Office view of every published sheet with its aides, and attach / remove aides or hide a sheet without touching its activities.
  if (act === 'planAdmin') {
    if (!hasRole_(u, ['admin', 'nurse'])) return out_({ ok: false, error: 'forbidden' });
    const pv = plans.getDataRange().getValues(), list = [];
    for (let i = 1; i < pv.length; i++) {
      if (!pv[i][0]) continue; let acts = []; try { acts = JSON.parse(pv[i][3] || '[]'); } catch (e) {}
      list.push({ key: String(pv[i][0]), name: String(pv[i][1] || ''), address: String(pv[i][2] || ''), activities: acts.map(function (a) { return String(a.t || ''); }), aides: emails_(pv[i][4]),
        active: !(pv[i][5] === false || String(pv[i][5]).toLowerCase() === 'false'), updatedAt: String(pv[i][6] || '') });
    }
    const us = usersAll_(), choices = []; Object.keys(us).forEach(function (e) { if (us[e].roles.indexOf('aide') >= 0) choices.push({ email: e, name: us[e].name || e }); });
    choices.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out_({ ok: true, plans: list, aides: choices });
  }
  if (act === 'planAides') {
    if (!hasRole_(u, ['admin', 'nurse'])) return out_({ ok: false, error: 'forbidden' });
    const pkey = keyOf_(d.key); if (!pkey) return out_({ ok: false, error: 'missing patient' });
    const list = emails_(d.aides), active = d.active !== false;
    return withLock_(function () {
      const r = findRow_(plans, 0, pkey); if (!r) return out_({ ok: false, error: 'No published sheet for this patient yet. The nurse publishes the activities first.' });
      if (active) { const psh = ptSheet_(), pt = ptRow_(psh, pkey); if (pt && psh.getRange(pt, 5).getValue() === 'discharged') return out_({ ok: false, error: 'This patient is discharged. Reopen the patient before publishing.' }); }
      if (active && !list.length) return out_({ ok: false, error: 'Attach at least one aide, or choose Unpublish.' });
      plans.getRange(r, 5).setValue(list.join(',')); plans.getRange(r, 6).setValue(active); plans.getRange(r, 7).setValue(new Date().toISOString());
      return out_({ ok: true, aides: list.length, active: active });
    });
  }
  if (act === 'plans') {
    const v = plans.getDataRange().getValues(), wv = weeks.getDataRange().getValues(), done = {}, res = [];
    for (let i = 1; i < wv.length; i++) if (wv[i][4]) done[wv[i][0]] = true;
    for (let i = 1; i < v.length; i++) {
      if (v[i][5] === false || String(v[i][5]).toLowerCase() === 'false' || !seesPlan_(u, v[i][4])) continue;
      res.push({ key: v[i][0], name: v[i][1], address: v[i][2], submitted: okWeek_(d.weekStart) && !!done[v[i][0] + '|' + d.weekStart] });
    }
    return out_({ ok: true, plans: res });
  }
  // week-level actions
  const key = keyOf_(d.key); if (!okWeek_(d.weekStart)) return out_({ ok: false, error: 'bad week' });
  if (act === 'week') {
    const c = weekCtx_(plans, weeks, key, d.weekStart, u); if (c.err) return out_({ ok: false, error: c.err });
    return out_({ ok: true, plan: c.plan, data: c.data, submittedAt: c.submittedAt, pdfUrl: c.pdfUrl });
  }
  const now = new Date().toISOString();
  if (act === 'save') {
    return withLock_(function () {
      const c = weekCtx_(plans, weeks, key, d.weekStart, u); if (c.err) return out_({ ok: false, error: c.err });
      if (!c.active) return out_({ ok: false, error: 'This sheet is closed (patient discharged).' });
      if (c.submittedAt) return out_({ ok: false, error: 'already submitted' });
      const data = c.data, p = d.patch || {}, isAide = hasRole_(u, ['aide']);
      data.times = data.times || {}; data.cells = data.cells || {}; data.notes = data.notes || {};
      // Entries stay credited to the aide who made them; an office correction is recorded as an edit, not as the nurse's own visit.
      const credit = function (cur) { if (isAide || !cur.by) { cur.by = who; cur.byE = me; delete cur.edBy; } else cur.edBy = who; return cur; };
      Object.keys(p.times || {}).forEach(function (k) {
        if (!/^[0-6]$/.test(k)) return; const t = p.times[k] || {}, cur = data.times[k] || {};
        ['in', 'out'].forEach(function (f) { if (f in t) cur[f] = String(t[f] || '').slice(0, 5); });
        data.times[k] = credit(cur);
      });
      Object.keys(p.cells || {}).forEach(function (k) {
        if (!/^\d{1,2}_[0-6]$/.test(k)) return; const v = p.cells[k], prev = data.cells[k] || {};
        if (v === 'Y' || v === 'R') { const e = credit({ by: prev.by, byE: prev.byE }); e.v = v; e.ts = now; data.cells[k] = e; } else delete data.cells[k];
      });
      Object.keys(p.notes || {}).forEach(function (k) {
        if (!/^[0-6]$/.test(k)) return; const t = String(p.notes[k] || '').slice(0, 500);
        if (t) data.notes[k] = { t: t, by: who, byE: me }; else delete data.notes[k];
      });
      const row = [c.wid, key, d.weekStart, JSON.stringify(data), '', ''];
      if (c.wr) weeks.getRange(c.wr, 1, 1, 6).setValues([row]); else weeks.appendRow(row);
      return out_({ ok: true, data: data });
    });
  }
  if (act === 'submit') {
    const aideSig = sig_(d.aideSig), clientSig = sig_(d.clientSig);
    if (!aideSig || !clientSig) return out_({ ok: false, error: 'signatures required' });
    const c = weekCtx_(plans, weeks, key, d.weekStart, u); if (c.err) return out_({ ok: false, error: c.err });
    if (!c.active) return out_({ ok: false, error: 'This sheet is closed (patient discharged).' });
    if (c.submittedAt) return out_({ ok: false, error: 'already submitted' });
    const sub = { aideName: String(d.aideName || who).slice(0, 80), clientName: String(d.clientName || '').slice(0, 80), aideSig: aideSig, clientSig: clientSig,
                  rnGiven: d.rnGiven === 'yes' ? 'Yes' : (d.rnGiven === 'no' ? 'No' : ''), rnName: String(d.rnName || '').slice(0, 80), callTime: String(d.callTime || '').slice(0, 20) };
    const pname = nameFolder_(c.plan.name), fileName = 'Activity Sheet - ' + pname + ' - week of ' + d.weekStart + '.pdf';
    // The slow work (PDF, Drive) happens without holding the lock, so other aides' saves are not blocked.
    const pdf = Utilities.newBlob(sheetHtml_(c.plan, c.data, d.weekStart, sub), 'text/html', 'sheet.html').getAs('application/pdf').setName(fileName);
    const file = ptFolder_(key, pname).createFile(pdf);
    const dup = withLock_(function () {
      const c2 = weekCtx_(plans, weeks, key, d.weekStart, u);
      if (c2.err || c2.submittedAt) return true; // someone submitted while this one was being prepared
      const data = c2.data; data.submit = { aide: sub.aideName, client: sub.clientName, rnGiven: sub.rnGiven, rnName: sub.rnName, callTime: sub.callTime };
      const row = [c2.wid, key, d.weekStart, JSON.stringify(data), now, file.getUrl()];
      if (c2.wr) weeks.getRange(c2.wr, 1, 1, 6).setValues([row]); else weeks.appendRow(row);
      return false;
    });
    if (dup) { try { file.setTrashed(true); } catch (e) {} return out_({ ok: false, error: 'already submitted' }); }
    try {
      MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: 'Activity sheet submitted — ' + c.plan.name + ' — week of ' + d.weekStart,
        body: 'The weekly activity sheet for ' + c.plan.name + ' (week of ' + d.weekStart + ') was submitted by ' + sub.aideName + ' and is attached.\nSaved to Drive: ' + file.getUrl() + '\n\nThis message contains protected health information.', attachments: [pdf] });
    } catch (e) { console.error('activity sheet email failed: ' + e); }
    return out_({ ok: true, url: file.getUrl() });
  }
  return out_({ ok: false, error: 'unknown action' });
}

function sheetHtml_(plan, data, weekStart, sub) {
  const css = 'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5px;line-height:1.42;color:#111}h1{font-size:16px;text-align:center;margin:0 0 2px}.c{text-align:center}' +
    'table{width:100%;border-collapse:collapse;margin:6px 0}td,th{border:1px solid #777;padding:3px 4px;vertical-align:top;font-size:9.5px}th{background:#f3e6f7;color:#34182d}' +
    '.ck{text-align:center;font-weight:bold;width:7.5%}.off{background:#ddd}.n{border:none}';
  let h = pdfHdr_('Home Health Aide Activity Sheet', 'patient', { name: plan.name, date: weekStart }) + '<div class="c">&radic; = CHHA Performed &nbsp; R = Client Refused &nbsp;|&nbsp; Agency Phone #: 609-277-3032</div>' +
    '<div class="c"><b>Notice:</b> Activity Sheet must reach our office by Monday, 12:00 pm, after each week ending for payroll processing.</div>' +
    '<p><b>Client:</b> ' + esc_(plan.name) + ' &mdash; ' + esc_(plan.address) + '<br><b>Week of:</b> ' + esc_(weekStart) + '</p>';
  h += '<table><tr><th>Day</th><th>Date</th><th>Time In</th><th>Time Out</th><th># Hours</th><th>Aide</th></tr>';
  let tot = 0;
  DAYS_.forEach(function (dn, i) {
    const t = (data.times || {})[i] || {}, hr = hours_(t.in, t.out); if (hr) tot += Number(hr);
    h += '<tr><td>' + dn + '</td><td>' + dayDate_(weekStart, i) + '</td><td>' + esc_(t.in || '') + '</td><td>' + esc_(t.out || '') + '</td><td>' + hr + '</td><td>' + esc_(t.by || '') + '</td></tr>';
  });
  h += '<tr><td colspan="4"><b>Total hours</b></td><td colspan="2"><b>' + tot.toFixed(1) + '</b></td></tr></table>';
  h += '<table><tr><th>Daily Activities</th>' + DAYS_.map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr>';
  (plan.activities || []).forEach(function (a) {
    h += '<tr><td><b>' + a.n + '. ' + esc_(a.t) + ':</b> ' + esc_(a.detail || '') + '</td>' + DAYS_.map(function (x, i) {
      if ((a.days || []).indexOf(i) < 0) return '<td class="ck off"></td>';
      const c = (data.cells || {})[a.n + '_' + i]; return '<td class="ck">' + (c ? (c.v === 'Y' ? '&radic;' : 'R') : '') + '</td>';
    }).join('') + '</tr>';
  });
  h += '</table>';
  const nk = Object.keys(data.notes || {});
  if (nk.length) h += '<p><b>Notes</b></p><ul>' + nk.sort().map(function (k) { return '<li>' + DAYS_[k] + ' ' + dayDate_(weekStart, Number(k)) + ': ' + esc_(data.notes[k].t) + ' (' + esc_(data.notes[k].by) + ')</li>'; }).join('') + '</ul>';
  h += '<p>I attest with my signature below that the Home Health Aide was present at the above address for the dates and times stated above.</p>' +
    '<table class="n"><tr><td class="n"><b>CHHA Signature</b><br><img src="' + sub.aideSig + '" style="height:55px"><br>' + esc_(sub.aideName) + '</td>' +
    '<td class="n"><b>Client Signature</b><br><img src="' + sub.clientSig + '" style="height:55px"><br>' + esc_(sub.clientName) + '</td></tr></table>' +
    '<p>Report given to RN / Supervisor: <b>' + esc_(sub.rnGiven) + '</b> &nbsp; Name of RN: <b>' + esc_(sub.rnName) + '</b> &nbsp; Time of call: <b>' + esc_(sub.callTime) + '</b></p>' +
    '<p><b>Any change in patient status: contact RN immediately.</b></p>';
  return '<html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + h + '</body></html>';
}

// ── Weekly activity sheet reminders: Friday 9 am and Sunday 6 pm (run installReminder() once from the editor) ──
// Aides get a text. If texting is off, the aide has no phone number or opted out, or the text fails, they get the same reminder by email instead.
function installReminder() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (['sundayReminder', 'fridayReminder'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('fridayReminder').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(9).create();
  ScriptApp.newTrigger('sundayReminder').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(18).create();
  Logger.log('Reminders installed: Fridays at 9 am and Sundays at 6 pm in the script time zone (' + Session.getScriptTimeZone() + '). Set the time zone under Project Settings if it is wrong.');
}
function weekStartNow_() {
  const tz = Session.getScriptTimeZone(), now = new Date();
  const dow = Number(Utilities.formatDate(now, tz, 'u')); // 1 = Monday ... 7 = Sunday
  return Utilities.formatDate(new Date(now.getTime() - (dow - 1) * 86400000), tz, 'yyyy-MM-dd');
}
function fridayReminder() { return sheetReminder_('fri'); }
function sundayReminder() { return sheetReminder_('sun'); }
function sheetReminder_(when) {
  const L = load_(), p = pendingSheets_(L), v = L.plans, pending = [], byAide = {}, open = {};
  p.items.forEach(function (i) { open[i.key] = true; });
  for (let i = 1; i < v.length; i++) {
    if (!open[v[i][0]]) continue;
    pending.push(v[i][1]);
    emails_(v[i][4]).forEach(function (e) { (byAide[e] = byAide[e] || []).push(v[i][1]); });
  }
  if (!pending.length) return 0;
  const tail = '\n\nActivity sheets must reach the office by Monday 12:00 pm for payroll. Open the employee portal, choose the client, sign with the client and press Submit.';
  if (when === 'sun') MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: 'Activity sheets not yet submitted — week of ' + p.week,
    body: 'These weekly activity sheets have not been submitted:\n\n- ' + pending.join('\n- ') + tail });
  const idx = smsIndex_(), trk = trkMap_(); let n = 0;
  Object.keys(byAide).forEach(function (e) {
    const list = byAide[e], o = trk[e], names = list.join(', ');
    const text = when === 'fri'
      ? 'Comfort Hands: your weekly activity sheet is ready to finish and submit for ' + names + '. Please submit it today.' + smsTail_()
      : 'Comfort Hands: reminder, your activity sheet for ' + names + ' is not submitted yet. It is due Monday 12:00 pm for payroll.' + smsTail_();
    let st = 'no-number';
    if (o && o.phone && o.smsOk) st = sendSms_(o.phone, text, 'sheet|' + when + '|' + p.week + '|' + e, 'sheet-' + when, e, idx);
    if (st === 'sent') { n++; return; }
    if (st === 'already') return;
    MailApp.sendEmail({ to: e, subject: when === 'fri' ? 'Please submit this week’s activity sheet' : 'Reminder: submit this week’s activity sheet',
      body: (when === 'fri' ? 'Your weekly activity sheet is ready to finish and submit for:\n\n- ' : 'Please finish and submit the weekly activity sheet for:\n\n- ') + list.join('\n- ') + tail });
  });
  return n;
}

// Health check: opening the web-app URL in a browser should show this text.
function doGet() {
  return ContentService.createTextOutput('Comfort Hands receiver is running.');
}

function doPost(e) {
  let d = null, user = null;
  try {
    d = JSON.parse(e.postData.contents) || {};
    if (/^CHANGE-ME/.test(CONFIG.SHARED_SECRET) || /^CHANGE-ME/.test(CONFIG.PASSWORD_SALT))
      return out_({ ok: false, error: 'The office system is not set up yet: SHARED_SECRET and PASSWORD_SALT in Code.gs still have their placeholder values.' });
    const res = route_(d, function (u) { user = u; });
    logCall_(d, user, res);
    return res;
  } catch (err) {
    try { console.error(err && err.stack ? err.stack : String(err)); } catch (e2) {}
    audit_(user, 'ERROR ' + ((d && d.action) || 'packet'), subjectOf_(d), String(err));
    return out_({ ok: false, error: /lock/i.test(String(err)) ? 'The system is busy. Try again in a moment.' : String(err).slice(0, 300) });
  }
}
function route_(d, setUser) {
  if (d.action === 'login') return login_(d);
  if (d.action === 'resetRequest') return resetRequest_(d);
  if (d.action === 'resetConfirm') return resetConfirm_(d);
  if (d.action === 'applySubmit' || /^applicant/.test(String(d.action))) return hr_(d);
  const user = userFromToken_(d.token);
  if (!user) return out_({ ok: false, error: 'unauthorized' });
  setUser(user);
  if (d.action === 'changePassword') return changePassword_(d, user);
  if (['publishPlan', 'planAdmin', 'planAides', 'plans', 'week', 'save', 'submit'].indexOf(d.action) >= 0) return aide_(d.action, d, user);
  if (REC_ACTIONS_.indexOf(d.action) >= 0) return records_(d.action, d, user);
  if (!hasRole_(user, ['admin', 'nurse', 'patient'])) return out_({ ok: false, error: 'forbidden' });
  if (d.action === 'patientCopy') return once_(d, function () { return sendCopy_(d); });
  if (d.action === 'fax') return once_(d, function () { return sendFax_(d); });
  if (d.action) return out_({ ok: false, error: 'unknown action' }); // only the admission packet has no action; never file a packet for an unrecognised request
  return once_(d, function () { return packet_(d); });
}
function packet_(d) {
  const last = clean_(d.patientLast) || 'Unknown';
  const first = clean_(d.patientFirst) || 'Patient';
  const day = Utilities.formatDate(new Date(d.submittedAt || Date.now()), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const fileName = 'Admission - ' + last + ', ' + first + ' - ' + day + '.pdf';
  const pdf = Utilities.newBlob(buildHtml_(d), 'text/html', 'packet.html').getAs('application/pdf').setName(fileName);
  // File in Drive: the patient's own folder (<Last, First>)
  const folder = ptFolder_(d.patientId, last + ', ' + first);
  const file = folder.createFile(pdf);
  MailApp.sendEmail({
    to: CONFIG.OFFICE_EMAIL,
    subject: 'Signed admission packet — ' + first + ' ' + last,
    body: 'The admission packet for ' + first + ' ' + last + ' was signed by ' + (d.signedBy || 'the patient') +
          ' and is attached.\n\nSaved to Drive: ' + file.getUrl() +
          '\n\nThis message contains protected health information.',
    attachments: [pdf]
  });
  let welcome = 'skipped (no patient email)';
  if (/^\S+@\S+\.\S+$/.test(String(d.patientEmail || ''))) {
    try { sendWelcome_(d, first, last, day, folder); welcome = 'sent'; }
    catch (err2) { welcome = 'failed: ' + err2; }
  }
  try { if (d.patientId) withLock_(function () { ptMarkActive_(d.patientId); }); } catch (e3) {}
  return { ok: true, url: file.getUrl(), welcome: welcome };
}

// ═════════════════════════════════════════════════════════════
// RECORDS: patient list, 60-day progress notes, discharge, aide evaluations
// ═════════════════════════════════════════════════════════════
// Aide evaluations: 60 days after the first case, then 90 days after the first case, then yearly.
const REC_ = { PN_DAYS: 60, EVAL_FIRST_DAYS: 60, EVAL_SECOND_DAYS: 90, EVAL_REPEAT_DAYS: 365, WARN_DAYS: 10, PURGE_DAYS: 30, PCA_WARN_DAYS: 45, TRK_WARN_DAYS: 60 };
const REC_ACTIONS_ = ['home', 'agencyIds', 'ptGet', 'ptSave', 'ptStatus', 'pcaList', 'pcaSave', 'pcaAddExisting', 'pcaFax', 'trkSave', 'aideWeeks', 'reports', 'reportSave', 'draftSave', 'draftGet', 'draftDelete', 'onbList', 'onbSave', 'onbSendForms', 'onbRequest', 'onbOffer', 'onbRef', 'onbPacket', 'onbActivate'];
// Patients tab columns. Use P_.<NAME> (0-based) instead of bare numbers. New columns are only ever added at the end.
const PT_COLS_ = ['id', 'name', 'dob', 'startOfCare', 'status', 'shared', 'form', 'createdAt', 'updatedAt', 'updatedBy', 'dischargedAt', 'lastNoteAt', 'purged', 'submittedAt', 'ver', 'dcFiledAt', 'form2', 'form3', 'folderId'];
const P_ = { ID: 0, NAME: 1, DOB: 2, START: 3, STATUS: 4, SHARED: 5, FORM: 6, CREATED: 7, UPDATED: 8, BY: 9, DISCHARGED: 10, LASTNOTE: 11, PURGED: 12, SUBMITTED: 13, VER: 14, DCFILED: 15, FORM2: 16, FORM3: 17, FOLDER: 18 };
const PT_N_ = PT_COLS_.length;
const CELL_MAX_ = 45000; // a Sheet cell holds 50,000 characters; stay under it
let DB_ = null; const TABS_ = {};
const SHEET_NAME_ = 'Comfort Hands Operations Data (restricted)';
// The care plan tab used to be called "Plans". An existing one is renamed in place, so nothing is lost.
function carePlanTab_() {
  if (TABS_['CarePlan']) return TABS_['CarePlan'];
  const ss = db_(); let sh = ss.getSheetByName('CarePlan');
  if (!sh) { const old = ss.getSheetByName('Plans'); if (old) { old.setName('CarePlan'); sh = old; } else { sh = ss.insertSheet('CarePlan'); sh.appendRow(['key', 'name', 'address', 'activities', 'aides', 'active', 'updatedAt']); } }
  return (TABS_['CarePlan'] = sh);
}
// Names for the name columns. Includes deactivated users so old rows keep a name.
let USERNAMES_ = null;
function userNames_() {
  if (USERNAMES_) return USERNAMES_;
  const m = {}, v = usersSheet_().getDataRange().getValues();
  CONFIG.USERS.forEach(function (u) { m[u.email.toLowerCase()] = u.name || u.email; });
  for (let i = 1; i < v.length; i++) { const e = String(v[i][0]).trim().toLowerCase(); if (e) m[e] = String(v[i][1] || e); }
  return (USERNAMES_ = m);
}
function userName_(email) { return userNames_()[String(email || '').trim().toLowerCase()] || ''; }

// Opens a tab, creating it (or adding newly introduced header columns) when needed.
function tab_(name, header) {
  if (TABS_[name]) return TABS_[name];
  const ss = db_(); let sh = ss.getSheetByName(name);
  if (!sh) { try { sh = ss.insertSheet(name); sh.appendRow(header); } catch (e) { sh = ss.getSheetByName(name); if (!sh) throw e; } }
  else if (sh.getLastColumn() < header.length) sh.getRange(1, 1, 1, header.length).setValues([header]);
  return (TABS_[name] = sh);
}
function ptSheet_() { return tab_('Patients', PT_COLS_); }
// The patient list only needs the small columns. Reading the big form columns (up to 45,000 characters per patient) made every list load slow, so skip them.
function ptLight_() {
  const sh = ptSheet_(), n = sh.getLastRow(); if (n < 2) return [new Array(PT_N_).fill('')];
  const a = sh.getRange(1, 1, n, 5).getValues(), b = sh.getRange(1, 8, n, 8).getValues(), out = [];
  for (let i = 0; i < n; i++) { const r = new Array(PT_N_).fill(''); for (let j = 0; j < 5; j++) r[j] = a[i][j]; for (let j = 0; j < 8; j++) r[7 + j] = b[i][j]; out.push(r); }
  return out;
}
function repSheet_() { return tab_('Reports', ['id', 'kind', 'patientId', 'aideEmail', 'title', 'date', 'pdfUrl', 'by', 'createdAt', 'data']); }
function draftSheet_() { return tab_('Drafts', ['id', 'kind', 'patientId', 'aideEmail', 'data', 'updatedAt', 'updatedBy']); }
function draftId_(d) { return String(d.kind) + '|' + (d.kind === 'chha' ? String(d.aideEmail || '').toLowerCase() : keyOf_(d.patientId)); }
// PCA authorizations: one row per request sent to an insurer. The insurer's answer (approval date, authorization number, units, dates, ICD-10) is recorded on the same row.
const PCA_COLS_ = ['id', 'patientId', 'insurer', 'type', 'sentAt', 'hoursDay', 'daysWeek', 'hoursWeek', 'reqFrom', 'reqTo', 'status', 'approvedAt', 'authNo', 'units', 'authFrom', 'authTo', 'icd10', 'note', 'updatedAt', 'by', 'patientName', 'faxedAt'];
function pcaTab_() { return tab_('PcaAuth', PCA_COLS_); }
function pcaObj_(r) { const o = {}; PCA_COLS_.forEach(function (c, i) { o[c] = (/At$|From$|To$/.test(c) && c !== 'updatedAt') ? iso_(r[i]) : String(r[i] == null ? '' : r[i]); }); return o; }
function pcaRows_(pid) { const v = pcaTab_().getDataRange().getValues(), res = []; for (let i = 1; i < v.length; i++) if (v[i][0] && (!pid || keyOf_(v[i][1]) === keyOf_(pid))) res.push(pcaObj_(v[i])); return res; }
// What the office needs to see for one patient: the current approval, any request still waiting for an answer, and days to the end date.
function pcaState_(rows) {
  const appr = rows.filter(function (r) { return r.status === 'approved' && r.authTo; }).sort(function (a, b) { return a.authTo < b.authTo ? 1 : -1; })[0];
  const pend = rows.filter(function (r) { return r.status === 'requested'; }).sort(function (a, b) { return a.sentAt < b.sentAt ? 1 : -1; })[0];
  const days = appr ? daysUntil_(appr.authTo) : null;
  const st = !rows.length ? 'none' : (pend ? (appr ? 'renewal sent' : 'awaiting insurer') : (appr ? 'approved' : 'denied'));
  return { pcaStatus: st, pcaInsurer: (appr || pend || {}).insurer || '', pcaEnd: appr ? appr.authTo : '', daysToPca: days, pcaAuthNo: appr ? appr.authNo : '', pcaSent: pend ? pend.sentAt : '' };
}
// Aide compliance trackers. Dates only: no documents are stored. One row per aide.
const TRK_COLS_ = ['email', 'position', 'phone', 'smsOk', 'hireDate', 'certExpiry', 'bgLast', 'physLast', 'ceuDoneAt', 'updatedAt', 'by', 'aideName'];
function trkTab_() { return tab_('AideTrack', TRK_COLS_); }
let TRK_MEMO_ = null;
function trkMap_() {
  if (TRK_MEMO_) return TRK_MEMO_;
  const v = trkTab_().getDataRange().getValues(), m = {};
  for (let i = 1; i < v.length; i++) { const e = String(v[i][0]).trim().toLowerCase(); if (!e) continue; const o = {}; TRK_COLS_.forEach(function (c, j) { o[c] = /Expiry$|Last$|Date$|DoneAt$/.test(c) ? iso_(v[i][j]) : (c === 'smsOk' ? isTrue_(v[i][j]) : String(v[i][j] == null ? '' : v[i][j])); }); o.row = i + 1; m[e] = o; }
  TRK_MEMO_ = m; return m;
}
function isChha_(pos) { return /home health aide|chha/i.test(String(pos || '')); }
function trkFlag_(due) { if (!due) return { due: '', days: null, status: 'unset' }; const d = daysUntil_(due); return { due: due, days: d, status: d < 0 ? 'over' : (d <= REC_.TRK_WARN_DAYS ? 'soon' : 'ok') }; }
// The CEU year runs from the hire date. All assigned training is due 11 months into each year. Once done in a year, the next due date is the following year's; if no year has been completed, the first one counts.
function ceuDue_(hire, doneAt) {
  if (!hire) return '';
  let m = -1; if (doneAt) while (addMonths_(hire, 12 * (m + 1)) <= doneAt) m++;
  return addMonths_(hire, 11 + 12 * (m + 1));
}
function trkItems_(o) {
  const items = [];
  if (isChha_(o.position)) items.push(Object.assign({ k: 'cert', label: 'CHHA certification', note: 'expires' }, trkFlag_(o.certExpiry)));
  items.push(Object.assign({ k: 'bg', label: 'Background check', last: o.bgLast }, trkFlag_(o.bgLast ? addMonths_(o.bgLast, 12) : '')));
  items.push(Object.assign({ k: 'phys', label: 'Physical exam', last: o.physLast }, trkFlag_(o.physLast ? addMonths_(o.physLast, 12) : '')));
  items.push(Object.assign({ k: 'ceu', label: 'Annual CEU training', last: o.ceuDoneAt }, trkFlag_(ceuDue_(o.hireDate, o.ceuDoneAt))));
  return items;
}
function trkFor_(email) {
  const o = trkMap_()[String(email).toLowerCase()] || { position: '', hireDate: '', certExpiry: '', bgLast: '', physLast: '', ceuDoneAt: '', phone: '', smsOk: false };
  return { position: o.position, phone: o.phone, smsOk: !!o.smsOk, hireDate: o.hireDate, certExpiry: o.certExpiry, bgLast: o.bgLast, physLast: o.physLast, ceuDoneAt: o.ceuDoneAt, chha: isChha_(o.position), items: trkItems_(o) };
}
function trkUpsert_(email, fields, who) {
  email = String(email).trim().toLowerCase(); const sh = trkTab_(), m = trkMap_(), cur = m[email];
  const x = TRK_COLS_.map(function (c) { return cur ? (c === 'smsOk' ? (cur.smsOk ? true : false) : cur[c]) : (c === 'smsOk' ? false : ''); }); x[0] = email;
  Object.keys(fields).forEach(function (c) { const i = TRK_COLS_.indexOf(c); if (i > 0 && fields[c] !== undefined) x[i] = c === 'smsOk' ? !!fields[c] : fields[c]; });
  x[TRK_COLS_.indexOf('updatedAt')] = new Date().toISOString(); x[TRK_COLS_.indexOf('by')] = who || ''; x[TRK_COLS_.indexOf('aideName')] = userName_(email);
  const row = x.map(function (v) { return typeof v === 'string' ? txt_(v) : v; });
  if (cur) sh.getRange(cur.row, 1, 1, TRK_COLS_.length).setValues([row]); else sh.appendRow(row);
  TRK_MEMO_ = null;
}
// Keeps the name columns in step with the Users tab and the patient records. Runs in upgrade() and in the daily maintenance run.
function refreshNames_() {
  USERNAMES_ = null; const names = userNames_(); let n = 0;
  const fill = function (sh, keyCol, nameCol, lookup) {
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) { const k = String(v[i][keyCol] || '').trim(); if (!k) continue; const nm = lookup(k); if (nm && String(v[i][nameCol] || '') !== nm) { sh.getRange(i + 1, nameCol + 1).setValue(txt_(nm)); n++; } }
  }, byUser = function (e) { return names[e.toLowerCase()]; };
  fill(aideTab_(), 0, 5, byUser);
  fill(trkTab_(), 0, TRK_COLS_.indexOf('aideName'), byUser);
  fill(textLogTab_(), 3, 4, byUser);
  const pv = ptLight_(), pn = {}; for (let i = 1; i < pv.length; i++) if (pv[i][P_.ID]) pn[keyOf_(pv[i][P_.ID])] = String(pv[i][P_.NAME] || '');
  fill(pcaTab_(), 1, PCA_COLS_.indexOf('patientName'), function (k) { return pn[keyOf_(k)]; });
  return n;
}
// An approval that already exists (it did not start as a request sent from the portal). One current authorization per patient: the latest approved row is updated, otherwise a row is added.
function faxDomain_() { return String((CONFIG.FAX && CONFIG.FAX.GATEWAY_DOMAIN) || '').trim().replace(/^@/, ''); }
// Emails the filled form to the insurer's fax number through MetroFax. The number comes from CONFIG only, never from the browser.
// The email carries no patient name. MetroFax emails its own delivery confirmation to the sending account.
function pcaFax_(pid, insurer, b64, who) {
  const dom = faxDomain_(); if (!dom) return { ok: false, error: 'Faxing is not set up yet (the MetroFax address is missing from the script settings).' };
  const num = String(((CONFIG.FAX || {}).NUMBERS || {})[insurer] || '').replace(/\D/g, '');
  if (!num) return { ok: false, error: 'No fax number is set for ' + (insurer || 'that insurer') + '.' };
  const full = num.length === 10 ? '1' + num : num; if (full.length !== 11) return { ok: false, error: 'The fax number for ' + insurer + ' is not valid.' };
  if (!b64 || b64.length > 6000000) return { ok: false, error: 'The form is missing or too large to fax.' };
  let bytes; try { bytes = Utilities.base64Decode(b64); } catch (e) { return { ok: false, error: 'The form could not be read.' }; }
  if (!bytes || bytes.length < 100 || bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) return { ok: false, error: 'That file is not a PDF.' };
  try {
    MailApp.sendEmail({ to: full + '@' + dom, subject: 'PCA authorization request', body: 'From Comfort Hands Home Healthcare, LLC. Please call 609-277-3032 with questions.',
      attachments: [Utilities.newBlob(bytes, 'application/pdf', 'PCA-request.pdf')] });
  } catch (e) { return { ok: false, error: 'The fax could not be sent: ' + e }; }
  // keep a copy in the patient's Drive folder (best effort; the fax has already gone)
  let url = ''; try { const pr = ptGetRow_(ptSheet_(), ptRow_(ptSheet_(), pid)), nm = String(pr[P_.NAME] || ''); url = ptFolder_(pid, nm).createFile(Utilities.newBlob(bytes, 'application/pdf', 'PCA request - ' + insurer + ' - ' + today_() + '.pdf')).getUrl(); } catch (e) {}
  return { ok: true, last4: full.slice(-4), to: full, url: url, rows: pcaRows_(pid).sort(function (a, b) { return a.sentAt < b.sentAt ? 1 : -1; }) };
}
function pcaCheck_(f) {
  if (!String(f.authNo || '').trim()) return 'The authorization number is needed.';
  if (!validDay_(f.authFrom) || !validDay_(f.authTo)) return 'The start and end dates are needed (yyyy-mm-dd).';
  if (f.authTo < f.authFrom) return 'The end date is before the start date.';
  return '';
}
function pcaApprove_(pid, f, who, psh) {
  const sh = pcaTab_(), v = sh.getDataRange().getValues(), I = function (c) { return PCA_COLS_.indexOf(c); }; let r = 0, best = '';
  for (let i = 1; i < v.length; i++) if (v[i][0] && keyOf_(v[i][1]) === pid && String(v[i][I('status')]) === 'approved') { const to = iso_(v[i][I('authTo')]); if (!r || to > best) { r = i + 1; best = to; } }
  const x = r ? v[r - 1].slice() : PCA_COLS_.map(function () { return ''; }); while (x.length < PCA_COLS_.length) x.push('');
  const set = function (c, val) { x[I(c)] = val; }, num = function (q) { const n = parseFloat(q); return isFinite(n) && n >= 0 ? String(n) : ''; };
  if (!r) { set('id', 'a' + Utilities.getUuid().replace(/-/g, '').slice(0, 12)); set('patientId', pid); set('type', 'existing'); set('sentAt', f.authFrom); }
  if (String(f.insurer || '').trim()) set('insurer', txt_(String(f.insurer).trim().slice(0, 40)));
  set('status', 'approved'); if (!x[I('approvedAt')]) set('approvedAt', f.authFrom);
  set('authNo', txt_(String(f.authNo).trim().slice(0, 40))); set('authFrom', f.authFrom); set('authTo', f.authTo);
  if (f.units !== undefined && String(f.units).trim() !== '') set('units', num(f.units)); if (f.icd10 !== undefined && String(f.icd10).trim() !== '') set('icd10', txt_(String(f.icd10).slice(0, 80)));
  if (f.hoursWeek !== undefined && String(f.hoursWeek).trim() !== '') set('hoursWeek', num(f.hoursWeek));
  set('updatedAt', new Date().toISOString()); set('by', who || ''); set('patientName', txt_(String(ptGetRow_(psh, ptRow_(psh, pid))[P_.NAME] || '')));
  if (r) sh.getRange(r, 1, 1, PCA_COLS_.length).setValues([x]); else sh.appendRow(x);
  return x[0];
}
/**
 * ONE-TIME: load your patients' current PCA authorizations. Run it once to create the "PcaImport" tab, fill one patient per row
 * (firstName, lastName, dob, insurer, authNo, authFrom, authTo; optional units, icd10, hoursWeek; dates yyyy-mm-dd), then run it again.
 * The patient must already be in the portal. A blank insurer is taken from the patient's record. Re-running updates, never duplicates.
 */
function importPca() {
  const ss = db_(); let imp = ss.getSheetByName('PcaImport');
  if (!imp) { imp = ss.insertSheet('PcaImport'); imp.appendRow(['firstName', 'lastName', 'dob', 'insurer', 'authNo', 'authFrom', 'authTo', 'units', 'icd10', 'hoursWeek']); Logger.log('Created the "PcaImport" tab. Fill it in (dates as yyyy-mm-dd), then run importPca again.'); return; }
  const v = imp.getDataRange().getValues(), psh = ptSheet_(); let n = 0; const notes = [];
  withLock_(function () {
    for (let i = 1; i < v.length; i++) {
      const first = String(v[i][0] || '').trim(), last = String(v[i][1] || '').trim(); if (!first && !last) continue;
      const dob = iso_(v[i][2]), f = { insurer: String(v[i][3] || '').trim(), authNo: String(v[i][4] || '').trim(), authFrom: iso_(v[i][5]), authTo: iso_(v[i][6]), units: v[i][7], icd10: v[i][8], hoursWeek: v[i][9] };
      if (!first || !last || !validDay_(dob)) { notes.push('row ' + (i + 1) + ': needs first, last and a valid dob'); continue; }
      const pid = keyOf_([last, first, dob].join('_').toLowerCase().replace(/[^a-z0-9_-]/g, '')), pr = ptRow_(psh, pid);
      if (!pr) { notes.push('row ' + (i + 1) + ': ' + first + ' ' + last + ' is not in the portal (check the spelling and dob)'); continue; }
      const bad = pcaCheck_(f); if (bad) { notes.push('row ' + (i + 1) + ': ' + bad); continue; }
      if (!f.insurer) { try { f.insurer = String(ptBlob_(ptGetRow_(psh, pr)).shared.insCompany || ''); } catch (e) {} if (!f.insurer) notes.push('row ' + (i + 1) + ': imported with no insurer (none on the patient record either)'); }
      pcaApprove_(pid, f, 'import', psh); n++;
    }
  });
  Logger.log('Imported ' + n + ' authorization(s).' + (notes.length ? ' Notes:\n' + notes.join('\n') : ''));
}
function aideTab_() { return tab_('AideRecords', ['email', 'firstCase', 'lastEvalAt', 'lastEvalType', 'updatedAt', 'aideName']); }
function iso_(v) { if (!v) return ''; if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); return String(v).slice(0, 10); }
function dparse_(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; }
function addMonths_(s, n) { const d = dparse_(s); if (!d) return ''; const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n); const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); d.setDate(Math.min(day, last)); return iso_(d); }
function addDays_(s, n) { const d = dparse_(s); if (!d) return ''; d.setDate(d.getDate() + n); return iso_(d); }
function today_() { return Utilities.formatDate(now_(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function daysUntil_(s) { const d = dparse_(s), t = dparse_(today_()); return d ? Math.round((d - t) / 86400000) : null; }
function ptRow_(sh, id) { return findRow_(sh, 0, id); }
function isTrue_(v) { return v === true || String(v).toLowerCase() === 'true'; }
function delRows_(sh, pred) { const v = sh.getDataRange().getValues(); for (let i = v.length - 1; i >= 1; i--) if (pred(v[i])) sh.deleteRow(i + 1); }

// remove anything that must never be stored on the Sheet
function stripSensitive_(obj) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (/^ssn/i.test(k) || /Sig$/.test(k)) return;
    const v = obj[k];
    if (typeof v === 'string' && v.indexOf('data:image') === 0) return;
    if (v && typeof v === 'object' && typeof v.v === 'string' && v.v.indexOf('data:image') === 0) return;
    out[k] = v;
  });
  return out;
}
// The admission form is stored across up to three cells (form, form2, form3); pieces after the first start with "~".
function ptBlob_(x) {
  const c = function (v) { v = String(v || ''); return v.charAt(0) === '~' ? v.slice(1) : v; };
  let shared = {}, form = {};
  try { shared = JSON.parse(x[P_.SHARED] || '{}'); } catch (e) {}
  try { form = JSON.parse((String(x[P_.FORM] || '') + c(x[P_.FORM2]) + c(x[P_.FORM3])) || '{}'); } catch (e) {}
  return { shared: shared, form: form };
}
function ptSetForm_(x, json) {
  x[P_.FORM] = json.slice(0, CELL_MAX_);
  x[P_.FORM2] = json.length > CELL_MAX_ ? '~' + json.slice(CELL_MAX_, 2 * CELL_MAX_) : '';
  x[P_.FORM3] = json.length > 2 * CELL_MAX_ ? '~' + json.slice(2 * CELL_MAX_, 3 * CELL_MAX_) : '';
}
function ptGetRow_(sh, r) { const x = sh.getRange(r, 1, 1, PT_N_).getValues()[0]; while (x.length < PT_N_) x.push(''); return x; }

// The patient's Drive folder. Remembered by ID after first use, so every document for a patient lands in one place
// and two patients with the same name never share a folder.
function ptFolder_(pid, fallbackName) {
  const root = DriveApp.getFolderById(id_(CONFIG.DRIVE_FOLDER_ID));
  const psh = ptSheet_(), r = pid ? ptRow_(psh, keyOf_(pid)) : 0;
  if (!r) return folderByName_(root, fallbackName);
  const x = ptGetRow_(psh, r);
  if (x[P_.FOLDER]) { try { return DriveApp.getFolderById(String(x[P_.FOLDER])); } catch (e) {} }
  let name = fallbackName; const s = ptBlob_(x).shared;
  if (s.lastName && s.firstName) name = clean_(s.lastName) + ', ' + clean_(s.firstName);
  const it = root.getFoldersByName(name); let folder;
  if (it.hasNext()) {
    const f = it.next(), fid = f.getId();
    const taken = psh.getDataRange().getValues().some(function (row, i) { return i > 0 && String(row[P_.FOLDER] || '') === fid && row[P_.ID] !== x[P_.ID]; });
    folder = taken ? root.createFolder(name + ' (DOB ' + iso_(x[P_.DOB]) + ')') : f;
  } else folder = root.createFolder(name);
  psh.getRange(r, P_.FOLDER + 1).setValue(folder.getId());
  return folder;
}

function ptSummary_(x, aidesByKey, pcaBy) {
  const status = String(x[P_.STATUS] || 'admission');
  const anchor = iso_(x[P_.LASTNOTE]) || iso_(x[P_.START]) || iso_(x[P_.SUBMITTED]) || iso_(x[P_.CREATED]);
  const due = status === 'active' ? addDays_(anchor, REC_.PN_DAYS) : '';
  return { id: x[P_.ID], name: x[P_.NAME], dob: iso_(x[P_.DOB]), start: iso_(x[P_.START]), status: status, lastNote: iso_(x[P_.LASTNOTE]), dischargedAt: iso_(x[P_.DISCHARGED]), submittedAt: iso_(x[P_.SUBMITTED]),
           updatedAt: String(x[P_.UPDATED] || ''), updatedBy: x[P_.BY] || '', ver: Number(x[P_.VER] || 0), purged: isTrue_(x[P_.PURGED]), nextNoteDue: due, daysToNote: due ? daysUntil_(due) : null, aides: (aidesByKey || {})[x[P_.ID]] || [], pca: pcaState_((pcaBy || {})[keyOf_(x[P_.ID])] || []) };
}

function usersAll_() {
  const res = {}, off = {}, v = usersSheet_().getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    const e = String(v[i][0]).trim().toLowerCase(); if (!e) continue;
    if (v[i][4] === false || String(v[i][4]).toLowerCase() === 'false') { off[e] = true; continue; }
    res[e] = { email: e, name: v[i][1] || e, roles: String(v[i][3] || '').toLowerCase().split(/[\s,;]+/).filter(Boolean) };
  }
  CONFIG.USERS.forEach(function (u) { const e = u.email.toLowerCase(); if (!res[e] && !off[e]) res[e] = { email: e, name: u.name || e, roles: u.roles || [] }; });
  return res;
}

// Each tab is read once per request and reused.
function load_() {
  const ss = db_();
  return { plans: carePlanTab_().getDataRange().getValues(), weeks: ss.getSheetByName('Weeks').getDataRange().getValues(), aideRec: aideTab_().getDataRange().getValues() };
}
function byAide_(x, aide) { return x.byE ? x.byE === aide.email : (x.by === aide.name || x.by === aide.email); }

// weekly sheet facts for one aide between two dates
function aideFacts_(aide, from, to, L) {
  L = L || load_(); const plans = L.plans, weeks = L.weeks;
  const mine = {}; for (let i = 1; i < plans.length; i++) if (emails_(plans[i][4]).indexOf(aide.email) >= 0) mine[plans[i][0]] = plans[i][1];
  const rows = {}; let firstCase = '';
  for (let i = 1; i < weeks.length; i++) {
    const pk = weeks[i][1]; if (!mine[pk]) continue;
    const ws = iso_(weeks[i][2]); let data = {}; try { data = JSON.parse(weeks[i][3] || '{}'); } catch (e) {}
    let hrs = 0, ticks = 0, refused = 0, notes = 0, worked = false;
    Object.keys(data.times || {}).forEach(function (k) { const t = data.times[k]; if (byAide_(t, aide)) { const h = Number(hours_(t.in, t.out)) || 0; if (h) { hrs += h; worked = true; } } });
    Object.keys(data.cells || {}).forEach(function (k) { const c = data.cells[k]; if (byAide_(c, aide)) { if (c.v === 'Y') ticks++; else if (c.v === 'R') refused++; worked = true; } });
    Object.keys(data.notes || {}).forEach(function (k) { if (byAide_(data.notes[k], aide)) notes++; });
    if (!worked) continue;
    if (!firstCase || ws < firstCase) firstCase = ws;
    if ((from && ws < from) || (to && ws > to)) continue;
    const sub = weeks[i][4] ? iso_(weeks[i][4]) : '';
    const dueBy = addDays_(ws, 7); // Monday after the week ends (noon deadline)
    const subTs = weeks[i][4] ? new Date(weeks[i][4]) : null, dl = dparse_(dueBy); if (dl) dl.setHours(12, 0, 0, 0);
    rows[pk + '|' + ws] = { patient: mine[pk], week: ws, hours: Math.round(hrs * 10) / 10, ticks: ticks, refused: refused, notes: notes, submitted: !!sub, onTime: !!(subTs && dl && subTs <= dl) };
  }
  const list = Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) { return a.week < b.week ? 1 : -1; });
  return { rows: list, firstCase: firstCase, patients: Object.keys(mine).map(function (k) { return mine[k]; }) };
}

function aideSummary_(aide, L) {
  L = L || load_();
  let first = '', lastEval = '', lastType = '';
  for (let i = 1; i < L.aideRec.length; i++) if (String(L.aideRec[i][0]).trim().toLowerCase() === aide.email) { first = iso_(L.aideRec[i][1]); lastEval = iso_(L.aideRec[i][2]); lastType = String(L.aideRec[i][3] || ''); break; }
  const f = aideFacts_(aide, '', '', L);
  if (!first) first = f.firstCase;
  const due = !lastEval ? (first ? addDays_(first, REC_.EVAL_FIRST_DAYS) : '')
    : (/^60/.test(lastType) && first ? addDays_(first, REC_.EVAL_SECOND_DAYS) : addDays_(lastEval, REC_.EVAL_REPEAT_DAYS));
  return { email: aide.email, name: aide.name, patients: f.patients, firstCase: first, lastEval: lastEval, lastType: lastType, nextEvalDue: due, daysToEval: due ? daysUntil_(due) : null, trk: trkFor_(aide.email) };
}

function pendingSheets_(L) {
  L = L || load_(); const wk = weekStartNow_(), done = {}, res = [];
  for (let i = 1; i < L.weeks.length; i++) if (L.weeks[i][4]) done[L.weeks[i][0]] = true;
  for (let i = 1; i < L.plans.length; i++) {
    const p = L.plans[i]; if (p[5] === false || String(p[5]).toLowerCase() === 'false' || done[p[0] + '|' + wk]) continue;
    res.push({ key: p[0], name: p[1] });
  }
  return { week: wk, items: res };
}

// Text messages in the last 7 days, for the home screen. Counts only (no names or numbers).
function weekTexts_() {
  try {
    const tl = textLogTab_(), ln = tl.getLastRow(), from = Math.max(2, ln - 1500), v = ln < 2 ? [] : [[]].concat(tl.getRange(from, 1, ln - from + 1, 8).getValues()), cut = new Date(now_().getTime() - 7 * 86400000).toISOString(); let sent = 0, failed = 0;
    for (let i = 1; i < v.length; i++) { const at = v[i][0] instanceof Date ? v[i][0].toISOString() : String(v[i][0]); if (!at || at < cut) continue; const st = String(v[i][6]); if (st === 'sent' || st === 'dry-run') sent++; else if (st === 'failed') failed++; }
    return { sent: sent, failed: failed, live: smsLive_() };
  } catch (e) { return { sent: 0, failed: 0, live: false }; }
}
function home_() {
  const L = load_(), pv = ptLight_(), aidesByKey = {};
  for (let i = 1; i < L.plans.length; i++) aidesByKey[L.plans[i][0]] = emails_(L.plans[i][4]);
  const patients = [], pcaBy = {};
  pcaRows_('').forEach(function (r) { const k = keyOf_(r.patientId); (pcaBy[k] = pcaBy[k] || []).push(r); });
  for (let i = 1; i < pv.length; i++) if (pv[i][0]) patients.push(ptSummary_(pv[i], aidesByKey, pcaBy));
  const users = usersAll_(), aides = Object.keys(users).filter(function (e) { return users[e].roles.indexOf('aide') >= 0; }).map(function (e) { return aideSummary_(users[e], L); });
  const sheets = pendingSheets_(L);
  const names = {}; patients.forEach(function (p) { names[p.id] = p.name; });
  const dv = draftSheet_().getDataRange().getValues(), drafts = [], LBL = { pn: 'Supplemental progress note', ra: '60-day re-assessment', dc: 'Discharge summary', chha: 'Aide evaluation' };
  for (let i = 1; i < dv.length; i++) {
    if (!dv[i][0]) continue;
    const subj = dv[i][1] === 'chha' ? ((users[String(dv[i][3]).toLowerCase()] || {}).name || dv[i][3]) : (names[dv[i][2]] || dv[i][2]);
    drafts.push({ kind: dv[i][1], label: LBL[dv[i][1]] || dv[i][1], patientId: dv[i][2], aideEmail: dv[i][3], subject: subj, updatedAt: String(dv[i][5] || ''), by: dv[i][6] });
  }
  const soon = function (d) { return d !== null && d >= 0 && d <= REC_.WARN_DAYS; }, over = function (d) { return d !== null && d < 0; };
  const counts = {
    admissions: patients.filter(function (p) { return p.status === 'admission'; }).length,
    notesSoon: patients.filter(function (p) { return soon(p.daysToNote); }).length,
    notesOver: patients.filter(function (p) { return over(p.daysToNote); }).length,
    pcaDue: patients.filter(function (p) { return p.status !== 'discharged' && !p.purged && p.pca.daysToPca !== null && p.pca.daysToPca <= REC_.PCA_WARN_DAYS && p.pca.pcaStatus !== 'renewal sent'; }).length,
    trkSoon: aides.filter(function (a) { return a.trk.items.some(function (i) { return i.status === 'soon'; }); }).length,
    trkOver: aides.filter(function (a) { return a.trk.items.some(function (i) { return i.status === 'over'; }); }).length,
    evalsSoon: aides.filter(function (a) { return soon(a.daysToEval); }).length,
    evalsOver: aides.filter(function (a) { return over(a.daysToEval); }).length,
    sheets: sheets.items.length,
    drafts: drafts.length,
    onboarding: onbAll_().filter(function (o) { return o.status === 'in progress' && !(o.app && o.app._imported); }).length
  };
  return { ok: true, positions: HR_POSITIONS_, patients: patients, aides: aides, sheets: sheets, drafts: drafts, counts: counts, week: weekTexts_(), today: today_() };
}

// Reading never takes the lock. Each change takes it only for the moment it writes.
function records_(act, d, u) {
  if (!hasRole_(u, ['admin', 'nurse'])) return out_({ ok: false, error: 'forbidden' });
  if (act === 'agencyIds') return out_({ ok: true, agency: CONFIG.AGENCY || {} });
  if (/^onb/.test(act)) {
    if (!hasRole_(u, ['admin'])) return out_({ ok: false, error: 'forbidden' });
    return act === 'onbList' ? onb_(act, d, u) : withLock_(function () { return onb_(act, d, u); });
  }
  const psh = ptSheet_(), who = u.name || u.email;
  if (act === 'home') return out_(home_());
  if (act === 'ptGet') {
    const r = ptRow_(psh, keyOf_(d.id)); if (!r) return out_({ ok: false, error: 'not found' });
    const x = ptGetRow_(psh, r), b = ptBlob_(x);
    return out_({ ok: true, patient: ptSummary_(x, {}), shared: b.shared, form: b.form });
  }
  if (act === 'trkSave') {
    const email = String(d.email || '').trim().toLowerCase(), us = usersAll_();
    if (!us[email] || us[email].roles.indexOf('aide') < 0) return out_({ ok: false, error: 'No aide with that email.' });
    const dayOk = function (v) { return v === undefined || v === '' || validDay_(v); };
    if (![d.hireDate, d.certExpiry, d.bgLast, d.physLast, d.ceuDoneAt].every(dayOk)) return out_({ ok: false, error: 'bad date' });
    if (d.position !== undefined && d.position !== '' && HR_POSITIONS_.indexOf(String(d.position)) < 0) return out_({ ok: false, error: 'bad position' });
    const f = {}; ['position', 'hireDate', 'certExpiry', 'bgLast', 'physLast', 'ceuDoneAt'].forEach(function (c) { if (d[c] !== undefined) f[c] = String(d[c]); });
    if (d.phone !== undefined) f.phone = String(d.phone).replace(/[^\d+]/g, '').slice(0, 16);
    if (d.smsOk !== undefined) f.smsOk = !!d.smsOk;
    if (d.ceu === 'done') f.ceuDoneAt = validDay_(d.ceuDoneAt) ? d.ceuDoneAt : today_(); else if (d.ceu === 'notdone') f.ceuDoneAt = '';
    return withLock_(function () {
      trkUpsert_(email, f, who); audit_(u, 'trkSave', email, Object.keys(f).join(','));
      return out_({ ok: true, trk: trkFor_(email) });
    });
  }
  if (act === 'pcaList') {
    const r = ptRow_(psh, keyOf_(d.id)); if (!r) return out_({ ok: false, error: 'not found' });
    const rows = pcaRows_(d.id).sort(function (a, b) { return a.sentAt < b.sentAt ? 1 : -1; });
    let ins = ''; try { ins = String(ptBlob_(ptGetRow_(psh, r)).shared.insCompany || ''); } catch (e) {}
    return out_({ ok: true, rows: rows, state: pcaState_(rows), agency: Object.assign({}, CONFIG.AGENCY || {}, { faxReady: !!faxDomain_(), faxTo: CONFIG.FAX ? CONFIG.FAX.NUMBERS : {} }), insurer: ins });
  }
  if (act === 'pcaFax') {
    const pid = keyOf_(d.patientId); if (!pid || !ptRow_(psh, pid)) return out_({ ok: false, error: 'not found' });
    const res = pcaFax_(pid, String(d.insurer || ''), String(d.pdf || ''), who);
    if (res.ok) audit_(u, 'pcaFax', pid, String(d.insurer) + ' ...' + res.last4);
    return out_(res);
  }
  if (act === 'pcaAddExisting') {
    const pid = keyOf_(d.patientId); if (!pid || !ptRow_(psh, pid)) return out_({ ok: false, error: 'not found' });
    const bad = pcaCheck_(d); if (bad) return out_({ ok: false, error: bad });
    return withLock_(function () {
      pcaApprove_(pid, d, who, psh); audit_(u, 'pcaAddExisting', pid, String(d.authNo || ''));
      const rows = pcaRows_(pid).sort(function (a, b) { return a.sentAt < b.sentAt ? 1 : -1; }); return out_({ ok: true, rows: rows, state: pcaState_(rows) });
    });
  }
  if (act === 'pcaSave') {
    const pid = keyOf_(d.patientId); if (!pid || !ptRow_(psh, pid)) return out_({ ok: false, error: 'not found' });
    const dayOk = function (v) { return !v || validDay_(v); };
    if (!['requested', 'approved', 'denied'].includes(d.status)) return out_({ ok: false, error: 'bad status' });
    if (![d.sentAt, d.reqFrom, d.reqTo, d.approvedAt, d.authFrom, d.authTo].every(dayOk)) return out_({ ok: false, error: 'bad date' });
    if (d.status === 'approved' && !(d.authNo && d.authFrom && d.authTo)) return out_({ ok: false, error: 'An approval needs the authorization number, start date and end date.' });
    if (d.authFrom && d.authTo && d.authTo < d.authFrom) return out_({ ok: false, error: 'The end date is before the start date.' });
    const num = function (v) { const n = parseFloat(v); return isFinite(n) && n >= 0 ? String(n) : ''; };
    return withLock_(function () {
      const sh = pcaTab_(), v = sh.getDataRange().getValues(); let r = 0;
      if (d.id) for (let i = 1; i < v.length; i++) if (String(v[i][0]) === String(d.id) && keyOf_(v[i][1]) === pid) { r = i + 1; break; }
      if (d.id && !r) return out_({ ok: false, error: 'not found' });
      const x = r ? v[r - 1].slice() : PCA_COLS_.map(function () { return ''; }); if (!r) x[0] = 'a' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
      const set = function (c, val) { x[PCA_COLS_.indexOf(c)] = val; };
      set('patientId', pid); set('insurer', txt_(String(d.insurer || '').slice(0, 40))); set('type', txt_(String(d.type || '').slice(0, 20))); set('sentAt', d.sentAt || x[4] || today_());
      ['hoursDay', 'daysWeek', 'hoursWeek'].forEach(function (c) { if (d[c] !== undefined) set(c, num(d[c])); });
      if (d.faxedAt && validDay_(d.faxedAt)) set('faxedAt', d.faxedAt);
      set('reqFrom', d.reqFrom || ''); set('reqTo', d.reqTo || ''); set('status', d.status); set('approvedAt', d.approvedAt || '');
      set('authNo', txt_(String(d.authNo || '').slice(0, 40))); set('units', num(d.units)); set('authFrom', d.authFrom || ''); set('authTo', d.authTo || '');
      set('icd10', txt_(String(d.icd10 || '').slice(0, 80))); set('note', txt_(String(d.note || '').slice(0, 300))); set('updatedAt', new Date().toISOString()); set('by', who); set('patientName', txt_(String(ptGetRow_(psh, ptRow_(psh, pid))[P_.NAME] || '')));
      if (r) sh.getRange(r, 1, 1, PCA_COLS_.length).setValues([x]); else sh.appendRow(x);
      audit_(u, 'pcaSave', pid, d.status + (x[PCA_COLS_.indexOf('authNo')] ? ' ' + x[PCA_COLS_.indexOf('authNo')] : ''));
      const rows = pcaRows_(pid); return out_({ ok: true, id: x[0], rows: rows.sort(function (a, b) { return a.sentAt < b.sentAt ? 1 : -1; }), state: pcaState_(rows) });
    });
  }
  if (act === 'ptSave') {
    const id = keyOf_(d.id); if (!id || !d.name) return out_({ ok: false, error: 'missing name' });
    const shared = JSON.stringify(stripSensitive_(d.shared)), form = JSON.stringify(stripSensitive_(d.form));
    if (shared.length > CELL_MAX_ || form.length > 3 * CELL_MAX_) return out_({ ok: false, error: 'record too large' });
    return withLock_(function () {
      const now = new Date().toISOString(), r = ptRow_(psh, id);
      if (!r) {
        const x = []; for (let i = 0; i < PT_N_; i++) x.push('');
        x[P_.ID] = id; x[P_.NAME] = txt_(d.name); x[P_.DOB] = validDay_(d.dob) ? d.dob : ''; x[P_.START] = validDay_(d.start) ? d.start : ''; x[P_.STATUS] = 'admission';
        x[P_.SHARED] = shared; ptSetForm_(x, form); x[P_.CREATED] = now; x[P_.UPDATED] = now; x[P_.BY] = who; x[P_.PURGED] = false; x[P_.VER] = 1;
        psh.appendRow(x); return out_({ ok: true, id: id, ver: 1 });
      }
      const x = ptGetRow_(psh, r), ver = Number(x[P_.VER] || 0);
      if (x[P_.STATUS] === 'discharged') return out_({ ok: false, error: 'discharged' });
      // Refuse a save made from an out-of-date copy, so one device can never silently erase another's work.
      if (d.ver === null || d.ver === undefined || Number(d.ver) !== ver) return out_({ ok: false, error: 'conflict', ver: ver, updatedBy: x[P_.BY], updatedAt: String(x[P_.UPDATED] || '') });
      x[P_.NAME] = txt_(d.name); if (validDay_(d.dob)) x[P_.DOB] = d.dob; if (validDay_(d.start)) x[P_.START] = d.start;
      x[P_.SHARED] = shared; ptSetForm_(x, form); x[P_.UPDATED] = now; x[P_.BY] = who; x[P_.VER] = ver + 1;
      psh.getRange(r, 1, 1, PT_N_).setValues([x]);
      return out_({ ok: true, id: id, ver: ver + 1 });
    });
  }
  if (act === 'ptStatus') {
    return withLock_(function () {
      const r = ptRow_(psh, keyOf_(d.id)); if (!r) return out_({ ok: false, error: 'not found' });
      const x = ptGetRow_(psh, r);
      if (d.to === 'active' && x[P_.STATUS] === 'admission') { x[P_.STATUS] = 'active'; x[P_.SUBMITTED] = today_(); }
      else if (d.to === 'reopen' && x[P_.STATUS] === 'discharged') {
        if (!hasRole_(u, ['admin'])) return out_({ ok: false, error: 'Only an admin can reopen a discharged patient.' });
        if (isTrue_(x[P_.PURGED])) return out_({ ok: false, error: 'This record was already erased after discharge. Start a new admission instead.' });
        x[P_.STATUS] = 'active'; x[P_.DISCHARGED] = ''; x[P_.DCFILED] = '';
      } else return out_({ ok: false, error: 'not allowed' });
      x[P_.UPDATED] = new Date().toISOString(); x[P_.BY] = who; x[P_.VER] = Number(x[P_.VER] || 0) + 1;
      psh.getRange(r, 1, 1, PT_N_).setValues([x]);
      return out_({ ok: true, status: x[P_.STATUS] });
    });
  }
  if (act === 'aideWeeks') {
    const users = usersAll_(), a = users[String(d.email || '').toLowerCase()]; if (!a) return out_({ ok: false, error: 'no such aide' });
    const L = load_(), s = aideSummary_(a, L), from = validDay_(d.from) ? d.from : (s.lastEval || s.firstCase || addDays_(today_(), -90));
    return out_({ ok: true, aide: s, rows: aideFacts_(a, from, today_(), L).rows, from: from });
  }
  if (act === 'reports') {
    const v = repSheet_().getDataRange().getValues(), res = [];
    for (let i = v.length - 1; i >= 1; i--) {
      if (d.patientId && v[i][2] !== d.patientId) continue;
      if (d.aideEmail && String(v[i][3]).toLowerCase() !== String(d.aideEmail).toLowerCase()) continue;
      if (d.kind && v[i][1] !== d.kind) continue;
      res.push({ id: v[i][0], kind: v[i][1], title: v[i][4], date: iso_(v[i][5]), url: v[i][6], by: v[i][7], data: String(v[i][9] || '').slice(0, 4000) });
      if (res.length >= 60) break;
    }
    return out_({ ok: true, reports: res });
  }
  if (act === 'draftSave' || act === 'draftGet' || act === 'draftDelete') {
    if (['pn', 'ra', 'dc', 'chha'].indexOf(String(d.kind)) < 0) return out_({ ok: false, error: 'bad kind' });
    const id = draftId_(d); if (id.slice(-1) === '|') return out_({ ok: false, error: 'missing subject' });
    const dsh = draftSheet_();
    if (act === 'draftGet') { const r = findRow_(dsh, 0, id); if (!r) return out_({ ok: true, draft: null }); const x = dsh.getRange(r, 1, 1, 7).getValues()[0]; let data = {}; try { data = JSON.parse(x[4] || '{}'); } catch (e) {} return out_({ ok: true, draft: { data: data, updatedAt: String(x[5] || ''), by: x[6] } }); }
    if (act === 'draftDelete') return withLock_(function () { const r = findRow_(dsh, 0, id); if (r) dsh.deleteRow(r); return out_({ ok: true }); });
    if (d.kind === 'chha') { if (!usersAll_()[String(d.aideEmail || '').toLowerCase()]) return out_({ ok: false, error: 'no such aide' }); }
    else { const pr = ptRow_(psh, keyOf_(d.patientId)); if (!pr) return out_({ ok: false, error: 'no such patient' }); if (psh.getRange(pr, P_.STATUS + 1).getValue() === 'discharged') return out_({ ok: false, error: 'discharged' }); }
    const json = JSON.stringify({ f: stripSensitive_((d.data || {}).f), r: (d.data || {}).r || {} });
    if (json.length > CELL_MAX_) return out_({ ok: false, error: 'draft too large' });
    return withLock_(function () {
      const r = findRow_(dsh, 0, id);
      const row = [id, d.kind, d.kind === 'chha' ? '' : keyOf_(d.patientId), d.kind === 'chha' ? String(d.aideEmail).toLowerCase() : '', json, new Date().toISOString(), who];
      if (r) dsh.getRange(r, 1, 1, 7).setValues([row]); else dsh.appendRow(row);
      return out_({ ok: true });
    });
  }
  if (act === 'reportSave') return once_(d, function () { return reportSave_(d, u); });
  return out_({ ok: false, error: 'unknown action' });
}

// ── Shared PDF style (same look as the printed packet) ──
// Header (agency name, then name/date on a rule) and the purple banner, as a table so Google's PDF converter handles it.
// kind: 'patient' (Patient name, DOB, Date) | 'staff' (Applicant name, Date) | 'office' (agency name only).
function pdfHdr_(title, kind, o) {
  o = o || {};
  const u = function (v, w) { return v ? '<u>&nbsp;' + esc_(v) + '&nbsp;</u>' : '<span style="display:inline-block;border-bottom:1px solid #444;width:' + w + 'px">&nbsp;</span>'; };
  const right = kind === 'patient' ? 'Patient name: ' + u(o.name, 130) + (o.dob !== undefined ? ' &nbsp; DOB: ' + u(o.dob, 70) : '') + ' &nbsp; Date: ' + u(o.date, 70)
    : kind === 'staff' ? esc_(o.label || 'Applicant name') + ': ' + u(o.name, 150) + ' &nbsp; Date: ' + u(o.date, 70) : '';
  return '<table style="width:100%;border-collapse:collapse;border-bottom:2px solid #34182d;margin:0 0 8px"><tr><td style="font-size:12px;font-weight:bold;color:#34182d;padding:0 0 5px;border:0">Comfort Hands Home Healthcare, LLC</td>' +
    '<td style="text-align:right;font-size:9.5px;color:#444;padding:0 0 5px;border:0">' + right + '</td></tr></table>' +
    '<div style="background:#34182d;color:#fff;padding:9px 12px;margin:0 0 10px"><div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;color:#e6c8f2">' +
    (kind === 'patient' ? 'Patient document' : kind === 'staff' ? 'Staff document' : 'Document') + '</div><div style="font-size:17px;font-weight:bold;margin-top:2px">' + esc_(title) + '</div></div>';
}
const PDF_CSS_ = 'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5px;line-height:1.42;color:#111}' +
  'h2{font-size:14px;margin:8px 0 5px;color:#34182d}h3{font-size:11px;margin:10px 0 4px;padding:3px 6px;background:#f3e6f7;color:#34182d}' +
  '.psl{color:#555;font-weight:bold;font-size:9px}.psv{margin-bottom:6px}ul,ol{padding-left:18px}p{margin:0 0 7px}table{border-collapse:collapse}';
function usdate_(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : String(v || ''); }
function repHtml_(title, sub, body, kind, label) {
  const css = 'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#111;line-height:1.42}h1{font-size:17px;margin:0;color:#34182d}h2{font-size:14px;margin:8px 0;text-align:center}' +
    'h3{font-size:11px;margin:10px 0 4px;padding:3px 6px;background:#f3e6f7;color:#34182d}table{width:100%;border-collapse:collapse}' +
    'table.g td,table.g th{border:1px solid #888;padding:4px 5px;vertical-align:top;font-size:10px}table.g th{background:#eee;text-align:left}' +
    '.c{text-align:center}.ln{border-bottom:1px solid #444;display:inline-block;min-width:120px}.cb{font-family:Courier New,monospace;font-weight:bold}' +
    '.sig img{height:60px}.k{font-size:8.5px;color:#555;text-transform:uppercase;font-weight:bold}.box{border:1px solid #888;padding:5px 7px;margin:4px 0;white-space:pre-wrap;min-height:56px}table.sig{width:100%;table-layout:fixed}table.sig td{vertical-align:top;padding-right:14px}';
  const bits = String(sub || '').split(' \u00b7 '), head = pdfHdr_(title, kind || 'staff', { name: bits[0], date: usdate_(bits[bits.length - 1]), label: label });
  // The heading sits in a table header group so it repeats at the top of every page.
  return '<html><head><meta charset="utf-8"><style>' + css + '</style></head><body><table style="width:100%;border-collapse:collapse"><thead style="display:table-header-group"><tr><td style="padding:0;border:0">' + head + '</td></tr></thead><tbody><tr><td style="padding:0;border:0">' + safeHtml_(body) + '</td></tr></tbody></table></body></html>';
}

function reportSave_(d, u) {
  const kind = String(d.kind || ''); if (['pn', 'ra', 'dc', 'chha'].indexOf(kind) < 0) return { ok: false, error: 'bad kind' };
  if (!d.html || String(d.html).length > 1500000) return { ok: false, error: 'bad report' };
  const day = String(d.date || ''); if (!validDay_(day)) return { ok: false, error: 'Enter a valid date.' };
  if (daysUntil_(day) > 1) return { ok: false, error: 'The date is in the future.' };
  const who = u.name || u.email, psh = ptSheet_(), root = DriveApp.getFolderById(id_(CONFIG.DRIVE_FOLDER_ID));
  let fname, folder, pid = '', aideEmail = '', sub, label;
  if (kind === 'chha') {
    aideEmail = String(d.aideEmail || '').toLowerCase(); const a = usersAll_()[aideEmail]; if (!a) return { ok: false, error: 'no such aide' };
    label = 'CHHA Performance Evaluation'; folder = folderByName_(root, 'Staff - ' + clean_(a.name)); fname = label + ' - ' + clean_(a.name) + ' - ' + day + '.pdf'; sub = a.name;
  } else {
    pid = keyOf_(d.patientId); const r = ptRow_(psh, pid); if (!r) return { ok: false, error: 'no such patient' };
    const x = ptGetRow_(psh, r), st = String(x[P_.STATUS] || 'admission');
    if (st === 'discharged') return { ok: false, error: 'This patient is already discharged.' };
    if ((kind === 'pn' || kind === 'ra') && st !== 'active') return { ok: false, error: 'The admission is not finished yet. Mark the patient active first.' };
    sub = String(x[P_.NAME]); const fn = nameFolder_(sub);
    folder = ptFolder_(pid, fn);
    label = kind === 'pn' ? 'Supplemental Progress Note' : kind === 'ra' ? (String((d.data || {}).type) === 'Post-Hospitalization' ? 'Post-Hospitalization Re-Assessment' : '60-Day Re-Assessment') : 'Discharge-Transfer Summary';
    fname = label + ' - ' + fn + ' - ' + day + '.pdf';
  }
  // PDF and Drive work happen before the lock is taken.
  const pdf = Utilities.newBlob(repHtml_(label, sub + ' · ' + day, d.html, kind === 'chha' ? 'staff' : 'patient', kind === 'chha' ? 'Aide name' : ''), 'text/html', 'r.html').getAs('application/pdf').setName(fname);
  const file = folder.createFile(pdf), now = new Date().toISOString();
  withLock_(function () {
    repSheet_().appendRow([Utilities.getUuid(), kind, pid, aideEmail, label, day, file.getUrl(), who, now, JSON.stringify(stripSensitive_(d.data || {})).slice(0, 4000)]);
    const dsh = draftSheet_();
    // Only the 60-day Re-Assessment resets the 60-day clock. The supplemental progress note and a post-hospitalization re-assessment do not.
    if (kind === 'ra' && String((d.data || {}).type) !== 'Post-Hospitalization') psh.getRange(ptRow_(psh, pid), P_.LASTNOTE + 1).setValue(day);
    if (kind === 'dc') {
      const r = ptRow_(psh, pid); psh.getRange(r, P_.STATUS + 1).setValue('discharged'); psh.getRange(r, P_.DISCHARGED + 1).setValue(day); psh.getRange(r, P_.DCFILED + 1).setValue(today_());
      const plans = carePlanTab_(), pr = findRow_(plans, 0, pid); if (pr) plans.getRange(pr, 6).setValue(false); // aides stop seeing the sheet
      delRows_(dsh, function (row) { return row[2] === pid; }); // every unfinished draft for this patient
    }
    if (kind === 'chha') {
      const rec = aideTab_(), r = findRowCI_(rec, aideEmail), fc = validDay_(d.firstCase) ? d.firstCase : '';
      const row = [aideEmail, fc || (r ? iso_(rec.getRange(r, 2).getValue()) : ''), day, String(d.evalType || '').slice(0, 40), now, txt_(userName_(aideEmail))];
      if (r) rec.getRange(r, 1, 1, 6).setValues([row]); else rec.appendRow(row);
    }
    const dr = findRow_(dsh, 0, draftId_({ kind: kind, patientId: pid, aideEmail: aideEmail })); if (dr) dsh.deleteRow(dr);
  });
  try {
    MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: label + ' filed — ' + sub, attachments: [pdf],
      body: label + ' for ' + sub + ' (' + day + ') was filed by ' + who + '.\nSaved to Drive: ' + file.getUrl() + '\n\nThis message contains protected health information.' });
  } catch (e) { console.error('report email failed: ' + e); }
  return { ok: true, url: file.getUrl() };
}

function ptMarkActive_(id) {
  id = keyOf_(id); if (!id) return;
  const sh = ptSheet_(), r = ptRow_(sh, id); if (!r) return;
  if (sh.getRange(r, P_.STATUS + 1).getValue() === 'admission') { sh.getRange(r, P_.STATUS + 1).setValue('active'); sh.getRange(r, P_.SUBMITTED + 1).setValue(today_()); }
}

// ── Weekly digest (Mondays 8 am) + daily purge. Run installDueReminders() once. ──
function installDueReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (['dueDigest', 'purgeOld'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dueDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  ScriptApp.newTrigger('purgeOld').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Installed: Monday 8 am due-date digest and a daily 3 am purge (script time zone ' + Session.getScriptTimeZone() + ').');
}
function dueDigest() {
  const h = home_(), lines = [];
  h.patients.forEach(function (p) { if (p.daysToNote !== null && p.daysToNote <= REC_.WARN_DAYS) lines.push('60-day re-assessment ' + (p.daysToNote < 0 ? 'OVERDUE ' + (-p.daysToNote) + ' days' : 'due in ' + p.daysToNote + ' days') + ': ' + p.name); });
  h.aides.forEach(function (a) { if (a.daysToEval !== null && a.daysToEval <= REC_.WARN_DAYS) lines.push('Aide evaluation ' + (a.daysToEval < 0 ? 'OVERDUE ' + (-a.daysToEval) + ' days' : 'due in ' + a.daysToEval + ' days') + ': ' + a.name); });
  onbAll_().forEach(function (o) { if (o.status === 'in progress' && !(o.app && o.app._imported) && o.createdAt && (Date.now() - new Date(o.createdAt).getTime()) > 7 * 86400000) lines.push('New hire still onboarding: ' + o.name + ' (' + o.done + '/' + o.total + ' steps; next: ' + o.next + ')'); });
  h.aides.forEach(function (a) { a.trk.items.forEach(function (i) { if (i.status === 'over') lines.push('Aide ' + i.label + ' OVERDUE ' + (-i.days) + ' days: ' + a.name); else if (i.status === 'soon') lines.push('Aide ' + i.label + (i.k === 'cert' ? ' expires in ' : ' due in ') + i.days + ' days' + (i.k === 'cert' ? ' (renewal window open)' : '') + ': ' + a.name); else if (i.status === 'unset') lines.push('Aide ' + i.label + ' date not entered: ' + a.name); }); });
  h.patients.forEach(function (p) { if (p.status === 'discharged' || p.purged) return; const q = p.pca; if (q.pcaStatus === 'awaiting insurer' && q.pcaSent && (Date.now() - new Date(q.pcaSent + 'T12:00:00').getTime()) > 14 * 86400000) lines.push('PCA request sent ' + q.pcaSent + ', no insurer answer recorded: ' + p.name); if (q.daysToPca !== null && q.pcaStatus !== 'renewal sent' && q.daysToPca <= REC_.PCA_WARN_DAYS) lines.push('PCA authorization ' + (q.daysToPca < 0 ? 'EXPIRED ' + (-q.daysToPca) + ' days ago' : 'ends in ' + q.daysToPca + ' days') + ', renewal not yet sent: ' + p.name); if (p.status === 'active' && q.pcaStatus === 'none') lines.push('No PCA authorization on file: ' + p.name); });
  h.patients.forEach(function (p) { if (p.status === 'admission') lines.push('Admission still in progress: ' + p.name); });
  h.drafts.forEach(function (x) { if (x.updatedAt && (Date.now() - new Date(x.updatedAt).getTime()) > 3 * 86400000) lines.push('Draft not finished (' + x.label + '): ' + x.subject); });
  try { officeSummaryText_(h); } catch (e) {}
  if (!lines.length) return;
  MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: 'Comfort Hands: pending nurse tasks', body: lines.join('\n') + '\n\nOpen the staff portal home screen for details. This email lists names only, with no clinical details.' });
}
// 30 days after a discharge is FILED, everything about that patient is erased from the Sheet: the admission data, the text kept
// with filed reports, unfinished drafts, the care plan and the aides' weekly sheets. The PDFs in Drive are kept. The patient's
// name, date of birth and dates stay as an index so the filed PDFs can still be found.
function purgeOld() {
  try { refreshNames_(); } catch (e) {}
  withLock_(function () {
    const psh = ptSheet_(), v = psh.getDataRange().getValues(), cutoff = addDays_(today_(), -REC_.PURGE_DAYS), gone = {}, rows = [];
    for (let i = 1; i < v.length; i++) {
      if (v[i][P_.STATUS] !== 'discharged' || isTrue_(v[i][P_.PURGED])) continue;
      const base = iso_(v[i][P_.DCFILED]) || iso_(v[i][P_.DISCHARGED]);
      if (base && base <= cutoff) { gone[v[i][P_.ID]] = true; rows.push(i + 1); }
    }
    if (!rows.length) return;
    // keep each aide's first-case date (not patient information) before the weekly sheets are erased
    const L = load_(), users = usersAll_(), rec = aideTab_(), now = new Date().toISOString();
    Object.keys(users).forEach(function (e) {
      if (users[e].roles.indexOf('aide') < 0) return;
      const fc = aideFacts_(users[e], '', '', L).firstCase; if (!fc) return;
      const r = findRowCI_(rec, e);
      if (!r) rec.appendRow([e, fc, '', '', now, txt_(userName_(e))]); else if (!rec.getRange(r, 2).getValue()) rec.getRange(r, 2).setValue(fc);
    });
    rows.forEach(function (r) {
      psh.getRange(r, P_.SHARED + 1, 1, 2).setValues([['', '']]); psh.getRange(r, P_.FORM2 + 1, 1, 2).setValues([['', '']]); psh.getRange(r, P_.PURGED + 1).setValue(true);
    });
    const ss = db_();
    delRows_(draftSheet_(), function (row) { return gone[row[2]]; });
    delRows_(ss.getSheetByName('Weeks'), function (row) { return gone[row[1]]; });
    delRows_(carePlanTab_(), function (row) { return gone[row[0]]; });
    delRows_(pcaTab_(), function (row) { return gone[row[1]]; });
    const rsh = repSheet_(), rv = rsh.getDataRange().getValues();
    for (let i = 1; i < rv.length; i++) if (gone[rv[i][2]] && rv[i][9]) rsh.getRange(i + 1, 10).setValue('');
  });
}

/**
 * ONE-TIME: bring existing patients into the portal. In the restricted Sheet open the "Import" tab (run this once to create it),
 * type one patient per row (first, last, dob, startOfCare, lastNote; dates as yyyy-mm-dd), then select importPatients and Run.
 * Patients are added as ACTIVE. The 60-day note is counted from lastNote (or startOfCare if blank). Rows already imported are skipped.
 * Aides see a patient's activity sheet after the nurse publishes that patient's care plan in the portal.
 */
function importPatients() {
  const ss = db_(); let imp = ss.getSheetByName('Import');
  if (!imp) { imp = ss.insertSheet('Import'); imp.appendRow(['first', 'last', 'dob', 'startOfCare', 'lastNote']); Logger.log('Created the "Import" tab. Fill it in (dates as yyyy-mm-dd), then run importPatients again.'); return; }
  const v = imp.getDataRange().getValues(), psh = ptSheet_(); let added = 0; const skipped = [];
  withLock_(function () {
    for (let i = 1; i < v.length; i++) {
      const first = String(v[i][0] || '').trim(), last = String(v[i][1] || '').trim(); if (!first && !last) continue;
      const dob = iso_(v[i][2]), start = iso_(v[i][3]), note = iso_(v[i][4]);
      if (!first || !last || !validDay_(dob)) { skipped.push('row ' + (i + 1) + ': needs first, last and a valid dob'); continue; }
      if (start && !validDay_(start)) { skipped.push('row ' + (i + 1) + ': bad startOfCare'); continue; }
      if (note && !validDay_(note)) { skipped.push('row ' + (i + 1) + ': bad lastNote'); continue; }
      const id = keyOf_([last, first, dob].join('_').toLowerCase().replace(/[^a-z0-9_-]/g, ''));
      if (ptRow_(psh, id)) { skipped.push('row ' + (i + 1) + ': ' + first + ' ' + last + ' already exists'); continue; }
      const now = new Date().toISOString(), x = []; for (let k = 0; k < PT_N_; k++) x.push('');
      x[P_.ID] = id; x[P_.NAME] = txt_(first + ' ' + last); x[P_.DOB] = dob; x[P_.START] = start; x[P_.STATUS] = 'active';
      x[P_.SHARED] = JSON.stringify({ firstName: first, lastName: last, dob: dob }); x[P_.FORM] = '{}'; x[P_.CREATED] = now; x[P_.UPDATED] = now; x[P_.BY] = 'import';
      x[P_.LASTNOTE] = note; x[P_.PURGED] = false; x[P_.SUBMITTED] = start || today_(); x[P_.VER] = 1;
      psh.appendRow(safeRow_(x)); added++;
    }
  });
  Logger.log('Imported ' + added + ' patient(s).' + (skipped.length ? ' Skipped: ' + skipped.join('; ') : ''));
}

/**
 * BULK PATIENT UPDATE. Fills in member ID, insurance company, address, phone, ICD-10 and first day of service for patients that are already in the portal
 * (or adds new ones when a date of birth is given).
 *   1. Make a tab named "PatientUpdate" (run previewPatientUpdate once and it creates it for you) and paste your list in, with a header row.
 *      Headers it understands (any order, capital letters do not matter): Member ID, Insurance company, First Day of Service, Admission ID, First Name, Last Name,
 *      ICD-10, Address1, Address2, City, County, Home Phone, State, Zip, DOB, Medicaid #. Only First Name and Last Name are required.
 *   2. Run previewPatientUpdate: it changes nothing and lists what it would do (View > Logs).
 *   3. Run updatePatients to apply it. A "Result" column is added on the tab, one line per row.
 * A patient is found by first + last name (and DOB when you give one). A blank cell never erases what is already saved. Run it again any time.
 */
function previewPatientUpdate() { patientUpdate_(true); }
function updatePatients() { patientUpdate_(false); }

function patientUpdate_(dry) {
  const ss = db_(); let imp = ss.getSheetByName('PatientUpdate');
  if (!imp) { imp = ss.insertSheet('PatientUpdate'); imp.appendRow(['Member ID', 'Insurance company', 'First Day of Service', 'Admission ID', 'First Name', 'ICD-10', 'Last Name', 'Address1', 'Address2', 'City', 'County', 'Home Phone', 'State', 'Zip', 'DOB']); Logger.log('Created the "PatientUpdate" tab. Paste your list in under the headers, then run previewPatientUpdate again.'); return; }
  const v = imp.getDataRange().getValues(); if (v.length < 2) { Logger.log('The PatientUpdate tab has no rows.'); return; }
  const norm = function (h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };
  const ALIAS = { memberid: 'memberId', insuranceid: 'memberId', insurancecompany: 'ins', insurance: 'ins', mco: 'ins', firstdayofservice: 'start', startofcare: 'start', admissionid: 'admId', firstname: 'first', lastname: 'last',
    icd10: 'icd', icd: 'icd', address1: 'addr1', address: 'addr1', address2: 'addr2', city: 'city', county: 'county', homephone: 'phone', phone: 'phone', cell: 'phone', state: 'state', zip: 'zip', zipcode: 'zip', postalcode: 'zip',
    dob: 'dob', dateofbirth: 'dob', medicaid: 'medicaid', medicaidnumber: 'medicaid', medicaidid: 'medicaid' };
  const col = {}; let resCol = -1;
  v[0].forEach(function (h, i) { const k = ALIAS[norm(h)]; if (k && col[k] === undefined) col[k] = i; if (norm(h) === 'result') resCol = i; });
  if (col.first === undefined || col.last === undefined) { Logger.log('The first row must have headers named "First Name" and "Last Name".'); return; }
  const get = function (row, k) { return col[k] === undefined ? '' : (row[col[k]] instanceof Date ? row[col[k]] : String(row[col[k]] == null ? '' : row[col[k]]).trim()); };
  const letters = function (s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); };
  const title = function (s) { s = String(s || '').trim(); return s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); }) : s; };
  const phoneFmt = function (s) { const d = String(s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1'); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(s || '').trim(); };
  const dayIn = function (x) {
    if (!x) return ''; if (x instanceof Date) return iso_(x);
    const t = String(x).trim(), m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
  };
  const insMap = function (s) {
    s = String(s || '').toLowerCase(); if (!s) return '';
    if (/horizon/.test(s)) return 'Horizon'; if (/united|uhc/.test(s)) return 'UnitedHealthcare'; if (/aetna/.test(s)) return 'Aetna';
    if (/wellpoint|amerigroup/.test(s)) return 'Wellpoint'; if (/health\s*partners/.test(s)) return 'HealthPartners'; return null;
  };
  const psh = ptSheet_(), pv = psh.getDataRange().getValues(), byName = {};
  for (let i = 1; i < pv.length; i++) if (pv[i][P_.ID]) { const k = letters(String(pv[i][P_.NAME]).split(/\s+/)[0]) + '|' + letters(String(pv[i][P_.NAME]).split(/\s+/).slice(-1)[0]); (byName[k] = byName[k] || []).push(i + 1); }
  const results = [], tally = { updated: 0, added: 0, unchanged: 0, skipped: 0 }; const seen = {};
  const doRows = function () {
    for (let i = 1; i < v.length; i++) {
      const row = v[i], first = String(get(row, 'first')), last = String(get(row, 'last')); let msg = '';
      if (!first && !last) { results.push(''); continue; }
      try {
        const dobIn = dayIn(get(row, 'dob')), key = letters(first) + '|' + letters(last); let rows = (byName[key] || []).slice();
        const dupNote = seen[key + '|' + dobIn] ? ' [This patient is on more than one row; later rows overwrite earlier ones.]' : ''; seen[key + '|' + dobIn] = true;
        if (rows.length > 1 && dobIn) rows = rows.filter(function (r) { return iso_(pv[r - 1][P_.DOB]) === dobIn; });
        if (rows.length > 1) { msg = 'SKIPPED: more than one patient named ' + first + ' ' + last + '. Add a DOB column.'; tally.skipped++; results.push(msg); continue; }
        let x, r = rows[0], isNew = false;
        if (!r) {
          if (!validDay_(dobIn)) { msg = 'SKIPPED: not in the portal yet. Add a DOB (yyyy-mm-dd or m/d/yyyy) to add them.'; tally.skipped++; results.push(msg); continue; }
          x = []; for (let k = 0; k < PT_N_; k++) x.push(''); isNew = true;
          const id = keyOf_([last, first, dobIn].join('_').toLowerCase().replace(/[^a-z0-9_-]/g, ''));
          x[P_.ID] = id; x[P_.NAME] = txt_(first + ' ' + last); x[P_.DOB] = dobIn; x[P_.STATUS] = 'active'; x[P_.CREATED] = new Date().toISOString(); x[P_.PURGED] = false; x[P_.SUBMITTED] = today_(); x[P_.VER] = 0;
          x[P_.SHARED] = JSON.stringify({ firstName: first, lastName: last, dob: dobIn }); x[P_.FORM] = '{}';
        } else { x = ptGetRow_(psh, r); if (isTrue_(x[P_.PURGED])) { msg = 'SKIPPED: this patient record was purged.'; tally.skipped++; results.push(msg); continue; } }
        const b = ptBlob_(x), sh = b.shared, fm = b.form, changed = [], warn = [];
        const setS = function (k, val, label) { val = String(val || '').trim(); if (val && String(sh[k] || '') !== val) { sh[k] = val; changed.push(label); } };
        const setF = function (k, val, label, sec) { val = String(val || '').trim(); if (val && String((fm[k] || {}).v || '') !== val) { fm[k] = { s: (fm[k] || {}).s || sec, l: (fm[k] || {}).l || label, v: val }; changed.push(label); } };
        const a1 = String(get(row, 'addr1')), a2 = String(get(row, 'addr2'));
        setS('address', [a1, a2].filter(Boolean).join(' '), 'address');
        setS('city', title(get(row, 'city')), 'city'); setS('state', String(get(row, 'state')).toUpperCase(), 'state'); setS('zip', get(row, 'zip'), 'zip');
        setS('cell', phoneFmt(get(row, 'phone')), 'phone'); setS('icd1', get(row, 'icd'), 'ICD-10');
        const insRaw = String(get(row, 'ins')), ins = insMap(insRaw); if (ins === null) warn.push('insurance "' + insRaw + '" not recognised'); else setS('insCompany', ins, 'insurance');
        setF('insNum', String(get(row, 'memberId')), 'Member ID / Insurance #', 'Insurance'); setF('medicaidNum', String(get(row, 'medicaid')), 'Medicaid #', 'Insurance');
        setF('county', title(get(row, 'county')), 'County', 'Patient Information');
        const adm = String(get(row, 'admId')); if (adm && String(sh.admissionId || '') !== adm) { sh.admissionId = adm; changed.push('admission ID'); }
        const soc = dayIn(get(row, 'start'));
        if (soc) { if (iso_(x[P_.START]) !== soc) { x[P_.START] = soc; changed.push('first day of service'); } setF('socDate', soc, 'Start of Care Date', 'Start of care'); }
        if (!changed.length) { tally.unchanged++; results.push('No change' + (warn.length ? ' (' + warn.join('; ') + ')' : '') + dupNote); continue; }
        msg = (isNew ? 'ADDED' : 'Updated') + ': ' + changed.join(', ') + (warn.length ? ' (' + warn.join('; ') + ')' : '') + dupNote;
        if (!dry) {
          x[P_.SHARED] = JSON.stringify(sh); ptSetForm_(x, JSON.stringify(fm));
          x[P_.UPDATED] = new Date().toISOString(); x[P_.BY] = 'import'; x[P_.VER] = Number(x[P_.VER] || 0) + 1;
          if (isNew) { psh.appendRow(safeRow_(x)); } else { psh.getRange(r, 1, 1, PT_N_).setValues([safeRow_(x)]); }
        }
        if (isNew) tally.added++; else tally.updated++; results.push(msg);
      } catch (e) { msg = 'ERROR: ' + e.message; tally.skipped++; results.push(msg); }
    }
  };
  if (dry) doRows(); else withLock_(function () { doRows(); });
  results.forEach(function (m, i) { if (m) Logger.log('row ' + (i + 2) + ' ' + get(v[i + 1], 'first') + ' ' + get(v[i + 1], 'last') + ': ' + m); });
  if (!dry) {
    const rc = resCol >= 0 ? resCol + 1 : v[0].length + 1; if (resCol < 0) imp.getRange(1, rc).setValue('Result');
    imp.getRange(2, rc, results.length, 1).setValues(results.map(function (m) { return [m]; }));
  }
  Logger.log((dry ? 'PREVIEW (nothing was changed). ' : 'Done. ') + tally.updated + ' updated, ' + tally.added + ' added, ' + tally.unchanged + ' already up to date, ' + tally.skipped + ' skipped.' + (dry ? ' Run updatePatients to apply.' : ''));
}

/**
 * ONE-TIME: load the compliance dates for your existing aides. Run it once to create the "AideImport" tab, fill one aide per row
 * (email, position, hireDate, certExpiry, bgLast, physLast, ceuDoneAt, phone, smsOk; dates yyyy-mm-dd; smsOk yes/no), then run it again.
 * The aide must already have an aide login (Users tab). Rows already imported are updated, never duplicated.
 */
function importAides() {
  const ss = db_(); let imp = ss.getSheetByName('AideImport');
  if (!imp) { imp = ss.insertSheet('AideImport'); imp.appendRow(['email', 'position', 'hireDate', 'certExpiry', 'bgLast', 'physLast', 'ceuDoneAt', 'phone', 'smsOk']); Logger.log('Created the "AideImport" tab. Fill it in (dates as yyyy-mm-dd), then run importAides again.'); return; }
  const v = imp.getDataRange().getValues(), users = usersAll_(); let n = 0; const bad = [];
  withLock_(function () {
    for (let i = 1; i < v.length; i++) {
      const email = String(v[i][0] || '').trim().toLowerCase(); if (!email) continue;
      const pos = String(v[i][1] || '').trim(), dts = [2, 3, 4, 5, 6].map(function (j) { return iso_(v[i][j]); });
      if (!users[email] || users[email].roles.indexOf('aide') < 0) { bad.push('row ' + (i + 1) + ': no aide login for ' + email); continue; }
      if (pos && HR_POSITIONS_.indexOf(pos) < 0) { bad.push('row ' + (i + 1) + ': position must be one of ' + HR_POSITIONS_.join(' | ')); continue; }
      if (!dts.every(function (x) { return !x || validDay_(x); })) { bad.push('row ' + (i + 1) + ': dates must be yyyy-mm-dd'); continue; }
      trkUpsert_(email, { position: pos, hireDate: dts[0], certExpiry: dts[1], bgLast: dts[2], physLast: dts[3], ceuDoneAt: dts[4], phone: String(v[i][7] || '').replace(/[^\d+]/g, ''), smsOk: /^(y|yes|true|1)$/i.test(String(v[i][8] || '').trim()) }, 'import'); n++;
    }
  });
  Logger.log('Imported ' + n + ' aide(s).' + (bad.length ? ' Skipped:\n' + bad.join('\n') : ''));
}

// ═══════════════════════════ SHIFT REMINDERS AND TEXT MESSAGES ═══════════════════════════
// The office keeps a standing weekly schedule in the "Schedule" tab (one row per shift). Aides get a text shortly before a shift starts and when it ends.
// Texts never contain a patient's name or address. Reminders go only to active aides with a phone number and SMS consent (AideTrack tab).
// Until CONFIG.SMS is filled in and ENABLED is true, nothing is sent: each text that WOULD be sent is only recorded in the "TextLog" tab as dry-run.
const SCHED_DAYS_ = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];   // column order; JavaScript's getDay() is (index + 1) % 7
const SCHED_COLS_ = (function () { const c = ['aideEmail', 'aideName', 'patient']; SCHED_DAYS_.forEach(function (d) { c.push(d + ' start', d + ' finish'); }); c.push('active', 'skip'); return c; })();
const DAYNAMES_ = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function now_() { return new Date(); }
function schedTab_() {
  if (!TABS_['Schedule']) { const ex = db_().getSheetByName('Schedule'); if (ex) { try { schedMigrate_(ex); } catch (e) {} } }
  const fresh = !db_().getSheetByName('Schedule'), sh = tab_('Schedule', SCHED_COLS_);
  if (fresh) { try { schedFormat_(sh); schedNameFormula_(sh); } catch (e) {} }
  return sh;
}
// The first version of the tab had one row per shift with a "days" column. Rows in that layout are moved into the per-day layout.
function schedMigrate_(sh) {
  const v = sh.getDataRange().getValues(); if (!v.length || String(v[0][2]) !== 'days') return false;
  const out = [SCHED_COLS_.slice()];
  for (let i = 1; i < v.length; i++) {
    const r = v[i], row = SCHED_COLS_.map(function () { return ''; }); row[0] = r[0]; row[2] = r[1];
    const days = parseDays_(r[2]); if (days) days.forEach(function (wd) { const k = (wd + 6) % 7; row[3 + 2 * k] = r[3]; row[4 + 2 * k] = r[4]; });
    row[17] = r[5]; row[18] = r[6]; out.push(row);
  }
  try { schedFormat_(sh); } catch (e) {}
  sh.getRange(1, 1, out.length, SCHED_COLS_.length).setValues(out);
  try { schedNameFormula_(sh); } catch (e) {}
  return true;
}
function schedNameFormula_(sh) { sh.getRange('B2').setFormula('=ARRAYFORMULA(IF(A2:A="","",IFERROR(VLOOKUP(A2:A,Users!A:B,2,FALSE),"not found")))'); }
function schedFormat_(sh) {
  sh.setFrozenRows(1);
  sh.getRange('C2:Q1000').setNumberFormat('@'); sh.getRange('S2:S1000').setNumberFormat('@');
  sh.getRange('R2:R1000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['yes', 'no'], true).setAllowInvalid(true).build());
  const t = '=OR(D2="",REGEXMATCH(TO_TEXT(D2),"^\\s*\\d{1,2}:\\d{2}\\s*([AaPp][Mm])?\\s*$"))';
  sh.getRange('D2:Q1000').setDataValidation(SpreadsheetApp.newDataValidation().requireFormulaSatisfied(t).setAllowInvalid(false).setHelpText('Type a time like 9:00 AM or 14:30, or leave blank for no shift that day').build());
  sh.getRange('A1').setNote('The aide\'s sign-in email (must be an active aide). One row per aide per patient. For two shifts on one day, use two rows.');
  sh.getRange('B1').setNote('Filled in automatically from the Users tab. Do not type here.');
  sh.getRange('C1').setNote('For the office only. Never put in a text message.');
  sh.getRange('D1').setNote('Each day has a start and a finish. Leave both blank for no shift that day. A finish earlier than the start means an overnight shift.');
  sh.getRange('R1').setNote('yes (or blank) = send reminders. no = pause this row.');
  sh.getRange('S1').setNote('One-off dates with no shift, e.g. 2026-12-25, 12/31/2026. Applies to the whole row.');
}
function textLogTab_() {
  if (!TABS_['TextLog']) { const ex = db_().getSheetByName('TextLog'); if (ex) { try { const h = ex.getRange(1, 1, 1, 7).getValues()[0]; if (String(h[4]) === 'phoneEnd') { const v = ex.getDataRange().getValues(), nv = v.map(function (r, i) { const q = r.slice(); q.splice(4, 0, i ? '' : 'aideName'); return q; }); ex.getRange(1, 1, nv.length, 8).setValues(nv); } } catch (e) {} } }
  return tab_('TextLog', ['at', 'key', 'kind', 'email', 'aideName', 'phoneEnd', 'status', 'detail']);
}
function fmt12_(min) { const h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 === 0 ? 12 : h % 12; return h12 + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function parseTime_(v) {
  if (v instanceof Date) return v.getHours() * 60 + v.getMinutes();
  if (typeof v === 'number') return v >= 0 && v < 1 ? Math.round(v * 1440) : -1;
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/.exec(String(v == null ? '' : v)); if (!m) return -1;
  let h = Number(m[1]); const mi = Number(m[2]), ap = m[3] && m[3].toLowerCase(); if (mi > 59) return -1;
  if (ap) { if (h < 1 || h > 12) return -1; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; } else if (h > 23) return -1;
  return h * 60 + mi;
}
function dayIdx_(w) { if (w.length < 3) return -1; for (let i = 0; i < 7; i++) if (DAYNAMES_[i].indexOf(w) === 0) return i; return -1; }
function parseDays_(s) {
  s = String(s == null ? '' : s).toLowerCase().replace(/[–—]/g, '-'); const out = {};
  if (/^\s*(daily|every ?day)\s*$/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  const parts = s.split(/[,;\/\s]+/).filter(Boolean); if (!parts.length) return null;
  for (let k = 0; k < parts.length; k++) {
    const m = /^([a-z]+)(?:-([a-z]+))?$/.exec(parts[k]); if (!m) return null;
    const a = dayIdx_(m[1]); if (a < 0) return null;
    if (m[2]) { const b = dayIdx_(m[2]); if (b < 0) return null; for (let i = a; ; i = (i + 1) % 7) { out[i] = true; if (i === b) break; } } else out[a] = true;
  }
  return Object.keys(out).map(Number);
}
function parseSkip_(v) {
  const res = {}; if (v instanceof Date) { res[iso_(v)] = true; return res; }
  const parts = String(v == null ? '' : v).split(/[,;\s]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(parts[i]), y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else { m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(parts[i]); if (!m) return null; mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    const dt = new Date(y, mo - 1, d); if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    res[iso_(dt)] = true;
  }
  return res;
}
// Reads the Schedule tab. Returns the usable shifts and a list of rows that cannot be used (with the reason). No patient names in the reasons.
function schedRows_() {
  const v = schedTab_().getDataRange().getValues(), users = usersAll_(), trk = trkMap_(), shifts = [], bad = [];
  const blank = function (x) { return String(x == null ? '' : x).trim() === ''; };
  for (let i = 1; i < v.length; i++) {
    const r = v[i], email = String(r[0] || '').trim().toLowerCase(), row = i + 1;
    let any = !blank(r[2]); for (let c = 3; c <= 16; c++) if (!blank(r[c])) any = true;
    if (!email && !any) continue;
    const act = String(r[17] == null ? '' : r[17]).trim().toLowerCase(); if (act === 'no' || act === 'false' || act === 'n') continue;
    if (!email) { bad.push({ row: row, msg: 'no aide email' }); continue; }
    if (!users[email] || users[email].roles.indexOf('aide') < 0) { bad.push({ row: row, msg: 'no active aide with the email ' + email }); continue; }
    const days = []; let msg = '';
    for (let d = 0; d < 7; d++) {
      const a = r[3 + 2 * d], b = r[4 + 2 * d];
      if (blank(a) && blank(b)) continue;
      if (blank(a) || blank(b)) { msg = SCHED_DAYS_[d] + ' needs both a start and a finish'; break; }
      const st = parseTime_(a), en = parseTime_(b);
      if (st < 0 || en < 0) { msg = SCHED_DAYS_[d] + ' start or finish not understood (use e.g. 9:00 AM or 14:30)'; break; }
      if (st === en) { msg = SCHED_DAYS_[d] + ' start and finish are the same time'; break; }
      days.push({ wd: (d + 1) % 7, st: st, en: en });
    }
    if (msg) { bad.push({ row: row, msg: msg }); continue; }
    if (!days.length) { bad.push({ row: row, msg: 'no days filled in' }); continue; }
    const skip = parseSkip_(r[18]); if (!skip) { bad.push({ row: row, msg: 'skip dates not understood (use e.g. 2026-12-25)' }); continue; }
    const o = trk[email];
    if (!o || !o.phone) { bad.push({ row: row, msg: email + ' has no mobile phone on file, so no texts will be sent' }); continue; }
    if (!o.smsOk) { bad.push({ row: row, msg: email + ' has not agreed to text messages, so no texts will be sent' }); continue; }
    shifts.push({ row: row, email: email, days: days, skip: skip });
  }
  return { shifts: shifts, bad: bad };
}
// Every shift that begins on the given date (yyyy-mm-dd), with its real start and end times.
function occurrences_(shifts, dateIso) {
  const d0 = dparse_(dateIso), wd = d0.getDay(), out = [];
  shifts.forEach(function (s) {
    if (s.skip[dateIso]) return;
    s.days.forEach(function (dd) {
      if (dd.wd !== wd) return;
      const a = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, dd.st), b = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, dd.en + (dd.en < dd.st ? 1440 : 0));
      out.push({ shift: s, date: dateIso, start: a, end: b, st: dd.st, en: dd.en });
    });
  });
  return out;
}
// Reminders depend on the script's time zone. If it is not the agency's, send nothing and tell the office (once a day).
function tzOk_() {
  const want = CONFIG.TIMEZONE || 'America/New_York', have = Session.getScriptTimeZone();
  if (have === want) return true;
  const pr = PropertiesService.getScriptProperties(), day = iso_(new Date());
  if (pr.getProperty('tzWarnDay') !== day) { pr.setProperty('tzWarnDay', day); try { MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: 'Comfort Hands: text reminders are paused (time zone)', body: 'The Apps Script project time zone is ' + have + ' but ' + want + ' is required, so no reminder texts were sent. Open the script, Project Settings, and set the Time zone to ' + want + '.' }); } catch (e) {} }
  return false;
}
function smsCfg_() { return CONFIG.SMS || {}; }
function smsLive_() { const c = smsCfg_(); return !!(c.ENABLED && c.TWILIO_SID && c.TWILIO_TOKEN && c.FROM); }
function e164_(p) { p = String(p || '').replace(/[^\d+]/g, ''); if (/^\+\d{8,15}$/.test(p)) return p; const d = p.replace(/\D/g, ''); if (d.length === 10) return '+1' + d; if (d.length === 11 && d.charAt(0) === '1') return '+' + d; return ''; }
function smsIndex_() {
  const v = textLogTab_().getDataRange().getValues(), live = smsLive_(), m = {};
  for (let i = 1; i < v.length; i++) { if (String(v[i][6]) !== (live ? 'sent' : 'dry-run')) continue; const k = String(v[i][1]); const at = String(v[i][0]); if (!m[k] || at > m[k]) m[k] = at; }
  return m;
}
function smsLast_(idx, prefix) { let best = ''; Object.keys(idx).forEach(function (k) { if (k.indexOf(prefix) === 0 && idx[k] > best) best = idx[k]; }); return best; }
// Sends (or, in dry-run, only records) one text. Never throws. The log keeps the last 4 digits of the number and a status, never the message.
function sendSms_(to, body, key, kind, email, idx) {
  const num = e164_(to); if (!num) return 'no-number';
  const live = smsLive_(); if (idx && idx[key]) return 'already';
  let status = live ? 'sent' : 'dry-run', detail = '';
  if (live) {
    try {
      const c = smsCfg_(), payload = { To: num, Body: body }; if (/^MG/.test(c.FROM)) payload.MessagingServiceSid = c.FROM; else payload.From = c.FROM;
      const res = UrlFetchApp.fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(c.TWILIO_SID) + '/Messages.json',
        { method: 'post', payload: payload, headers: { Authorization: 'Basic ' + Utilities.base64Encode(c.TWILIO_SID + ':' + c.TWILIO_TOKEN) }, muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code < 200 || code >= 300) { status = 'failed'; let ec = ''; try { ec = String(JSON.parse(res.getContentText()).code || ''); } catch (e) {} detail = 'HTTP ' + code + (ec ? ' Twilio ' + ec : ''); }
    } catch (e) { status = 'failed'; detail = 'send error'; }
  }
  try { textLogTab_().appendRow([now_().toISOString(), txt_(key), kind, email || '', txt_(userName_(email)), num.slice(-4), status, detail]); } catch (e) {}
  if (idx && status !== 'failed') idx[key] = now_().toISOString();
  return status;
}
function clockLink_() { const u = smsCfg_().CLOCK_URL; return u ? ' ' + u : ''; }
function smsTail_() { return ' Reply STOP to opt out.'; }
// Shift reminders. Run every 5 minutes by installTextReminders(). Each reminder is sent once; a missed run is caught up within 20 minutes.
function shiftReminders() {
  if (!tzOk_()) return 0;
  const now = now_(), sched = schedRows_(), lead = Number(smsCfg_().LEAD_MIN) || 15, WIN = 20 * 60000, idx = smsIndex_(), trk = trkMap_();
  const today = iso_(now), yest = addDays_(today, -1);
  schedCheck_(sched);
  const occ = occurrences_(sched.shifts, yest).concat(occurrences_(sched.shifts, today)); let sent = 0;
  occ.forEach(function (o) {
    const ph = trk[o.shift.email].phone, inAt = o.start.getTime() - lead * 60000, outAt = o.end.getTime(), t = now.getTime();
    if (t >= inAt && t < inAt + WIN) { const s = sendSms_(ph, 'Comfort Hands: your shift starts at ' + fmt12_(o.st) + '. Please clock in when you arrive.' + clockLink_() + smsTail_(), 'in|' + o.date + '|' + o.shift.email + '|' + o.st, 'shift-in', o.shift.email, idx); if (s === 'sent' || s === 'dry-run') sent++; }
    if (t >= outAt && t < outAt + WIN) { const s = sendSms_(ph, 'Comfort Hands: your shift ends at ' + fmt12_(o.en) + '. Please clock out.' + clockLink_() + smsTail_(), 'out|' + o.date + '|' + o.shift.email + '|' + o.en, 'shift-out', o.shift.email, idx); if (s === 'sent' || s === 'dry-run') sent++; }
  });
  return sent;
}
// Once a day, email the office the Schedule rows that cannot be used.
function schedCheck_(sched) {
  const day = today_(), pr = PropertiesService.getScriptProperties();
  if (pr.getProperty('schedCheckDay') === day) return; pr.setProperty('schedCheckDay', day);
  if (!sched.bad.length) return;
  try { MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: 'Comfort Hands: Schedule rows that cannot be used', body: 'These rows in the Schedule tab are being skipped, so no reminders will go out for them:\n\n' + sched.bad.map(function (b) { return 'Row ' + b.row + ': ' + b.msg; }).join('\n') + '\n\nFix the rows in the Schedule tab. This check runs once a day.' }); } catch (e) {}
}
function checkSchedule() { const s = schedRows_(); Logger.log(s.shifts.length + ' usable shift row(s).' + (s.bad.length ? ' Problems:\n' + s.bad.map(function (b) { return 'Row ' + b.row + ': ' + b.msg; }).join('\n') : ' No problems found.')); return s; }
// Shows today's reminders without sending or recording anything.
function shiftPreview() {
  const s = schedRows_(), lead = Number(smsCfg_().LEAD_MIN) || 15, lines = [];
  occurrences_(s.shifts, today_()).forEach(function (o) { lines.push(fmt12_(Math.max(0, o.st - lead)) + ' clock-in reminder, ' + fmt12_(o.en) + ' clock-out reminder -> ' + o.shift.email); });
  Logger.log((lines.length ? lines.join('\n') : 'No shifts today.') + (s.bad.length ? '\nRows with problems: ' + s.bad.length : '') + '\nTexting is ' + (smsLive_() ? 'LIVE' : 'OFF (dry-run only)') + '.');
}
// Compliance texts to aides: at 60 days, at 30 days, on the due date, then weekly until it is recorded. Run daily at 9 am.
function complianceTexts() {
  if (!tzOk_()) return 0;
  const hr = now_().getHours(); if (hr < 6 || hr >= 21) return 0;
  const users = usersAll_(), idx = smsIndex_(), trk = trkMap_(), office = (CONFIG.AGENCY && CONFIG.AGENCY.phone) || 'the office'; let n = 0;
  Object.keys(users).forEach(function (email) {
    if (users[email].roles.indexOf('aide') < 0) return; const o = trk[email]; if (!o || !o.phone || !o.smsOk) return;
    trkItems_(o).forEach(function (i) {
      if (i.status === 'ok' || i.status === 'unset') return;
      const base = 'trk|' + email + '|' + i.k + '|' + i.due + '|', us = usDate_(i.due); let key = '', body = '';
      if (i.days <= 0) {
        if (!idx[base + '0']) key = base + '0';
        else if (i.days < 0) { const last = smsLast_(idx, base + 'over|') || idx[base + '0']; if (daysUntil_(iso_(new Date(last))) <= -7) key = base + 'over|' + today_(); }
        if (key) body = 'Comfort Hands: your ' + i.label.toLowerCase() + (i.days < 0 ? ' is overdue (was due ' : (i.k === 'cert' ? ' expires today (' : ' is due today (')) + us + '). Please contact the office at ' + office + '.';
      } else if (i.days <= 30) { if (!idx[base + '30']) key = base + '30'; } else if (i.days <= 60) { if (!idx[base + '60']) key = base + '60'; }
      if (key && !body) body = 'Comfort Hands: your ' + i.label.toLowerCase() + (i.k === 'cert' ? ' expires ' + us + '. Your renewal window is open: please renew and tell the office.' : ' is due ' + us + ' (' + i.days + ' days).') + (i.k === 'cert' ? '' : ' Please contact the office at ' + office + ' to arrange it.');
      if (key) { const s = sendSms_(o.phone, body + smsTail_(), key, 'compliance', email, idx); if (s === 'sent' || s === 'dry-run') n++; }
    });
  });
  try { const cut = new Date(now_().getTime() - 120 * 86400000).toISOString(); delRows_(textLogTab_(), function (row) { return String(row[0]) < cut; }); } catch (e) {}
  return n;
}
// Broadcast texts from the Notifications tab (columns: Text, Status, Started, Sends). Run daily at 9 am by installTextReminders().
// Status "active": sent to every active aide on days 1, 3, 5 and 7 of the run (4 texts), then the row changes to "done".
// Status "inactive" (or anything else) stops it and clears Started/Sends, so setting it back to active starts a fresh run.
function notificationTexts() {
  if (!tzOk_()) return 0;
  const hr = now_().getHours(); if (hr < 6 || hr >= 21) return 0;
  return withLock_(function () {
    const sh = tab_('Notifications', ['Text', 'Status', 'Started', 'Sends']), v = sh.getDataRange().getValues(); if (v.length < 2) return 0;
    const users = usersAll_(), trk = trkMap_(), idx = smsIndex_(), today = today_(), TOTAL = 4; let total = 0, recips = null;
    function recipients() {
      if (recips) return recips; recips = [];
      Object.keys(users).forEach(function (e) { if (users[e].roles.indexOf('aide') < 0) return; const o = trk[e]; if (o && o.phone && o.smsOk) recips.push({ email: e, phone: o.phone }); });
      return recips;
    }
    for (let i = 1; i < v.length; i++) {
      const row = i + 1, text = String(v[i][0] || '').replace(/\s+/g, ' ').trim(), st = String(v[i][1] || '').trim().toLowerCase(), started = iso_(v[i][2]), sends = String(v[i][3] || '');
      if (!text && !st) continue;
      if (st !== 'active') { if ((v[i][2] || v[i][3]) && st !== 'done' && st !== 'too long') sh.getRange(row, 3, 1, 2).setValues([['', '']]); continue; }
      if (!text) continue;
      if (text.length > 300) { sh.getRange(row, 2).setValue('too long'); continue; }
      let start = started, offset = 0;
      if (!start || /^done/.test(sends)) { start = today; sh.getRange(row, 3, 1, 2).setValues([[start, '']]); }
      else offset = -daysUntil_(start);
      if (offset > 6) { sh.getRange(row, 2, 1, 3).setValues([['done', start, 'done (' + (sends.match(/^\d+/) || ['0'])[0] + ' of ' + TOTAL + ')']]); continue; }
      if (offset % 2 !== 0) continue;
      const n = offset / 2 + 1, body = 'Comfort Hands: ' + text + smsTail_(); let sent = 0;
      recipients().forEach(function (r) { const s2 = sendSms_(r.phone, body, 'notif|' + row + '|' + start + '|' + offset + '|' + r.email, 'notification', r.email, idx); if (s2 === 'sent' || s2 === 'dry-run') sent++; });
      total += sent;
      if (n >= TOTAL) sh.getRange(row, 2, 1, 3).setValues([['done', start, 'done (' + n + ' of ' + TOTAL + ')']]);
      else sh.getRange(row, 3, 1, 2).setValues([[start, n + ' of ' + TOTAL]]);
    }
    return total;
  });
}
function usDate_(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : String(s || ''); }
// A counts-only text to the office phones (no names), sent with the Monday digest.
function officeSummaryText_(h) {
  const ph = smsCfg_().OFFICE_PHONES || []; if (!ph.length) return;
  const c = h.counts, body = 'Comfort Hands weekly: ' + (c.trkOver || 0) + ' aide(s) with overdue compliance items, ' + (c.trkSoon || 0) + ' due within 60 days, ' + (c.pcaDue || 0) + ' PCA authorization(s) ending within 45 days. Open the staff portal for details.';
  const idx = smsIndex_(); ph.forEach(function (p, i) { sendSms_(p, body, 'office|' + today_() + '|' + i, 'office-summary', '', idx); });
}
// Run ONCE after texting is set up (and again if you ever change it).
function installTextReminders() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (['shiftReminders', 'complianceTexts', 'notificationTexts'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('shiftReminders').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('complianceTexts').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('notificationTexts').timeBased().everyDays(1).atHour(9).create();
  schedTab_(); textLogTab_(); tab_('Notifications', ['Text', 'Status', 'Started', 'Sends']);
  Logger.log('Installed: shift reminders every 5 minutes, compliance texts and Notifications-tab texts daily at 9 am (script time zone ' + Session.getScriptTimeZone() + '). Texting is ' + (smsLive_() ? 'LIVE.' : 'OFF: set CONFIG.SMS and ENABLED to true. Until then texts are only recorded in the TextLog tab as dry-run.'));
}
// Sends one real text to CONFIG.SMS.TEST_TO to prove the Twilio details work.
function sendTestText() {
  const c = smsCfg_(); if (!smsLive_()) { Logger.log('Texting is not switched on: fill in CONFIG.SMS (TWILIO_SID, TWILIO_TOKEN, FROM) and set ENABLED: true.'); return; }
  Logger.log('Result: ' + sendSms_(c.TEST_TO, 'Comfort Hands: test message. Reply STOP to opt out.', 'test|' + Date.now(), 'test', '', null));
}

/**
 * Run ONCE from the editor after pasting this version (select upgrade, Run, read the Execution log).
 * It prepares the tabs, strengthens stored passwords, moves the Sheet out of the shared admissions folder,
 * turns off link sharing, and lists everyone who still has direct access so you can remove them.
 */
function upgrade() {
  const ss = db_(), tz = Session.getScriptTimeZone();
  try { ss.setSpreadsheetTimeZone(tz); } catch (e) {}
  try { if (ss.getName() !== SHEET_NAME_) { ss.rename(SHEET_NAME_); Logger.log('Renamed the Sheet to "' + SHEET_NAME_ + '".'); } } catch (e) { Logger.log('Could not rename the Sheet: ' + e); }
  carePlanTab_(); ptSheet_(); repSheet_(); draftSheet_(); aideTab_(); pcaTab_(); trkTab_(); schedTab_(); textLogTab_(); onbSheet_(); auditSheet_(); hrRoot_();
  try { Logger.log('Name columns refreshed on ' + refreshNames_() + ' row(s).'); } catch (e) { Logger.log('Could not refresh names: ' + e); }
  const us = usersSheet_(), v = us.getDataRange().getValues(); let n = 0;
  for (let i = 1; i < v.length; i++) if (/^[0-9a-f]{64}$/.test(String(v[i][2]))) { us.getRange(i + 1, 3).setValue(stretch_(String(v[i][2]))); n++; }
  Logger.log('Passwords strengthened for ' + n + ' account(s). Everyone signs in again once; passwords are unchanged.');
  const f = DriveApp.getFileById(ss.getId());
  try { f.moveTo(DriveApp.getRootFolder()); Logger.log('The Sheet "' + ss.getName() + '" is now in your own My Drive, outside the shared admissions folder.'); } catch (e) { Logger.log('Could not move the Sheet: ' + e); }
  try { f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) { Logger.log('Could not turn off link sharing: ' + e); }
  const others = f.getEditors().concat(f.getViewers()).map(function (x) { return x.getEmail(); }).filter(Boolean);
  Logger.log(others.length ? 'These people still have direct access to the Sheet. Anyone who can edit it can create an admin login, so remove anyone who does not need it (open the Sheet, Share): ' + others.join(', ')
                           : 'Nobody else has direct access to the Sheet.');
  if (/^CHANGE-ME/.test(CONFIG.SHARED_SECRET) || /^CHANGE-ME/.test(CONFIG.PASSWORD_SALT)) Logger.log('WARNING: SHARED_SECRET / PASSWORD_SALT still have placeholder values. The portal will refuse to work until you set them.');
  Logger.log('Time zone: ' + tz + (tz === (CONFIG.TIMEZONE || 'America/New_York') ? '' : ' (WARNING: should be ' + (CONFIG.TIMEZONE || 'America/New_York') + '. Set it in Project Settings or text reminders stay paused.)') + '. Upgrade finished.');
}

// ── Text of the forms the new hire signs. Kept here (not in the web page) so the signed PDF always carries the agency's own wording. ──
const HR_CO_ = 'Comfort Hands Home Health Care LLC';
const HR_STANDARDS_ = '<p>' + HR_CO_ + ' values each of its employees and the work they do. We expect to have a long and successful relationship with all who become part of our mission to provide compassionate, excellent, and reliable service to clients in need. We respect the ongoing trust of our clients by providing them with the highest quality of care. For these reasons, it is important that you understand and strictly adhere to ' + HR_CO_ + ' conditions of employment and standards of conduct.</p>' +
  '<p><b>1. STANDARDS OF CONDUCT:</b> I understand that ' + HR_CO_ + ' expects a professional code of conduct at all times.</p><ol type="a">' +
  ['I will treat clients, coworkers, and supervisors in a caring manner and speak to them in a respectful tone of voice.', 'I will refrain from the use of profanity, gossip, or aggressive physical contact.', 'I will notify ' + HR_CO_ + ' immediately when unable to go to an assignment as scheduled.', 'I will be punctual and in attendance as scheduled, avoiding absenteeism and lateness.', 'I will demonstrate honesty in all actions, communications, and documentation (including time slips).', 'I will respect the client\'s homes and property by not taking objects or money that belong to them or accepting any money or gifts from them.', 'I will refuse to act as a client\'s financial agent or Power of Attorney about their financial matters or health care decisions.', 'I will perform all duties as assigned on the care plan in a satisfactory or more than satisfactory manner.', 'I will remain awake, alert, and available to the client while on duty in the client\'s home.', 'I will maintain a healthy work environment, refraining from smoking or being under the influence of drugs/alcohol while on assignment.', 'I will abide by the rules of confidentiality at all times and not discuss clients or fellow employees with anyone outside of ' + HR_CO_ + '.', 'I will minimize safety risks by not taking any unauthorized person (such as a child, family member, or friend) to assignments.', 'I will follow all ' + HR_CO_ + ' policies and procedures.', 'I will keep all client information confidential.'].map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ol>' +
  '<p>I agree to comply with these standards and all applicable laws and regulations. I understand that if a reasonable suspicion exists that I have breached these or other standards that relate to my profession, licensure, or job duties ' + HR_CO_ + ' may initiate disciplinary actions or separation of employment.</p>' +
  [['2. CONFIDENTIALITY STATEMENT', 'I understand that all client information, including his/her name, address, treatment information and other private matters that occur in a client\'s home are confidential. I will respect the privacy of my client by only using his/her personal and health information as needed to perform the duties of my job. While in my possession I will secure all client information to keep it confidential. I will not keep copies of any client information and will return it to the ' + HR_CO_ + ' office when no longer needed.'],
   ['3. PAYROLL', 'If hired, I understand and agree that my pay, whether hourly or per visit, will include time spent on client care, charting/documentation, and travel time. I also understand and agree that I will not be paid without signed time slips and client care documentation and that these items must be turned into the service office no later than Monday of the week services are rendered.'],
   ['4. RELEASE OF INFORMATION', 'I hereby authorize ' + HR_CO_ + ' to seek any information from all my previous employers, references, and schools and to complete a background investigation. I release all of these and Services from any liability arising from their giving or receiving information about me and my suitability for employment with ' + HR_CO_ + '.'],
   ['5. COMPETITIVE SELECTION PROCESS', 'I understand and agree that any offer of employment I may receive is contingent upon my successful completion of ' + HR_CO_ + ' post-offer, pre-employment screening, and the availability of work. ' + HR_CO_ + ' only offers work assignments as they are available. I also understand that if there is more than one qualified candidate for a position, ' + HR_CO_ + ' retains sole discretion to offer employment to the applicant who it believes is the most qualified for the position.'],
   ['6. DRUG/ALCOHOL USE', 'I certify that I am not addicted to or a habitual user of illegal drugs or substances. I also do not misuse any legally prescribed medications that could impair my ability to fully perform my job duties and exercise sound judgment at all times. If hired, I understand that my employment may be terminated for suspected use or for being under the influence of drugs or alcohol at work. I agree to submit drug/alcohol testing within the guidelines of state law.'],
   ['7. CRIMINAL BACKGROUND CHECK', 'Other than any criminal convictions I have disclosed and explained on the Employee Integrity Insurance Coverage Application, I do not have a criminal record and have not been excluded from participation in any federal or state health care program. If convicted of a crime or excluded from a federal or state health care program during my employment with ' + HR_CO_ + ', I will notify my director in writing within 5 days of the conviction or exclusion.'],
   ['8. UNEMPLOYMENT BENEFITS', 'If hired, I understand that my state unemployment benefits may be denied for separation from ' + HR_CO_ + ', failing to accept a suitable job; failing to contact my supervisor at the end of each assignment and regularly thereafter to indicate that I am willing and able to accept new assignments; failing to return to work from a vacation or medical leave of absence.'],
   ['9. RELEASE OF EMPLOYMENT RECORDS', 'If hired, I understand that ' + HR_CO_ + ' is bound by law to report accurate information related to the work history of its employees to federal, state, or local agencies when authorized to do so in writing.'],
   ['10. WORKING DIRECTLY FOR PATIENT / FAMILY IS NOT PERMITTED', 'If hired, I agree that in consideration of my employment with ' + HR_CO_ + ' I will not, for any reason, seek or accept employment from or directly/indirectly provide services to any client of ' + HR_CO_ + ' to whom I have rendered services during my employment with the company and for a period of one hundred eighty (180) days after the separation of my employment. I further agree that if I breach the foregoing damages or compensation will not be an adequate remedy and that ' + HR_CO_ + ' may implement any or all legal remedies available.'],
   ['11. AT-WILL EMPLOYMENT', 'If hired, I understand and agree that my employment by ' + HR_CO_ + ' would be "at will" and that both parties may terminate our employment relationship at any time and for any reason.']
  ].map(function (p) { return '<p><b>' + p[0] + ':</b> ' + p[1] + '</p>'; }).join('') +
  '<p><b>BY SIGNING BELOW, I ACKNOWLEDGE THAT I HAVE READ, UNDERSTAND, AND AGREE TO EACH OF THE PRECEDING PARAGRAPHS AND THAT NO PROMISES REGARDING EMPLOYMENT HAVE BEEN MADE TO ME.</b></p>';

const HR_JOB_COMP_ = '<p>The position of Companion provides in-home client assistance. These services are assigned by and performed under the supervision of the RN responsible for client care. Under no circumstances may a Companion be assigned certified home health aide (CHHA) tasks or other tasks related to any intravenous or sterile, or invasive procedures, other than rectal temperatures. Likewise, a Companion may not be assigned to administer oral, sublingual, subcutaneous, transdermal, rectal, or topical medications.</p>' +
  '<p>The Companion receives scheduling assignments and direction from the Elder Care Coordinator or designee and reports directly to the Nursing Supervisor / Director of Nursing. Under the direction and supervision of either the Nursing Supervisor, Director of Nursing, or staff nurse, live-ins may be responsible for the following:</p>' +
  '<p><b>Responsibilities</b></p><p><i>Household Support</i></p><ul><li>Performing light housekeeping (e.g., laundry, dishes, tidying)</li><li>Preparing meals according to dietary needs</li><li>Running errands (e.g., grocery shopping, picking up prescriptions)</li><li>Assisting with transportation to appointments or social activities</li></ul>' +
  '<p><i>Companionship and Emotional Support</i></p><ul><li>Providing social interaction and emotional reassurance</li><li>Supporting mental and emotional well-being, especially for isolated or elderly clients</li></ul>' +
  '<p><i>Documentation and Communication</i></p><ul><li>Keeping accurate records of services provided</li><li>Reporting any concerns, incidents, or changes in client condition to the appropriate supervisor or nurse</li><li>Communicating effectively with family members or guardians if appropriate</li></ul>' +
  '<p><b>Companions may also</b></p><ul><li>Help clients manage their personal affairs by running errands and scheduling medical appointments, and social activities</li><li>Provide clients with environmental support</li><li>Provide clients with nutritional support</li><li>Schedule and confirm weekly visits with the Nursing Supervisor/Director in order to coordinate necessary visits with other personnel</li><li>Notify the company of absences due to illness, emergency leave, normal vacation periods, or special professional meetings that will affect the agreed service with the company</li><li>Prepare and submit the required paperwork to the company</li></ul>' +
  '<p><b>Qualifications</b></p><ul><li>Must have ninth-grade education or equivalent, with a preference for high school graduates</li><li>Ability to speak, comprehend, read, and write English as the job requires</li><li>Certification from a basic aide training program consistent with State and federal requirements</li><li>Satisfactory performance on a competency evaluation and annual reevaluation</li><li>One-year employment as a personal care aide, nurse\'s aide, or other healthcare-related position preferred</li><li>Emotional and mental maturity necessary to establish and foster positive work relationships with the client, family, and other company personnel</li></ul>' +
  '<p><b>Performance/Functional Abilities</b></p><ul><li>Must be able to read 12-point or larger type</li><li>Must be able to hear and speak in a manner understood by most people</li><li>Must be able to stoop and bend</li><li>Must be able to travel to prospective clients\' residences</li><li>Must be able to lift, turn, and transfer clients weighing up to 200 pounds</li><li>Must be able to carry bundles weighing up to 10 pounds upstairs</li><li>Must be able to write legibly</li></ul>' +
  '<p><b>Special Requirements</b></p><p>It is preferred that employees have a car with current insurance coverage and a valid State driver\'s license.</p>' +
  '<p>I have read this job description and fully understand the conditions set forth therein and will perform these duties to the best of my knowledge and ability.</p>' +
  '<p><b>Waiver and Release of Information</b></p><p>I understand and agree that any consequential omissions or misinterpretations made by me on this application would be sufficient cause for cancellation of this application and/or termination by Comfort Hands Home Health Care if I have been employed.</p>' +
  '<p>I understand that any offer of employment will be at will, that Comfort Hands Home Health Care reserves the right to terminate my employment at any time, with or without prior notice, for any reason, and that I am free to resign at any time, with prior notice. I understand that no representative of the company has the authority to alter the at-will status of this employment.</p>' +
  '<p>I give Comfort Hands Home Health Care the right to investigate all statements contained herein and the references listed above to give you any information concerning my previous employment and any other pertinent information they may have, personal or otherwise. I release Comfort Hands Home Health Care and its representatives from all liability for any damage that may result from furnishing the same information to you. This includes a criminal background history, a workers\' compensation investigation, and all Social Security checks. This may also include random drug testing.</p>' +
  '<p>I further agree that I will abide by all the rules, regulations, and policies of Comfort Hands Home Health Care and that failure to do so may cause termination. I also understand that any offer of employment may be conditioned upon satisfactory completion of a post-offer physical examination or medical evaluation.</p>' +
  '<p>I attest that I, the applicant, have never abused, neglected, sexually assaulted, exploited, or deprived any person, nor have I subjected any person to serious injury as a result of intentional or grossly negligent misconduct.</p>';

const HR_C3_ = 'C3 Intelligence Inc.', HR_C3_ADDR_ = '31355 Oak Crest Drive Suite 210, Westlake Village, CA 91361, and can be contacted at (866) 946-8359 (www.C3Intelligence.com)', HR_BGCO_ = 'Comfort Hands Home Healthcare, LLC';
const HR_BG1_ = '<p>' + HR_BGCO_ + ' (the "Company") may request background information about you from a third-party consumer reporting agency in connection with your employment application and for employment purposes. This information may be obtained in the form of consumer reports and/or investigative consumer reports. These reports may be obtained at any time after receipt of your authorization and, if you are hired by the Company, throughout your employment, as allowed by law.</p>' +
  '<p>' + HR_C3_ + ' will obtain the reports for the Company. ' + HR_C3_ + ' is located at ' + HR_C3_ADDR_ + '. The reports may contain information bearing on your character, general reputation, personal characteristics, mode of living and credit standing. The types of information that may be obtained include, but are not limited to: social security number verifications; credit reports; criminal records checks; public court records checks; driving records checks; educational records checks; employment verifications; personal and professional references checks; licensing and certification records checks; drug/alcohol testing results; etc. The information contained in the reports will be obtained from private and public record sources, including, as appropriate, personal interviews with sources, such as neighbors, friends, and associates. I also understand that information contained in my job application or otherwise disclosed by me before or during my employment, if any, may be used for the purpose of obtaining consumer reports and/or investigative consumer reports.</p>' +
  '<p>By signing below, I acknowledge receipt of the DISCLOSURE OF BACKGROUND INVESTIGATION and certify that I have read and understand this document.</p>';
const HR_NJ_NOTICE_ = '<p><b>NOTICE REGARDING BACKGROUND INVESTIGATIONS PER NEW JERSEY LAW</b></p><p>This summary of the provisions of the New Jersey Fair Credit Reporting Act (NJFCRA) is being provided to you pursuant to state law (N.J.S.A. § 56:11-28 et seq.).</p><ul>' +
  '<li>Before an employer can obtain a consumer report about you from a consumer reporting agency they must provide you with a clear and conspicuous disclosure in writing that such may be obtained for employment purposes. You must provide written consent to the procurement, for employment purposes, of a consumer report.</li>' +
  '<li>When using a consumer report for employment purposes, before taking adverse action based in whole or in part on the report, an employer must provide you with a copy of the consumer report and a description in writing of your rights under the federal Fair Credit Reporting Act as well as the NJFCRA.</li>' +
  '<li>You must be afforded a reasonable opportunity to dispute, with the consumer reporting agency, any information on which the employer relied upon in your consumer report.</li>' +
  '<li>You can request from a consumer reporting agency all information in your file, upon proper identification. This includes sources of information and identification of each person who procured a consumer report for employment purposes during the two-year period preceding your request. These requests must be made during normal business hours and on reasonable notice. It can be done in person or by telephone, if you have made a written request and pay the toll charge. A consumer reporting agency must provide trained personnel to explain to you any information in the consumer report.</li>' +
  '<li>You can dispute inaccurate information with the consumer reporting agency. If you dispute the completeness or accuracy of any of the information in your file, the consumer reporting agency must reinvestigate free of charge during a 30-day period. A consumer reporting agency must provide written notice to you of the results of the reinvestigation not later than five business days after completion of the reinvestigation.</li>' +
  '<li>If, after a reinvestigation, any information disputed by you is found to be inaccurate or incomplete or cannot be verified, the consumer reporting agency must promptly delete that item of information from your file or modify that item of information, as appropriate, based on the results of the reinvestigation.</li>' +
  '<li>You can seek damages for noncompliance under the NJFCRA.</li></ul>';
const HR_BG2A_ = '<p><b>YOUR RIGHTS UNDER FEDERAL LAW</b></p><p>I have been provided with a separate DISCLOSURE OF BACKGROUND INVESTIGATION and understand that I have the right, upon written request made within a reasonable time after receipt thereof, to request disclosure of the nature and scope of any investigative consumer report. The nature and scope of the most common form of investigative consumer report related to employment with Company is the investigation of employee performance, and/or personal and professional references. I may review or obtain a copy of any report(s) about me prepared by ' + HR_C3_ + ' by mail or in person as provided by federal law. <b>' + HR_C3_ + ' may be contacted at 31355 Oak Crest Drive, Suite 210, Westlake Village, CA 91361, (866)946-8359 (www.C3Intelligence.com).</b> You will find information about C3 Intelligence’s privacy practices at https://www.c3intelligence.com/privacy.php</p>' +
  '<p>Pursuant to section 606(b) of the Fair Credit Reporting Act, you have a right to make a written request of the employer procuring an investigative consumer report to make a disclosure to you regarding the nature and scope of the investigation when the request is made within a reasonable period of time after receipt of this notice of rights.</p>' +
  '<p>DPPA Notice: I understand that a "consumer report" may consist of my driving history ("MVR") from a state motor vehicle records agency or Department of Motor Vehicles and authorize the Company to obtain my MVR(s), which may contain personal information about me, such as my photograph, social security number, driver identification number, name, address, telephone number, and medical or disability information.</p>' +
  '<p style="border:1px solid #333;padding:4px 6px"><b>By signing below, I acknowledge receipt of “A SUMMARY OF YOUR RIGHTS UNDER THE FAIR CREDIT REPORTING ACT (FCRA)” and certify that I have read and understand that document.</b></p>' +
  '<p style="text-align:center"><b>YOUR RIGHTS UNDER STATE LAW</b></p>' +
  '<p><b>Massachusetts &amp; New Jersey Applicants, Employees, or Residents:</b> You have the right to know whether the Company requested an investigative consumer report about you and, upon written request to the Company, to receive a copy of any such report. You also have the right to ask the consumer reporting agency (e.g., C3 Intelligence) for a copy of any such report.</p>' +
  '<p><b>Washington State Applicants, Employees, or Residents:</b> You have the right to receive a complete and accurate disclosure of the nature and scope of any investigative consumer report as well as a written summary of your rights and remedies under Washington law.</p>' +
  '<p style="border:1px solid #333;padding:4px 6px"><i><b>New York applicants, employees, and residents only</b></i> – By signing below, I acknowledge receipt of ARTICLE 23-A OF THE NEW YORK CORRECTION LAW</p>' +
  '<p style="border:1px solid #333;padding:4px 6px"><i><b>Los Angeles City or County applicants, employees, and residents only</b></i> – By signing below, I acknowledge receipt of NOTICE TO APPLICANTS &amp; EMPLOYEES FAIR CHANCE INITIATIVE FOR HIRING ORDINANCE</p>' +
  '<p style="border:1px solid #333;padding:4px 6px"><i><b>San Francisco City or County applicants, employees, and residents only</b></i> – By signing below, I acknowledge receipt of EMPLOYEE RIGHTS UNDER SAN FRANCISCO POLICE CODE ARTICLE 49</p>' +
  '<p><b>By signing below, I acknowledge receipt of the NOTICES, RIGHTS, and ACKNOWLEDGMENTS and certify that I have read and understand this document.</b></p>';
const HR_BG_STAND_ = function (name) { return '<div style="border:1px solid #333;padding:5px 8px;margin-top:12px;text-align:center;color:#666;font-weight:bold;font-size:90%">THIS ' + name + ' MUST BE PROVIDED AS A STANDALONE DOCUMENT. DO NOT ATTACH TO OTHER PAPERWORK.</div><p style="text-align:right;margin-top:8px">Page 1 of 1 (rev. 03/2023)</p>'; };
const HR_BG3_ = '<p>I acknowledge receipt of the separate documents entitled DISCLOSURE OF BACKGROUND INVESTIGATION, A SUMMARY OF YOUR RIGHTS UNDER THE FAIR CREDIT REPORTING ACT and NOTICES RIGHTS AND ACKNOWLEDGMENTS and certify that I have read and understand those documents.</p>' +
  '<p>By my signature below, I consent to the release of consumer reports and/or investigative consumer reports prepared by a consumer reporting agency, such as ' + HR_C3_ + ', to ' + HR_BGCO_ + ', and its designated representatives and agents. I understand that if the Company hires me, my consent will apply, and the Company may obtain reports, throughout my employment in compliance, as allowed by law.</p>' +
  '<p>By my signature below, I voluntarily authorize law enforcement agencies, learning institutions (including public and private schools and universities), information service bureaus, credit bureaus, record/data repositories, courts (federal, state and local), motor vehicle records agencies, my past or present employers, the military, and other individuals and sources to furnish any and all information on me that is requested by the consumer reporting agency, ' + HR_C3_ + ' located at ' + HR_C3_ADDR_ + '.</p>' +
  '<p>By my signature below, I certify the information I provided on this form is true and correct. I agree that this Authorization form in original, faxed, photocopied or electronic (including electronic signature) form, will be valid for any reports that may be requested by or on behalf of the Company, as allowed by law.</p>' +
  '<p><b><u>Personal Identifiable Information (PII)</u></b><br>The information below will be used only for background screening purposes.<br><small>*If you do not wish to write your full SSN or year of birth, please call our Secure Line at 866-946-8359 ext. 503</small></p>';

// ═════════════════════════════════════════════════════════════
// HIRING: public job application, provisional offer, new-hire forms signed on screen, document uploads, checklist.
// Homebase and HHAeXchange are plain links in the portal; nothing is tracked there.
// Everything a new hire submits is filed in a separate Drive folder ("Comfort Hands HR (restricted)") in the owner's My Drive.
// ═════════════════════════════════════════════════════════════
const ONB_COLS_ = ['id', 'name', 'email', 'phone', 'status', 'steps', 'formsSentAt', 'createdAt', 'updatedAt', 'updatedBy', 'position', 'app', 'folderId', 'offerAt', 'docs'];
const O_ = { ID: 0, NAME: 1, EMAIL: 2, PHONE: 3, STATUS: 4, STEPS: 5, SENT: 6, CREATED: 7, UPDATED: 8, BY: 9, POS: 10, APP: 11, FOLDER: 12, OFFER: 13, DOCS: 14 };
const ONB_N_ = ONB_COLS_.length;
// [key, label, who completes it]: "auto" steps tick themselves when the applicant does them (staff can still tick them by hand).
const ONB_STEPS_ = [['app', 'Application received', 'auto'], ['appReview', 'Application review', 'admin'], ['offer', 'Provisional offer and contract sent', 'auto'],
  ['standards', 'Agreement of Standards signed', 'auto'], ['jobdesc', 'Job description signed', 'auto'], ['bgforms', 'Background investigation forms signed', 'auto'], ['crimatt', 'Criminal history attestation signed', 'auto'], ['policies', 'Policy acknowledgments signed', 'auto'], ['refrelease', 'Reference release signed', 'auto'],
  ['ids', 'ID documents uploaded', 'auto'], ['contract', 'Signed employment contract returned', 'auto'], ['w4', 'Form W-4 completed', 'admin'], ['i9', 'Form I-9 completed (Sections 1 and 2)', 'admin'],
  ['license', 'License / certification verification', 'admin'], ['refs', 'Reference check', 'admin'], ['bg', 'Background check', 'admin'], ['physical', 'Physical examination', 'admin'],
  ['inservice', 'In-service education', 'admin'], ['competency', 'Competency evaluation', 'admin'], ['homebase', 'Homebase signup', 'admin'], ['hhax', 'HHAeXchange signup', 'admin'], ['portal', 'Employee-portal login created', 'admin']];
const HR_POLICIES_ = '<p>This single form combines the agency’s policy acknowledgments. Read the Reference Guide and each policy below. One signature at the end confirms every acknowledgment on this form.</p><p><b>Part 1. Agency Policy and Procedure Reference Guide</b></p><p><b>1. Agency Policies and Procedures</b></p><p>Purpose: To define the structure, authority, and expectations under which all home care services are provided.</p><p>Comfort Hands Home Healthcare, LLC operates in accordance with NJ Department of Health regulations and the Joint Commission’s Home Care Accreditation Standards. Agency policies are designed to protect clients’ health, safety, and rights while ensuring CHHAs and professional staff deliver consistent, compliant care.</p><p><i>Key procedures</i></p><ul><li>All staff must read and acknowledge agency policies during orientation.</li><li>Policies are reviewed annually or when regulations change.</li><li>Supervisors must ensure employees follow all procedures outlined in the agency manual, including documentation, safety, infection control, and communication standards.</li></ul><p><b>2. Emergency Procedures</b></p><p>Purpose: To protect clients and staff during emergencies and ensure a timely, organized response.</p><p>CHHAs must know the steps for responding to medical emergencies, fires, weather-related disasters, or home hazards while maintaining communication with supervisors and emergency services.</p><p><i>Key procedures</i></p><ul><li>Stay with the client and ensure immediate safety.</li><li>Call 911 for medical or environmental emergencies.</li><li>Notify the RN supervisor and the agency administrator immediately.</li><li>Complete an incident report within 24 hours.</li><li>Participate in annual emergency preparedness training.</li></ul><p>Compliance: In accordance with CMS §484.102 (Emergency Preparedness Requirements) and NJ DOH home care licensure rules.</p><p><b>3. Patient Rights</b></p><p>Purpose: To ensure that each client is treated with dignity, respect, and fairness while receiving home care services.</p><p>Clients of Comfort Hands Home Healthcare, LLC have the right to receive care that respects their autonomy, privacy, and individuality. All staff must be familiar with and uphold the agency’s Patient Bill of Rights.</p><p><i>Key rights include</i></p><ul><li>The right to receive respectful and non-discriminatory care.</li><li>The right to privacy and confidentiality of medical information.</li><li>The right to participate in the care plan and refuse treatment.</li><li>The right to voice concerns or complaints without fear of retaliation.</li></ul><p>Training Note: Each CHHA must review and sign acknowledgment of Patient Rights during orientation and annually thereafter.</p><p><b>4. Infection Control</b></p><p>Purpose: To prevent the spread of infectious diseases among clients, caregivers, and the community.</p><p>CHHAs are responsible for maintaining infection control standards in every home care visit.</p><p><i>Key procedures</i></p><ul><li>Wash hands before and after client contact.</li><li>Use gloves and PPE as required by the care plan.</li><li>Properly dispose of contaminated materials (e.g., gloves, dressings).</li><li>Report any exposure incidents immediately.</li><li>Participate in annual infection control training.</li></ul><p>Compliance: Follows OSHA Bloodborne Pathogens Standard (29 CFR 1910.1030) and CMS §484.80(b).</p><p><b>5. Documentation Standards</b></p><p>Purpose: To ensure accurate, timely, and legally defensible clinical records.</p><p>All CHHAs and nursing staff must complete required documentation for every visit, reflecting services provided and client condition changes.</p><p><i>Key procedures</i></p><ul><li>Record visit notes promptly, accurately, and legibly.</li><li>Use only agency-approved forms and secure systems.</li><li>Include date, time, signature, and any changes observed in client status.</li><li>Submit completed documentation by the end of each workday.</li></ul><p>Compliance: Complies with CMS §484.110 (Clinical Records) and NJ DOH administrative code.</p><p><b>6. Communication Protocols</b></p><p>Purpose: To promote clear, timely, and effective communication among staff, clients, and families.</p><p>Effective communication is critical for client safety and care coordination. Staff must adhere to the agency’s chain of communication and documentation expectations.</p><p><i>Key procedures</i></p><ul><li>Immediately report client condition changes to the RN supervisor.</li><li>Communicate respectfully and maintain professionalism in all interactions.</li><li>Document all verbal and written communications in the client’s record.</li><li>Use secure communication channels (no texting PHI).</li></ul><p>Training Note: Communication procedures are reinforced during onboarding, annual evaluations, and in-service sessions.</p><p><b>Part 2. Acknowledgments</b></p><p><b>A. Agency Policy, Procedure Manual and Employee Handbook</b></p><p>I acknowledge that I have received, read, and understand the policies and procedures contained in the Comfort Hands Home Healthcare, LLC Policy and Procedure Manual, the Employee Handbook, and any related compliance documents provided to me during orientation or employment. I understand that:</p><ol><li>The agency’s policies and procedures are designed to ensure quality patient care, regulatory compliance, and employee safety.</li><li>It is my responsibility to read, understand, and comply with all agency policies, procedures, and updates, including but not limited to: patient care standards; confidentiality and HIPAA compliance; code of conduct and ethics; infection control and safety practices; workplace behavior and equal opportunity; and corporate compliance and reporting obligations.</li><li>Failure to adhere to these policies may result in corrective action, up to and including termination of employment.</li><li>Comfort Hands Home Healthcare, LLC reserves the right to modify, amend, or terminate its policies and procedures at any time, with or without notice, as necessary to meet operational or regulatory requirements.</li></ol><p>I also understand that my signature does not constitute a contract of employment and that my employment with Comfort Hands Home Healthcare, LLC is at-will.</p><p><b>B. CHHA Code of Conduct</b></p><p>I have reviewed the CHHA Code of Conduct and agree to adhere to all professional, ethical, and behavioral standards. I understand the importance of integrity, compassion, and professionalism in all client interactions and agency activities.</p><p><b>C. Confidentiality and HIPAA Compliance</b></p><p>This Confidentiality and HIPAA Compliance Statement acknowledges each employee’s responsibility to protect all confidential, sensitive, and personal information encountered during their employment with Comfort Hands Home Healthcare, LLC.</p><p><i>Definition of Protected Health Information (PHI).</i> Protected Health Information (PHI) refers to any information that can identify an individual and relates to their past, present, or future physical or mental health condition, the provision of healthcare, or payment for healthcare services. This includes names, addresses, birth dates, telephone numbers, medical record numbers, diagnoses, treatment details, or any combination of data that could identify a patient. PHI may exist in any form (verbal, written, or electronic) and must always be protected from unauthorized access or disclosure.</p><p>I understand that in the course of my employment or association with Comfort Hands Home Healthcare, LLC, I may have access to confidential information, including but not limited to patient records, medical information, personnel files, and proprietary business materials. I acknowledge and agree to the following obligations:</p><ol><li>I will maintain the confidentiality of all patient information and protect it in accordance with federal and state privacy laws, including the Health Insurance Portability and Accountability Act (HIPAA).</li><li>I will not access, use, disclose, or copy any confidential or protected health information (PHI) unless required to perform my authorized job duties.</li><li>I will not discuss or disclose PHI in public areas, social media, or outside of authorized professional contexts.</li><li>I will follow all agency procedures to safeguard records, computers, and passwords against unauthorized access.</li><li>I understand that any violation of confidentiality or HIPAA regulations may result in disciplinary action, termination, and possible legal penalties.</li><li>I will immediately report any suspected breach of confidentiality or HIPAA violation to my supervisor or the designated Privacy Officer.</li><li>My duty to protect confidential information continues even after my employment ends.</li></ol><p><b>D. Abuse, Neglect and Exploitation Prevention</b></p><p>I have reviewed the agency’s Abuse, Neglect, and Exploitation Prevention Policy. I understand the definitions, signs, and mandatory reporting requirements under NJ law and agree to report any suspected abuse or neglect immediately per policy.</p><p><b>E. Infection Prevention</b></p><p>I have completed infection prevention training and understand proper hygiene, PPE use, and reporting procedures for exposure or contamination. I agree to follow all agency infection control protocols to ensure safety for clients and staff.</p><p><b>F. Emergency Preparedness and Safety</b></p><p>I have reviewed the agency’s Emergency Preparedness and Safety Policy. I understand emergency procedures, safety protocols, and my responsibilities during client care and emergency events.</p><p><b>Employee Acknowledgment Statement</b></p><p>I acknowledge that I have reviewed and understand the policies and procedures described in this document, including the Reference Guide and acknowledgments A through F. I agree to abide by the standards, expectations, and ethical obligations of Comfort Hands Home Healthcare, LLC. I understand that failure to comply with these standards may result in disciplinary action, up to and including termination. This acknowledgment is made at orientation and is repeated every year.</p>';
const HR_POSITIONS_ = ['Director of Nursing', 'Staffing Coordinator', 'Office Support Staff', 'Licensed Practical Nurse (LPN)', 'Certified Home Health Aide', 'Certified Nursing Assistant', 'Marketing Executive', 'Live-In Certified Home Health Aide', 'RN Clinical Supervisor', 'Registered Nurse (RN)', 'Companion', 'Personal Care Assistant (PCA)'];
const HR_JOB_TAIL_ = HR_JOB_COMP_.slice(HR_JOB_COMP_.indexOf('<p><b>Special Requirements'));
const HR_JOB_CHHA_ = '<p>The position of Certified Home Health Aide (CHHA) provides in-home client assistance. These services are assigned by and performed under the supervision of the RN responsible for client care. Under no circumstances may a CHHA be assigned tasks related to any intravenous or sterile or invasive procedures, other than rectal temperatures. Likewise, a CHHA may not be assigned to administer oral, sublingual, subcutaneous, transdermal, rectal, or topical medications.</p>' +
  '<p>The CHHA receives scheduling assignments and direction from the Elder Care Coordinator or designee and reports directly to the Nursing Supervisor / Director of Nursing. Under the direction and supervision of either the Nursing Supervisor, Director of Nursing, or staff nurse, live-ins may be responsible for the following:</p>' +
  '<p><b>Responsibilities</b></p><ul><li>Assist clients with feeding and dressing</li><li>Assist clients with personal hygiene, grooming, and dental/oral care</li><li>Help clients manage their personal affairs by running errands and scheduling medical appointments and social activities</li><li>Assist with selected health-related tasks in the case of self-directed clients</li><li>Provide clients with environmental support</li><li>Provide clients with nutritional support</li><li>Schedule and confirm weekly visits with the Nursing Supervisor/Director in order to coordinate necessary visits with other personnel</li><li>Notify the company of absences due to illness, emergency leave, normal vacation periods, or special professional meetings that will affect the agreed service with the company</li><li>Prepare and submit the required paperwork to the company</li></ul>' +
  '<p><b>Qualifications</b></p><ul><li>Must have ninth-grade education or equivalent, with a preference for high school graduates</li><li>Ability to speak, comprehend, read, and write English as the job requires</li><li>Certification from a basic aide training program consistent with State and federal requirements</li><li>Satisfactory performance on a competency evaluation and annual reevaluation</li><li>One-year employment as a personal care aide, nurse’s aide, or other healthcare-related position preferred</li><li>Emotional and mental maturity necessary to establish and foster positive work relationships with the client, family, and other company personnel</li></ul>' +
  '<p><b>Performance/Functional Abilities</b></p><ul><li>Must be able to read 12-point or larger type</li><li>Must be able to hear and speak in a manner understood by most people</li><li>Must be able to stoop and bend</li><li>Must be able to travel to prospective clients’ residences</li><li>Must be able to lift, turn, and transfer clients weighing up to 200 pounds</li><li>Must be able to carry bundles weighing up to 10 pounds upstairs</li><li>Must be able to write legibly</li></ul>' + HR_JOB_TAIL_;
const HR_JOB_TITLE_CHHA_ = 'Certified Home Health Aide (CHHA) Job Description';
const HR_JOBDESC_FOR_ = ['Companion', 'Personal Care Assistant (PCA)', 'Certified Home Health Aide', 'Live-In Certified Home Health Aide']; // positions that sign a job description (PCA signs the CHHA one)
function jobDesc_(pos) {
  const p = String(pos || '');
  if (/companion/i.test(p)) return { title: 'Companion Job Description', html: HR_JOB_COMP_ };
  if (/home health aide|chha|personal care|pca/i.test(p)) return { title: 'Certified Home Health Aide (CHHA) Job Description', html: HR_JOB_CHHA_ };
  return null;
}
// Application fields: [key, label, section]. Only these keys are accepted. The Social Security number goes into the application PDF only.
const APP_FIELDS_ = [['firstName', 'First Name', 'Demographic Information'], ['lastName', 'Last Name'], ['email', 'Email'], ['phone', 'Phone/Mobile'], ['ssn', 'Social Security Number'], ['dob', 'Date of Birth'], ['residency', 'US Residency Status'],
  ['addr1', 'Current Address Line 1'], ['addr2', 'Current Address Line 2'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip Code'], ['country', 'Country'],
  ['paddr1', 'Previous Address Line 1'], ['paddr2', 'Previous Address Line 2'], ['pcity', 'Previous City'], ['pstate', 'Previous State'], ['pzip', 'Previous Zip Code'], ['pcountry', 'Previous Country'],
  ['position', 'Position Applied For', 'Position/Availability'], ['days', 'Available to Work'], ['startDate', 'Date available to Start'], ['transport', 'Means of Transportation'], ['languages', 'Languages spoken in addition to English'], ['languageOther', 'Other language'],
  ['licType', 'License Type', 'License'], ['licNo', 'License / Certification No.'], ['licBoard', 'Issuing Authority / Board'], ['licExp', 'Expiration Date'], ['licAction', 'Has your Professional license been suspended, revoked or under investigation?'], ['licExplain', 'If yes, please explain'],
  ['certs', 'Certifications', 'Additional Certifications'], ['palsExp', 'PALS expiration date'], ['cprExp', 'CPR expiration date'], ['bclsExp', 'BCLS expiration date'], ['aclsExp', 'ACLS expiration date'],
  ['emp1Name', 'Current / Most Recent Employer', 'Employment History'], ['emp1Addr1', 'Address Line 1'], ['emp1Addr2', 'Address Line 2'], ['emp1City', 'City'], ['emp1State', 'State'], ['emp1Zip', 'Zip Code'], ['emp1Country', 'Country'], ['emp1Title', 'Job Title'], ['emp1Resp', 'Responsibilities'],
  ['emp1Still', 'Still Work Here?'], ['emp1Start', 'Start Date'], ['emp1End', 'End Date'], ['emp1Sup', 'Supervisor\'s Name'], ['emp1SupPhone', 'Supervisor\'s Phone Number'], ['emp1Reason', 'Reason(s) for Leaving'], ['emp1Contact', 'May we contact your current/previous employers'],
  ['emp2Name', 'Previous Employer'], ['emp2Addr1', 'Address Line 1'], ['emp2Addr2', 'Address Line 2'], ['emp2City', 'City'], ['emp2State', 'State'], ['emp2Zip', 'Zip Code'], ['emp2Country', 'Country'], ['emp2Title', 'Job Title'], ['emp2Resp', 'Responsibilities'],
  ['convicted', 'Have you ever been convicted of any crime?', 'Personal/Criminal Records'], ['convictedExplain', 'If yes explain'],
  ['eduLevel', 'Highest Level of Education', 'Education History'], ['eduGrad', 'Graduation Date'], ['eduSchool', 'School Name'], ['eduAddr', 'School Address'], ['eduCity', 'City'], ['eduState', 'State'], ['eduZip', 'Zip Code'], ['malpProvider', 'Malpractice Insurance Provider'], ['malpPolicy', 'Malpractice Insurance Policy #'],
  ['ref1Name', 'Reference 1 Name', 'References'], ['ref1Title', 'Title'], ['ref1Addr', 'Address'], ['ref1Contact', 'Telephone / Email'], ['ref2Name', 'Reference 2 Name'], ['ref2Title', 'Title'], ['ref2Addr', 'Address'], ['ref2Contact', 'Telephone / Email'], ['ref3Name', 'Reference 3 Name'], ['ref3Title', 'Title'], ['ref3Addr', 'Address'], ['ref3Contact', 'Telephone / Email'],
  ['consentEmployer', 'Authorization to contact prior employers', 'Consent and Authorizations'], ['consentBackground', 'Authorization for background check'], ['consentDate', 'Date'], ['consentSms', 'Consent to SMS messaging']];
const UPLOAD_KINDS_ = { w4: 'Form W-4 (completed and signed)', ssncard: 'Social Security card', i9a: 'I-9 List A document', i9b: 'I-9 List B document (identity)', i9c: 'I-9 List C document (work authorization)', contract: 'Signed employment contract', physical: 'Completed physical examination', other: 'Other document' };
const DOC_TYPES_ = { 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' };
const FILE_TYPES_ = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

// Items the office can ask an employee for (used for "Request items"). A key is a form, an upload, or the details page.
const REQ_LABELS_ = { details: 'Review and update your personal details', w4: 'Form W-4 (tax withholding), completed and signed on screen', ssncard: 'Photo or scan of your Social Security card',
  i9a: 'I-9 List A document (identity and work authorization)', i9b: 'I-9 List B document (identity)', i9c: 'I-9 List C document (work authorization)', contract: 'Signed employment contract',
  physical: 'Completed physical examination', standards: 'Agreement of Standards (sign on screen)', jobdesc: 'Job description (sign on screen)', bgforms: 'Background investigation forms (sign on screen)',
  crimatt: 'Criminal history attestation (sign on screen)', policies: 'Policy acknowledgments (sign on screen)', refrelease: 'Reference release (sign on screen)', other: 'Other document the office asked for' };
function reqItems_(x) { const q = onbApp_(x)._req; return q && Array.isArray(q.items) && q.items.length ? q.items : null; }
function onbSheet_() { return tab_('Onboarding', ONB_COLS_); }
function onbRow_(sh, r) { const x = sh.getRange(r, 1, 1, ONB_N_).getValues()[0]; while (x.length < ONB_N_) x.push(''); return x; }
function onbSteps_(x) { let s = {}; try { s = JSON.parse(x[O_.STEPS] || '{}'); } catch (e) {} if (s.formsSent && !s.offer) s.offer = s.formsSent; delete s.formsSent; return s; }
function onbDocs_(x) { try { const d = JSON.parse(x[O_.DOCS] || '[]'); return Array.isArray(d) ? d : []; } catch (e) { return []; } }
function onbApp_(x) { try { return JSON.parse(x[O_.APP] || '{}') || {}; } catch (e) { return {}; } }
function onbAllDone_(steps) { return ONB_STEPS_.every(function (s) { return steps[s[0]] && steps[s[0]].done; }); }
function onbObj_(x) {
  const steps = onbSteps_(x); let done = 0, next = '';
  ONB_STEPS_.forEach(function (s) { if (steps[s[0]] && steps[s[0]].done) done++; else if (!next) next = s[1]; });
  let folderUrl = ''; if (x[O_.FOLDER]) folderUrl = 'https://drive.google.com/drive/folders/' + x[O_.FOLDER];
  return { id: x[O_.ID], name: x[O_.NAME], email: x[O_.EMAIL], phone: x[O_.PHONE], status: String(x[O_.STATUS] || 'in progress'), steps: steps, formsSentAt: iso_(x[O_.OFFER]) || iso_(x[O_.SENT]), createdAt: iso_(x[O_.CREATED]),
           updatedAt: String(x[O_.UPDATED] || ''), position: x[O_.POS] || '', app: onbApp_(x), docs: onbDocs_(x), folderUrl: folderUrl, done: done, total: ONB_STEPS_.length, next: next };
}
function onbAll_() { const v = onbSheet_().getDataRange().getValues(), res = []; for (let i = 1; i < v.length; i++) if (v[i][0]) { while (v[i].length < ONB_N_) v[i].push(''); res.push(onbObj_(v[i])); } return res; }
function hrRoot_() {
  const p = PropertiesService.getScriptProperties(), id = p.getProperty('HR_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Comfort Hands HR (restricted)'); p.setProperty('HR_FOLDER_ID', f.getId()); return f;
}
function onbFolder_(x) {
  if (x[O_.FOLDER]) { try { return DriveApp.getFolderById(String(x[O_.FOLDER])); } catch (e) {} }
  const f = hrRoot_().createFolder(clean_(x[O_.NAME]) + ' (' + x[O_.ID] + ')'); x[O_.FOLDER] = f.getId(); return f;
}
// Re-reads the applicant's row under the lock, lets fn change it, and writes it back.
function onbUpdate_(id, who, fn) {
  return withLock_(function () {
    const sh = onbSheet_(), r = findRow_(sh, 0, id); if (!r) return null;
    const x = onbRow_(sh, r), steps = onbSteps_(x), docs = onbDocs_(x);
    const tick = function (k, note) { if (!(steps[k] && steps[k].done)) steps[k] = { done: true, date: today_(), by: who, note: note || (steps[k] && steps[k].note) || '' }; };
    fn(x, steps, docs, tick);
    x[O_.STEPS] = JSON.stringify(steps); x[O_.DOCS] = JSON.stringify(docs).slice(0, CELL_MAX_); x[O_.UPDATED] = new Date().toISOString(); x[O_.BY] = who;
    if (onbAllDone_(steps) && x[O_.STATUS] === 'in progress') x[O_.STATUS] = 'hired';
    sh.getRange(r, 1, 1, ONB_N_).setValues([safeRow_(x)]);
    return x;
  });
}
function fileFrom_(f, baseName, docsOk) {
  f = f || {}; const ext = FILE_TYPES_[String(f.mime || '')] || (docsOk ? DOC_TYPES_[String(f.mime || '')] : ''), b64 = String(f.b64 || '');
  if (!ext) throw new Error(docsOk ? 'Please upload a PDF, Word, JPG or PNG file.' : 'Please upload a PDF, JPG or PNG file.');
  if (!b64 || b64.length > 8200000 || !/^[A-Za-z0-9+\/=]+$/.test(b64)) throw new Error('That file is too large or unreadable (limit 6 MB).');
  return Utilities.newBlob(Utilities.base64Decode(b64), f.mime, clean_(baseName) + '.' + ext);
}
function throttle_(key, max, secs) { const c = CacheService.getScriptCache(), n = Number(c.get(key) || 0); if (n >= max) return false; c.put(key, String(n + 1), secs); return true; }

// ── forms the new hire signs: definitions are built here from the stored application ──
function hrForms_(x) {
  const a = onbApp_(x), full = String(x[O_.NAME] || ''), addr = [a.addr1, a.addr2].filter(Boolean).join(', ');
  const nameF = [{ id: 'last', label: 'Last name', value: a.lastName || '', req: true }, { id: 'first', label: 'First name', value: a.firstName || '', req: true }, { id: 'middle', label: 'Middle name', value: '' }];
  const forms = [{ k: 'standards', step: 'standards', title: 'Agreement of Standards / Employment Agreement', html: HR_STANDARDS_, fields: [{ id: 'print', label: 'Print full name', value: full, req: true }] }];
  const jd = jobDesc_(x[O_.POS]); if (jd) forms.push({ k: 'jobdesc', step: 'jobdesc', title: jd.title, html: jd.html, fields: [{ id: 'print', label: 'Employee name (printed)', value: full, req: true }] });
  const fcra = CONFIG.FCRA_SUMMARY_URL ? '<p>Before signing, read <a href="' + esc_(CONFIG.FCRA_SUMMARY_URL) + '" target="_blank" rel="noopener">A Summary of Your Rights Under the Fair Credit Reporting Act</a>.</p>' : '';
  const nomid = { id: 'nomid', label: 'No middle name', type: 'check' };
  const nameF1 = [nameF[0], nameF[1], nameF[2], nomid];
  forms.push({ k: 'bg1', step: 'bgforms', title: 'Disclosure of Background Investigation', html: HR_BG1_, post: HR_BG_STAND_('DISCLOSURE OF BACKGROUND INVESTIGATION'), fields: nameF1 });
  forms.push({ k: 'bg2', step: 'bgforms', title: 'Notices Rights and Acknowledgments', html: HR_BG2A_, post: HR_BG_STAND_('NOTICE AND RIGHTS AND ACKNOWLDGEMENT'), fields: nameF1.concat([
    { id: 'mnok', label: 'Minnesota & Oklahoma Applicants, Employees, or Residents: Please check this box if you would like to receive a free copy of your consumer report and/or investigative consumer report if one is obtained by the Company.', type: 'check' },
    { id: 'ecr', label: 'Residents of CO, CT, HI, IL, MD, NV, OR, VT, WA, New York City, Philadelphia, PA or Washington, DC: IF THIS BOX IS CHECKED, Your report will include an Employment Credit Report. This is permissible because you are being considered, retained, hired, or promoted to the following position:', type: 'check' },
    { id: 'ecrpos', label: 'Position (only if the box above is checked)', value: '' }]) });
  forms.push({ k: 'bg3', step: 'bgforms', title: 'Authorization for Background Investigation', html: HR_BG3_, pre: fcra, post: HR_BG_STAND_('AUTHORIZATION FOR BACKGROUND INVESTIGATION'), fields: nameF1.concat([
    { id: 'ssn', label: 'Social Security No.*', value: '', secret: true }, { id: 'dob', label: 'Date of Birth*', value: a.dob || '' }, { id: 'other', label: 'If Applicable, Other Social Security/Names Used', value: '' },
    { id: 'addr', label: 'Present Address', value: addr, req: true }, { id: 'city', label: 'City', value: a.city || '', req: true }, { id: 'state', label: 'State', value: a.state || '', req: true }, { id: 'zip', label: 'Zip', value: a.zip || '', req: true },
    { id: 'prior', label: 'Prior Addresses', value: [a.paddr1, a.paddr2].filter(Boolean).join(', ') }, { id: 'pcity', label: 'Prior address: City', value: a.pcity || '' }, { id: 'pstate', label: 'Prior address: State', value: a.pstate || '' }, { id: 'pzip', label: 'Prior address: Zip', value: a.pzip || '' },
    { id: 'dl', label: 'Driver’s License # & State of Issue', value: '' },
    { id: 'phone', label: 'Daytime Phone Number', value: x[O_.PHONE] || '', req: true }, { id: 'email', label: 'Email Address', value: x[O_.EMAIL] || '', req: true }]) });
  forms.push({ k: 'bgnj', step: 'bgforms', title: 'Notice Regarding Background Investigations per New Jersey Law', html: HR_NJ_NOTICE_.replace(/^<p><b>NOTICE REGARDING[^]*?<\/b><\/p>/, ''), post: '<p style="text-align:right;margin-top:8px">Provided as a separate document.</p>', fields: [{ id: 'print', label: 'Print full name', value: full, req: true }] });
  forms.push({ k: 'crimatt', step: 'crimatt', title: 'Criminal History Background Check Attestation', html: '<p>These questions are asked of all employees with direct physical access to members, and are updated every year. Answer every question.</p><p><b>Definition for question 5:</b> “Currently” means sufficiently recent to justify a reasonable belief that the use of drugs may have an ongoing impact on one’s ability to practice. It is not limited to the day of, or within a matter of days or weeks before, the date of an application; it means the use has occurred recently enough to indicate the individual is actively engaged in such conduct. “Illegal use of drugs” refers to drugs whose possession or distribution is unlawful under the Controlled Substances Act, 21 U.S.C. § 812. It does not include use of a drug taken under the supervision of a licensed health care professional, or other uses authorized by the Controlled Substances Act or other provision of federal law. It does include the unlawful use of prescription controlled substances.</p><p>By signing, I attest that my answers are true and complete.</p>', fields: [
    { id: 'q1', label: 'Have you ever been convicted of, pled guilty to or pled nolo contendere to any felony in the last ten years or been found liable or responsible for or named as a defendant in any civil offense that is reasonably related to your qualifications, competence, functions or duties as a medical professional?', type: 'yn', req: true },
    { id: 'q2', label: 'Have you ever been convicted of, pled guilty to or pled nolo contendere to any felony in the last ten years or been found liable or responsible for or named as a defendant in any civil offense that is alleged fraud, an act of violence, child abuse or sexual offense or sexual misconduct?', type: 'yn', req: true },
    { id: 'q3', label: 'Have you ever been indicted in any criminal suit?', type: 'yn', req: true },
    { id: 'q4', label: 'Have you ever been court martialed for actions related to your duties as a medical professional?', type: 'yn', req: true },
    { id: 'q5', label: 'Are you currently engaged in the illegal use of drugs? (See the definition above.)', type: 'yn', req: true },
    { id: 'q6', label: 'Do you use any chemical substances that would in any way impair or limit your ability to perform the functions of your job with reasonable skill and safety?', type: 'yn', req: true },
    { id: 'q7', label: 'Do you have any reason to believe that you would pose a risk to the safety or well-being of your clients?', type: 'yn', req: true },
    { id: 'print', label: 'Employee name (printed)', value: full, req: true }] });
  forms.push({ k: 'policies', step: 'policies', title: 'Policy and Procedure Guide and Employee Acknowledgments', html: HR_POLICIES_, fields: [{ id: 'print', label: 'Employee name (printed)', value: full, req: true }] });
  const emps = [[a.emp1Name, a.emp1Title, a.emp1Start, a.emp1End], [a.emp2Name, a.emp2Title, '', '']].filter(function (e) { return e[0]; });
  forms.push({ k: 'refrelease', step: 'refrelease', title: 'Employment Reference Verification: Applicant Authorization',
    html: (emps.length ? '<p><b>Former employers listed on my application:</b></p><ul>' + emps.map(function (e) { return '<li>' + esc_(e[0]) + (e[1] ? ', ' + esc_(e[1]) : '') + (e[2] ? ' (' + esc_(e[2]) + ' to ' + esc_(e[3] || 'present') + ')' : '') + '</li>'; }).join('') + '</ul>' : '') +
      '<p>I authorize my former employers to release information relating to my employment history, including my position, dates of employment, job performance, attendance, cooperation, initiative, health, strengths, weaknesses and eligibility for rehire. I release them from any and all liability resulting from filling out this form. I understand that any information received will be treated in a completely confidential manner.</p>',
    fields: [{ id: 'print', label: 'Applicant\'s name', value: full, req: true }] });
  const conRate = rateFor_(x[O_.POS]);
  if (conRate) forms.unshift({ k: 'contract', step: 'contract', title: 'Provisional Employment Agreement', html: contractOnscreen_(full, x[O_.POS], conRate), fields: [{ id: 'print', label: 'Print full name', value: full, req: true }, { id: 'start', label: 'Start date (MM/DD/YYYY)', value: '', req: true }] });
  return forms;
}
// The contract as shown for on-screen signing: the paper blanks (start date, signatures) are replaced by the fields and signature pad on the page.
function contractOnscreen_(name, pos, rate) {
  return contractBody_(esc_(name), esc_(pos), '$' + Number(rate).toFixed(2) + ' per hour', ' (the position selected on the online application)')
    .replace(/<b>Start date:<\/b> _+/, '<b>Start date:</b> entered below')
    .replace(/<p><b>Employee signature:<\/b>[^]*?<\/p>/, '')
    .replace(/<p><b>Printed name:<\/b>[^]*?<\/p>/, '')
    .replace(/<p><b>For Comfort Hands Home Healthcare LLC:<\/b>[^]*?<\/p>/, '<p><b>For Comfort Hands Home Healthcare LLC:</b> offered by the Agency on the date this offer was sent.</p>')
    .replace(/<p><b>Name and title:<\/b>[^]*?<\/p>/, '');
}
function hrState_(x) {
  const docs = onbDocs_(x), has = {}; docs.forEach(function (d) { has[d.k] = true; });
  const req = reqItems_(x), asked = function (k) { return !req || req.indexOf(k) >= 0; };
  const pub = {}, ap = onbApp_(x), nm = String(x[O_.NAME] || '').trim().split(/\s+/);
  Object.keys(ap).forEach(function (k) { if (k.charAt(0) !== '_' && k !== 'ssn') pub[k] = ap[k]; });
  if (!pub.firstName) pub.firstName = nm[0] || ''; if (!pub.lastName) pub.lastName = nm.slice(1).join(' '); if (!pub.phone && x[O_.PHONE]) pub.phone = String(x[O_.PHONE]); pub.email = String(x[O_.EMAIL] || '');
  return { ok: true, name: x[O_.NAME], first: String(x[O_.NAME]).split(/\s+/)[0], position: x[O_.POS], req: req, details: asked('details'), app: pub,
    forms: hrForms_(x).filter(function (f) { return asked(f.k) || (/^bg/.test(f.k) && asked('bgforms')); }).map(function (f) { return { k: f.k, title: f.title, html: f.html, pre: f.pre || '', post: f.post || '', fields: f.fields, done: !!has[f.k] }; }),
    uploads: Object.keys(UPLOAD_KINDS_).filter(function (k) { return asked(k); }).map(function (k) { return { k: k, label: UPLOAD_KINDS_[k], done: !!has[k] }; }),
    w4: (function () { const a = onbApp_(x), n = String(x[O_.NAME] || '').trim().split(/\s+/); return { firstName: String(a.firstName || n[0] || ''), lastName: String(a.lastName || n.slice(1).join(' ') || ''), addr1: String(a.addr1 || ''), addr2: String(a.addr2 || ''), city: String(a.city || ''), state: String(a.state || ''), zip: String(a.zip || '') }; })(),
    i9Url: CONFIG.I9_DOCUMENTS_URL || 'https://www.uscis.gov/i-9-central/form-i-9-acceptable-documents' };
}
function appToken_(id) { const exp = Date.now() + 2 * 3600 * 1000, p = Utilities.base64EncodeWebSafe(JSON.stringify({ a: id, x: exp })); return { token: 'A.' + p + '.' + sign_('A:' + p), exp: exp }; }
function appFromToken_(t) {
  const p = String(t || '').split('.'); if (p.length !== 3 || p[0] !== 'A' || !same_(sign_('A:' + p[1]), p[2])) return '';
  try { const o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(p[1])).getDataAsString()); return o.x > Date.now() ? keyOf_(o.a) : ''; } catch (e) { return ''; }
}

// Requests from the public Apply page (no staff sign-in).
function hr_(d) {
  const act = d.action, cache = CacheService.getScriptCache();
  if (act === 'applySubmit') return once_(d, function () { return JSON.parse(applySubmit_(d).getContent()); });
  const sh = onbSheet_();
  if (act === 'applicantCode' || act === 'applicantLogin') {
    const id = keyOf_(d.id), r = id ? findRow_(sh, 0, id) : 0, x = r ? onbRow_(sh, r) : null;
    const open = x && (x[O_.OFFER] || x[O_.SENT]) && ['in progress', 'hired'].indexOf(String(x[O_.STATUS])) >= 0 && /^\S+@\S+\.\S+$/.test(String(x[O_.EMAIL]));
    if (act === 'applicantCode') {
      if (open && !cache.get('acool:' + id) && throttle_('acnt:' + id, 5, 3600)) {
        cache.put('acool:' + id, '1', 60);
        const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 8), 16) % 1000000).padStart(6, '0');
        cache.put('acode:' + id, hash_(id, code), 900); cache.remove('aatt:' + id);
        MailApp.sendEmail({ to: x[O_.EMAIL], subject: 'Your Comfort Hands new-hire code', body: 'Your code is ' + code + '. It expires in 15 minutes.\n\nIf you did not ask for this code, ignore this email.' });
      }
      return out_({ ok: true }); // same reply whether or not the link is valid
    }
    const stored = cache.get('acode:' + id), att = Number(cache.get('aatt:' + id) || 0);
    if (!open || !stored || att >= 5) { cache.remove('acode:' + id); return out_({ ok: false, error: 'invalid code' }); }
    cache.put('aatt:' + id, String(att + 1), 900);
    if (!same_(stored, hash_(id, String(d.code || '').trim()))) return out_({ ok: false, error: 'invalid code' });
    cache.remove('acode:' + id); cache.remove('aatt:' + id);
    const t = appToken_(id); audit_({ email: x[O_.EMAIL] }, 'applicantLogin', id, 'ok');
    return out_({ ok: true, token: t.token, exp: t.exp });
  }
  // signed-in applicant
  const id = appFromToken_(d.token), r = id ? findRow_(sh, 0, id) : 0; if (!r) return out_({ ok: false, error: 'unauthorized' });
  let x = onbRow_(sh, r); const who = String(x[O_.NAME]) + ' (applicant)', me = { email: x[O_.EMAIL] };
  if (['in progress', 'hired'].indexOf(String(x[O_.STATUS])) < 0) return out_({ ok: false, error: 'unauthorized' });
  if (act === 'applicantGet') return out_(hrState_(x));
  if (act === 'applicantDetails') {
    if (reqItems_(x) && reqItems_(x).indexOf('details') < 0) return out_({ ok: false, error: 'Your details were not requested.' });
    const inc = d.app || {}, lim = function (k) { return k.slice(-4) === 'Resp' || /Explain$/.test(k) ? 1500 : 200; };
    const fix = function (k) { let v = inc[k]; if (Array.isArray(v)) v = v.map(String).join(', '); if (v === true) v = 'Yes'; return String(v == null || v === false ? '' : v).trim().slice(0, lim(k)); };
    if ('firstName' in inc && !fix('firstName')) return out_({ ok: false, error: 'Enter your first name.' });
    if ('lastName' in inc && !fix('lastName')) return out_({ ok: false, error: 'Enter your last name.' });
    if ('phone' in inc && !fix('phone')) return out_({ ok: false, error: 'Enter your phone number.' });
    let n = 0;
    x = onbUpdate_(id, who, function (y) {
      const app = onbApp_(y), ch = [], cur = hrState_(y).app;
      APP_FIELDS_.forEach(function (f) {
        const k = f[0]; if (k === 'email' || k === 'ssn' || k === 'position' || !(k in inc)) return;
        const v = fix(k), old = String(cur[k] == null ? '' : cur[k]); if (v === old) return;
        ch.push({ k: k, l: f[1], o: old.slice(0, 80), n: v.slice(0, 80) }); if (v) app[k] = v; else delete app[k];
      });
      if (!ch.length) return;
      n = ch.length;
      const log = Array.isArray(app._log) ? app._log : []; log.push({ at: new Date().toISOString(), c: ch }); app._log = log.slice(-12);
      while (JSON.stringify(app).length > CELL_MAX_ - 50 && app._log.length > 1) app._log.shift();
      y[O_.APP] = JSON.stringify(app).slice(0, CELL_MAX_);
      const fn = app.firstName || cur.firstName, ln = app.lastName || cur.lastName; if (fn || ln) y[O_.NAME] = (fn + ' ' + ln).trim();
      if (app.phone) y[O_.PHONE] = app.phone;
    });
    audit_(me, 'applicantDetails', id, n + ' fields'); return out_(hrState_(x));
  }
  if (act === 'applicantSign') {
    const f = hrForms_(x).filter(function (q) { return q.k === d.form; })[0]; if (!f) return out_({ ok: false, error: 'unknown form' });
    if (onbDocs_(x).some(function (q) { return q.k === f.k; })) return out_({ ok: false, error: 'This form is already signed.' });
    const sig = sig_(d.sig); if (!sig) return out_({ ok: false, error: 'Please sign the form.' });
    const vals = d.fields || {}, rows = [];
    for (let i = 0; i < f.fields.length; i++) {
      const q = f.fields[i], v = q.type === 'check' ? (vals[q.id] === true ? 'Yes' : 'No') : String(vals[q.id] == null ? '' : vals[q.id]).trim().slice(0, 300);
      if (q.type === 'yn' && v !== 'Yes' && v !== 'No') return out_({ ok: false, error: 'Please answer Yes or No: ' + q.label.slice(0, 80) + '…' });
      if (q.req && !v) return out_({ ok: false, error: 'Please fill in: ' + q.label });
      rows.push('<tr><td style="width:42%"><b>' + esc_(q.label) + '</b></td><td>' + esc_(v) + '</td></tr>');
    }
    const body = '<h2>' + esc_(f.title) + '</h2>' + f.html + '<table class="g" style="margin-top:8px">' + rows.join('') + '</table>' +
      '<table class="sig" style="margin-top:12px"><tr><td><div class="k">Signature</div><img src="' + sig + '"><div>' + esc_(x[O_.NAME]) + '</div></td><td><div class="k">Date signed</div>' + today_() + '<div class="k" style="margin-top:6px">Signed electronically through the Comfort Hands new-hire page</div></td></tr></table>' + (f.post || '');
    const pdf = Utilities.newBlob(repHtml_(f.title, x[O_.NAME] + ' · ' + today_(), body), 'text/html', 'f.html').getAs('application/pdf').setName(f.title.replace(/[:\/]/g, ' -') + ' - ' + clean_(x[O_.NAME]) + ' - ' + today_() + '.pdf');
    const folder = onbFolder_(x), file = folder.createFile(pdf);
    x = onbUpdate_(id, who, function (y, steps, docs, tick) {
      if (!y[O_.FOLDER]) y[O_.FOLDER] = folder.getId();
      docs.push({ k: f.k, label: f.title, url: file.getUrl(), at: today_() });
      const has = {}; docs.forEach(function (q) { has[q.k] = true; });
      if (f.step !== 'bgforms' || (has.bg1 && has.bg2 && has.bg3 && has.bgnj)) tick(f.step);
    });
    audit_(me, 'applicantSign', id, f.k); return out_(hrState_(x));
  }
  if (act === 'applicantUpload') {
    const kind = String(d.kind || ''); if (!UPLOAD_KINDS_[kind]) return out_({ ok: false, error: 'unknown document' });
    if (onbDocs_(x).length >= 30) return out_({ ok: false, error: 'Too many files. Call the office.' });
    if (!throttle_('aup:' + id, 20, 3600)) return out_({ ok: false, error: 'Too many uploads. Try again later.' });
    let blob; try { blob = fileFrom_(d.file, UPLOAD_KINDS_[kind] + (d.docType ? ' - ' + String(d.docType).slice(0, 60) : '') + ' - ' + x[O_.NAME] + ' - ' + today_()); } catch (e) { return out_({ ok: false, error: String(e.message || e) }); }
    const folder = onbFolder_(x), file = folder.createFile(blob);
    x = onbUpdate_(id, who, function (y, steps, docs, tick) {
      if (!y[O_.FOLDER]) y[O_.FOLDER] = folder.getId();
      docs.push({ k: kind, label: UPLOAD_KINDS_[kind] + (d.docType ? ': ' + String(d.docType).slice(0, 60) : ''), url: file.getUrl(), at: today_() });
      const has = {}; docs.forEach(function (q) { has[q.k] = true; });
      if (has.ssncard && (has.i9a || (has.i9b && (has.i9c || has.ssncard)))) tick('ids');
      if (kind === 'contract') tick('contract');
      if (kind === 'w4') tick('w4');
    });
    audit_(me, 'applicantUpload', id, kind); return out_(hrState_(x));
  }
  return out_({ ok: false, error: 'unknown action' });
}

// reCAPTCHA v3: Google checks the visitor's token. Off (always true) until CONFIG.RECAPTCHA_SECRET is set. If Google cannot be reached the application is refused rather than let through.
function captchaOk_(token) {
  const secret = CONFIG.RECAPTCHA_SECRET; if (!secret) return true;
  if (!token || String(token).length > 4000) return false;
  try {
    const r = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'post', payload: { secret: secret, response: String(token) }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return false;
    const j = JSON.parse(r.getContentText());
    if (!j.success) return false;
    if (j.action && j.action !== 'apply') return false;
    if (typeof j.score === 'number' && j.score < (Number(CONFIG.RECAPTCHA_MIN_SCORE) || 0.5)) return false;
    return true;
  } catch (e) { return false; }
}

function applySubmit_(d) {
  if (d.website) return out_({ ok: true }); // hidden field that only automated senders fill in
  if (!captchaOk_(d.captcha)) return out_({ ok: false, error: 'We could not confirm you are not a robot. Please reload the page and try again, or call the office at 609-277-3032.' });
  const a = d.app || {}, app = {};
  APP_FIELDS_.forEach(function (f) { let v = a[f[0]]; if (Array.isArray(v)) v = v.map(String).join(', '); if (v === true) v = 'Yes'; app[f[0]] = String(v == null || v === false ? '' : v).trim().slice(0, f[0].slice(-4) === 'Resp' || /Explain$/.test(f[0]) ? 1500 : 200); });
  const email = app.email.toLowerCase(), bad = function (m) { return out_({ ok: false, error: m }); };
  if (!app.firstName || !app.lastName) return bad('Enter your first and last name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return bad('Enter a valid email address.');
  if (!app.phone) return bad('Enter your phone number.');
  if (HR_POSITIONS_.indexOf(app.position) < 0) return bad('Choose the position you are applying for.');
  if (app.consentEmployer !== 'Yes' && app.consentEmployer !== 'No') return bad('Answer the prior-employer authorization.');
  if (app.consentBackground !== 'Yes' && app.consentBackground !== 'No') return bad('Answer the background check authorization.');
  if (!throttle_('ap:all', 40, 3600) || !throttle_('ap:' + email, 3, 86400)) return bad('We could not take your application right now. Please call the office at 609-277-3032.');
  let resume = null; if (d.resume && d.resume.b64) { try { resume = fileFrom_(d.resume, 'Resume - ' + app.lastName + ', ' + app.firstName, true); } catch (e) { return bad(String(e.message || e)); } }
  const id = 'o' + Utilities.getUuid().replace(/-/g, '').slice(0, 14), name = app.firstName + ' ' + app.lastName, now = new Date().toISOString();
  // Application PDF (includes the Social Security number) goes to the restricted HR folder; the Sheet copy leaves it out.
  let html = '<h2>Careers - Application</h2>';
  APP_FIELDS_.forEach(function (f) { if (f[2]) html += (html.indexOf('<table') > 0 ? '</table>' : '') + '<h3>' + esc_(f[2]) + '</h3><table class="g">'; if (app[f[0]]) html += '<tr><td style="width:42%"><b>' + esc_(f[1]) + '</b></td><td>' + esc_(app[f[0]]) + '</td></tr>'; });
  html += '</table><p>Submitted online ' + today_() + '.</p>';
  const x = []; for (let i = 0; i < ONB_N_; i++) x.push('');
  x[O_.ID] = id; x[O_.NAME] = name; const folder = onbFolder_(x);
  const pdf = Utilities.newBlob(repHtml_('Job Application', name + ' · ' + today_(), html), 'text/html', 'a.html').getAs('application/pdf').setName('Application - ' + clean_(app.lastName) + ', ' + clean_(app.firstName) + ' - ' + today_() + '.pdf');
  const docs = [{ k: 'application', label: 'Application', url: folder.createFile(pdf).getUrl(), at: today_() }];
  if (resume) docs.push({ k: 'resume', label: 'Resume', url: folder.createFile(resume).getUrl(), at: today_() });
  const keep = {}; Object.keys(app).forEach(function (k) { if (k !== 'ssn' && app[k]) keep[k] = app[k]; });
  const steps = { app: { done: true, date: today_(), by: 'applicant', note: '' } };
  if (!jobDesc_(app.position)) steps.jobdesc = { done: true, date: today_(), by: 'system', note: 'not applicable to this position' };
  x[O_.EMAIL] = email; x[O_.PHONE] = app.phone; x[O_.STATUS] = 'in progress'; x[O_.STEPS] = JSON.stringify(steps); x[O_.CREATED] = now; x[O_.UPDATED] = now; x[O_.BY] = 'applicant';
  x[O_.POS] = app.position; x[O_.APP] = JSON.stringify(keep).slice(0, CELL_MAX_); x[O_.DOCS] = JSON.stringify(docs);
  withLock_(function () { onbSheet_().appendRow(safeRow_(x)); });
  audit_({ email: email }, 'applySubmit', id, app.position);
  try { MailApp.sendEmail({ to: CONFIG.OFFICE_EMAIL, subject: 'New job application: ' + name + ' (' + app.position + ')', body: name + ' applied for ' + app.position + '.\n\nOpen Staff Home, Admin tasks, to review the application and send the provisional offer.' }); } catch (e) {}
  try { MailApp.sendEmail({ to: email, replyTo: String(CONFIG.OFFICE_EMAIL).split(/[,;\s]+/)[0], subject: 'We received your application', body: 'Hello ' + app.firstName + ',\n\nThank you for applying to Comfort Hands Home Healthcare for the position of ' + app.position + '. We will review your application and contact you.\n\nComfort Hands Home Healthcare, LLC\n609-277-3032' }); } catch (e) {}
  return out_({ ok: true });
}

// Staff actions (admin only; called through records_ under the lock, except onbList).
function onb_(act, d, u) {
  const sh = onbSheet_(), who = u.name || u.email, now = new Date().toISOString();
  if (act === 'onbList') return out_({ ok: true, items: onbAll_(), steps: ONB_STEPS_.map(function (s) { return { k: s[0], l: s[1], auto: s[2] === 'auto' }; }), positions: HR_POSITIONS_, reqItems: REQ_LABELS_,
    setup: { contract: true, applyUrl: !!CONFIG.APPLY_URL, fcra: !!CONFIG.FCRA_SUMMARY_URL } });
  if (act === 'onbPacket') return out_({ ok: true, sections: packetSections_(d.position) });
  // Ask an employee (new, or an existing aide added from the tracker) for chosen items only, and email a link that lists just those.
  if (act === 'onbRequest') {
    let id = keyOf_(d.id), r = id ? findRow_(sh, 0, id) : 0, x, seen = {};
    const items = (Array.isArray(d.items) ? d.items : []).map(String).filter(function (k) { if (!REQ_LABELS_[k] || seen[k]) return false; seen[k] = 1; return true; });
    if (r) x = onbRow_(sh, r);
    else {
      const name = String(d.name || '').trim().slice(0, 100), em = String(d.email || '').trim().toLowerCase();
      if (!name || !/^\S+@\S+\.\S+$/.test(em)) return out_({ ok: false, error: 'An existing employee needs a name and a valid email address.' });
      const dup = onbAll_().filter(function (o) { return String(o.email).toLowerCase() === em; })[0]; if (dup) { id = dup.id; r = findRow_(sh, 0, id); x = onbRow_(sh, r); }
      else {
        id = 'o' + Utilities.getUuid().replace(/-/g, '').slice(0, 14); x = []; for (let i = 0; i < ONB_N_; i++) x.push('');
        const nm = name.split(/\s+/), ph = String(d.phone || '').slice(0, 30);
        x[O_.ID] = id; x[O_.NAME] = name; x[O_.EMAIL] = em; x[O_.PHONE] = ph; x[O_.STATUS] = 'in progress'; x[O_.CREATED] = now; x[O_.STEPS] = '{}';
        if (HR_POSITIONS_.indexOf(String(d.position)) >= 0) x[O_.POS] = d.position;
        x[O_.APP] = JSON.stringify({ _imported: true, firstName: nm[0], lastName: nm.slice(1).join(' '), phone: ph });
      }
    }
    if (!/^\S+@\S+\.\S+$/.test(String(x[O_.EMAIL]))) return out_({ ok: false, error: 'Add the employee’s email first.' });
    const app = onbApp_(x);
    if (items.length) app._req = { items: items, at: today_(), by: who, sentAt: (app._req && app._req.sentAt) || '' }; else delete app._req;
    if (d.send) {
      if (!items.length) return out_({ ok: false, error: 'Choose at least one item to request.' });
      if (!CONFIG.APPLY_URL) return out_({ ok: false, error: 'APPLY_URL is not set in Code.gs. It is the web address of the Apply page on your site.' });
      const first = String(x[O_.NAME]).split(/\s+/)[0], office = String(CONFIG.OFFICE_EMAIL).split(/[,;\s]+/)[0], link = String(CONFIG.APPLY_URL) + (String(CONFIG.APPLY_URL).indexOf('?') >= 0 ? '&' : '?') + 'a=' + x[O_.ID];
      MailApp.sendEmail({ to: x[O_.EMAIL], replyTo: office, subject: 'Comfort Hands Home Healthcare: items we need from you',
        body: ['Hello ' + first + ',', '', 'We need the following from you for your Comfort Hands file:', '', items.map(function (k) { return '  • ' + REQ_LABELS_[k]; }).join('\n'), '',
          'Open your personal page to complete them:', link, '', 'You will ask for a 6-digit code by email, then sign forms on screen and upload documents. Nothing else is needed.', 'Call us at 609-277-3032 with any questions.', '', 'Sincerely,', 'Comfort Hands Home Healthcare, LLC'].join('\n') });
      app._req.sentAt = today_(); x[O_.SENT] = today_();
    }
    x[O_.APP] = JSON.stringify(app).slice(0, CELL_MAX_); x[O_.UPDATED] = now; x[O_.BY] = who;
    if (r) sh.getRange(r, 1, 1, ONB_N_).setValues([safeRow_(x)]); else sh.appendRow(safeRow_(x));
    return out_({ ok: true, item: onbObj_(x), sent: !!d.send });
  }
  if (act === 'onbSave') {
    const name = String(d.name || '').trim().slice(0, 100), email = String(d.email || '').trim().toLowerCase();
    if (!name) return out_({ ok: false, error: 'name required' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return out_({ ok: false, error: 'bad email' });
    let id = keyOf_(d.id), r = id ? findRow_(sh, 0, id) : 0, x;
    if (r) x = onbRow_(sh, r); else { id = 'o' + Utilities.getUuid().replace(/-/g, '').slice(0, 14); x = []; for (let i = 0; i < ONB_N_; i++) x.push(''); x[O_.ID] = id; x[O_.STATUS] = 'in progress'; x[O_.CREATED] = now; }
    const steps = onbSteps_(x), inc = d.steps || {};
    ONB_STEPS_.forEach(function (s) {
      const k = s[0]; if (!(k in inc)) return; const n = inc[k] || {}, cur = steps[k] || {};
      if (n.done && !cur.done) { cur.done = true; cur.date = today_(); cur.by = who; } else if (!n.done) { cur.done = false; delete cur.date; delete cur.by; }
      cur.note = String(n.note || '').slice(0, 300); steps[k] = cur;
    });
    x[O_.NAME] = name; x[O_.EMAIL] = email; x[O_.PHONE] = String(d.phone || '').slice(0, 30); x[O_.STEPS] = JSON.stringify(steps); x[O_.UPDATED] = now; x[O_.BY] = who;
    if (HR_POSITIONS_.indexOf(String(d.position)) >= 0) x[O_.POS] = d.position;
    const st = String(d.status || x[O_.STATUS] || 'in progress'); x[O_.STATUS] = ['in progress', 'withdrawn', 'not hired', 'hired'].indexOf(st) >= 0 ? st : 'in progress';
    const all = onbAllDone_(steps);
    if (all && x[O_.STATUS] === 'in progress') x[O_.STATUS] = 'hired'; else if (!all && x[O_.STATUS] === 'hired') x[O_.STATUS] = 'in progress';
    if (r) sh.getRange(r, 1, 1, ONB_N_).setValues([safeRow_(x)]); else sh.appendRow(safeRow_(x));
    return out_({ ok: true, item: onbObj_(x) });
  }
  const id = keyOf_(d.id), r = findRow_(sh, 0, id); if (!r) return out_({ ok: false, error: 'not found' });
  const x = onbRow_(sh, r), steps = onbSteps_(x);
  const mark = function (k) { steps[k] = { done: true, date: today_(), by: who, note: (steps[k] && steps[k].note) || '' }; x[O_.STEPS] = JSON.stringify(steps); x[O_.UPDATED] = now; x[O_.BY] = who; };
  if (act === 'onbOffer' || act === 'onbSendForms') {
    if (!(steps.appReview && steps.appReview.done)) return out_({ ok: false, error: 'Mark the application review complete first.' });
    if (!/^\S+@\S+\.\S+$/.test(String(x[O_.EMAIL]))) return out_({ ok: false, error: 'Add the applicant’s email first.' });
    const rate = rateFor_(x[O_.POS]); if (!rate) return out_({ ok: false, error: 'Choose the applicant’s position first. Hourly rates are set for Certified Home Health Aide, PCA and Companion.' });
    if (!CONFIG.APPLY_URL) return out_({ ok: false, error: 'APPLY_URL is not set in Code.gs. It is the web address of the Apply page on your site.' });
    const att = [contractPdf_(x[O_.NAME], x[O_.POS], rate)];
    (CONFIG.ONBOARDING_FORMS || []).filter(function (f) { return f.id; }).forEach(function (f) { att.push(DriveApp.getFileById(id_(f.id)).getBlob().setName(f.name || 'form')); });
    const first = String(x[O_.NAME]).split(/\s+/)[0], office = String(CONFIG.OFFICE_EMAIL).split(/[,;\s]+/)[0], link = String(CONFIG.APPLY_URL) + (String(CONFIG.APPLY_URL).indexOf('?') >= 0 ? '&' : '?') + 'a=' + x[O_.ID];
    MailApp.sendEmail({ to: x[O_.EMAIL], replyTo: office, subject: 'Comfort Hands Home Healthcare: provisional offer of employment',
      body: ['Hello ' + first + ',', '', 'Thank you for applying to Comfort Hands Home Healthcare. We have reviewed your application and are pleased to offer you provisional employment' + (x[O_.POS] ? ' as ' + x[O_.POS] : '') + '.', '',
        'This offer is provisional. It is subject to a satisfactory background check and satisfactory reference checks, and to completing the new-hire steps below. A copy of your employment contract is attached for you to read. You will sign it on screen on your new-hire page; there is nothing to print or upload.', '',
        'Next step: open your personal new-hire page:', link, '', 'On that page you will ask for a 6-digit code by email, then review and sign your forms on screen, including your employment contract and Form W-4 (tax withholding), and upload your identification documents. Your details from the application are already filled in.', '', 'Form I-9 is completed at our office. Please bring the original identification documents you listed to your first visit, and we will finish it with you.', '',
        (CONFIG.ONBOARDING_NOTE || ''), 'Call us at 609-277-3032 with any questions.', '', 'Sincerely,', 'Comfort Hands Home Healthcare, LLC'].join('\n'), attachments: att });
    x[O_.OFFER] = today_(); mark('offer'); sh.getRange(r, 1, 1, ONB_N_).setValues([safeRow_(x)]);
    return out_({ ok: true, item: onbObj_(x), sent: att.length });
  }
  if (act === 'onbRef') {
    const id = keyOf_(d.id), r = id ? findRow_(sh, 0, id) : 0; if (!r) return out_({ ok: false, error: 'not found' });
    const slot = String(d.slot || ''); if (['1', '2', '3'].indexOf(slot) < 0) return out_({ ok: false, error: 'bad reference number' });
    const x0 = onbRow_(sh, r); if (onbDocs_(x0).some(function (q) { return q.k === 'ref' + slot; })) return out_({ ok: false, error: 'This reference check is already recorded.' });
    const t = function (k, n) { return String(d[k] == null ? '' : d[k]).trim().slice(0, n || 200); };
    const RATES = ['Excellent', 'Good', 'Fair'], items = [['perf', 'Job performance'], ['attend', 'Attendance'], ['coop', 'Cooperation'], ['init', 'Initiative'], ['health', 'Health']], rates = d.rates || {};
    for (let i = 0; i < items.length; i++) if (RATES.indexOf(rates[items[i][0]]) < 0) return out_({ ok: false, error: 'Rate every item: ' + items[i][1] + '.' });
    if (['Yes', 'No'].indexOf(String(d.rehire)) < 0) return out_({ ok: false, error: 'Answer "Would you rehire this individual?"' });
    if (!t('company') || !t('by')) return out_({ ok: false, error: 'Enter the company name and who completed the form.' });
    const row = function (a, b) { return '<tr><td style="width:34%"><b>' + esc_(a) + '</b></td><td>' + esc_(b) + '</td></tr>'; };
    const body = '<h2>Employment Reference Verification</h2><table class="g">' + row('Applicant', x0[O_.NAME]) + row('Company name and address', t('company') + (t('address') ? ', ' + t('address') : '')) + row('Employee’s position', t('position')) + row('Employed from / to', t('from') + ' to ' + t('to')) + '</table>' +
      '<h3>Ratings</h3><table class="g">' + items.map(function (q) { return row(q[1], rates[q[0]]); }).join('') + '</table><h3>Comments</h3><table class="g">' + row('Comments', t('comments', 1000)) + row('Strengths', t('strengths', 600)) + row('Weaknesses', t('weaknesses', 600)) + row('Would you rehire this individual?', String(d.rehire)) + '</table>' +
      '<h3>Completed by</h3><table class="g">' + row('Name', t('by')) + row('Title', t('title')) + row('How it was verified', t('how')) + row('Recorded by (Comfort Hands)', who + ' on ' + today_()) + '</table>' +
      '<p style="margin-top:8px">The applicant’s signed authorization to release this information is on file (Employment Reference Verification: Applicant Authorization).</p>';
    const pdf = Utilities.newBlob(repHtml_('Reference check', x0[O_.NAME] + ' · ' + today_(), body), 'text/html', 'ref.html').getAs('application/pdf').setName('Reference Check ' + slot + ' - ' + clean_(x0[O_.NAME]) + ' - ' + clean_(t('company', 40)) + ' - ' + today_() + '.pdf');
    const folder = onbFolder_(x0), file = folder.createFile(pdf);
    const x = onbUpdate_(id, who, function (y, steps, docs, tick) {
      if (!y[O_.FOLDER]) y[O_.FOLDER] = folder.getId();
      docs.push({ k: 'ref' + slot, label: 'Reference check ' + slot + ': ' + t('company', 40), url: file.getUrl(), at: today_() });
      const n = docs.filter(function (q) { return /^ref[123]$/.test(q.k); }).length; if (n >= 2) tick('refs', n + ' references recorded');
    });
    audit_(u, 'onbRef', id, 'ref' + slot); return out_({ ok: true, item: onbObj_(x) });
  }
  if (act === 'onbActivate') {
    const email = String(x[O_.EMAIL]); if (!/^\S+@\S+\.\S+$/.test(email)) return out_({ ok: false, error: 'Add the aide’s email first.' });
    const us = usersSheet_(), ur = findRowCI_(us, email);
    if (!ur) us.appendRow([email, txt_(x[O_.NAME]), 'x' + Utilities.getUuid(), 'aide', true, now]);
    else { const roles = String(us.getRange(ur, 4).getValue() || '').toLowerCase().split(/[\s,;]+/).filter(Boolean); if (roles.indexOf('aide') < 0) { roles.push('aide'); us.getRange(ur, 4).setValue(roles.join(',')); } }
    try { MailApp.sendEmail({ to: email, replyTo: String(CONFIG.OFFICE_EMAIL).split(/[,;\s]+/)[0], subject: 'Your Comfort Hands employee portal account',
      body: 'Hello ' + String(x[O_.NAME]).split(/\s+/)[0] + ',\n\nYour employee portal account is ready. Open the employee portal' + (CONFIG.STAFF_PORTAL_URL ? ' (' + CONFIG.STAFF_PORTAL_URL + ')' : '') + ', choose "Forgot password", enter this email address, and use the 6-digit code we send you to choose your password.\n\nComfort Hands Home Healthcare, LLC  609-277-3032' }); } catch (e) {}
    try { const ap = onbObj_(x).app || {}; if (!trkMap_()[email.toLowerCase()]) trkUpsert_(email, { position: String(x[O_.POS] || ''), phone: String(x[O_.PHONE] || '').replace(/[^\d+]/g, ''), smsOk: ap.consentSms === 'Yes', hireDate: today_() }, who); } catch (e) {}
    mark('portal'); if (onbAllDone_(steps)) x[O_.STATUS] = 'hired';
    sh.getRange(r, 1, 1, ONB_N_).setValues([safeRow_(x)]); return out_({ ok: true, item: onbObj_(x) });
  }
  return out_({ ok: false, error: 'unknown action' });
}

/* ───────── employment contract (built per applicant) ───────── */
function rateFor_(pos) {
  const p = String(pos || '');
  if (/companion/i.test(p)) return 17;
  if (/home health aide|chha|personal care|pca/i.test(p)) return 18;
  return 0;
}
function contractBody_(nameH, posH, payH, note) {
  const P = function (t) { return '<p>' + t + '</p>'; }, H = function (t) { return '<h3>' + esc_(t) + '</h3>'; };
  return '<h2>Provisional Employment Agreement</h2>' +
    P('This Agreement is between Comfort Hands Home Healthcare LLC (the "Agency") and the person named below (the "Employee").') +
    P('<b>Employee name:</b> ' + nameH + ' &nbsp;&nbsp; <b>Start date:</b> ______________________') +
    H('1. Position and rate of pay') + P('The Employee is offered the position of <b>' + posH + '</b>' + note + ', paid <b>' + payH + '</b>.') +
    P('The rate applies to hours worked. It may be changed in writing with advance notice, and any change applies only to future hours.') +
    H('2. Payroll') + P('The Agency pays <b>every two weeks (biweekly)</b> through its payroll provider. Pay is for hours recorded and approved in the Agency\'s timekeeping and electronic visit verification systems. Taxes and any other required deductions are withheld by law. Hours must be recorded accurately and on time. The Employee is classified as non-exempt and is paid overtime as required by New Jersey and federal law.') +
    H('3. Provisional employment') + P('This offer is <b>provisional</b>. Employment is <b>subject to a positive background check and positive reference checks</b>, completed to the Agency\'s satisfaction and as required by New Jersey law and Medicaid program rules. The Agency may withdraw this offer, or end employment, if these checks are not satisfactory. The Employee must not be assigned to a patient until the checks are complete. Background checks are carried out under the Fair Credit Reporting Act and the New Jersey Opportunity to Compete Act, and the Employee will receive any notice or review the law requires before a decision based on the results.') +
    H('4. Conditions of employment') + P('Employment also depends on the Employee providing, before the first assignment:') +
    '<ul><li>Proof of identity and authorization to work in the United States (Form I-9, within three business days of starting) and a completed Form W-4.</li><li>A valid, current certification or license for the position, where one is required, kept current throughout employment.</li><li>A completed physical examination and required health screenings.</li><li>Completion of orientation, in-service education and competency evaluation required for the position.</li><li>Signed Agreement of Standards, job description acknowledgment and reference and background authorizations.</li></ul>' +
    H('5. Duties and standards') + P('The Employee will perform the duties in the signed job description, follow each patient\'s plan of care and the instructions of the supervising nurse, and work only within the scope of the position. The Employee will treat patients with dignity, report changes in a patient\'s condition and any incident promptly, and follow the Agency\'s policies and the Agreement of Standards.') +
    H('6. Confidentiality') + P('The Employee will keep all patient and Agency information private under HIPAA and the Agency\'s policies, during and after employment, and will not share it except as required to provide care or by law. Patient information may be used only for work purposes.') +
    H('7. Patient relationships') + P('The Employee will not accept gifts, money or loans from patients or families, will not take patient property, and will not arrange private work with Agency patients outside the Agency during employment.') +
    H('8. At-will employment') + P('Employment is at will. Either the Employee or the Agency may end it at any time, with or without cause or notice. The Agency asks for at least two weeks\' notice of resignation where possible. Nothing in this Agreement promises a minimum number of hours or a fixed term. Hours depend on patient assignments and authorized services.') +
    H('9. Leave and benefits') + P('The Employee earns paid sick leave as required by New Jersey law. No other benefits are promised by this Agreement.') +
    H('10. Whole agreement') + P('This Agreement, together with the signed forms listed in Section 4 and the Agency\'s written policies, is the entire agreement about this employment. Changes must be in writing and signed by the Agency. If any part is found unenforceable, the rest stays in effect. New Jersey law applies.') +
    H('Signatures') + P('By signing, the Employee confirms they have read and understood this Agreement and accept this provisional offer.') +
    P('<b>Employee signature:</b> ______________________________ &nbsp; <b>Date:</b> ______________') + P('<b>Printed name:</b> ' + nameH) +
    P('<b>For Comfort Hands Home Healthcare LLC:</b> ______________________________ &nbsp; <b>Date:</b> ______________') + P('<b>Name and title:</b> ______________________________');
}
function contractPdf_(name, pos, rate) {
  const body = contractBody_(esc_(name), esc_(pos), '$' + Number(rate).toFixed(2) + ' per hour', ' (the position selected on the online application)');
  return Utilities.newBlob(repHtml_('Employment Agreement', name + ' · ' + today_(), body), 'text/html', 'c.html').getAs('application/pdf').setName('Provisional Employment Agreement - ' + clean_(name) + '.pdf');
}

/* ───────── printable paper packet (for applicants without internet) ───────── */
const PK_APP_ = [
  ['Demographic Information', [['First name'], ['Last name'], ['Email'], ['Phone / mobile'], ['Social Security number'], ['Date of birth'],
    ['US residency status', 'o', ['US citizen', 'Noncitizen national', 'Permanent Resident', 'Alien with work permit']],
    ['Current address: line 1', 'w'], ['Line 2'], ['City'], ['State'], ['Zip code'], ['Country'],
    ['Previous address: line 1', 'w'], ['Line 2'], ['City'], ['State'], ['Zip code'], ['Country']]],
  ['Position and Availability', [['Position applied for', 'o', ['Certified Home Health Aide', 'Live-In Certified Home Health Aide', 'Certified Nursing Assistant', 'Personal Care Assistant (PCA)', 'Companion', 'Licensed Practical Nurse (LPN)', 'Registered Nurse (RN)', 'RN Clinical Supervisor', 'Director of Nursing', 'Staffing Coordinator', 'Office Support Staff', 'Marketing Executive']],
    ['Date available to start'], ['Available to work', 'o', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']], ['Means of transportation', 'o', ['Public transport', 'Own car']], ['Languages spoken in addition to English', 'o', ['Spanish', 'Creole', 'French', 'Other']], ['Other language']]],
  ['License and Certifications', [['License type', 'o', ['CHHA', 'CNA', 'LPN', 'RN', 'Other']], ['License / certification no.'], ['Issuing authority / board'], ['Expiration date'],
    ['Has your professional license been suspended, revoked or under investigation?', 'yn'], ['If yes, please explain', 'a'], ['Additional certifications', 'o', ['PALS', 'CPR', 'BCLS', 'ACLS']], ['Expiration dates (PALS / CPR / BCLS / ACLS)', 'w']]],
  ['Employment History', [['Current / most recent employer', 'w'], ['Address'], ['City, state, zip'], ['Job title'], ['Responsibilities', 'a'], ['Still work here?', 'yn'], ['Start date'], ['End date'], ['Supervisor’s name'], ['Supervisor’s phone'], ['Reason(s) for leaving', 'w'],
    ['May we contact your current / previous employers?', 'yn'], ['Previous employer', 'w'], ['Address'], ['City, state, zip'], ['Job title'], ['Responsibilities', 'a'], ['Start date'], ['End date']]],
  ['Personal / Criminal Records', [['Have you ever been convicted of any crime?', 'yn'], ['If yes, explain', 'a']]],
  ['Education History', [['Highest level of education', 'o', ['Bachelor’s or higher', 'Associate’s', 'GED', 'Other']], ['Graduation date'], ['School name', 'w'], ['School address'], ['City, state, zip'], ['Malpractice insurance provider'], ['Policy number']]],
  ['References', [['Reference 1: name'], ['Title'], ['Address'], ['Telephone / email'], ['Reference 2: name'], ['Title'], ['Address'], ['Telephone / email'], ['Reference 3: name'], ['Title'], ['Address'], ['Telephone / email']]]
];
function pkField_(f) {
  const t = f[1] || 'l', lab = esc_(f[0]);
  if (t === 'o') return '<div class="f w"><span class="lb">' + lab + '</span><div class="op">' + f[2].map(function (o) { return '<span>☐ ' + esc_(o) + '</span>'; }).join('') + '</div></div>';
  if (t === 'yn') return '<div class="f w"><span class="lb">' + lab + '</span><div class="op"><span>☐ Yes</span><span>☐ No</span></div></div>';
  if (t === 'a') return '<div class="f w"><span class="lb">' + lab + '</span><i></i><i></i></div>';
  return '<div class="f' + (t === 'w' ? ' w' : '') + '"><span class="lb">' + lab + '</span><i></i></div>';
}
function pkBlank_(fields) {
  return '<div class="g2">' + fields.map(function (q) {
    if (q.type === 'check') return '<div class="f w"><span class="op"><span>☐ ' + esc_(q.label) + '</span></span></div>';
    if (q.type === 'yn') return '<div class="f w"><span class="lb">' + esc_(q.label) + '</span><div class="op"><span>☐ Yes</span><span>☐ No</span></div></div>';
    return '<div class="f' + (String(q.label).length > 38 ? ' w' : '') + '"><span class="lb">' + esc_(q.label) + '</span><i></i></div>';
  }).join('') + '</div>';
}
function pkSign_(label) {
  return '<div class="sg"><div><i></i><span class="lb">' + esc_(label || 'Employee signature') + '</span></div><div><i></i><span class="lb">Printed name</span></div><div class="d"><i></i><span class="lb">Date</span></div></div>';
}
// Sections in print order. The browser adds the Form W-4 and Form I-9 pages, which are images of the government forms.
function packetSections_(position) {
  const sec = [], blank = []; for (let i = 0; i < ONB_N_; i++) blank.push('');
  blank[O_.POS] = jobDesc_(position) ? position : 'Companion';
  sec.push({ title: 'Application for Employment', note: 'Print clearly in ink. Fields marked with the agency’s requirements must be answered.',
    html: PK_APP_.map(function (g) { return '<h3>' + esc_(g[0]) + '</h3><div class="g2">' + g[1].map(pkField_).join('') + '</div>'; }).join('') +
      '<h3>Resume</h3><p>Attach a copy of your resume to this packet, if you have one.</p>' +
      '<h3>Consent and Authorizations</h3><p>' + esc_('I hereby authorize Comfort Hands Home Health Care LLC to request and receive from all prior employers within one year of the date of this application, any and all pertinent information concerning my prior employment and its termination, including the reason for such termination.') + '</p><p>☐ Yes &nbsp; ☐ No</p>' +
      '<p>' + esc_('In connection with my application for employment with Comfort Hands Home Health Care LLC. I authorize the agency or its agents to procure a consumer report and/or investigative consumer report about my background, character or reputation, including, but not limited to, information as to my employment, education, consumer credit history (consumer credit history will only be verified if appropriate for certain job descriptions), driving record, social security number verification, criminal record, and/or other public records history. I authorize all persons to fully disclose information relevant to this investigation. I release from liability all persons, companies, and governmental or other agencies disclosing such information. I further authorize that a photocopy of this authorization may be considered as an original.') + '</p><p>☐ Yes &nbsp; ☐ No</p>' +
      '<p>' + esc_('I agree to receive text messages (SMS) from Comfort Hands Home Healthcare, LLC at the mobile number on this application. The messages are about my work: shift and clock-in/clock-out reminders, scheduling updates, and reminders about my employment compliance requirements and due dates (such as annual health requirements and certification renewals). Messages never include patient information. Message frequency varies. Message and data rates may apply. Reply STOP at any time to opt out, or HELP for help. Privacy Policy and Terms: comforthands.net/privacy and comforthands.net/terms.') + '</p><p>☐ Yes &nbsp; ☐ No</p>' +
      '<p class="eeo">' + esc_('As required by federal and state law, we are an equal opportunity employer and manage our per diem employment and employee relations practices without discrimination based on race, age, color, religion, national origin, medical condition, marital status, sex, citizenship status, ancestry, sexual orientation, creed, disability, or handicap. Our company will comply with all relevant state mandates. I acknowledge that Comfort Hands Home Healthcare is a per diem employer.') + '</p>' + pkSign_('Applicant signature') });
  const both = !jobDesc_(position);
  hrForms_(blank).forEach(function (f) {
    if (f.k === 'contract') return;
    if (f.k === 'refrelease') f.html = f.html.replace(/<p><b>Former employers listed[\s\S]*?<\/ul>/, '');
    sec.push({ title: f.title, html: (f.k.indexOf('bg') === 0 && f.k !== 'bgnj' ? '<div style="font-size:9px;line-height:1.28">' : '<div>') + f.html + pkBlank_(f.fields.filter(function (q) { return q.id !== 'print' || f.k === 'standards'; })) + pkSign_('Signature') + (f.post || '') + '</div>' });
    if (f.k === 'jobdesc' && both) sec.push({ title: HR_JOB_TITLE_CHHA_, html: HR_JOB_CHHA_ + pkBlank_(f.fields.filter(function (q) { return false; })) + pkSign_('Signature') });
  });
  sec.push({ title: 'Provisional Employment Agreement', html: contractBody_('______________________________', '☐ Certified Home Health Aide (CHHA) / Personal Care Assistant (PCA) &nbsp;&nbsp; ☐ Companion', '$18.00 per hour for Certified Home Health Aide (CHHA) and Personal Care Assistant (PCA), or $17.00 per hour for Companion, as checked above', '') });
  sec.push({ title: 'Physical Examination', html: '<p><b>Date:</b> ________________ &nbsp; <b>Employee’s name:</b> ______________________________ &nbsp; <b>D.O.B.:</b> ________________</p><p>☐ Pre-employment &nbsp; ☐ Annual</p><p><b>First Mantoux:</b> ________________ &nbsp; <b>Second Mantoux:</b> ________________ &nbsp; <b>Chest X-ray:</b> ________________</p>' +
    '<table class="gx">' + ['Weight', 'Height', 'Blood pressure', 'Hernia', 'Free from contagious disease', 'Eyes', 'Ears', 'Throat', 'Extremities', 'Skin', 'Heart', 'Chest', 'Abdomen'].map(function (r) { return '<tr><td style="width:34%"><b>' + r + '</b></td><td>&nbsp;</td></tr>'; }).join('') + '</table>' +
    '<h3>Back assessment</h3><p><b>Limitations:</b> ☐ No &nbsp; ☐ Yes &nbsp; If yes, explain limitations: ______________________________________________</p>' +
    '<p style="margin-top:18px"><b>Nurse’s signature:</b> ______________________________</p><p><b>Name of provider (print):</b> ______________________________</p><p><b>Provider signature:</b> ______________________________</p><p class="eeo">Comfort Hands Home Health Care LLC is an Equal Employment Opportunity employer.</p>' });
  const ORI_ALL_ = ['Tour of office', 'Introduction to Agency employees', 'Completion of all employment forms', 'General orientation to the organization: agency philosophy and mission', 'Review of organizational chart', 'Human Resource Process: Attendance, Dress Code, Job descriptions, Evaluations, Payroll Procedure', 'Scope of services provided by the agency: Home Maker, Home-Health Aide and Skilled', 'Confidentiality Plan, Emergency Plan, On Call Procedure, Disaster Plan', 'Patient referrals', 'Ethics: complaint process', 'Safety review (in office), Drug free work place', 'HIPAA: Video, Testing, Patient privacy right policy'];
  const ORI_FIELD_ = ['Human Resource Process: License/Certification validation, Health Requirements, Supervisory Visits (clinical and administrative), Attendance, Staffing, Dress Code, Job Descriptions, Competency, Evaluations, HHA In-service Education, IHSN Continuing Education', 'Scope of services provided by the agency: Home Maker, Home-Health Aide', 'Introduction to home care for employees who do not have home care experience', 'HHA: Plan of Care/Activity Sheet, documentation', 'HHA: review of general patient and environmental changes that require an immediate report by phone', 'IHSN: responsibility for communication among field nurses on multi-shift cases', 'Home safety issues', 'Review of Exposure Control Policy (identification, handling, and disposal of hazardous or infectious materials)', 'Bloodborne Pathogens/Infection Control and Universal Precautions', 'Patient Abuse, elder, child &amp; domestic violence', 'Review of clinical forms and documentation', 'Patients Rights and Responsibilities, Advance Directive', 'Quality Improvement, Risk Management'];
  const oriList = function (a) { return '<ul class="chk">' + a.map(function (t) { return '<li>☐ &nbsp;' + t.replace(/&(?!amp;)/g, '&amp;') + '</li>'; }).join('') + '</ul>'; };
  sec.push({ title: 'New Employee Orientation Guideline / Checklist',
    html: '<div class="g2"><div class="f"><span class="lb">Name</span><i></i></div><div class="f"><span class="lb">Position</span><i></i></div></div>' +
      '<h3>Check (✓) for all employees</h3>' + oriList(ORI_ALL_) + '<h3>All field staff (HHAs, field nurses and supervisory personnel)</h3>' + oriList(ORI_FIELD_) +
      '<div class="sg" style="grid-template-columns:2fr 1fr"><div><i></i><span class="lb">Employee signature</span></div><div class="d"><i></i><span class="lb">Date</span></div></div>' +
      '<div class="sg" style="grid-template-columns:2fr 1fr"><div><i></i><span class="lb">Instructor signature</span></div><div class="d"><i></i><span class="lb">Date</span></div></div>' });
  return sec;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function clean_(s) { return String(s || '').replace(/[\\\/:*?"<>|]/g, '').trim(); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml_(d) {
  const css =
    'body{font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#111;line-height:1.42}' +
    'h1{font-size:17px;margin:0;color:#34182d}' +
    'h2{font-size:14px;margin:0 0 6px;padding:5px 7px;background:#34182d;color:#fff}' +
    'h3,.sh{font-size:11px;margin:10px 0 4px;padding:3px 6px;background:#f3e6f7;color:#34182d;font-weight:bold}' +
    '.tag{font-size:9px;color:#555;text-transform:uppercase;margin-bottom:2px}' +
    '.brk{page-break-before:always}tr,.rights-box,.act-card,.chk-item,.sig{page-break-inside:avoid}h2,h3,.sh{page-break-after:avoid}' +
    'table{width:100%;border-collapse:collapse}' +
    'table.gt td{vertical-align:top;padding:2px 6px 4px 0}' +
    'table.atable td,table.atable th,table.mtable td,table.mtable th{border:1px solid #bbb;padding:3px 4px;vertical-align:top;font-size:9.5px}' +
    'th{background:#f1f1f1;text-align:left}' +
    '.lbl{display:block;font-size:8px;color:#666;text-transform:uppercase;font-weight:bold}' +
    '.val{display:block;border-bottom:1px solid #999;min-height:12px;font-size:10.5px;padding-bottom:1px}' +
    'td .val,th .val{border-bottom:none;display:inline}' +
    '.cb{font-family:Courier New,monospace;font-weight:bold;margin-right:3px}' +
    '.rrow{margin:2px 0}.rbtn,.act-opt,.act-day{margin-right:10px;display:inline}' +
    '.chk-item{margin:3px 0}.chk-item div{display:inline}.chk-label{font-weight:bold}.chk-desc{display:block;color:#444;font-size:9px}' +
    '.rights-box{border:1px solid #cfcfcf;padding:5px 7px;margin:6px 0}.rights-box h3{background:none;padding:0;margin:0 0 3px;color:#111}' +
    '.psl{font-size:8px;color:#666;text-transform:uppercase;font-weight:bold}.psv{margin-bottom:4px;font-size:10.5px}' +
    '.act-card{border:1px solid #cfcfcf;padding:4px 6px;margin:4px 0}.act-num{font-weight:bold;margin-right:4px}' +
    'ul,ol{padding-left:16px;margin:3px 0}p{margin:3px 0}' +
    '.sig td{vertical-align:top;padding:6px;width:50%}.sk{color:#555;font-weight:bold;font-size:9px;text-transform:uppercase;margin-bottom:3px}';

  let body = pdfHdr_('Signed Admission Packet', 'patient', { name: String(d.patientFirst || '') + ' ' + String(d.patientLast || ''), dob: d.dob || d.patientDob || '', date: d.signDate || '' });

  const forms = d.forms || [];
  if (forms.length) {
    forms.forEach(function (f, i) {
      // every section starts on its own page; a section is never begun part-way down a page another section is using
      const newRole = i > 0 && f.tag !== forms[i - 1].tag;
      body += '<div class="' + (i > 0 ? 'brk' : '') + '">' + (i === 0 || newRole ? '<div class="tag">' + esc_(f.tag) + '</div>' : '') + safeHtml_(f.html) + '</div>';
    });
  } else {
    // Fallback (older portal): simple label/value tables.
    const sections = {}, order = [];
    (d.entries || []).forEach(function (f) { if (!sections[f.s]) { sections[f.s] = []; order.push(f.s); } sections[f.s].push(f); });
    order.forEach(function (sec) {
      body += '<h3>' + esc_(sec) + '</h3><table>' + sections[sec].map(function (f) {
        return '<tr><td style="width:36%;color:#555">' + esc_(f.l) + '</td><td>' + esc_(f.c ? (f.d != null ? f.d : f.v) : f.v) + '</td></tr>';
      }).join('') + '</table>';
    });
  }

  body += '<div class="brk"><h2>Signatures</h2><table class="sig"><tr>' +
    '<td><div class="sk">Patient / Representative</div>' +
      (sig_(d.patientSignature) ? '<img src="' + sig_(d.patientSignature) + '" style="height:70px">' : '<i>missing</i>') +
      '<div>' + esc_(d.signedBy) + (d.relationship ? ' (' + esc_(d.relationship) + ')' : '') + '</div></td>' +
    '<td><div class="sk">Nurse Witness</div>' +
      (sig_(d.nurseSignature) ? '<img src="' + sig_(d.nurseSignature) + '" style="height:70px">' : '<i>not signed</i>') + '</td>' +
    '</tr></table><div>Signed: ' + esc_(d.signDate) + ' &nbsp; Submitted: ' + esc_(d.submittedAt) + '</div></div>';

  return '<html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + body + '</body></html>';
}

// Pre-visit copy: Consents & Rights + Service Agreement, emailed to the patient.
function sendCopy_(d) {
  if (!/^\S+@\S+\.\S+$/.test(String(d.to || ''))) return { ok: false, error: 'bad email' };
  const last = clean_(d.patientLast) || 'Unknown', first = clean_(d.patientFirst) || 'Patient';
  const day = Utilities.formatDate(new Date(d.submittedAt || Date.now()), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const html = '<html><head><meta charset="utf-8"><style>' + PDF_CSS_ + '</style></head><body>' +
    pdfHdr_('Admission Documents \u2014 Copy for Your Records', 'patient', { name: String(d.patientFirst || '') + ' ' + String(d.patientLast || ''), dob: d.dob || d.patientDob || '', date: day }) + safeHtml_(d.html) + '</body></html>';
  const fileName = 'Pre-visit copy - ' + last + ', ' + first + ' - ' + day + '.pdf';
  const pdf = Utilities.newBlob(html, 'text/html', 'copy.html').getAs('application/pdf').setName(fileName);
  const folder = ptFolder_(d.patientId, last + ', ' + first);
  const file = folder.createFile(pdf);
  const attachments = [pdf];
  const extras = CONFIG.EXTRA_ATTACHMENTS.filter(function (a) { return a.id; });
  for (let i = 0; i < extras.length; i++) {
    try { attachments.push(pdfBlob_(extras[i].id, extras[i].name)); }
    catch (err) { return { ok: false, error: String(err) }; }
  }
  MailApp.sendEmail({
    to: d.to,
    subject: 'Your Comfort Hands Home Healthcare admission documents',
    body: 'Hello ' + first + ',\n\nAttached is a copy of your Consents & Rights and Client Service Agreement' + (extras.length ? ', along with the New Jersey Advance Directive and the Consumer’s Guide to Homemaker Home Health Aide Services' : '') + '. ' +
          'Please read them before your nurse’s visit. Your nurse will answer any questions and ask for your signature after the assessment.\n\n' +
          'Questions? Call us at 609-277-3032.\n\nComfort Hands Home Healthcare, LLC',
    attachments: attachments
  });
  return { ok: true, url: file.getUrl() };
}

// Welcome email to the patient with a copy of the signed Client Service Agreement.
function sendWelcome_(d, first, last, day, folder) {
  const agreement = (d.docs && d.docs['Service Agreement']) || '<p>Service Agreement text unavailable.</p>';
  const sigBlock =
    '<div style="margin-top:16px;border-top:2px solid #333;padding-top:8px"><b>Signed by:</b> ' + esc_(d.signedBy) +
    (d.relationship ? ' (' + esc_(d.relationship) + ')' : '') + ' &nbsp; <b>Date:</b> ' + esc_(d.signDate) + '<br>' +
    (sig_(d.patientSignature) ? '<img src="' + sig_(d.patientSignature) + '" style="height:70px">' : '') +
    (sig_(d.nurseSignature) ? '<div><b>Nurse witness:</b><br><img src="' + sig_(d.nurseSignature) + '" style="height:60px"></div>' : '') + '</div>';
  const html = '<html><head><meta charset="utf-8"><style>' + PDF_CSS_ + '</style></head><body>' +
    pdfHdr_('Client Service Agreement', 'patient', { name: String(d.patientFirst || '') + ' ' + String(d.patientLast || ''), dob: d.dob || d.patientDob || '', date: String(d.signDate || day) }) + safeHtml_(agreement) + sigBlock + '</body></html>';
  const pdf = Utilities.newBlob(html, 'text/html', 'agreement.html').getAs('application/pdf')
    .setName('Signed Service Agreement - ' + last + ', ' + first + ' - ' + day + '.pdf');
  folder.createFile(pdf);
  const body = [
    'Dear ' + first + ',', '',
    'Welcome to Comfort Hands Home Healthcare! We are glad to be caring for you.', '',
    'Attached are our welcome letter and a copy of the Client Service Agreement you signed. Questions? Call us at 609-277-3032.', '',
    'Sincerely,', 'Abigail Ayitiah, MSN, APRN, A-GNP-C', 'Administrator', 'Comfort Hands Home Healthcare, LLC'
  ].join('\n');
  const wAttach = [pdf];
  if (CONFIG.WELCOME_LETTER_FILE_ID) {
    wAttach.unshift(pdfBlob_(CONFIG.WELCOME_LETTER_FILE_ID,'Welcome Letter - Comfort Hands Home Healthcare.pdf'));
  }
  MailApp.sendEmail({
    to: d.patientEmail,
    subject: 'Welcome to Comfort Hands Home Healthcare',
    body: body,
    attachments: wAttach
  });
}

// Accepts a bare Drive ID or a pasted link tail like '<id>/edit?tab=t.0' and returns just the ID.
function id_(s) { return String(s || '').split(/[\/?#]/)[0].trim(); }

/**
 * TEST: run this from the Apps Script editor (select testSend → Run). Sends sample emails to YOU (the account running it),
 * saves sample PDFs under "Testpatient, Sample" in the Drive folder, and logs the results (View → Logs / Execution log).
 * Delete the "Testpatient, Sample" folder afterwards.
 */
function testToken_() {
  if (!CONFIG.USERS.length) throw new Error('Add at least one user to CONFIG.USERS first.');
  return makeToken_(findUser_(CONFIG.USERS[0].email)).token;
}
function testSend() {
  const me = Session.getActiveUser().getEmail() || String(CONFIG.OFFICE_EMAIL).split(',')[0];
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const now = new Date().toISOString();
  const packet = {
    token: testToken_(), submittedAt: now,
    patientFirst: 'Sample', patientLast: 'Testpatient', patientEmail: me,
    signedBy: 'Sample Testpatient', relationship: 'Self', signDate: now.slice(0, 10),
    ordered: ['2. Bathing', '7. Ambulation'],
    entries: [
      { s: 'Admin · Patient Info', l: 'First Name', v: 'Sample' },
      { s: 'Admin · Patient Info', l: 'Last Name', v: 'Testpatient' },
      { s: 'Nurse · Care Plan', l: 'Frequency', v: '5x/week, 2 hrs/visit' }
    ],
    docs: { 'Service Agreement': '<h2>Client Service Agreement (TEST)</h2><p>This is a test copy of the Service Agreement.</p>' },
    patientSignature: png, nurseSignature: png
  };
  Logger.log('Packet + welcome: ' + doPost({ postData: { contents: JSON.stringify(packet) } }).getContent());
  const copy = { token: testToken_(), action: 'patientCopy', to: me, patientFirst: 'Sample', patientLast: 'Testpatient',
                 html: '<h2>Pre-visit copy (TEST)</h2><p>Consents &amp; Rights and Service Agreement would appear here.</p>', submittedAt: now };
  Logger.log('Pre-visit copy: ' + doPost({ postData: { contents: JSON.stringify(copy) } }).getContent());
}

// Faxes the Physician Order Request through MetroFax email-to-fax (<number>@metrofax.com).
// The sending Google account's address must be allowed to send in your MetroFax account.
function sendFax_(d) {
  const num = String(d.fax || '').replace(/\D/g, '');
  if (!/^1\d{10}$/.test(num)) return { ok: false, error: 'bad fax number' };
  const last = clean_(d.patientLast) || 'Unknown', first = clean_(d.patientFirst) || 'Patient';
  const day = Utilities.formatDate(new Date(d.submittedAt || Date.now()), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const html = '<html><head><meta charset="utf-8"><style>' + PDF_CSS_ + 'table{width:100%}td,th{vertical-align:top;padding:2px 4px}</style></head><body>' + safeHtml_(d.html) + '</body></html>';
  const pdf = Utilities.newBlob(html, 'text/html', 'fax.html').getAs('application/pdf').setName('Physician Order - ' + last + ', ' + first + ' - ' + day + '.pdf');
  const folder = ptFolder_(d.patientId, last + ', ' + first);
  const file = folder.createFile(pdf);
  // MetroFax puts the email subject and body on the fax cover page, so keep both free of patient details.
  MailApp.sendEmail({
    to: num + '@metrofax.com',
    subject: 'Physician Order Request',
    body: 'From Comfort Hands Home Healthcare, LLC. Please call 609-277-3032 with questions.',
    attachments: [pdf]
  });
  MailApp.sendEmail({
    to: CONFIG.OFFICE_EMAIL,
    subject: 'Fax sent — Physician Order — ' + first + ' ' + last,
    body: 'The Physician Order Request for ' + first + ' ' + last + ' was sent to MetroFax for fax number ' + num + '.\nSaved to Drive: ' + file.getUrl() + '\nCheck MetroFax for delivery confirmation.'
  });
  return { ok: true, url: file.getUrl() };
}

// Returns the file exactly as uploaded. Refuses Google Docs/other types, because converting them to PDF changes the formatting.
function pdfBlob_(rawId, name) {
  const f = DriveApp.getFileById(id_(rawId));
  if (f.getMimeType() !== MimeType.PDF) {
    throw new Error(name + ' must be an uploaded PDF file in Drive (this one is ' + f.getMimeType() + ')');
  }
  return f.getBlob().setName(name);
}
