// PayPal-Routen in server.js, gestartet im Kindprozess ohne .env und ohne Datenbank
// (testhilfe/). PayPal ist entweder nicht eingerichtet (fetch gesperrt) oder wird
// vorgetaeuscht (PAYPAL_ATTRAPPE). Nie eine Anfrage an das echte PayPal. npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const { starteServer } = require('../testhilfe/server-probe');

const KUNDE = { first: 'Max', last: 'Muster', email: 'max@example.org', phone: '0123', street: 'Weg', house: '1', city: 'Selm-Bork' };
// So schickt index.html eine Online-Bestellung (redirectToOnlinePayment). Abholung, damit
// die Tests nicht von der Uhrzeit abhaengen (Lieferung nur 11:30-22:30, eigener Test unten).
function rumpf(extra = {}) {
  return { items: [{ name: 'Pizza Margherita', price: 8.5, qty: 2, extraDetails: [], note: '' },
                   { name: 'Cola', price: 2.5, qty: 1, extraDetails: [], note: '' }],
           subtotal: 19.5, discount: 0, deliveryFee: 0, serviceFee: 0, total: 1.00,   // total vom Gast: wird ignoriert
           mode: 'abholung', note: 'klingeln', coupon: null, customer: KUNDE, ...extra };
}
const post = (s, pfad, body, admin = false) => s.holen(pfad, { method: 'POST', admin, body: JSON.stringify(body) });

test('ohne PayPal-Werte: paypal:false, alle PayPal-Routen lehnen ab, keine Anfrage nach aussen', async () => {
  const s = await starteServer();
  try {
    const c = await s.holen('/api/config', { admin: false });
    assert.equal(c.json.paypal, false);
    assert.deepEqual(Object.keys(c.json), ['whatsapp', 'serviceFee', 'deliveryCities', 'paypal']);
    const o = await post(s, '/api/create-paypal-order', rumpf());
    assert.equal(o.status, 503); assert.equal(o.json.paypal, false); assert.ok(!o.json.url);
    assert.equal((await post(s, '/api/paypal-capture', { paypalOrderId: 'ABCDEF123' })).status, 503);
    assert.equal((await post(s, '/api/paypal-webhook', { event_type: 'PAYMENT.CAPTURE.COMPLETED' })).status, 503);
    assert.equal((await s.holen('/api/admin/paypal', { admin: false })).status, 401);
    const st = await s.holen('/api/admin/paypal');
    assert.equal(st.status, 200);
    assert.equal(st.json.modus, 'aus'); assert.equal(st.json.fuerGaesteSichtbar, false);
    assert.match(s.log, /PayPal nicht eingerichtet/);
    assert.ok(!s.log.includes('FETCH-GESPERRT') && !s.log.includes('GESPEICHERT'), s.log);
  } finally { s.stop(); }
});

test('Schluessel ohne PAYPAL_ENV=live: Warnzeile, paypal:false, keine Anfrage, Status ohne Geheimnisse', async () => {
  const env = { PAYPAL_CLIENT_ID: 'FANTASIE-ID-1234', PAYPAL_CLIENT_SECRET: 'FANTASIE-GEHEIM-5678' };
  for (const PAYPAL_ENV of [undefined, 'sandbox', 'Live']) {
    const s = await starteServer({ env: { ...env, ...(PAYPAL_ENV ? { PAYPAL_ENV } : {}) } });
    try {
      assert.equal((await s.holen('/api/config', { admin: false })).json.paypal, false);
      assert.equal((await post(s, '/api/create-paypal-order', rumpf())).status, 503);
      const st = await s.holen('/api/admin/paypal');
      assert.equal(st.status, 200);
      assert.ok(!st.text.includes('FANTASIE'), st.text);
      assert.match(s.log, /PAYPAL_ENV ist nicht "live"/);
      assert.ok(!s.log.includes('FETCH-GESPERRT'), s.log);
    } finally { s.stop(); }
  }
});

test('PayPal vorgetaeuscht: paypal:true, Bestellung mit Betrag vom Server und denselben Pruefungen wie Stripe', async () => {
  const s = await starteServer({ env: { PAYPAL_ATTRAPPE: '1', PAYPAL_ENV: 'live',
    PAYPAL_CLIENT_ID: 'FANTASIE-ID-1234', PAYPAL_CLIENT_SECRET: 'FANTASIE-GEHEIM-5678' } });
  try {
    // Webhook wird beim Start sichergestellt (in der Attrappe schon vorhanden)
    for (let i = 0; i < 50 && !s.log.includes('PayPal wird angeboten'); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await s.holen('/api/config', { admin: false })).json.paypal, true);

    const anlegen = () => (s.log.match(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders/g) || []).length;
    // Pruefungen vor PayPal: ohne Kundendaten, Warenkorb passt nicht, ungueltige Art
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ customer: undefined }))).status, 400);
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ subtotal: 1 }))).status, 400);
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ items: [] }))).status, 400);
    assert.equal((await post(s, '/api/create-paypal-order', rumpf({ mode: 'drohne' }))).status, 400);
    assert.equal(anlegen(), 0, 'PayPal darf vor bestandenen Pruefungen nicht gefragt werden');

    const o = await post(s, '/api/create-paypal-order', rumpf());
    assert.equal(o.status, 200, o.text);
    assert.match(o.json.url, /^https:\/\/www\.paypal\.com\//);
    assert.equal(anlegen(), 1);
    const pp = JSON.parse(s.log.match(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders (\{.*\})/)[1]);
    assert.equal(pp.purchase_units[0].amount.value, '19.50');          // 19,50 + 0 + 0 (nicht 1,00)
    assert.equal(pp.purchase_units[0].custom_id, String(o.json.orderNum));
    const gespeichert = JSON.parse(s.log.match(/GESPEICHERT Order (\{.*\})/)[1]);
    assert.equal(gespeichert.payment, 'paypal');
    assert.equal(gespeichert.status, 'awaiting_payment');
    assert.equal(gespeichert.paymentStatus, 'pending');
    assert.equal(gespeichert.paypalOrderId, 'PPATTRAPPE123');
    assert.equal(gespeichert.total, 19.5);
    assert.equal(gespeichert.discount, 0);

    // Kein Rabatt-Code bei La Scala (auch nicht bei Stripe): ein mitgeschickter Code aendert nichts,
    // Gebuehren nimmt der Server wie bei Stripe aus dem Rumpf
    const gross = rumpf({ items: [{ name: 'Familienpizza', price: 25, qty: 3, extraDetails: [], note: '' }], subtotal: 75,
                          coupon: 'finanz', discount: 7.5, deliveryFee: 2, serviceFee: 0.99 });
    const r = await post(s, '/api/create-paypal-order', gross);
    assert.equal(r.status, 200, r.text);
    const alle = [...s.log.matchAll(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders (\{.*\})/g)];
    assert.equal(JSON.parse(alle[1][1]).purchase_units[0].amount.value, '77.99');   // 75 + 2 + 0,99, kein Abzug
    const g2 = [...s.log.matchAll(/GESPEICHERT Order (\{.*\})/g)].map(m => JSON.parse(m[1]))[1];
    assert.equal(g2.discount, 0); assert.ok(!g2.coupon);

    assert.ok(!s.log.includes('FETCH-GESPERRT'), s.log);
  } finally { s.stop(); }
});

// Lieferzeit wie bei Stripe und /api/orders (11:30-22:30 Uhr, Dienstag Ruhetag): Uhr vorgetaeuscht
// (testhilfe/uhr-attrappe.js). Ohne Stripe-Schluessel scheitert Stripe erst NACH der Lieferzeit-
// Pruefung (500) - eine 400 heisst also: ausserhalb der Lieferzeit.
test('Lieferung: PayPal lehnt genau dann ab, wenn create-stripe-checkout ablehnt (vor der PayPal-Anfrage)', async () => {
  const UHR = require('path').join(__dirname, '..', 'testhilfe', 'uhr-attrappe.js');
  const faelle = [
    ['2026-11-19T10:00:00+01:00', false],   // Donnerstag vor 11:30
    ['2026-11-19T12:00:00+01:00', true],    // Donnerstag mittags
    ['2026-11-19T22:45:00+01:00', false],   // nach 22:30
    ['2026-11-17T12:00:00+01:00', false],   // Dienstag Ruhetag
  ];
  for (const [uhr, offen] of faelle) {
    const s = await starteServer({ env: { PAYPAL_ATTRAPPE: '1', PAYPAL_ENV: 'live',
      PAYPAL_CLIENT_ID: 'FANTASIE-ID-1234', PAYPAL_CLIENT_SECRET: 'FANTASIE-GEHEIM-5678',
      UHR_ATTRAPPE: uhr, NODE_OPTIONS: `--require ${UHR}` } });
    try {
      for (let i = 0; i < 50 && !s.log.includes('PayPal wird angeboten'); i++) await new Promise(r => setTimeout(r, 100));
      const anlegen = () => (s.log.match(/PAYPAL-ATTRAPPE POST \/v2\/checkout\/orders/g) || []).length;
      const liefern = rumpf({ mode: 'lieferung' });
      const st = await post(s, '/api/create-stripe-checkout', liefern);
      const pl = await post(s, '/api/create-paypal-order', liefern);
      if (offen) {
        assert.equal(st.status, 500, uhr + st.text);
        assert.equal(pl.status, 200, uhr + pl.text); assert.equal(anlegen(), 1);
      } else {
        assert.equal(st.status, 400, uhr + st.text);
        assert.equal(pl.status, 400, uhr + pl.text); assert.equal(pl.json.message, st.json.message);
        assert.match(pl.json.message, /Lieferung ist nur von 11:30 bis 22:30 Uhr/);
        assert.equal(anlegen(), 0, 'ausserhalb der Lieferzeit darf PayPal nicht gefragt werden');
      }
      // Abholung haengt nicht an der Lieferzeit (wie bei Stripe)
      assert.equal((await post(s, '/api/create-paypal-order', rumpf())).status, 200);
      assert.ok(!s.log.includes('FETCH-GESPERRT'), s.log);
    } finally { s.stop(); }
  }
});
