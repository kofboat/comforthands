/* Fills the I-9 and W-4 from application answers. Runs in the browser (PDFLib global) and in node tests. */
(function (root) {
  const AGENCY = { name: 'Comfort Hands Home Healthcare LLC', addr: '505 Hamilton Ave Ste 200, Linwood, NJ 08221', rep: 'Akosah, Kofi - Office manager' };
  const s = v => String(v == null ? '' : v).replace(/[^\x20-\x7E]/g, '').trim();
  const dob = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : s(v); };
  const phone = v => { const d = String(v || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1'); return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : s(v); };
  const CB = { 'US citizen': 'CB_1', 'Noncitizen national': 'CB_2', 'Permanent Resident': 'CB_3', 'Alien with work permit': 'CB_4' };
  async function fillI9(PDFLib, bytes, a) {
    const doc = await PDFLib.PDFDocument.load(bytes), f = doc.getForm();
    const T = (n, v) => { v = s(v); if (v) f.getTextField(n).setText(v); };
    T('First Name Given Name', a.firstName); T('Last Name (Family Name)', a.lastName);
    T('Address Street Number and Name', a.addr1); T('Apt Number (if any)', a.addr2); T('City or Town', a.city); T('ZIP Code', a.zip);
    const st = s(a.state).toUpperCase(); try { if (st) f.getDropdown('State').select(st); } catch (e) {}
    T('Date of Birth mmddyyyy', dob(a.dob)); T('Employees E-mail Address', a.email); T('Telephone Number', phone(a.phone));
    if (CB[a.residency]) f.getCheckBox(CB[a.residency]).check();
    /* employer name and address are drawn on the page itself (not as form fields) so every viewer shows them */
    const hf = await doc.embedFont(PDFLib.StandardFonts.Helvetica), pg = doc.getPage(0);
    [['Employers Business or Org Name', AGENCY.name], ['Employers Business or Org Address', AGENCY.addr], ['Last Name First Name and Title of Employer or Authorized Representative', AGENCY.rep]].forEach(function (p) {
      const fld = f.getTextField(p[0]), r = fld.acroField.getWidgets()[0].getRectangle(), sz = 9;
      pg.drawText(p[1], { x: r.x + 3, y: r.y + (r.height - sz) / 2 + 1, size: sz, font: hf, maxWidth: r.width - 6 });
    });
    f.updateFieldAppearances(hf);
    return doc.save();
  }
  async function fillW4(PDFLib, bytes, a) {
    const doc = await PDFLib.PDFDocument.load(bytes), pg = doc.getPage(0), H = pg.getHeight(), font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const put = (t, x, top, size) => { t = s(t); if (t) pg.drawText(t, { x: x, y: H - top, size: size || 10, font: font }); };
    put(a.firstName, 100, 101); put(a.lastName, 280, 101);
    put([a.addr1, a.addr2].map(s).filter(Boolean).join(', '), 100, 125);
    put([s(a.city), [s(a.state), s(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', '), 100, 150);
    return doc.save();
  }
  /* Completed W-4 with the employee's own answers and on-screen signature (page 1 only is written to). Coordinates are points from the top-left of the 2026 form. */
  async function fillW4Signed(PDFLib, bytes, a, w) {
    const doc = await PDFLib.PDFDocument.load(bytes), pg = doc.getPage(0), H = pg.getHeight(), font = await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const put = (t, x, top, size) => { t = s(t); if (t) pg.drawText(t, { x: x, y: H - top, size: size || 10, font: font }); };
    const X = (x, top) => pg.drawText('X', { x: x - 3.2, y: H - top - 3, size: 9, font: bold });
    const money = n => { n = Number(n) || 0; return n ? n.toFixed(2).replace(/\.00$/, '') : ''; };
    put(a.firstName, 100, 101); put(a.lastName, 280, 101); put(w.ssn, 482, 102);
    put([a.addr1, a.addr2].map(s).filter(Boolean).join(', '), 100, 125);
    put([s(a.city), [s(a.state), s(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', '), 100, 150);
    if (w.status === 'single') X(119, 162); else if (w.status === 'married') X(119, 174.5); else if (w.status === 'head') X(119, 185.5);
    if (w.step2) X(568, 408.5);
    const kids = (Number(w.kids) || 0) * 2200, deps = (Number(w.deps) || 0) * 500, oc = Number(w.otherCredits) || 0, tot = kids + deps + oc;
    put(money(kids), 418, 489); put(money(deps), 418, 500); put(money(tot), 514, 524);
    put(money(w.otherIncome), 514, 560); put(money(w.deductions), 514, 596); put(money(w.extra), 514, 614);
    if (w.exempt) { X(568, 658.5); }
    if (w.sig) {
      const img = await doc.embedPng(w.sig), k = Math.min(220 / img.width, 28 / img.height);
      pg.drawImage(img, { x: 104, y: H - 698, width: img.width * k, height: img.height * k });
    }
    put(w.date, 466, 699);
    return doc.save();
  }
  const api = { fillI9: fillI9, fillW4: fillW4, fillW4Signed: fillW4Signed };
  if (typeof module !== 'undefined') module.exports = api; else root.HRFILL = api;
})(typeof window !== 'undefined' ? window : this);
