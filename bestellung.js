// ─── Feldauswahl für POST /api/orders ────────────────────────────
// Die Route ist öffentlich (ohne Anmeldung). Über sie schickt die Bestellseite
// (index.html) nur Bar-Bestellungen; Stripe läuft über
// /api/create-stripe-checkout, PayPal über /api/create-paypal-order.
//
// Früher hing hier auch die "Manuelle Bestellung (POS)" des Web-Dashboards
// dran: source 'pos' machte die Bestellung sofort 'confirmed', übernahm den
// Betrag ungeprüft, verschickte Mails und druckte den Bon. Weil die Route
// offen ist, konnte das jeder im Internet auslösen. Das Dashboard gibt es
// nicht mehr; die Läden arbeiten mit der App über /api/admin/... .
//
// Bewusst als reine Funktion in eigener Datei: server.js verbindet sich beim
// Laden mit der Datenbank, diese Datei lässt sich ohne alles testen
// (test/bestellung.test.js).

// Zahlarten, die die Bestellseite über diese Route wirklich schickt.
// Das Schema kennt mehr (z. B. 'karte' für alte POS-Bestellungen) – die
// bleiben lesbar, werden hier aber nicht mehr angenommen.
const WEB_ZAHLARTEN = ['bar'];

// Felder, die nur der Server selbst oder die Admin-Schnittstellen setzen.
// Die Bestellseite schickt keines davon. Alles andere läuft wie bisher durch
// (unbekannte Felder verwirft Mongoose ohnehin).
const GESPERRTE_FELDER = [
  '_id', '__v', 'id', 'createdAt', 'updatedAt',
  'orderNum', 'status', 'paymentStatus', 'source', 'statusToken', 'userId',
  'prepTime', 'cancelReason', 'nachgeholt',
  'stripeSessionId', 'stripePaymentIntentId', 'paypalOrderId', 'paypalCaptureId',
  // Betrag rechnet die Route selbst; Rabatt und Gutschein gibt es bei
  // La Scala nicht, die Bestellseite schickt sie auch nicht.
  'total', 'discount', 'coupon',
];

/**
 * Baut aus dem Request-Body die Felder einer Web-Bestellung.
 * @returns {{ felder: object } | { fehler: string }}
 */
function webBestellungAusRequest(body) {
  const roh = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!WEB_ZAHLARTEN.includes(roh.payment)) {
    return { fehler: 'Diese Zahlart ist hier nicht möglich.' };
  }
  const felder = { ...roh };
  for (const f of GESPERRTE_FELDER) delete felder[f];
  felder.source        = 'web';
  felder.status        = 'pending';
  felder.paymentStatus = 'unpaid';   // wie der Schema-Standard: Bar zahlt bei Übergabe
  return { felder };
}

module.exports = { webBestellungAusRequest, WEB_ZAHLARTEN, GESPERRTE_FELDER };
