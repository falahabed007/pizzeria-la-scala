// Berichte und Abrechnung mit PayPal (server.js: berichtAbrechnung, pdfAbrechnung,
// abrechnungMailZeilen, abrechnungOwnerText). PayPal ist eine eigene Gruppe
// "PayPal (Ihr PayPal-Konto)", nie Barzahlung, gerechnet wie bar. Ohne PayPal bleibt
// alles centgenau und wortgleich wie vorher (Vergleich mit dem Stand 5ae3e9f,
// testhilfe/abrechnung-vor-paypal.js). Ohne Datenbank: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { ausServer } = require('../testhilfe/aus-server');
const vorPaypal = require('../testhilfe/abrechnung-vor-paypal');

// La Scala: keine Servicegebuehr (PDF_SV 0), Grundgebuehr fest PDF_BASE (kein GRUNDGEBUEHR_MONATE)
const hilfen = ausServer(['PDF_M', 'PDF_W', 'PDF_SV', 'PDF_BASE',
  'PDF_DOMAIN', 'pdfFmt', 'pdfTableRow', 'stripePauschale', 'svcText']);
// Die neuen Funktionen mit genau diesen Hilfen
const neu = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const { definition } = require('../testhilfe/aus-server');
  const namen = ['berichtAbrechnung', 'pdfAbrechnung', 'abrechnungMailZeilen', 'abrechnungOwnerText'];
  const parameter = Object.keys(hilfen);
  return new Function(...parameter, `${namen.map(n => definition(src, n)).join('\n')}\nreturn { ${namen.join(', ')} };`)(
    ...parameter.map(p => hilfen[p]));
})();
const alt = vorPaypal(hilfen);

// PDF-Attrappe: merkt sich jeden Text mit Position
function pdfText(funktion, a) {
  const log = [];
  const doc = { y: 100 };
  for (const m of ['font', 'fontSize', 'fillColor', 'rect', 'fill', 'save', 'restore', 'fillOpacity', 'moveTo', 'lineTo', 'strokeColor', 'lineWidth', 'stroke']) {
    doc[m] = () => doc;
  }
  doc.text = (t, x, y) => { log.push([String(t), x, y === undefined ? doc.y : y]); return doc; };
  funktion(doc, a);
  return log;
}

// Zufaellige, aber wiederholbare Bestellungen
function zufall(saat) { let s = saat; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }
function bestellungen(saat, zahlarten) {
  const r = zufall(saat), n = Math.floor(r() * 40);
  return Array.from({ length: n }, () => {
    const svc = r() < 0.1 ? 0 : r() < 0.1 ? undefined : 0.99;
    return { payment: zahlarten[Math.floor(r() * zahlarten.length)],
             total: Math.round((4 + r() * 80) * 100) / 100, ...(svc === undefined ? {} : { serviceFee: svc }) };
  });
}
const MONATE = [false, new Date(2026, 8, 1), new Date(2026, 9, 1), new Date(2026, 10, 1)];
const cent = n => Math.round(n * 100);

test('Bericht ohne PayPal: Abrechnung, Mail- und PDF-Zeilen genau wie vor der PayPal-Vorbereitung', () => {
  let faelle = 0;
  for (let saat = 1; saat <= 300; saat++) {
    const orders = bestellungen(saat, ['bar', 'stripe', 'karte']);
    for (const monat of MONATE) {
      const a = neu.berichtAbrechnung(orders, monat), b = alt.berichtAbrechnung(orders, monat);
      const { nPaypal, umsatzPaypal, ...rest } = a;
      assert.equal(nPaypal, 0); assert.equal(umsatzPaypal, 0);
      assert.deepEqual(rest, b, `saat ${saat}`);                // auch nicht um Bruchteile eines Cents
      assert.equal(neu.abrechnungMailZeilen(a), alt.abrechnungMailZeilen(b));
      assert.equal(neu.abrechnungOwnerText(a), alt.abrechnungOwnerText(b));
      assert.deepEqual(pdfText(neu.pdfAbrechnung, a), pdfText(alt.pdfAbrechnung, b));
      faelle++;
    }
  }
  assert.equal(faelle, 1200);
});

test('Bericht mit PayPal: Summen fuer Stripe und bar, Gebuehren, Ueberweisung und Gesamtumsatz bleiben', () => {
  for (let saat = 1; saat <= 300; saat++) {
    const orders = bestellungen(saat, ['bar', 'stripe', 'karte', 'paypal']);
    const ohnePaypal = orders.filter(o => o.payment !== 'paypal');
    const pp = orders.filter(o => o.payment === 'paypal');
    for (const monat of MONATE) {
      const a = neu.berichtAbrechnung(orders, monat), b = alt.berichtAbrechnung(orders, monat);
      // Was FlueVate rechnet, aendert sich durch die eigene Gruppe nicht (PayPal wie bar)
      for (const f of ['n', 'nOnline', 'umsatzOnline', 'svc', 'stripeGeb', 'grund', 'domain', 'fluevate',
                       'gebuehren', 'brutto', 'bleibt', 'ueberweisung', 'offen']) {
        assert.equal(cent(a[f]), cent(b[f]), `${f}, saat ${saat}`);
      }
      // Bar/EC ist jetzt nur noch bar und Karte; PayPal steht daneben
      assert.equal(a.nPaypal, pp.length);
      assert.equal(cent(a.umsatzPaypal), cent(pp.reduce((s, o) => s + o.total, 0)));
      assert.equal(a.nLaden + a.nPaypal, b.nLaden);
      assert.equal(cent(a.umsatzLaden + a.umsatzPaypal), cent(b.umsatzLaden));
      // Stripe- und Bar-Summen genau wie ohne die PayPal-Bestellungen
      const c = neu.berichtAbrechnung(ohnePaypal, monat);
      for (const f of ['nOnline', 'umsatzOnline', 'stripeGeb', 'nLaden', 'umsatzLaden']) assert.equal(cent(a[f]), cent(c[f]), f);
    }
  }
});

test('Bericht mit PayPal: von Hand nachgerechnet (bar 20, PayPal 30, Stripe 50, je 0,99 Servicegebuehr)', () => {
  const orders = [{ payment: 'bar', total: 20, serviceFee: 0.99 }, { payment: 'paypal', total: 30, serviceFee: 0.99 },
                  { payment: 'stripe', total: 50, serviceFee: 0.99 }];
  const a = neu.berichtAbrechnung(orders, new Date(2026, 9, 1));   // Oktober: Grundgebuehr 150
  assert.equal(a.umsatzLaden, 20); assert.equal(a.umsatzPaypal, 30); assert.equal(a.umsatzOnline, 50);
  assert.equal(a.brutto, 100);
  assert.equal(a.svc, 2.97);                         // auch fuer die PayPal-Bestellung, wie bei bar
  assert.equal(a.stripeGeb, 1);                      // 50 * 1,5 % + 0,25 nur fuer Stripe
  assert.equal(cent(a.fluevate), 15297);             // 150 + 2,97
  assert.equal(a.ueberweisung, 0);                   // 50 - 1 - 152,97 < 0
  assert.equal(cent(a.offen), 10397);                // nur aus Stripe gerechnet, PayPal-Geld liegt beim Laden
  assert.equal(cent(a.bleibt), 100 * 100 - 15297 - 100);
  const b = neu.berichtAbrechnung(orders, false);    // Woche: keine Fixkosten
  assert.equal(cent(b.ueberweisung), 5000 - 100 - 297);
  assert.equal(b.offen, 0);
});

test('Bericht mit PayPal: eigene Zeile "PayPal (Ihr PayPal-Konto)", Bar/EC ohne PayPal', () => {
  const orders = [{ payment: 'bar', total: 20, serviceFee: 0.99 }, { payment: 'paypal', total: 30, serviceFee: 0.99 },
                  { payment: 'stripe', total: 50, serviceFee: 0.99 }];
  const a = neu.berichtAbrechnung(orders, false);
  const mail = neu.abrechnungMailZeilen(a);
  assert.match(mail, /Bar \/ EC-Karte in Ihrer Kasse<\/td><td[^>]*>20,00 €/);
  assert.match(mail, /PayPal \(Ihr PayPal-Konto, 1 Bestellungen, PayPal-Gebühren nicht enthalten\)<\/td><td[^>]*>30,00 €/);
  assert.match(neu.abrechnungOwnerText(a), /PayPal \(Ihr PayPal-Konto\):<\/b> 30,00 €/);
  const pdf = pdfText(neu.pdfAbrechnung, a).map(z => z[0]);
  assert.ok(pdf.includes('Bar / EC-Karte  (1 Bestellungen)'));
  assert.ok(pdf.includes('PayPal (Ihr PayPal-Konto)  (1 Bestellungen)'));
  assert.ok(pdf.includes('PAYPAL (IHR PAYPAL-KONTO) – LIEGT AUF IHREM PAYPAL-KONTO'));
  // Der Betrag der PayPal-Bestellung steht nie neben einer Bar-Zeile
  const zeilen = pdfText(neu.pdfAbrechnung, a);
  const barZeilen = zeilen.filter(z => /Bar|Kasse/.test(z[0]));
  for (const z of barZeilen) assert.ok(!z[0].includes('30,00') || z[0].includes('PayPal'), z[0]);
});

test('Berichte: PayPal nirgends als Barzahlung beschriftet (Tagesbericht, Bestellliste, Bon)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Tagesbericht: Zahlart je Bestellung
  const zahlung = src.match(/const zahlung {2}= (.*);/)[1];
  assert.match(zahlung, /o\.payment==='paypal'\?'PayPal'/);
  // Bestellliste in Wochen-/Monatsbericht: eigene Gruppe
  assert.match(src, /drawGroup\('PayPal \(Ihr PayPal-Konto\)', '#003087', orders\.filter\(o => o\.payment === 'paypal'\)\)/);
  assert.match(src, /drawGroup\('Barzahlung', '#d32027', orders\.filter\(o => o\.payment === 'bar'\)\)/);
  // Bar-Uebersicht nur bar
  assert.equal((src.match(/barOrders(M)?\s*= orders\.filter\(o => o\.payment === 'bar'\)/g) || []).length, 3);
  // Bon (PrintNode)
  const bon = fs.readFileSync(path.join(__dirname, '..', 'printnode-helper.js'), 'utf8');
  assert.match(bon, /order\.payment === 'paypal' \? 'PayPal'/);
});
