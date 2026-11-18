const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
// Render's dashboard keeps line breaks, but a .env file can't: allow "\n" in either.
const text = (v) => (v || '').replace(/\\n/g, '\n').trim();

export function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 8080),
    timezone: env.TIMEZONE || 'Asia/Karachi',

    groq: {
      apiKey: env.GROQ_API_KEY || '',
      model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
      transcribeModel: env.GROQ_TRANSCRIBE_MODEL || 'whisper-large-v3-turbo',
    },

    // WhatsApp > Settings > Agents > your agent > Chat info > API key
    agentPlatform: {
      token: env.WHATSAPP_AGENT_TOKEN || '',
      backlogMinutes: num(env.WHATSAPP_AGENT_BACKLOG_MINUTES, 10),
    },

    // Optional: a WhatsApp Business number through a Meta developer app (webhook)
    meta: {
      token: env.META_ACCESS_TOKEN || '',
      appSecret: env.META_APP_SECRET || '',
      verifyToken: env.META_VERIFY_TOKEN || '',
      phoneNumberId: env.META_PHONE_NUMBER_ID || '',
      graphVersion: env.META_GRAPH_VERSION || 'v25.0',
    },

    // Numbers allowed to create invoices on WhatsApp. Empty or * = anyone.
    allowedNumbers: list(env.ALLOWED_NUMBERS).map((n) => n.replace(/\D/g, '') || n),

    // Key for the web form and POST /api/invoice. Empty = web access switched off.
    apiKey: env.INVOICE_API_KEY || '',

    business: {
      name: env.BUSINESS_NAME || 'Your Business',
      address: text(env.BUSINESS_ADDRESS),
      phone: env.BUSINESS_PHONE || '',
      email: env.BUSINESS_EMAIL || '',
      website: env.BUSINESS_WEBSITE || '',
      taxId: env.BUSINESS_TAX_ID || '',
      taxIdLabel: env.BUSINESS_TAX_ID_LABEL || 'NTN',
      logoUrl: env.BUSINESS_LOGO_URL || '',
      bankDetails: text(env.BANK_DETAILS),
      terms: text(env.INVOICE_TERMS),
      accentColor: env.ACCENT_COLOR || '#0F4C5C',
    },

    defaults: {
      currency: env.CURRENCY || 'PKR',
      taxRate: num(env.TAX_RATE, 0),
      taxLabel: env.TAX_LABEL || 'Sales tax',
      dueDays: num(env.DUE_DAYS, 7),
      prefix: env.INVOICE_PREFIX || 'INV',
    },
  };
}
