// ═══════════════════════════════════════════════════════════════
// PAYPAL DIREKT (Odi's Bowl Ahaus, 19.11.2026)
// ═══════════════════════════════════════════════════════════════
// PayPal laeuft NICHT ueber Stripe (das geht mit Direct Charges nicht), sondern
// direkt ueber die REST-App im eigenen PayPal-Geschaeftskonto des Ladens: Das Geld
// geht direkt auf sein PayPal-Konto. Orders v2, intent CAPTURE, ohne SDK.
//
// Der Schalter (Stand 19.11.2026): Je Laden werden nur ZWEI Werte eingetragen,
// PAYPAL_CLIENT_ID und PAYPAL_CLIENT_SECRET der Live-REST-App des Ladens. Scharf
// geschaltet wird bewusst mit PAYPAL_ENV=live. PayPal gilt erst als eingerichtet, wenn
//  - beide Werte gesetzt sind und PAYPAL_ENV genau `live` ist,
//  - eine Probe-Anmeldung bei PayPal (Token holen) gelingt UND
//  - ein Webhook bekannt ist. Den legt der Server selbst in der PayPal-App an bzw.
//    findet ihn dort (erstelleWebhookVerwalter, unten); PAYPAL_WEBHOOK_ID bleibt als
//    optionale Vorgabe von Hand und hat dann Vorrang.
// Mit Sandbox-Daten kann auf dieser Seite nie "bezahlt" werden: Ohne PAYPAL_ENV=live
// gibt es keinen einzigen PayPal-Aufruf, weder Bestellung noch Einzug noch Webhook.
//
// Geld bewegt sich bei intent CAPTURE erst mit dem Einzug (capture), und den
// macht nur dieser Server. Deshalb:
//  - eingezogen wird nur, solange die Bestellung hier auf `awaiting_payment` steht;
//    eine abgelaufene (nie bezahlte) Bestellung wird nie mehr eingezogen;
//  - eingebucht wird nur, wenn PayPal den Einzug als COMPLETED meldet und Betrag und
//    Waehrung genau zur gespeicherten Bestellung passen;
//  - Einbuchen ist atomar und nur aus `awaiting_payment` heraus (server.js), Rueckkehr,
//    Webhook und Wachhund koennen also gleichzeitig laufen, ohne doppelt zu buchen.
//    PayPal selbst nimmt fuer eine Bestellung nur einen Einzug an.
//
// Dieses Modul enthaelt nur, was sich ohne Express, Mongoose und echtes PayPal
// rechnen laesst. PayPal-Aufrufe gehen ueber eine injizierbare fetch-Funktion,
// die Datenbank ueber ein injiziertes `speicher`- bzw. `ablage`-Objekt
// (test/paypal-direkt.test.js). Einzige weitere Abhaengigkeit ist Nodes eigenes crypto.

const crypto = require('crypto');

const LIVE_BASIS = 'https://api-m.paypal.com';
// Die zwei Pflichtwerte je Laden. PAYPAL_ENV=live ist der Schalter, PAYPAL_WEBHOOK_ID
// eine optionale Vorgabe von Hand.
const PAYPAL_VARIABLEN = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'];
// Route des Webhooks auf dem eigenen Server (server.js)
const WEBHOOK_PFAD = '/api/paypal-webhook';

// Fristen fuer Wachhund und Aufraeumen (alle 5 Minuten, server.js)
const FRISTEN = {
  // Erst danach greift der Wachhund ein; vorher laufen Rueckkehr und Webhook.
  wachhundMinuten: 10,
  // Nie bezahlt (bei PayPal nicht freigegeben): nach einer Stunde abgeschlossen wie
  // eine abgelaufene Stripe-Zahlung. Stripe schliesst seine Zahlseite nach 31 Minuten.
  abbruchMinuten: 60,
  // Freigegeben, aber nie eingezogen: nur bis 2 Stunden nach der Bestellung noch
  // einziehen (wie WACHHUND_HOECHSTENS_STUNDEN bei Stripe). Danach wartet kein Gast
  // mehr; die Bestellung wird abgeschlossen, ohne dass Geld fliesst.
  einziehenHoechstensStunden: 2,
  // PayPal nicht (mehr) eingerichtet: ohne Rueckfrage abschliessen, aber erst nach
  // einem Tag. Eingezogen werden kann ohne Zugang ohnehin nichts.
  ohneZugangStunden: 24,
  // Aeltere Bestellungen fasst der Wachhund nicht mehr an.
  hoechstensTage: 7,
};

// ─── Schalter ────────────────────────────────────────────────────

// Was ist gesetzt? Nie Geheimwerte, nur Ja/Nein und die fehlenden Namen.
//  schluessel:     Client-ID und Secret gesetzt (egal ob scharf geschaltet)
//  zugang:         zusaetzlich PAYPAL_ENV=live -> PayPal darf angesprochen werden
//                  (Einziehen, Abgleichen, Erstatten, Webhook sicherstellen)
//  vollstaendig:   dasselbe wie zugang (alle Pflichtwerte und der Schalter)
//  webhookVorgabe: PAYPAL_WEBHOOK_ID von Hand, sonst null (optional, hat Vorrang)
function paypalKonfiguration(env = {}) {
  const gesetzt = n => typeof env[n] === 'string' && env[n].trim() !== '';
  const live = env.PAYPAL_ENV === 'live';
  const schluessel = PAYPAL_VARIABLEN.every(gesetzt);
  const fehlend = PAYPAL_VARIABLEN.filter(n => !gesetzt(n));
  if (!live) fehlend.push('PAYPAL_ENV=live');
  const irgendwas = [...PAYPAL_VARIABLEN, 'PAYPAL_WEBHOOK_ID'].some(gesetzt)
    || (typeof env.PAYPAL_ENV === 'string' && env.PAYPAL_ENV !== '');
  const zugang = live && schluessel;
  return {
    live,
    schluessel,
    zugang,
    vollstaendig:   zugang,
    teilweise:      irgendwas && !zugang,
    fehlend,
    clientId:       gesetzt('PAYPAL_CLIENT_ID') ? env.PAYPAL_CLIENT_ID.trim() : null,
    webhookVorgabe: gesetzt('PAYPAL_WEBHOOK_ID') ? env.PAYPAL_WEBHOOK_ID.trim() : null,
  };
}

// Probe-Anmeldung mit Zwischenspeicher (dieselbe Logik wie erstelleKontoPruefer in
// stripe-direkt.js, hier eigenstaendig, damit das Modul in Standorte ohne
// stripe-direkt.js passt). Liefert istBereit(schluessel) -> Promise<boolean>: fragt
// hoechstens alle `ttlMs` (Fehler: `fehlerTtlMs`), wartet hoechstens `zeitlimitMs`,
// wirft nie. `abrufen()` muss true liefern, wenn die Anmeldung gelingt.
function erstelleProbe({ abrufen, ttlMs = 5 * 60 * 1000, fehlerTtlMs = 60 * 1000,
                         zeitlimitMs = 4000, uhr = () => Date.now(), melden = () => {} }) {
  let speicher = null;   // { schluessel, bereit, bis }
  let laufend  = null;   // { schluessel, promise } - gleichzeitige Anfragen teilen sich eine Probe
  async function fragen(schluessel) {
    let timer;
    try {
      const ergebnis = await Promise.race([
        Promise.resolve().then(() => abrufen(schluessel)),
        new Promise((_, nein) => { timer = setTimeout(() => nein(new Error('Zeitlimit')), zeitlimitMs); }),
      ]);
      const bereit = ergebnis === true;
      speicher = { schluessel, bereit, bis: uhr() + ttlMs };
      return bereit;
    } catch (e) {
      try { melden(e); } catch { /* Melden darf nie stoeren */ }
      speicher = { schluessel, bereit: false, bis: uhr() + fehlerTtlMs };
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  async function istBereit(schluessel) {
    if (!schluessel) return false;
    if (speicher && speicher.schluessel === schluessel && uhr() < speicher.bis) return speicher.bereit;
    if (laufend && laufend.schluessel === schluessel) return laufend.promise;
    const promise = fragen(schluessel);
    laufend = { schluessel, promise };
    try { return await promise; } finally { if (laufend && laufend.promise === promise) laufend = null; }
  }
  // Nach einer gescheiterten PayPal-Bestellung sofort neu fragen
  istBereit.vergessen = () => { speicher = null; };
  return istBereit;
}

// Entscheidung fuer /api/config und create-paypal-order: true nur, wenn Schluessel und
// Schalter stehen, ein Webhook bekannt ist UND die Probe-Anmeldung gelingt. istBereit
// kommt aus erstelleProbe (Zwischenspeicher 5 min / Fehler 1 min, 4 s Zeitlimit). webhookId: die bekannte Webhook-ID (verwalter.id()); fehlt das
// Argument, gilt PAYPAL_WEBHOOK_ID. Fragt PayPal nur, wenn alles andere steht. Wirft nie.
async function paypalBereit({ env, istBereit, webhookId }) {
  try {
    const k = paypalKonfiguration(env);
    if (!k.zugang) return false;
    const id = webhookId === undefined ? k.webhookVorgabe : webhookId;
    if (!id) return false;
    return (await istBereit(k.clientId)) === true;
  } catch {
    return false;
  }
}

// ─── PayPal-Aufrufe ──────────────────────────────────────────────

class PaypalFehler extends Error {
  constructor(text, { status, name } = {}) {
    super(text);
    this.status = status;     // HTTP-Status von PayPal
    this.paypalName = name;   // z. B. ORDER_ALREADY_CAPTURED, RESOURCE_NOT_FOUND
  }
}

// Client fuer genau ein env. Wirft bei jedem Aufruf, wenn kein Live-Zugang gesetzt
// ist - die Sandbox wird nie angesprochen.
function erstelleClient({ env, fetch: holen = globalThis.fetch, zeitlimitMs = 15000 }) {
  async function anfrage(url, optionen) {
    const k = paypalKonfiguration(env);
    if (!k.zugang) throw new PaypalFehler('PayPal nicht eingerichtet (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=live)');
    const r = await holen(url, { ...optionen, signal: AbortSignal.timeout(zeitlimitMs) });
    const text = await r.text();
    let daten = {};
    try { daten = text ? JSON.parse(text) : {}; } catch { daten = { message: text.slice(0, 200) }; }
    return { r, daten };
  }

  async function token() {
    const id = String(env.PAYPAL_CLIENT_ID || '').trim(), geheim = String(env.PAYPAL_CLIENT_SECRET || '').trim();
    const { r, daten } = await anfrage(`${LIVE_BASIS}/v1/oauth2/token`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${Buffer.from(`${id}:${geheim}`).toString('base64')}`,
                 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok || !daten.access_token) {
      throw new PaypalFehler('PayPal Auth: ' + (daten.error_description || daten.error || r.status), { status: r.status, name: daten.error });
    }
    return daten.access_token;
  }

  // Wie das frühere paypalApi(path, method, token, body) in server.js
  async function aufruf(pfad, methode, zugangsToken, body, { requestId, vollstaendig } = {}) {
    const headers = { 'Authorization': `Bearer ${zugangsToken}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    if (vollstaendig) headers['Prefer'] = 'return=representation';
    const { r, daten } = await anfrage(`${LIVE_BASIS}${pfad}`, {
      method: methode, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      const name = daten.name || (Array.isArray(daten.details) && daten.details[0] && daten.details[0].issue) || undefined;
      const issue = Array.isArray(daten.details) && daten.details[0] && daten.details[0].issue;
      throw new PaypalFehler(`PayPal API ${pfad}: ${daten.message || daten.error_description || r.status}${issue ? ' (' + issue + ')' : ''}`,
        { status: r.status, name: issue || name });
    }
    return daten;
  }

  async function bestellungLesen(ppOrderId, t) {
    return aufruf(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}`, 'GET', t || await token());
  }
  async function einziehen(ppOrderId, t) {
    return aufruf(`/v2/checkout/orders/${encodeURIComponent(ppOrderId)}/capture`, 'POST', t || await token(), {}, { vollstaendig: true });
  }
  async function bestellungAnlegen(body, requestId) {
    return aufruf('/v2/checkout/orders', 'POST', await token(), body, { requestId, vollstaendig: true });
  }
  async function signaturPruefen(daten) {
    return aufruf('/v1/notifications/verify-webhook-signature', 'POST', await token(), daten);
  }
  // Webhooks der App (Notifications API v1). Eine App hat hoechstens 10 Webhooks.
  async function webhooksAuflisten(t) {
    const d = await aufruf('/v1/notifications/webhooks', 'GET', t || await token());
    return Array.isArray(d.webhooks) ? d.webhooks : [];
  }
  async function webhookAnlegen(url, ereignisse, t) {
    return aufruf('/v1/notifications/webhooks', 'POST', t || await token(),
      { url, event_types: ereignisse.map(name => ({ name })) });
  }
  async function webhookEreignisseSetzen(id, ereignisse, t) {
    return aufruf(`/v1/notifications/webhooks/${encodeURIComponent(id)}`, 'PATCH', t || await token(),
      [{ op: 'replace', path: '/event_types', value: ereignisse.map(name => ({ name })) }]);
  }
  async function webhookLoeschen(id, t) {
    return aufruf(`/v1/notifications/webhooks/${encodeURIComponent(id)}`, 'DELETE', t || await token());
  }
  return { token, aufruf, bestellungLesen, einziehen, bestellungAnlegen, signaturPruefen,
           webhooksAuflisten, webhookAnlegen, webhookEreignisseSetzen, webhookLoeschen };
}

// ─── Bestellung anlegen ──────────────────────────────────────────

// PayPal-Bestellnummern sind kurze Zeichenketten aus Grossbuchstaben und Ziffern.
// Alles andere (auch Objekte wie {"$ne": null}) wird nie an Datenbank oder PayPal gereicht.
const istPaypalId = id => typeof id === 'string' && /^[A-Za-z0-9-]{6,64}$/.test(id);

const cent = n => Math.round(Number(n) * 100);
const euroText = n => (cent(n) / 100).toFixed(2);

// Prueft den Warenkorb einer PayPal-Bestellung, bevor ein Betrag an PayPal geht.
// total ist der Betrag, den der Server speichert (wie bei Stripe aus subtotal und
// Gebuehren gerechnet). Bei PayPal wird genau dieser Betrag eingezogen - anders als bei
// Stripe gibt es keine Einzelposten, die PayPal selbst summiert. Damit eine
// heruntergesetzte subtotal nicht billiger macht, muss sie zu den Positionen passen.
function betragPruefen({ items, subtotal, total }) {
  if (!Array.isArray(items) || !items.length) return 'Der Warenkorb ist leer.';
  const kaputt = i => !i || typeof i !== 'object' || !(Number(i.price) >= 0)
    || (i.qty !== undefined && !(Number.isInteger(Number(i.qty)) && Number(i.qty) >= 1));
  if (items.some(kaputt)) return 'Ungültiger Warenkorb. Bitte lade die Seite neu.';
  const ausPositionen = items.reduce((s, i) => s + cent((Number(i && i.price) || 0) * (Number(i && i.qty) || 1)), 0);
  if (!Number.isFinite(Number(subtotal)) || Math.abs(ausPositionen - cent(subtotal)) > 1) {
    return 'Der Warenkorb hat sich geändert. Bitte lade die Seite neu und versuche es erneut.';
  }
  if (!Number.isFinite(Number(total)) || cent(total) <= 0) return 'Ungültiger Bestellbetrag.';
  return null;
}

// Rumpf fuer POST /v2/checkout/orders. Betrag = gespeicherter Gesamtbetrag, EUR, zwei
// Nachkommastellen. reference_id/custom_id = Bestellnummer (wird beim Einbuchen geprueft).
function bestellungFuerPaypal({ orderNum, total, statusToken, frontend, laden }) {
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: String(orderNum),
      custom_id:    String(orderNum),
      description:  `${laden} Bestellung #${orderNum}`,
      amount: { currency_code: 'EUR', value: euroText(total) },
    }],
    payment_source: { paypal: { experience_context: {
      brand_name:          laden,
      locale:              'de-DE',
      user_action:         'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      // Nur Zahlarten, die sofort bestaetigt werden (kein eCheck mit Tagen Wartezeit)
      payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
      // PayPal haengt an beide Adressen ?token=<PayPal-Bestellnummer> an
      return_url: `${frontend}?order=${orderNum}&t=${statusToken}&paypal=1`,
      cancel_url: `${frontend}?payment=cancelled&paypal=1`,
    } } },
  };
}

// Freigabe-Link aus der Antwort (payment_source: payer-action, frueher: approve)
function freigabeLink(ppOrder) {
  const l = ((ppOrder && ppOrder.links) || []).find(x => x && (x.rel === 'payer-action' || x.rel === 'approve'));
  return l && typeof l.href === 'string' && /^https:\/\/([a-z0-9-]+\.)*paypal\.com\//.test(l.href) ? l.href : null;
}

// ─── Zahlung auswerten ───────────────────────────────────────────

// Der Einzug einer PayPal-Bestellung (Antwort von GET oder capture). Bei mehreren
// zaehlt der abgeschlossene.
function einzugAus(ppOrder) {
  const pu = ppOrder && Array.isArray(ppOrder.purchase_units) ? ppOrder.purchase_units[0] : null;
  const caps = pu && pu.payments && Array.isArray(pu.payments.captures) ? pu.payments.captures : [];
  const c = caps.find(x => x && x.status === 'COMPLETED') || caps[0];
  if (!c) return null;
  return {
    id: c.id, status: c.status,
    wert: c.amount ? c.amount.value : undefined,
    waehrung: c.amount ? c.amount.currency_code : undefined,
  };
}

// Gehoert die PayPal-Bestellung zu dieser Bestellung? (custom_id/reference_id)
function gehoertZu(ppOrder, order) {
  const pu = ppOrder && Array.isArray(ppOrder.purchase_units) ? ppOrder.purchase_units[0] : null;
  if (!pu) return false;
  const nr = String(order.orderNum);
  return pu.custom_id === nr || pu.reference_id === nr;
}

// Passt der bei PayPal bezahlte Betrag genau zur gespeicherten Bestellung?
function betragPasst(einzug, total) {
  if (!einzug || einzug.waehrung !== 'EUR') return false;
  if (typeof einzug.wert !== 'string' || !/^\d+(\.\d{1,2})?$/.test(einzug.wert)) return false;
  return cent(einzug.wert) === cent(total) && cent(total) > 0;
}

// ─── Abgleich: das eine Verfahren fuer Rueckkehr, Webhook und Wachhund ──
//
// Fragt PayPal nach dem Stand, zieht eine freigegebene Zahlung ein (nur wenn
// `einziehenErlaubt`), und bucht ein, wenn der Einzug abgeschlossen ist und Betrag und
// Waehrung passen. speicher.einbuchen(order, einzug) muss atomar sein und nur aus
// `awaiting_payment` (oder einer gerade abgelaufenen Bestellung, s. server.js) heraus
// buchen; es liefert die gebuchte Bestellung oder null.
//
// Ergebnis: { ergebnis, order?, ppStatus? } mit ergebnis
//  'eingebucht'  - jetzt gebucht (dieser Aufruf)
//  'schon'       - war schon gebucht (anderer Weg kam zuerst)
//  'offen'       - bei PayPal (noch) nicht bezahlt; ppStatus sagt, in welchem Stand
//  'wartet'      - Einzug liegt bei PayPal auf PENDING (Geld noch nicht da)
//  'betrag'      - bezahlt, aber Betrag/Waehrung passen nicht: NICHT eingebucht
//  'fremd'       - PayPal-Bestellung gehoert nicht zu dieser Bestellung
async function abgleichen({ order, client, speicher, einziehenErlaubt = true, melden = console }) {
  if (!order || !istPaypalId(order.paypalOrderId)) return { ergebnis: 'fremd' };
  const t = await client.token();
  let pp;
  try {
    pp = await client.bestellungLesen(order.paypalOrderId, t);
  } catch (e) {
    if (e.status === 404) return { ergebnis: 'offen', ppStatus: 'NICHT_GEFUNDEN' };
    throw e;
  }
  if (!gehoertZu(pp, order)) {
    melden.error(`🚨 PayPal: Bestellung ${order.paypalOrderId} gehoert nicht zu #${order.orderNum} - nichts gebucht`);
    return { ergebnis: 'fremd' };
  }

  let einzug = einzugAus(pp);
  let ppStatus = pp.status;
  if (pp.status === 'APPROVED' && !einzug && einziehenErlaubt && order.status === 'awaiting_payment') {
    try {
      const antwort = await client.einziehen(order.paypalOrderId, t);
      einzug = einzugAus(antwort);
      ppStatus = antwort.status || ppStatus;
    } catch (e) {
      // Zahlungsquelle abgelehnt: kein Geld geflossen. Der Aufrufer schliesst ab.
      if (e.paypalName === 'INSTRUMENT_DECLINED') return { ergebnis: 'offen', ppStatus: 'EINZUG_DECLINED' };
      // Ein anderer Weg (Rueckkehr, Webhook, Wachhund) hat schon eingezogen.
      if (e.paypalName !== 'ORDER_ALREADY_CAPTURED') throw e;
    }
    if (!einzug || einzug.wert === undefined) {
      const neu = await client.bestellungLesen(order.paypalOrderId, t);
      einzug = einzugAus(neu);
      ppStatus = neu.status;
    }
  }

  if (einzug && einzug.status === 'COMPLETED') {
    if (!betragPasst(einzug, order.total)) {
      melden.error(`🚨 PayPal: #${order.orderNum} bezahlt ${einzug.wert} ${einzug.waehrung}, erwartet ${euroText(order.total)} EUR`
        + ` - NICHT eingebucht (Einzug ${einzug.id}). Bitte im PayPal-Konto des Ladens pruefen.`);
      return { ergebnis: 'betrag', ppStatus };
    }
    const gebucht = await speicher.einbuchen(order, einzug);
    return gebucht ? { ergebnis: 'eingebucht', order: gebucht, ppStatus } : { ergebnis: 'schon', ppStatus };
  }
  if (einzug && einzug.status === 'PENDING') return { ergebnis: 'wartet', ppStatus };
  return { ergebnis: 'offen', ppStatus: einzug ? `EINZUG_${einzug.status}` : ppStatus };
}

// Einzug bei PayPal abgelehnt oder gescheitert: endgueltig, es floss kein Geld
const abgelehnt = ppStatus => /^EINZUG_(DECLINED|FAILED)$/.test(ppStatus || '');

// ─── Rueckkehr des Gastes (POST /api/paypal-capture) ─────────────

// Liefert { status, json } fuer die Route.
async function rueckkehrVerarbeiten({ body, env, finden, client, speicher, melden = console }) {
  if (!paypalKonfiguration(env).zugang) {
    return { status: 503, json: { ok: false, message: 'PayPal ist derzeit nicht verfügbar.' } };
  }
  const id = body && (body.paypalOrderId || body.token);
  if (!istPaypalId(id)) return { status: 400, json: { ok: false, message: 'paypalOrderId fehlt' } };
  const order = await finden(id);
  if (!order) return { status: 404, json: { ok: false, message: 'Bestellung nicht gefunden' } };
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
    return { status: 200, json: { ok: true, orderNum: order.orderNum } };
  }
  // Abgelaufen oder storniert: nie mehr einziehen. War der Einzug gerade noch
  // durchgelaufen (Wettlauf mit dem Aufraeumen), bucht abgleichen ihn trotzdem ein.
  const r = await abgleichen({ order, client, speicher, einziehenErlaubt: order.status === 'awaiting_payment', melden });
  if (r.ergebnis === 'eingebucht' || r.ergebnis === 'schon') {
    return { status: 200, json: { ok: true, orderNum: order.orderNum } };
  }
  if (order.status !== 'awaiting_payment') {
    return { status: 200, json: { ok: false, abgelaufen: true, orderNum: order.orderNum,
      message: 'Diese PayPal-Zahlung ist abgelaufen, es wurde nichts abgebucht. Bitte bestelle erneut.' } };
  }
  if (r.ergebnis === 'offen' && abgelehnt(r.ppStatus)) {
    // Sofort abschliessen: Der Gast erfaehrt "nichts abgebucht" und bestellt vielleicht
    // neu - dann darf der Wachhund diese Bestellung nie mehr einziehen.
    await speicher.abschliessen(order);
    return { status: 200, json: { ok: false, abgelehnt: true, orderNum: order.orderNum,
      message: 'PayPal hat die Zahlung abgelehnt, es wurde nichts abgebucht. Bitte versuche es erneut oder wähle eine andere Zahlungsart.' } };
  }
  return { status: 200, json: { ok: false, orderNum: order.orderNum, message: 'Noch nicht bezahlt' } };
}

// ─── Webhook (POST /api/paypal-webhook) ──────────────────────────

// Ereignisse, die der Webhook abonnieren muss (erstelleWebhookVerwalter legt ihn damit
// an bzw. ergaenzt sie). Mehr braucht der Abgleich nicht.
const WEBHOOK_EREIGNISSE = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED'];
// Weitere, die nur einen Abgleich ausloesen, falls sie doch abonniert sind
const WEBHOOK_ABGLEICH = new Set([...WEBHOOK_EREIGNISSE, 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED']);

// PayPal-Bestellnummer aus dem Ereignis
function ppOrderIdAusEreignis(event) {
  const r = event && event.resource;
  if (!r) return null;
  if (String(event.event_type).startsWith('CHECKOUT.ORDER.')) return r.id;
  return r.supplementary_data && r.supplementary_data.related_ids ? r.supplementary_data.related_ids.order_id : null;
}

// Antworten (PayPal stellt bei allem ausser 2xx erneut zu, bis zu 3 Tage lang):
//  503 eigene Einrichtung fehlt / Pruefung bei PayPal gerade nicht moeglich -> erneut
//  500 eigener Fehler beim Verarbeiten (Datenbank, PayPal-Abfrage)           -> erneut
//  400 Signatur ungueltig oder Kopfzeilen fehlen (nicht von PayPal)
//  200 verarbeitet, oder fremdes/unbekanntes Ereignis bzw. unbekannte Bestellung
//      (eine Wiederholung aendert daran nichts)
// webhookId: die bekannte ID (verwalter.id()); fehlt das Argument, gilt PAYPAL_WEBHOOK_ID.
// beiSignaturFehler: wird gerufen (ohne zu warten), wenn PayPal die Signatur ablehnt oder
// die Pruefung scheitert - etwa weil es den Webhook nicht mehr gibt (verwalter.verdachtMelden).
async function webhookVerarbeiten({ env, webhookId, beiSignaturFehler = () => {}, headers = {}, event, client, finden, speicher, jetzt = new Date(), melden = console }) {
  const k = paypalKonfiguration(env);
  const whId = webhookId === undefined ? k.webhookVorgabe : webhookId;
  if (!k.zugang || !whId) {
    const fehlt = k.zugang ? ['kein Webhook bekannt'] : k.fehlend;
    melden.error('PayPal-Webhook: PayPal nicht vollstaendig eingerichtet (' + fehlt.join(', ') + ') - nichts eingebucht');
    return { status: 503, json: { message: 'PayPal nicht eingerichtet' } };
  }
  const verdacht = () => { try { beiSignaturFehler(); } catch { /* darf nie stoeren */ } };
  const kopf = n => (typeof headers[n] === 'string' ? headers[n] : '');
  const pflicht = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (pflicht.some(n => !kopf(n)) || !event || typeof event !== 'object' || Array.isArray(event)) {
    melden.warn('PayPal-Webhook: ohne Signatur-Kopfzeilen - abgewiesen');
    return { status: 400, json: { message: 'invalid signature' } };
  }
  let pruefung;
  try {
    pruefung = await client.signaturPruefen({
      auth_algo: kopf('paypal-auth-algo'), cert_url: kopf('paypal-cert-url'),
      transmission_id: kopf('paypal-transmission-id'), transmission_sig: kopf('paypal-transmission-sig'),
      transmission_time: kopf('paypal-transmission-time'),
      webhook_id: whId, webhook_event: event,
    });
  } catch (e) {
    melden.error('PayPal-Webhook: Signaturpruefung nicht moeglich:', e.message);
    verdacht();
    return { status: 503, json: { message: 'Signaturpruefung nicht moeglich' } };
  }
  if (!pruefung || pruefung.verification_status !== 'SUCCESS') {
    melden.warn('PayPal-Webhook: ungueltige Signatur - nichts eingebucht');
    verdacht();
    return { status: 400, json: { message: 'invalid signature' } };
  }

  if (!WEBHOOK_ABGLEICH.has(event.event_type)) return { status: 200, json: { received: true, ignoriert: true } };
  const id = ppOrderIdAusEreignis(event);
  if (!istPaypalId(id)) return { status: 200, json: { received: true, ignoriert: true } };
  try {
    const order = await finden(id);
    if (!order) return { status: 200, json: { received: true, ignoriert: true } };   // nicht aus diesem Laden
    const alterMs = jetzt - new Date(order.createdAt || jetzt);
    const r = await abgleichen({ order, client, speicher, melden,
      einziehenErlaubt: alterMs <= FRISTEN.einziehenHoechstensStunden * 3600 * 1000 });
    if (r.ergebnis === 'eingebucht') melden.log(`💳 Bezahlt (PayPal, Webhook): #${order.orderNum} → wartet auf Bestätigung`);
    return { status: 200, json: { received: true } };
  } catch (e) {
    melden.error('PayPal-Webhook Verarbeitung fehlgeschlagen:', e.message);
    return { status: 500, json: { message: 'Verarbeitung fehlgeschlagen' } };
  }
}

// ─── Webhook selbst sicherstellen ────────────────────────────────
//
// Statt PAYPAL_WEBHOOK_ID von Hand: Sobald Schluessel, PAYPAL_ENV=live und Anmeldung
// stehen, sorgt der Server dafuer, dass es in der PayPal-App des Ladens einen Webhook
// auf <API-Basis>/api/paypal-webhook mit WEBHOOK_EREIGNISSE gibt:
//  1. Die gemerkte ID (Datenbank ueber `ablage`, dazu im Prozess) gilt, solange Adresse
//     und App (Kennung aus der Client-ID) passen. Beim Start wird PayPal nicht gefragt.
//  2. Sonst Webhooks der App auflisten. Gibt es einen auf die Adresse, gilt er; fehlen
//     Ereignisse, werden sie ergaenzt (bestehende bleiben).
//  3. Sonst anlegen. Scheitert das (auch "schon vorhanden": ein zweiter Prozess war
//     schneller), wird erneut aufgelistet und ein vorhandener genommen. Nach dem Anlegen
//     wird noch einmal aufgelistet: Haben zwei Prozesse gleichzeitig angelegt, waehlen
//     beide denselben (kleinste ID), und der andere loescht seinen eigenen wieder.
//  4. Alle WEBHOOK_BESTAETIGEN_STUNDEN und nach einem Signaturfehler (hoechstens alle
//     WEBHOOK_VERDACHT_MINUTEN) wird nachgesehen, ob die gemerkte ID noch in der Liste
//     steht. Fehlt sie, wird neu sichergestellt.
// Misserfolg: wirft nie, PayPal bleibt aus (solange kein Webhook bekannt ist), klare
// Logzeile, naechster Versuch erst nach WEBHOOK_PAUSEN_MIN (1, 2, 5, 15, 30, dann 60 min).
// Ein Webhook auf eine Adresse ohne https oder auf localhost/IP wird nie angelegt.
// PAYPAL_WEBHOOK_ID (von Hand) hat Vorrang: dann fragt der Verwalter PayPal gar nicht.
//
// ablage: { lesen() -> {id,url,app,ereignisse}|null, schreiben(eintrag), loeschen() }

const WEBHOOK_PAUSEN_MIN = [1, 2, 5, 15, 30, 60];
const WEBHOOK_BESTAETIGEN_STUNDEN = 12;
const WEBHOOK_VERDACHT_MINUTEN = 10;
// Von Hand ausgeloest (Admin-Route ?erneut=1): hoechstens alle 30 Sekunden
const WEBHOOK_ERZWINGEN_ABSTAND_MS = 30 * 1000;

// Kennung der PayPal-App, ohne die Client-ID selbst zu speichern
const appKennung = clientId => crypto.createHash('sha256').update(String(clientId)).digest('hex').slice(0, 16);

const IP_ODER_LOKAL = h => h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')
  || !h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':');

// Webhook-Adresse aus der oeffentlichen API-Basis: { url } oder { fehler }.
// Nur https, Port 443, kein localhost, keine IP, keine Zugangsdaten/Query/Anker.
function webhookAdresse(apiBasis) {
  let u;
  try { u = new URL(String(apiBasis || '').trim()); }
  catch { return { fehler: `Oeffentliche API-Adresse "${String(apiBasis || '')}" ist keine gueltige Adresse` }; }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:') return { fehler: `Oeffentliche API-Adresse ${u.origin} ist nicht https - Webhook wird nicht angelegt` };
  if (IP_ODER_LOKAL(host)) return { fehler: `Oeffentliche API-Adresse ${u.origin} ist lokal oder eine IP - Webhook wird nicht angelegt` };
  if (u.port && u.port !== '443') return { fehler: `Oeffentliche API-Adresse ${u.origin}: PayPal stellt nur an Port 443 zu` };
  if (u.username || u.password || u.search || u.hash) return { fehler: 'Oeffentliche API-Adresse darf keine Zugangsdaten, ? oder # enthalten' };
  return { url: (u.origin + u.pathname).replace(/\/+$/, '') + WEBHOOK_PFAD };
}

function adresseNormal(url) {
  try { const u = new URL(String(url)); return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase(); }
  catch { return null; }
}
const gleicheAdresse = (a, b) => { const x = adresseNormal(a); return !!x && x === adresseNormal(b); };

const ereignisNamen = w => (w && Array.isArray(w.event_types) ? w.event_types : [])
  .map(e => e && e.name).filter(n => typeof n === 'string');
function fehlendeEreignisse(w) {
  const namen = ereignisNamen(w);
  return namen.includes('*') ? [] : WEBHOOK_EREIGNISSE.filter(n => !namen.includes(n));
}

// Der Webhook der App auf diese Adresse: bevorzugt die bekannte ID, sonst einer mit
// allen Ereignissen, bei Gleichstand die kleinste ID (zwei Prozesse waehlen gleich).
function webhookWaehlen(liste, url, bevorzugt) {
  const k = (liste || []).filter(w => w && istPaypalId(w.id) && gleicheAdresse(w.url, url));
  if (!k.length) return null;
  const b = bevorzugt && k.find(w => w.id === bevorzugt);
  if (b) return b;
  return k.slice().sort((x, y) => (fehlendeEreignisse(x).length - fehlendeEreignisse(y).length)
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
}

function webhookFehlerText(e) {
  if (e && (e.status === 401 || e.paypalName === 'invalid_client')) {
    return 'Anmeldung bei PayPal scheitert (Client-ID oder Secret falsch, oder keine Live-App)';
  }
  if (e && e.status === 403) {
    return 'PayPal verweigert dieser App die Webhook-Verwaltung (403). Ausweg: Webhook in der PayPal-App von Hand anlegen und PAYPAL_WEBHOOK_ID setzen';
  }
  if (e && e.paypalName === 'WEBHOOK_NUMBER_LIMIT_EXCEEDED') {
    return 'Die PayPal-App hat schon die Hoechstzahl an Webhooks (10). Einen alten in der PayPal-App loeschen';
  }
  return (e && e.message) || String(e);
}

const QUELLE_TEXT = { gemerkt: 'gemerkt (Datenbank)', gefunden: 'in der PayPal-App gefunden',
  ergaenzt: 'in der PayPal-App gefunden, Ereignisse ergaenzt', angelegt: 'vom Server angelegt' };

function erstelleWebhookVerwalter({ env, client, ablage = null, apiBasis, uhr = () => Date.now(), melden = console,
                                    pausenMin = WEBHOOK_PAUSEN_MIN,
                                    bestaetigenMs = WEBHOOK_BESTAETIGEN_STUNDEN * 3600 * 1000,
                                    verdachtAbstandMs = WEBHOOK_VERDACHT_MINUTEN * 60 * 1000 }) {
  let bekannt = null;    // { id, url, app, ereignisse, quelle, bestaetigtAm }
  let fehler  = null;    // { grund, am, versuche, naechsterVersuch }
  let geladen = false;   // gemerkte ID aus der Datenbank gelesen
  let verdacht = false, letzterVerdacht = -Infinity, letzteVorgabeWarnung = -Infinity, letztesErzwingen = -Infinity;
  let laufend = null;
  const log = (art, text) => { try { melden[art](text); } catch { /* Melden darf nie stoeren */ } };

  function lage() {
    const k = paypalKonfiguration(env);
    return { k, adr: webhookAdresse(apiBasis), app: k.clientId ? appKennung(k.clientId) : null };
  }
  const passt = (w, l) => !!w && !!l.adr.url && !!l.app && w.app === l.app
    && gleicheAdresse(w.url, l.adr.url) && istPaypalId(w.id);
  const frisch = (l, jetzt) => passt(bekannt, l) && !verdacht && jetzt - bekannt.bestaetigtAm < bestaetigenMs;

  // Die Webhook-ID, die jetzt gilt, oder null. Synchron, fragt niemanden.
  function id() {
    const l = lage();
    if (!l.k.zugang) return null;
    if (l.k.webhookVorgabe) return l.k.webhookVorgabe;
    return passt(bekannt, l) ? bekannt.id : null;
  }

  function scheitern(grund) {
    const versuche = (fehler ? fehler.versuche : 0) + 1;
    const pause = pausenMin[Math.min(versuche - 1, pausenMin.length - 1)];
    fehler = { grund, am: uhr(), versuche, naechsterVersuch: uhr() + pause * 60 * 1000 };
    const folge = passt(bekannt, lage())
      ? `Der bekannte Webhook ${bekannt.id} bleibt in Gebrauch.`
      : 'PayPal bleibt aus (/api/config meldet paypal:false).';
    log('error', `⚠️  PayPal-Webhook nicht sichergestellt: ${grund}. ${folge} Naechster Versuch in ${pause} Min.`);
  }

  async function merken(eintrag) {
    if (!ablage) return;
    try { await ablage.schreiben(eintrag); }
    catch (e) { log('warn', `PayPal-Webhook ${eintrag.id}: nicht in der Datenbank gemerkt (${e.message}). Beim naechsten Start wird PayPal erneut gefragt.`); }
  }

  async function lauf(erzwingen) {
    const l = lage();
    if (!l.k.zugang) return null;                          // Schalter aus: kein Aufruf bei PayPal
    if (l.k.webhookVorgabe) return l.k.webhookVorgabe;     // von Hand: nichts verwalten
    if (l.adr.fehler) {                                    // nie einen unsicheren Webhook anlegen
      if (!fehler || fehler.grund !== l.adr.fehler || uhr() >= fehler.naechsterVersuch) scheitern(l.adr.fehler);
      return null;
    }

    if (!geladen && ablage) {
      try {
        const w = await ablage.lesen();
        geladen = true;
        if (!bekannt && passt(w, l)) {
          bekannt = { id: w.id, url: l.adr.url, app: l.app, ereignisse: Array.isArray(w.ereignisse) ? w.ereignisse : [],
                      quelle: 'gemerkt', bestaetigtAm: uhr() };
          fehler = null;
          log('log', `💙 PayPal-Webhook ${w.id} (gemerkt): ${l.adr.url}`);
        }
      } catch (e) {
        log('warn', `PayPal-Webhook: gemerkte ID nicht lesbar (${e.message}) - PayPal wird gefragt`);
      }
    }
    const jetzt = uhr();
    if (frisch(l, jetzt)) return bekannt.id;
    if (fehler && jetzt < fehler.naechsterVersuch && !erzwingen) return id();

    try {
      const t = await client.token();
      let liste = await client.webhooksAuflisten(t);
      const vorher = passt(bekannt, l) ? bekannt : null;
      if (vorher && !liste.some(w => w && w.id === vorher.id)) {
        log('error', `🚨 PayPal-Webhook ${vorher.id} gibt es in der PayPal-App nicht mehr - wird neu sichergestellt`);
        bekannt = null;
        if (ablage && ablage.loeschen) { try { await ablage.loeschen(); } catch { /* wird gleich ueberschrieben */ } }
      }

      let wahl = webhookWaehlen(liste, l.adr.url, vorher && vorher.id);
      let quelle = vorher && wahl && wahl.id === vorher.id ? vorher.quelle : 'gefunden';
      if (!wahl) {
        let neu = null;
        try {
          neu = await client.webhookAnlegen(l.adr.url, WEBHOOK_EREIGNISSE, t);
        } catch (e) {
          // "Schon vorhanden" (ein anderer Prozess war schneller) oder Ausgang unklar:
          // erneut auflisten und einen vorhandenen nehmen, nie blind ein zweites Mal anlegen.
          liste = await client.webhooksAuflisten(t);
          wahl = webhookWaehlen(liste, l.adr.url);
          if (!wahl) throw e;
        }
        if (neu) {
          if (!istPaypalId(neu && neu.id)) throw new Error('PayPal hat beim Anlegen keine Webhook-ID geliefert');
          wahl = neu; quelle = 'angelegt';
          // Zwei Prozesse koennen gleichzeitig angelegt haben: alle waehlen denselben,
          // ein ueberzaehliger eigener wird wieder geloescht.
          try {
            liste = await client.webhooksAuflisten(t);
            const gemeinsam = webhookWaehlen(liste, l.adr.url);
            if (gemeinsam && gemeinsam.id !== neu.id && liste.some(w => w && w.id === neu.id)) {
              try {
                await client.webhookLoeschen(neu.id, t);
                liste = liste.filter(w => w && w.id !== neu.id);
                log('warn', `PayPal-Webhook: gleichzeitig doppelt angelegt, eigener ${neu.id} wieder geloescht, es gilt ${gemeinsam.id}`);
              } catch (e2) {
                log('warn', `PayPal-Webhook: doppelt angelegt, ${neu.id} liess sich nicht loeschen (${e2.message}) - bitte in der PayPal-App loeschen`);
              }
              wahl = gemeinsam; quelle = 'gefunden';
            }
          } catch { liste = [neu]; /* Kontrolle ist Zugabe; der neue gilt */ }
        }
      }

      if (fehlendeEreignisse(wahl).length) {
        const alle = [...new Set([...ereignisNamen(wahl), ...WEBHOOK_EREIGNISSE])];
        const antwort = await client.webhookEreignisseSetzen(wahl.id, alle, t);
        const nachher = antwort && Array.isArray(antwort.event_types) ? antwort : { ...wahl, event_types: alle.map(name => ({ name })) };
        if (fehlendeEreignisse(nachher).length) throw new Error('PayPal hat die fehlenden Ereignisse nicht uebernommen');
        wahl = { ...wahl, event_types: nachher.event_types };
        if (quelle !== 'angelegt') quelle = 'ergaenzt';
      }

      const neuGewaehlt = !vorher || vorher.id !== wahl.id || quelle === 'ergaenzt';
      bekannt = { id: wahl.id, url: l.adr.url, app: l.app, ereignisse: ereignisNamen(wahl), quelle, bestaetigtAm: uhr() };
      verdacht = false;
      fehler = null;
      if (neuGewaehlt) {
        await merken({ id: bekannt.id, url: bekannt.url, app: bekannt.app, ereignisse: bekannt.ereignisse, am: new Date(uhr()) });
        log('log', `💙 PayPal-Webhook ${bekannt.id} bereit (${QUELLE_TEXT[quelle]}): ${l.adr.url}`);
      }
      // Gerade selbst angelegt: einen gleichzeitig angelegten zweiten loescht dessen Prozess
      // selbst (und meldet, falls das scheitert); Reste meldet die naechste Bestaetigung.
      const gleiche = liste.filter(w => w && gleicheAdresse(w.url, l.adr.url)).length;
      if (gleiche > 1 && quelle !== 'angelegt') log('warn', `PayPal-Webhook: ${gleiche} Webhooks auf ${l.adr.url} in der PayPal-App, es gilt ${bekannt.id} - die uebrigen bitte dort loeschen`);
      return bekannt.id;
    } catch (e) {
      scheitern(webhookFehlerText(e));
      return id();   // ein bekannter Webhook bleibt bei einem voruebergehenden Fehler in Gebrauch
    }
  }

  // Stellt den Webhook sicher (oder bestaetigt ihn). Einer zur Zeit, wirft nie, liefert id().
  // erzwingen: Pause und Bestaetigungsfrist uebergehen (hoechstens alle 30 s).
  function sicherstellen({ erzwingen = false } = {}) {
    if (laufend) return laufend;
    if (erzwingen) {
      if (uhr() - letztesErzwingen < WEBHOOK_ERZWINGEN_ABSTAND_MS) erzwingen = false;
      else { letztesErzwingen = uhr(); verdacht = true; }
    }
    laufend = (async () => {
      try { return await lauf(erzwingen); }
      catch (e) { log('error', `PayPal-Webhook: unerwarteter Fehler ${e && e.message}`); return id(); }
      finally { laufend = null; }
    })();
    return laufend;
  }

  // Fuer Gastanfragen und den 5-Minuten-Takt: startet sicherstellen() nur, wenn es faellig
  // ist (unbekannt nach Ablauf der Pause, Bestaetigung faellig, Verdacht). Wartet nie.
  function anstossen() {
    if (laufend) return laufend;
    const l = lage(), jetzt = uhr();
    if (!l.k.zugang || l.k.webhookVorgabe) return Promise.resolve(id());
    if (frisch(l, jetzt) || (fehler && jetzt < fehler.naechsterVersuch)) return Promise.resolve(id());
    return sicherstellen();
  }

  // Signaturpruefung abgelehnt oder gescheitert: vielleicht gibt es den Webhook nicht mehr.
  // Hoechstens alle verdachtAbstandMs einmal bei PayPal nachsehen.
  function verdachtMelden() {
    const l = lage(), jetzt = uhr();
    if (!l.k.zugang) return;
    if (l.k.webhookVorgabe) {
      if (jetzt - letzteVorgabeWarnung >= verdachtAbstandMs) {
        letzteVorgabeWarnung = jetzt;
        log('warn', 'PayPal-Webhook: Signaturpruefung scheitert - PAYPAL_WEBHOOK_ID (von Hand) pruefen oder entfernen, dann stellt der Server den Webhook selbst sicher');
      }
      return;
    }
    if (jetzt - letzterVerdacht < verdachtAbstandMs) return;
    letzterVerdacht = jetzt;
    verdacht = true;
    anstossen();
  }

  // Fuer die Statusauskunft: nur Klartext, keine Geheimwerte
  function zustand() {
    const l = lage();
    const b = passt(bekannt, l) ? bekannt : null;
    const vorgabe = l.k.zugang ? l.k.webhookVorgabe : null;
    const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    return {
      vorhanden:    !!(l.k.zugang && (vorgabe || b)),
      quelle:       vorgabe ? 'von Hand (PAYPAL_WEBHOOK_ID, nicht geprueft)' : b ? QUELLE_TEXT[b.quelle] : null,
      adresse:      l.adr.url || null,
      id:           vorgabe || (b && b.id) || null,
      ereignisse:   vorgabe ? null : b ? b.ereignisse : null,
      zuletztBestaetigt: !vorgabe && b ? iso(b.bestaetigtAm) : null,
      fehler:       l.adr.fehler || (fehler ? fehler.grund : null),
      naechsterVersuch: fehler && !vorgabe ? iso(fehler.naechsterVersuch) : null,
      laeuft:       !!laufend,
    };
  }

  return { id, sicherstellen, anstossen, verdachtMelden, zustand };
}

// ─── Statusauskunft fuer den Betreiber (GET /api/admin/paypal) ───

// Ersetzt Client-ID und Secret in allen Texten - falls je ein Fehlertext sie enthielte.
function ohneGeheimnisse(wert, geheim) {
  const liste = geheim.filter(g => typeof g === 'string' && g.trim().length >= 4).map(g => g.trim());
  return JSON.parse(JSON.stringify(wert), (_k, v) =>
    typeof v === 'string' ? liste.reduce((s, g) => s.split(g).join('***'), v) : v);
}

// probe: { ok, grund } der letzten Probe-Anmeldung oder null; webhook: verwalter.zustand();
// sichtbar: Ergebnis von paypalBereit (das, was /api/config meldet).
function paypalStatus({ env = {}, probe = null, webhook = {}, sichtbar = false }) {
  const k = paypalKonfiguration(env);
  const gesetzt = n => typeof env[n] === 'string' && env[n].trim() !== '';
  const w = webhook || {};
  const probeText = !k.zugang ? 'nicht versucht (Schluessel fehlen oder PAYPAL_ENV ist nicht live)'
    : !probe ? 'noch nicht versucht'
    : probe.ok ? 'ok' : `fehlgeschlagen: ${probe.grund || 'unbekannt'}`;
  let naechsterSchritt;
  if (!k.schluessel) naechsterSchritt = 'PAYPAL_CLIENT_ID und PAYPAL_CLIENT_SECRET der Live-REST-App des Ladens eintragen.';
  else if (!k.live) naechsterSchritt = 'Schluessel stehen. Zum Scharfschalten PAYPAL_ENV=live setzen und den Dienst neu starten.';
  else if (probe && !probe.ok) naechsterSchritt = 'Anmeldung bei PayPal scheitert: Client-ID und Secret der LIVE-App pruefen (keine Sandbox-Daten).';
  else if (!w.vorhanden) naechsterSchritt = `Webhook noch nicht bereit${w.fehler ? ': ' + w.fehler : ''}. Der Server versucht es selbst erneut`
    + `${w.naechsterVersuch ? ' (naechster Versuch ' + w.naechsterVersuch + ')' : ''}; sofort: diese Adresse mit ?erneut=1 aufrufen.`;
  else if (sichtbar !== true) naechsterSchritt = 'Alles eingetragen, aber PayPal wird gerade nicht angeboten - Probe-Anmeldung pruefen.';
  else naechsterSchritt = 'PayPal ist eingeschaltet und wird Gaesten angeboten.';
  return ohneGeheimnisse({
    schluesselGesetzt: { PAYPAL_CLIENT_ID: gesetzt('PAYPAL_CLIENT_ID'), PAYPAL_CLIENT_SECRET: gesetzt('PAYPAL_CLIENT_SECRET') },
    modus: k.live ? 'live' : 'aus',
    ...(k.live ? {} : { modusHinweis: gesetzt('PAYPAL_ENV')
      ? 'PAYPAL_ENV ist gesetzt, aber nicht genau "live" - die Sandbox wird nie genutzt'
      : 'PAYPAL_ENV fehlt - PayPal ist bewusst aus' }),
    probeAnmeldung: probeText,
    webhook: {
      vorhanden: w.vorhanden === true, adresse: w.adresse || null, quelle: w.quelle || null, id: w.id || null,
      ereignisse: w.ereignisse || null, zuletztBestaetigt: w.zuletztBestaetigt || null,
      fehler: w.fehler || null, naechsterVersuch: w.naechsterVersuch || null,
    },
    fuerGaesteSichtbar: sichtbar === true,
    naechsterSchritt,
  }, [env.PAYPAL_CLIENT_SECRET, env.PAYPAL_CLIENT_ID]);
}

// ─── Wachhund und Aufraeumen (alle 5 Minuten) ────────────────────

// Fuer jede PayPal-Bestellung auf `awaiting_payment`, die aelter als
// FRISTEN.wachhundMinuten ist:
//  - bei PayPal bezahlt -> einbuchen (nachgeholt, Alarm wie bei Stripe)
//  - bei PayPal freigegeben (APPROVED), juenger als 2 h -> einziehen und einbuchen
//  - nie bezahlt und aelter als FRISTEN.abbruchMinuten -> abschliessen wie eine
//    abgelaufene Stripe-Zahlung (cancelled, kein Storno, keine Mail)
//  - ohne PayPal-Zugang erst nach FRISTEN.ohneZugangStunden abschliessen
// speicher.abschliessen(order) muss atomar und nur aus `awaiting_payment` heraus setzen.
// Liefert { nachgeholt: [orders], abgeschlossen: [orderNums] }. Wirft nie.
async function wachhundLauf({ orders, client, speicher, jetzt = new Date(), fristen = FRISTEN, melden = console }) {
  const nachgeholt = [], abgeschlossen = [];
  for (const order of orders || []) {
    try {
      const alterMin = (jetzt - new Date(order.createdAt)) / 60000;
      if (alterMin < fristen.wachhundMinuten) continue;
      if (!client) {
        if (alterMin >= fristen.ohneZugangStunden * 60 && await speicher.abschliessen(order)) {
          abgeschlossen.push(order.orderNum);
          melden.warn(`PayPal nicht eingerichtet: #${order.orderNum} nie bezahlt, abgeschlossen`);
        }
        continue;
      }
      const einziehenErlaubt = alterMin <= fristen.einziehenHoechstensStunden * 60;
      const r = await abgleichen({ order, client, speicher, einziehenErlaubt, melden });
      if (r.ergebnis === 'eingebucht') {
        nachgeholt.push(r.order);
        melden.error(`🚨 PayPal-Wachhund: #${order.orderNum} war bezahlt und unsichtbar - jetzt auf pending`);
        continue;
      }
      if (r.ergebnis !== 'offen') {
        if (r.ergebnis === 'wartet') melden.warn(`PayPal: #${order.orderNum} Einzug wartet bei PayPal (PENDING)`);
        continue;   // schon, wartet, betrag, fremd: nicht abschliessen
      }
      // Nie bezahlt. APPROVED bleibt offen, solange noch eingezogen werden darf;
      // ein abgelehnter Einzug ist endgueltig und wird sofort abgeschlossen.
      const darfAbschliessen = abgelehnt(r.ppStatus)
        || (alterMin >= fristen.abbruchMinuten && !(r.ppStatus === 'APPROVED' && einziehenErlaubt));
      if (darfAbschliessen && await speicher.abschliessen(order)) {
        abgeschlossen.push(order.orderNum);
        melden.log(`PayPal: #${order.orderNum} nie bezahlt (${r.ppStatus}), abgeschlossen`);
      }
    } catch (e) {
      melden.warn(`PayPal-Wachhund uebersprungen #${order && order.orderNum}: ${e.message}`);
    }
  }
  return { nachgeholt, abgeschlossen };
}

module.exports = {
  LIVE_BASIS, PAYPAL_VARIABLEN, FRISTEN, WEBHOOK_EREIGNISSE, WEBHOOK_PFAD, WEBHOOK_PAUSEN_MIN, PaypalFehler,
  paypalKonfiguration, paypalBereit, erstelleProbe, erstelleClient,
  webhookAdresse, webhookWaehlen, fehlendeEreignisse, erstelleWebhookVerwalter, paypalStatus,
  istPaypalId, betragPruefen, bestellungFuerPaypal, freigabeLink,
  einzugAus, gehoertZu, betragPasst, abgleichen,
  rueckkehrVerarbeiten, webhookVerarbeiten, ppOrderIdAusEreignis, wachhundLauf,
};
