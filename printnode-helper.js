// PrintNode ESC/POS Bondrucker Helper
// Druckt automatisch bei jeder neuen Bestellung

const fetch = require('node-fetch');

async function printOrder(order) {
  if (!process.env.PRINTNODE_API_KEY || !process.env.PRINTNODE_PRINTER_ID) {
    console.log('PrintNode nicht konfiguriert – überspringe Druck');
    return;
  }

  const content = buildReceipt(order);
  const base64Content = Buffer.from(content).toString('base64');

  const response = await fetch('https://api.printnode.com/printjobs', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      printer: parseInt(process.env.PRINTNODE_PRINTER_ID),
      title: `Pizzeria La Scala Bestellung #${order.orderNum}`,
      contentType: 'raw_base64',
      content: base64Content,
      source: 'Pizzeria La Scala Backend'
    })
  });

  if (response.ok) {
    console.log(`🖨️ Bon gedruckt: Bestellung #${order.orderNum}`);
  } else {
    const err = await response.text();
    console.error('PrintNode Fehler:', err);
  }
}

function buildReceipt(order) {
  const ESC = '\x1B';
  const GS  = '\x1D';

  // ESC/POS Commands
  const RESET        = ESC + '@';
  const BOLD_ON      = ESC + 'E\x01';
  const BOLD_OFF     = ESC + 'E\x00';
  const CENTER       = ESC + 'a\x01';
  const LEFT         = ESC + 'a\x00';
  const DOUBLE_ON    = GS  + '!\x11';
  const DOUBLE_OFF   = GS  + '!\x00';
  const CUT          = GS  + 'V\x41\x03';
  const LF           = '\n';

  const SEPARATOR = '--------------------------------' + LF;

  const time = new Date(order.createdAt).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  let receipt = RESET;

  // Header
  receipt += CENTER;
  receipt += DOUBLE_ON + BOLD_ON + 'LA SCALA' + LF + DOUBLE_OFF + BOLD_OFF;
  receipt += 'Ludgeristraße 62 · 59379 Selm' + LF;
  receipt += 'Tel: 0 25 92 / 9 78 93 30' + LF;
  receipt += SEPARATOR;

  // Bestellnummer + Zeit
  receipt += BOLD_ON + `BESTELLUNG #${order.orderNum}` + BOLD_OFF + LF;
  receipt += time + LF;
  receipt += SEPARATOR;

  // Art
  const modeText = order.mode === 'lieferung' ? '*** LIEFERUNG ***' : '*** ABHOLUNG ***';
  receipt += BOLD_ON + CENTER + modeText + LF + BOLD_OFF;
  receipt += LEFT;

  // Kundeninfos
  receipt += `Kunde: ${order.customer?.first || ''} ${order.customer?.last || ''}` + LF;
  if (order.customer?.phone) receipt += `Tel: ${order.customer.phone}` + LF;
  if (order.mode === 'lieferung' && order.customer?.street) {
    receipt += `Adresse: ${order.customer.street} ${order.customer.house}` + LF;
    receipt += `         ${order.customer.city}` + LF;
  }
  receipt += SEPARATOR;

  // Artikel
  (order.items || []).forEach(item => {
    const name = item.name.substring(0, 22);
    const price = (item.price === 0) ? 'GRATIS' : (item.price * item.qty).toFixed(2).replace('.', ',') + ' EUR';
    const line = `${item.qty}x ${name}`;
    const spaces = 32 - line.length - price.length;
    receipt += BOLD_ON + line + ' '.repeat(Math.max(1, spaces)) + price + LF + BOLD_OFF;
    if (item.note) receipt += `   -> ${item.note}` + LF;
  });

  receipt += SEPARATOR;

  // Preise
  if (order.subtotal) {
    receipt += padLine('Zwischensumme:', order.subtotal.toFixed(2).replace('.', ',') + ' EUR') + LF;
  }
  if (order.deliveryFee && order.deliveryFee > 0) {
    receipt += padLine('Liefergebuehr:', order.deliveryFee.toFixed(2).replace('.', ',') + ' EUR') + LF;
  }
  if (order.serviceFee && order.serviceFee > 0) {
    receipt += padLine('Servicegebuehr:', order.serviceFee.toFixed(2).replace('.', ',') + ' EUR') + LF;
  }
  receipt += SEPARATOR;
  receipt += BOLD_ON + DOUBLE_ON;
  receipt += padLine('GESAMT:', (order.total || 0).toFixed(2).replace('.', ',') + ' EUR') + LF;
  receipt += DOUBLE_OFF + BOLD_OFF;
  receipt += SEPARATOR;

  // Zahlung
  const payText = order.payment === 'bar'
    ? 'Barzahlung'
    : order.payment === 'stripe' ? 'Kreditkarte (Stripe)' : 'EC-Karte';
  receipt += `Zahlung: ${payText}` + LF;
  receipt += `Bezahlt: ${order.paymentStatus === 'paid' ? 'JA' : 'NEIN – bitte kassieren!'}` + LF;

  // Anmerkung
  if (order.note) {
    receipt += SEPARATOR;
    receipt += BOLD_ON + 'ANMERKUNG:' + BOLD_OFF + LF;
    receipt += order.note + LF;
  }

  receipt += SEPARATOR;
  receipt += CENTER + 'Vielen Dank!' + LF;
  receipt += '~35 Min Lieferzeit' + LF;
  receipt += LF + LF + LF;
  receipt += CUT;

  return receipt;
}

function padLine(label, value) {
  const total = 32;
  const spaces = total - label.length - value.length;
  return label + ' '.repeat(Math.max(1, spaces)) + value;
}

module.exports = { printOrder };
