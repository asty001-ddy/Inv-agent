import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { Groq } from './groq.js';
import { WhatsApp, verifySignature, extractMessages } from './whatsapp.js';
import { InvoiceAgent } from './agent.js';

export function createApp({ cfg = loadConfig(), fetchImpl = globalThis.fetch } = {}) {
  const groq = new Groq({ ...cfg.groq, fetchImpl });
  const wa = new WhatsApp({ ...cfg.meta, fetchImpl });
  const agent = new InvoiceAgent({ cfg, groq, fetchImpl });

  const app = express();
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Meta retries webhooks, so remember recent message ids and skip repeats.
  const seen = new Set();
  const firstTime = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 2000) seen.delete(seen.values().next().value);
    return true;
  };
  // One message at a time per person, in order.
  const queues = new Map();
  const enqueue = (user, job) => {
    const next = (queues.get(user) || Promise.resolve()).then(job).catch((e) => console.error('Job failed:', e));
    queues.set(user, next);
    next.finally(() => { if (queues.get(user) === next) queues.delete(user); });
    return next;
  };

  const allowed = (from) =>
    !cfg.allowedNumbers.length || cfg.allowedNumbers.includes('*') || cfg.allowedNumbers.includes(from);

  async function deliver(to, replies) {
    for (const r of replies) {
      if (r.type === 'text') await wa.sendText(to, r.body);
      else if (r.type === 'buttons') await wa.sendButtons(to, r.body, r.buttons);
      else if (r.type === 'document') await wa.sendDocument(to, r.buffer, r.filename, r.caption);
    }
  }

  async function processMessage(m) {
    if (!allowed(m.from)) {
      console.log(`Ignored message from ${m.from} (not in ALLOWED_NUMBERS)`);
      return;
    }
    wa.markReadTyping(m.id);
    let text = m.text;
    if (m.type === 'audio' && m.mediaId) {
      try {
        const { buffer, mime } = await wa.downloadMedia(m.mediaId);
        text = await groq.transcribe(buffer, 'voice.ogg', mime);
        console.log(`Voice note from ${m.from}: ${text}`);
      } catch (err) {
        console.error('Voice note failed:', err.message);
        return wa.sendText(m.from, 'Sorry, I could not hear that voice note. Could you type it instead?');
      }
    }
    if (!text) return wa.sendText(m.from, 'Please send the invoice details as a text message or a voice note.');
    try {
      await deliver(m.from, await agent.handle(m.from, text, { buttonId: m.buttonId }));
    } catch (err) {
      console.error('Reply failed:', err.message);
      await wa.sendText(m.from, 'Something went wrong while making that invoice. Please try again.').catch(() => {});
    }
  }

  // ---------- Health check (Render uses this) ----------
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // ---------- WhatsApp webhook ----------
  app.get('/webhook', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && cfg.meta.verifyToken && req.query['hub.verify_token'] === cfg.meta.verifyToken;
    if (ok) return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
    res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), cfg.meta.appSecret)) return res.sendStatus(401);
    res.sendStatus(200); // answer Meta straight away; the work happens after
    for (const m of extractMessages(req.body)) {
      if (firstTime(m.id)) enqueue(m.from, () => processMessage(m));
    }
  });

  // ---------- Web form + API (needs INVOICE_API_KEY) ----------
  const requireKey = (req, res, next) => {
    if (!cfg.apiKey) return res.status(403).json({ error: 'Web access is off. Set INVOICE_API_KEY to turn it on.' });
    if (req.get('x-api-key') !== cfg.apiKey) return res.status(401).json({ error: 'Wrong access key.' });
    next();
  };

  // Body: { "text": "Invoice Ali Traders, 3 chairs at 4500" }  or  { "draft": { ...invoice fields } }
  // Returns the PDF, or 422 with what is missing.
  app.post('/api/invoice', requireKey, async (req, res) => {
    try {
      let draft = req.body?.draft;
      if (!draft) {
        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Send "text" or "draft".' });
        const parsed = await agent.fromText(text);
        if (parsed.missing.length) return res.status(422).json({ missing: parsed.missing, question: parsed.question, draft: parsed.draft });
        draft = parsed.draft;
      }
      const out = await agent.pdfFromDraft(draft);
      if (out.missing) return res.status(422).json({ missing: out.missing });
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'X-Invoice-Number': out.invoice.number,
        'X-Invoice-Total': String(out.invoice.total),
      });
      res.send(out.buffer);
    } catch (err) {
      console.error('API error:', err.message);
      res.status(500).json({ error: 'Could not create the invoice. Please try again.' });
    }
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(express.static(path.join(here, '..', 'public')));

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const missing = [
    ['GROQ_API_KEY', cfg.groq.apiKey],
    ['META_ACCESS_TOKEN', cfg.meta.token],
    ['META_PHONE_NUMBER_ID', cfg.meta.phoneNumberId],
    ['META_VERIFY_TOKEN', cfg.meta.verifyToken],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) console.warn(`Missing settings: ${missing.join(', ')} — WhatsApp replies will not work until they are set.`);
  if (!cfg.meta.appSecret) console.warn('META_APP_SECRET is not set — webhook signatures are not being checked.');
  createApp({ cfg }).listen(cfg.port, () => console.log(`Invoice agent running on port ${cfg.port}`));
}
