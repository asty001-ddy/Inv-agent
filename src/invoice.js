// Invoice maths and formatting. The AI only extracts details; every number on
// the invoice is calculated here.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

export function emptyDraft(defaults) {
  return {
    client: { name: '', address: '', phone: '', email: '', tax_id: '' },
    items: [],
    currency: defaults.currency,
    tax_rate: defaults.taxRate,
    discount_amount: 0,
    discount_percent: 0,
    due_date: '',
    notes: '',
  };
}

// Clean up whatever the AI returned so the rest of the code can trust it.
export function normalizeDraft(raw, defaults) {
  const d = emptyDraft(defaults);
  if (!raw || typeof raw !== 'object') return d;
  const c = raw.client || {};
  for (const k of Object.keys(d.client)) d.client[k] = str(c[k]);
  d.items = (Array.isArray(raw.items) ? raw.items : [])
    .map((it) => ({
      description: str(it?.description),
      quantity: pos(it?.quantity) || 1,
      unit_price: pos(it?.unit_price),
    }))
    .filter((it) => it.description);
  d.currency = (str(raw.currency) || defaults.currency).toUpperCase().slice(0, 5);
  d.tax_rate = raw.tax_rate === undefined || raw.tax_rate === null || raw.tax_rate === '' ? defaults.taxRate : pos(raw.tax_rate);
  d.discount_amount = pos(raw.discount_amount);
  d.discount_percent = Math.min(pos(raw.discount_percent), 100);
  d.due_date = /^\d{4}-\d{2}-\d{2}$/.test(str(raw.due_date)) ? str(raw.due_date) : '';
  d.notes = str(raw.notes);
  return d;
}

export function missingFields(d) {
  const missing = [];
  if (!d.client.name) missing.push('client name');
  if (!d.items.length) missing.push('items');
  else if (d.items.some((it) => !it.unit_price)) missing.push('price for every item');
  return missing;
}

export function totals(d) {
  const lines = d.items.map((it) => ({ ...it, amount: round2(it.quantity * it.unit_price) }));
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const discount = round2(Math.min(subtotal, d.discount_amount + (subtotal * d.discount_percent) / 100));
  const taxable = round2(subtotal - discount);
  const tax = round2((taxable * d.tax_rate) / 100);
  return { lines, subtotal, discount, taxable, tax, total: round2(taxable + tax) };
}

export function money(n, currency) {
  const s = Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${s}`;
}

export function todayISO(timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}

export function addDays(iso, days) {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function prettyDate(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

// Render's free disk is wiped on every deploy, so a stored counter would reset.
// A date + time-based code stays unique without a database.
export function invoiceNumber(prefix, timezone, now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  const seq = (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)).toString(36).toUpperCase().padStart(4, '0');
  return `${prefix}-${p.year}${p.month}${p.day}-${seq}`;
}

// Final invoice object passed to the PDF renderer.
export function finalize(draft, cfg) {
  const issue = todayISO(cfg.timezone);
  return {
    ...draft,
    number: invoiceNumber(cfg.defaults.prefix, cfg.timezone),
    issue_date: issue,
    due_date: draft.due_date || addDays(issue, cfg.defaults.dueDays),
    tax_label: cfg.defaults.taxLabel,
    ...totals(draft),
  };
}

// WhatsApp preview shown before the PDF is made.
export function summaryText(d, defaults) {
  const t = totals(d);
  const cur = d.currency;
  const out = ['*Invoice preview*', `Client: ${d.client.name}`];
  if (d.due_date) out.push(`Due: ${prettyDate(d.due_date)}`);
  else out.push(`Due: in ${defaults.dueDays} days`);
  out.push('');
  t.lines.forEach((l, i) =>
    out.push(`${i + 1}. ${l.description} — ${fmtQty(l.quantity)} × ${money(l.unit_price, cur)} = ${money(l.amount, cur)}`),
  );
  out.push('', `Subtotal: ${money(t.subtotal, cur)}`);
  if (t.discount) out.push(`Discount: −${money(t.discount, cur)}`);
  if (t.tax) out.push(`${defaults.taxLabel} (${d.tax_rate}%): ${money(t.tax, cur)}`);
  out.push(`*Total: ${money(t.total, cur)}*`);
  if (d.notes) out.push('', `Notes: ${d.notes}`);
  return out.join('\n');
}

export const fmtQty = (q) => (Number.isInteger(q) ? String(q) : String(round2(q)));
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
