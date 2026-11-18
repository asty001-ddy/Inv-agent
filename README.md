# Invoice Agent

Message a WhatsApp number with what to bill — by text or voice note, in English, Urdu or Roman Urdu — and get a branded PDF invoice back.

```
You:   Invoice Al Shukr Dairy, 50 litres milk at 220, delivery 1500, 16% tax, due in 10 days
Agent: Invoice preview … Total: PKR 14,500.00   [Generate PDF] [Cancel]
You:   (tap Generate PDF)
Agent: 📄 INV-261118-0UJB_Al-Shukr-Dairy.pdf
```

You can keep editing before you confirm: *"make it 60 litres"*, *"add 5% discount"*, *"remove delivery"*. Send **new** to start over.

**How it works:** WhatsApp (Meta Cloud API) → this server on Render → Groq reads the message (and transcribes voice notes) → the server calculates the totals and draws the PDF → the PDF is sent back on WhatsApp. The AI never does the maths.

There is also a small web page at your Render URL (and `POST /api/invoice`) for making invoices from a browser or from another app.

---

## Deploy on Render (auto-deploy from GitHub)

1. In Render: **New → Blueprint**, pick this repo. Render reads `render.yaml`.
2. Fill in the values it asks for:
   | Key | Where to get it |
   |---|---|
   | `GROQ_API_KEY` | console.groq.com → API Keys |
   | `META_ACCESS_TOKEN` | Same as your WhatsApp agent (permanent system-user token) |
   | `META_APP_SECRET` | Meta app → App settings → Basic |
   | `META_PHONE_NUMBER_ID` | Meta app → WhatsApp → API Setup |
   | `ALLOWED_NUMBERS` | Your number(s) e.g. `923001234567` — only these can make invoices |
   | `BUSINESS_*`, `BANK_DETAILS` | Printed on every invoice. Use `\n` for line breaks |
3. Deploy. From now on **every push to `main` redeploys automatically**.
4. In Meta → WhatsApp → Configuration → **Webhook**:
   - Callback URL: `https://<your-service>.onrender.com/webhook`
   - Verify token: copy `META_VERIFY_TOKEN` from Render's Environment tab
   - Subscribe to the **messages** field.
5. Send *hi* to the WhatsApp number.

### Important: one number, one webhook
A WhatsApp number sends its messages to **one** webhook URL. If your existing WhatsApp agent already uses the number, either give the invoice agent its own number (add a second number in the same Meta app), or point that number's webhook here.

### Free plan note
Render's free plan sleeps after 15 minutes without traffic, so the first reply after a quiet spell takes about a minute (Meta retries, so no message is lost). To keep it awake, either switch the plan to **Starter** in `render.yaml`, or add a free uptime monitor (e.g. cron-job.org) that opens `https://<your-service>.onrender.com/healthz` every 10 minutes.

Drafts in progress are kept in memory, so a redeploy or a sleep clears an unfinished draft. Finished invoices are already on WhatsApp.

---

## Run locally

```bash
cp .env.example .env    # fill in the keys
npm install
npm run dev             # http://localhost:8080
npm test
```

## API

```bash
curl -X POST https://<your-service>.onrender.com/api/invoice \
  -H "x-api-key: $INVOICE_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Invoice Ali Traders, 3 office chairs at 4500, due 30 Nov"}' -o invoice.pdf
```

Or send exact fields with `{"draft": {"client":{"name":"Ali Traders"},"items":[{"description":"Office chair","quantity":3,"unit_price":4500}],"tax_rate":16}}`.
If something is missing you get `422` with `missing` and a follow-up `question`.

## Settings

All in `.env.example`: currency (`PKR` default), default tax rate, due days, invoice prefix, logo URL, accent colour, payment terms, Groq model.

## Files

```
src/server.js    routes: /webhook, /api/invoice, /healthz, web page
src/agent.js     conversation: draft → preview → PDF (Groq prompt lives here)
src/invoice.js   totals, invoice numbers, dates
src/pdf.js       the PDF layout
src/whatsapp.js  Meta Cloud API: send text/buttons/PDF, voice notes, signature check
src/groq.js      Groq chat (JSON) + Whisper transcription
```
