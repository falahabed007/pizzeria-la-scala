// Startet server.js in einem Kindprozess mit der Datenbank-Attrappe (db-attrappe.js),
// ohne .env-Werte von aussen, mit gesperrtem fetch. Fuer Routentests ohne Datenbank.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WURZEL = path.join(__dirname, '..');
const ATTRAPPE = path.join(__dirname, 'db-attrappe.js');

// daten: { Order: [...], User: [...] }; env: zusaetzliche Variablen; skript: Pfad zu server.js
async function starteServer({ daten = {}, env = {}, skript = path.join(WURZEL, 'server.js') } = {}) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-probe-'));
  const datei = path.join(ordner, 'daten.json');
  fs.writeFileSync(datei, JSON.stringify(daten));
  const port = 41000 + Math.floor(Math.random() * 15000);
  // Nur das Noetigste aus der Umgebung - keine Schluessel, keine Datenbank.
  const umgebung = { PATH: process.env.PATH, HOME: ordner, TZ: process.env.TZ || 'Europe/Berlin',
                     PORT: String(port), DB_ATTRAPPE: datei, ADMIN_TOKEN_SECRET: 'probe', ...env };
  // dotenv liest .env aus dem Arbeitsverzeichnis: deshalb im leeren Ordner starten
  const kind = spawn(process.execPath, ['-r', ATTRAPPE, skript], { cwd: ordner, env: umgebung,
                                                                   stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  kind.stdout.on('data', d => { log += d; });
  kind.stderr.on('data', d => { log += d; });
  await new Promise((ja, nein) => {
    const t = setTimeout(() => nein(new Error('Server startet nicht:\n' + log)), 15000);
    const pruefen = () => { if (log.includes(`Port ${port}`)) { clearTimeout(t); ja(); } };
    kind.stdout.on('data', pruefen);
    kind.on('exit', c => { clearTimeout(t); nein(new Error(`Server beendet (${c}):\n${log}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    get log() { return log; },
    async holen(pfad, { admin = true, ...optionen } = {}) {
      const r = await fetch(url + pfad, { ...optionen,
        headers: { ...(admin ? { Authorization: 'Bearer probe' } : {}), 'Content-Type': 'application/json', ...(optionen.headers || {}) } });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* kein JSON */ }
      return { status: r.status, json, text };
    },
    stop() {
      kind.removeAllListeners('exit');
      kind.kill('SIGKILL');
      fs.rmSync(ordner, { recursive: true, force: true });
    },
  };
}

module.exports = { starteServer, WURZEL };
