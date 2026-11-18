import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { normalizeDraft, totals } from '../src/invoice.js';

const cfg = loadConfig({
  GROQ_API_KEY: 'g', META_ACCESS_TOKEN: 't', META_PHONE_NUMBER_ID: '123', META_VERIFY_TOKEN: 'v',
  META_APP_SECRET: 'secret', INVOICE_API_KEY: 'k', ALLOWED_NUMBERS: '923001234567',
  BUSINESS_NAME: 'Finova Solutions', TAX_RATE: '0', PORT: '0',
});

const groqDraft = {
  intent: 'update',
  draft: {
    client: { name: 'Al Shukr Dairy', address: 'Lahore' },
    items: [{ description: 'Fresh milk (litres)', quantity: 50, unit_price: 220 }, { description: 'Delivery', quantity: 1, unit_price: 1500 }],
    tax_rate: 17, discount_amount: 500,
  },
  reply: 'Noted.',
};

function mockFetch(calls) {
  return async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).includes('api.groq.com')) return json({ choices: [{ message: { content: JSON.stringify(groqDraft) } }] });
    if (String(url).endsWith('/media')) return json({ id: 'media-1' });
    if (String(url).includes('graph.facebook.com')) return json({ messages: [{ id: 'out' }] });
    return new Response('nope', { status: 404 });
  };
}

const webhookBody = (m) => ({ entry: [{ changes: [{ value: { contacts: [{ wa_id: m.from, profile: { name: 'A' } }], messages: [m] } }] }] });
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'secret').update(raw).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('totals: discount before tax', () => {
  const d = normalizeDraft(groqDraft.draft, cfg.defaults);
  const t = totals(d);
  assert.equal(t.subtotal, 12500);
  assert.equal(t.discount, 500);
  assert.equal(t.tax, 2040);
  assert.equal(t.total, 14040);
});

test('WhatsApp flow: message -> preview with buttons -> PDF', async () => {
  const calls = [];
  const app = createApp({ cfg, fetchImpl: mockFetch(calls) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw });
  };
  try {
    // verification handshake
    const v = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=v&hub.challenge=42`);
    assert.equal(await v.text(), '42');

    // bad signature rejected
    const bad = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    assert.equal(bad.status, 401);

    // stranger ignored
    await post(webhookBody({ id: 'x0', from: '999', type: 'text', text: { body: 'hi' } }));
    await wait(50);
    assert.equal(calls.filter((c) => c.url.includes('api.groq.com')).length, 0);

    // details -> preview with buttons
    assert.equal((await post(webhookBody({ id: 'm1', from: '923001234567', type: 'text', text: { body: 'Invoice Al Shukr Dairy...' } }))).status, 200);
    await post(webhookBody({ id: 'm1', from: '923001234567', type: 'text', text: { body: 'duplicate retry' } }));
    await wait(150);
    const sent = calls.filter((c) => c.url.endsWith('/123/messages')).map((c) => JSON.parse(c.opts.body));
    const preview = sent.find((s) => s.type === 'interactive');
    assert.ok(preview, 'preview with buttons sent');
    assert.match(preview.interactive.body.text, /Total: PKR 14,040.00/);
    assert.equal(calls.filter((c) => c.url.includes('api.groq.com')).length, 1, 'duplicate webhook ignored');

    // tap Generate -> PDF uploaded and sent
    await post(webhookBody({ id: 'm2', from: '923001234567', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'confirm', title: 'Generate PDF' } } }));
    await wait(400);
    assert.ok(calls.some((c) => c.url.endsWith('/123/media')), 'PDF uploaded');
    const doc = calls.filter((c) => c.url.endsWith('/123/messages')).map((c) => JSON.parse(c.opts.body)).find((s) => s.type === 'document');
    assert.ok(doc, 'document sent');
    assert.match(doc.document.filename, /^INV-\d{6}-[0-9A-Z]{4}_Al-Shukr-Dairy\.pdf$/);
  } finally {
    server.close();
  }
});

test('API: text in, PDF out; key required', async () => {
  const calls = [];
  const server = createApp({ cfg, fetchImpl: mockFetch(calls) }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/invoice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
    assert.equal(denied.status, 401);
    const res = await fetch(`${base}/api/invoice`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ text: 'Invoice Al Shukr' }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  } finally {
    server.close();
  }
});
