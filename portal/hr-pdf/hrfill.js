/* Fills the I-9 and W-4 from application answers. Runs in the browser (PDFLib global) and in node tests. */
(function (root) {
  const AGENCY = { name: 'Comfort Hands Home Healthcare LLC', addr: '505 Hamilton Ave Ste 200, Linwood, NJ 08221' };
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
    T('Employers Business or Org Name', AGENCY.name); T('Employers Business or Org Address', AGENCY.addr);
    f.updateFieldAppearances(await doc.embedFont(PDFLib.StandardFonts.Helvetica));
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
  const api = { fillI9: fillI9, fillW4: fillW4 };
  if (typeof module !== 'undefined') module.exports = api; else root.HRFILL = api;
})(typeof window !== 'undefined' ? window : this);
