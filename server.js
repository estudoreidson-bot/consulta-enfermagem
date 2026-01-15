// server.js
// Integração InfinitePay (Checkout) com link automático, webhook e liberação automática.
// Variáveis de ambiente esperadas:
// - INFINITEPAY_HANDLE (obrigatória): sua InfiniteTag (sem o "$ ").
// - ALLOWED_ORIGIN (opcional): restringe CORS ao domínio do frontend (ex.: https://consulta-enfermagem.pages.dev).
// - INFINITEPAY_WEBHOOK_SECRET (opcional): placeholder para validação de assinatura do webhook (se você configurar/receber).
// - DATABASE_URL (opcional): se existir e o pacote "pg" estiver instalado, usa Postgres; caso contrário usa arquivo local db.json.
// - PUBLIC_BASE_URL (opcional): URL pública do backend (Render). Se não houver, o servidor tenta inferir pelo Host da requisição.
// Observação: o endpoint de geração de link usa o formato oficial do Checkout (API pública) conforme documentação da InfinitePay.

"use strict";

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const https = require("https");

const app = express();
app.set("trust proxy", true);

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = String(process.env.ALLOWED_ORIGIN || "").trim();
const INFINITEPAY_HANDLE = String(process.env.INFINITEPAY_HANDLE || "").trim();
const INFINITEPAY_WEBHOOK_SECRET = String(process.env.INFINITEPAY_WEBHOOK_SECRET || "").trim();
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

// -----------------------------
// CORS restrito
// -----------------------------
app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGIN) return cb(null, true);
    if (!origin) return cb(null, true);
    if (origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(null, false);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Device-Id",
    "X-Infinitepay-Signature",
    "X-Webhook-Signature",
    "X-Signature"
  ],
}));

// Captura rawBody para validação opcional de assinatura do webhook
app.use(bodyParser.json({
  limit: "2mb",
  verify: (req, res, buf) => {
    try { req.rawBody = buf; } catch {}
  }
}));

// -----------------------------
// Rate limit simples em memória
// -----------------------------
const RL = new Map();
function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    try {
      const now = Date.now();
      const key = String((keyFn ? keyFn(req) : (req.ip || "ip")) || "k");
      const entry = RL.get(key);
      if (!entry || now > entry.resetAt) {
        RL.set(key, { count: 1, resetAt: now + windowMs });
        return next();
      }
      entry.count += 1;
      if (entry.count > max) return res.status(429).json({ error: "Requisição excessiva." });
      return next();
    } catch {
      return res.status(429).json({ error: "Requisição excessiva." });
    }
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RL.entries()) {
    if (!v || now > v.resetAt + 60000) RL.delete(k);
  }
}, 60000).unref();

// -----------------------------
// Sanitização CPF
// -----------------------------
function cpfDigits(v) {
  return String(v || "").replace(/\D+/g, "");
}
function sanitizeCpfOrNull(v) {
  const d = cpfDigits(v);
  if (!d || d.length !== 11) return null;
  return d;
}
function nowIso() {
  return new Date().toISOString();
}
function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

// -----------------------------
// Persistência: Postgres (se possível) ou db.json
// -----------------------------
const DB_FILE = path.join(__dirname, "db.json");
let fileDb = { users: [] };

function loadFileDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const txt = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.users)) fileDb = parsed;
  } catch {
  }
}
function saveFileDb() {
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(fileDb, null, 2), "utf8");
    fs.renameSync(tmp, DB_FILE);
  } catch {
  }
}

let pgPool = null;
let pgEnabled = false;

async function initPostgresIfPossible() {
  if (!DATABASE_URL) return;
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch {
    return;
  }
  try {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        cpf TEXT UNIQUE NOT NULL,
        nome TEXT NOT NULL DEFAULT '',
        status_pagamento TEXT NOT NULL DEFAULT 'PENDENTE',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    pgEnabled = true;
  } catch {
    pgEnabled = false;
    pgPool = null;
  }
}

async function dbGetUserByCpf(cpf) {
  if (pgEnabled && pgPool) {
    const r = await pgPool.query("SELECT id, cpf, nome, status_pagamento, updated_at FROM users WHERE cpf=$1 LIMIT 1", [cpf]);
    return r.rows[0] || null;
  }
  const u = fileDb.users.find(x => x && x.cpf === cpf) || null;
  return u ? { ...u } : null;
}

async function dbUpsertUser({ cpf, nome }) {
  const safeNome = String(nome || "").trim().slice(0, 120);
  if (pgEnabled && pgPool) {
    const id = makeId("usr");
    const r = await pgPool.query(`
      INSERT INTO users (id, cpf, nome, status_pagamento, updated_at)
      VALUES ($1,$2,$3,'PENDENTE',NOW())
      ON CONFLICT (cpf) DO UPDATE
        SET nome = CASE WHEN EXCLUDED.nome <> '' THEN EXCLUDED.nome ELSE users.nome END,
            updated_at = NOW()
      RETURNING id, cpf, nome, status_pagamento, updated_at
    `, [id, cpf, safeNome]);
    return r.rows[0];
  }

  const existing = fileDb.users.find(x => x && x.cpf === cpf);
  if (existing) {
    if (safeNome) existing.nome = safeNome;
    existing.updated_at = nowIso();
    saveFileDb();
    return { ...existing };
  }
  const user = {
    id: makeId("usr"),
    cpf,
    nome: safeNome || "",
    status_pagamento: "PENDENTE",
    updated_at: nowIso(),
  };
  fileDb.users.push(user);
  saveFileDb();
  return { ...user };
}

async function dbSetPaymentStatus(cpf, status) {
  const st = (status === "PAGO") ? "PAGO" : "PENDENTE";
  if (pgEnabled && pgPool) {
    const r = await pgPool.query(`
      UPDATE users SET status_pagamento=$2, updated_at=NOW()
      WHERE cpf=$1
      RETURNING id, cpf, nome, status_pagamento, updated_at
    `, [cpf, st]);
    if (r.rowCount) return r.rows[0];
    const created = await dbUpsertUser({ cpf, nome: "" });
    await pgPool.query("UPDATE users SET status_pagamento=$2, updated_at=NOW() WHERE cpf=$1", [cpf, st]);
    return { ...created, status_pagamento: st, updated_at: nowIso() };
  }

  const existing = fileDb.users.find(x => x && x.cpf === cpf);
  if (existing) {
    existing.status_pagamento = st;
    existing.updated_at = nowIso();
    saveFileDb();
    return { ...existing };
  }
  const created = await dbUpsertUser({ cpf, nome: "" });
  const e2 = fileDb.users.find(x => x && x.cpf === cpf);
  if (e2) {
    e2.status_pagamento = st;
    e2.updated_at = nowIso();
    saveFileDb();
  }
  return created;
}

// -----------------------------
// HTTP helper (InfinitePay API)
// -----------------------------
function httpsPostJson(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}), "utf8");
    const u = new URL(url);

    const req = https.request({
      method: "POST",
      hostname: u.hostname,
      path: u.pathname + u.search,
      port: u.port || 443,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "User-Agent": "consulta-enfermagem/1.0",
        ...extraHeaders,
      },
      timeout: 12000,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(txt); } catch {}
        resolve({ status: res.statusCode || 0, json, text: txt });
      });
    });

    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function inferBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https");
  const host = req.headers["x-forwarded-host"] || req.get("host");
  if (!host) return "";
  return String(proto) + "://" + String(host);
}

function pickPaymentUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  const candidates = [
    obj.paymentUrl, obj.payment_url,
    obj.checkoutUrl, obj.checkout_url,
    obj.url, obj.link, obj.href,
    obj && obj.data ? obj.data.payment_url : undefined,
    obj && obj.data ? obj.data.paymentUrl : undefined,
    obj && obj.data ? obj.data.url : undefined,
    obj && obj.data ? obj.data.checkout_url : undefined,
  ].filter(Boolean).map(String);
  const first = candidates.find(u => /^https?:\/\//i.test(u));
  return first || "";
}

// -----------------------------
// Rotas exigidas
// -----------------------------

// GET /api/payment/link?cpf=...&nome=...
app.get("/api/payment/link",
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    keyFn: (req) => "paylink:" + (req.ip || "ip") + ":" + cpfDigits(req.query && req.query.cpf),
  }),
  async (req, res) => {
    try {
      if (!INFINITEPAY_HANDLE) return res.status(500).json({ error: "Falha ao gerar pagamento." });

      const cpf = sanitizeCpfOrNull(req.query && req.query.cpf);
      if (!cpf) return res.status(400).json({ error: "Parâmetro inválido." });

      const nome = String((req.query && req.query.nome) || "").trim();
      await dbUpsertUser({ cpf, nome });

      // order_nsu: usa CPF + timestamp + sufixo aleatório (para rastreio no webhook)
      const orderNsu = `${cpf}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

      // Webhook URL: recomendável incluir para confirmação automática
      const baseUrl = inferBaseUrl(req);
      const webhookUrl = baseUrl ? (baseUrl + "/webhook/infinitepay") : undefined;

      // redirect_url opcional: se ALLOWED_ORIGIN estiver definido, usa como retorno
      const redirectUrl = ALLOWED_ORIGIN ? (ALLOWED_ORIGIN.replace(/\/+$/, "") + "/") : undefined;

      // Valor padrão (em centavos). Exemplo: R$ 25,00 => 2500
      const amountCents = 2500;

      // Formato oficial (Checkout) da InfinitePay:
      // POST https://api.infinitepay.io/invoices/public/checkout/links
      const payload = {
        handle: INFINITEPAY_HANDLE,
        order_nsu: orderNsu,
        items: [
          { quantity: 1, price: amountCents, description: "Acesso - Pagamento" }
        ],
      };

      if (webhookUrl) payload.webhook_url = webhookUrl;
      if (redirectUrl) payload.redirect_url = redirectUrl;

      const r = await httpsPostJson("https://api.infinitepay.io/invoices/public/checkout/links", payload);
      if (r.status < 200 || r.status >= 300) return res.status(502).json({ error: "Falha ao gerar pagamento." });

      const paymentUrl = pickPaymentUrl(r.json) || pickPaymentUrl({ data: r.json }) || "";
      if (!paymentUrl) return res.status(502).json({ error: "Falha ao gerar pagamento." });

      await dbSetPaymentStatus(cpf, "PENDENTE");

      return res.json({ paymentUrl, reference: cpf, orderNsu });
    } catch {
      return res.status(500).json({ error: "Falha ao gerar pagamento." });
    }
  }
);

// GET /api/payment/status?cpf=...
app.get("/api/payment/status",
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyFn: (req) => "status:" + (req.ip || "ip") + ":" + cpfDigits(req.query && req.query.cpf),
  }),
  async (req, res) => {
    try {
      const cpf = sanitizeCpfOrNull(req.query && req.query.cpf);
      if (!cpf) return res.status(400).json({ error: "Parâmetro inválido." });

      const u = await dbGetUserByCpf(cpf);
      const status = (u && u.status_pagamento === "PAGO") ? "PAGO" : "PENDENTE";
      return res.json({ cpf, status });
    } catch {
      return res.status(500).json({ error: "Falha ao consultar status." });
    }
  }
);

// POST /webhook/infinitepay
app.post("/webhook/infinitepay",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    keyFn: (req) => "wh:" + (req.ip || "ip"),
  }),
  async (req, res) => {
    try {
      // Validação condicional de assinatura (placeholder):
      // Se você tiver um segredo configurado, o webhook deve trazer uma assinatura em algum header.
      if (INFINITEPAY_WEBHOOK_SECRET) {
        const sigHeader =
          String(req.get("x-infinitepay-signature") || req.get("x-webhook-signature") || req.get("x-signature") || "").trim();

        if (!sigHeader) return res.status(400).json({ error: "Payload inválido." });

        const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), "utf8");
        const macHex = crypto.createHmac("sha256", INFINITEPAY_WEBHOOK_SECRET).update(raw).digest("hex");

        const safeEq = (a, b) => {
          try {
            const A = Buffer.from(String(a || ""), "utf8");
            const B = Buffer.from(String(b || ""), "utf8");
            if (A.length !== B.length) return false;
            return crypto.timingSafeEqual(A, B);
          } catch { return false; }
        };

        const normalized = sigHeader.replace(/^sha256=/i, "").trim();
        if (!safeEq(normalized, macHex)) return res.status(400).json({ error: "Payload inválido." });
      }

      // Validação mínima do payload (formato esperado pelo Checkout)
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const invoiceSlug = String(b.invoice_slug || "").trim();
      const transactionNsu = String(b.transaction_nsu || "").trim();
      const orderNsu = String(b.order_nsu || "").trim();
      const paidAmount = Number(b.paid_amount);

      if (!invoiceSlug || !transactionNsu || !orderNsu) return res.status(400).json({ error: "Payload inválido." });
      if (!Number.isFinite(paidAmount) || paidAmount <= 0) return res.status(400).json({ error: "Payload inválido." });

      // order_nsu contém o CPF no prefixo (11 dígitos)
      const cpf = sanitizeCpfOrNull(orderNsu.slice(0, 11));
      if (!cpf) return res.status(400).json({ error: "Payload inválido." });

      await dbSetPaymentStatus(cpf, "PAGO");

      return res.status(200).json({ ok: true });
    } catch {
      return res.status(400).json({ error: "Payload inválido." });
    }
  }
);

// -----------------------------
// Static (index.html no root)
// -----------------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => res.json({ ok: true }));

(async () => {
  loadFileDb();
  await initPostgresIfPossible();

  app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
  });
})();
