// Vorgeladen in einen Kindprozess: node -r ./testhilfe/db-attrappe.js server.js
// (testhilfe/server-probe.js). Ersetzt die Datenbank durch Daten aus der Datei in
// DB_ATTRAPPE (JSON { Order: [...], User: [...] }) und sperrt fetch nach aussen.
// Abfragen werten sift aus (dieselben Operatoren wie MongoDB: $nor, $nin, $in, ...;
// sift kommt mit mongoose). Schreibende Aufrufe tun nichts. Nie gegen eine echte
// Datenbank, nie gegen PayPal oder Stripe.
'use strict';
const fs = require('fs');
const siftModul = require('sift');
const sift = siftModul.default || siftModul;
const mongoose = require('mongoose');

// PAYPAL_ATTRAPPE=1: PayPal (nur Live-Adresse) wird vorgetaeuscht - Anmeldung, Webhook-
// Liste mit dem passenden Webhook, Bestellung anlegen. Alles andere bleibt gesperrt.
const PAYPAL = 'https://api-m.paypal.com';
// Webhook-Adresse wie im Server: oeffentliche API-Basis aus config.js (bzw. PUBLIC_API_URL)
const API_BASIS = (process.env.PUBLIC_API_URL || '').trim()
  || (fs.readFileSync(require('path').join(__dirname, '..', 'config.js'), 'utf8').match(/FLUEVATE_BACKEND\s*=\s*'([^']+)'/) || [])[1];
async function paypalAttrappe(url, optionen = {}) {
  const pfad = url.slice(PAYPAL.length), methode = optionen.method || 'GET';
  console.log('PAYPAL-ATTRAPPE', methode, pfad, optionen.body && pfad !== '/v1/oauth2/token' ? optionen.body : '');
  const antwort = (status, daten) => ({ ok: status < 300, status, text: async () => JSON.stringify(daten) });
  if (methode === 'POST' && pfad === '/v1/oauth2/token') return antwort(200, { access_token: 'ATTRAPPE-TOKEN' });
  if (methode === 'GET' && pfad === '/v1/notifications/webhooks') {
    return antwort(200, { webhooks: [{ id: 'WH-ATTRAPPE-1', url: `${API_BASIS}/api/paypal-webhook`,
      event_types: [{ name: 'CHECKOUT.ORDER.APPROVED' }, { name: 'PAYMENT.CAPTURE.COMPLETED' }] }] });
  }
  if (methode === 'POST' && pfad === '/v2/checkout/orders') {
    return antwort(201, { id: 'PPATTRAPPE123', status: 'PAYER_ACTION_REQUIRED',
      links: [{ rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=PPATTRAPPE123' }] });
  }
  return antwort(500, { name: 'ATTRAPPE', message: 'nicht vorgesehen' });
}
globalThis.fetch = async (url, optionen) => {
  if (process.env.PAYPAL_ATTRAPPE === '1' && String(url).startsWith(PAYPAL + '/')) return paypalAttrappe(String(url), optionen);
  console.error('FETCH-GESPERRT', String(url));
  throw new Error('fetch gesperrt (Test)');
};

const roh = process.env.DB_ATTRAPPE ? JSON.parse(fs.readFileSync(process.env.DB_ATTRAPPE, 'utf8')) : {};
const DATUM = ['createdAt', 'updatedAt', 'lastOrder'];
const daten = {};
for (const [name, liste] of Object.entries(roh)) {
  daten[name] = liste.map(d => {
    const x = { ...d };
    for (const f of DATUM) if (typeof x[f] === 'string') x[f] = new Date(x[f]);
    // Wie ein Mongoose-Dokument: toObject (z. B. /api/admin/customers)
    Object.defineProperty(x, 'toObject', { value: () => ({ ...x }), enumerable: false });
    return x;
  });
}

function abfrage(ergebnis) {
  let l = ergebnis;
  const q = {
    sort(spec) {
      const keys = Object.entries(spec || {});
      l = [...l].sort((a, b) => {
        for (const [k, d] of keys) {
          if (a[k] < b[k]) return -d;
          if (a[k] > b[k]) return d;
        }
        return 0;
      });
      return q;
    },
    limit(n) { if (Array.isArray(l)) l = l.slice(0, n); return q; },
    select() { return q; },
    lean() { return q; },
    exec() { return Promise.resolve(l); },
    then(ja, nein) { return Promise.resolve(l).then(ja, nein); },
  };
  return q;
}

function gruppieren(liste, spec) {
  const gruppen = new Map();
  const wert = (doc, ausdruck) => (typeof ausdruck === 'string' && ausdruck.startsWith('$') ? doc[ausdruck.slice(1)] : ausdruck);
  for (const doc of liste) {
    const id = wert(doc, spec._id);
    const k = String(id);
    if (!gruppen.has(k)) gruppen.set(k, { _id: id });
    const g = gruppen.get(k);
    for (const [feld, op] of Object.entries(spec)) {
      if (feld === '_id') continue;
      if ('$sum' in op) g[feld] = (g[feld] || 0) + (Number(wert(doc, op.$sum)) || 0);
      else if ('$max' in op) { const v = wert(doc, op.$max); if (g[feld] === undefined || v > g[feld]) g[feld] = v; }
      else throw new Error('db-attrappe: $group-Operator fehlt ' + JSON.stringify(op));
    }
  }
  return [...gruppen.values()];
}

const originalModel = mongoose.model.bind(mongoose);
mongoose.model = function (name, ...rest) {
  const M = originalModel(name, ...rest);
  if (!rest.length) return M;
  const liste = () => daten[name] || [];
  M.find = (filter = {}) => abfrage(liste().filter(sift(filter)));
  M.findOne = (filter = {}) => abfrage(liste().find(sift(filter)) || null);
  M.findById = id => abfrage(liste().find(d => String(d._id) === String(id)) || null);
  M.countDocuments = (filter = {}) => abfrage(liste().filter(sift(filter)).length);
  M.aggregate = pipeline => {
    let l = liste();
    for (const stufe of pipeline) {
      if (stufe.$match) l = l.filter(sift(stufe.$match));
      else if (stufe.$group) l = gruppieren(l, stufe.$group);
      else throw new Error('db-attrappe: Stufe fehlt ' + Object.keys(stufe));
    }
    return abfrage(l);
  };
  for (const schreibend of ['findByIdAndUpdate', 'findOneAndUpdate', 'updateOne', 'updateMany', 'create']) {
    M[schreibend] = () => abfrage(null);
  }
  // Bestellnummern (getNextOrderNum): fortlaufend ab 1
  if (name === 'Counter') { let seq = 0; M.findByIdAndUpdate = () => abfrage({ seq: ++seq }); }
  // Speichern: nur ins Log (GESPEICHERT <Modell> <JSON>), nichts in eine Datenbank
  M.prototype.save = async function () {
    console.log('GESPEICHERT', name, JSON.stringify(this.toObject()));
    return this;
  };
  return M;
};
// Keine Verbindung: der Server laeuft weiter wie ohne MONGODB_URI
mongoose.connect = () => Promise.reject(new Error('keine Datenbank (db-attrappe)'));
