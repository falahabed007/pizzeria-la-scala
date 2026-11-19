// Kasse: unbezahlte PayPal-Bestellungen erscheinen in keiner /api/admin/-Liste, Stripe
// und bar bleiben unveraendert (FUER_KASSE_PAYPAL in server.js). Startet server.js in
// einem Kindprozess mit einer Datenbank-Attrappe (testhilfe/), ohne .env, ohne
// Datenbank, fetch gesperrt. Laeuft mit: npm test
const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { starteServer, WURZEL } = require('../testhilfe/server-probe');

const SERVER = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');

const jetzt  = Date.now();
const vor    = min => new Date(jetzt - min * 60000).toISOString();
const TAG    = '2026-04-25';                       // fuer ?date= und /history
const amTag  = (h, m = 0) => new Date(`${TAG}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+02:00`).toISOString();
const kunde  = { first: 'Max', last: 'Muster', email: 'max@example.org', phone: '0123', street: 'Weg', house: '1', city: 'Nordkirchen' };
let nr = 5000;
function bestellung(payment, status, paymentStatus, createdAt, extra = {}) {
  nr += 1;
  return { _id: `o${nr}`, orderNum: nr, payment, status, paymentStatus, createdAt, updatedAt: createdAt,
           mode: nr % 2 ? 'lieferung' : 'abholung', source: 'web', customer: kunde,
           items: [{ name: 'Pizza', price: 9.5, qty: 1, note: nr % 3 ? '' : 'ohne Zwiebeln', extraDetails: [{ name: 'Groß', price: 0 }] }],
           subtotal: 9.5, deliveryFee: 0, serviceFee: 0.99, discount: 0, total: 10.49 + nr % 7, ...extra };
}

// Stripe und bar in allen Zustaenden, die vorkommen - heute und am festen Tag
function basis() {
  const l = [];
  for (const [zeit, z2] of [[vor(5), vor(30)], [amTag(12), amTag(19, 30)]]) {
    l.push(bestellung('bar', 'pending', 'unpaid', zeit, { userId: 'u1' }));
    l.push(bestellung('bar', 'confirmed', 'unpaid', z2));
    l.push(bestellung('bar', 'delivered', 'paid', z2, { userId: 'u1' }));
    l.push(bestellung('bar', 'cancelled', 'unpaid', zeit, { cancelReason: 'Kunde' }));
    l.push(bestellung('karte', 'delivered', 'paid', z2));
    l.push(bestellung('stripe', 'awaiting_payment', 'pending', zeit, { userId: 'u2' }));
    l.push(bestellung('stripe', 'pending', 'paid', zeit, { userId: 'u2' }));
    l.push(bestellung('stripe', 'confirmed', 'paid', z2));
    l.push(bestellung('stripe', 'ready', 'paid', z2));
    l.push(bestellung('stripe', 'cancelled', 'pending', zeit));             // abgelaufene Zahlung
    l.push(bestellung('stripe', 'cancelled', 'refunded', z2, { userId: 'u1' }));
  }
  return l;
}
// PayPal, nie oder noch nicht bezahlt: darf nirgends auftauchen
function paypalUnbezahlt() {
  const l = [];
  for (const zeit of [vor(3), amTag(13)]) {
    l.push(bestellung('paypal', 'awaiting_payment', 'pending', zeit, { userId: 'u1', paypalOrderId: 'PP' + nr }));
    l.push(bestellung('paypal', 'cancelled', 'pending', zeit, { userId: 'u2', zahlungAbgelaufen: true, paypalOrderId: 'PP' + nr }));
    // Faelle, die nur durch Handeingriffe entstehen koennten - auch dann nicht an die Kasse
    l.push(bestellung('paypal', 'pending', 'pending', zeit, { paypalOrderId: 'PP' + nr }));
    l.push(bestellung('paypal', 'confirmed', 'unpaid', zeit, { paypalOrderId: 'PP' + nr }));
  }
  return l;
}
// PayPal bezahlt bzw. erstattet: erscheint wie eine Stripe-Bestellung
function paypalBezahlt() {
  const l = [];
  for (const zeit of [vor(2), amTag(14)]) {
    l.push(bestellung('paypal', 'pending', 'paid', zeit, { paypalOrderId: 'PP' + nr, paypalCaptureId: 'CAP' + nr }));
    l.push(bestellung('paypal', 'delivered', 'paid', zeit, { userId: 'u1', paypalOrderId: 'PP' + nr, paypalCaptureId: 'CAP' + nr }));
    l.push(bestellung('paypal', 'cancelled', 'refunded', zeit, { paypalOrderId: 'PP' + nr, paypalCaptureId: 'CAP' + nr }));
  }
  return l;
}
const NUTZER = [
  { _id: 'u1', email: 'a@example.org', first: 'A', last: 'B', createdAt: vor(10000) },
  { _id: 'u2', email: 'c@example.org', first: 'C', last: 'D', createdAt: vor(9000) },
];

// Alle /api/admin/-Antworten mit Bestellungen, die die Kasse liest
const ROUTEN = [
  '/api/admin/orders/pending',
  '/api/admin/orders',
  `/api/admin/orders?date=${TAG}`,
  `/api/admin/history?from=${TAG}&to=${TAG}`,
  '/api/admin/history',
  '/api/admin/finance',
  '/api/admin/customers',
  '/api/admin/customers/u1/orders',
  '/api/admin/customers/u2/orders',
];

async function antworten(orders) {
  const s = await starteServer({ daten: { Order: orders, User: NUTZER } });
  try {
    const ergebnis = {};
    for (const r of ROUTEN) {
      const a = await s.holen(r);
      assert.equal(a.status, 200, `${r}: ${a.text}`);
      ergebnis[r] = a.json;
    }
    assert.ok(!s.log.includes('FETCH-GESPERRT'), 'kein Aufruf nach aussen');
    return ergebnis;
  } finally { s.stop(); }
}
// Alle Bestellnummern in einer Antwort (orders, pending, Listen)
function nummern(json) {
  const l = [];
  (function lauf(x) {
    if (Array.isArray(x)) return x.forEach(lauf);
    if (x && typeof x === 'object') { if (typeof x.orderNum === 'number') l.push(x.orderNum); Object.values(x).forEach(lauf); }
  })(json);
  return l;
}

const BASIS = basis(), UNBEZAHLT = paypalUnbezahlt(), BEZAHLT = paypalBezahlt();
let nurBasis, mitUnbezahlt, mitAllem;
test.before(async () => {
  [nurBasis, mitUnbezahlt, mitAllem] = await Promise.all([
    antworten(BASIS), antworten([...BASIS, ...UNBEZAHLT]), antworten([...BASIS, ...UNBEZAHLT, ...BEZAHLT]),
  ]);
});

test('Kasse: Stripe und bar - jede Antwort bleibt genau gleich, wenn unbezahlte PayPal-Bestellungen dazukommen', () => {
  for (const r of ROUTEN) assert.deepEqual(mitUnbezahlt[r], nurBasis[r], r);
});

test('Kasse: die Daten der Probe decken die Listen wirklich ab (keine leeren Antworten)', () => {
  assert.ok(nurBasis['/api/admin/orders/pending'].pending.length >= 2);
  assert.ok(nurBasis['/api/admin/orders'].orders.length >= 8);
  assert.ok(nurBasis[`/api/admin/orders?date=${TAG}`].orders.length >= 5);
  assert.ok(nurBasis[`/api/admin/history?from=${TAG}&to=${TAG}`].orders.length >= 5);
  assert.ok(nurBasis['/api/admin/customers'].length === 2);
  assert.ok(nurBasis['/api/admin/customers/u1/orders'].length >= 3);
});

test('Kasse: unbezahlte PayPal-Bestellungen erscheinen in keiner Admin-Antwort, auch nicht als Storno', () => {
  const verboten = new Set(UNBEZAHLT.map(o => o.orderNum));
  for (const r of ROUTEN) {
    for (const n of nummern(mitAllem[r])) assert.ok(!verboten.has(n), `${r} zeigt unbezahlte PayPal-Bestellung #${n}`);
  }
});

test('Kasse: bezahlte PayPal-Bestellungen erscheinen wie Stripe (pending in der Kasse, erstattete als Storno)', () => {
  const [pendingHeute, deliveredHeute, erstattetHeute] = BEZAHLT;
  const pending = nummern(mitAllem['/api/admin/orders/pending']);
  assert.ok(pending.includes(pendingHeute.orderNum));
  const alle = nummern(mitAllem['/api/admin/orders']);
  assert.ok(alle.includes(deliveredHeute.orderNum) && alle.includes(erstattetHeute.orderNum));
  const tag = mitAllem[`/api/admin/history?from=${TAG}&to=${TAG}`];
  assert.equal(tag.stats.byPayment.paypal, 2);      // pending + delivered am Tag, erstattete ist storniert
  assert.ok(!('paypal' in nurBasis[`/api/admin/history?from=${TAG}&to=${TAG}`].stats.byPayment));
});

test('Kasse: jede Order-Abfrage einer GET /api/admin/-Route nimmt FUER_KASSE_PAYPAL', () => {
  // Routen-Bloecke ausschneiden und jede Order.find/aggregate-$match darin pruefen
  // (ein Block endet an der ersten Zeile "});" - danach folgen Crons und Funktionen)
  const bloecke = SERVER.split(/\napp\.(?=get|post|patch|delete|use)/)
    .filter(b => /^get\('\/api\/admin\//.test(b)).map(b => b.split('\n});\n')[0]);
  let geprueft = 0;
  for (const b of bloecke) {
    const name = b.match(/^get\('([^']+)'/)[1];
    for (const m of b.matchAll(/Order\.find\(\{([^]*?)\}\)|\$match: \{([^]*?)\} \}/g)) {
      geprueft++;
      assert.match(m[0], /^Order\.find\(\{\s*\.\.\.FUER_KASSE_PAYPAL,|^\$match: \{ \.\.\.FUER_KASSE_PAYPAL,/, `${name}: ${m[0].slice(0, 80)}`);
    }
    assert.ok(!/Order\.find\(\s*\)/.test(b), `${name}: Order.find() ohne Filter`);
  }
  // La Scala: 8 (Nordkirchen 9 - hier gibt es keine zweite Aggregation fuer die Stempelkarte)
  assert.ok(geprueft >= 8, `nur ${geprueft} Abfragen gefunden`);
});

test('Kasse: FUER_KASSE_PAYPAL trifft nur payment paypal', () => {
  const m = SERVER.match(/const FUER_KASSE_PAYPAL = (\{.*\});/);
  assert.ok(m);
  assert.deepEqual(JSON.parse(m[1].replace(/(\$?\w+):/g, '"$1":').replace(/'/g, '"')),
    { $nor: [{ payment: 'paypal', paymentStatus: { $nin: ['paid', 'refunded'] } }] });
});
