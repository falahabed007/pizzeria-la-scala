// Abrechnung, wie sie bis zur PayPal-Vorbereitung in server.js stand: wortgleich aus
// Commit 5ae3e9f (La Scala, Live-Stand 19.11.2026). Nur fuer test/paypal-bericht.test.js - der Test
// vergleicht die neue Abrechnung damit (ohne PayPal muss alles centgenau gleich bleiben).
// Die Hilfen (PDF-Konstanten, pdfFmt, pdfTableRow ...) kommen aus dem aktuellen server.js.
// Erzeugt mit testhilfe/aus-server.js (definition) aus git show origin/main:server.js.
'use strict';
module.exports = function vorPaypal({ PDF_SV, PDF_BASE, PDF_DOMAIN, PDF_M, PDF_W, stripePauschale, svcText, pdfFmt, pdfTableRow }) {
function berichtAbrechnung(orders, mitFixkosten) {
  const summe  = (liste, f) => Math.round(liste.reduce((s, o) => s + f(o), 0) * 100) / 100;
  const online = orders.filter(o => o.payment === 'stripe');
  const laden  = orders.filter(o => o.payment !== 'stripe');
  const a = {
    n: orders.length, nOnline: online.length, nLaden: laden.length,
    umsatzOnline: summe(online, o => o.total || 0), umsatzLaden: summe(laden, o => o.total || 0),
    svc: summe(orders, o => o.serviceFee || PDF_SV), stripeGeb: summe(online, stripePauschale),
    grund: mitFixkosten ? PDF_BASE : 0, domain: mitFixkosten ? PDF_DOMAIN : 0,
  };
  a.brutto    = a.umsatzOnline + a.umsatzLaden;
  a.fluevate  = a.grund + a.domain + a.svc;
  a.gebuehren = a.fluevate + a.stripeGeb;
  a.bleibt    = a.brutto - a.gebuehren;
  const rest  = Math.round((a.umsatzOnline - a.stripeGeb - a.fluevate) * 100) / 100;
  a.ueberweisung = Math.max(0, rest);
  a.offen        = Math.max(0, -rest);
  return a;
}

function pdfAbrechnung(doc, a) {
  let zebra = false;
  const zeile = (text, wert, bold = false) => {
    if (bold) doc.rect(PDF_M, doc.y, PDF_W, 20).fill('#e6ecf3');
    pdfTableRow(doc, [[text, PDF_M+8, PDF_W-110, 'left'], [wert, PDF_M+2, PDF_W-4, 'right']], zebra && !bold, bold);
    zebra = !zebra;
  };
  const block = titel => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#666').text(titel, PDF_M, doc.y + 8, { width: PDF_W });
    doc.y += 3; zebra = false;
  };
  const minus = n => '– ' + pdfFmt(n); // Helvetica (WinAnsi) hat kein U+2212
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
  block('UMSATZ');
  zeile(`Bar / EC-Karte  (${a.nLaden} Bestellungen)`, pdfFmt(a.umsatzLaden));
  if (a.nOnline) zeile(`Online über Stripe  (${a.nOnline} Bestellungen)`, pdfFmt(a.umsatzOnline));
  zeile('Gesamtumsatz', pdfFmt(a.brutto), true);
  block('GEBÜHREN FLUEVATE');
  if (a.grund)  zeile('Grundgebühr (monatlich)', pdfFmt(a.grund));
  if (a.domain) zeile('Domain (monatlich)', pdfFmt(a.domain));
  zeile(`Servicegebühr  (${svcText(a.n, a.svc)})`, pdfFmt(a.svc));
  zeile('Gebühren FlueVate gesamt', pdfFmt(a.fluevate), true);
  block('AUSZAHLUNG ÜBER STRIPE');
  zeile(`Online-Umsatz  (${a.nOnline} Bestellungen)`, pdfFmt(a.umsatzOnline));
  if (a.nOnline) zeile('Stripe-Gebühr  (1,5 % + 0,25 € je Zahlung)', minus(a.stripeGeb));
  zeile('Gebühren FlueVate', minus(a.fluevate));
  zeile('Überweisung an Sie', pdfFmt(a.ueberweisung), true);
  if (a.offen) zeile('Offener Betrag  (wird eingezogen oder ist an FlueVate zu überweisen)', pdfFmt(a.offen), true);
  block('BAR / EC-KARTE – LIEGT IN IHRER KASSE');
  zeile(`${a.nLaden} Bestellungen`, pdfFmt(a.umsatzLaden), true);
  doc.y += 8;
  const ay = doc.y;
  doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Ihnen bleiben nach allen Gebühren', PDF_M+10, ay+8, { width: PDF_W*0.65 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(a.bleibt), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
  doc.y = ay + 28 + 3;
  doc.font('Helvetica').fontSize(7.5).fillColor('#888')
    .text(a.offen ? `Kasse ${pdfFmt(a.umsatzLaden)} – offener Betrag ${pdfFmt(a.offen)}` : `Überweisung ${pdfFmt(a.ueberweisung)} + Kasse ${pdfFmt(a.umsatzLaden)}`, PDF_M+10, doc.y, { width: PDF_W-20 });
  doc.y += 14;
}

function abrechnungMailZeilen(a) {
  const eur = n => n.toFixed(2).replace('.', ',') + ' €';
  const td = 'style="padding:8px"', tdr = 'style="padding:8px;text-align:right"';
  const teile = [a.grund && 'Grundgebühr', a.domain && 'Domain', `Servicegebühr ${a.n} Bestellungen`].filter(Boolean).join(', ');
  return `<tr><td ${td}>Gesamtumsatz (Brutto)</td><td ${tdr}>${eur(a.brutto)}</td></tr>`
    + `<tr style="background:#f5f5f5"><td ${td}>Gebühren FlueVate (${teile})</td><td ${tdr}>${eur(a.fluevate)}</td></tr>`
    + (a.nOnline ? `<tr><td ${td}>Stripe-Gebühr (${a.nOnline} Online-Zahlungen)</td><td ${tdr}>${eur(a.stripeGeb)}</td></tr>` : '')
    + `<tr style="background:#f5f5f5"><td ${td}><b>Überweisung an Sie über Stripe</b> (Online-Umsatz abzüglich Gebühren)</td><td ${tdr}><b>${eur(a.ueberweisung)}</b></td></tr>`
    + (a.offen ? `<tr><td ${td}><b>Offener Betrag</b> (wird eingezogen oder ist an FlueVate zu überweisen)</td><td ${tdr}><b>${eur(a.offen)}</b></td></tr>` : '')
    + `<tr><td ${td}>Bar / EC-Karte in Ihrer Kasse</td><td ${tdr}>${eur(a.umsatzLaden)}</td></tr>`
    + `<tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihnen bleiben nach allen Gebühren</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${eur(a.bleibt)}</td></tr>`;
}

function abrechnungOwnerText(a) {
  const eur = n => n.toFixed(2).replace('.', ',') + ' €';
  const teile = [a.grund && `Grundgebühr ${eur(a.grund)}`, a.domain && `Domain ${eur(a.domain)}`,
    `Servicegebühr ${eur(a.svc)} (${a.n} Bestellungen)`].filter(Boolean).join(', ');
  return `<b>Gebühren FlueVate:</b> ${eur(a.fluevate)} (${teile})`
    + (a.nOnline ? `<br><b>Stripe-Gebühr:</b> ${eur(a.stripeGeb)} (${a.nOnline} Online-Zahlungen)` : '')
    + `<br><b>Überweisung an den Laden:</b> ${eur(a.ueberweisung)}`
    + (a.offen ? `<br><b>Offener Betrag (einziehen):</b> ${eur(a.offen)}` : '');
}

  return { berichtAbrechnung, pdfAbrechnung, abrechnungMailZeilen, abrechnungOwnerText };
};
