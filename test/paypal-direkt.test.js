// Tests fuer paypal-direkt.js. Laufen ohne Datenbank, ohne .env und ohne PayPal
// (unveraendert in andere Standorte kopierbar, brauchen nur ../paypal-direkt):
// PayPal ist eine vorgetaeuschte fetch-Funktion, die Datenbank ein Speicher im Arbeitsspeicher.
const test   = require('node:test');
const assert = require('node:assert/strict');
const pp     = require('../paypal-direkt');
// Eigenstaendig: kein stripe-direkt.js noetig (das Modul passt so auch in andere Standorte)
const erstelleKontoPruefer = pp.erstelleProbe;

const LIVE = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'geheim', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_ENV: 'live' };
const stumm = { log() {}, warn() {}, error() {} };
const MIN = 60 * 1000;

// ─── Vorgetaeuschtes PayPal ──────────────────────────────────────
// orders: id -> { status, wert, waehrung, nr, einzugStatus }
// webhooks: id -> { id, url, event_types }; anlegenScheitert: Anzahl POSTs, die mit 500 scheitern;
// anderer: Webhook, den "ein anderer Prozess" kurz vor unserem POST anlegt (-> WEBHOOK_URL_ALREADY_EXISTS)
function fakePaypal({ tokenOk = true, verify = 'SUCCESS', verifyWirft = false, verzoegerung = 0,
                      anlegenScheitert = 0, webhookStatus = 0, anderer = null, doppeltErlaubt = false } = {}) {
  const orders = new Map();
  const webhooks = new Map();
  const aufrufe = [];
  let einzuege = 0, naechste = 1, naechsterWh = 1;
  const antwort = (status, daten) => ({ ok: status < 300, status, text: async () => JSON.stringify(daten) });
  const ppOrder = (id, o) => ({
    id, status: o.status,
    purchase_units: [{ reference_id: String(o.nr), custom_id: String(o.nr),
      amount: { currency_code: 'EUR', value: o.betrag },
      ...(o.einzug ? { payments: { captures: [o.einzug] } } : {}) }],
    links: [{ rel: 'payer-action', href: `https://www.paypal.com/checkoutnow?token=${id}` }],
  });
  async function fetch(url, opt = {}) {
    aufrufe.push({ url, method: opt.method, headers: opt.headers || {}, body: opt.body });
    if (verzoegerung) await new Promise(r => setTimeout(r, verzoegerung));
    const u = new URL(url);
    if (u.host !== 'api-m.paypal.com') throw new Error('falscher Host ' + u.host);
    if (u.pathname === '/v1/oauth2/token') {
      return tokenOk ? antwort(200, { access_token: 'tok', expires_in: 32000 }) : antwort(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    if (u.pathname === '/v1/notifications/verify-webhook-signature') {
      if (verifyWirft) return antwort(500, { name: 'INTERNAL_SERVICE_ERROR', message: 'kaputt' });
      return antwort(200, { verification_status: verify });
    }
    if (u.pathname.startsWith('/v1/notifications/webhooks')) {
      if (webhookStatus) return antwort(webhookStatus, { name: 'NOT_AUTHORIZED', message: 'Authorization failed' });
      const wid = decodeURIComponent(u.pathname.split('/')[4] || '');
      if (!wid && opt.method === 'GET') return antwort(200, { webhooks: [...webhooks.values()].map(w => structuredClone(w)) });
      if (!wid && opt.method === 'POST') {
        const b = JSON.parse(opt.body);
        if (anlegenScheitert > 0) { anlegenScheitert--; return antwort(500, { name: 'INTERNAL_SERVICE_ERROR', message: 'gerade nicht' }); }
        if (anderer) { webhooks.set(anderer.id, anderer); anderer = null; }
        if (!doppeltErlaubt && [...webhooks.values()].some(w => w.url === b.url)) return antwort(400, { name: 'WEBHOOK_URL_ALREADY_EXISTS', message: 'Webhook URL already exists' });
        const id = 'WH' + String(naechsterWh++).padStart(8, '0') + 'X';
        webhooks.set(id, { id, url: b.url, event_types: b.event_types });
        return antwort(201, structuredClone(webhooks.get(id)));
      }
      const w = webhooks.get(wid);
      if (!w) return antwort(404, { name: 'INVALID_RESOURCE_ID', message: 'Webhook not found' });
      if (opt.method === 'PATCH') {
        const p = JSON.parse(opt.body);
        if (p[0].op === 'replace' && p[0].path === '/event_types') w.event_types = p[0].value;
        return antwort(200, structuredClone(w));
      }
      if (opt.method === 'DELETE') { webhooks.delete(wid); return { ok: true, status: 204, text: async () => '' }; }
    }
    if (u.pathname === '/v2/checkout/orders' && opt.method === 'POST') {
      const b = JSON.parse(opt.body);
      const id = 'PP' + String(naechste++).padStart(8, '0');
      orders.set(id, { status: 'PAYER_ACTION_REQUIRED', betrag: b.purchase_units[0].amount.value, nr: b.purchase_units[0].custom_id });
      return antwort(201, ppOrder(id, orders.get(id)));
    }
    const m = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return antwort(404, { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }], message: 'not found' });
      if (!m[2]) return antwort(200, ppOrder(m[1], o));
      if (o.status === 'COMPLETED') return antwort(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }], message: 'already' });
      if (o.status !== 'APPROVED') return antwort(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }], message: 'not approved' });
      if (o.ablehnen) return antwort(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }], message: 'declined' });
      einzuege++;
      o.status = 'COMPLETED';
      o.einzug = { id: 'CAP' + m[1], status: o.einzugStatus || 'COMPLETED',
                   amount: { currency_code: o.waehrung || 'EUR', value: o.bezahlt || o.betrag } };
      return antwort(201, ppOrder(m[1], o));
    }
    return antwort(404, { name: 'NOT_FOUND' });
  }
  return { fetch, orders, webhooks, aufrufe, get einzuege() { return einzuege; },
    anlegen(id, felder) { orders.set(id, { status: 'APPROVED', betrag: '23.49', nr: 1001, ...felder }); } };
}

// ─── Speicher wie in server.js (atomar, nur aus awaiting_payment) ──
function fakeSpeicher(orders, { nachgeholt = false } = {}) {
  const db = new Map(orders.map(o => [o._id, o]));
  let buchungen = 0;
  return {
    db, get buchungen() { return buchungen; },
    async einbuchen(order, einzug) {
      const o = db.get(order._id);
      const offen = o && (o.status === 'awaiting_payment' || (o.status === 'cancelled' && o.zahlungAbgelaufen && o.paymentStatus === 'pending'));
      if (!offen) return null;
      Object.assign(o, { status: 'pending', paymentStatus: 'paid', paypalCaptureId: einzug.id, ...(nachgeholt ? { nachgeholt: true } : {}) });
      delete o.zahlungAbgelaufen;
      buchungen++;
      return { ...o };
    },
    async abschliessen(order) {
      const o = db.get(order._id);
      if (!o || o.status !== 'awaiting_payment') return false;
      Object.assign(o, { status: 'cancelled', zahlungAbgelaufen: true });
      return true;
    },
    finden: async id => { for (const o of db.values()) if (o.paypalOrderId === id) return { ...o }; return null; },
  };
}

const bestellung = (felder = {}) => ({ _id: 'o1', orderNum: 1001, payment: 'paypal', paymentStatus: 'pending',
  status: 'awaiting_payment', total: 23.49, paypalOrderId: 'PPAAAA0001', createdAt: new Date(), ...felder });

const kopf = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert',
  'paypal-transmission-id': 'tid', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-11-19T12:00:00Z' };
const ereignis = (typ, ppId) => typ.startsWith('CHECKOUT.ORDER.')
  ? { event_type: typ, resource: { id: ppId } }
  : { event_type: typ, resource: { id: 'CAP' + ppId, supplementary_data: { related_ids: { order_id: ppId } } } };

// ─── Schalter ────────────────────────────────────────────────────

test('Schalter: zwei Werte UND PAYPAL_ENV genau live; PAYPAL_WEBHOOK_ID ist nur optionale Vorgabe', () => {
  const werte = { PAYPAL_CLIENT_ID: [undefined, '', 'cid'], PAYPAL_CLIENT_SECRET: [undefined, '  ', 'geheim'],
    PAYPAL_WEBHOOK_ID: [undefined, 'WH-1'], PAYPAL_ENV: [undefined, '', 'sandbox', 'LIVE', 'live ', 'production', 'live'] };
  let anzahl = 0, ein = 0;
  for (const a of werte.PAYPAL_CLIENT_ID) for (const b of werte.PAYPAL_CLIENT_SECRET)
    for (const c of werte.PAYPAL_WEBHOOK_ID) for (const d of werte.PAYPAL_ENV) {
      const env = {};
      if (a !== undefined) env.PAYPAL_CLIENT_ID = a;
      if (b !== undefined) env.PAYPAL_CLIENT_SECRET = b;
      if (c !== undefined) env.PAYPAL_WEBHOOK_ID = c;
      if (d !== undefined) env.PAYPAL_ENV = d;
      const k = pp.paypalKonfiguration(env);
      const soll = a === 'cid' && b === 'geheim' && d === 'live';
      assert.equal(k.vollstaendig, soll, JSON.stringify(env));
      assert.equal(k.zugang, soll, JSON.stringify(env));
      assert.equal(k.schluessel, a === 'cid' && b === 'geheim', JSON.stringify(env));
      assert.equal(k.webhookVorgabe, c === 'WH-1' ? 'WH-1' : null);
      if (!soll) assert.ok(k.fehlend.length > 0);
      else assert.deepEqual(k.fehlend, []);
      anzahl++; if (soll) ein++;
    }
  assert.equal(anzahl, 3 * 3 * 2 * 7);
  assert.equal(ein, 2);   // mit und ohne PAYPAL_WEBHOOK_ID
  assert.equal(pp.paypalKonfiguration({}).teilweise, false);
  assert.equal(pp.paypalKonfiguration({ PAYPAL_ENV: 'sandbox' }).teilweise, true);
  assert.equal(pp.paypalKonfiguration({ PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'g' }).teilweise, true);
  assert.equal(JSON.stringify(pp.paypalKonfiguration(LIVE)).includes('geheim'), false, 'kein Geheimwert in der Ausgabe');
});

test('Schalter: Probe nur bei vollstaendiger Live-Einrichtung, Sandbox wird nie angesprochen', async () => {
  const kombis = [
    {}, { ...LIVE, PAYPAL_ENV: 'sandbox' }, { ...LIVE, PAYPAL_ENV: undefined }, { ...LIVE, PAYPAL_WEBHOOK_ID: '' },
    { ...LIVE, PAYPAL_CLIENT_SECRET: undefined }, { ...LIVE, PAYPAL_CLIENT_ID: '' }, { ...LIVE, PAYPAL_ENV: 'Live' },
  ];
  for (const env of kombis) {
    const f = fakePaypal();
    const istBereit = erstelleKontoPruefer({ abrufen: async () => { await pp.erstelleClient({ env, fetch: f.fetch }).token(); return true; } });
    assert.equal(await pp.paypalBereit({ env, istBereit }), false, JSON.stringify(env));
    assert.equal(f.aufrufe.length, 0, 'keine Anfrage an PayPal: ' + JSON.stringify(env));
  }
  const f = fakePaypal();
  const istBereit = erstelleKontoPruefer({ abrufen: async () => { await pp.erstelleClient({ env: LIVE, fetch: f.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit }), true);
  assert.equal(f.aufrufe.length, 1);
  assert.equal(f.aufrufe[0].url, 'https://api-m.paypal.com/v1/oauth2/token');
});

test('Client: ohne Live-Zugang keine einzige Anfrage, auch nicht fuer Einzug oder Erstattung', async () => {
  for (const env of [{ ...LIVE, PAYPAL_ENV: 'sandbox' }, { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'g' }, {}]) {
    const f = fakePaypal();
    const c = pp.erstelleClient({ env, fetch: f.fetch });
    await assert.rejects(c.token(), /nicht eingerichtet/);
    await assert.rejects(c.aufruf('/v2/payments/captures/X/refund', 'POST', 'tok', {}), /nicht eingerichtet/);
    assert.equal(f.aufrufe.length, 0);
  }
});

test('Schalter: fehlgeschlagene Probe -> aus; Zwischenspeicher 5 min / 1 min; Zeitlimit', async () => {
  let jetzt = 0;
  const f = fakePaypal({ tokenOk: false });
  const istBereit = erstelleKontoPruefer({ uhr: () => jetzt,
    abrufen: async () => { await pp.erstelleClient({ env: LIVE, fetch: f.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit }), false);
  assert.equal(f.aufrufe.length, 1);
  jetzt += 30 * 1000;
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit }), false);
  assert.equal(f.aufrufe.length, 1, 'Fehler 1 Minute zwischengespeichert');
  jetzt += 31 * 1000;
  const g = fakePaypal();   // PayPal geht wieder (neuer Pruefer, eigene Uhr)
  const istBereit2 = erstelleKontoPruefer({ uhr: () => jetzt,
    abrufen: async () => { await pp.erstelleClient({ env: LIVE, fetch: g.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: istBereit2 }), true);
  jetzt += 4 * MIN;
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: istBereit2 }), true);
  assert.equal(g.aufrufe.length, 1, 'Erfolg 5 Minuten zwischengespeichert');
  jetzt += 2 * MIN;
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: istBereit2 }), true);
  assert.equal(g.aufrufe.length, 2, 'nach 5 Minuten neu gefragt');

  // PayPal haengt: nach dem Zeitlimit aus, ohne zu werfen
  const langsam = erstelleKontoPruefer({ zeitlimitMs: 30, abrufen: () => new Promise(() => {}) });
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: langsam }), false);
  // Wirft der Pruefer selbst: aus
  assert.equal(await pp.paypalBereit({ env: LIVE, istBereit: () => { throw new Error('x'); } }), false);
});

// ─── Bestellung anlegen ──────────────────────────────────────────

test('Bestellung fuer PayPal: gespeicherter Betrag, EUR, zwei Stellen, Rueckkehr- und Abbruchadresse', () => {
  const b = pp.bestellungFuerPaypal({ orderNum: 1042, total: 12.5, statusToken: 'abc_DEF', frontend: 'https://odis-ahaus.com', laden: 'Odi’s Bowl Ahaus' });
  assert.equal(b.intent, 'CAPTURE');
  assert.deepEqual(b.purchase_units[0].amount, { currency_code: 'EUR', value: '12.50' });
  assert.equal(b.purchase_units[0].custom_id, '1042');
  const x = b.payment_source.paypal.experience_context;
  assert.equal(x.return_url, 'https://odis-ahaus.com?order=1042&t=abc_DEF&paypal=1');
  assert.equal(x.cancel_url, 'https://odis-ahaus.com?payment=cancelled&paypal=1');
  assert.equal(x.user_action, 'PAY_NOW');
  assert.equal(pp.bestellungFuerPaypal({ orderNum: 1, total: 0.1 + 0.2, statusToken: 't', frontend: 'f', laden: 'l' }).purchase_units[0].amount.value, '0.30');
});

test('Freigabe-Link: nur https auf paypal.com', () => {
  assert.equal(pp.freigabeLink({ links: [{ rel: 'self', href: 'https://api-m.paypal.com/x' }, { rel: 'payer-action', href: 'https://www.paypal.com/checkoutnow?token=1' }] }), 'https://www.paypal.com/checkoutnow?token=1');
  assert.equal(pp.freigabeLink({ links: [{ rel: 'approve', href: 'https://www.paypal.com/checkoutnow?token=1' }] }), 'https://www.paypal.com/checkoutnow?token=1');
  assert.equal(pp.freigabeLink({ links: [{ rel: 'payer-action', href: 'https://boese.example/paypal.com/' }] }), null);
  assert.equal(pp.freigabeLink({}), null);
});

test('betragPruefen: Positionen muessen zur Zwischensumme passen', () => {
  const items = [{ name: 'Bowl', price: 11.9, qty: 2 }, { name: 'Cola', price: 2.9 }];
  assert.equal(pp.betragPruefen({ items, subtotal: 26.7, total: 28.69 }), null);
  assert.match(pp.betragPruefen({ items, subtotal: 5, total: 5.99 }), /geändert/);
  assert.match(pp.betragPruefen({ items: [], subtotal: 0, total: 0.99 }), /leer/);
  assert.match(pp.betragPruefen({ items: [{ price: -5, qty: 1 }, { price: 10, qty: 1 }], subtotal: 5, total: 5.99 }), /Ungültig/);
  assert.match(pp.betragPruefen({ items: [{ price: 5, qty: 0.5 }], subtotal: 2.5, total: 3.49 }), /Ungültig/);
  assert.match(pp.betragPruefen({ items: [{ price: 0, qty: 1 }], subtotal: 0, total: 0 }), /Bestellbetrag/);
});

test('istPaypalId: keine Objekte oder Sonderzeichen an Datenbank und PayPal', () => {
  assert.equal(pp.istPaypalId('5O190127TN364715T'), true);
  assert.equal(pp.istPaypalId({ $ne: null }), false);
  assert.equal(pp.istPaypalId('../../v1/x'), false);
  assert.equal(pp.istPaypalId(''), false);
});

// ─── Betragspruefung beim Einbuchen ──────────────────────────────

test('betragPasst: passt / zu wenig / falsche Waehrung', () => {
  assert.equal(pp.betragPasst({ wert: '23.49', waehrung: 'EUR' }, 23.49), true);
  assert.equal(pp.betragPasst({ wert: '23.5', waehrung: 'EUR' }, 23.5), true);
  assert.equal(pp.betragPasst({ wert: '23.48', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '0.01', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '23.50', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '23.49', waehrung: 'USD' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: '23.49' }, 23.49), false);
  assert.equal(pp.betragPasst({ wert: 'abc', waehrung: 'EUR' }, 23.49), false);
  assert.equal(pp.betragPasst(null, 23.49), false);
});

test('Abgleich: freigegeben -> eingezogen und eingebucht', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.ergebnis, 'eingebucht');
  assert.equal(f.einzuege, 1);
  assert.equal(s.db.get('o1').paymentStatus, 'paid');
  assert.equal(s.db.get('o1').status, 'pending');
  assert.equal(s.db.get('o1').paypalCaptureId, 'CAPPPAAAA0001');
});

for (const [name, felder] of [['zu wenig bezahlt', { bezahlt: '20.00' }], ['falsche Waehrung', { waehrung: 'USD' }]]) {
  test(`Abgleich: ${name} -> NICHT eingebucht, laut gemeldet`, async () => {
    const f = fakePaypal(); f.anlegen('PPAAAA0001', felder);
    const s = fakeSpeicher([bestellung()]);
    const fehler = [];
    const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s,
      melden: { ...stumm, error: m => fehler.push(m) } });
    assert.equal(r.ergebnis, 'betrag');
    assert.equal(s.db.get('o1').status, 'awaiting_payment');
    assert.equal(s.db.get('o1').paymentStatus, 'pending');
    assert.equal(s.buchungen, 0);
    assert.match(fehler.join(' '), /NICHT eingebucht/);
    // Auch der Wachhund schliesst sie nicht ab (Geld ist geflossen, Mensch muss pruefen)
    const w = await pp.wachhundLauf({ orders: [bestellung({ createdAt: new Date(Date.now() - 90 * MIN) })],
      client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
    assert.deepEqual(w, { nachgeholt: [], abgeschlossen: [] });
    assert.equal(s.db.get('o1').status, 'awaiting_payment');
  });
}

test('Abgleich: Einzug PENDING bei PayPal -> nicht eingebucht, nicht abgeschlossen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { einzugStatus: 'PENDING' });
  const s = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 90 * MIN) })]);
  const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.ergebnis, 'wartet');
  const w = await pp.wachhundLauf({ orders: [{ ...s.db.get('o1') }], client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.deepEqual(w.abgeschlossen, []);
  assert.equal(s.db.get('o1').paymentStatus, 'pending');
});

test('Abgleich: PayPal-Bestellung gehoert zu einer anderen Nummer -> nichts gebucht', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { nr: 999, status: 'COMPLETED', einzug: { id: 'C', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '23.49' } } });
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.abgleichen({ order: bestellung(), client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.ergebnis, 'fremd');
  assert.equal(s.buchungen, 0);
});

// ─── Kein doppeltes Einbuchen ────────────────────────────────────

test('Rueckkehr, Webhook und Wachhund gleichzeitig: ein Einzug, eine Buchung', async () => {
  for (const verzoegerung of [0, 3]) {
    const f = fakePaypal({ verzoegerung }); f.anlegen('PPAAAA0001');
    const alt = bestellung({ createdAt: new Date(Date.now() - 15 * MIN) });
    const s = fakeSpeicher([alt]);
    const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
    const ergebnisse = await Promise.all([
      pp.rueckkehrVerarbeiten({ body: { paypalOrderId: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm }),
      pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm }),
      pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm }),
      pp.wachhundLauf({ orders: [{ ...alt }], client, speicher: s, melden: stumm }),
      pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm }),
    ]);
    assert.equal(f.einzuege, 1, 'PayPal zieht nur einmal ein');
    assert.equal(s.buchungen, 1, 'nur eine Buchung');
    assert.equal(ergebnisse[0].json.ok, true);
    assert.equal(ergebnisse[1].status, 200);
    assert.equal(s.db.get('o1').status, 'pending');
    // Spaete Wiederholung des Webhooks, nachdem die Kasse angenommen hat: bleibt, wie es ist
    s.db.get('o1').status = 'confirmed';
    const spaet = await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm });
    assert.equal(spaet.status, 200);
    assert.equal(s.db.get('o1').status, 'confirmed');
    assert.equal(s.buchungen, 1);
  }
});

// ─── Nie bezahlt: abschliessen ───────────────────────────────────

test('Wachhund: nie bezahlte PayPal-Bestellung wird nach einer Stunde abgeschlossen (kein Storno)', async () => {
  const f = fakePaypal();
  f.anlegen('PPAAAA0001', { status: 'PAYER_ACTION_REQUIRED' });
  f.anlegen('PPAAAA0002', { status: 'CREATED', nr: 1002 });
  const jung = bestellung({ createdAt: new Date(Date.now() - 30 * MIN) });
  const alt  = bestellung({ _id: 'o2', orderNum: 1002, paypalOrderId: 'PPAAAA0002', createdAt: new Date(Date.now() - 61 * MIN) });
  const weg  = bestellung({ _id: 'o3', orderNum: 1003, paypalOrderId: 'PPAAAA0003', createdAt: new Date(Date.now() - 61 * MIN) }); // bei PayPal unbekannt
  const s = fakeSpeicher([jung, alt, weg]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const w = await pp.wachhundLauf({ orders: [jung, alt, weg].map(o => ({ ...o })), client, speicher: s, melden: stumm });
  assert.deepEqual(w.abgeschlossen.sort(), [1002, 1003]);
  assert.equal(f.einzuege, 0);
  assert.equal(s.db.get('o1').status, 'awaiting_payment');
  for (const id of ['o2', 'o3']) {
    const o = s.db.get(id);
    assert.equal(o.status, 'cancelled');
    assert.equal(o.paymentStatus, 'pending', 'nie bezahlt: weder Kasse noch Umsatz noch Stornoliste');
    assert.equal(o.cancelReason, undefined);
  }
});

test('Wachhund: freigegeben, nicht eingezogen -> bis 2 h einziehen (nachgeholt), danach abschliessen ohne Einzug', async () => {
  const f = fakePaypal();
  f.anlegen('PPAAAA0001');
  f.anlegen('PPAAAA0002', { nr: 1002 });
  const frisch = bestellung({ createdAt: new Date(Date.now() - 12 * MIN) });
  const zuAlt  = bestellung({ _id: 'o2', orderNum: 1002, paypalOrderId: 'PPAAAA0002', createdAt: new Date(Date.now() - 121 * MIN) });
  const s = fakeSpeicher([frisch, zuAlt], { nachgeholt: true });
  const w = await pp.wachhundLauf({ orders: [{ ...frisch }, { ...zuAlt }], client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(w.nachgeholt.length, 1);
  assert.equal(w.nachgeholt[0].nachgeholt, true);
  assert.deepEqual(w.abgeschlossen, [1002]);
  assert.equal(f.einzuege, 1, 'die zu alte Freigabe wird nie eingezogen');
  assert.equal(s.db.get('o2').paymentStatus, 'pending');
});

test('Wachhund: juenger als 10 Minuten unberuehrt; ohne PayPal-Zugang erst nach einem Tag abschliessen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 5 * MIN) })]);
  await pp.wachhundLauf({ orders: [{ ...s.db.get('o1') }], client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(f.aufrufe.length, 0);
  assert.equal(s.db.get('o1').status, 'awaiting_payment');

  const t = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 23 * 60 * MIN) }),
                          bestellung({ _id: 'o2', orderNum: 1002, createdAt: new Date(Date.now() - 25 * 60 * MIN) })]);
  const w = await pp.wachhundLauf({ orders: [...t.db.values()].map(o => ({ ...o })), client: null, speicher: t, melden: stumm });
  assert.deepEqual(w.abgeschlossen, [1002]);
  assert.equal(t.db.get('o1').status, 'awaiting_payment');
});

test('Wachhund wirft nie: PayPal nicht erreichbar -> uebersprungen, nichts abgeschlossen', async () => {
  const s = fakeSpeicher([bestellung({ createdAt: new Date(Date.now() - 90 * MIN) })]);
  const client = pp.erstelleClient({ env: LIVE, fetch: async () => { throw new Error('Netz weg'); } });
  const w = await pp.wachhundLauf({ orders: [{ ...s.db.get('o1') }], client, speicher: s, melden: stumm });
  assert.deepEqual(w, { nachgeholt: [], abgeschlossen: [] });
  assert.equal(s.db.get('o1').status, 'awaiting_payment');
});

// ─── Rueckkehr des Gastes ────────────────────────────────────────

test('Rueckkehr: abgelaufene Bestellung wird nie mehr eingezogen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');   // Gast hat nach Ablauf doch noch freigegeben
  const s = fakeSpeicher([bestellung({ status: 'cancelled', zahlungAbgelaufen: true })]);
  const r = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden,
    client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.abgelaufen, true);
  assert.equal(f.einzuege, 0);
  assert.equal(s.db.get('o1').status, 'cancelled');
});

test('Rueckkehr: Einzug lief beim Abschliessen gerade noch durch -> trotzdem eingebucht', async () => {
  const f = fakePaypal();
  f.anlegen('PPAAAA0001', { status: 'COMPLETED', einzug: { id: 'CAPX', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '23.49' } } });
  const s = fakeSpeicher([bestellung({ status: 'cancelled', zahlungAbgelaufen: true })]);
  const r = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden,
    client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), speicher: s, melden: stumm });
  assert.equal(r.json.ok, true);
  assert.equal(s.db.get('o1').status, 'pending');
  assert.equal(s.db.get('o1').paymentStatus, 'paid');
});

test('Rueckkehr: abgelehnte Zahlungsquelle -> Hinweis, Bestellung sofort abgeschlossen', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { ablehnen: true });
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const r = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm });
  assert.equal(r.json.ok, false);
  assert.equal(r.json.abgelehnt, true);
  assert.equal(s.db.get('o1').status, 'cancelled');
  assert.equal(s.db.get('o1').paymentStatus, 'pending');
});

test('Rueckkehr: noch nicht freigegeben, ungueltige ID, unbekannt, ohne Live-Zugang', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { status: 'PAYER_ACTION_REQUIRED' });
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const a = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: LIVE, finden: s.finden, client, speicher: s, melden: stumm });
  assert.deepEqual([a.status, a.json.ok, a.json.abgelaufen], [200, false, undefined]);
  assert.equal(s.db.get('o1').status, 'awaiting_payment');
  assert.equal((await pp.rueckkehrVerarbeiten({ body: { token: { $ne: null } }, env: LIVE, finden: s.finden, client, speicher: s })).status, 400);
  assert.equal((await pp.rueckkehrVerarbeiten({ body: { token: 'PPZZZZ9999' }, env: LIVE, finden: s.finden, client, speicher: s })).status, 404);
  const g = fakePaypal(); g.anlegen('PPAAAA0001');
  const sb = await pp.rueckkehrVerarbeiten({ body: { token: 'PPAAAA0001' }, env: { ...LIVE, PAYPAL_ENV: 'sandbox' }, finden: s.finden,
    client: pp.erstelleClient({ env: { ...LIVE, PAYPAL_ENV: 'sandbox' }, fetch: g.fetch }), speicher: s });
  assert.equal(sb.status, 503);
  assert.equal(g.aufrufe.length, 0);
  assert.equal(s.buchungen, 0);
});

// ─── Webhook ─────────────────────────────────────────────────────

test('Webhook: ohne gueltige Signatur wird nichts eingebucht', async () => {
  const f = fakePaypal({ verify: 'FAILURE' }); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const r = await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'), client, finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r.status, 400);
  assert.equal(f.einzuege, 0);
  assert.equal(s.buchungen, 0);
  // Ohne Signatur-Kopfzeilen wird PayPal gar nicht erst gefragt
  const g = fakePaypal(); g.anlegen('PPAAAA0001');
  const r2 = await pp.webhookVerarbeiten({ env: LIVE, headers: { 'paypal-auth-algo': 'x' }, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env: LIVE, fetch: g.fetch }), finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r2.status, 400);
  assert.equal(g.aufrufe.length, 0);
  assert.equal(s.buchungen, 0);
});

test('Webhook: ohne PAYPAL_WEBHOOK_ID oder ohne live -> 503, nichts eingebucht, keine Anfrage', async () => {
  for (const env of [{ ...LIVE, PAYPAL_WEBHOOK_ID: '' }, { ...LIVE, PAYPAL_ENV: 'sandbox' }]) {
    const f = fakePaypal(); f.anlegen('PPAAAA0001');
    const s = fakeSpeicher([bestellung()]);
    const r = await pp.webhookVerarbeiten({ env, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'),
      client: pp.erstelleClient({ env, fetch: f.fetch }), finden: s.finden, speicher: s, melden: stumm });
    assert.equal(r.status, 503);
    assert.equal(f.aufrufe.length, 0);
    assert.equal(s.buchungen, 0);
  }
});

test('Webhook: Antworten - eigene Fehler erneut, fremde Ereignisse nicht endlos', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001');
  const s = fakeSpeicher([bestellung()]);
  const client = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const w = (event, extra = {}) => pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event, client, finden: s.finden, speicher: s, melden: stumm, ...extra });
  // unbekanntes Ereignis
  assert.deepEqual(await w({ event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: {} }), { status: 200, json: { received: true, ignoriert: true } });
  // Bestellung aus einem anderen Shop desselben PayPal-Kontos
  assert.equal((await w(ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPFREMD0001'))).json.ignoriert, true);
  // Datenbank gestoert -> 500 (PayPal stellt erneut zu)
  assert.equal((await w(ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), { finden: async () => { throw new Error('DB weg'); } })).status, 500);
  // Signaturpruefung bei PayPal gerade nicht moeglich -> 503
  const g = fakePaypal({ verifyWirft: true });
  assert.equal((await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env: LIVE, fetch: g.fetch }), finden: s.finden, speicher: s, melden: stumm })).status, 503);
  assert.equal(s.buchungen, 0);
  // gueltig -> eingezogen und eingebucht
  const ok = await w(ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'));
  assert.equal(ok.status, 200);
  assert.equal(s.db.get('o1').paymentStatus, 'paid');
  // Die Signaturpruefung bekam die Webhook-ID und das Ereignis
  const v = f.aufrufe.find(a => a.url.endsWith('/verify-webhook-signature'));
  assert.equal(JSON.parse(v.body).webhook_id, 'WH-1');
  assert.equal(JSON.parse(v.body).transmission_sig, 'sig');
});

test('Webhook: Betrag passt nicht -> 200 (Wiederholung hilft nicht), aber nicht eingebucht', async () => {
  const f = fakePaypal(); f.anlegen('PPAAAA0001', { bezahlt: '1.00' });
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.webhookVerarbeiten({ env: LIVE, headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env: LIVE, fetch: f.fetch }), finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r.status, 200);
  assert.equal(s.buchungen, 0);
  assert.equal(s.db.get('o1').paymentStatus, 'pending');
});

test('Anlegen ueber den Client: Request-Id und gespeicherter Betrag gehen an PayPal', async () => {
  const f = fakePaypal();
  const c = pp.erstelleClient({ env: LIVE, fetch: f.fetch });
  const o = await c.bestellungAnlegen(pp.bestellungFuerPaypal({ orderNum: 1001, total: 23.49, statusToken: 't', frontend: 'https://odis-ahaus.com', laden: 'L' }), 'odis-1001-t');
  assert.equal(pp.istPaypalId(o.id), true);
  assert.equal(pp.freigabeLink(o), `https://www.paypal.com/checkoutnow?token=${o.id}`);
  const post = f.aufrufe.find(a => a.url.endsWith('/v2/checkout/orders'));
  assert.equal(post.headers['PayPal-Request-Id'], 'odis-1001-t');
  assert.equal(JSON.parse(post.body).purchase_units[0].amount.value, '23.49');
  assert.ok(f.aufrufe.every(a => a.url.startsWith('https://api-m.paypal.com/')));
});

test('Webhook-Ereignisse fuer die PayPal-App', () => {
  assert.deepEqual(pp.WEBHOOK_EREIGNISSE, ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED']);
  assert.equal(pp.ppOrderIdAusEreignis(ereignis('CHECKOUT.ORDER.APPROVED', 'PPX0000001')), 'PPX0000001');
  assert.equal(pp.ppOrderIdAusEreignis(ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPX0000001')), 'PPX0000001');
});

// ─── Webhook selbst sicherstellen (zwei Werte genuegen) ──────────

const ZWEI   = { PAYPAL_CLIENT_ID: 'cid-laden', PAYPAL_CLIENT_SECRET: 'geheim-laden', PAYPAL_ENV: 'live' };
const BASIS  = 'https://api.odis-ahaus.com';
const WH_URL = 'https://api.odis-ahaus.com/api/paypal-webhook';
const wh = (id, url, namen) => ({ id, url, event_types: namen.map(name => ({ name })) });
const namenVon = w => w.event_types.map(e => e.name).sort();
const anlegeAufrufe = f => f.aufrufe.filter(a => a.method === 'POST' && a.url === 'https://api-m.paypal.com/v1/notifications/webhooks');

function fakeAblage(start = null, { lesenWirft = false, schreibenWirft = false } = {}) {
  let eintrag = start;
  const a = {
    gelesen: 0, geschrieben: 0,
    get eintrag() { return eintrag; },
    async lesen() { a.gelesen++; if (lesenWirft) throw new Error('DB weg'); return eintrag ? structuredClone(eintrag) : null; },
    async schreiben(w) { if (schreibenWirft) throw new Error('DB weg'); a.geschrieben++; eintrag = structuredClone(w); },
    async loeschen() { eintrag = null; },
  };
  return a;
}

function verwalter(f, { env = ZWEI, ablage = fakeAblage(), apiBasis = BASIS, uhr } = {}) {
  const m = [];
  const melden = { log: t => m.push(['log', t]), warn: t => m.push(['warn', t]), error: t => m.push(['error', t]) };
  const v = pp.erstelleWebhookVerwalter({ env, client: pp.erstelleClient({ env, fetch: f.fetch }), ablage, apiBasis, melden,
    ...(uhr ? { uhr } : {}) });
  return { v, ablage, m, fehlerText: () => m.filter(x => x[0] === 'error').map(x => x[1]).join('\n') };
}

const immerBereit = () => erstelleKontoPruefer({ abrufen: async () => true });

test('Webhook vorhanden -> dessen ID uebernommen, nichts angelegt, gemerkt (ohne Client-ID)', async () => {
  const f = fakePaypal();
  f.webhooks.set('WHFREMD0001', wh('WHFREMD0001', 'https://anderer-laden.de/api/paypal-webhook', ['*']));
  f.webhooks.set('WHALT00001', wh('WHALT00001', WH_URL, pp.WEBHOOK_EREIGNISSE));
  const { v, ablage } = verwalter(f);
  assert.equal(v.id(), null);
  assert.equal(await pp.paypalBereit({ env: ZWEI, istBereit: immerBereit(), webhookId: v.id() }), false, 'ohne Webhook aus');
  assert.equal(await v.sicherstellen(), 'WHALT00001');
  assert.equal(v.id(), 'WHALT00001');
  assert.equal(anlegeAufrufe(f).length, 0);
  assert.equal(f.aufrufe.some(a => a.method === 'PATCH'), false);
  assert.equal(f.webhooks.size, 2);
  assert.equal(ablage.eintrag.id, 'WHALT00001');
  assert.equal(ablage.eintrag.url, WH_URL);
  assert.equal(JSON.stringify(ablage.eintrag).includes('cid-laden'), false, 'die Client-ID wird nicht gespeichert');
  assert.equal(await pp.paypalBereit({ env: ZWEI, istBereit: immerBereit(), webhookId: v.id() }), true);
  assert.match(v.zustand().quelle, /gefunden/);
  // Alles nur gegen Live, nie Sandbox
  assert.ok(f.aufrufe.every(a => a.url.startsWith('https://api-m.paypal.com/')));
});

test('Webhook vorhanden, Ereignis fehlt -> ergaenzt, vorhandene Ereignisse bleiben', async () => {
  const f = fakePaypal();
  f.webhooks.set('WHALT00001', wh('WHALT00001', 'https://API.odis-ahaus.com/api/paypal-webhook/', ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.REFUNDED']));
  const { v, ablage } = verwalter(f);
  assert.equal(await v.sicherstellen(), 'WHALT00001');
  const patch = f.aufrufe.filter(a => a.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].url, 'https://api-m.paypal.com/v1/notifications/webhooks/WHALT00001');
  assert.deepEqual(namenVon(f.webhooks.get('WHALT00001')), ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.REFUNDED']);
  assert.equal(anlegeAufrufe(f).length, 0);
  assert.match(v.zustand().quelle, /ergaenzt/);
  assert.ok(ablage.eintrag.ereignisse.includes('PAYMENT.CAPTURE.COMPLETED'));
  // Alle Ereignisse ('*'): nichts zu ergaenzen
  const g = fakePaypal();
  g.webhooks.set('WHSTERN001', wh('WHSTERN001', WH_URL, ['*']));
  assert.equal(await verwalter(g).v.sicherstellen(), 'WHSTERN001');
  assert.equal(g.aufrufe.filter(a => a.method === 'PATCH').length, 0);
});

test('Kein Webhook vorhanden -> erst auflisten, dann angelegt (Adresse und Ereignisse), danach nicht erneut', async () => {
  const f = fakePaypal();
  const { v, ablage, m } = verwalter(f);
  const id = await v.sicherstellen();
  assert.match(id, /^WH/);
  const wAufrufe = f.aufrufe.filter(a => a.url.includes('/notifications/webhooks'));
  assert.equal(wAufrufe[0].method, 'GET', 'vor dem Anlegen wird aufgelistet');
  assert.deepEqual(JSON.parse(anlegeAufrufe(f)[0].body),
    { url: WH_URL, event_types: [{ name: 'CHECKOUT.ORDER.APPROVED' }, { name: 'PAYMENT.CAPTURE.COMPLETED' }] });
  assert.equal(f.webhooks.size, 1);
  assert.equal(ablage.eintrag.id, id);
  assert.match(m.map(x => x[1]).join('\n'), /bereit \(vom Server angelegt\)/);
  const vorher = f.aufrufe.length;
  assert.equal(await v.sicherstellen(), id);
  assert.equal(await v.anstossen(), id);
  assert.equal(f.aufrufe.length, vorher, 'bekannt und frisch: keine Anfrage');
  assert.equal(anlegeAufrufe(f).length, 1);
});

test('Anlegen scheitert -> PayPal bleibt aus, klare Logzeile, Pause waechst, spaeterer Versuch gelingt', async () => {
  let jetzt = 1e12;
  const f = fakePaypal({ anlegenScheitert: 2 });
  const { v, fehlerText } = verwalter(f, { uhr: () => jetzt });
  assert.equal(await v.sicherstellen(), null);
  assert.equal(v.id(), null);
  assert.equal(await pp.paypalBereit({ env: ZWEI, istBereit: immerBereit(), webhookId: v.id() }), false);
  assert.match(fehlerText(), /Webhook nicht sichergestellt: .*gerade nicht.*PayPal bleibt aus.*Naechster Versuch in 1 Min/);
  assert.equal(v.zustand().vorhanden, false);
  assert.ok(v.zustand().naechsterVersuch);
  assert.equal(f.webhooks.size, 0);

  // Innerhalb der Pause: keine einzige Anfrage, auch nicht ueber anstossen oder sicherstellen
  let n = f.aufrufe.length;
  jetzt += 30 * 1000;
  assert.equal(await v.anstossen(), null);
  assert.equal(await v.sicherstellen(), null);
  assert.equal(f.aufrufe.length, n);

  // Nach der Pause: zweiter Fehlschlag, jetzt 2 Minuten Pause
  jetzt += 31 * 1000;
  assert.equal(await v.anstossen(), null);
  assert.match(fehlerText(), /Naechster Versuch in 2 Min/);
  n = f.aufrufe.length;
  jetzt += 61 * 1000;
  await v.anstossen();
  assert.equal(f.aufrufe.length, n, 'Pause von 2 Minuten eingehalten');

  jetzt += 60 * 1000;
  const id = await v.anstossen();
  assert.match(id, /^WH/);
  assert.equal(f.webhooks.size, 1);
  assert.equal(v.zustand().fehler, null);
  assert.equal(await pp.paypalBereit({ env: ZWEI, istBereit: immerBereit(), webhookId: v.id() }), true);
});

test('Gemerkte ID: beim Start keine Anfrage; nach 12 h bestaetigt; verschwunden -> neu sichergestellt', async () => {
  let jetzt = 1e12;
  const f = fakePaypal();
  const ablage = fakeAblage();
  const erste = await verwalter(f, { ablage, uhr: () => jetzt }).v.sicherstellen();
  assert.match(erste, /^WH/);

  // Neustart: dieselbe Datenbank, PayPal wird nicht gefragt
  const n = f.aufrufe.length;
  const { v, fehlerText } = verwalter(f, { ablage, uhr: () => jetzt });
  assert.equal(await v.sicherstellen(), erste);
  assert.equal(f.aufrufe.length, n, 'gemerkt: keine Anfrage beim Start');
  assert.match(v.zustand().quelle, /gemerkt/);

  // Nach 12 h: Bestaetigung per Liste (vorhanden -> nur GET, nichts angelegt)
  jetzt += 12 * 3600 * 1000 + 1;
  assert.equal(await v.anstossen(), erste);
  assert.equal(anlegeAufrufe(f).length, 1);

  // Jemand loescht den Webhook in der PayPal-App
  f.webhooks.clear();
  jetzt += 12 * 3600 * 1000 + 1;
  const neu = await v.anstossen();
  assert.match(neu, /^WH/);
  assert.notEqual(neu, erste);
  assert.equal(ablage.eintrag.id, neu);
  assert.match(fehlerText(), new RegExp(`${erste} gibt es in der PayPal-App nicht mehr`));

  // Gemerkt fuer eine andere App (Client-ID gewechselt) oder andere Adresse: gilt nicht
  for (const [env, apiBasis] of [[{ ...ZWEI, PAYPAL_CLIENT_ID: 'neue-app' }, BASIS], [ZWEI, 'https://api.neu-ahaus.de']]) {
    const g = fakePaypal();
    const w = verwalter(g, { env, apiBasis, ablage: fakeAblage(structuredClone(ablage.eintrag)) });
    const id = await w.v.sicherstellen();
    assert.notEqual(id, neu);
    assert.equal(anlegeAufrufe(g).length, 1);
  }
});

test('Signaturpruefung scheitert, gemerkter Webhook weg -> neu sichergestellt (hoechstens alle 10 Minuten)', async () => {
  let jetzt = 1e12;
  const f = fakePaypal({ verify: 'FAILURE' });
  const ablage = fakeAblage();
  const alt = await verwalter(f, { ablage, uhr: () => jetzt }).v.sicherstellen();
  f.webhooks.clear();   // in der PayPal-App geloescht

  const { v } = verwalter(f, { ablage, uhr: () => jetzt });   // Neustart, ID aus der Datenbank
  assert.equal(await v.sicherstellen(), alt);
  const s = fakeSpeicher([bestellung()]);
  const r = await pp.webhookVerarbeiten({ env: ZWEI, webhookId: v.id(), beiSignaturFehler: v.verdachtMelden, headers: kopf,
    event: ereignis('PAYMENT.CAPTURE.COMPLETED', 'PPAAAA0001'), client: pp.erstelleClient({ env: ZWEI, fetch: f.fetch }),
    finden: s.finden, speicher: s, melden: stumm });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(f.aufrufe.find(a => a.url.endsWith('/verify-webhook-signature')).body).webhook_id, alt);
  const neu = await v.sicherstellen();   // laeuft schon (vom Verdacht angestossen)
  assert.match(neu, /^WH/);
  assert.notEqual(neu, alt);
  assert.equal(f.webhooks.size, 1);
  assert.equal(s.buchungen, 0);

  // Weitere Signaturfehler kurz danach: keine neue Liste bei PayPal
  const n = f.aufrufe.length;
  v.verdachtMelden(); v.verdachtMelden();
  await v.sicherstellen();
  assert.equal(f.aufrufe.length, n);
  // Nach 10 Minuten darf wieder nachgesehen werden (Webhook ist da: nur Liste, nichts angelegt)
  jetzt += 10 * 60 * 1000;
  v.verdachtMelden();
  await v.sicherstellen();
  assert.ok(f.aufrufe.length > n);
  assert.equal(anlegeAufrufe(f).length, 2);
});

test('Vorgabe von Hand (PAYPAL_WEBHOOK_ID) hat Vorrang: keine Webhook-Anfrage, keine Datenbank', async () => {
  const env = { ...ZWEI, PAYPAL_WEBHOOK_ID: ' WHHAND0001 ' };
  const f = fakePaypal();
  f.webhooks.set('WHAUTO0001', wh('WHAUTO0001', WH_URL, pp.WEBHOOK_EREIGNISSE));
  const { v, ablage } = verwalter(f, { env, ablage: fakeAblage({ id: 'WHGEMERKT1', url: WH_URL, app: 'x' }) });
  assert.equal(v.id(), 'WHHAND0001');
  assert.equal(await v.sicherstellen(), 'WHHAND0001');
  assert.equal(await v.anstossen(), 'WHHAND0001');
  v.verdachtMelden();
  assert.equal(f.aufrufe.length, 0);
  assert.equal(ablage.gelesen, 0);
  assert.match(v.zustand().quelle, /von Hand/);
  const s = fakeSpeicher([bestellung()]);
  await pp.webhookVerarbeiten({ env, webhookId: v.id(), headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'),
    client: pp.erstelleClient({ env, fetch: f.fetch }), finden: s.finden, speicher: s, melden: stumm });
  assert.equal(JSON.parse(f.aufrufe.find(a => a.url.endsWith('/verify-webhook-signature')).body).webhook_id, 'WHHAND0001');
});

test('Schluessel ohne PAYPAL_ENV=live -> aus und KEIN Aufruf bei PayPal (auch kein Webhook, keine Datenbank)', async () => {
  for (const env of [{ PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'g' }, { ...ZWEI, PAYPAL_ENV: 'sandbox' },
                     { ...ZWEI, PAYPAL_ENV: 'LIVE' }, { ...ZWEI, PAYPAL_ENV: '' }, {}]) {
    const f = fakePaypal();
    const { v, ablage } = verwalter(f, { env });
    assert.equal(await v.sicherstellen(), null);
    assert.equal(await v.sicherstellen({ erzwingen: true }), null);
    assert.equal(await v.anstossen(), null);
    v.verdachtMelden();
    assert.equal(v.id(), null);
    assert.equal(v.zustand().vorhanden, false);
    const probe = erstelleKontoPruefer({ abrufen: async () => { await pp.erstelleClient({ env, fetch: f.fetch }).token(); return true; } });
    assert.equal(await pp.paypalBereit({ env, istBereit: probe, webhookId: v.id() }), false);
    const s = fakeSpeicher([bestellung()]);
    assert.equal((await pp.webhookVerarbeiten({ env, webhookId: v.id(), headers: kopf, event: ereignis('CHECKOUT.ORDER.APPROVED', 'PPAAAA0001'),
      client: pp.erstelleClient({ env, fetch: f.fetch }), finden: s.finden, speicher: s, melden: stumm })).status, 503);
    assert.equal(f.aufrufe.length, 0, JSON.stringify(env));
    assert.equal(ablage.gelesen, 0);
    const st = pp.paypalStatus({ env, probe: null, webhook: v.zustand(), sichtbar: false });
    assert.equal(st.modus, 'aus');
    assert.equal(st.fuerGaesteSichtbar, false);
  }
});

test('Unsichere Adresse (kein https, localhost, IP, fremder Port) -> Webhook wird nie angelegt', async () => {
  for (const basis of ['http://api.odis-ahaus.com', 'https://localhost:3001', 'https://127.0.0.1', 'https://[::1]',
                       'https://api.localhost', 'https://intern', 'https://10.0.0.5', 'https://api.odis-ahaus.com:8443',
                       'https://u:p@api.odis-ahaus.com', 'https://api.odis-ahaus.com/?x=1', '', 'kein url', null]) {
    const f = fakePaypal();
    const { v, fehlerText } = verwalter(f, { apiBasis: basis });
    assert.equal(await v.sicherstellen(), null, String(basis));
    assert.equal(await v.sicherstellen({ erzwingen: true }), null);
    assert.equal(f.aufrufe.length, 0, 'keine Anfrage: ' + basis);
    assert.ok(v.zustand().fehler, String(basis));
    assert.match(fehlerText(), /PayPal bleibt aus/);
  }
  assert.deepEqual(pp.webhookAdresse('https://api.odis-ahaus.com/'), { url: WH_URL });
  assert.deepEqual(pp.webhookAdresse(' https://API.odis-ahaus.com '), { url: WH_URL });
  assert.deepEqual(pp.webhookAdresse('https://api.odis-ahaus.com:443'), { url: WH_URL });
});

test('"Schon vorhanden" beim Anlegen (anderer Prozess war schneller) -> erneut auflisten, kein Duplikat', async () => {
  const f = fakePaypal({ anderer: wh('WHANDERS01', WH_URL, pp.WEBHOOK_EREIGNISSE) });
  const { v } = verwalter(f);
  assert.equal(await v.sicherstellen(), 'WHANDERS01');
  assert.equal(f.webhooks.size, 1);
  assert.equal(anlegeAufrufe(f).length, 1);
});

test('Zwei Prozesse gleichzeitig -> am Ende ein Webhook, beide nutzen dieselbe ID', async () => {
  for (const doppeltErlaubt of [false, true]) {
    const f = fakePaypal({ verzoegerung: 3, doppeltErlaubt });
    const a = verwalter(f), b = verwalter(f);
    const [x, y] = await Promise.all([a.v.sicherstellen(), b.v.sicherstellen()]);
    assert.equal(x, y, 'doppeltErlaubt=' + doppeltErlaubt);
    assert.equal(f.webhooks.size, 1, 'doppeltErlaubt=' + doppeltErlaubt);
    assert.ok(f.webhooks.has(x));
  }
  // In einem Prozess: gleichzeitige Aufrufe teilen sich einen Lauf
  const f = fakePaypal({ verzoegerung: 2 });
  const { v } = verwalter(f);
  const ids = await Promise.all([v.sicherstellen(), v.anstossen(), v.sicherstellen(), v.anstossen()]);
  assert.equal(new Set(ids).size, 1);
  assert.equal(anlegeAufrufe(f).length, 1);
});

test('Sicherstellen wirft nie: Netz weg, Datenbank weg, 403 mit klarem Grund', async () => {
  const netzWeg = { fetch: async () => { throw new Error('Netz weg'); } };
  const a = verwalter(netzWeg, { ablage: fakeAblage(null, { lesenWirft: true }) });
  assert.equal(await a.v.sicherstellen(), null);
  assert.match(a.v.zustand().fehler, /Netz weg/);

  // Datenbank nicht beschreibbar: im Prozess trotzdem bekannt, Warnung im Log
  const f = fakePaypal();
  const b = verwalter(f, { ablage: fakeAblage(null, { schreibenWirft: true }) });
  assert.match(await b.v.sicherstellen(), /^WH/);
  assert.match(b.m.map(x => x[1]).join('\n'), /nicht in der Datenbank gemerkt/);

  // PayPal verweigert die Webhook-Verwaltung (App ohne Recht): klarer Ausweg
  const g = fakePaypal({ webhookStatus: 403 });
  const c = verwalter(g);
  assert.equal(await c.v.sicherstellen(), null);
  assert.match(c.v.zustand().fehler, /403.*PAYPAL_WEBHOOK_ID/);

  // Anmeldung scheitert
  const h = fakePaypal({ tokenOk: false });
  const d = verwalter(h);
  assert.equal(await d.v.sicherstellen(), null);
  assert.match(d.v.zustand().fehler, /Anmeldung bei PayPal scheitert/);
  assert.equal(h.aufrufe.length, 1, 'nach gescheiterter Anmeldung keine weitere Anfrage');
});

test('paypalBereit: ohne bekannten Webhook keine Probe-Anfrage', async () => {
  const f = fakePaypal();
  const probe = erstelleKontoPruefer({ abrufen: async () => { await pp.erstelleClient({ env: ZWEI, fetch: f.fetch }).token(); return true; } });
  assert.equal(await pp.paypalBereit({ env: ZWEI, istBereit: probe, webhookId: null }), false);
  assert.equal(f.aufrufe.length, 0);
  assert.equal(await pp.paypalBereit({ env: ZWEI, istBereit: probe, webhookId: 'WH00000001X' }), true);
  assert.equal(f.aufrufe.length, 1);
});

test('Statusauskunft: Klartext je Stufe, keine Geheimnisse', async () => {
  const geheim = 'EJ-SUPERGEHEIM-secret-123', cid = 'AV-CLIENT-ID-xyz-987';
  const voll = { PAYPAL_CLIENT_ID: cid, PAYPAL_CLIENT_SECRET: geheim, PAYPAL_ENV: 'live' };
  const ohneGeheim = st => {
    const t = JSON.stringify(st);
    assert.equal(t.includes(geheim), false, 'Secret in der Auskunft');
    assert.equal(t.includes(cid), false, 'Client-ID in der Auskunft');
  };

  let st = pp.paypalStatus({ env: {}, webhook: {}, sichtbar: false });
  assert.deepEqual(st.schluesselGesetzt, { PAYPAL_CLIENT_ID: false, PAYPAL_CLIENT_SECRET: false });
  assert.equal(st.modus, 'aus');
  assert.match(st.naechsterSchritt, /PAYPAL_CLIENT_ID und PAYPAL_CLIENT_SECRET/);

  st = pp.paypalStatus({ env: { ...voll, PAYPAL_ENV: 'sandbox' }, webhook: {}, sichtbar: false });
  assert.deepEqual(st.schluesselGesetzt, { PAYPAL_CLIENT_ID: true, PAYPAL_CLIENT_SECRET: true });
  assert.equal(st.modus, 'aus');
  assert.match(st.modusHinweis, /nicht genau "live"/);
  assert.match(st.naechsterSchritt, /PAYPAL_ENV=live/);
  assert.equal(JSON.stringify(st).includes('sandbox'), false, 'der Wert von PAYPAL_ENV wird nicht ausgegeben');
  ohneGeheim(st);

  // Probe scheitert, und der Fehlertext enthielte (theoretisch) die Werte
  st = pp.paypalStatus({ env: voll, probe: { ok: false, grund: `PayPal Auth: ${cid}:${geheim} abgelehnt` }, webhook: {}, sichtbar: false });
  assert.match(st.probeAnmeldung, /^fehlgeschlagen: PayPal Auth: \*\*\*:\*\*\* abgelehnt/);
  assert.match(st.naechsterSchritt, /Anmeldung bei PayPal scheitert/);
  ohneGeheim(st);

  // Echter Ablauf: Webhook angelegt, sichtbar
  const f = fakePaypal();
  const { v } = verwalter(f, { env: voll });
  st = pp.paypalStatus({ env: voll, probe: { ok: true }, webhook: v.zustand(), sichtbar: false });
  assert.equal(st.webhook.vorhanden, false);
  assert.equal(st.webhook.adresse, WH_URL);
  assert.match(st.naechsterSchritt, /Webhook noch nicht bereit/);
  await v.sicherstellen();
  const sichtbar = await pp.paypalBereit({ env: voll, istBereit: immerBereit(), webhookId: v.id() });
  st = pp.paypalStatus({ env: voll, probe: { ok: true }, webhook: v.zustand(), sichtbar });
  assert.equal(st.modus, 'live');
  assert.equal(st.probeAnmeldung, 'ok');
  assert.equal(st.webhook.vorhanden, true);
  assert.equal(st.webhook.adresse, WH_URL);
  assert.deepEqual(st.webhook.ereignisse, pp.WEBHOOK_EREIGNISSE);
  assert.equal(st.fuerGaesteSichtbar, true);
  assert.match(st.naechsterSchritt, /eingeschaltet/);
  ohneGeheim(st);
  ohneGeheim(v.zustand());
});
