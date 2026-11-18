/* Fills the five insurer PCA authorization request forms from a patient record. Runs in the browser (PDFLib global) and in node tests. */
(function (root) {
  const s = v => String(v == null ? '' : v).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, '').trim();
  const us = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '')); return m ? m[2] + '/' + m[3] + '/' + m[1] : s(v); };
  const num = v => { const n = parseFloat(v); return isFinite(n) ? (Math.round(n * 100) / 100) : ''; };
  const MCO = { hnjh: 'Horizon NJ Health', uhc: 'UnitedHealthcare', aetna: 'Aetna Better Health of New Jersey', wellpoint: 'Wellpoint', hpp: 'HealthPartners' };
  const FILE = { hnjh: 'hnjh.pdf', uhc: 'uhc.pdf', aetna: 'aetna.pdf', wellpoint: 'wellpoint.pdf', hpp: 'hpp.pdf' };
  function cityLine(a) { return [s(a.city), [s(a.state), s(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', '); }
  function derive(d) {
    const x = Object.assign({}, d), ag = x.ag || {};
    x.name = s(x.name || [x.first, x.last].filter(Boolean).join(' '));
    x.hw = num(x.hoursWeek) || (num(x.hoursDay) && num(x.daysWeek) ? num(x.hoursDay) * num(x.daysWeek) : '');
    x.hd = num(x.hoursDay); x.dw = num(x.daysWeek);
    x.memAddr = [s(x.addr), cityLine(x)].filter(Boolean).join(', ');
    x.agAddr = [s(ag.addr), cityLine(ag)].filter(Boolean).join(', ');
    x.dxs = (x.dx || []).filter(q => q && (s(q.t) || s(q.icd)));
    x.icds = x.dxs.map(q => s(q.icd)).filter(Boolean).join(', ');
    x.dxText = x.dxs.map(q => s(q.t) + (s(q.icd) ? ' (' + s(q.icd) + ')' : '')).join('; ');
    x.ag = ag; return x;
  }
  async function fill(PDFLib, mco, bytes, d0) {
    const d = derive(d0), ag = d.ag, doc = await PDFLib.PDFDocument.load(bytes), font = await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
    const pages = doc.getPages();
    const T = (p, x, base, text, maxW, size) => { text = s(text); if (!text) return; let sz = size || 9; if (maxW) while (sz > 5.5 && font.widthOfTextAtSize(text, sz) > maxW) sz -= 0.5; pages[p].drawText(text, { x: x, y: pages[p].getHeight() - base, size: sz, font: font }); };
    const X = (p, x, top, size) => { size = size || 9; pages[p].drawText('X', { x: x + 1.6, y: pages[p].getHeight() - (top + size - 0.4), size: size, font: bold }); };
    const run = (p, x1, x2, bottom, text, size) => T(p, x1 + 2, bottom - 4, text, x2 - x1 - 4, size);
    const typ = d.type || 'new';
    if (mco === 'hnjh') {
      if (d.ageGroup === 'pediatric') X(0, 128, 84); else X(0, 23, 84);
      if (typ === 'new') X(0, 32, 125); if (typ === 'reauth') X(0, 149, 125); if (typ === 'transfer') X(0, 256, 125); if (typ === 'mco') X(0, 376, 125); if (typ === 'increase' || typ === 'decrease') X(0, 488, 125);
      T(0, 212, 184, us(d.today));
      run(0, 369, 499, 221, d.county);
      run(0, 82, 343, 242, d.name); run(0, 403, 479, 242, d.memberId); run(0, 500, 581, 242, us(d.dob));
      run(0, 130, 580, 262, d.memAddr); run(0, 96, 285, 282, d.phone); run(0, 397, 581, 282, d.altPhone);
      if (d.lang && !/^english$/i.test(s(d.lang))) { X(0, 110, 290); run(0, 256, 580, 302, d.lang); } else X(0, 149, 290);
      run(0, 138, 313, 351, us(d.authExpires)); run(0, 455, 581, 351, d.curHours);
      X(0, d.lapse ? 347 : 385, 359);
      run(0, 130, 274, 391, us(d.authFrom)); run(0, 284, 433, 391, us(d.authTo)); run(0, 500, 581, 391, d.hw ? d.hw + ' hrs/wk' : '');
      X(0, d.assisted ? 138 : 176, 399);
      const q = d.dxs;
      if (q[0]) { run(0, 69, 213, 450, q[0].t); run(0, 245, 294, 450, q[0].icd); }
      if (q[1]) { run(0, 332, 494, 450, q[1].t); run(0, 528, 577, 450, q[1].icd); }
      if (q[2]) { run(0, 62, 211, 470, q[2].t); run(0, 245, 290, 470, q[2].icd); }
      if (q[3]) { run(0, 331, 493, 470, q[3].t); run(0, 527, 577, 470, q[3].icd); }
      if (d.group && d.group.yes) { X(0, 109, 478); run(0, 82, 343, 510, d.group.name); run(0, 403, 479, 510, d.group.id); run(0, 500, 581, 510, us(d.group.dob)); X(0, 320, 534); } else { X(0, 147, 478); X(0, 58, 534); }
      if (typ === 'increase') X(0, 158, 568); if (typ === 'decrease') X(0, 221, 568);
      if (typ === 'increase' || typ === 'decrease') { run(0, 262, 577, 599, d.notes); }
      run(0, 78, 393, 673, ag.name); run(0, 447, 577, 673, ag.providerId);
      run(0, 93, 305, 693, ag.phone); run(0, 366, 578, 693, ag.fax); run(0, 116, 580, 713, ag.contact);
    } else if (mco === 'uhc') {
      T(0, 110, 146, us(d.today)); T(0, 394, 146, d.name, 150);
      T(0, 195, 171, us(d.dob)); T(0, 311, 184, d.caregiver, 220, 8);
      T(0, 140, 198, d.memberId); T(0, 407, 198, d.phone);
      T(0, 80, 244, d.memAddr, 215, 8.5); T(0, 311, 244, d.dxText, 225, 8.5);
      T(0, 80, 285, ag.name, 215, 9);
      T(0, 270, 453, d.hd); T(0, 415, 453, d.dw);
      pages[0].drawEllipse({ x: 140, y: pages[0].getHeight() - 462, xScale: 70, yScale: 17, borderWidth: 1.3, borderColor: PDFLib.rgb(0, 0, 0), opacity: 0, borderOpacity: 1 });
      if (d.group && d.group.yes) { T(0, 285, 504, d.group.name, 140); T(0, 364, 516, d.group.id, 75); }
      const purp = { new: 569, increase: 590, reauth: 615, transfer: 641, mco: 662 }; const yy = purp[typ]; if (yy) X(0, 295, yy - 1, 8);
      Object.keys(purp).forEach(k => { if (k !== typ && !(typ === 'decrease' && false)) X(0, 325, purp[k] - 1, 8); });
      if (typ === 'mco') T(0, 428, 670, d.priorMco, 105);
      if (d.curHd || d.curDw) { T(1, 268, 222, d.curHd); T(1, 412, 222, d.curDw); }
      T(1, 170, 345, ag.name, 135, 8.5); T(1, 478, 345, ag.contact, 62, 8);
      T(1, 197, 370, ag.providerId, 100, 8.5); T(1, 493, 368, ag.tin && 'TIN ' + s(ag.tin), 55, 7.5); T(1, 493, 380, ag.npi && 'NPI ' + s(ag.npi), 55, 7.5);
      T(1, 80, 414, ag.addr, 215, 8.5); T(1, 80, 426, cityLine(ag), 215, 8.5); T(1, 456, 397, ag.phone, 75, 8.5); T(1, 440, 435, ag.fax, 90, 8.5);
      T(1, 74, 623, d.notes, 392, 8.5);
    } else if (mco === 'aetna') {
      if (typ === 'new') X(0, 54, 280); if (typ === 'reauth' || typ === 'increase' || typ === 'decrease') X(0, 158, 280); if (typ === 'transfer') X(0, 318, 280); if (typ === 'mco') X(0, 54, 304);
      T(0, 316, 336, us(d.today)); T(0, 132, 384, d.name, 400); T(0, 292, 406, d.memberId, 105); T(0, 434, 406, us(d.dob), 100);
      T(0, 201, 428, d.memAddr, 340); T(0, 196, 450, d.phone, 120); T(0, 436, 450, d.altPhone, 100);
      if (d.lang && !/^english$/i.test(s(d.lang))) { X(0, 157, 468); T(0, 357, 477, d.lang, 180); } else X(0, 213, 467);
      T(0, 172, 499, d.email, 360); T(0, 194, 538, us(d.authExpires), 110, 8);
      T(0, 171, 556, d.dw, 38, 8); T(0, 394, 556, d.hw, 115, 8);
      X(0, d.lapse ? 475 : 532, 570);
      if (d.group && d.group.yes) { X(0, 390, 593); T(0, 104, 624, d.group.name, 135); T(0, 325, 624, d.group.id, 112); T(0, 480, 624, us(d.group.dob), 80); } else X(0, 452, 592);
      T(0, 122, 687, d.dxs[0] && d.dxs[0].t, 135, 8.5); T(0, 300, 687, d.dxs[0] && d.dxs[0].icd, 70, 8.5);
      T(0, 460, 687, d.dxs.slice(1).map(q => s(q.t) + (s(q.icd) ? ' ' + s(q.icd) : '')).join('; '), 100, 7.5);
      if (d.group && d.group.yes) pages[1].drawText('X', { x: 58.5, y: pages[1].getHeight() - 141, size: 14, font: bold }); else pages[1].drawText('X', { x: 58.5, y: pages[1].getHeight() - 105, size: 14, font: bold });
      const st = { new: 350, reauth: 366, increase: 381, decrease: 396 }; if (st[typ]) X(1, 276, st[typ] + 0, 9);
      T(1, 225, 540, ag.name, 330); T(1, 225, 565, ag.npi, 200);
      T(1, 225, 611, ag.addr, 330, 8.5); T(1, 225, 633, cityLine(ag), 330, 8.5); T(1, 227, 653, ag.phone, 150); T(1, 430, 653, ag.fax, 130);
    } else if (mco === 'hpp') {
      T(0, 106, 125, us(d.today)); T(0, 430, 125, us(d.socDate || d.authFrom));
      T(0, 41, 177, d.name, 170); T(0, 221, 177, d.memberId, 160);
      const dp = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d.dob || '')); if (dp) { T(0, 460, 174, dp[2], 22); T(0, 493, 174, dp[3], 22); T(0, 526, 174, dp[1], 34); }
      T(0, 41, 247, ag.name, 170); T(0, 221, 247, ag.addr, 160, 8.5); T(0, 221, 258, cityLine(ag), 160, 8.5); T(0, 392, 247, ag.phone, 170);
      T(0, 122, 257, ag.contact, 92, 8.5); T(0, 435, 257, ag.fax, 135);
      T(0, 109, 299, ag.promise || ag.providerId, 150); T(0, 331, 299, ag.npi, 150);
      T(0, 200, 358, d.mdName, 360); T(0, 109, 406, d.mdPromise, 150); T(0, 331, 406, d.mdNpi, 150);
      T(0, 41, 457, d.dxText, 525, 9);
      T(0, 41, 500, ['Personal care aide (HHA) services' + (d.hw ? ': ' + d.hw + ' hrs/week' : '') + (d.dw ? ', ' + d.dw + ' days/week' : '') + '.', d.notes].filter(Boolean).join(' '), 525, 8.5);
      X(0, 41, 697, 9);
      T(0, 152, 708, [us(d.authFrom), us(d.authTo)].filter(Boolean).join(' - '), 355, 9);
      T(0, 522, 708, d.hw ? d.hw + ' hrs/wk' : '', 52, 7.5);
      X(1, 78, 648); T(1, 110, 691, d.goals || 'Personal care assistance as ordered', 445, 8.5);
    } else if (mco === 'wellpoint') {
      const f = doc.getForm(), TF = (n, v) => { v = s(v); if (v) { const t = f.getTextField(n); t.setText(v); t.setFontSize(8); } }, CB = n => f.getCheckBox(n).check();
      TF('Text1', d.first); TF('Text2', d.last); TF('Text3', d.memberId); TF('Text4', d.addr); TF('Text5', cityLine(d)); TF('Text6', us(d.dob)); TF('Text7', d.phone);
      TF('Text8', d.caregiver ? 'Contact: ' + d.caregiver : '');
      TF('Text11', d.mdName); TF('Text12', d.mdNpi); TF('Text13', d.mdProviderId); TF('Text15', d.mdContact); TF('Text16', d.mdPhone); TF('Text17', d.mdFax);
      const ma = s(d.mdAddr), ci = ma.indexOf(','); TF('Text18', ci > 0 ? ma.slice(0, ci) : ma); TF('Text19', ci > 0 ? ma.slice(ci + 1) : '');
      CB('Check Box21');
      TF('Text23', ag.name); TF('Text24', ag.npi); TF('Text25', ag.providerId); TF('Text26', ag.tin); TF('Text27', ag.contact); TF('Text28', ag.phone); TF('Text29', ag.fax);
      TF('Text30', ag.addr); TF('Text31', cityLine(ag));
      CB(typ === 'mco' ? 'Check Box33' : 'Check Box34');
      { const a = f.getTextField('Text35'), b = f.getTextField('Text36'); if (d.authFrom) { a.setText(us(d.authFrom)); a.setFontSize(7); } if (d.authTo) { b.setText(us(d.authTo)); b.setFontSize(7); } }
      TF('Text37', d.icds); TF('Text38', 'T1019' + (d.hw ? ' - ' + d.hw + ' hrs/wk' : ''));
      CB('Check Box45'); TF('Text46', 'Personal Care Assistant'); CB('Check Box50');
      { const t54=f.getTextField('Text54'); t54.enableMultiline(); t54.setText(['PCA services (T1019)' + (d.hd ? ': ' + d.hd + ' hrs/day' : '') + (d.dw ? ', ' + d.dw + ' days/week' : '') + (d.hw ? ' (' + d.hw + ' hrs/week)' : '') + '. Request: ' + ({ new: 'new/initial', reauth: 'reauthorization', increase: 'increase in hours', decrease: 'decrease in hours', transfer: 'agency transfer', mco: 'MCO change' })[typ] + '.', d.dxText && 'Dx: ' + d.dxText + '.', d.notes].filter(Boolean).join(' ')); t54.setFontSize(7); }
      CB('Check Box55');
      f.updateFieldAppearances(font);
    }
    return doc.save();
  }
  const api = { fill: fill, MCO: MCO, FILE: FILE };
  if (typeof module !== 'undefined') module.exports = api; else root.PCAFILL = api;
})(typeof window !== 'undefined' ? window : this);
