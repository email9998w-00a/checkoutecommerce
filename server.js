import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const BLACKCAT_URL = (process.env.BLACKCAT_URL || 'https://api.blackcatoficial.com/api').replace(/\/$/, '');
const BLACKCAT_API_KEY = process.env.BLACKCAT_API_KEY;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '*';
const POSTBACK_URL = process.env.POSTBACK_URL || '';

if (!BLACKCAT_API_KEY) console.warn('BLACKCAT_API_KEY não configurada: criação de PIX ficará indisponível.');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://connect.facebook.net'], scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'], imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://viacep.com.br', 'https://connect.facebook.net'],
      fontSrc: ["'self'", 'https:', 'data:'], formAction: ["'self'"], upgradeInsecureRequests: []
    }
  }
}));
app.use(cors({ origin: PUBLIC_ORIGIN === '*' ? true : PUBLIC_ORIGIN }));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));

const digits = value => String(value ?? '').replace(/\D/g, '');
const DEFAULT_TEST_PHONE = digits(process.env.DEFAULT_TEST_PHONE || '');
const clean = value => String(value ?? '').trim().slice(0, 200);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());
function validCpf(value) {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let d1 = (sum * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== Number(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  let d2 = (sum * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === Number(cpf[10]);
}
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw new Error('Itens inválidos');
  return items.map(item => {
    const quantity = Math.max(1, Math.min(999, Number(item.quantity || 1)));
    const unitPrice = Math.round(Number(item.price ?? item.unitPrice ?? 0) * 100);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('Item inválido');
    return { title: 'Compra Online', unitPrice, quantity, tangible: Boolean(item.tangible) };
  });
}

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/create-pix', async (req, res) => {
  try {
    if (!BLACKCAT_API_KEY) return res.status(503).json({ error: 'Gateway não configurado' });
    const body = req.body || {};
    const customer = body.customer || {};
    const name = clean(customer.name);
    const email = clean(customer.email);
    const cpf = digits(customer.cpf || customer.document);
    const phone = DEFAULT_TEST_PHONE;
    if (name.split(/\s+/).filter(Boolean).length < 2) throw new Error('Nome inválido');
    if (!validEmail(email)) throw new Error('E-mail inválido');
    if (!validCpf(cpf)) throw new Error('CPF inválido');
    const items = normalizeItems(body.order?.items || body.items);
    const amount = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) + Math.round(Number(body.order?.shipping || 0) * 100);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Valor inválido');
    const externalRef = `WEB-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const tangible = items.some(item => item.tangible);
    const payload = {
      amount, currency: 'BRL', paymentMethod: 'pix', items,
      customer: { name, email, phone, document: { number: cpf, type: 'cpf' } },
      pix: { expiresInDays: 1 }, externalRef,
      ...(POSTBACK_URL ? { postbackUrl: POSTBACK_URL } : {})
    };
    if (tangible) {
      const s = body.shipping || {};
      payload.shipping = { name, street: clean(s.street), number: clean(s.number), complement: clean(s.complement), neighborhood: clean(s.neighborhood), city: clean(s.city), state: clean(s.state).slice(0, 2).toUpperCase(), zipCode: digits(s.zipCode) };
      if (!payload.shipping.street || !payload.shipping.number || !payload.shipping.neighborhood || !payload.shipping.city || payload.shipping.state.length !== 2 || payload.shipping.zipCode.length !== 8) throw new Error('Endereço de entrega incompleto');
    }
    const upstream = await fetch(`${BLACKCAT_URL}/sales/create-sale`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': BLACKCAT_API_KEY }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok || result.success === false) {
      console.error('Blackcat create-sale:', upstream.status, result?.message || result?.error || 'erro');
      return res.status(502).json({ error: 'Não foi possível gerar o PIX' });
    }
    const data = result.data || result;
    const paymentData = data.paymentData || {};
    const copyPaste = paymentData.copyPaste || paymentData.copiaECola || paymentData.pixCopyPaste || paymentData.qrCode || data.copyPaste || data.qrCode || '';
    let qrCodeImage = paymentData.qrCodeBase64 || paymentData.qrCodeImage || paymentData.qr_image || data.qrCodeBase64 || '';
    if (qrCodeImage && !String(qrCodeImage).startsWith('data:image/')) qrCodeImage = `data:image/png;base64,${qrCodeImage}`;
    if (!qrCodeImage && copyPaste) qrCodeImage = await QRCode.toDataURL(copyPaste, { errorCorrectionLevel: 'M', margin: 1, width: 512 });
    return res.status(201).json({ transaction_id: data.transactionId, pix_qrcode_image: qrCodeImage, pix_copy_paste: copyPaste, expires_at: paymentData.expiresAt, status: data.status });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Dados inválidos' });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    if (!BLACKCAT_API_KEY) return res.status(503).json({ error: 'Gateway não configurado' });
    const id = clean(req.query.transaction_id);
    if (!/^[A-Za-z0-9_-]{3,120}$/.test(id)) return res.status(400).json({ error: 'Transação inválida' });
    const upstream = await fetch(`${BLACKCAT_URL}/sales/${encodeURIComponent(id)}/status`, { headers: { 'X-API-Key': BLACKCAT_API_KEY }, signal: AbortSignal.timeout(10_000) });
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return res.status(502).json({ error: 'Não foi possível consultar o PIX' });
    return res.json({ status: result.data?.status || result.status });
  } catch { return res.status(502).json({ error: 'Não foi possível consultar o PIX' }); }
});
app.post('/webhook/payment', (req, res) => { console.log('Blackcat webhook recebido', req.headers['x-webhook-event'], req.body?.transactionId); return res.sendStatus(200); });
app.listen(PORT, '0.0.0.0', () => console.log(`PIX proxy listening on ${PORT}`));
