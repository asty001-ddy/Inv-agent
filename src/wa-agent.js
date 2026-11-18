// WhatsApp Agent Platform: the agent you create in WhatsApp > Settings > Agents.
// One API key, no Meta developer app, no webhook. The server asks WhatsApp for new
// messages (long polling) and replies. An agent can only message the person who created it.
// Manual: "WhatsApp Agent Platform - Developer Manual", v1, 25 Aug 2026.

import { extractMessages } from './whatsapp.js';

const BASE = 'https://api.whatsapp.com/agent/v1';
const POLL_TIMEOUT_S = 25; // longest hold the API allows
const MIN_POLL_GAP_MS = 4500; // stays under 15 polls/minute

export class WhatsAppAgentPlatform {
  constructor({ token, base = BASE, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.base = base;
    this.fetch = fetchImpl;
  }

  async call(method, path, { json, form } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    let body;
    if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) body = form;
    // Sends 12/min max: back off and retry on 429 or "not accepted for delivery" (503).
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.base}${path}`, { method, headers, body, signal: AbortSignal.timeout(60000) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const err = new Error(`WhatsApp agent ${method} ${path} ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
  }

  send(to, message) {
    return this.call('POST', '/messages', { json: { messaging_product: 'whatsapp', to, ...message } });
  }

  async sendText(to, body) {
    for (let i = 0; i < body.length; i += 4000) {
      await this.send(to, { type: 'text', text: { body: body.slice(i, i + 4000) } });
    }
  }

  // No buttons on this platform, so the preview asks for a "yes".
  sendPreview(to, summary) {
    return this.sendText(to, `${summary}\n\nReply *yes* to get the PDF, or tell me what to change. Send *cancel* to discard.`);
  }

  async sendDocument(to, buffer, filename, caption) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append('file', new Blob([buffer], { type: 'application/pdf' }), filename);
    const { id } = await this.call('POST', '/media', { form });
    return this.send(to, { type: 'document', document: { id, filename, caption: caption.slice(0, 1024) } });
  }

  async downloadMedia(mediaId) {
    const meta = await this.call('GET', `/media/${encodeURIComponent(mediaId)}`);
    const res = await this.fetch(meta.url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`WhatsApp agent media download ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: (meta.mime_type || 'audio/ogg').split(';')[0] };
  }

  // Blue ticks + "typing…". Never blocks the reply if it fails.
  markReadTyping(messageId) {
    return this.call('POST', '/statuses', {
      json: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
    }).catch(() => {});
  }

  // One long poll. Returns { messages, nextOffset } (nextOffset null when nothing arrived).
  async poll(offset) {
    const url = `${this.base}/updates?offset=${offset}&limit=100&timeout=${POLL_TIMEOUT_S}`;
    const res = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout((POLL_TIMEOUT_S + 20) * 1000),
    });
    if (res.status === 204) return { messages: [], nextOffset: null };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`WhatsApp agent poll ${res.status}: ${data?.error?.message || ''}`);
      err.status = res.status;
      throw err;
    }
    return { messages: extractMessages(data), nextOffset: Number.isFinite(data.next_offset) ? data.next_offset : null };
  }
}

// Keeps polling for new messages and hands each one to onMessage.
// On start it reads from the beginning of the buffer but only answers messages from the
// last `backlogMinutes`, so a restart or redeploy catches what arrived meanwhile
// without re-answering old chats.
export function startPoller({ client, onMessage, backlogMinutes = 10, status = {} }) {
  let offset = 0;
  let stopped = false;
  let backoff = 0;
  const since = Math.floor(Date.now() / 1000) - backlogMinutes * 60;
  const seen = new Set();

  status.mode = 'polling';
  (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const { messages, nextOffset } = await client.poll(offset);
        status.lastPollAt = new Date().toISOString();
        status.lastError = null;
        backoff = 0;
        for (const m of messages) {
          if (m.timestamp && m.timestamp < since) continue;
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (seen.size > 2000) seen.delete(seen.values().next().value);
          onMessage(m);
        }
        if (nextOffset !== null) offset = nextOffset;
      } catch (err) {
        status.lastError = err.message;
        if (err.status === 409) {
          // Another copy is polling (normal for a minute during a redeploy)
          await sleep(5000);
        } else if (err.status === 400 || err.status === 401) {
          console.error('WhatsApp agent key rejected. Check WHATSAPP_AGENT_TOKEN in Render.', err.message);
          await sleep(60000);
        } else {
          backoff = Math.min(backoff ? backoff * 2 : 2000, 60000);
          console.error(`WhatsApp agent poll failed, retrying in ${backoff / 1000}s:`, err.message);
          await sleep(backoff);
        }
      }
      const gap = Date.now() - started;
      if (gap < MIN_POLL_GAP_MS) await sleep(MIN_POLL_GAP_MS - gap);
    }
  })();
  return { stop: () => { stopped = true; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
