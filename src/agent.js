import { emptyDraft, normalizeDraft, missingFields, summaryText, finalize, todayISO, money } from './invoice.js';
import { renderInvoicePdf } from './pdf.js';

const CONFIRM = /^(yes|y|ok|okay|confirm|confirmed|generate|generate pdf|create|done|send|go|haan|han|ji|jee|theek|theek hai|thik hai|bana do|bhej do)[.! ]*$/i;
const RESET = /^(new|new invoice|cancel|reset|start over|clear|naya|nai invoice)[.! ]*$/i;
const HELP = /^(help|menu|\?|how)[.! ]*$/i;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY = 10;

export function helpText(cfg) {
  return [
    `Hi! I make invoices for *${cfg.business.name}*.`,
    '',
    'Just tell me (text or voice note) who it is for and what to bill, e.g.:',
    '_Invoice Al Shukr Dairy, 50 litres milk at 220, delivery 1500, due in 10 days_',
    '',
    "I'll show a preview, then send you the PDF to forward.",
    'Send *new* to start over at any time.',
  ].join('\n');
}

function systemPrompt(cfg, draft) {
  const today = todayISO(cfg.timezone);
  return `You are the invoicing assistant for "${cfg.business.name}". Users chat on WhatsApp in English, Urdu or Roman Urdu.
Your job: build an invoice draft from what the user says, step by step, and keep it updated as they add or change things.

Today is ${today} (timezone ${cfg.timezone}). Default currency: ${cfg.defaults.currency}. Default tax rate: ${cfg.defaults.taxRate}%. Default due date: ${cfg.defaults.dueDays} days from today.

CURRENT DRAFT (JSON):
${JSON.stringify(draft)}

Rules:
- Return the FULL updated draft every time: keep everything already in it unless the user changes or removes it.
- Write every draft field in English using Latin letters, even if the user wrote in Urdu script (the PDF can only print Latin letters). Transliterate names (e.g. "علی ٹریڈرز" -> "Ali Traders").
- items: one entry per product or service. quantity defaults to 1. unit_price is the price of ONE unit. If the user gives a line total and a quantity, divide to get unit_price. A delivery or service charge is its own item.
- Understand shorthand: "5k" = 5000, "1.2 lac"/"1.2 lakh" = 120000, "Rs"/"rupees" = PKR, "$" = USD, "SAR"/"riyal" = SAR, "AED"/"dirham" = AED.
- tax_rate is a percentage (e.g. 17). Only change it if the user mentions tax/GST; "no tax" = 0.
- Discount: use discount_amount for a fixed amount, discount_percent for a percentage.
- due_date as YYYY-MM-DD. Convert "due in 10 days", "end of month", "15 Dec" relative to today. Leave "" if not mentioned.
- Never invent prices, quantities or client details. If something essential is missing (client name, an item, or a price), ask for it.
- Do NOT calculate totals; the system does that.

Respond with ONLY a JSON object:
{
  "intent": "update" | "confirm" | "cancel" | "help" | "chat",
  "draft": { "client": {"name":"","address":"","phone":"","email":"","tax_id":""}, "items":[{"description":"","quantity":1,"unit_price":0}], "currency":"", "tax_rate":0, "discount_amount":0, "discount_percent":0, "due_date":"", "notes":"" },
  "reply": "short WhatsApp message to the user, in the language they used"
}
intent: "update" when they give or change invoice details; "confirm" when they approve the preview / ask to generate the PDF; "cancel" when they want to discard it; "help" when they ask how this works; "chat" for anything else (greetings, thanks) - reply briefly and steer back to invoicing.
"reply" should ask ONE short question for what is still missing, or be a brief acknowledgement. Never list totals in it.`;
}

export class InvoiceAgent {
  constructor({ cfg, groq, fetchImpl = globalThis.fetch }) {
    this.cfg = cfg;
    this.groq = groq;
    this.fetch = fetchImpl;
    this.sessions = new Map();
  }

  session(user) {
    let s = this.sessions.get(user);
    if (!s || Date.now() - s.updatedAt > SESSION_TTL_MS) {
      s = { draft: emptyDraft(this.cfg.defaults), history: [], updatedAt: Date.now() };
      this.sessions.set(user, s);
    }
    s.updatedAt = Date.now();
    return s;
  }

  reset(user) {
    this.sessions.delete(user);
  }

  // Takes one incoming message and returns what to send back:
  // [{ type: 'text', body } | { type: 'buttons', body, buttons } | { type: 'document', buffer, filename, caption }]
  async handle(user, text, { buttonId = '' } = {}) {
    const msg = (text || '').trim();
    const s = this.session(user);

    if (buttonId === 'cancel' || RESET.test(msg)) {
      this.reset(user);
      return [{ type: 'text', body: 'Cleared. Tell me the next invoice whenever you are ready.' }];
    }
    if (HELP.test(msg)) return [{ type: 'text', body: helpText(this.cfg) }];
    if (buttonId === 'confirm' || (CONFIRM.test(msg) && missingFields(s.draft).length === 0 && s.draft.items.length)) {
      return this.generate(user, s);
    }

    let out;
    try {
      out = await this.groq.json([
        { role: 'system', content: systemPrompt(this.cfg, s.draft) },
        ...s.history,
        { role: 'user', content: msg },
      ]);
    } catch (err) {
      console.error('Groq error:', err.message);
      return [{ type: 'text', body: 'Sorry, I could not process that just now. Please send it again in a moment.' }];
    }

    s.history.push({ role: 'user', content: msg });
    if (out.reply) s.history.push({ role: 'assistant', content: String(out.reply) });
    s.history = s.history.slice(-HISTORY);

    if (out.intent === 'cancel') {
      this.reset(user);
      return [{ type: 'text', body: out.reply || 'Cleared.' }];
    }
    if (out.intent === 'help') return [{ type: 'text', body: helpText(this.cfg) }];

    if (out.draft) s.draft = normalizeDraft(out.draft, this.cfg.defaults);
    const missing = missingFields(s.draft);

    if (out.intent === 'confirm' && missing.length === 0) return this.generate(user, s);

    if (missing.length === 0) {
      // Each WhatsApp channel shows this its own way (buttons, or "reply yes")
      return [{ type: 'preview', body: summaryText(s.draft, this.cfg.defaults) }];
    }
    const fallback = s.draft.client.name || s.draft.items.length
      ? `Got it. I still need: ${missing.join(', ')}.`
      : helpText(this.cfg);
    return [{ type: 'text', body: out.reply || fallback }];
  }

  async generate(user, s) {
    const inv = finalize(s.draft, this.cfg);
    const buffer = await renderInvoicePdf(inv, this.cfg.business, { fetchImpl: this.fetch });
    const filename = `${inv.number}_${slug(inv.client.name)}.pdf`;
    this.reset(user);
    return [
      { type: 'document', buffer, filename, caption: `${inv.number} · ${inv.client.name} · ${money(inv.total, inv.currency)}` },
      { type: 'text', body: 'Done ✅ Forward the PDF to your client. Send the next invoice whenever you like.' },
    ];
  }

  // One-shot use from the web form / API: text in, PDF out.
  async fromText(text) {
    const draft = emptyDraft(this.cfg.defaults);
    const out = await this.groq.json([
      { role: 'system', content: systemPrompt(this.cfg, draft) },
      { role: 'user', content: text },
    ]);
    const d = normalizeDraft(out.draft, this.cfg.defaults);
    return { draft: d, missing: missingFields(d), question: out.reply || '' };
  }

  async pdfFromDraft(rawDraft) {
    const d = normalizeDraft(rawDraft, this.cfg.defaults);
    const missing = missingFields(d);
    if (missing.length) return { missing };
    const inv = finalize(d, this.cfg);
    const buffer = await renderInvoicePdf(inv, this.cfg.business, { fetchImpl: this.fetch });
    return { buffer, filename: `${inv.number}_${slug(inv.client.name)}.pdf`, invoice: inv };
  }
}

const slug = (s) => (s || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';
