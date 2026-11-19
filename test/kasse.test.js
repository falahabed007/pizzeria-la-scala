// Anmerkung als Extra in den Antworten an die Sunmi-Kasse (kasse.js).
// Läuft ohne Datenbank und ohne .env: node --test test/kasse.test.js
const test   = require('node:test');
const assert = require('node:assert/strict');
const { artikelFuerKasse, bestellungFuerKasse, kasseAnmerkung } = require('../kasse');

function pizza(note) {
  return {
    name: 'Pizza Salami', price: 9.5, qty: 1,
    extraDetails: [{ name: 'Groß (32 cm)', price: 2 }],
    note,
  };
}

// Baut req/res wie Express nach, ruft die Middleware und dann res.json.
function aufrufen(method, body, optionen) {
  const req = { method };
  let gesendet;
  const res = { json(b) { gesendet = b; return this; } };
  let weiter = false;
  kasseAnmerkung(optionen)(req, res, () => { weiter = true; });
  assert.equal(weiter, true);
  res.json(body);
  return gesendet;
}

test('Extras + Anmerkung: Anmerkung wird als Extra mit 0 € angehängt, note leer', () => {
  const [a] = artikelFuerKasse([pizza('  ohne Zwiebeln ')]);
  assert.deepEqual(a.extraDetails, [
    { name: 'Groß (32 cm)', price: 2 },
    { name: 'ANMERKUNG: ohne Zwiebeln', price: 0 },
  ]);
  assert.equal(a.note, '');
  assert.equal(a.name, 'Pizza Salami');
  assert.equal(a.price, 9.5);
  assert.equal(a.qty, 1);
});

test('nur Anmerkung ohne Extras bleibt unverändert', () => {
  const ohne = { name: 'Cola', price: 2, qty: 1, extraDetails: [], note: 'kalt' };
  const fehlend = { name: 'Fanta', price: 2, qty: 1, note: 'kalt' };
  const [a, b] = artikelFuerKasse([ohne, fehlend]);
  assert.equal(a, ohne);
  assert.equal(b, fehlend);
});

test('nur Extras ohne Anmerkung bleibt unverändert', () => {
  const leer = pizza('');
  const nurLeerzeichen = pizza('   ');
  const keine = pizza(undefined);
  const [a, b, c] = artikelFuerKasse([leer, nurLeerzeichen, keine]);
  assert.equal(a, leer);
  assert.equal(b, nurLeerzeichen);
  assert.equal(c, keine);
});

test('Eingabe wird nicht verändert', () => {
  const items = [pizza('ohne Zwiebeln')];
  const vorher = structuredClone(items);
  const nachher = artikelFuerKasse(items);
  assert.notEqual(nachher, items);
  assert.deepEqual(items, vorher);
});

test('kein Array geht unverändert zurück', () => {
  assert.equal(artikelFuerKasse(undefined), undefined);
  assert.equal(artikelFuerKasse(null), null);
  const obj = { a: 1 };
  assert.equal(artikelFuerKasse(obj), obj);
  assert.equal(artikelFuerKasse('x'), 'x');
});

test('zweimal angewendet hängt nicht doppelt an', () => {
  const einmal = artikelFuerKasse([pizza('ohne Zwiebeln')]);
  const zweimal = artikelFuerKasse(einmal);
  assert.equal(zweimal[0].extraDetails.length, 2);
  const mitNote = artikelFuerKasse([pizza('ohne Zwiebeln')], { noteBehalten: true });
  const nochmal = artikelFuerKasse(mitNote, { noteBehalten: true });
  assert.equal(nochmal[0].extraDetails.length, 2);
});

test('noteBehalten lässt note stehen', () => {
  const [a] = artikelFuerKasse([pizza('ohne Zwiebeln')], { noteBehalten: true });
  assert.equal(a.note, 'ohne Zwiebeln');
  assert.equal(a.extraDetails.at(-1).name, 'ANMERKUNG: ohne Zwiebeln');
});

test('bestellungFuerKasse nutzt toJSON (Mongoose-Dokument)', () => {
  const doc = {
    _id: 'abc',
    items: 'nicht das hier',
    toJSON() { return { _id: 'abc', orderNumber: 7, items: [pizza('ohne Zwiebeln')] }; },
  };
  const x = bestellungFuerKasse(doc);
  assert.equal(typeof x.toJSON, 'undefined');
  assert.equal(x.orderNumber, 7);
  assert.equal(x.items[0].extraDetails.at(-1).name, 'ANMERKUNG: ohne Zwiebeln');
  assert.equal(x.items[0].note, '');
  assert.equal(bestellungFuerKasse(null), null);
  const ohneItems = { _id: 'x' };
  assert.equal(bestellungFuerKasse(ohneItems), ohneItems);
});

test('Middleware: GET setzt orders und pending um, andere Felder bleiben', () => {
  const stats = { heute: 3 };
  const body = {
    orders: [{ _id: '1', items: [pizza('ohne Zwiebeln')] }],
    pending: [{ _id: '2', items: [pizza('scharf')] }],
    stats,
  };
  const vorher = structuredClone(body);
  const raus = aufrufen('GET', body);
  assert.notEqual(raus, body);
  assert.equal(raus.stats, stats);
  assert.equal(raus.orders[0].items[0].extraDetails.at(-1).name, 'ANMERKUNG: ohne Zwiebeln');
  assert.equal(raus.orders[0].items[0].note, '');
  assert.equal(raus.pending[0].items[0].extraDetails.at(-1).name, 'ANMERKUNG: scharf');
  assert.deepEqual(body, vorher);
});

test('Middleware: noteBehalten wird durchgereicht', () => {
  const raus = aufrufen('GET', { orders: [{ items: [pizza('ohne Zwiebeln')] }] }, { noteBehalten: true });
  assert.equal(raus.orders[0].items[0].note, 'ohne Zwiebeln');
  assert.equal(raus.orders[0].items[0].extraDetails.at(-1).name, 'ANMERKUNG: ohne Zwiebeln');
});

test('Middleware: POST bleibt unberührt', () => {
  const req = { method: 'POST' };
  const json = () => {};
  const res = { json };
  let weiter = false;
  kasseAnmerkung()(req, res, () => { weiter = true; });
  assert.equal(weiter, true);
  assert.equal(res.json, json);
});

test('Middleware: Fehlerantwort { message } bleibt unberührt', () => {
  const body = { message: 'Nicht angemeldet' };
  assert.equal(aufrufen('GET', body), body);
});

test('Middleware: Nicht-Plain-Objekte gehen unverändert durch', () => {
  class Antwort { constructor() { this.orders = [{ items: [pizza('ohne Zwiebeln')] }]; } }
  const instanz = new Antwort();
  assert.equal(aufrufen('GET', instanz), instanz);
  assert.equal(instanz.orders[0].items[0].extraDetails.length, 1);
  const liste = [{ items: [pizza('ohne Zwiebeln')] }];
  assert.equal(aufrufen('GET', liste), liste);
  assert.equal(aufrufen('GET', null), null);
  assert.equal(aufrufen('GET', 'text'), 'text');
});

test('Middleware: wirft toJSON eines Eintrags, geht der ursprüngliche Body raus', (t) => {
  const fehler = t.mock.method(console, 'error', () => {});
  const body = {
    orders: [
      { items: [pizza('ohne Zwiebeln')] },
      { toJSON() { throw new Error('kaputt'); } },
    ],
  };
  assert.equal(aufrufen('GET', body), body);
  assert.equal(fehler.mock.callCount(), 1);
});
