import PDFDocument from 'pdfkit';
import { money, prettyDate, fmtQty } from './invoice.js';

const INK = '#1F2933';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const PAGE = { margin: 50, width: 595.28, height: 841.89 }; // A4

let logoCache = { url: '', buf: null };

async function loadLogo(url, fetchImpl) {
  if (!url) return null;
  if (logoCache.url === url) return logoCache.buf;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(String(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    logoCache = { url, buf };
    return buf;
  } catch (err) {
    console.warn('Logo could not be loaded, continuing without it:', err.message);
    logoCache = { url, buf: null };
    return null;
  }
}

export async function renderInvoicePdf(inv, business, { fetchImpl = globalThis.fetch } = {}) {
  const logo = await loadLogo(business.logoUrl, fetchImpl);
  const accent = business.accentColor || '#0F4C5C';

  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE.margin,
    bufferPages: true,
    info: { Title: `Invoice ${inv.number}`, Author: business.name },
  });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const L = PAGE.margin;
  const R = PAGE.width - PAGE.margin;
  const W = R - L;

  // Accent band
  doc.rect(0, 0, PAGE.width, 8).fill(accent);

  // ---- Header: business (left), invoice title (right)
  let y = 40;
  let textX = L;
  if (logo) {
    try {
      doc.image(logo, L, y, { fit: [70, 70] });
      textX = L + 82;
    } catch {
      /* unsupported image type: skip */
    }
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(15).text(business.name, textX, y, { width: 260 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const bizLines = [
    business.address,
    [business.phone, business.email].filter(Boolean).join('   |   '),
    business.website,
    business.taxId ? `${business.taxIdLabel}: ${business.taxId}` : '',
  ].filter(Boolean);
  doc.text(bizLines.join('\n'), textX, doc.y + 4, { width: 260, lineGap: 2 });
  const headerBottomLeft = Math.max(doc.y, logo ? y + 70 : 0);

  doc.font('Helvetica-Bold').fontSize(26).fillColor(accent).text('INVOICE', L, y - 2, { width: W, align: 'right' });
  const meta = [
    ['Invoice no.', inv.number],
    ['Issue date', prettyDate(inv.issue_date)],
    ['Due date', prettyDate(inv.due_date)],
  ];
  let my = y + 36;
  for (const [k, v] of meta) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, R - 200, my, { width: 90, align: 'right' });
    doc.font('Helvetica-Bold').fillColor(INK).text(v, R - 105, my, { width: 105, align: 'right' });
    my += 15;
  }

  y = Math.max(headerBottomLeft, my) + 24;

  // ---- Bill to + amount due
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.7).strokeColor(LINE).stroke();
  y += 16;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('BILL TO', L, y, { characterSpacing: 1 });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(inv.client.name, L, y + 13, { width: 280 });
  const clientLines = [
    inv.client.address,
    [inv.client.phone, inv.client.email].filter(Boolean).join('   |   '),
    inv.client.tax_id ? `${business.taxIdLabel}: ${inv.client.tax_id}` : '',
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(clientLines.join('\n'), L, doc.y + 3, { width: 280, lineGap: 2 });
  const billBottom = doc.y;

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('AMOUNT DUE', R - 200, y, { width: 200, align: 'right', characterSpacing: 1 });
  doc.font('Helvetica-Bold').fontSize(18).fillColor(accent).text(money(inv.total, inv.currency), R - 250, y + 13, { width: 250, align: 'right' });

  y = Math.max(billBottom, y + 40) + 26;

  // ---- Items table
  const col = { no: L, desc: L + 26, qty: L + W - 230, rate: L + W - 170, amt: L + W - 90 };
  const widths = { no: 22, desc: col.qty - col.desc - 10, qty: 50, rate: 80, amt: 90 };

  const tableHeader = () => {
    doc.rect(L, y, W, 22).fill(accent);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF');
    doc.text('#', col.no + 6, y + 7, { width: widths.no });
    doc.text('DESCRIPTION', col.desc, y + 7, { width: widths.desc });
    doc.text('QTY', col.qty, y + 7, { width: widths.qty, align: 'right' });
    doc.text('RATE', col.rate, y + 7, { width: widths.rate, align: 'right' });
    doc.text('AMOUNT', col.amt, y + 7, { width: widths.amt - 6, align: 'right' });
    y += 22;
  };
  tableHeader();

  inv.lines.forEach((l, i) => {
    doc.font('Helvetica').fontSize(9.5);
    const h = Math.max(doc.heightOfString(l.description, { width: widths.desc }), 12) + 14;
    if (y + h > PAGE.height - 120) {
      doc.addPage();
      y = PAGE.margin;
      tableHeader();
    }
    if (i % 2 === 1) doc.rect(L, y, W, h).fill('#F7F9FA');
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(String(i + 1), col.no + 6, y + 7, { width: widths.no });
    doc.fillColor(INK).fontSize(9.5).text(l.description, col.desc, y + 7, { width: widths.desc });
    doc.text(fmtQty(l.quantity), col.qty, y + 7, { width: widths.qty, align: 'right' });
    doc.text(num(l.unit_price), col.rate, y + 7, { width: widths.rate, align: 'right' });
    doc.font('Helvetica-Bold').text(num(l.amount), col.amt, y + 7, { width: widths.amt - 6, align: 'right' });
    y += h;
  });
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.7).strokeColor(LINE).stroke();

  // ---- Totals
  y += 14;
  if (y > PAGE.height - 200) {
    doc.addPage();
    y = PAGE.margin;
  }
  const tx = R - 230;
  const row = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor(bold ? INK : MUTED);
    doc.text(label, tx, y, { width: 130 });
    doc.fillColor(INK).text(value, tx + 100, y, { width: 124, align: 'right' });
    y += bold ? 20 : 17;
  };
  row('Subtotal', money(inv.subtotal, inv.currency));
  if (inv.discount) row(inv.discount_percent && !inv.discount_amount ? `Discount (${inv.discount_percent}%)` : 'Discount', `- ${money(inv.discount, inv.currency)}`);
  if (inv.tax) row(`${inv.tax_label} (${inv.tax_rate}%)`, money(inv.tax, inv.currency));
  y += 2;
  doc.rect(tx - 8, y - 6, 240, 30).fill('#EEF4F5');
  y += 3;
  row('Total', money(inv.total, inv.currency), true);
  y += 18;

  // ---- Payment details, notes, terms
  const block = (title, body) => {
    if (!body) return;
    doc.font('Helvetica').fontSize(9);
    const h = doc.heightOfString(body, { width: W * 0.62 }) + 24;
    if (y + h > PAGE.height - 70) {
      doc.addPage();
      y = PAGE.margin;
    }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(title, L, y, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(body, L, y + 13, { width: W * 0.62, lineGap: 2 });
    y = doc.y + 16;
  };
  block('PAYMENT DETAILS', business.bankDetails);
  block('NOTES', inv.notes);
  block('TERMS', business.terms);

  // ---- Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // let the footer sit below the normal margin without adding a page
    const fy = PAGE.height - 45;
    doc.moveTo(L, fy - 8).lineTo(R, fy - 8).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(`Thank you for your business.   |   ${business.name}`, L, fy, { width: W - 80, lineBreak: false });
    if (range.count > 1) doc.text(`Page ${i + 1} of ${range.count}`, R - 80, fy, { width: 80, align: 'right', lineBreak: false });
  }

  doc.end();
  return done;
}

const num = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
