const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const Stripe     = require('stripe');
const { Resend } = require('resend'); // v2.0.1
const cron       = require('node-cron');
const PDFDocument = require('pdfkit');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const fs         = require('fs');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// Stripe lazy – liest Key bei jedem Aufruf
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY nicht gesetzt');
  return Stripe(key);
}

// ─── PayPal (REST v2, lazy) ──────────────────────────────────────
// Unabhängig von Stripe: eigene ENV-Keys, eigene Endpunkte.
// PAYPAL_ENV=live → Produktion, sonst Sandbox.
function paypalBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}
async function getPaypalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET nicht gesetzt');
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  if (!r.ok) throw new Error('PayPal Auth: ' + (data.error_description || r.status));
  return data.access_token;
}
async function paypalApi(path, method, token, body) {
  const r = await fetch(`${paypalBase()}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`PayPal API ${path}: ` + (data.message || data.error_description || r.status));
  return data;
}

// Resend lazy – kein Crash beim Start wenn Key fehlt
function getResend() {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('⚠️  RESEND_API_KEY fehlt – E-Mails werden nicht gesendet'); return null; }
  return new Resend(key);
}

// ─── Eigene Adresse ──────────────────────────────────────────────
// Die einzige Stelle, an der die Domain steht. Sie wurde vorher sechsmal
// getippt, waehrend FRONTEND_URL zwar in .env und render.yaml stand, aber
// nie gelesen wurde - ein Umzug haette funf Stellen stumm veralten lassen.
const FRONTEND = process.env.FRONTEND_URL || 'https://pizzerialascala.de';

// ─── CORS ────────────────────────────────────────────────────────
const allowedOrigins = [
  FRONTEND,
  FRONTEND.replace('https://', 'https://www.'),
  // Rückfallweg, falls GitHub Pages einmal ohne die eigene Domain ausliefert
  'https://falahabed007.github.io',
];
// Lokale Entwicklung: localhost/127.0.0.1 auf beliebigem Port
const localOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const corsOptions = {
  origin: function(origin, callback) {
    // Kein Origin = Postman / server-to-server / lokale Datei → erlauben
    if (!origin || origin === 'null') return callback(null, true);
    if (allowedOrigins.includes(origin) || localOrigin.test(origin)) {
      return callback(null, origin);
    }
    // Bewusst kein Error: den würde Express zu einem 500 ohne CORS-Header
    // machen, und im Browser käme nur das nichtssagende "Load failed" an.
    // callback(null, false) lässt die Antwort sauber ohne Allow-Origin durch.
    console.warn('CORS blockiert:', origin);
    return callback(null, false);
  },
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
};
// Render terminiert TLS vor der App; ohne das ist req.ip immer die Proxy-IP.
app.set('trust proxy', 1);

app.use(cors(corsOptions));
// Preflight für alle Routen – mit denselben Optionen. Ein blankes cors()
// würde hier jeder Herkunft "Allow-Origin: *" geben und die Prüfung oben
// aushebeln.
app.options('*', cors(corsOptions));

// ─── Webhooks brauchen raw body (vor express.json) ───────────────
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── Statische HTML-Dateien (kein Cache) ─────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// ─── MongoDB ─────────────────────────────────────────────────────
if (!process.env.MONGODB_URI) {
  console.error('❌ MONGODB_URI nicht gesetzt – Datenbankfunktionen sind deaktiviert.');
}
// try/catch um den Aufruf, nicht nur .catch() dahinter: Bei einer fehlerhaften
// Zeichenkette wirft mongoose.connect SYNCHRON, und dann greift das .catch()
// daneben nicht - der Prozess stirbt beim Start und der Hoster meldet nur 502,
// ohne dass irgendwo steht, woran es lag. Haeufigste Ursache ist ein Passwort
// mit @ oder / darin, das nicht URL-kodiert wurde.
try {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB verbunden'))
    .catch(err => console.error('❌ MongoDB Erstverbindung fehlgeschlagen:', err.message));
} catch (err) {
  console.error('❌ MONGODB_URI ist unbrauchbar:', err.message);
  console.error('   Sonderzeichen im Passwort URL-kodieren: @ wird %40, / wird %2F, : wird %3A.');
}
// Dauerhafte Zustandswechsel sichtbar loggen (kein stiller Ausfall)
mongoose.connection.on('disconnected', () => console.error('❌ MongoDB getrennt – Reconnect läuft …'));
mongoose.connection.on('reconnected',  () => console.log('✅ MongoDB wieder verbunden'));
mongoose.connection.on('error',        err => console.error('❌ MongoDB Fehler:', err.message));

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════

const orderSchema = new mongoose.Schema({
  orderNum:             { type: Number, unique: true },
  mode:                 { type: String, enum: ['lieferung','abholung'], required: true },
  status:               { type: String, default: 'pending',
                          enum: ['awaiting_payment','pending','confirmed','preparing','ready','delivered','cancelled'] },
  payment:              { type: String, enum: ['bar','stripe','karte','paypal'], required: true }, // paypal: Altbestellungen
  paymentStatus:        { type: String, default: 'unpaid', enum: ['unpaid','paid','pending','refunded'] },
  source:               { type: String, default: 'web', enum: ['web','pos'] },
  stripeSessionId:      String,
  // Vom Wachhund nachgeholt, statt vom Webhook. Verhindert doppelten Alarm
  // und macht im Nachhinein sichtbar, dass die Zahlkette geklemmt hat.
  nachgeholt:          { type: Boolean, default: false },
  stripePaymentIntentId:String,
  paypalOrderId:        String,
  paypalCaptureId:      String,
  prepTime:             Number,
  cancelReason:         { type: String, default: '' },
  customer: {
    first: String, last: String, email: String,
    phone: String, city: String, street: String, house: String
  },
  items:       [{ name: String, price: Number, qty: Number, note: String, extraDetails: [{ name: String, price: Number }] }],
  subtotal:    Number,
  deliveryFee: { type: Number, default: 0 },
  serviceFee:  { type: Number, default: 0 },
  discount:    { type: Number, default: 0 },
  total:       Number,
  note:        String,
  coupon:      String,
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Zugriffsschluessel fuer die Statusabfrage des Kunden. Bewusst nicht die _id:
  // deren Zufallsteil ist pro Serverprozess konstant und damit ratbar.
  statusToken: { type: String, index: true,
                 default: () => crypto.randomBytes(9).toString('base64url') },
}, { timestamps: true });

const Order = mongoose.model('Order', orderSchema);

const counterSchema = new mongoose.Schema({ _id: String, seq: Number });
const Counter = mongoose.model('Counter', counterSchema);

const availabilitySchema = new mongoose.Schema({
  itemName:  { type: String, required: true, unique: true },
  available: { type: Boolean, default: false }
}, { timestamps: true });
const Availability = mongoose.model('Availability', availabilitySchema);

const settingsSchema = new mongoose.Schema({
  _id:            String,
  mode:           { type: String, default: 'online', enum: ['online','geschlossen','neutral'] },
  manualOverride: { type: Boolean, default: false },
  // Rückwärtskompatibilität
  isOpen:         { type: Boolean, default: true }
});
const Settings = mongoose.model('Settings', settingsSchema);

const userSchema = new mongoose.Schema({
  email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  first:    { type: String, required: true, trim: true },
  last:     { type: String, required: true, trim: true },
  phone:    { type: String, default: '' },
  addresses: [{
    label:  { type: String, default: 'Zuhause' },
    street: String,
    house:  String,
    city:   String,
    zip:    String,
  }],
  defaultAddress:  { type: Number, default: 0 },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

// ─── Counter ─────────────────────────────────────────────────────
async function getNextOrderNum() {
  const r = await Counter.findByIdAndUpdate('orderNum',
    { $inc: { seq: 1 } }, { new: true, upsert: true });
  return r.seq + 1000;
}

// ─── Admin Auth ───────────────────────────────────────────────────
// Zeitkonstanter Vergleich: ein normales === verraet ueber die Laufzeit,
// wie viele Zeichen am Anfang schon stimmen.
function gleichSicher(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ message: 'Nicht autorisiert' });
  const token = h.slice(7);

  // Regulaerer Weg: befristetes Admin-JWT aus /api/admin/login.
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role === 'admin') { req.admin = payload; return next(); }
  } catch { /* kein gueltiges JWT – unten weiterpruefen */ }

  // Notweg fuer Clients, die noch das feste Token eingetragen haben
  // (z. B. die Sunmi-Kasse zwischen zwei Anmeldungen). Kann entfallen,
  // sobald alle Geraete einmal ueber /api/admin/login gelaufen sind.
  if (process.env.ADMIN_TOKEN_SECRET && gleichSicher(token, process.env.ADMIN_TOKEN_SECRET)) {
    req.admin = { role: 'admin', legacy: true };
    return next();
  }

  return res.status(401).json({ message: 'Token ungültig' });
}

// ─── Customer Auth (JWT) ──────────────────────────────────────────
function customerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Nicht eingeloggt' });
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token abgelaufen oder ungültig' });
  }
}

// ═══════════════════════════════════════════════════════════════
// KUNDEN-AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, first, last, phone } = req.body;
    if (!email || !password || !first || !last || !phone) {
      return res.status(400).json({ message: 'Alle Pflichtfelder ausfüllen' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Passwort mindestens 6 Zeichen' });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: 'E-Mail bereits registriert' });

    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, password: hash, first, last, phone: phone || '' });
    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      token,
      user: { id: user._id, email: user.email, first: user.first, last: user.last }
    });
  } catch (err) {
    console.error('Register Fehler:', err);
    res.status(500).json({ message: 'Registrierung fehlgeschlagen' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'Falsche E-Mail oder Passwort' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: 'Falsche E-Mail oder Passwort' });

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user._id, email: user.email, first: user.first, last: user.last }
    });
  } catch (err) {
    console.error('Login Fehler:', err);
    res.status(500).json({ message: 'Login fehlgeschlagen' });
  }
});

app.get('/api/auth/me', customerAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User nicht gefunden' });
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Fehler' });
  }
});

app.patch('/api/auth/profile', customerAuth, async (req, res) => {
  try {
    const { first, last, phone, addresses, defaultAddress } = req.body;
    const update = {};
    if (first) update.first = first;
    if (last) update.last = last;
    if (phone !== undefined) update.phone = phone;
    if (addresses) update.addresses = addresses;
    if (defaultAddress !== undefined) update.defaultAddress = defaultAddress;

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password');
    res.json(user);
  } catch {
    res.status(500).json({ message: 'Profil-Update fehlgeschlagen' });
  }
});

app.patch('/api/auth/password', customerAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Neues Passwort mindestens 6 Zeichen' });
    }
    const user = await User.findById(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ message: 'Aktuelles Passwort falsch' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Passwort geändert' });
  } catch {
    res.status(500).json({ message: 'Fehler beim Passwort ändern' });
  }
});

app.get('/api/account/orders', customerAuth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .select('orderNum status payment total items createdAt mode');
    res.json(orders);
  } catch {
    res.status(500).json({ message: 'Bestellhistorie konnte nicht geladen werden' });
  }
});

app.post('/api/account/reorder/:orderId', customerAuth, async (req, res) => {
  try {
    const original = await Order.findOne({ _id: req.params.orderId, userId: req.user.id });
    if (!original) return res.status(404).json({ message: 'Bestellung nicht gefunden' });

    res.json({
      items: original.items,
      mode: original.mode,
      note: original.note || ''
    });
  } catch {
    res.status(500).json({ message: 'Re-Order fehlgeschlagen' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════

// Lebenszeichen fuer den Lastverteiler: antwortet immer mit 200, solange der
// Prozess laeuft. Getrennt von /api/health, und zwar aus einem konkreten
// Grund: /api/health meldet bei fehlender Datenbank korrekt 503. Zeigt Renders
// healthCheckPath darauf, gilt der Dienst dauerhaft als krank, Render leitet
// keinen Verkehr hin und antwortet mit 502 - man kommt also nicht einmal mehr
// an die Meldung heran, die sagt, was fehlt. Henne und Ei.
app.get('/api/live', (req, res) => res.json({ alive: true, time: new Date() }));

// Was die Zustandsmeldung ueber die Datenbank verraten darf: ob eine URI
// gesetzt ist, ob ein Datenbankname darin steht, und in welchem Zustand die
// Verbindung ist. NICHT Benutzer, Passwort oder Clusteradresse - der Endpunkt
// ist oeffentlich.
function datenbankBefund() {
  const zustand = ['getrennt', 'verbunden', 'verbindet', 'trennt'][mongoose.connection.readyState] || 'unbekannt';
  const uri = process.env.MONGODB_URI;
  if (!uri) return { db: 'disconnected', grund: 'MONGODB_URI ist nicht gesetzt', zustand };
  const nachSchema = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const vorPfad = nachSchema.split('/')[0];
  if ((vorPfad.match(/@/g) || []).length > 1) {
    return { db: 'disconnected', zustand,
      grund: 'Mehrere @ vor der Clusteradresse - Sonderzeichen im Passwort URL-kodieren: @ wird %40' };
  }
  let name = null;
  try { name = new URL(uri.replace(/^mongodb\+srv:/, 'https:')).pathname.replace(/^\//, '') || null; }
  catch { return { db: 'disconnected', grund: 'MONGODB_URI laesst sich nicht lesen', zustand }; }
  if (mongoose.connection.readyState === 1) return { db: 'connected', datenbank: name, zustand };
  return { db: 'disconnected', datenbank: name, zustand,
    grund: !name
      ? 'Kein Datenbankname in der URI - er gehoert hinter den letzten Schraegstrich'
      : 'URI steht, Verbindung kommt nicht zustande - meist sind die Outbound-Adressen des Hosters nicht in Atlas freigegeben' };
}

app.get('/api/health', (req, res) => {
  const befund = datenbankBefund();
  const dbUp = befund.db === 'connected';
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    ...befund,
    restaurant: 'Pizzeria La Scala', time: new Date(),
    // Render setzt RENDER_GIT_COMMIT selbst. Ohne diese Angabe laesst sich
    // von aussen nicht feststellen, welcher Stand gerade laeuft.
    commit: (process.env.RENDER_GIT_COMMIT || 'unbekannt').slice(0, 7)
  });
});

app.get('/api/config', (req, res) => res.json({
  whatsapp: process.env.WHATSAPP_NUMBER || '',
  serviceFee: 0,
  deliveryCities: {
    'Selm-Bork':   { min: 12.00, fee: 0 },
    'Südkirchen':  { min: 20.00, fee: 0 },
    'Nordkirchen': { min: 20.00, fee: 0 },
    'Vinnum':      { min: 20.00, fee: 0 },
    'Cappenberg':  { min: 20.00, fee: 0 },
    'Lüdinghausen':{ min: 20.00, fee: 0 },
  }
}));

// ── Restaurant Status (öffentlich) ───────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const s = await Settings.findById('restaurant');
    const mode = s ? (s.mode || (s.isOpen ? 'online' : 'geschlossen')) : 'online';
    res.json({ mode, isOpen: mode === 'online' });
  } catch(e) { res.json({ mode: 'online', isOpen: true }); }
});

// ── Restaurant Status (Admin) ─────────────────────────────────────
app.patch('/api/admin/status', auth, async (req, res) => {
  try {
    const { mode, manualOverride } = req.body;
    const update = {};
    if (mode !== undefined)           update.mode           = mode;
    if (manualOverride !== undefined) update.manualOverride = manualOverride;
    // Auto-Modus: sofort berechnen wenn manualOverride auf false gesetzt wird
    if (manualOverride === false && mode === undefined) {
      update.mode = calcAutoMode();
    }
    update.isOpen = (update.mode || mode) === 'online';
    const s = await Settings.findByIdAndUpdate('restaurant', update, { upsert: true, new: true });
    const icons = { online:'✅ ONLINE', geschlossen:'❌ GESCHLOSSEN', neutral:'⚪ NEUTRAL' };
    console.log(`🏪 Restaurant: ${icons[s.mode]} | Manuell: ${s.manualOverride}`);
    res.json({ mode: s.mode, manualOverride: s.manualOverride, isOpen: s.isOpen });
  } catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// ── Admin: aktuellen Status lesen ────────────────────────────────
app.get('/api/admin/status', auth, async (req, res) => {
  try {
    const s = await Settings.findById('restaurant');
    const mode = s ? (s.mode || (s.isOpen ? 'online' : 'geschlossen')) : 'online';
    res.json({ mode, manualOverride: s ? s.manualOverride : false, isOpen: mode === 'online' });
  } catch(e) { res.status(500).json({ mode: 'online', manualOverride: false }); }
});

app.get('/api/availability', async (req, res) => {
  try {
    const d = await Availability.find({ available: false }).select('itemName -_id');
    res.json({ disabled: d.map(x => x.itemName) });
  } catch(e) { res.status(500).json({ message: 'Fehler' }); }
});

// ── Neue Web-Bestellung (pending) ────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    // userId aus Kunden-JWT extrahieren falls vorhanden (Gastbestellung bleibt möglich)
    let userId = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
        userId = decoded.id;
      } catch {} // Gastbestellung – kein Fehler
    }

    const isPOS    = req.body.source === 'pos';
    // Personal (Kasse/Telefon) wird nicht gesperrt; Web-Bestellungen nur in der Lieferzeit
    if (!isPOS && req.body.mode === 'lieferung' && !lieferungMoeglich()) {
      return res.status(400).json({ message: LIEFERZEIT_FEHLER });
    }
    const orderNum = await getNextOrderNum();

    const gesamt = Math.round((
      (Number(req.body.subtotal) || 0) +
      (Number(req.body.deliveryFee) || 0) + (Number(req.body.serviceFee) || 0)
    ) * 100) / 100;

    const order    = new Order({
      ...req.body, orderNum, userId,
      total:    isPOS ? req.body.total : gesamt,
      status: isPOS ? 'confirmed' : 'pending'
    });
    await order.save();
    if (isPOS) {
      await sendConfirmationEmail(order, order.prepTime || 20);
      await sendRestaurantEmail(order);
      await triggerPrint(order);
    }
    res.status(201).json({ orderNum: order.orderNum, statusToken: order.statusToken, order });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Fehler beim Speichern' }); }
});

// ── Bestellstatus fuer den wartenden Kunden (oeffentlich, Token-geschuetzt) ──
// Der Kunde wartet nach dem Absenden auf die Annahme durch das Restaurant.
// Antwortet absichtlich minimal: kein Name, keine Adresse, keine Betraege.
app.get('/api/orders/status/:token', async (req, res) => {
  try {
    const o = await Order.findOne({ statusToken: req.params.token })
      .select('status paymentStatus prepTime orderNum mode cancelReason');
    // Der Marker unterscheidet diese 404 von der eines Backends, das die Route
    // noch gar nicht kennt -- etwa im Fenster zwischen Seiten- und Backend-Deploy.
    if (!o) return res.status(404).json({ message: 'Nicht gefunden', unbekannterSchluessel: true });
    res.json({
      status:           o.status,
      paymentStatus:    o.paymentStatus,
      estimatedMinutes: o.prepTime || null,
      orderNum:         o.orderNum,
      mode:             o.mode,
      cancelReason:     o.cancelReason || ''
    });
  } catch (e) {
    console.error('Statusabfrage:', e.message);
    res.status(500).json({ message: 'Fehler' });
  }
});

// ── Stripe Checkout ───────────────────────────────────────────────
app.post('/api/create-stripe-checkout', async (req, res) => {
  try {
    const { items, subtotal, deliveryFee, serviceFee, customer, mode, note } = req.body;
    if (mode === 'lieferung' && !lieferungMoeglich()) return res.status(400).json({ message: LIEFERZEIT_FEHLER });
    const orderNum = await getNextOrderNum();

    const total  = Math.round((
      (Number(subtotal) || 0) + (Number(deliveryFee) || 0) + (Number(serviceFee) || 0)
    ) * 100) / 100;

    const lineItems = items.filter(i => i.price > 0).map(i => ({
      price_data: { currency:'eur',
        product_data: { name: `${i.qty}× ${i.name}${i.note?' ('+i.note+')':''}` },
        unit_amount: Math.round(i.price * 100) },
      quantity: i.qty,
    }));
    if (deliveryFee > 0) lineItems.push({
      price_data: { currency:'eur', product_data:{ name:'Liefergebühr' }, unit_amount: Math.round(deliveryFee*100) }, quantity:1
    });
    if (serviceFee > 0) lineItems.push({
      price_data: { currency:'eur', product_data:{ name:'Servicegebühr' }, unit_amount: Math.round(serviceFee*100) }, quantity:1
    });

    // Stripe Connect: Provision berechnen
    // serviceFee + Stripe-Transaktionsgebühr (1,5% + 0,25€)
    // stripeFee in appFee einrechnen → Gastro trägt Stripe-Gebühren, FlueVate behält vollen Anteil
    const stripeFee = Math.round((total * 0.015 + 0.25) * 100);
    const appFee = Math.round(serviceFee * 100) + stripeFee;

    // Zugriffsschluessel schon hier erzeugen: die success_url wird gebaut,
    // bevor die Bestellung existiert, und muss ihn mitfuehren.
    const statusToken = crypto.randomBytes(9).toString('base64url');

    const sessionOpts = {
      line_items: lineItems,
      mode: 'payment',
      ...(customer.email ? { customer_email: customer.email } : {}),
      locale: 'de',
      metadata: { orderNum: String(orderNum) },
      success_url: `${FRONTEND}?order=${orderNum}&t=${statusToken}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${FRONTEND}?payment=cancelled`,
    };

    // Stripe Connect wenn konfiguriert
    if (process.env.STRIPE_CONNECT_ACCOUNT) {
      // Mit Connect: payment_method_types explizit (Klarna nicht mit Connect kompatibel)
      sessionOpts.payment_method_types = ['card'];
      sessionOpts.payment_intent_data = {
        application_fee_amount: appFee,
        transfer_data: { destination: process.env.STRIPE_CONNECT_ACCOUNT }
      };
    } else {
      // Ohne Connect: alle im Stripe-Dashboard aktivierten Methoden erlauben
      // (Karte, Apple Pay, Google Pay, Klarna, etc.)
      sessionOpts.automatic_payment_methods = { enabled: true };
    }

    const session = await getStripe().checkout.sessions.create(sessionOpts);

    const order = new Order({
      items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum,
      payment: 'stripe', paymentStatus: 'pending',
      stripeSessionId: session.id, status: 'awaiting_payment',
      statusToken
    });
    await order.save();
    res.json({ url: session.url, orderNum });
  } catch(e) { console.error(e); res.status(500).json({ message: 'Stripe Fehler: '+e.message }); }
});

// ── Stripe Webhook ────────────────────────────────────────────────
app.post('/api/stripe-webhook', async (req, res) => {
  let event;
  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send('Webhook Error: '+e.message); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const order = await Order.findOne({ stripeSessionId: s.id });
    if (order) {
      order.paymentStatus = 'paid';
      order.status = 'pending'; // wartet auf Admin-Bestätigung
      order.stripePaymentIntentId = s.payment_intent;
      await order.save();
      console.log(`💳 Bezahlt: #${order.orderNum} → wartet auf Bestätigung`);
    }
  }
  if (event.type === 'checkout.session.expired') {
    await Order.findOneAndUpdate({ stripeSessionId: event.data.object.id }, { status:'cancelled' });
  }
  res.json({ received: true });
});

// ── Zahlungsverifikation (Fallback falls Webhook fehlschlägt) ──
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, message: 'sessionId fehlt' });

    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.json({ ok: false, message: 'Noch nicht bezahlt' });
    }

    const order = await Order.findOne({ stripeSessionId: sessionId });
    if (!order) return res.status(404).json({ ok: false, message: 'Bestellung nicht gefunden' });

    if (order.status === 'awaiting_payment') {
      order.paymentStatus = 'paid';
      order.status = 'pending';
      order.stripePaymentIntentId = session.payment_intent;
      await order.save();
      console.log(`✅ Zahlung verifiziert (Fallback): #${order.orderNum}`);
    }

    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) {
    console.error('verify-payment Fehler:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── PayPal Checkout ───────────────────────────────────────────────
app.post('/api/create-paypal-order', async (req, res) => {
  try {
    const { items, subtotal, deliveryFee, serviceFee, customer, mode, note } = req.body;
    if (mode === 'lieferung' && !lieferungMoeglich()) return res.status(400).json({ message: LIEFERZEIT_FEHLER });
    const orderNum = await getNextOrderNum();

    const total  = Math.round((
      (Number(subtotal) || 0) + (Number(deliveryFee) || 0) + (Number(serviceFee) || 0)
    ) * 100) / 100;

    // Zugriffsschluessel schon hier erzeugen: die return_url wird gebaut,
    // bevor die Bestellung existiert, und muss ihn mitfuehren.
    const statusToken = crypto.randomBytes(9).toString('base64url');

    const token = await getPaypalAccessToken();
    const ppOrder = await paypalApi('/v2/checkout/orders', 'POST', token, {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: String(orderNum),
        custom_id:    String(orderNum),
        description:  `Pizzeria La Scala Bestellung #${orderNum}`,
        amount: { currency_code: 'EUR', value: Number(total).toFixed(2) }
      }],
      application_context: {
        brand_name:          'Pizzeria La Scala',
        locale:              'de-DE',
        user_action:         'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: `${FRONTEND}?order=${orderNum}&t=${statusToken}&paypal=1`,
        cancel_url: `${FRONTEND}?payment=cancelled`,
      }
    });

    const approve = (ppOrder.links || []).find(l => l.rel === 'approve' || l.rel === 'payer-action');

    const order = new Order({
      items, subtotal, deliveryFee, serviceFee, total,
      customer, mode, note, orderNum,
      payment: 'paypal', paymentStatus: 'pending',
      paypalOrderId: ppOrder.id, status: 'awaiting_payment',
      statusToken
    });
    await order.save();
    res.json({ url: approve?.href, orderNum });
  } catch(e) { console.error(e); res.status(500).json({ message: 'PayPal Fehler: '+e.message }); }
});

// ── PayPal Capture (nach Rückkehr / Fallback) ─────────────────────
app.post('/api/paypal-capture', async (req, res) => {
  try {
    const paypalOrderId = req.body.paypalOrderId || req.body.token;
    if (!paypalOrderId) return res.status(400).json({ ok: false, message: 'paypalOrderId fehlt' });

    const order = await Order.findOne({ paypalOrderId });
    if (!order) return res.status(404).json({ ok: false, message: 'Bestellung nicht gefunden' });

    const token   = await getPaypalAccessToken();
    const current = await paypalApi(`/v2/checkout/orders/${paypalOrderId}`, 'GET', token);

    let captured;
    if (current.status === 'COMPLETED') {
      captured = current; // schon (z.B. per Webhook) eingezogen
    } else if (current.status === 'APPROVED') {
      captured = await paypalApi(`/v2/checkout/orders/${paypalOrderId}/capture`, 'POST', token, {});
    } else {
      return res.json({ ok: false, message: 'Noch nicht bezahlt' });
    }

    const captureId = captured?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (order.status === 'awaiting_payment') {
      order.paymentStatus = 'paid';
      order.status = 'pending';
      if (captureId) order.paypalCaptureId = captureId;
      await order.save();
      console.log(`✅ PayPal-Zahlung verifiziert: #${order.orderNum}`);
    }
    res.json({ ok: true, orderNum: order.orderNum });
  } catch(e) {
    console.error('paypal-capture Fehler:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── PayPal Webhook (Signatur per Verify-API → nutzt geparstes JSON) ─
app.post('/api/paypal-webhook', async (req, res) => {
  try {
    const token  = await getPaypalAccessToken();
    const verify = await paypalApi('/v1/notifications/verify-webhook-signature', 'POST', token, {
      auth_algo:         req.headers['paypal-auth-algo'],
      cert_url:          req.headers['paypal-cert-url'],
      transmission_id:   req.headers['paypal-transmission-id'],
      transmission_sig:  req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id:        process.env.PAYPAL_WEBHOOK_ID,
      webhook_event:     req.body
    });
    if (verify.verification_status !== 'SUCCESS') {
      console.warn('PayPal Webhook: ungültige Signatur');
      return res.status(400).send('invalid signature');
    }

    const event = req.body;
    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureId = event.resource?.id;
      const ppOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
      const order = ppOrderId
        ? await Order.findOne({ paypalOrderId: ppOrderId })
        : await Order.findOne({ paypalCaptureId: captureId });
      if (order && order.status === 'awaiting_payment') {
        order.paymentStatus = 'paid';
        order.status = 'pending';
        if (captureId) order.paypalCaptureId = captureId;
        await order.save();
        console.log(`💳 Bezahlt (PayPal): #${order.orderNum} → wartet auf Bestätigung`);
      }
    }
    res.json({ received: true });
  } catch(e) {
    console.error('paypal-webhook Fehler:', e.message);
    res.status(500).send('error');
  }
});

// ── Stripe-Bestellungen nachträglich einbuchen (Admin) ──────────
app.post('/api/admin/recover-stripe-orders', auth, async (_req, res) => {
  try {
    const stuck = await Order.find({ status: 'awaiting_payment', payment: 'stripe' });
    const recovered = [];
    for (const order of stuck) {
      try {
        const session = await getStripe().checkout.sessions.retrieve(order.stripeSessionId);
        if (session.payment_status === 'paid') {
          order.paymentStatus = 'paid';
          order.status = 'pending';
          order.stripePaymentIntentId = session.payment_intent;
          await order.save();
          recovered.push(order.orderNum);
          console.log(`🔁 Nachträglich eingebucht: #${order.orderNum}`);
        }
      } catch(e) {
        console.warn(`Stripe-Abfrage für #${order.orderNum} fehlgeschlagen:`, e.message);
      }
    }
    res.json({ recovered, total: stuck.length });
  } catch(e) {
    res.status(500).json({ message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/customers/:userId/orders', auth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(orders);
  } catch(e) {
    res.status(500).json({ message: 'Fehler beim Laden der Bestellungen' });
  }
});

app.get('/api/admin/customers', auth, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    const userIds = users.map(u => u._id);
    const stats = await Order.aggregate([
      { $match: { userId: { $in: userIds } } },
      { $group: { _id: '$userId', count: { $sum: 1 }, total: { $sum: '$total' }, lastOrder: { $max: '$createdAt' } } }
    ]);
    const statsMap = {};
    stats.forEach(s => { statsMap[s._id.toString()] = s; });
    const result = users.map(u => ({
      ...u.toObject(),
      orderCount: statsMap[u._id.toString()]?.count || 0,
      orderTotal: statsMap[u._id.toString()]?.total || 0,
      lastOrder:  statsMap[u._id.toString()]?.lastOrder || null,
    }));
    res.json(result);
  } catch(e) {
    res.status(500).json({ message: 'Fehler beim Laden der Kunden' });
  }
});

// Bremse gegen Passwort-Raten. Bewusst KEINE harte Sperre: die wuerde ein
// Angreifer nutzen, um den Wirt vor dem Feierabendgeschaeft auszusperren.
// Stattdessen wird jeder Fehlversuch pro IP langsamer beantwortet.
const loginVersuche = new Map();          // ip -> { n, zuletzt }
const VERSUCH_FENSTER_MS = 15 * 60 * 1000;
const MAX_WARTE_MS       = 5000;

function loginBremse(ip) {
  const jetzt = Date.now();
  const e = loginVersuche.get(ip);
  if (!e || jetzt - e.zuletzt > VERSUCH_FENSTER_MS) return 0;
  return Math.min(e.n * 500, MAX_WARTE_MS);
}
function fehlversuchNotieren(ip) {
  const jetzt = Date.now();
  const e = loginVersuche.get(ip);
  if (!e || jetzt - e.zuletzt > VERSUCH_FENSTER_MS) loginVersuche.set(ip, { n: 1, zuletzt: jetzt });
  else loginVersuche.set(ip, { n: e.n + 1, zuletzt: jetzt });
}
// Aufraeumen, damit die Map nicht unbegrenzt waechst
setInterval(() => {
  const jetzt = Date.now();
  for (const [ip, e] of loginVersuche) if (jetzt - e.zuletzt > VERSUCH_FENSTER_MS) loginVersuche.delete(ip);
}, VERSUCH_FENSTER_MS).unref?.();

app.post('/api/admin/login', async (req, res) => {
  const ip = req.ip || 'unbekannt';

  if (!process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
    console.error('ADMIN_PASSWORD oder JWT_SECRET fehlt – Admin-Login nicht moeglich');
    return res.status(500).json({ message: 'Server nicht konfiguriert' });
  }

  const warte = loginBremse(ip);
  if (warte) await new Promise(r => setTimeout(r, warte));

  if (!gleichSicher(String(req.body?.password ?? ''), process.env.ADMIN_PASSWORD)) {
    fehlversuchNotieren(ip);
    console.warn('Admin-Login fehlgeschlagen von', ip);
    return res.status(401).json({ message: 'Falsches Passwort' });
  }

  loginVersuche.delete(ip);
  // Befristetes Token statt des Server-Geheimnisses. 30 Tage, damit das
  // Kuechen-Tablet nicht mitten im Betrieb rausfliegt.
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// ── Pending Bestellungen (für 5s Polling) ───────────────────────
app.get('/api/admin/orders/pending', auth, async (req, res) => {
  try { res.json({ pending: await Order.find({ status:'pending' }).sort({ createdAt:1 }) }); }
  catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Alle Bestellungen ────────────────────────────────────────────
app.get('/api/admin/orders', auth, async (req, res) => {
  try {
    const dateParam = req.query.date; // z.B. "2026-04-25"

    if (dateParam) {
      // ── Vergangenheits-Abfrage: nur Bestellungen dieses Tages ──
      // Deutschland = UTC+2 (CEST) / UTC+1 (CET)
      // Server läuft in UTC → 2h abziehen damit der volle deutsche Tag abgedeckt ist
      const from = new Date(dateParam + 'T00:00:00+02:00');
      const to   = new Date(dateParam + 'T23:59:59+02:00');
      const orders = await Order.find({
        status:    { $nin: ['pending', 'awaiting_payment'] },
        createdAt: { $gte: from, $lte: to }
      }).sort({ createdAt: -1 });
      const valid = orders.filter(o => o.status !== 'cancelled');
      return res.json({
        orders,
        stats: {
          todayCount:   orders.length,
          todayRevenue: valid.reduce((s,o) => s+(o.total||0), 0),
          active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
          done:         orders.filter(o=>['ready','delivered'].includes(o.status)).length,
          cancelled:    orders.filter(o=>o.status==='cancelled').length,
          unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled').length,
        }
      });
    }

    // ── Normalfall: heutige + laufende Bestellungen ──
    const orders  = await Order.find({ status:{ $nin:['pending'] } }).sort({ createdAt:-1 }).limit(300);
    const pending = await Order.find({ status:'pending' }).sort({ createdAt:1 });
    const today   = new Date(); today.setHours(0,0,0,0);
    const tod     = orders.filter(o => new Date(o.createdAt) >= today && o.status !== 'awaiting_payment');
    res.json({
      orders, pending,
      stats: {
        todayCount:   tod.length,
        todayRevenue: tod.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+(o.total||0),0),
        totalRevenue: orders.reduce((s,o)=>s+(o.total||0),0),
        active:       orders.filter(o=>['confirmed','preparing'].includes(o.status)).length,
        done:         tod.filter(o=>['ready','delivered'].includes(o.status)).length,
        cancelled:    tod.filter(o=>o.status==='cancelled').length,
        unpaid:       orders.filter(o=>o.paymentStatus!=='paid'&&o.status!=='cancelled'&&o.status!=='awaiting_payment').length,
      }
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bestellung BESTÄTIGEN (Annehmen + Zeit) ──────────────────────
app.patch('/api/admin/orders/:id/confirm', auth, async (req, res) => {
  try {
    const { estimatedMinutes } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id,
      { status:'confirmed', prepTime: estimatedMinutes||45 }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    // E-Mail + Druck auslösen
    await sendConfirmationEmail(order, estimatedMinutes);
    await sendRestaurantEmail(order);
    await triggerPrint(order);
    console.log(`✅ #${order.orderNum} bestätigt – ${estimatedMinutes} Min.`);
    res.json(order);
  } catch(e) { console.error(e); res.status(500).json({ message:'Fehler' }); }
});

// ── Status ändern ────────────────────────────────────────────────
app.patch('/api/admin/orders/:id/status', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status:req.body.status }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bezahlstatus togglen ─────────────────────────────────────────
app.patch('/api/admin/orders/:id/payment', auth, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id,
      { paymentStatus:req.body.paymentStatus }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    res.json(order);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── STORNIEREN (mit Auto-Refund bei Stripe & PayPal) ─────────────
app.delete('/api/admin/orders/:id', auth, async (req, res) => {
  try {
    const reason = req.body?.cancelReason || '';
    const order  = await Order.findByIdAndUpdate(req.params.id,
      { status:'cancelled', cancelReason:reason }, { new:true });
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });

    let refundStatus = null;
    if (order.payment === 'stripe' && order.paymentStatus === 'paid' && order.stripePaymentIntentId) {
      try {
        const refund = await getStripe().refunds.create({ payment_intent: order.stripePaymentIntentId });
        refundStatus = refund.status;
        await Order.findByIdAndUpdate(order._id, { paymentStatus:'refunded' });
        console.log(`💸 Stripe-Refund #${order.orderNum}: ${refund.status}`);
      } catch(e) { console.error('Stripe Refund Fehler:', e.message); refundStatus='failed'; }
    } else if (order.payment === 'paypal' && order.paymentStatus === 'paid' && order.paypalCaptureId) {
      try {
        const token  = await getPaypalAccessToken();
        const refund = await paypalApi(`/v2/payments/captures/${order.paypalCaptureId}/refund`, 'POST', token, {});
        refundStatus = refund.status;
        await Order.findByIdAndUpdate(order._id, { paymentStatus:'refunded' });
        console.log(`💸 PayPal-Refund #${order.orderNum}: ${refund.status}`);
      } catch(e) { console.error('PayPal Refund Fehler:', e.message); refundStatus='failed'; }
    }
    await sendCancellationEmail(order, reason, refundStatus);
    res.json({ success:true, order, refundStatus });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Bon nachdrucken ──────────────────────────────────────────────
app.post('/api/admin/orders/:id/print', auth, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message:'Nicht gefunden' });
    await triggerPrint(order);
    res.json({ success:true });
  } catch(e) { res.status(500).json({ message:'Druckfehler' }); }
});

// ── Verfügbarkeit (Sold-Out Toggle) ─────────────────────────────
// Die Sammlung kennt nur Artikel, die schon einmal umgeschaltet wurden. Die Kasse
// zeigt aber genau das, was dieser Endpunkt liefert - ohne die Karte bliebe ihre
// Liste fast leer. Deshalb kommen die Namen aus Menue/menu.json, derselben Quelle,
// aus der karte-einsetzen.js das POS_MENU des Dashboards erzeugt.
const MENU_FILE = path.join(__dirname, 'Menue', 'menu.json');
let menuNamesCache = { mtimeMs: 0, names: [] };

function menuItemNames() {
  try {
    const stat = fs.statSync(MENU_FILE);
    if (stat.mtimeMs === menuNamesCache.mtimeMs) return menuNamesCache.names;

    const karte = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
    const names = [];
    const seen  = new Set();
    (karte.kategorien || []).forEach(kat => (kat.items || []).forEach(it => {
      // Doppelte Namen nur einmal: die Bestellseite vergleicht per Namensanfang,
      // ein Schalter trifft ohnehin alle gleichnamigen Artikel.
      if (it && it.name && !seen.has(it.name)) { seen.add(it.name); names.push(it.name); }
    }));
    if (!names.length) throw new Error('keine Artikelnamen in menu.json');

    menuNamesCache = { mtimeMs: stat.mtimeMs, names };
    return names;
  } catch (e) {
    // Lieber der letzte bekannte Stand als eine leere Liste.
    console.error('Speisekarte fuer Verfuegbarkeit nicht lesbar:', e.message);
    return menuNamesCache.names;
  }
}

app.get('/api/admin/availability', auth, async (req, res) => {
  try {
    const stored = await Availability.find();
    const state  = new Map(stored.map(d => [d.itemName, d.available !== false]));

    const items = menuItemNames().map(name => ({
      itemName:  name,
      available: state.has(name) ? state.get(name) : true
    }));

    // Eintraege, die nicht mehr auf der Karte stehen, gehen nicht verloren -
    // sonst liesse sich ein umbenannter Artikel nie wieder freischalten.
    const onMenu = new Set(items.map(i => i.itemName));
    stored.forEach(d => {
      if (!onMenu.has(d.itemName)) items.push({ itemName: d.itemName, available: d.available !== false });
    });

    res.json({ items });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

app.patch('/api/admin/availability', auth, async (req, res) => {
  try {
    const { itemName, available } = req.body;
    if (!itemName) return res.status(400).json({ message:'itemName fehlt' });
    const doc = await Availability.findOneAndUpdate(
      { itemName }, { available }, { upsert:true, new:true });
    console.log(`${available?'✅':'❌'} "${itemName}" → ${available?'verfügbar':'ausverkauft'}`);
    res.json(doc);
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ── Finanzübersicht ──────────────────────────────────────────────
app.get('/api/admin/finance', auth, async (req, res) => {
  try {
    const orders = await Order.find({ status:{ $in:['confirmed','preparing','ready','delivered'] } });
    const today  = new Date(); today.setHours(0,0,0,0);
    const wStart = new Date(); wStart.setDate(wStart.getDate() - wStart.getDay() + 1); wStart.setHours(0,0,0,0);
    const calc = list => {
      const brutto    = list.reduce((s,o)=>s+(o.total||0),0);
      const svcFees   = list.reduce((s,o)=>s+(o.serviceFee||0),0);
      return { count:list.length, brutto, svcFees, auszahlung: brutto-svcFees };
    };
    res.json({
      today: calc(orders.filter(o=>new Date(o.createdAt)>=today)),
      week:  calc(orders.filter(o=>new Date(o.createdAt)>=wStart)),
    });
  } catch(e) { res.status(500).json({ message:'Fehler' }); }
});

// ═══════════════════════════════════════════════════════════════
// E-MAIL FUNKTIONEN
// ═══════════════════════════════════════════════════════════════

const cleanName = n => n.replace(/[A-Z0-9](,[A-Z0-9])+$/, '').trimEnd();

async function sendConfirmationEmail(order, mins) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const m    = mins || order.prepTime || (order.mode==='lieferung'?45:20);
  const addr = order.mode==='lieferung'
    ? `${order.customer.street} ${order.customer.house}, ${order.customer.city}`
    : 'Ludgeristraße 62, 59379 Selm';
  const rows = (order.items||[]).map(i => {
    const extras = (i.extraDetails||[]).map(e => `<div style="font-size:11px;color:#888;padding-left:8px">↳ ${e.name}${e.price>0?' (+'+e.price.toFixed(2).replace('.',',')+'€)':''}</div>`).join('');
    return `<tr><td style="padding:4px 8px;vertical-align:top">${i.qty}×</td><td style="padding:4px 8px">${cleanName(i.name)}${i.note?' <em>('+i.note+')</em>':''}${extras}</td><td style="padding:4px 8px;text-align:right;vertical-align:top">${(i.price*i.qty).toFixed(2).replace('.',',')} €</td></tr>`;
  }).join('');
  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM || 'bestellungen@pizzerialascala.de',
      to:   order.customer.email,
      subject: `✅ Bestellung #${order.orderNum} bestätigt – Pizzeria La Scala`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#d32027;color:#fff;padding:22px;text-align:center">
          <h1 style="margin:0;font-size:22px">🍕 Pizzeria La Scala</h1>
          <p style="margin:4px 0 0;opacity:.8;font-size:13px">Ludgeristraße 62 · 59379 Selm</p>
        </div>
        <div style="padding:26px 22px">
          <h2 style="color:#d32027;margin:0 0 14px">Bestellung #${order.orderNum} bestätigt ✅</h2>
          <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung ist in der Küche!</p>
          <div style="background:#fff8f0;border-left:4px solid #d4a76a;padding:12px 16px;border-radius:0 8px 8px 0;margin:14px 0">
            <p style="margin:0 0 4px;font-weight:bold">${order.mode==='lieferung'?'🛵 Lieferung':'🏃 Abholung'}</p>
            <p style="margin:0;font-size:13px;color:#666">${addr}</p>
            <p style="margin:4px 0 0;font-size:15px;font-weight:bold;color:#d32027">⏱ Voraussichtlich ~${m} Minuten</p>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">
            <thead><tr style="border-bottom:2px solid #eee"><th align="left" style="padding:4px 8px">Menge</th><th align="left" style="padding:4px 8px">Artikel</th><th align="right" style="padding:4px 8px">Preis</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="border-top:1px solid #eee;padding-top:10px;font-size:13px">
            <div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Zwischensumme</span><span>${(order.subtotal||0).toFixed(2).replace('.',',')} €</span></div>
            ${order.deliveryFee>0?`<div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Liefergebühr</span><span>${order.deliveryFee.toFixed(2).replace('.',',')} €</span></div>`:''}
            ${(order.serviceFee||0)>0?`<div style="display:flex;justify-content:space-between;color:#666;margin:3px 0"><span>Servicegebühr</span><span>${order.serviceFee.toFixed(2).replace('.',',')} €</span></div>`:''}
            <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:15px;border-top:2px solid #d32027;padding-top:8px;margin-top:6px"><span>Gesamt</span><span style="color:#d32027">${(order.total||0).toFixed(2).replace('.',',')} €</span></div>
          </div>
          <p style="font-size:13px;color:#666;margin-top:14px">
            Zahlung: ${order.payment==='stripe'?'💳 Online (Stripe)':order.payment==='paypal'?'💙 PayPal':order.payment==='karte'?'💳 EC-Karte':'💵 Barzahlung'} ·
            ${order.paymentStatus==='paid'?'✅ Bereits bezahlt':'💵 Bitte bereithalten'}
          </p>
          ${order.note?`<p style="background:#fff3ea;padding:10px;border-radius:6px;font-size:13px">📝 Anmerkung: ${order.note}</p>`:''}
        </div>
        <div style="background:#f7f3ee;padding:14px;text-align:center;font-size:11px;color:#999">Pizzeria La Scala · Ludgeristraße 62 · 59379 Selm · Tel: 0 25 92 / 9 78 93 30</div>
      </div>`
    });
    console.log(`📧 Bestätigung → ${order.customer.email}`);
  } catch(e) { console.error('Mail Fehler:', e); }
}

async function sendRestaurantEmail(order) {
  if (!process.env.RESTAURANT_EMAIL) return;
  const items = (order.items||[]).map(i=>{
    const base = `${i.qty}× ${cleanName(i.name)}${i.note?' ('+i.note+')':''}`;
    const extras = (i.extraDetails||[]).map(e=>`   ↳ ${e.name}${e.price>0?' (+'+e.price.toFixed(2)+'€)':''}`).join('\n');
    return extras ? base+'\n'+extras : base;
  }).join('\n');
  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM||'bestellungen@pizzerialascala.de',
      to:   process.env.RESTAURANT_EMAIL,
      subject: `🔔 Bestellung #${order.orderNum} – ${order.mode==='lieferung'?'Lieferung':'Abholung'}`,
      html: `<pre style="font-family:monospace;font-size:13px">BESTELLUNG #${order.orderNum} · ${order.source==='pos'?'POS':'ONLINE'}
═══════════════════════════════
Art:    ${order.mode==='lieferung'?'🛵 LIEFERUNG':'🏃 ABHOLUNG'}
Kunde:  ${order.customer?.first} ${order.customer?.last}
Tel:    ${order.customer?.phone||'–'}
${order.mode==='lieferung'?`Adresse: ${order.customer?.street} ${order.customer?.house}, ${order.customer?.city}`:''}

ARTIKEL:
${items}

Zwischensumme: ${(order.subtotal||0).toFixed(2)} €
${order.deliveryFee?`Liefergebühr:  ${order.deliveryFee.toFixed(2)} €\n`:''}${(order.serviceFee||0)>0?`Servicegebühr: ${order.serviceFee.toFixed(2)} €\n`:''}GESAMT:        ${(order.total||0).toFixed(2)} €

Zahlung: ${order.payment==='stripe'?'KREDITKARTE':order.payment==='paypal'?'PAYPAL':order.payment==='karte'?'EC-KARTE':'BAR'} – ${order.paymentStatus==='paid'?'✅ BEZAHLT':'❌ NOCH OFFEN'}
${order.note?`Anmerkung: ${order.note}`:''}</pre>`
    });
  } catch(e) { console.error('Restaurant Mail:', e); }
}

async function sendCancellationEmail(order, reason, refundStatus) {
  if (!process.env.RESEND_API_KEY || !order.customer?.email) return;
  const isOnlineRefund = ['stripe','paypal'].includes(order.payment) && order.paymentStatus === 'refunded';
  const refundHtml = isOnlineRefund
    ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px;margin:14px 0">
        <strong style="color:#2e7d32">💸 Rückerstattung eingeleitet</strong><br>
        <span style="font-size:13px;color:#555">Der Betrag von ${(order.total||0).toFixed(2).replace('.',',')} € wird in 5–10 Werktagen zurückgebucht.</span>
       </div>` : '';
  try {
    await getResend()?.emails.send({
      from: process.env.EMAIL_FROM||'bestellungen@pizzerialascala.de',
      to:   order.customer.email,
      subject: `❌ Bestellung #${order.orderNum} storniert – Pizzeria La Scala`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#d32027;color:#fff;padding:22px;text-align:center"><h1 style="margin:0">🍕 Pizzeria La Scala</h1></div>
        <div style="padding:26px 22px">
          <h2>Bestellung #${order.orderNum} storniert</h2>
          <p>Hallo <strong>${order.customer.first}</strong>, deine Bestellung wurde leider storniert.</p>
          ${reason?`<div style="background:#fff3ea;border-radius:8px;padding:12px;margin:14px 0"><strong>Grund:</strong> ${reason}</div>`:''}
          ${refundHtml}
          <p>Bei Fragen: <strong>0 25 92 / 9 78 93 30</strong></p>
        </div>
      </div>`
    });
  } catch(e) { console.error('Storno Mail:', e); }
}

// ═══════════════════════════════════════════════════════════════
// PRINTNODE
// ═══════════════════════════════════════════════════════════════

async function triggerPrint(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) return;
  try { const p = require('./printnode-helper'); await p.printOrder(order); }
  catch(e) { console.error('PrintNode:', e); }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-STATUS (Cron – jede Minute, Öffnungszeiten Deutschland)
// ═══════════════════════════════════════════════════════════════

function calcAutoMode() {
  // Deutsche Zeit berechnen
  const deTime = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const parts  = deTime.match(/(\d+)\.(\d+)\.(\d+),\s*(\d+):(\d+)/);
  if (!parts) return 'geschlossen';
  const day  = parseInt(parts[1]);
  const mon  = parseInt(parts[2]);
  const year = parseInt(parts[3]);
  const h    = parseInt(parts[4]);
  const m    = parseInt(parts[5]);
  const mins = h * 60 + m;

  // Wochentag berechnen (0=So, 1=Mo, ..., 6=Sa)
  const wd = new Date(year, mon - 1, day).getDay();

  // Öffnungszeiten La Scala: Mo und Mi–So 11:00–23:00, Dienstag Ruhetag
  // (außer an gesetzlichen Feiertagen in NRW). Lieferung 11:30–22:30 –
  // dieser Modus schaltet nur "Bestellung offen/geschlossen" und kennt keine
  // getrennte Lieferzeit; die Lieferzeit steht im Impressumstext.
  if (wd === 2 && !istFeiertagNRW(year, mon, day)) return 'geschlossen';
  return (mins >= 11*60 && mins < 23*60) ? 'online' : 'geschlossen';
}

// Lieferzeit La Scala: 11:30-22:30 Uhr (Europe/Berlin). Abholung und Bestellannahme
// laufen laut calcAutoMode() 11:00-23:00. Dienstag ist Ruhetag ausser an Feiertagen,
// die Tagesentscheidung trifft calcAutoMode().
function lieferungMoeglich() {
  const deTime = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
  const parts  = deTime.match(/(\d+)\.(\d+)\.(\d+),\s*(\d+):(\d+)/);
  if (!parts) return false;
  const mins = parseInt(parts[4]) * 60 + parseInt(parts[5]);
  if (calcAutoMode() !== 'online') return false;   // Dienstag-Ruhetag / ausserhalb Oeffnungszeit
  return mins >= 11*60 + 30 && mins < 22*60 + 30;
}
const LIEFERZEIT_FEHLER = 'Lieferung ist nur von 11:30 bis 22:30 Uhr möglich. Zu dieser Zeit bitte Abholung wählen.';

// Gesetzliche Feiertage NRW (für den Dienstags-Ruhetag)
function istFeiertagNRW(year, mon, day) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19*a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2*e + 2*i - h - k) % 7;
  const m = Math.floor((a + 11*h + 22*l) / 451);
  const em = Math.floor((h + l - 7*m + 114) / 31), ed = ((h + l - 7*m + 114) % 31) + 1;
  const key = (dt) => dt.getMonth() + 1 + '-' + dt.getDate();
  const off = (n) => key(new Date(year, em - 1, ed + n));
  const fest = new Set(['1-1', '5-1', '10-3', '11-1', '12-25', '12-26',
    off(-2), off(1), off(39), off(50), off(60)]);
  return fest.has(mon + '-' + day);
}

cron.schedule('* * * * *', async () => {
  try {
    const s = await Settings.findById('restaurant');
    if (s && s.manualOverride) return; // Manuell gesetzt – nicht überschreiben
    const autoMode = calcAutoMode();
    await Settings.findByIdAndUpdate('restaurant',
      { mode: autoMode, isOpen: autoMode === 'online' },
      { upsert: true, new: true }
    );
  } catch(e) { console.error('Auto-Status Fehler:', e); }
});

// ── Wachhund: bezahlt, aber unsichtbar ──────────────────────────
// Eine Kartenzahlung wird erst zur Bestellung, wenn Stripes Webhook sie
// meldet. Bricht diese Kette, bleibt die Bestellung auf `awaiting_payment`
// stehen: Der Gast hat gezahlt, die Kueche sieht nichts, und nichts meldet
// sich. Genau das ist in anderen FlueVate-Systemen 2026 passiert, mit
// mehreren bezahlten, aber unsichtbaren Bestellungen.
//
// Der Wachhund schaut alle fuenf Minuten nach Bestellungen, die laenger als
// zehn Minuten warten, fragt bei Stripe nach und holt sie nach. Er ist
// Rettung und Alarm zugleich: Das Geschaeft laeuft mit Verspaetung weiter,
// und es faellt trotzdem auf, statt monatelang unbemerkt zu bleiben.
const WACHHUND_MINUTEN = 10;
// Obere Altersgrenze, und die ist nicht optional. Ohne sie greift der
// Wachhund beim ersten Lauf nach JEDER haengenden Bestellung - auch nach allem, was
// aus aelterer Zeit liegt. Die Liste der eingehenden
// Bestellungen im Dashboard hat keine Datumsgrenze und sortiert die aeltesten
// nach oben: Mitten im Betrieb stuende dort eine Wand aus Monate alten
// "neuen" Bestellungen, jede mit Alarmton. Und weil "pending" im Umsatz
// zaehlt, aenderten sich rueckwirkend Berichte und Gebuehren.
//
// Nach zwei Stunden wartet kein Gast mehr. Aeltere Faelle sind Aufraeumarbeit
// und brauchen eine Entscheidung, keinen Automaten.
const WACHHUND_HOECHSTENS_STUNDEN = 2;

cron.schedule('*/5 * * * *', async () => {
  if (mongoose.connection.readyState !== 1) return;
  let stripe;
  try { stripe = getStripe(); } catch { return; }   // ohne Stripe kein Wachhund

  try {
    const grenze = new Date(Date.now() - WACHHUND_MINUTEN * 60 * 1000);
    const haengend = await Order.find({
      status: 'awaiting_payment', payment: 'stripe',
      createdAt: { $lt: grenze, $gt: new Date(Date.now() - WACHHUND_HOECHSTENS_STUNDEN * 3600 * 1000) },
      nachgeholt: { $ne: true },
    }).limit(50);
    if (!haengend.length) return;

    const geholt = [];
    for (const order of haengend) {
      try {
        const sitzung = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
        if (sitzung.payment_status !== 'paid') continue;   // Gast hat abgebrochen
        order.paymentStatus = 'paid';
        order.status = 'pending';
        order.nachgeholt = true;
        if (sitzung.payment_intent) order.stripePaymentIntentId = sitzung.payment_intent;
        await order.save();
        geholt.push(order);
        console.error(`🚨 Wachhund: #${order.orderNum} war bezahlt und unsichtbar - jetzt auf pending`);
      } catch (e) {
        console.warn(`Wachhund uebersprungen #${order.orderNum}: ${e.message}`);
      }
    }
    if (geholt.length) await wachhundMelden(geholt);
  } catch (e) { console.error('Wachhund Fehler:', e.message); }
});

// Die Meldung geht an beide: der Betreiber muss wissen, dass die Zahlkette
// klemmt, und das Restaurant, dass ein Gast seit zehn Minuten wartet.
async function wachhundMelden(bestellungen) {
  const resend = getResend();
  if (!resend) { console.error('🚨 Wachhund: kein RESEND_API_KEY - Alarm bleibt ungesendet'); return; }
  const empfaenger = [process.env.OWNER_EMAIL, process.env.RESTAURANT_EMAIL].filter(Boolean);
  if (!empfaenger.length) { console.error('🚨 Wachhund: kein Empfaenger gesetzt'); return; }

  const zeilen = bestellungen.map(o =>
    `<tr><td style="padding:4px 12px 4px 0">#${o.orderNum}</td>` +
    `<td style="padding:4px 12px 4px 0">${Number(o.total || 0).toFixed(2).replace('.', ',')} €</td>` +
    `<td style="padding:4px 0;color:#666">${new Date(o.createdAt).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}</td></tr>`).join('');

  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to: empfaenger,
    subject: `🚨 ${bestellungen.length} bezahlte Bestellung${bestellungen.length > 1 ? 'en' : ''} war${bestellungen.length > 1 ? 'en' : ''} unsichtbar`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;color:#222">
      <h2 style="font-size:18px;margin:0 0 8px">Bezahlt, aber nicht im Dashboard angekommen</h2>
      <p style="margin:0 0 12px">Diese Bestellung${bestellungen.length > 1 ? 'en' : ''} stand${bestellungen.length > 1 ? 'en' : ''}
      laenger als ${WACHHUND_MINUTEN} Minuten auf "wartet auf Zahlung", obwohl bei Stripe bezahlt wurde.
      Sie wurde${bestellungen.length > 1 ? 'n' : ''} soeben nachgeholt und ist jetzt im Dashboard sichtbar.</p>
      <table style="font-size:14px;border-collapse:collapse">${zeilen}</table>
      <p style="margin:16px 0 0;font-size:13px;color:#666">
        Der Gast wartet entsprechend laenger. Ursache ist fast immer der Stripe-Webhook:
        falsche Adresse, abgeschalteter Endpunkt oder ein Signaturgeheimnis, das mit
        <code>we_</code> statt <code>whsec_</code> beginnt. Pruefen mit
        <code>zahlkette-pruefen.js</code> aus dem Betriebs-Skill.</p></div>`,
  });
  if (error) console.error('🚨 Wachhund: Alarm-Mail fehlgeschlagen:', error.message || error);
  else console.error(`🚨 Wachhund: Alarm an ${empfaenger.join(', ')} gesendet`);
}

// ═══════════════════════════════════════════════════════════════
// WOCHENBERICHT + RECHNUNG (Cron – jeden Sonntag 23:59)
// ═══════════════════════════════════════════════════════════════

// PDF-Generator Helper
function generatePdf(buildFn) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildFn(doc);
    doc.end();
  });
}

// ─── PDF Layout-Helpers ───────────────────────────────────────────────────
const PDF_M  = 50;
const PDF_W  = 495;
const PDF_PW = 595;
const PDF_FT = 810;
const PDF_SV = 0;
const PDF_BASE = 150; // monatliche Grundgebühr (Fixmodell: 150 € + Servicegebühr/Bestellung)
const pdfFmt = n => n.toFixed(2).replace('.', ',') + ' €';

function pdfColorBox(doc, title, sub, color = '#d32027', h = 70) {
  doc.rect(0, 0, PDF_PW, h).fill(color);
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#fff').text(title, PDF_M, 18);
  if (sub) doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.75)').text(sub, PDF_M, 44);
  doc.y = h + 12;
}

function pdfHr(doc, color = '#ddd', lw = 0.5) {
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M + PDF_W, doc.y).strokeColor(color).lineWidth(lw).stroke();
  doc.y += lw + 3;
}

function pdfKacheln(doc, items) {
  const kW = Math.floor((PDF_W - (items.length - 1) * 8) / items.length);
  const top = doc.y;
  items.forEach(([label, value, color], i) => {
    const x = PDF_M + i * (kW + 8);
    doc.rect(x, top, kW, 46).fill(color);
    doc.font('Helvetica').fontSize(7.5).fillColor('rgba(255,255,255,0.72)').text(label, x + 8, top + 8, { width: kW - 12 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff').text(value, x + 8, top + 22, { width: kW - 12 });
  });
  doc.y = top + 54;
}

function pdfTableRow(doc, cells, shade, bold = false) {
  const top = doc.y;
  if (shade) doc.rect(PDF_M, top, PDF_W, 20).fill('#f5f7fa');
  cells.forEach(([txt, x, w, align]) => {
    const opts = align ? { width: w, align } : { width: w };
    (bold ? doc.font('Helvetica-Bold') : doc.font('Helvetica'))
      .fontSize(9.5).fillColor('#222').text(txt, x, top + 5, opts);
  });
  doc.y = top + 20;
}

function pdfKundenliste(doc, orders) {
  function drawGroup(label, color, list) {
    if (!list.length) return;
    const gy = doc.y;
    doc.rect(PDF_M, gy, PDF_W, 22).fill(color);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(label, PDF_M + 8, gy + 6, { width: PDF_W - 16 });
    doc.y = gy + 22 + 2;
    const hy = doc.y;
    doc.rect(PDF_M, hy, PDF_W, 16).fill('#eaeef3');
    [['#', PDF_M+2, 30, 'left'], ['Datum', PDF_M+34, 40, 'left'], ['Kunde', PDF_M+76, 190, 'left'],
     ['Art', PDF_M+268, 80, 'left'], ['Betrag', PDF_M+2, PDF_W-4, 'right']
    ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(8).fillColor('#444').text(h, x, hy+4, { width:w, align:a }));
    doc.y = hy + 16 + 2;
    let sub = 0;
    list.forEach((o, i) => {
      if (doc.y > PDF_FT - 24) { doc.addPage(); doc.y = PDF_M; }
      const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
      const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim().substring(0, 28);
      const modeStr = o.mode === 'lieferung' ? 'Lieferung' : 'Abholung';
      const ry = doc.y;
      if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 18).fill('#fafafa');
      doc.font('Helvetica').fontSize(9).fillColor('#222')
        .text(`${o.orderNum}`, PDF_M+2,   ry+4, { width:30 })
        .text(date,            PDF_M+34,  ry+4, { width:40 })
        .text(name,            PDF_M+76,  ry+4, { width:188 })
        .text(modeStr,         PDF_M+268, ry+4, { width:80 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#222')
        .text(pdfFmt(o.total||0), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
      doc.y = ry + 18;
      sub += (o.total||0);
    });
    const sy = doc.y;
    doc.rect(PDF_M, sy, PDF_W, 20).fill(color + '28');
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Summe ${label}:`, PDF_M+8, sy+5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#333').text(pdfFmt(sub), PDF_M+2, sy+5, { width:PDF_W-4, align:'right' });
    doc.y = sy + 20 + 10;
  }
  drawGroup('Barzahlung', '#d32027', orders.filter(o => o.payment === 'bar'));
  drawGroup('Online-Zahlung (Stripe)', '#276749', orders.filter(o => o.payment === 'stripe'));
  drawGroup('Online-Zahlung (PayPal)', '#003087', orders.filter(o => o.payment === 'paypal'));
  drawGroup('EC-Karte', '#555555', orders.filter(o => o.payment === 'karte'));
}

function pdfBarRechnung(doc, barOrders, barStats, zeitraum) {
  if (!barOrders.length) return;
  doc.addPage(); doc.y = PDF_M;
  doc.rect(0, 0, PDF_PW, 50).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#fff').text('Bar-Zahlungen – Übersicht', PDF_M, 14);
  doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.7)').text(`FlueVate Online-Bestellsystem  ·  ${zeitraum}`, PDF_M, 33);
  doc.y = 62;
  const addrY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Anbieter:', PDF_M, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Abed Rachman Falah · FlueVate', PDF_M, addrY+12).text('Zur Goldbrede 30, 59269 Beckum', PDF_M, addrY+22);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1a2e').text('Restaurant:', PDF_M+270, addrY);
  doc.font('Helvetica').fontSize(9).fillColor('#444').text('Pizzeria La Scala', PDF_M+270, addrY+12).text('Ludgeristraße 62, 59379 Selm', PDF_M+270, addrY+22);
  doc.y = addrY + 38;
  doc.font('Helvetica').fontSize(8.5).fillColor('#888').text(`Zeitraum: ${zeitraum}`, PDF_M, doc.y);
  doc.y += 12;
  const hy = doc.y;
  doc.rect(PDF_M, hy, PDF_W, 16).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('ℹ  Interne Übersicht – keine Rechnung. Nur Barzahlungen; Stripe-Gebühren wurden bereits beim Checkout einbehalten.', PDF_M+6, hy+4, { width:PDF_W-12 });
  doc.y = hy + 16 + 6;
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const th = doc.y;
  doc.rect(PDF_M, th, PDF_W, 16).fill('#1a1a2e');
  [['#', PDF_M+2, 34, 'left'], ['Datum', PDF_M+38, 40, 'left'], ['Kunde', PDF_M+80, 170, 'left'],
   ['Umsatz', PDF_M+252, 64, 'right'], ['Servicegebühr', PDF_M+318, 118, 'right'], ['Gesamt', PDF_M+2, PDF_W-4, 'right']
  ].forEach(([h, x, w, a]) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff').text(h, x, th+4, { width:w, align:a }));
  doc.y = th + 16;
  barOrders.forEach((o, i) => {
    if (doc.y > PDF_FT - 20) { doc.addPage(); doc.y = PDF_M; }
    const sf   = o.serviceFee || PDF_SV;
    const date = new Date(o.createdAt).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' }) + '.';
    const name = `${o.customer?.first||''} ${o.customer?.last||''}`.trim().substring(0, 24);
    const ry = doc.y;
    if (i % 2 === 0) doc.rect(PDF_M, ry, PDF_W, 16).fill('#f8f9fc');
    doc.font('Helvetica').fontSize(8.5).fillColor('#222')
      .text(`${o.orderNum}`, PDF_M+2,  ry+4, { width:34 })
      .text(date,            PDF_M+38, ry+4, { width:40 })
      .text(name,            PDF_M+80, ry+4, { width:168 })
      .text(pdfFmt(o.total), PDF_M+252, ry+4, { width:64,  align:'right' })
      .text(pdfFmt(sf),      PDF_M+318, ry+4, { width:118, align:'right' });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1a1a2e').text(pdfFmt(sf), PDF_M+2, ry+4, { width:PDF_W-4, align:'right' });
    doc.y = ry + 16;
  });
  doc.moveTo(PDF_M, doc.y).lineTo(PDF_M+PDF_W, doc.y).strokeColor('#333').lineWidth(1).stroke(); doc.y += 4;
  const s1y = doc.y;
  doc.rect(PDF_M, s1y, PDF_W, 18).fill('#f0f4f8');
  doc.font('Helvetica').fontSize(9).fillColor('#333').text('Servicegebühren', PDF_M+8, s1y+5).text(`${barOrders.length} × ${pdfFmt(PDF_SV)}`, PDF_M+200, s1y+5, { width:140, align:'right' });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text(pdfFmt(barStats.barSvc), PDF_M+2, s1y+5, { width:PDF_W-4, align:'right' });
  doc.y = s1y + 18 + 4;
  const gy = doc.y;
  doc.rect(PDF_M, gy, PDF_W, 30).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('Summe Servicegebühren (Bar)', PDF_M+10, gy+9, { width:PDF_W*0.6 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffd700').text(pdfFmt(barStats.barBetrag), PDF_M+2, gy+8, { width:PDF_W-4, align:'right' });
  doc.y = gy + 30 + 8;
  const uy = doc.y;
  doc.rect(PDF_M, uy, PDF_W, 14).fill('#fef9e7');
  doc.font('Helvetica').fontSize(7.5).fillColor('#7a5c00').text('Grundlage für die separate Gebühren-Rechnung (Lexware) – dieses Dokument ist keine Rechnung.', PDF_M+6, uy+3, { width:PDF_W-12 });
  doc.y = uy + 14;
}


// TAGESBERICHT (täglich um 22:00 Uhr)
cron.schedule('0 22 * * *', async () => {
  try {
    const now   = new Date();
    const start = new Date(now); start.setHours(0,0,0,0);
    const end   = new Date(now); end.setHours(23,59,59,999);
    const label = now.toLocaleDateString('de-DE', { weekday:'long', day:'2-digit', month:'2-digit', year:'numeric' });

    const orders = await Order.find({
      createdAt: { $gte: start, $lte: end },
      status: { $nin: ['cancelled','awaiting_payment'] }
    }).sort({ orderNum: 1 });

    if (orders.length === 0) {
      console.log('[Tagesbericht] Keine Bestellungen heute – kein PDF versendet.');
      return;
    }

    const total       = orders.reduce((s,o) => s + (o.total||0), 0);
    const totalBar    = orders.filter(o=>o.payment==='bar').reduce((s,o)=>s+(o.total||0),0);
    const totalStripe = orders.filter(o=>o.payment==='stripe').reduce((s,o)=>s+(o.total||0),0);
    const totalPayPal = orders.filter(o=>o.payment==='paypal').reduce((s,o)=>s+(o.total||0),0);
    const nLief       = orders.filter(o=>o.mode==='lieferung').length;
    const nAbh        = orders.filter(o=>o.mode==='abholung').length;

    const tagespdf = await generatePdf(doc => {
      const W = 495;
      const fmt = n => n.toFixed(2).replace('.',',')+' €';

      // Header
      doc.rect(0,0,595,70).fill('#d32027');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff').text('Tagesbericht', 50, 16);
      doc.fontSize(10).font('Helvetica').fillColor('rgba(255,255,255,0.8)')
        .text(`Pizzeria La Scala  ·  ${label}`, 50, 44);

      doc.moveDown(3.5);

      // Zusammenfassung
      const sumRows = [
        ['Bestellungen gesamt', `${orders.length}`, false],
        ['davon Lieferung', `${nLief}`, true],
        ['davon Abholung', `${nAbh}`, false],
        ['Umsatz Barzahlung', fmt(totalBar), true],
        ['Umsatz Kreditkarte (Stripe)', fmt(totalStripe), false],
        ['Umsatz PayPal', fmt(totalPayPal), true],
      ];
      sumRows.forEach(([label, val, shade]) => {
        const y = doc.y;
        if (shade) doc.rect(50,y,W,26).fill('#f5f5f5');
        doc.font('Helvetica').fontSize(11).fillColor('#222').text(label, 58, y+7);
        doc.text(val, 50, y+7, { width: W-8, align:'right' });
        doc.y = y+26;
      });

      // Gesamtumsatz
      const ty = doc.y;
      doc.rect(50,ty,W,36).fill('#d32027');
      doc.font('Helvetica-Bold').fontSize(14).fillColor('#fff')
        .text('GESAMTUMSATZ', 58, ty+11);
      doc.text(fmt(total), 50, ty+11, { width:W-8, align:'right' });
      doc.y = ty+50;

      doc.moveDown(1);

      // Bestelldetails
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#d32027').text('Alle Bestellungen');
      doc.moveDown(0.4);

      orders.forEach((o, i) => {
        if (doc.y > 730) doc.addPage();
        const rowY = doc.y;
        const shade = i % 2 === 0;
        if (shade) doc.rect(50,rowY,W,0).fill('#f9f9f9');

        const kunde    = `${o.customer?.first||''} ${o.customer?.last||''}`.trim() || '–';
        const telefon  = o.customer?.phone || '–';
        const email    = o.customer?.email || '–';
        const adresse  = o.mode==='lieferung'
          ? `${o.customer?.street||''} ${o.customer?.house||''}, ${o.customer?.city||''}`.trim()
          : 'Abholung';
        const zahlung  = o.payment==='stripe'?'Kreditkarte':o.payment==='karte'?'EC-Karte':'Bar';
        const bezahlt  = o.paymentStatus==='paid'?'✓ Bezahlt':'✗ Offen';
        const items    = (o.items||[]).map(it=>{
          const extras = (it.extraDetails||[]).map(e=>e.name).filter(Boolean).join(', ');
          return `${it.qty}× ${cleanName(it.name)}${extras?' ['+extras+']':''}${it.note?' ('+it.note+')':''}`;
        }).join(', ');

        // Trennlinie
        doc.rect(50, rowY, W, 0.5).fill('#e0e0e0');

        doc.font('Helvetica-Bold').fontSize(10).fillColor('#d32027')
          .text(`#${o.orderNum}  ${new Date(o.createdAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}  ${o.mode==='lieferung'?'LIEFERUNG':'ABHOLUNG'}`, 50, rowY+6, { width: W/2 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#222')
          .text(fmt(o.total||0), 50, rowY+6, { width:W, align:'right' });

        doc.font('Helvetica').fontSize(9).fillColor('#333')
          .text(`Kunde: ${kunde}  |  Tel: ${telefon}  |  ${email}`, 50, rowY+20, { width: W });
        doc.text(`Adresse: ${adresse}  |  Zahlung: ${zahlung}  |  ${bezahlt}`, 50, rowY+32, { width: W });
        doc.text(`Artikel: ${items}`, 50, rowY+44, { width: W });

        doc.y = rowY + 60;
      });

      // Footer
      doc.fontSize(8).fillColor('#aaa')
        .text(`Pizzeria La Scala  ·  Tagesbericht ${label}  ·  Erstellt: ${now.toLocaleTimeString('de-DE')}`, 50, 790, { width: W, align:'center' });
    });

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📋 Tagesbericht ${label} · Pizzeria La Scala`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
          <div style="background:#d32027;padding:22px 28px;color:#fff">
            <h2 style="margin:0;font-size:20px">Tagesbericht</h2>
            <p style="margin:4px 0 0;opacity:.8;font-size:13px">${label}</p>
          </div>
          <div style="padding:24px 28px">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
              <tr><td style="padding:8px">davon Lieferung</td><td style="padding:8px;text-align:right">${nLief}</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">davon Abholung</td><td style="padding:8px;text-align:right">${nAbh}</td></tr>
              <tr><td style="padding:8px">Umsatz Barzahlung</td><td style="padding:8px;text-align:right">${totalBar.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#f5f5f5"><td style="padding:8px">Umsatz Kreditkarte (Stripe)</td><td style="padding:8px;text-align:right">${totalStripe.toFixed(2).replace('.',',')} €</td></tr>
              <tr><td style="padding:8px">Umsatz PayPal</td><td style="padding:8px;text-align:right">${totalPayPal.toFixed(2).replace('.',',')} €</td></tr>
              <tr style="background:#d32027"><td style="padding:10px;font-weight:bold;color:#fff;font-size:15px">Gesamtumsatz</td><td style="padding:10px;text-align:right;font-weight:bold;color:#fff;font-size:15px">${total.toFixed(2).replace('.',',')} €</td></tr>
            </table>
            <p style="font-size:12px;color:#888;margin-top:12px">Die vollständige Bestellliste mit Kundendaten finden Sie im beigefügten PDF.</p>
          </div>
        </div>`,
        attachments: [{ filename: `Tagesbericht_${now.toISOString().slice(0,10)}.pdf`, content: tagespdf.toString('base64') }]
      });
    }
    console.log(`📋 Tagesbericht versendet: ${orders.length} Bestellungen, ${total.toFixed(2)} €`);
  } catch(e) { console.error('Tagesbericht Fehler:', e); }
});

// Baut das Wochenbericht-PDF. Einzige Quelle fuer das Layout.
function buildWochenberichtPdf(doc, d) {
  const { kw, jahr, vonBis, orders, brutto, svcFees, auszahlung,
          barOrders, barSvc, barNetto, barBetrag } = d;

  pdfColorBox(doc, `Wochenbericht KW ${kw} / ${jahr}`, `Pizzeria La Scala  ·  ${vonBis}`, '#d32027');
  pdfKacheln(doc, [
    ['Bestellungen gesamt', `${orders.length}`,                                                   '#1a1a2e'],
    ['Davon Bar',           `${barOrders.length}`,                                                '#2c5282'],
    ['Davon Online',        `${orders.filter(o=>['stripe','paypal'].includes(o.payment)).length}`,'#276749'],
    ['Brutto-Umsatz',       pdfFmt(brutto),                                                       '#744210'],
  ]);
  doc.moveDown(0.4);
  pdfHr(doc);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
  doc.y += 14;
  pdfTableRow(doc, [[`Servicegebühren  (${pdfFmt(PDF_SV)} × ${orders.length})`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees), PDF_M+2, PDF_W-4, 'right']], false, true);
  doc.y += 4;
  const ay = doc.y;
  doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria La Scala', PDF_M+10, ay+8, { width: PDF_W*0.65 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
  doc.y = ay + 28 + 12;
  pdfHr(doc, '#bbb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
  doc.y += 12;
  pdfKundenliste(doc, orders);
  if (barOrders.length > 0) {
    pdfBarRechnung(doc, barOrders, { barSvc, barNetto, barBetrag }, vonBis);
  }
  doc.font('Helvetica').fontSize(7).fillColor('#bbb')
    .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Wochenbericht KW ${kw} / ${jahr}`, PDF_M, 820, { width: PDF_W, align: 'center' });
}

// Baut und versendet den Wochenbericht fuer die Woche, die auf `now` endet.
// Einzige Quelle - der Sonntags-Cron und POST /api/admin/send-weekly rufen
// beide hier rein. Fehler werden bewusst nicht gefangen: der Cron loggt sie,
// der Endpunkt macht daraus einen 500er.
//
// nurOwner=true laesst die Mail an das Restaurant aus - fuer Probelaeufe.
// Bewusst ein Parameter und nicht das Leeren von RESTAURANT_EMAIL: an der
// Variablen haengt auch die Benachrichtigung bei jeder eingehenden
// Bestellung, die dabei mit ausfallen wuerde.
async function wochenberichtVersenden(now, { nurOwner = false } = {}) {
  const wStart   = new Date(now); wStart.setDate(now.getDate()-6); wStart.setHours(0,0,0,0);
  const wEnd     = new Date(now); wEnd.setHours(23,59,59,999);
  const kw       = getWeekNum(now);
  const datum    = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
  const vonBis   = `${wStart.toLocaleDateString('de-DE')} – ${datum}`;

  const orders = await Order.find({
    status: { $in: ['confirmed','preparing','ready','delivered'] },
    createdAt: { $gte: wStart, $lte: wEnd }
  });

  const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
  const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const auszahlung = brutto - svcFees;
  const barOrders  = orders.filter(o => o.payment === 'bar');
  const barSvc     = barOrders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
  const barNetto   = barOrders.reduce((s,o) => s+(o.total||0), 0) - barSvc;
  const barBetrag  = barSvc;

  const berichtPdf = await generatePdf(doc => buildWochenberichtPdf(doc, {
    kw, jahr: now.getFullYear(), vonBis, orders, brutto, svcFees, auszahlung,
    barOrders, barSvc, barNetto, barBetrag,
  }));

  // Wer wirklich eine Mail bekommen hat. Fehlt der Resend-Key oder eine
  // Adresse, wird still uebersprungen - ohne dieses Protokoll meldet der
  // Endpunkt einen Erfolg, dem gar kein Versand entspricht.
  const resend   = getResend();
  const versandt = [];

  // ── E-Mail 1: Restaurant bekommt Wochenbericht als PDF-Anhang ────────
  if (resend && process.env.RESTAURANT_EMAIL && !nurOwner) {
    const antwort = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
      to: process.env.RESTAURANT_EMAIL,
      subject: `📊 Wochenbericht KW ${kw} / ${now.getFullYear()} · Pizzeria La Scala`,
      html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
<div style="background:#d32027;padding:24px 28px;color:#fff">
  <h2 style="margin:0;font-size:20px">Wochenbericht KW ${kw} / ${now.getFullYear()}</h2>
  <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
</div>
<div style="padding:24px 28px">
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
    <tr><td style="padding:8px">Gesamtumsatz (Brutto)</td><td style="padding:8px;text-align:right">${brutto.toFixed(2).replace('.',',')} €</td></tr>
    <tr style="background:#f5f5f5"><td style="padding:8px">Servicegebühren (A. R. Falah)</td><td style="padding:8px;text-align:right">− ${svcFees.toFixed(2).replace('.',',')} €</td></tr>
    <tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihr Auszahlungsbetrag</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${auszahlung.toFixed(2).replace('.',',')} €</td></tr>
  </table>
  <p style="font-size:11px;color:#aaa;margin-top:8px">Anbei der Wochenbericht mit Kundenliste${barOrders.length > 0 ? ' und Bar-Übersicht' : ''}.</p>
</div>
</div>`,
      attachments: [{ filename: `KW${kw}_${now.getFullYear()}_La Scala_Wochenbericht.pdf`, content: berichtPdf.toString('base64') }],
    });
    if (antwort?.error) console.error('Resend lehnte die Restaurant-Mail ab:', antwort.error);
    else versandt.push('restaurant');
  }

  // ── E-Mail 2: Owner bekommt den Wochenbericht als Anhang ──────
  if (resend && process.env.OWNER_EMAIL) {
    const antwort = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
      to: process.env.OWNER_EMAIL,
      subject: `📊 Wochenbericht KW ${kw} · Pizzeria La Scala`,
      html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei der Wochenbericht KW ${kw} / ${now.getFullYear()} für Pizzeria La Scala.</p>
             <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Dein Verdienst:</b> ${svcFees.toFixed(2).replace('.',',')} €</p>
             <p style="font-family:Arial,sans-serif;color:#999;font-size:12px">Die Gebühren-Rechnung wird separat über Lexware gestellt.</p>`,
      attachments: [
        { filename: `KW${kw}_${now.getFullYear()}_La Scala_Wochenbericht.pdf`, content: berichtPdf.toString('base64') },
      ],
    });
    if (antwort?.error) console.error('Resend lehnte die Owner-Mail ab:', antwort.error);
    else versandt.push('owner');
  }

  return { kw, jahr: now.getFullYear(), vonBis, anzahl: orders.length,
           brutto, svcFees, auszahlung, berichtPdf, nurOwner, versandt };
}

cron.schedule('0 22 * * 0', async () => {
  try {
    const r = await wochenberichtVersenden(new Date());
    console.log(`📊 Wochenbericht KW ${r.kw} (${r.anzahl} Bestellungen) an: `
              + (r.versandt.join(', ') || 'NIEMANDEN – Resend-Key oder Adressen fehlen'));
  } catch(e) { console.error('Wochenbericht Fehler:', e); }
});

function getWeekNum(d) {
  const dt = new Date(d); dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate()+3-(dt.getDay()+6)%7);
  const w1 = new Date(dt.getFullYear(),0,4);
  return 1+Math.round(((dt-w1)/86400000-3+(w1.getDay()+6)%7)/7);
}

// Baut den kompletten Monatsbericht. Einzige Quelle fuer das Layout -
// Cron und manueller Endpunkt rufen beide hier rein.
function buildMonatsberichtPdf(doc, d) {
  const { monat, vonBis, orders, brutto, svcFees, auszahlung,
          barOrdersM, barSvcM, barNettoM, barBetragM, weekRows } = d;

  pdfColorBox(doc, `Monatsbericht ${monat}`, `Pizzeria La Scala  ·  ${vonBis}`, '#d32027');
  pdfKacheln(doc, [
    ['Bestellungen gesamt', `${orders.length}`,                                                   '#1a1a2e'],
    ['Davon Bar',           `${barOrdersM.length}`,                                               '#2c5282'],
    ['Davon Online',        `${orders.filter(o=>['stripe','paypal'].includes(o.payment)).length}`,'#276749'],
    ['Brutto-Umsatz',       pdfFmt(brutto),                                                       '#744210'],
  ]);
  doc.moveDown(0.4);
  pdfHr(doc);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('ABRECHNUNG', PDF_M, doc.y);
  doc.y += 14;
  pdfTableRow(doc, [[`Servicegebühren  (${pdfFmt(PDF_SV)} × ${orders.length} Bestellungen)`, PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees), PDF_M+2, PDF_W-4, 'right']], false);
  pdfTableRow(doc, [['Grundgebühr (monatlich)', PDF_M+8, PDF_W-80, 'left'], [pdfFmt(PDF_BASE), PDF_M+2, PDF_W-4, 'right']], true);
  pdfTableRow(doc, [['Gesamt FlueVate-Gebühren', PDF_M+8, PDF_W-80, 'left'], [pdfFmt(svcFees + PDF_BASE), PDF_M+2, PDF_W-4, 'right']], false, true);
  doc.y += 4;
  const ay = doc.y;
  doc.rect(PDF_M, ay, PDF_W, 28).fill('#e8f5e9');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#2e7d32').text('Auszahlung an Pizzeria La Scala', PDF_M+10, ay+8, { width: PDF_W*0.65 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#2e7d32').text(pdfFmt(auszahlung), PDF_M+2, ay+8, { width: PDF_W-4, align: 'right' });
  doc.y = ay + 28 + 16;
  pdfHr(doc, '#bbb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('WOCHENÜBERSICHT', PDF_M, doc.y);
  doc.y += 14;
  // Spalte 1 endet bei PDF_M+8+70 = 128, Spalte 2 startet bei PDF_M+90 = 140.
  weekRows.forEach(([kw2, w], i) => {
    pdfTableRow(doc, [
      [`KW ${kw2}`,           PDF_M+8,  70,        'left'],
      [`${w.n} Bestellungen`, PDF_M+90, PDF_W-170, 'left'],
      [pdfFmt(w.brutto),      PDF_M+2,  PDF_W-4,   'right'],
    ], i % 2 === 1);
  });
  doc.y += 8;
  pdfHr(doc, '#bbb');
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e').text('KUNDENLISTE', PDF_M, doc.y);
  doc.y += 12;
  pdfKundenliste(doc, orders);
  if (barOrdersM.length > 0) {
    pdfBarRechnung(doc, barOrdersM, { barSvc: barSvcM, barNetto: barNettoM, barBetrag: barBetragM }, vonBis);
  }
  doc.font('Helvetica').fontSize(7).fillColor('#bbb')
    .text(`FlueVate · Abed Rachman Falah · Zur Goldbrede 30 · 59269 Beckum  ·  Monatsbericht ${monat}`, PDF_M, 820, { width: PDF_W, align: 'center' });
}



// MONATSBERICHT (Cron – täglich 22:00, nur am letzten Tag des Monats)
// ═══════════════════════════════════════════════════════════════════
cron.schedule('0 22 * * *', async () => {
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return; // nur am letzten Tag des Monats

  try {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now); mEnd.setHours(23,59,59,999);
    const monat  = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const datum  = now.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: mStart, $lte: mEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
    const auszahlung = brutto - svcFees;
    const barOrdersM = orders.filter(o => o.payment === 'bar');
    const barSvcM    = barOrdersM.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
    const barNettoM  = barOrdersM.reduce((s,o) => s+(o.total||0), 0) - barSvcM;
    const barBetragM = barSvcM;

    // ── Wochenübersicht berechnen ─────────────────────────────────
    const weeksMap = {};
    orders.forEach(o => {
      const kw2 = getWeekNum(new Date(o.createdAt));
      if (!weeksMap[kw2]) weeksMap[kw2] = { n: 0, brutto: 0 };
      weeksMap[kw2].n++;
      weeksMap[kw2].brutto += o.total || 0;
    });
    const weekRows = Object.entries(weeksMap).sort((a, b) => +a[0] - +b[0]);

    // ── PDF: Monatsbericht (Kennzahlen + Kundenliste + Bar-Übersicht) ─────
    const monatsPdf = await generatePdf(doc => buildMonatsberichtPdf(doc, {
      monat, vonBis, orders, brutto, svcFees, auszahlung,
      barOrdersM, barSvcM, barNettoM, barBetragM, weekRows,
    }));

    // ── E-Mail: Restaurant ────────────────────────────────────────────────
    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
        to:   process.env.RESTAURANT_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria La Scala`,
        html: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#222">
  <div style="background:#d32027;padding:24px 28px;color:#fff">
    <h2 style="margin:0;font-size:20px">Monatsbericht ${monat}</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${vonBis}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#f5f5f5"><td style="padding:8px">Bestellungen gesamt</td><td style="padding:8px;text-align:right"><b>${orders.length}</b></td></tr>
      <tr><td style="padding:8px">Gesamtumsatz (Brutto)</td><td style="padding:8px;text-align:right">${brutto.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#f5f5f5"><td style="padding:8px">Servicegebühren (A. R. Falah)</td><td style="padding:8px;text-align:right">− ${svcFees.toFixed(2).replace('.',',')} €</td></tr>
      <tr style="background:#e8f5e9"><td style="padding:10px;font-weight:bold;color:#2e7d32;font-size:15px">Ihr Auszahlungsbetrag</td><td style="padding:10px;text-align:right;font-weight:bold;color:#2e7d32;font-size:15px">${auszahlung.toFixed(2).replace('.',',')} €</td></tr>
    </table>
    <p style="font-size:11px;color:#aaa;margin-top:8px">Anbei der Monatsbericht mit Kundenliste${barOrdersM.length > 0 ? ' und Bar-Übersicht' : ''}.</p>
  </div>
</div>`,
        attachments: [{ filename: `${monat.replace(' ','_')}_La Scala_Monatsbericht.pdf`, content: monatsPdf.toString('base64') }],
      });
    }

    // ── E-Mail: Owner ─────────────────────────────────────────────────────
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
        to: process.env.OWNER_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria La Scala`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Anbei der Monatsbericht <b>${monat}</b> für Pizzeria La Scala.</p>
               <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Grundgebühr:</b> ${PDF_BASE.toFixed(2).replace('.',',')} €<br><b>Servicegebühren:</b> ${svcFees.toFixed(2).replace('.',',')} €<br><b>Gesamt-Gebühren:</b> ${(svcFees + PDF_BASE).toFixed(2).replace('.',',')} €${barOrdersM.length > 0 ? `<br><b>davon Bar:</b> ${barBetragM.toFixed(2).replace('.',',')} € (${barOrdersM.length} Barzahlungen)` : ''}</p>
               <p style="font-family:Arial,sans-serif;color:#999;font-size:12px">Die Gebühren-Rechnung wird separat über Lexware gestellt.</p>`,
        attachments: [
          { filename: `${monat.replace(' ','_')}_La Scala_Monatsbericht.pdf`, content: monatsPdf.toString('base64') },
        ],
      });
    }
    console.log(`📅 Monatsbericht ${monat} versendet`);
  } catch(e) { console.error('Monatsbericht Fehler:', e); }
});

// ── Wochenbericht manuell triggern ───────────────────────────────
// POST /api/admin/send-weekly?date=2026-09-13  (oder leer = laufende Woche)
// date ist der Endtag der Woche; der Bericht deckt die 7 Tage davor ab.
// only=owner verschickt nur an OWNER_EMAIL, das Restaurant bleibt aussen vor.
app.post('/api/admin/send-weekly', auth, async (req, res) => {
  try {
    const p = req.query.date;
    const now = p ? new Date(`${p}T22:00:00`) : new Date();
    if (isNaN(now.getTime())) return res.status(400).json({ message: 'date muss YYYY-MM-TT sein' });
    const nurOwner = req.query.only === 'owner';
    const r = await wochenberichtVersenden(now, { nurOwner });
    console.log(`📊 Wochenbericht KW ${r.kw} manuell versendet (${r.anzahl} Bestellungen)`
              + (nurOwner ? ' – nur an Owner' : ''));
    res.json({
      success: true, kw: r.kw, jahr: r.jahr, zeitraum: r.vonBis, orders: r.anzahl,
      empfaenger: r.versandt,
      // Nur Ja/Nein, nie die Werte selbst - sagt genau, welche Variable fehlt.
      konfig: {
        RESEND_API_KEY:   !!process.env.RESEND_API_KEY,
        EMAIL_FROM:       !!process.env.EMAIL_FROM,
        OWNER_EMAIL:      !!process.env.OWNER_EMAIL,
        RESTAURANT_EMAIL: !!process.env.RESTAURANT_EMAIL,
      },
      warnung: r.versandt.length ? undefined
             : 'Es wurde nichts verschickt. Siehe konfig: was auf false steht, fehlt in Render.',
      berichtPdfBase64: r.berichtPdf.toString('base64'),
    });
  } catch(e) {
    console.error('Wochenbericht manuell Fehler:', e);
    res.status(500).json({ message: e.message });
  }
});

// ── Monatsbericht manuell triggern ───────────────────────────────
// POST /api/admin/send-monthly?month=2026-05  (oder leer = aktueller Monat)
app.post('/api/admin/send-monthly', auth, async (req, res) => {
  try {
    const monthParam = req.query.month; // z.B. "2026-05"
    let refDate;
    if (monthParam) {
      const [y, m] = monthParam.split('-').map(Number);
      refDate = new Date(y, m - 1, 28, 22, 0, 0); // letzter Tag des Monats
    } else {
      refDate = new Date();
    }
    const now    = refDate;
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const mEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const monat  = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const datum  = mEnd.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const vonBis = `${mStart.toLocaleDateString('de-DE')} – ${datum}`;

    const orders = await Order.find({
      status: { $in: ['confirmed','preparing','ready','delivered'] },
      createdAt: { $gte: mStart, $lte: mEnd }
    });

    const brutto     = orders.reduce((s,o) => s+(o.total||0), 0);
    const svcFees    = orders.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
    const auszahlung = brutto - svcFees;
    const barOrdersM = orders.filter(o => o.payment === 'bar');
    const barSvcM    = barOrdersM.reduce((s,o) => s+(o.serviceFee||PDF_SV), 0);
    const barNettoM  = barOrdersM.reduce((s,o) => s+(o.total||0), 0) - barSvcM;
    const barBetragM = barSvcM;
    const weeksMap = {};
    orders.forEach(o => { const kw2=getWeekNum(new Date(o.createdAt)); if(!weeksMap[kw2])weeksMap[kw2]={n:0,brutto:0}; weeksMap[kw2].n++; weeksMap[kw2].brutto+=o.total||0; });
    const weekRows = Object.entries(weeksMap).sort((a,b)=>+a[0]-+b[0]);

    const monatsPdf = await generatePdf(doc => buildMonatsberichtPdf(doc, {
      monat, vonBis, orders, brutto, svcFees, auszahlung,
      barOrdersM, barSvcM, barNettoM, barBetragM, weekRows,
    }));

    if (process.env.RESTAURANT_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
        to: process.env.RESTAURANT_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria La Scala`,
        html: `<p style="font-family:Arial,sans-serif">Manuell ausgelöster Monatsbericht für <b>${monat}</b>.<br>${orders.length} Bestellungen · Auszahlung: ${auszahlung.toFixed(2).replace('.',',')} €</p>`,
        attachments: [{ filename: `${monat.replace(' ','_')}_La Scala_Monatsbericht.pdf`, content: monatsPdf.toString('base64') }],
      });
    }
    if (process.env.OWNER_EMAIL) {
      await getResend()?.emails.send({
        from: process.env.EMAIL_FROM || 'system@pizzerialascala.de',
        to: process.env.OWNER_EMAIL,
        subject: `📅 Monatsbericht ${monat} · Pizzeria La Scala`,
        html: `<p style="font-family:Arial,sans-serif;color:#555">Manuell ausgelöst: Monatsbericht <b>${monat}</b>.</p>
               <p style="font-family:Arial,sans-serif;color:#555"><b>Zeitraum:</b> ${vonBis}<br><b>Grundgebühr:</b> ${PDF_BASE.toFixed(2).replace('.',',')} €<br><b>Servicegebühren:</b> ${svcFees.toFixed(2).replace('.',',')} €<br><b>Gesamt-Gebühren:</b> ${(svcFees + PDF_BASE).toFixed(2).replace('.',',')} €${barOrdersM.length > 0 ? `<br><b>davon Bar:</b> ${barBetragM.toFixed(2).replace('.',',')} € (${barOrdersM.length} Barzahlungen)` : ''}</p>
               <p style="font-family:Arial,sans-serif;color:#999;font-size:12px">Die Gebühren-Rechnung wird separat über Lexware gestellt.</p>`,
        attachments: [
          { filename: `${monat.replace(' ','_')}_La Scala_Monatsbericht.pdf`, content: monatsPdf.toString('base64') },
        ],
      });
    }
    console.log(`📅 Monatsbericht ${monat} manuell versendet (${orders.length} Bestellungen)`);
    res.json({
      success: true, monat, orders: orders.length,
      monatsPdfBase64: monatsPdf.toString('base64'),
    });
  } catch(e) {
    console.error('Monatsbericht manuell Fehler:', e);
    res.status(500).json({ message: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
// HISTORIE & AUSWERTUNG  (für die Fluevate-Kasse-App)
// ═══════════════════════════════════════════════════════════════
// GET /api/admin/history?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Liefert Kennzahlen, Tageswerte UND die Bestellungen eines Zeitraums in einer Antwort.
// /api/admin/finance kennt nur "heute" und "diese Woche" – für Monatsumsatz und
// Bestellhistorie reicht das nicht.
//
// Zeitzone: die Tagesgrenzen richten sich nach Europe/Berlin, nicht nach UTC. Sonst
// landen Bestellungen zwischen 22:00 und 24:00 im falschen Tag.
app.get('/api/admin/history', auth, async (req, res) => {
  try {
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const berlinDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

    const from = isDate(req.query.from) ? req.query.from : berlinDay(new Date());
    const to   = isDate(req.query.to)   ? req.query.to   : from;
    if (to < from) return res.status(400).json({ message: 'Zeitraum ist verdreht' });

    // Grosszuegiges UTC-Fenster laden und danach exakt nach Berliner Tagen filtern –
    // das ist auch bei der Sommerzeitumstellung korrekt.
    const padFrom = new Date(from + 'T00:00:00Z'); padFrom.setUTCDate(padFrom.getUTCDate() - 1);
    const padTo   = new Date(to   + 'T23:59:59Z'); padTo.setUTCDate(padTo.getUTCDate() + 1);

    const raw = await Order.find({
      status:    { $nin: ['awaiting_payment'] },
      createdAt: { $gte: padFrom, $lte: padTo }
    }).sort({ createdAt: -1 }).limit(3000);

    const all = raw.filter(o => {
      const k = berlinDay(o.createdAt);
      return k >= from && k <= to;
    });

    // Stornierte Bestellungen zaehlen nicht zum Umsatz, aber sehr wohl zur Statistik.
    const valid = all.filter(o => o.status !== 'cancelled');
    const r2  = n => Math.round((n + Number.EPSILON) * 100) / 100;
    const sum = pick => valid.reduce((s, o) => s + (pick(o) || 0), 0);

    const brutto  = sum(o => o.total);
    const svcFees = sum(o => o.serviceFee);

    const byPayment = {};
    const byPaymentRevenue = {};
    valid.forEach(o => {
      const k = o.payment || 'unbekannt';
      byPayment[k] = (byPayment[k] || 0) + 1;
      byPaymentRevenue[k] = r2((byPaymentRevenue[k] || 0) + (o.total || 0));
    });

    const days = {};
    valid.forEach(o => {
      const k = berlinDay(o.createdAt);
      if (!days[k]) days[k] = { date: k, count: 0, brutto: 0 };
      days[k].count  += 1;
      days[k].brutto += (o.total || 0);
    });

    res.json({
      from, to,
      stats: {
        count:        valid.length,
        brutto:       r2(brutto),
        svcFees:      r2(svcFees),
        deliveryFees: r2(sum(o => o.deliveryFee)),
        auszahlung:   r2(brutto - svcFees),
        cancelled:    all.length - valid.length,
        unpaid:       valid.filter(o => o.paymentStatus !== 'paid').length,
        byPayment,
        byPaymentRevenue
      },
      byDay: Object.values(days)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(d => ({ date: d.date, count: d.count, brutto: r2(d.brutto) })),
      // Begrenzt, damit die Antwort auf einem Kassengeraet handhabbar bleibt.
      orders: all.slice(0, 500)
    });
  } catch (e) {
    console.error('history:', e);
    res.status(500).json({ message: 'Fehler' });
  }
});


app.listen(PORT, () => console.log(`🍕 Pizzeria La Scala Backend · Port ${PORT}`));
