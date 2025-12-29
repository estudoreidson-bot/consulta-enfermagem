// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
const port = process.env.PORT || 3000;

// Configurações básicas
app.use(cors());
app.use(bodyParser.json());

// Servir o index.html (útil para testes locais)
app.use(express.static(path.join(__dirname)));

// Cliente OpenAI usando a variável de ambiente do Render
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Função genérica para chamar o modelo e retornar o texto
async function callOpenAI(prompt) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || "";
  return content.trim();
}

// Função para obter JSON do modelo com fallback (extrai o primeiro bloco {...})
async function callOpenAIJson(prompt) {
  const raw = await callOpenAI(prompt);

  try {
    return JSON.parse(raw);
  } catch (e) {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
      return JSON.parse(jsonSlice);
    }
    throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
  }
}

// Função para chamar o modelo com imagem (data URL) e retornar JSON
async function callOpenAIVisionJson(prompt, imagemDataUrl) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imagemDataUrl } }
        ]
      }
    ]
  });

  const raw = (completion.choices?.[0]?.message?.content || "").trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
      return JSON.parse(jsonSlice);
    }
    throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
  }
}

// Pequena validação para limitar tamanho e evitar abusos
function normalizeText(input, maxLen) {
  const s = (typeof input === "string" ? input : "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function normalizeImageDataUrl(input, maxLen) {
  const s = (typeof input === "string" ? input : "").trim();
  if (!s) return "";
  // Aceita apenas data URLs de imagem e limita tamanho para reduzir abuso
  if (!s.startsWith("data:image/")) return "";
  return s.length > maxLen ? "" : s;
}

function getImageDataUrlFromBody(body) {
  const b = body || {};
  // Aceita tanto o padrão interno (imagem_data_url) quanto o usado no frontend (image_data_url).
  return (typeof b.imagem_data_url === "string" && b.imagem_data_url.trim())
    ? b.imagem_data_url.trim()
    : (typeof b.image_data_url === "string" && b.image_data_url.trim())
      ? b.image_data_url.trim()
      : "";
}

function normalizeArrayOfStrings(arr, maxItems, maxLenEach) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    out.push(t.length > maxLenEach ? t.slice(0, maxLenEach) : t);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ======================================================================
// BASE INTERNA (CURADA) – APRESENTAÇÕES E DOSAGEM MÁXIMA
// Observação: esta base existe apenas para melhorar consistência quando o
// modelo não retornar dados completos. Não é exibida ao usuário.
// ======================================================================

function getKnownPresentationsMaxDose(medicamentoOriginal) {
  const med = String(medicamentoOriginal || "").trim().toLowerCase();
  if (!med) return null;

  // Vitamina D (colecalciferol)
  if (med.includes("vitamina d") || med.includes("colecalciferol") || med.includes("colecalciferol") || med.includes("cholecalciferol")) {
    return {
      apresentacoes: {
        comprimido_simples: "não disponível",
        comprimido_revestido: "1.000 UI; 2.000 UI; 7.000 UI",
        capsula: "1.000 UI; 2.000 UI; 5.000 UI; 7.000 UI; 10.000 UI; 50.000 UI",
        suspensao_oral: "não disponível",
        gotas: "solução oral em gotas (ex.: 200 UI/gota; frascos 10 mL ou 20 mL)",
        solucao_oral: "solução oral em gotas (ex.: 200 UI/gota)",
        solucao_injetavel: "não disponível",
        endovenosa: "não disponível",
        intramuscular: "não disponível",
      },
      dosagem_maxima_diaria: "4.000 UI/dia (adulto)"
    };
  }

  // Sulfato ferroso (ferro oral)
  // Atenção: outras formas de ferro (ex.: sacarato, ferripolimaltose) são medicamentos distintos.
  if (med.includes("sulfato ferroso") || med.includes("ferro (sulfato ferroso)") || med === "ferro") {
    return {
      apresentacoes: {
        comprimido_simples: "não disponível",
        comprimido_revestido: "40 mg de ferro elementar/comprimido (padrão SUS)",
        capsula: "não informado",
        suspensao_oral: "xarope (ex.: 5 mg/mL de ferro elementar)",
        gotas: "solução oral em gotas (ex.: 25 mg/mL de ferro elementar; 1 mg/gota)",
        solucao_oral: "solução oral (ex.: 25 mg/mL de ferro elementar)",
        solucao_injetavel: "não disponível",
        endovenosa: "não disponível",
        intramuscular: "não disponível",
      },
      dosagem_maxima_diaria: "200 mg/dia de ferro elementar (adulto)"
    };
  }

  return null;
}

// ======================================================================
// AUTENTICAÇÃO E PAINEL ADMIN (ENFERMAGEM) – LOGIN ÚNICO (SEM SELEÇÃO DE PERFIL)
// ======================================================================

// Credenciais fixas do administrador (podem ser sobrescritas por variáveis de ambiente)
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || "027-315-125-80";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "39-96-93";

// Persistência simples em JSON (append-only para pagamentos e auditoria via API)
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "enfermagem_users_db.json");

function ensureDataStore() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: [], payments: [], audit: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), "utf-8");
  }
}

function loadDb() {
  ensureDataStore();
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    if (!parsed.users) parsed.users = [];
    if (!parsed.payments) parsed.payments = [];
    if (!parsed.audit) parsed.audit = [];
    return parsed;
  } catch (e) {
    const fallback = { users: [], payments: [], audit: [] };
    try { fs.writeFileSync(DB_PATH, JSON.stringify(fallback, null, 2), "utf-8"); } catch (_) {}
    return fallback;
  }
}

function saveDb(db) {
  ensureDataStore();
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf-8");
  fs.renameSync(tmp, DB_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

function monthKeyFromDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function currentMonthKey() {
  return monthKeyFromDate(new Date());
}

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeLogin(v) {
  return String(v || "").trim();
}

function normalizePassword(v) {
  return String(v || "");
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(password || ""), s, 64).toString("hex");
  return { salt: s, hash: h };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const h = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(expectedHash, "hex"));
}

// Sessões em memória (se reiniciar, precisa logar novamente)
const sessions = new Map();
// token -> { role: "admin"|"nurse", userId: string|null, login: string, issuedAt: string, expiresAt: number }

function createSession(role, userId, login) {
  const token = crypto.randomBytes(32).toString("hex");
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (7 * 24 * 60 * 60 * 1000); // 7 dias
  sessions.set(token, { role, userId, login, issuedAt: new Date(issuedAt).toISOString(), expiresAt });
  return token;
}

function getSessionFromReq(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return { token, session: s };
}

function isOnline(lastSeenAtIso) {
  if (!lastSeenAtIso) return false;
  const t = Date.parse(lastSeenAtIso);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) <= (5 * 60 * 1000); // 5 minutos
}

function isPaidForMonth(db, userId, monthKey) {
  const mk = monthKey || currentMonthKey();
  return db.payments.some(p => p && p.userId === userId && p.month === mk);
}

function audit(db, adminLogin, action, targetUserId, details) {
  db.audit.push({
    id: randomId(),
    at: nowIso(),
    adminLogin: String(adminLogin || ""),
    action: String(action || ""),
    targetUserId: targetUserId || null,
    details: details || null
  });
}

// Rotas públicas de autenticação
app.post("/api/auth/login", (req, res) => {
  try {
    const login = normalizeLogin(req.body && req.body.login);
    const password = normalizePassword(req.body && req.body.password);

    if (!login || !password) {
      return res.status(400).json({ error: "Login e senha são obrigatórios." });
    }

    // Admin (credenciais fixas)
    if (login === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
      const token = createSession("admin", null, login);
      return res.json({ token, role: "admin", user: { id: null, fullName: "Administrador", login } });
    }

    const db = loadDb();
    const user = db.users.find(u => u && !u.deletedAt && u.login === login);
    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }
    if (user.active === false) {
      return res.status(403).json({ error: "Usuário desativado." });
    }
    if (!verifyPassword(password, user.salt, user.passwordHash)) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    user.lastLoginAt = nowIso();
    user.lastSeenAt = nowIso();
    user.updatedAt = nowIso();
    saveDb(db);

    const token = createSession("nurse", user.id, login);
    const paidCurrentMonth = isPaidForMonth(db, user.id, currentMonthKey());

    return res.json({
      token,
      role: "nurse",
      user: {
        id: user.id,
        fullName: user.fullName,
        dob: user.dob,
        phone: user.phone,
        login: user.login,
        active: user.active !== false,
        paidCurrentMonth,
        lastLoginAt: user.lastLoginAt,
        lastSeenAt: user.lastSeenAt
      }
    });
  } catch (e) {
    console.error("Erro em /api/auth/login:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/auth/me", (req, res) => {
  const s = getSessionFromReq(req);
  if (!s) return res.status(401).json({ error: "Não autenticado." });

  if (s.session.role === "admin") {
    return res.json({ role: "admin", user: { id: null, fullName: "Administrador", login: s.session.login } });
  }

  const db = loadDb();
  const user = db.users.find(u => u && u.id === s.session.userId && !u.deletedAt);
  if (!user) return res.status(401).json({ error: "Sessão inválida." });

  user.lastSeenAt = nowIso();
  saveDb(db);

  return res.json({
    role: "nurse",
    user: {
      id: user.id,
      fullName: user.fullName,
      dob: user.dob,
      phone: user.phone,
      login: user.login,
      active: user.active !== false,
      paidCurrentMonth: isPaidForMonth(db, user.id, currentMonthKey()),
      lastLoginAt: user.lastLoginAt || null,
      lastSeenAt: user.lastSeenAt || null
    }
  });
});

app.post("/api/auth/logout", (req, res) => {
  const s = getSessionFromReq(req);
  if (s) sessions.delete(s.token);
  return res.json({ ok: true });
});

app.post("/api/auth/heartbeat", (req, res) => {
  const s = getSessionFromReq(req);
  if (!s) return res.status(401).json({ error: "Não autenticado." });

  if (s.session.role === "nurse") {
    const db = loadDb();
    const user = db.users.find(u => u && u.id === s.session.userId && !u.deletedAt);
    if (user) {
      user.lastSeenAt = nowIso();
      user.updatedAt = nowIso();
      saveDb(db);
    }
  }

  return res.json({ ok: true });
});

// Gate: protege todo /api/* (exceto /api/auth/* e /api/health)
function apiAuthGate(req, res, next) {
  if (req.path.startsWith("/auth/")) return next();
  if (req.path === "/health") return next();

  const s = getSessionFromReq(req);
  if (!s) return res.status(401).json({ error: "Não autenticado." });

  req._session = s.session;

  // Admin-only
  if (req.path.startsWith("/admin/")) {
    if (s.session.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao administrador." });
    return next();
  }

  // Nurse-only
  if (s.session.role !== "nurse") return res.status(403).json({ error: "Acesso restrito." });

  // Bloqueio por mensalidade (somente para rotas operacionais)
  const operational = !req.path.startsWith("/auth/") && !req.path.startsWith("/admin/");
  if (operational) {
    const db = loadDb();
    const paid = isPaidForMonth(db, s.session.userId, currentMonthKey());
    if (!paid) return res.status(402).json({ error: "Mensalidade em atraso. Acesso operacional bloqueado." });
  }

  return next();
}

app.use("/api", apiAuthGate);

// Painel Admin: CRUD de enfermeiros + pagamentos (append-only) + auditoria
app.get("/api/admin/stats", (req, res) => {
  const db = loadDb();
  const users = db.users.filter(u => u && !u.deletedAt);
  const active = users.filter(u => u.active !== false);
  const month = currentMonthKey();
  const paid = active.filter(u => isPaidForMonth(db, u.id, month));
  const online = active.filter(u => isOnline(u.lastSeenAt));
  return res.json({
    totals: {
      users: users.length,
      active: active.length,
      online: online.length,
      paidCurrentMonth: paid.length,
      unpaidCurrentMonth: active.length - paid.length
    },
    month
  });
});

app.get("/api/admin/users", (req, res) => {
  const db = loadDb();
  const q = String((req.query && req.query.q) || "").trim().toLowerCase();
  const month = currentMonthKey();
  let users = db.users.filter(u => u && !u.deletedAt);

  if (q) {
    users = users.filter(u =>
      String(u.fullName || "").toLowerCase().includes(q) ||
      String(u.login || "").toLowerCase().includes(q) ||
      String(u.phone || "").toLowerCase().includes(q)
    );
  }

  const out = users.map(u => ({
    id: u.id,
    fullName: u.fullName,
    dob: u.dob,
    phone: u.phone,
    login: u.login,
    active: u.active !== false,
    createdAt: u.createdAt || null,
    updatedAt: u.updatedAt || null,
    lastLoginAt: u.lastLoginAt || null,
    lastSeenAt: u.lastSeenAt || null,
    online: isOnline(u.lastSeenAt),
    paidCurrentMonth: isPaidForMonth(db, u.id, month)
  }));

  return res.json({ month, users: out });
});

app.post("/api/admin/users", (req, res) => {
  try {
    const db = loadDb();
    const fullName = String(req.body && req.body.fullName || "").trim();
    const dob = String(req.body && req.body.dob || "").trim(); // DD/MM/AAAA ou AAAA-MM-DD
    const phone = String(req.body && req.body.phone || "").trim();
    const login = normalizeLogin(req.body && req.body.login);
    const password = normalizePassword(req.body && req.body.password);

    if (!fullName || !dob || !phone || !login || !password) {
      return res.status(400).json({ error: "Campos obrigatórios: nome completo, data de nascimento, telefone, login e senha." });
    }

    if (db.users.some(u => u && !u.deletedAt && u.login === login)) {
      return res.status(409).json({ error: "Login já existe." });
    }

    const id = randomId();
    const { salt, hash } = hashPassword(password);
    const user = {
      id,
      fullName,
      dob,
      phone,
      login,
      salt,
      passwordHash: hash,
      active: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: null,
      lastSeenAt: null,
      deletedAt: null
    };

    db.users.push(user);
    audit(db, req._session.login, "CREATE_USER", id, { fullName, dob, phone, login });
    saveDb(db);

    return res.json({ ok: true, user: { id, fullName, dob, phone, login, active: true } });
  } catch (e) {
    console.error("Erro em /api/admin/users (POST):", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

app.patch("/api/admin/users/:id", (req, res) => {
  try {
    const db = loadDb();
    const id = String(req.params.id || "").trim();
    const user = db.users.find(u => u && u.id === id && !u.deletedAt);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const patch = {};
    if (typeof req.body.active === "boolean") patch.active = req.body.active;
    if (typeof req.body.fullName === "string" && req.body.fullName.trim()) patch.fullName = req.body.fullName.trim();
    if (typeof req.body.dob === "string" && req.body.dob.trim()) patch.dob = req.body.dob.trim();
    if (typeof req.body.phone === "string" && req.body.phone.trim()) patch.phone = req.body.phone.trim();

    if (typeof req.body.password === "string" && req.body.password) {
      const { salt, hash } = hashPassword(req.body.password);
      patch.salt = salt;
      patch.passwordHash = hash;
    }

    Object.assign(user, patch);
    user.updatedAt = nowIso();
    audit(db, req._session.login, "UPDATE_USER", id, patch);
    saveDb(db);

    return res.json({ ok: true });
  } catch (e) {
    console.error("Erro em /api/admin/users/:id (PATCH):", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

app.delete("/api/admin/users/:id", (req, res) => {
  try {
    const db = loadDb();
    const id = String(req.params.id || "").trim();
    const user = db.users.find(u => u && u.id === id && !u.deletedAt);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    user.active = false;
    user.deletedAt = nowIso();
    user.updatedAt = nowIso();
    audit(db, req._session.login, "DELETE_USER", id, { login: user.login });

    saveDb(db);
    return res.json({ ok: true });
  } catch (e) {
    console.error("Erro em /api/admin/users/:id (DELETE):", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/admin/users/:id/payments", (req, res) => {
  const db = loadDb();
  const id = String(req.params.id || "").trim();
  const user = db.users.find(u => u && u.id === id && !u.deletedAt);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

  const payments = db.payments
    .filter(p => p && p.userId === id)
    .sort((a, b) => String(b.paidAt || "").localeCompare(String(a.paidAt || "")));

  return res.json({ user: { id: user.id, fullName: user.fullName, login: user.login }, payments });
});

app.post("/api/admin/users/:id/pay", (req, res) => {
  try {
    const db = loadDb();
    const id = String(req.params.id || "").trim();
    const user = db.users.find(u => u && u.id === id && !u.deletedAt);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const month = String((req.body && req.body.month) || currentMonthKey()).trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Mês inválido. Use AAAA-MM." });
    }

    if (db.payments.some(p => p && p.userId === id && p.month === month)) {
      return res.status(409).json({ error: "Este mês já consta como pago." });
    }

    const rec = {
      id: randomId(),
      userId: id,
      month,
      paidAt: nowIso(),
      amount: (req.body && req.body.amount != null) ? String(req.body.amount) : null,
      method: (req.body && req.body.method) ? String(req.body.method) : null,
      note: (req.body && req.body.note) ? String(req.body.note) : null,
      adminLogin: req._session.login
    };

    db.payments.push(rec);
    audit(db, req._session.login, "MARK_PAID", id, { month, amount: rec.amount, method: rec.method, note: rec.note });
    saveDb(db);

    return res.json({ ok: true, payment: rec });
  } catch (e) {
    console.error("Erro em /api/admin/users/:id/pay:", e);
    return res.status(500).json({ error: "Erro interno." });
  }
});

app.get("/api/admin/audit", (req, res) => {
  const db = loadDb();
  const auditLog = (db.audit || []).slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return res.json({ audit: auditLog });
});


// ======================================================================
// ROTA 1 – GERAR SOAP E PRESCRIÇÃO A PARTIR DA TRANSCRIÇÃO (EXISTENTE)
// ======================================================================

app.post("/api/gerar-soap", async (req, res) => {
  try {
    const { transcricao } = req.body || {};

    if (!transcricao || !String(transcricao).trim()) {
      return res.status(400).json({ error: "O campo 'transcricao' é obrigatório." });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);

    const prompt = `
Você é um enfermeiro humano escrevendo documentação clínica a partir da transcrição integral de um atendimento (português do Brasil).
Seu usuário é sempre um enfermeiro (enfermagem na APS ou pronto atendimento).

Tarefa:
1) Gere uma EVOLUÇÃO em SOAP com foco de enfermagem, concisa e operacional.
2) Gere um PLANO DE CUIDADOS (prescrição de enfermagem), com itens objetivos, monitorização, educação em saúde e critérios claros para escalar para avaliação médica.

Regras obrigatórias:
- Não invente dados. Se faltar informação, registre como "não informado" ou "não foi referido".
- Sem emojis, sem símbolos gráficos (como ✓, ❌, bullets com ícones).
- Não faça diagnóstico médico definitivo. Foque em achados, hipóteses de enfermagem e condutas de enfermagem.
- Use linguagem prática para colar no sistema.
- Mantenha o texto seguro: inclua sinais de alarme e critérios de encaminhamento quando pertinente.

Formato de saída: JSON estrito, sem texto fora do JSON, com as chaves:
{
  "soap": "S: ...\nO: ...\nA: ...\nP: ...",
  "prescricao": "Plano de cuidados em texto corrido ou itens numerados"
}

Conteúdo mínimo esperado:
SOAP:
- S: queixa, início, sintomas associados, fatores de risco, alergias relevantes se citadas, medicações em uso se citadas.
- O: sinais vitais se presentes, exame objetivo descrito, achados relevantes, contexto (gestante/lactante quando aplicável).
- A: avaliação de enfermagem (problemas/necessidades), riscos (queda, LPP, desidratação etc) quando pertinentes.
- P: intervenções e orientações de enfermagem, monitorização, encaminhamentos, retorno, sinais de alarme.

PLANO DE CUIDADOS (prescrição de enfermagem):
- Monitorização (o que medir e quando).
- Cuidados diretos (hidratação, curativo, higiene, posicionamento, mobilidade, prevenção de quedas/LPP quando aplicável).
- Educação em saúde (orientações e checagem de compreensão).
- Retorno/reavaliação (quando e com quais critérios).
- Critérios objetivos para escalar ao médico.

Transcrição:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);

    const soap = typeof data?.soap === "string" ? data.soap.trim() : "";
    const prescricao = typeof data?.prescricao === "string" ? data.prescricao.trim() : "";

    return res.json({ soap, prescricao });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar evolução/plano de cuidados." });
  }
});




// ======================================================================
// ROTA 2 – RECOMENDAÇÕES DE PERGUNTAS COMPLEMENTARES (ANAMNESE) (EXISTENTE)
// ======================================================================

app.post("/api/recomendacoes-anamnese", async (req, res) => {
  try {
    const { soap } = req.body || {};
    if (!soap || !String(soap).trim()) {
      return res.json({ perguntas: [] });
    }

    const safeSoap = normalizeText(soap, 10000);

    const prompt = `
Você é um enfermeiro humano. A partir do SOAP atual, gere perguntas complementares objetivas para melhorar a avaliação de enfermagem.
As perguntas devem ser guiadas por cenário, priorizando segurança, sinais de alarme, monitorização e fatores de risco.

Regras:
- Sem emojis e sem símbolos gráficos.
- Perguntas curtas e práticas.
- No máximo 12 perguntas.
- Evite perguntas redundantes.

Formato de saída: JSON estrito:
{ "perguntas": ["...","..."] }

SOAP:
"""${safeSoap}"""
`;

    const data = await callOpenAIJson(prompt);
    const perguntas = normalizeArrayOfStrings(data?.perguntas, 12, 180);
    return res.json({ perguntas });
  } catch (e) {
    console.error(e);
    return res.json({ perguntas: [] });
  }
});




// ======================================================================
// ROTA 2.1 – ATUALIZAR SOAP E PRESCRIÇÃO A PARTIR DE PERGUNTAS/RESPOSTAS
// ======================================================================

app.post("/api/atualizar-soap-perguntas", async (req, res) => {
  try {
    const { soap_atual, perguntas_e_respostas, transcricao_base } = req.body || {};
    const safeSoap = normalizeText(soap_atual || "", 12000);
    const safeQa = Array.isArray(perguntas_e_respostas) ? perguntas_e_respostas : [];
    const safeTranscricao = normalizeText(transcricao_base || "", 20000);

    const qaText = safeQa
      .map((x, i) => {
        const p = normalizeText(x?.pergunta || "", 300);
        const r = normalizeText(x?.resposta || "", 600);
        return `Pergunta ${i + 1}: ${p}\nResposta ${i + 1}: ${r}`;
      })
      .join("\n\n");

    const prompt = `
Você é um enfermeiro humano atualizando a documentação do atendimento após novas respostas complementares.
Atualize:
1) SOAP (S/O/A/P) com foco de enfermagem.
2) Plano de cuidados (prescrição de enfermagem), mantendo-o objetivo e seguro.

Regras:
- Não invente dados.
- Sem emojis e sem símbolos gráficos.
- Não faça diagnóstico médico definitivo.

Formato de saída: JSON estrito:
{
  "soap": "S: ...\nO: ...\nA: ...\nP: ...",
  "prescricao": "Plano de cuidados atualizado"
}

SOAP atual:
"""${safeSoap}"""

Transcrição base (se necessário):
"""${safeTranscricao}"""

Novas perguntas e respostas:
"""${qaText}"""
`;

    const data = await callOpenAIJson(prompt);
    const soap = typeof data?.soap === "string" ? data.soap.trim() : safeSoap;
    const prescricao = typeof data?.prescricao === "string" ? data.prescricao.trim() : "";
    return res.json({ soap, prescricao });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao atualizar evolução." });
  }
});




// ======================================================================
// ROTA 3 – GERAR PRESCRIÇÃO HOSPITALAR A PARTIR DA TRANSCRIÇÃO (NOVA)
// ======================================================================

app.post("/api/prescricao-hospitalar", async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    if (!transcricao || !String(transcricao).trim()) {
      return res.json({ prescricao_hospitalar: "" });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);

    const prompt = `
Você é um enfermeiro humano. Gere uma PASSAGEM DE PLANTÃO no formato SBAR a partir da transcrição.

Regras:
- Sem emojis e sem símbolos gráficos.
- Seja objetivo e operacional.
- Não invente sinais vitais ou exames; use "não informado" quando faltar.

Formato de saída: JSON estrito:
{ "prescricao_hospitalar": "Situação: ...\nBackground: ...\nAvaliação: ...\nRecomendação: ..." }

Transcrição:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);
    const sbar = typeof data?.prescricao_hospitalar === "string" ? data.prescricao_hospitalar.trim() : "";
    return res.json({ prescricao_hospitalar: sbar });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar SBAR." });
  }
});




// ======================================================================
// ROTA 4 – CLASSIFICAR MEDICAMENTOS EM GESTAÇÃO E LACTAÇÃO (NOVA)
// ======================================================================

app.post("/api/classificar-gestacao-lactacao", async (req, res) => {
  try {
    const { contexto } = req.body || {};
    if (!contexto || !String(contexto).trim()) {
      return res.json({ sae: "", orientacoes: "" });
    }

    const safeContexto = normalizeText(contexto, 25000);

    const prompt = `
Você é um enfermeiro humano. A partir do contexto (transcrição + evolução + plano), gere:
1) SAE (Processo de Enfermagem) com 4 partes: Coleta de dados, Diagnósticos de Enfermagem sugeridos (com justificativa curta), Resultados esperados (metas), Intervenções (com frequência e critérios de reavaliação).
2) Orientações ao paciente (texto curto para entrega), com sinais de alarme e quando retornar.

Regras:
- Sem emojis e sem símbolos gráficos.
- Não invente dados.
- Linguagem prática e segura.

Formato de saída: JSON estrito:
{
  "sae": "Coleta de dados: ...\n\nDiagnósticos de enfermagem sugeridos: ...\n\nResultados esperados: ...\n\nIntervenções: ...",
  "orientacoes": "Orientações ao paciente: ...\n\nSinais de alerta: ...\n\nRetorno: ..."
}

Contexto:
"""${safeContexto}"""
`;

    const data = await callOpenAIJson(prompt);
    const sae = typeof data?.sae === "string" ? data.sae.trim() : "";
    const orientacoes = typeof data?.orientacoes === "string" ? data.orientacoes.trim() : "";
    return res.json({ sae, orientacoes });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar SAE/orientações." });
  }
});









// ======================================================================
// ROTA 4.15 – INTERAÇÕES MEDICAMENTOSAS ENTRE MEDICAMENTOS PRESCRITOS (NOVA)
// ======================================================================

app.post("/api/interacoes-medicamentosas", async (req, res) => {
  try {
    const { contexto } = req.body || {};
    if (!contexto || !String(contexto).trim()) {
      return res.json({ registro: "" });
    }

    const safeContexto = normalizeText(contexto, 25000);

    const prompt = `
Você é um enfermeiro humano. Gere um REGISTRO DE ADMINISTRAÇÃO SEGURA DE MEDICAMENTOS (enfermagem), baseado no contexto.
Inclua, quando aplicável:
- Checagem dos "9 certos".
- Via e horário.
- Observações de tolerância e resposta.
- Reações adversas e conduta.
- Orientações e reavaliação.

Regras:
- Sem emojis e sem símbolos gráficos.
- Não invente doses ou diluições se não estiverem no contexto; use "não informado".

Formato de saída: JSON estrito:
{ "registro": "..." }

Contexto:
"""${safeContexto}"""
`;

    const data = await callOpenAIJson(prompt);
    const registro = typeof data?.registro === "string" ? data.registro.trim() : "";
    return res.json({ registro });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar registro." });
  }
});






// ======================================================================
// ROTA 4.16 – APRESENTAÇÕES E DOSAGEM MÁXIMA DIÁRIA (NOVA)
// ======================================================================

app.post("/api/apresentacoes-dosagem-maxima", async (req, res) => {
  try {
    const { contexto } = req.body || {};
    if (!contexto || !String(contexto).trim()) {
      return res.json({ curativos: "" });
    }

    const safeContexto = normalizeText(contexto, 25000);

    const prompt = `
Você é um enfermeiro humano. Gere um REGISTRO PADRONIZADO DE CURATIVOS E FERIDAS, quando fizer sentido para o caso.
Se o caso não envolver feridas/curativos, gere um texto curto dizendo que não há curativo indicado no contexto, e quais sinais deveriam motivar avaliação.

Quando envolver, incluir:
- Localização.
- Dimensões (se informado).
- Aspecto do leito (tecido), bordas, exsudato, odor.
- Pele perilesional.
- Dor.
- Conduta do curativo: limpeza, cobertura, frequência, orientação domiciliar.
- Plano de reavaliação e sinais de alarme.

Regras:
- Sem emojis e sem símbolos gráficos.
- Não invente medidas; use "não informado".

Formato de saída: JSON estrito:
{ "curativos": "..." }

Contexto:
"""${safeContexto}"""
`;

    const data = await callOpenAIJson(prompt);
    const curativos = typeof data?.curativos === "string" ? data.curativos.trim() : "";
    return res.json({ curativos });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar curativos." });
  }
});






// ======================================================================
// ROTA 4.2 – EXTRAIR DADOS DO PACIENTE (NOME / IDADE / PESO) (NOVA)
// ======================================================================

app.post("/api/extrair-dados-paciente", async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    if (!transcricao || !String(transcricao).trim()) {
      return res.json({ nome: null, idade: null, peso_kg: null });
    }

    const safeTranscricao = normalizeText(transcricao, 4000);

    const prompt = `
Você é um enfermeiro humano extraindo dados objetivos de uma fala curta.
Extraia somente se estiver explícito.

Formato de saída: JSON estrito:
{
  "nome": "string ou null",
  "idade": "number ou null",
  "peso_kg": "number ou null"
}

Regras:
- Se não houver certeza, use null.
- Idade em anos (inteiro).
- Peso em kg (número).
- Sem texto fora do JSON.

Fala:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);

    let nome = typeof data?.nome === "string" ? data.nome.trim() : null;
    if (nome === "") nome = null;

    let idade = null;
    if (typeof data?.idade === "number" && Number.isFinite(data.idade)) idade = Math.round(data.idade);

    let peso_kg = null;
    if (typeof data?.peso_kg === "number" && Number.isFinite(data.peso_kg)) {
      const v = Number(data.peso_kg);
      if (v > 0 && v < 500) peso_kg = Math.round(v * 10) / 10;
    }

    return res.json({ nome, idade, peso_kg });
  } catch (e) {
    console.error(e);
    return res.json({ nome: null, idade: null, peso_kg: null });
  }
});






// ======================================================================
// ROTA 4.3 – CLASSIFICAÇÃO DE RISCO POR CORES (NOVA)
// ======================================================================

app.post("/api/classificacao-risco", async (req, res) => {
  try {
    const { contexto } = req.body || {};
    if (!contexto || !String(contexto).trim()) {
      return res.json({
        cor: "Não informado",
        significado: "Sem dados suficientes para classificar.",
        legenda: [
          { cor: "Vermelho", significado: "Emergência. Atendimento imediato." },
          { cor: "Laranja", significado: "Muito urgente. Prioridade alta de atendimento." },
          { cor: "Amarelo", significado: "Urgente. Necessita avaliação em curto prazo." },
          { cor: "Verde", significado: "Pouco urgente. Pode aguardar com segurança, mantendo reavaliação se piora." },
          { cor: "Azul", significado: "Não urgente. Caso de baixa gravidade, orientar e agendar conforme necessidade." }
        ]
      });
    }

    const safeContexto = normalizeText(contexto, 25000);

    const prompt = `
Você é um enfermeiro humano realizando CLASSIFICAÇÃO DE RISCO por cores com base no contexto do atendimento (transcrição + SOAP + conduta).

Tarefa:
1) Escolher UMA cor entre: Vermelho, Laranja, Amarelo, Verde, Azul.
2) Explicar de forma curta o significado da cor escolhida para priorização do atendimento.
3) Sempre devolver também uma legenda com o significado de cada cor.

Regras obrigatórias:
- Não invente sinais vitais, sintomas ou exames. Use apenas o que estiver no contexto.
- Se o contexto estiver insuficiente para classificar com segurança, retorne "Não informado" e explique que faltam dados críticos.
- Sem emojis e sem símbolos gráficos.
- Não fazer diagnóstico médico definitivo.

Formato de saída: JSON estrito, sem texto fora do JSON:
{
  "cor": "Vermelho|Laranja|Amarelo|Verde|Azul|Não informado",
  "significado": "string curta",
  "legenda": [
    { "cor": "Vermelho", "significado": "..." },
    { "cor": "Laranja", "significado": "..." },
    { "cor": "Amarelo", "significado": "..." },
    { "cor": "Verde", "significado": "..." },
    { "cor": "Azul", "significado": "..." }
  ]
}

Contexto:
\"\"\"${safeContexto}\"\"\"
`;

    const data = await callOpenAIJson(prompt);

    const cor = typeof data?.cor === "string" ? data.cor.trim() : "Não informado";
    const significado = typeof data?.significado === "string" ? data.significado.trim() : "";
    const legendaRaw = Array.isArray(data?.legenda) ? data.legenda : [];

    const legenda = legendaRaw
      .map((x) => ({
        cor: normalizeText(x?.cor || "", 30),
        significado: normalizeText(x?.significado || "", 220)
      }))
      .filter((x) => x.cor && x.significado)
      .slice(0, 5);

    const legendaFallback = [
      { cor: "Vermelho", significado: "Emergência. Atendimento imediato." },
      { cor: "Laranja", significado: "Muito urgente. Prioridade alta de atendimento." },
      { cor: "Amarelo", significado: "Urgente. Necessita avaliação em curto prazo." },
      { cor: "Verde", significado: "Pouco urgente. Pode aguardar com segurança, mantendo reavaliação se piora." },
      { cor: "Azul", significado: "Não urgente. Caso de baixa gravidade, orientar e agendar conforme necessidade." }
    ];

    return res.json({
      cor: cor || "Não informado",
      significado: significado || (cor && cor !== "Não informado" ? "Priorizar atendimento conforme classificação." : "Sem dados suficientes para classificar."),
      legenda: legenda.length ? legenda : legendaFallback
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar a classificação de risco." });
  }
});


// ======================================================================
// ROTA 4.4 – ANÁLISE DE LESÃO POR FOTO (CURATIVOS E FERIDAS) (NOVA)
// ======================================================================

async function analisarLesaoPorImagem(safeImage) {
  const prompt = `
Você é um enfermeiro humano elaborando um REGISTRO DE CURATIVOS E FERIDAS com base em uma foto de lesão.

Tarefa:
1) Descrever somente características VISÍVEIS e com linguagem prudente (sem inventar).
2) Recomendar prescrição e cuidados de enfermagem de forma objetiva e segura, aplicável no dia a dia.
3) Informar sinais de alerta e critérios objetivos para encaminhamento/avaliação médica.

Regras obrigatórias:
- Não fazer diagnóstico médico definitivo.
- Se a imagem estiver insuficiente (iluminação, foco, ângulo), diga "não informado" nos itens que não forem confiáveis.
- Evitar afirmações absolutas quando houver incerteza.
- Sem emojis e sem símbolos gráficos.

Formato de saída: JSON estrito:
{
  "caracteristicas": "string",
  "prescricao_cuidados": "string",
  "sinais_alarme": "string"
}

Orientações esperadas:
- Incluir higiene/limpeza, cobertura, frequência de troca, proteção da pele perilesional, controle de dor, prevenção de infecção quando aplicável.
- Se houver suspeita visual de gravidade (necrose extensa, sangramento ativo importante, exposição de estruturas profundas, sinais compatíveis com infecção importante), orientar priorização de avaliação médica.
`;

  const data = await callOpenAIVisionJson(prompt, safeImage);

  const caracteristicas = typeof data?.caracteristicas === "string" ? data.caracteristicas.trim() : "";
  const prescricao_cuidados = typeof data?.prescricao_cuidados === "string" ? data.prescricao_cuidados.trim() : "";
  const sinais_alarme = typeof data?.sinais_alarme === "string" ? data.sinais_alarme.trim() : "";

  return {
    caracteristicas: caracteristicas || "não informado",
    prescricao_cuidados: prescricao_cuidados || "não informado",
    sinais_alarme: sinais_alarme || "não informado",
  };
}

app.post("/api/analisar-lesao", async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000); // ~4MB em caracteres

    if (!safeImage) {
      return res.status(400).json({
        error: "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente."
      });
    }

    const out = await analisarLesaoPorImagem(safeImage);
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao analisar a lesão." });
  }
});

// Alias para compatibilidade com o frontend atual (retorna um texto único para exibição).
app.post("/api/analisar-lesao-imagem", async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000);

    if (!safeImage) {
      return res.status(400).json({ error: "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente." });
    }

    const out = await analisarLesaoPorImagem(safeImage);
    const texto =
      "Características visíveis:\n" + out.caracteristicas +
      "\n\nPrescrição e cuidados de enfermagem:\n" + out.prescricao_cuidados +
      "\n\nSinais de alarme e encaminhamento:\n" + out.sinais_alarme;

    return res.json({ texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao analisar a lesão." });
  }
});


// ======================================================================
// ROTA 4.5 – ANÁLISE DE PRESCRIÇÃO POR FOTO (ADMINISTRAÇÃO SEGURA) (NOVA)
// ======================================================================

app.post("/api/analisar-prescricao-imagem", async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000);

    if (!safeImage) {
      return res.status(400).json({
        error: "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente."
      });
    }

    const prompt = `
Você é um enfermeiro humano realizando uma ANÁLISE DE SEGURANÇA DE UMA PRESCRIÇÃO MÉDICA baseada em uma foto.

Objetivo:
1) Transcrever somente o que estiver legível (sem inventar). Quando não der para ler, escreva "não informado".
2) Para cada medicamento identificado, informar para que serve em linguagem prática.
3) Identificar riscos relevantes para a enfermagem: dose potencialmente excessiva, via/frequência incompatíveis, duplicidade terapêutica, alergia mencionada, necessidade de ajuste por idade/gestação/lactação quando houver dado, e ausência de informações críticas (ex.: diluente, velocidade, volume) quando aplicável.
4) Se houver interação medicamentosa potencialmente relevante, listar e dizer se é um risco importante ou se é "não informado" por falta de dados.
5) Se a via for EV ou IM e a prescrição estiver incompleta, orientar a CONFIRMAÇÃO do preparo/diluição/velocidade conforme protocolo institucional e bula. Não inventar volumes/concentrações.

Regras obrigatórias:
- Não prescrever ou alterar a prescrição médica.
- Não dar diagnóstico médico.
- Ser prudente: quando houver incerteza, dizer explicitamente.
- Sem emojis e sem símbolos gráficos.

Formato de saída: JSON estrito:
{
  "medicamentos": [
    {
      "nome": "string",
      "posologia_legivel": "string",
      "via": "string",
      "frequencia": "string",
      "indicacao_pratica": "string",
      "observacoes_enfermagem": "string"
    }
  ],
  "riscos_e_inconsistencias": ["string"],
  "interacoes_medicamentosas": ["string"],
  "itens_a_confirmar": ["string"],
  "resumo_operacional": "string"
}
`;

    const data = await callOpenAIVisionJson(prompt, safeImage);

    const meds = Array.isArray(data?.medicamentos) ? data.medicamentos : [];
    const riscos = Array.isArray(data?.riscos_e_inconsistencias) ? data.riscos_e_inconsistencias : [];
    const interacoes = Array.isArray(data?.interacoes_medicamentosas) ? data.interacoes_medicamentosas : [];
    const confirmar = Array.isArray(data?.itens_a_confirmar) ? data.itens_a_confirmar : [];
    const resumo = typeof data?.resumo_operacional === "string" ? data.resumo_operacional.trim() : "";

    const lines = [];
    lines.push("Prescrição identificada (somente o que está legível):");
    if (!meds.length) {
      lines.push("não informado");
    } else {
      let i = 1;
      for (const m of meds.slice(0, 30)) {
        const nome = normalizeText(m?.nome || "", 120) || "não informado";
        const pos = normalizeText(m?.posologia_legivel || "", 200) || "não informado";
        const via = normalizeText(m?.via || "", 80) || "não informado";
        const freq = normalizeText(m?.frequencia || "", 80) || "não informado";
        const ind = normalizeText(m?.indicacao_pratica || "", 260) || "não informado";
        const obs = normalizeText(m?.observacoes_enfermagem || "", 420) || "não informado";

        lines.push(`${i}) ${nome}`);
        lines.push(`Posologia legível: ${pos}`);
        lines.push(`Via: ${via}`);
        lines.push(`Frequência: ${freq}`);
        lines.push(`Para que serve: ${ind}`);
        lines.push(`Pontos de enfermagem: ${obs}`);
        lines.push("");
        i += 1;
      }
    }

    lines.push("Riscos e inconsistências relevantes:");
    if (riscos.length) {
      for (const r of riscos.slice(0, 30)) lines.push("- " + normalizeText(r, 260));
    } else {
      lines.push("- não informado");
    }

    lines.push("");
    lines.push("Interações medicamentosas (se possível inferir com segurança):");
    if (interacoes.length) {
      for (const it of interacoes.slice(0, 30)) lines.push("- " + normalizeText(it, 260));
    } else {
      lines.push("- não informado");
    }

    lines.push("");
    lines.push("Itens que devem ser confirmados antes da administração:");
    if (confirmar.length) {
      for (const c of confirmar.slice(0, 30)) lines.push("- " + normalizeText(c, 260));
    } else {
      lines.push("- não informado");
    }

    if (resumo) {
      lines.push("");
      lines.push("Resumo operacional:");
      lines.push(resumo);
    }

    return res.json({ texto: lines.join("\n") });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao analisar a prescrição." });
  }
});



// ======================================================================
// ROTA 5 – DÚVIDAS MÉDICAS (NOVA)
// ======================================================================

async function responderDuvidaEnfermagem(duvida) {
  const q = String(duvida || "").trim();
  if (!q) return "";

  const safeQ = normalizeText(q, 2000);

  const prompt = `
Você é um enfermeiro humano respondendo uma dúvida de enfermagem de forma objetiva e operacional.
O objetivo é orientar conduta, técnica, procedimento, educação em saúde e critérios de encaminhamento/escalação.

Regras:
- Resposta curta, prática, em português do Brasil.
- Sem emojis e sem símbolos gráficos.
- Se houver risco de gravidade, inclua sinais de alarme e orientação de procurar serviço.
- Não prescreva medicamentos fora do escopo; foque em ações de enfermagem.

Formato de saída: JSON estrito:
{ "resposta": "..." }

Dúvida:
"""${safeQ}"""
`;

  const data = await callOpenAIJson(prompt);
  return typeof data?.resposta === "string" ? data.resposta.trim() : "";
}

app.post("/api/duvidas-medicas", async (req, res) => {
  try {
    const { duvida } = req.body || {};
    const resposta = await responderDuvidaEnfermagem(duvida);
    return res.json({ resposta });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao responder a dúvida." });
  }
});

app.post("/api/duvidas-enfermagem", async (req, res) => {
  try {
    const { duvida } = req.body || {};
    const resposta = await responderDuvidaEnfermagem(duvida);
    return res.json({ resposta });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao responder a dúvida." });
  }
});




// ======================================================================
// ROTA 6 – GERAR RELATÓRIO CLÍNICO DO PACIENTE A PARTIR DA TRANSCRIÇÃO (NOVA)
// ======================================================================

app.post("/api/gerar-relatorio", async (req, res) => {
  try {
    const { transcricao } = req.body || {};

    if (!transcricao || !String(transcricao).trim()) {
      return res.json({ relatorio: "" });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);

    const prompt = `
Você é um enfermeiro humano redigindo um relatório/declaração de enfermagem com base na transcrição do atendimento.

Objetivo:
- Identificar a FINALIDADE do relatório a partir da própria transcrição (por exemplo: INSS, CAPS/saúde mental, escola, trabalho, advogado, assistência social, aquisição de insumos, etc).
- Produzir um RELATÓRIO DE ENFERMAGEM compatível com a finalidade identificada, pronto para impressão.

Regras:
- Português do Brasil.
- Sem emojis e sem símbolos gráficos.
- Não invente dados. Se faltar informação, use "não informado" ou "não foi referido".
- Não faça diagnóstico médico definitivo. Descreva achados e condutas de enfermagem.
- Texto claro, objetivo e formal.

Formato do relatório:
- Cabeçalho: "RELATÓRIO DE ENFERMAGEM"
- Campo "Finalidade:" com a finalidade identificada (se não estiver explícita, "não informado").
- Corpo em parágrafos curtos: identificação (se dita), histórico/queixa, achados objetivos mencionados, condutas/orientações, e considerações pertinentes à finalidade.
- Data: "Data: ____/____/____" (deixe em branco).

Formato de saída: JSON estrito:
{ "relatorio": "..." }

Transcrição:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);
    const relatorio = typeof data?.relatorio === "string" ? data.relatorio.trim() : "";
    return res.json({ relatorio });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar relatório." });
  }
});






// ======================================================================
// SAÚDE DO BACKEND (TESTE RÁPIDO)
// ======================================================================
app.get("/api/health", (req, res) => {
  return res.json({
    ok: true,
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    time: new Date().toISOString()
  });
});

// ======================================================================
// PERGUNTAS E PROCEDIMENTOS ESSENCIAIS (FLUXO CONTROLADO)
// - Mantém no máximo 3 perguntas por vez.
// - Atualiza somente após "pergunta feita" + nova resposta do paciente.
// ======================================================================
function clampNumber(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function guessContextAndHypothesis(t) {
  const s = String(t || "").toLowerCase();

  if (s.includes("dor no peito") || s.includes("torác") || s.includes("opress")) {
    return { contexto: "Dor torácica", hipotese: "Síndrome coronariana aguda vs. causas não cardíacas" };
  }
  if (s.includes("falta de ar") || s.includes("dispne") || s.includes("chiado")) {
    return { contexto: "Dispneia", hipotese: "Crise asmática/DPOC vs. causas infecciosas ou cardíacas" };
  }
  if (s.includes("dor abdominal") || s.includes("barriga") || s.includes("abdome")) {
    return { contexto: "Dor abdominal", hipotese: "Gastroenterite/infecção urinária vs. abdome agudo" };
  }
  if (s.includes("dor de garganta") || s.includes("garganta") || s.includes("amígdala")) {
    return { contexto: "Odinofagia", hipotese: "Faringoamigdalite viral vs. bacteriana" };
  }
  if (s.includes("diarre") || s.includes("vômit") || s.includes("vomit") || s.includes("náuse") || s.includes("enjoo")) {
    return { contexto: "Gastrointestinal", hipotese: "Gastroenterite" };
  }
  if ((s.includes("urina") || s.includes("xixi") || s.includes("disúria") || s.includes("ardor")) && (s.includes("dor") || s.includes("frequên") || s.includes("urgên") || s.includes("febre"))) {
    return { contexto: "Sintomas urinários", hipotese: "Infecção urinária" };
  }
  if (s.includes("cefale") || s.includes("dor de cabeça") || s.includes("enxaqu")) {
    return { contexto: "Cefaleia", hipotese: "Cefaleia primária vs. sinais de alarme" };
  }
  if (s.includes("corrimento") || s.includes("prurido") || s.includes("coceira")) {
    return { contexto: "Queixa ginecológica", hipotese: "Vulvovaginite/cervicite" };
  }
  return { contexto: "Atendimento geral", hipotese: "" };
}

function heuristicQuestions(transcricao) {
  const t = String(transcricao || "").toLowerCase();
  const { contexto, hipotese } = guessContextAndHypothesis(t);

  const q = [];
  const push = (s) => {
    const x = String(s || "").trim();
    if (!x) return;
    if (!q.some(a => a.toLowerCase() === x.toLowerCase())) q.push(x);
  };

  push("Confirmar início e evolução do quadro (quando começou e como piorou/melhorou).");
  push("Aferir sinais vitais e saturação; verificar sinais de alarme relevantes ao quadro.");

  if (t.includes("febre") || t.includes("calafrio")) {
    push("Perguntar pico da febre, padrão (contínua/intermitente) e uso/resposta a antitérmicos.");
    push("Perguntar sinais de gravidade: prostração importante, confusão, rigidez de nuca, dispneia, dor torácica.");
  }

  if (t.includes("dor de garganta") || t.includes("garganta") || t.includes("amígdala")) {
    push("Perguntar presença de tosse, coriza, rouquidão e contato com casos semelhantes.");
    push("Verificar exsudato/hiperemia amigdalar, linfonodos cervicais dolorosos e febre (critérios clínicos).");
  }

  if (t.includes("tosse") || t.includes("coriza") || t.includes("catarro")) {
    push("Caracterizar tosse (seca/produtiva), dispneia, dor pleurítica e duração do quadro.");
    push("Checar sinais de alarme respiratório e comorbidades (asma/DPOC, cardiopatia, imunossupressão).");
  }

  if (t.includes("dor no peito") || t.includes("torác") || t.includes("opress")) {
    push("Caracterizar dor torácica: início, duração, irradiação, fatores de melhora/piora e sintomas associados.");
    push("Investigar dispneia, sudorese, náuseas, síncope e fatores de risco cardiovasculares.");
  }

  if (t.includes("falta de ar") || t.includes("dispne") || t.includes("chiado")) {
    push("Perguntar intensidade/limitação funcional, gatilhos, sibilância e resposta a broncodilatador.");
    push("Investigar sinais de gravidade: fala entrecortada, uso de musculatura acessória, cianose, SpO2 baixa.");
  }

  if (t.includes("dor abdominal") || t.includes("abdome") || t.includes("barriga")) {
    push("Caracterizar dor abdominal (localização, irradiação, intensidade, relação com alimentação/evacuação).");
    push("Perguntar náuseas/vômitos, diarreia, febre, e sinais de desidratação.");
    push("Perguntar sintomas urinários e, se aplicável, possibilidade de gestação.");
  }

  if (t.includes("diarre") || t.includes("vômit") || t.includes("vomit") || t.includes("náuse") || t.includes("enjoo")) {
    push("Perguntar número de episódios, sangue/muco nas fezes e tolerância a líquidos.");
    push("Avaliar risco de desidratação (diurese, sede intensa, sonolência) e sinais de alarme.");
  }

  if ((t.includes("urina") || t.includes("xixi") || t.includes("disúria") || t.includes("ardor")) && (t.includes("dor") || t.includes("frequên") || t.includes("urgên") || t.includes("febre"))) {
    push("Perguntar disúria, urgência, polaciúria, dor lombar e febre; investigar gestação quando aplicável.");
    push("Se possível, realizar EAS/urocultura conforme protocolo/local.");
  }

  if (t.includes("cefale") || t.includes("dor de cabeça")) {
    push("Caracterizar cefaleia (início súbito vs. progressivo, intensidade, padrão, sintomas associados).");
    push("Investigar sinais de alarme: déficit focal, rigidez de nuca, febre, pior cefaleia da vida, vômitos em jato.");
  }

  if (t.includes("sangr") || t.includes("hemorrag") || t.includes("menstrua")) {
    push("Quantificar sangramento e avaliar instabilidade (tontura, síncope, palidez, taquicardia).");
    push("Perguntar possibilidade de gestação e dor pélvica/abdominal associada.");
  }

  return { contexto, hipotese, sugestoes: q };
}

function isRedFlagQuestion(question) {
  const q = String(question || "").toLowerCase();
  return q.includes("sinais de alarme") || q.includes("gravidade") || q.includes("instabilidade") || q.includes("spo2") || q.includes("rigidez de nuca");
}

app.post("/api/guia-tempo-real", async (req, res) => {
  try {
    const body = req.body || {};

    // Compatibilidade com versão antiga: { transcricao, itens_atuais }
    const legacyTrans = normalizeText(body.transcricao || "", 12000);
    const legacyItens = Array.isArray(body.itens_atuais)
      ? body.itens_atuais.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3)
      : [];

    if (!body.estado && legacyItens.length) {
      return res.json({ contexto: "", itens: legacyItens });
    }

    const estado = String(body.estado || "").trim() || "perguntas";
    const evento = String(body.evento || "").trim() || "stream";

    if (estado === "aguardando_motivo") {
      return res.json({ contexto: "", hipotese_principal: "", confianca: 0, perguntas: [] });
    }

    const transcricao = normalizeText(body.transcricao || legacyTrans || "", 12000);
    if (!transcricao || transcricao.length < 20) {
      return res.json({ contexto: "", hipotese_principal: "", confianca: 0, perguntas: [] });
    }

    const perguntaFeita = String(body.pergunta_feita || "").trim();
    const pendentes = Array.isArray(body.perguntas_pendentes)
      ? body.perguntas_pendentes.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3)
      : [];

    const confiancaAtual = clampNumber(body.confianca_atual, 0, 95);
    const hipoteseAtual = String(body.hipotese_atual || "").trim();
    const ultimaFala = normalizeText(body.ultima_fala || "", 800);

    let contexto = "";
    let hipotese = "";
    let confianca = 0;
    let sugestoes = [];

    if (process.env.OPENAI_API_KEY) {
      const prompt = `
Você está auxiliando um enfermeiro durante uma consulta.
Objetivo: sugerir no máximo 3 perguntas essenciais por vez para chegar a um diagnóstico provável com eficiência.

Regras:
- Nunca gere mais de 3 perguntas.
- Se houver perguntas pendentes úteis, você pode mantê-las.
- Se uma pergunta ficou sem sentido após a resposta do paciente, substitua.
- Use linguagem objetiva e prática.
- Retorne também uma hipótese principal (curta) e um nível de confiança (0 a 95; nunca 100).

Retorne JSON estrito no formato:
{
  "contexto": "texto curto",
  "hipotese_principal": "texto curto",
  "confianca": 0,
  "perguntas_sugeridas": ["...", "...", "..."]
}

Dados atuais:
- Estado: ${estado}
- Evento: ${evento}
- Hipótese atual: ${hipoteseAtual || "não informado"}
- Confiança atual: ${confiancaAtual}
- Pergunta feita (se houver): ${perguntaFeita || "nenhuma"}
- Perguntas pendentes: ${pendentes.length ? pendentes.join(" | ") : "nenhuma"}

Última fala (trecho recente, pode estar vazio): ${ultimaFala || "não informado"}

Transcrição:
<<<${transcricao}>>>
`;
      const data = await callOpenAIJson(prompt);
      contexto = typeof data?.contexto === "string" ? data.contexto.trim() : "";
      hipotese = typeof data?.hipotese_principal === "string" ? data.hipotese_principal.trim() : "";
      confianca = clampNumber(data?.confianca, 0, 95);
      sugestoes = Array.isArray(data?.perguntas_sugeridas) ? data.perguntas_sugeridas : [];
    } else {
      const h = heuristicQuestions(transcricao);
      contexto = h.contexto || "";
      hipotese = h.hipotese || "";
      sugestoes = h.sugestoes || [];

      const bonusEvento = (evento === "resposta") ? 12 : (evento === "inicial") ? 8 : 0;
      const bonusLen = Math.min(15, Math.floor(transcricao.length / 300));
      const base = (confiancaAtual > 0 ? confiancaAtual : 25);
      confianca = clampNumber(base + bonusEvento + bonusLen, 10, 95);
    }

    // Atualiza pendentes: remove a pergunta feita
    let pend = pendentes.slice();
    if (perguntaFeita) {
      pend = pend.filter(x => x.toLowerCase() !== perguntaFeita.toLowerCase());
    }

    const sugNorm = (Array.isArray(sugestoes) ? sugestoes : []).map(x => String(x || "").trim()).filter(Boolean);
    const sugLower = sugNorm.map(x => x.toLowerCase());

    const kept = pend.filter(x => sugLower.includes(x.toLowerCase()) || isRedFlagQuestion(x));

    const next = [];
    kept.forEach(x => { if (next.length < 3) next.push(x); });

    for (const s of sugNorm) {
      if (next.length >= 3) break;
      const exists = next.some(x => x.toLowerCase() === s.toLowerCase());
      if (!exists) next.push(s);
    }

    for (const old of pend) {
      if (next.length >= 3) break;
      const exists = next.some(x => x.toLowerCase() === String(old || "").toLowerCase());
      if (!exists) next.push(String(old || "").trim());
    }

    return res.json({
      contexto,
      hipotese_principal: hipotese,
      confianca,
      perguntas: next.slice(0, 3)
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna no guia em tempo real." });
  }
});


// ======================================================================
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================================

app.listen(port, () => {
  console.log(`Servidor escutando na porta ${port}`);
});
