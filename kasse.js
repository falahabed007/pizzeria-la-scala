// Antworten an die Sunmi-Kasse (GET /api/admin/orders und /pending).
//
// Die Kassen-App druckt je Artikel entweder die Extras (extraDetails) oder die
// Anmerkung (note). Hat ein Artikel Extras -- jede Pizza hat die Größe --, fiel
// "ohne Zwiebeln" auf dem Bon weg. Darum hängt die Anmerkung hier als Extra
// mit 0 € an. Nur die Antwort ändert sich, gespeichert wird nichts anders.
'use strict';

const VORSATZ = 'ANMERKUNG: ';

// Neues Array; die übergebenen Artikel bleiben unverändert.
// noteBehalten: die Anmerkung bleibt zusätzlich in `note` stehen (für
// Dashboards, die sie von dort lesen).
function artikelFuerKasse(items, { noteBehalten = false } = {}) {
  if (!Array.isArray(items)) return items;
  return items.map(i => {
    const note = i && typeof i.note === 'string' ? i.note.trim() : '';
    const extras = i && Array.isArray(i.extraDetails) ? i.extraDetails : [];
    if (!note || extras.length === 0) return i;
    if (extras.some(e => e && e.name === VORSATZ + note)) return i;
    return {
      ...i,
      extraDetails: [...extras, { name: VORSATZ + note, price: 0 }],
      note: noteBehalten ? i.note : '',
    };
  });
}

function bestellungFuerKasse(o, optionen) {
  const x = o && typeof o.toJSON === 'function' ? o.toJSON() : o;
  if (!x || !Array.isArray(x.items)) return x;
  return { ...x, items: artikelFuerKasse(x.items, optionen) };
}

// Express-Middleware: setzt die Anmerkungen in `orders` und `pending` um,
// egal welche Route die Antwort baut. Geht dabei etwas schief, geht die
// Antwort unverändert raus -- die Kasse darf nie ohne Bestellungen dastehen.
function kasseAnmerkung(optionen) {
  return function (req, res, next) {
    if (req.method !== 'GET') return next();
    const senden = res.json.bind(res);
    res.json = body => {
      let antwort = body;
      try {
        if (body && Object.getPrototypeOf(body) === Object.prototype) {
          for (const feld of ['orders', 'pending']) {
            if (Array.isArray(body[feld])) {
              if (antwort === body) antwort = { ...body };
              antwort[feld] = body[feld].map(o => bestellungFuerKasse(o, optionen));
            }
          }
        }
      } catch (e) {
        console.error('Kasse: Anmerkung nicht umgesetzt, Antwort geht unverändert raus:', e.message);
        antwort = body;
      }
      return senden(antwort);
    };
    next();
  };
}

module.exports = { artikelFuerKasse, bestellungFuerKasse, kasseAnmerkung };
