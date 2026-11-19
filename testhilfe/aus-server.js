// Holt einzelne oberste Definitionen (function NAME / const NAME =) als Quelltext aus
// server.js, ohne server.js zu laden (das verbindet sich mit der Datenbank und startet
// Crons). Fuer Tests reiner Rechen- und Textfunktionen, die in server.js stehen.
'use strict';
const fs = require('fs');
const path = require('path');

// Ende einer Anweisung ab Position i: Funktionsdeklaration bis zur passenden }, sonst bis
// zum ; auf oberster Ebene. Beachtet Zeichenketten, Template-Literale und Kommentare.
function ende(src, i, bisSemikolon) {
  const stapel = [];
  for (; i < src.length; i++) {
    const c = src[i], oben = stapel[stapel.length - 1];
    if (oben === '"' || oben === "'") { if (c === '\\') i++; else if (c === oben) stapel.pop(); continue; }
    if (oben === '`') {
      if (c === '\\') i++;
      else if (c === '`') stapel.pop();
      else if (c === '$' && src[i + 1] === '{') { stapel.push('${'); i++; }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { stapel.push(c); continue; }
    if (c === '{' || c === '(' || c === '[') { stapel.push(c); continue; }
    if (c === '}' || c === ')' || c === ']') {
      stapel.pop();
      if (c === '}' && !bisSemikolon && stapel.length === 0) return i + 1;
      continue;
    }
    if (c === ';' && bisSemikolon && stapel.length === 0) return i + 1;
  }
  throw new Error('Ende nicht gefunden');
}

function definition(src, name) {
  const f = src.match(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (f) return src.slice(f.index, ende(src, f.index + f[0].length - 1, false));
  const k = src.match(new RegExp(`^const ${name} *=`, 'm'));
  if (k) return src.slice(k.index, ende(src, k.index, true));
  throw new Error(`${name} nicht in server.js gefunden`);
}

// Liefert { name: wert } fuer die genannten Definitionen, in dieser Reihenfolge
// ausgewertet (spaetere duerfen fruehere benutzen). quelle: anderer Quelltext statt server.js.
function ausServer(namen, quelle) {
  const src = quelle || fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const code = namen.map(n => definition(src, n)).join('\n');
  return new Function(`${code}\nreturn { ${namen.join(', ')} };`)();
}

module.exports = { ausServer, definition };
