const BASE = 'https://api.groq.com/openai/v1';

export class Groq {
  constructor({ apiKey, model, transcribeModel, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.transcribeModel = transcribeModel;
    this.fetch = fetchImpl;
  }

  // Chat completion that must come back as a JSON object. Retries once on a bad
  // answer or a temporary error (rate limit, Groq busy).
  async json(messages) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature: 0.1,
            response_format: { type: 'json_object' },
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          const err = new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
          if (res.status === 429 || res.status >= 500) {
            lastErr = err;
            await sleep(1500);
            continue;
          }
          throw err;
        }
        const data = await res.json();
        return JSON.parse(data.choices?.[0]?.message?.content || '{}');
      } catch (err) {
        lastErr = err;
        if (!(err instanceof SyntaxError) && !String(err.message).startsWith('Groq')) throw err;
      }
    }
    throw lastErr;
  }

  // Voice note -> text. Whisper handles Urdu, English and a mix of both.
  async transcribe(buffer, filename = 'voice.ogg', mime = 'audio/ogg') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    form.append('model', this.transcribeModel);
    form.append('response_format', 'json');
    const res = await this.fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`Groq transcription ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return (data.text || '').trim();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
