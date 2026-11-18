import crypto from 'node:crypto';

// Checks the X-Hub-Signature-256 header so only Meta can call the webhook.
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true; // not configured: skip (fine for a first test, set it before going live)
  if (!header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pulls the messages we care about out of a Meta webhook payload.
export function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of value.messages || []) {
        const msg = { id: m.id, from: m.from, name: names[m.from] || '', type: m.type, text: '', timestamp: Number(m.timestamp) || 0 };
        if (m.type === 'text') msg.text = m.text?.body || '';
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
          msg.buttonId = r.id || '';
          msg.text = r.title || '';
        } else if (m.type === 'button') msg.text = m.button?.text || '';
        else if (m.type === 'audio') msg.mediaId = m.audio?.id;
        out.push(msg);
      }
    }
  }
  return out;
}

export class WhatsApp {
  constructor({ token, phoneNumberId, graphVersion = 'v25.0', fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.phoneNumberId = phoneNumberId;
    this.base = `https://graph.facebook.com/${graphVersion}`;
    this.fetch = fetchImpl;
  }

  async post(path, payload) {
    const res = await this.fetch(`${this.base}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  send(to, message) {
    return this.post(`${this.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message });
  }

  async sendText(to, body) {
    // WhatsApp caps a text message at 4096 characters
    for (let i = 0; i < body.length; i += 4000) {
      await this.send(to, { type: 'text', text: { body: body.slice(i, i + 4000), preview_url: false } });
    }
  }

  // Up to 3 tap-to-reply buttons. Falls back to plain text if the body is too long.
  async sendButtons(to, body, buttons) {
    if (body.length > 1024) {
      await this.sendText(to, body);
      return this.sendText(to, buttons.map((b) => `Reply *${b.title}*`).join(' or '));
    }
    return this.send(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    });
  }

  // Invoice preview with Generate / Cancel buttons
  sendPreview(to, summary) {
    return this.sendButtons(to, `${summary}\n\nTap *Generate PDF*, or tell me what to change.`, [
      { id: 'confirm', title: 'Generate PDF' },
      { id: 'cancel', title: 'Cancel' },
    ]);
  }

  async uploadMedia(buffer, filename, mime) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buffer], { type: mime }), filename);
    const res = await this.fetch(`${this.base}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) throw new Error(`WhatsApp media upload ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data.id;
  }

  async sendDocument(to, buffer, filename, caption) {
    const id = await this.uploadMedia(buffer, filename, 'application/pdf');
    return this.send(to, { type: 'document', document: { id, filename, caption } });
  }

  async downloadMedia(mediaId) {
    const metaRes = await this.fetch(`${this.base}/${mediaId}`, { headers: { Authorization: `Bearer ${this.token}` } });
    const meta = await metaRes.json();
    if (!metaRes.ok || !meta.url) throw new Error(`WhatsApp media lookup ${metaRes.status}`);
    const fileRes = await this.fetch(meta.url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!fileRes.ok) throw new Error(`WhatsApp media download ${fileRes.status}`);
    return { buffer: Buffer.from(await fileRes.arrayBuffer()), mime: (meta.mime_type || 'audio/ogg').split(';')[0] };
  }

  // Blue ticks + "typing…" while the agent works. Never blocks the reply if it fails.
  markReadTyping(messageId) {
    return this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }).catch(() => {});
  }
}
