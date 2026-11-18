# Invoice Agent

Chat with your invoice agent inside WhatsApp. Tell it what to bill — by text or voice note, in English, Urdu or Roman Urdu — and get a branded PDF invoice back.

```
You:   Invoice Al Shukr Dairy, 50 litres milk at 220, delivery 1500, 16% tax, due in 10 days
Agent: Invoice preview … Total: PKR 14,500.00
       Reply yes to get the PDF, or tell me what to change.
You:   yes
Agent: 📄 INV-261118-0UJB_Al-Shukr-Dairy.pdf
```

Before you say yes you can keep editing: *"make it 60 litres"*, *"add 5% discount"*, *"remove delivery"*. Send **cancel** or **new** to start over.

**How it works:** the agent you create in WhatsApp (Settings → Agents) → this server on Render picks up your messages → Groq reads them (and transcribes voice notes) → the server calculates the totals and draws the PDF → the PDF comes back in the same chat. The AI never does the maths.

No Meta developer app and no webhook are needed: the server asks WhatsApp for new messages itself.

---

## Set up (about 10 minutes)

### 1. Create the agent in WhatsApp
WhatsApp on your phone → **Settings → Agents → Create an agent** → give it a name (e.g. *Invoices*) and a picture.
Open the agent's chat → **Chat info → API key** → copy it. Treat it like a password.

### 2. Deploy on Render
1. **New → Blueprint**, pick this repo. Render reads `render.yaml`.
2. Fill in:
   | Key | Value |
   |---|---|
   | `GROQ_API_KEY` | console.groq.com → API Keys |
   | `WHATSAPP_AGENT_TOKEN` | The API key from step 1 |
   | `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `BUSINESS_PHONE`, `BUSINESS_EMAIL`, `BUSINESS_TAX_ID` | Printed on every invoice |
   | `BANK_DETAILS` | e.g. `Bank: Meezan Bank\nTitle: Finova Solutions\nIBAN: PK..` (`\n` = new line) |
3. Deploy. From now on **every push to `main` redeploys automatically**.

### 3. Say hi
Open the agent's chat in WhatsApp and send *hi*.

To check it's connected, open `https://<your-service>.onrender.com/healthz` — `whatsappAgent.lastPollAt` should show a recent time and `lastError` should be empty.

---

## Good to know
- **Only you can use it.** A WhatsApp agent can only chat with the person who created it. For clients or staff to message an invoice number, use the optional business-number mode below.
- **Free plan:** Render's free plan sleeps after 15 minutes without visits, which would stop the agent hearing you. The app visits its own `/healthz` every 10 minutes to stay awake (turn off with `KEEP_AWAKE=off`). One always-on service fits inside Render's free monthly hours. For guaranteed uptime, change `plan: free` to `plan: starter`.
- **Restarts:** after a redeploy the agent answers anything you sent in the last 10 minutes (`WHATSAPP_AGENT_BACKLOG_MINUTES`). An unfinished draft is cleared by a restart; finished invoices are already in your chat.
- **Privacy:** chats with WhatsApp agents are not end-to-end encrypted (they pass through a Meta service), so keep sensitive data out.
- **If you reinstall WhatsApp or regenerate the key**, paste the new key into `WHATSAPP_AGENT_TOKEN` on Render.

## Web form and API
Your Render URL has a simple page for making an invoice from a browser. It uses `INVOICE_API_KEY` (Render generates it — see the Environment tab).

```bash
curl -X POST https://<your-service>.onrender.com/api/invoice \
  -H "x-api-key: $INVOICE_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Invoice Ali Traders, 3 office chairs at 4500, due 30 Nov"}' -o invoice.pdf
```

Or send exact fields: `{"draft": {"client":{"name":"Ali Traders"},"items":[{"description":"Office chair","quantity":3,"unit_price":4500}],"tax_rate":16}}`.
If something is missing you get `422` with `missing` and a follow-up `question`.

## Optional: a WhatsApp Business number
To let other people message a business number (with tap buttons), also set `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID` and `ALLOWED_NUMBERS`, then in your Meta app → WhatsApp → Configuration → Webhook use `https://<your-service>.onrender.com/webhook` and subscribe to **messages**. Both modes can run at once.

## Run locally
```bash
cp .env.example .env    # fill in the keys
npm install
npm run dev             # http://localhost:8080
npm test
```

## Files
```
src/server.js    routes, message handling, starts the WhatsApp agent poller
src/wa-agent.js  WhatsApp Agents API (api.whatsapp.com/agent/v1): poll, send, PDF upload, voice notes
src/whatsapp.js  WhatsApp business number (Meta Cloud API, webhook) — optional
src/agent.js     conversation: draft → preview → PDF (Groq prompt lives here)
src/invoice.js   totals, invoice numbers, dates
src/pdf.js       the PDF layout
src/groq.js      Groq chat (JSON) + Whisper transcription
```
