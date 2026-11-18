import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

// Fake api.whatsapp.com/agent/v1 + Groq, following the developer manual's shapes.
function fakeWhatsAppAgent() {
  const inbox = []; // queued updates
  const sent = [];
  const statuses = [];
  let seq = 100;
  const now = Math.floor(Date.now() / 1000);
  const userId = 'user:50972923564215';

  const push = (message) => inbox.push({ seq: seq++, message: { from: userId, timestamp: String(now), ...message } });

  const groqReply = {
    intent: 'update',
    draft: { client: { name: 'Ali Traders' }, items: [{ description: 'Office chair', quantity: 3, unit_price: 4500 }], tax_rate: 0 },
    reply: 'Noted.',
  };

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.host === 'api.groq.com') return json({ choices: [{ message: { content: JSON.stringify(groqReply) } }] });
    assert.equal(opts.headers?.Authorization, 'Bearer test-agent-key');
    if (u.pathname === '/agent/v1/updates') {
      const offset = Number(u.searchParams.get('offset'));
      const ready = inbox.filter((e) => e.seq >= offset);
      if (!ready.length) {
        await new Promise((r) => setTimeout(r, 30));
        return new Response(null, { status: 204 });
      }
      return json({
        object: 'whatsapp_agent_platform',
        entry: [{ id: '123', changes: [{ field: 'messages', value: {
          messaging_product: 'whatsapp',
          contacts: [{ wa_id: userId, profile: { name: 'Atifa' } }],
          messages: ready.map((e) => e.message),
          statuses: [],
        } }] }],
        next_offset: ready.at(-1).seq + 1,
      });
    }
    if (u.pathname === '/agent/v1/messages') {
      const body = JSON.parse(opts.body);
      assert.equal(body.messaging_product, 'whatsapp');
      assert.equal(body.to, userId);
      sent.push(body);
      return json({ messaging_product: 'whatsapp', contacts: [{ input: userId, wa_id: userId }], messages: [{ id: `wamid.out${sent.length}` }] });
    }
    if (u.pathname === '/agent/v1/statuses') {
      statuses.push(JSON.parse(opts.body));
      return json({ success: true });
    }
    if (u.pathname === '/agent/v1/media' && opts.method === 'POST') {
      assert.ok(opts.body instanceof FormData);
      assert.equal(opts.body.get('type'), 'application/pdf');
      return json({ id: 'media-abc' });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetchImpl, push, sent, statuses };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(50);
  }
  throw new Error('timed out');
}

test('WhatsApp Agents: message -> preview -> "yes" -> PDF', { timeout: 30000 }, async () => {
  const wa = fakeWhatsAppAgent();
  const cfg = loadConfig({ GROQ_API_KEY: 'g', WHATSAPP_AGENT_TOKEN: 'test-agent-key', BUSINESS_NAME: 'Finova Solutions' });
  const app = createApp({ cfg, fetchImpl: wa.fetchImpl, startPolling: true });

  wa.push({ id: 'wamid.in1', type: 'text', text: { body: 'Invoice Ali Traders, 3 office chairs at 4500' } });
  await until(() => wa.sent.length >= 1);
  assert.equal(wa.sent[0].type, 'text');
  assert.match(wa.sent[0].text.body, /Total: PKR 13,500.00/);
  assert.match(wa.sent[0].text.body, /Reply \*yes\*/);
  assert.deepEqual(wa.statuses[0], { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.in1', typing_indicator: { type: 'text' } });

  wa.push({ id: 'wamid.in2', type: 'text', text: { body: 'yes' } });
  await until(() => wa.sent.some((s) => s.type === 'document'));
  const doc = wa.sent.find((s) => s.type === 'document');
  assert.equal(doc.document.id, 'media-abc');
  assert.match(doc.document.filename, /_Ali-Traders\.pdf$/);
  assert.match(doc.document.caption, /PKR 13,500.00/);

  // reactions are ignored
  const before = wa.sent.length;
  wa.push({ id: 'wamid.in3', type: 'reaction', reaction: { message_id: 'wamid.out1', emoji: '👍' } });
  await wait(6000);
  assert.equal(wa.sent.length, before);
  app.locals.stop();
});
