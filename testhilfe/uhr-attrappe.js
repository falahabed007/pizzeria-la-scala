// Vorgeladen in einen Kindprozess (NODE_OPTIONS=--require .../uhr-attrappe.js): verschiebt die
// deutsche Uhrzeit, die server.js fuer Oeffnungs- und Lieferzeit liest (calcAutoMode,
// lieferungMoeglich: new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })), auf
// UHR_ATTRAPPE (ISO-Zeitpunkt). Date selbst bleibt unangetastet (mongoose prueft den Typ Date).
// Nur fuer test/paypal-routen.test.js.
'use strict';
if (process.env.UHR_ATTRAPPE) {
  const versatz = new Date(process.env.UHR_ATTRAPPE).getTime() - Date.now();
  if (Number.isNaN(versatz)) throw new Error('UHR_ATTRAPPE ist kein Zeitpunkt');
  const echt = Date.prototype.toLocaleString;
  Date.prototype.toLocaleString = function (sprache, optionen) {
    // Nur "jetzt" (gerade erzeugt) verschieben, gespeicherte Zeitpunkte bleiben, wie sie sind
    const jetzt = Math.abs(this.getTime() - Date.now()) < 2000;
    return echt.call(jetzt ? new Date(this.getTime() + versatz) : this, sprache, optionen);
  };
}
