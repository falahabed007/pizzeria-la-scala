// ═══════════════════════════════════════════════════════════════
// Zentrale Konfiguration – FlueVate-Bestellsystem
// ═══════════════════════════════════════════════════════════════
//
// EINZIGE Stelle, an der die Backend-Adresse steht. Sie wird von
// index.html (Bestellung), account.html (Kundenkonto) und
// dashboard.html (Admin) gemeinsam benutzt.
//
// Zieht das Backend um, ist hier eine Zeile zu ändern – vorher stand
// die Adresse dreimal im Code, und beim Umzug wurde nur index.html
// angepasst. Kundenkonto und Dashboard zeigten dadurch monatelang auf
// einen Host, den es nicht gibt.
//
// Diese Datei muss in <head> vor allen anderen Skripten geladen werden.

window.FLUEVATE_BACKEND = 'https://api.pizzerialascala.de';
