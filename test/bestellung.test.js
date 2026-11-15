// Feldauswahl der öffentlichen Route POST /api/orders (bestellung.js).
// Läuft ohne Datenbank und ohne .env: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const { webBestellungAusRequest } = require('../bestellung');

// So schickt index.html eine Bar-Bestellung (siehe processOrder).
function barBestellung() {
  return {
    items: [{ name: 'Pizza Margherita', price: 8.5, qty: 2, extraDetails: [], note: '' }],
    subtotal: 17, deliveryFee: 2, serviceFee: 0, total: 19,
    mode: 'lieferung',
    payment: 'bar',
    note: 'Bitte klingeln',
    customer: { first: 'Max', last: 'Muster', email: 'max@example.org', phone: '0123',
                street: 'Hauptstr.', house: '1', city: 'Musterstadt' },
  };
}

test('normale Bar-Bestellung bleibt unverändert', () => {
  const body = barBestellung();
  const { felder, fehler } = webBestellungAusRequest(body);
  assert.equal(fehler, undefined);
  for (const f of ['items', 'subtotal', 'deliveryFee', 'serviceFee', 'mode', 'payment', 'note', 'customer']) {
    assert.deepEqual(felder[f], body[f], f);
  }
  assert.equal(felder.source, 'web');
  assert.equal(felder.status, 'pending');
  assert.equal(felder.paymentStatus, 'unpaid');
  // Betrag rechnet die Route selbst, Rabatt und Gutschein gibt es nicht
  assert.equal('total' in felder, false);
  assert.equal('discount' in felder, false);
  assert.equal('coupon' in felder, false);
});

test("source 'pos' wird zu 'web', Status bleibt 'pending'", () => {
  const { felder } = webBestellungAusRequest({ ...barBestellung(), source: 'pos', status: 'confirmed', prepTime: 20 });
  assert.equal(felder.source, 'web');
  assert.equal(felder.status, 'pending');
  assert.equal('prepTime' in felder, false);
});

test("paymentStatus 'paid', Rabatt und Gutschein werden verworfen", () => {
  const { felder } = webBestellungAusRequest({ ...barBestellung(), paymentStatus: 'paid', discount: 50, coupon: 'X' });
  assert.equal(felder.paymentStatus, 'unpaid');
  assert.equal('discount' in felder, false);
  assert.equal('coupon' in felder, false);
});

test("Zahlart 'karte' wird abgelehnt", () => {
  const r = webBestellungAusRequest({ ...barBestellung(), payment: 'karte' });
  assert.ok(r.fehler);
  assert.equal(r.felder, undefined);
});

test('andere oder fehlende Zahlarten werden abgelehnt', () => {
  for (const payment of ['stripe', 'paypal', '', undefined, null, ['bar'], { $ne: 'x' }]) {
    assert.ok(webBestellungAusRequest({ ...barBestellung(), payment }).fehler, String(payment));
  }
  assert.ok(webBestellungAusRequest(undefined).fehler);
  assert.ok(webBestellungAusRequest([]).fehler);
});

test('Server-Felder lassen sich nicht von außen setzen', () => {
  const angriff = {
    ...barBestellung(),
    _id: '000000000000000000000001', id: 'x', orderNum: 1, statusToken: 'geraten',
    userId: '000000000000000000000002', cancelReason: 'x', nachgeholt: true,
    stripeSessionId: 'cs_x', stripePaymentIntentId: 'pi_x', paypalOrderId: 'p', paypalCaptureId: 'c',
    createdAt: '2020-01-01', updatedAt: '2020-01-01',
  };
  const { felder } = webBestellungAusRequest(angriff);
  for (const f of ['_id', 'id', 'orderNum', 'statusToken', 'userId', 'cancelReason', 'nachgeholt',
                   'stripeSessionId', 'stripePaymentIntentId', 'paypalOrderId', 'paypalCaptureId',
                   'createdAt', 'updatedAt']) {
    assert.equal(f in felder, false, f);
  }
});

test('Request-Objekt wird nicht verändert', () => {
  const body = { ...barBestellung(), source: 'pos', paymentStatus: 'paid' };
  webBestellungAusRequest(body);
  assert.equal(body.source, 'pos');
  assert.equal(body.paymentStatus, 'paid');
});
