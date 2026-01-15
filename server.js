// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const OpenAI = require("openai");
// ======================================================================
// ARMAZENAMENTO PERSISTENTE (opcional)
// - Em Render Free, o filesystem é efêmero e perde dados em redeploy/restart.
// - Persistent Disks exigem instância paga.
// Solução robusta: usar DATABASE_URL (Postgres externo, ex.: Supabase/Neon/Render paid).
// Implementação simples: persiste o "DB JSON" em uma única linha (JSONB).
// ======================================================================

let Pool = null;
try { ({ Pool } = require("pg")); } catch { Pool = null; }

const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_PG_STORE = Boolean(DATABASE_URL) && Boolean(Pool);
const PG_STATE_ID = process.env.PG_STATE_ID || "main";
let pgPool = null;

let pgWriteInFlight = null;
let pgDirty = false;

function pgPoolOrNull() {
  if (!USE_PG_STORE) return null;
  if (pgPool) return pgPool;
  // Muitos provedores exigem SSL; manter compatível com conexões que não exigem.
  const sslEnabled = String(process.env.PG_SSL || "auto").toLowerCase();
  const useSsl = (sslEnabled === "true") || (sslEnabled === "1") || (sslEnabled === "yes") || (sslEnabled === "require") || (sslEnabled === "auto");
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30_000
  });
  return pgPool;
}

async function pgEnsureTable() {
  const pool = pgPoolOrNull();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function pgReadState() {
  const pool = pgPoolOrNull();
  if (!pool) return null;
  await pgEnsureTable();
  const r = await pool.query("SELECT data FROM app_state WHERE id = $1 LIMIT 1", [PG_STATE_ID]);
  if (!r.rows || !r.rows.length) return null;
  return r.rows[0].data;
}

async function pgWriteState(dbObj) {
  const pool = pgPoolOrNull();
  if (!pool) return;
  await pgEnsureTable();
  await pool.query(
    "INSERT INTO app_state (id, data, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
    [PG_STATE_ID, JSON.stringify(dbObj)]
  );
}

function schedulePgSave(dbObj) {
  // Não bloqueia a requisição; mantém última versão consistente no Postgres.
  if (!USE_PG_STORE) return;

  const doWrite = async () => {
    try {
      await pgWriteState(dbObj);
    } catch (e) {
      console.error("[PG_STORE] falha ao persistir:", e?.message || e);
    }
  };

  if (pgWriteInFlight) {
    pgDirty = true;
    return;
  }
  pgWriteInFlight = doWrite()
    .finally(() => {
      pgWriteInFlight = null;
      if (pgDirty) {
        pgDirty = false;
        // escreve a versão atual em memória
        schedulePgSave(DB);
      }
    });
}

async function hydrateDbFromPgIfAvailable() {
  if (!USE_PG_STORE) return { backend: "file", hydrated: false };
  try {
    const data = await pgReadState();
    if (data && typeof data === "object") {
      DB = normalizeDb(data);
      return { backend: "postgres", hydrated: true, seeded: false };
    }
    // Se não existir estado ainda, "semeia" com o que já está em memória (arquivo/local).
    await pgWriteState(normalizeDb(DB));
    return { backend: "postgres", hydrated: true, seeded: true };
  } catch (e) {
    console.error("[PG_STORE] falha ao hidratar:", e?.message || e);
    return { backend: "postgres", hydrated: false, error: e?.message || String(e) };
  }
}


const app = express();
const port = process.env.PORT || 3000;

// Configurações básicas
app.use(cors());
app.use(bodyParser.json({ limit: "25mb" }));
app.use(bodyParser.urlencoded({ limit: "25mb", extended: true }));

// Servir o index.html apenas na rota raiz (útil para testes locais)
app.get("/", (req, res) => {
  return res.sendFile(path.join(__dirname, "index.html"));
});

// Servir o index.html (útil para testes locais)

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
  // Aceita:
  // - images_data_url (array) (frontend)
  // - imagens_data_url (array)
  // - imagem_data_url (string)
  // - image_data_url (string)
  const arr = Array.isArray(b.images_data_url) ? b.images_data_url
    : (Array.isArray(b.imagens_data_url) ? b.imagens_data_url : null);

  if (arr && arr.length) {
    const first = arr.find((x) => typeof x === "string" && x.trim());
    if (first) return first.trim();
  }

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
// AUTENTICAÇÃO + BASE LOCAL (usuários, pagamentos e auditoria)
// ======================================================================

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "enfermagem_users_db.json");

// Persistência opcional no GitHub (para não perder usuários em redeploy).
// Configure via variáveis de ambiente no host do backend (Render/Replit/etc).
// - GITHUB_TOKEN: token com permissão de escrita no repositório
// - GITHUB_REPO: "owner/repo"
// - GITHUB_BRANCH: ex "main"
// - GITHUB_DB_PATH: ex "data/enfermagem_users_snapshot.json"
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DB_PATH = process.env.GITHUB_DB_PATH || "data/enfermagem_users_snapshot.json";
const GITHUB_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);


function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

const LEGACY_DB_PATHS = [
  path.join(DATA_DIR, "enfermagem_db.json"),
  path.join(DATA_DIR, "enfermagem_users_db_old.json"),
  path.join(DATA_DIR, "enfermagem_users_db_v1.json"),
  path.join(DATA_DIR, "enfermagem_users.json"),
  path.join(DATA_DIR, "db.json"),
  path.join(DATA_DIR, "database.json"),
  path.join(__dirname, "enfermagem_users_db.json"),
];

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_BACKUPS = 40;

function ensureBackupDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
}

// Escrita atômica (evita corromper o DB em queda/restart no meio da gravação)
function safeWriteFileAtomic(filePath, dataStr) {
  ensureDataDir();
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmp, dataStr, "utf-8");
  fs.renameSync(tmp, filePath);
}

function listBackupFiles() {
  ensureBackupDir();
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.toLowerCase().endsWith(".json"))
      .map(f => ({ f, p: path.join(BACKUP_DIR, f) }))
      .map(x => ({ ...x, t: fs.statSync(x.p).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files;
  } catch {
    return [];
  }
}

function rotateBackups() {
  const files = listBackupFiles();
  for (let i = MAX_BACKUPS; i < files.length; i++) {
    try { fs.unlinkSync(files[i].p); } catch {}
  }
}

function loadDbFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const db = JSON.parse(raw);
    if (!db || typeof db !== "object") return null;
    db.users = Array.isArray(db.users) ? db.users : [];
    db.payments = Array.isArray(db.payments) ? db.payments : [];
    db.audit = Array.isArray(db.audit) ? db.audit : [];
    return db;
  } catch {
    return null;
  }
}

function restoreFromLatestBackup() {
  const backups = listBackupFiles();
  for (const b of backups) {
    const db = loadDbFromFile(b.p);
    if (db) return { db, path: b.p };
  }
  return null;
}

function tryReadDbFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const db = JSON.parse(raw);
    if (!db || typeof db !== "object") return null;
    const users = Array.isArray(db.users) ? db.users : [];
    const payments = Array.isArray(db.payments) ? db.payments : [];
    const audit = Array.isArray(db.audit) ? db.audit : [];
    return { users, payments, audit };
  } catch {
    return null;
  }
}

function dbScore(db) {
  if (!db) return 0;
  return (db.users?.length || 0) * 1000000 + (db.payments?.length || 0) * 1000 + (db.audit?.length || 0) + (db.commissions?.length || 0) * 10 + (db.pixOrders?.length || 0) * 5 + (db.cardEvents?.length || 0);
}

function mergeDbs(a, b) {
  const out = { users: [], payments: [], audit: [], commissions: [], pixOrders: [], cardEvents: [] };

  const usersMap = new Map();
  for (const u of (Array.isArray(a?.users) ? a.users : [])) {
    if (u && u.id) usersMap.set(u.id, u);
  }
  for (const u of (Array.isArray(b?.users) ? b.users : [])) {
    if (!u || !u.id) continue;
    const prev = usersMap.get(u.id);
    if (!prev) {
      usersMap.set(u.id, u);
    } else {
      const prevLogin = Date.parse(prev.lastLoginAt || "") || 0;
      const newLogin = Date.parse(u.lastLoginAt || "") || 0;
      usersMap.set(u.id, newLogin > prevLogin ? { ...prev, ...u } : { ...u, ...prev });
    }
  }
  out.users = Array.from(usersMap.values());

  const paySeen = new Set();
  for (const p of [...(a?.payments || []), ...(b?.payments || [])]) {
    if (!p || !p.userId || !p.month) continue;
    const k = `${p.userId}|${p.month}|${p.paidAt || ""}`;
    if (paySeen.has(k)) continue;
    paySeen.add(k);
    out.payments.push(p);
  }

  const audSeen = new Set();
  for (const x of [...(a?.audit || []), ...(b?.audit || [])]) {
    if (!x) continue;
    const k = `${x.at || ""}|${x.action || ""}|${x.target || ""}|${x.details || ""}`;
    if (audSeen.has(k)) continue;
    audSeen.add(k);
    out.audit.push(x);
  }

  if (out.audit.length > 5000) out.audit = out.audit.slice(out.audit.length - 5000);
  if (out.payments.length > 20000) out.payments = out.payments.slice(out.payments.length - 20000);


  // Comissões (ledger)
  const commissions = [...(Array.isArray(a?.commissions) ? a.commissions : []), ...(Array.isArray(b?.commissions) ? b.commissions : [])];
  const commissionsMap = new Map();
  for (const c of commissions) { if (c && c.id) commissionsMap.set(c.id, c); }
  out.commissions = Array.from(commissionsMap.values());

  // Pedidos Pix
  const pixOrders = [...(Array.isArray(a?.pixOrders) ? a.pixOrders : []), ...(Array.isArray(b?.pixOrders) ? b.pixOrders : [])];
  const pixMap = new Map();
  for (const o of pixOrders) { if (o && o.id) pixMap.set(o.id, o); }
  out.pixOrders = Array.from(pixMap.values());

  // Eventos/cartão (opcional)
  const cardEvents = [...(Array.isArray(a?.cardEvents) ? a.cardEvents : []), ...(Array.isArray(b?.cardEvents) ? b.cardEvents : [])];
  const ceMap = new Map();
  for (const e of cardEvents) { if (e && e.id) ceMap.set(e.id, e); }
  out.cardEvents = Array.from(ceMap.values());

  return out;
}

function backupFile(filePath, reason = "auto") {
  try {
    ensureDataDir();
    ensureBackupDir();
    if (!fs.existsSync(filePath)) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.basename(filePath).replace(/\.json$/i, "");
    const safeReason = String(reason || "auto").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40) || "auto";
    const backupName = `${base}.backup-${stamp}-${safeReason}.json`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    fs.copyFileSync(filePath, backupPath);
    rotateBackups();
  } catch {}
}


function migrateDbIfNeeded() {
  ensureDataDir();

  const current = tryReadDbFile(DB_PATH);

  let best = null;
  let bestPath = null;
  for (const p of LEGACY_DB_PATHS) {
    const db = tryReadDbFile(p);
    if (db && dbScore(db) > dbScore(best)) {
      best = db;
      bestPath = p;
    }
  }

  if (!fs.existsSync(DB_PATH)) {
    if (best && bestPath) {
      try { fs.copyFileSync(bestPath, DB_PATH); } catch {}
    }
    return;
  }

  const currUsers = current?.users?.length || 0;
  const bestUsers = best?.users?.length || 0;

  if (currUsers === 0 && bestUsers > 0 && bestPath) {
    backupFile(DB_PATH);
    try { fs.copyFileSync(bestPath, DB_PATH); } catch {}
    return;
  }

  if (current && best && bestPath && bestPath !== DB_PATH) {
    const merged = mergeDbs(current, best);
    if (dbScore(merged) > dbScore(current)) {
      backupFile(DB_PATH);
      try { fs.writeFileSync(DB_PATH, JSON.stringify(merged, null, 2), "utf-8"); } catch {}
    }
  }
}


function nowIso() {
  return new Date().toISOString();
}

function currentYYYYMM() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}


const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 15;
const PRICE_MONTHLY = 25.00;
const PRICE_ANNUAL_CARD = 240.00;
const PRICE_ANNUAL_PIX = 200.00;

function addDaysIso(iso, days) {
  const t = iso ? new Date(iso).getTime() : Date.now();
  return new Date(t + (Number(days) * DAY_MS)).toISOString();
}

function ensureTrialFields(user) {
  if (!user || typeof user !== "object") return false;
  const hasStarted = !!user.trialStartedAt;
  const hasEnds = !!user.trialEndsAt;
  if (hasStarted && hasEnds) return false;

  let started = String(user.trialStartedAt || user.createdAt || "").trim();
  const startedMs = started ? new Date(started).getTime() : NaN;
  if (!started || Number.isNaN(startedMs)) started = nowIso();

  user.trialStartedAt = started;
  user.trialEndsAt = user.trialEndsAt ? String(user.trialEndsAt) : addDaysIso(started, TRIAL_DAYS);
  return true;
}


function trialRemainingSeconds(user, nowMs = Date.now()) {
  const end = user?.trialEndsAt ? new Date(user.trialEndsAt).getTime() : 0;
  if (!end) return 0;
  return Math.max(0, Math.floor((end - nowMs) / 1000));
}

function warning5Days(user, nowMs = Date.now()) {
  const rem = trialRemainingSeconds(user, nowMs);
  return rem > 0 && rem <= Math.floor(5 * DAY_MS / 1000);
}

function isTrialActive(user, nowMs = Date.now()) {
  const end = user?.trialEndsAt ? new Date(user.trialEndsAt).getTime() : 0;
  return !!end && nowMs < end;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round2(n) {
  const x = Number(n || 0);
  return Math.round(x * 100) / 100;
}



function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D+/g, "");
}


function normalizeCpf(v) {
  return onlyDigits(v);
}

function isValidCpf(v) {
  const cpf = normalizeCpf(v);
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calcDv = (base, factorStart) => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (factorStart - i);
    const mod = sum % 11;
    return (mod < 2) ? 0 : (11 - mod);
  };

  const base9 = cpf.slice(0, 9);
  const dv1 = calcDv(base9, 10);
  const base10 = cpf.slice(0, 10);
  const dv2 = calcDv(base10, 11);
  return cpf === (base9 + String(dv1) + String(dv2));
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function loadDb() {
  ensureDataDir();
  ensureBackupDir();
  migrateDbIfNeeded();

  // 1) Tenta carregar o DB principal
  const primary = loadDbFromFile(DB_PATH);
  if (primary) return primary;

  // 2) Se o arquivo existe mas está corrompido, faz backup e tenta recuperar do último backup válido
  if (fs.existsSync(DB_PATH)) {
    try {
      backupFile(DB_PATH, "corrupt");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const corruptPath = DB_PATH.replace(/\.json$/i, "") + `.corrupt-${stamp}.json`;
      try { fs.renameSync(DB_PATH, corruptPath); } catch {}
    } catch {}
  }

  const recovered = restoreFromLatestBackup();
  if (recovered?.db) {
    try {
      safeWriteFileAtomic(DB_PATH, JSON.stringify(recovered.db, null, 2));
      return recovered.db;
    } catch {
      return recovered.db;
    }
  }

  // 3) Primeira execução sem DB: cria inicial (sem riscos de apagar dados)
  const fresh = { users: [], payments: [], audit: [], commissions: [], pixOrders: [], cardEvents: [] };
  try {
    if (!fs.existsSync(DB_PATH)) {
      safeWriteFileAtomic(DB_PATH, JSON.stringify(fresh, null, 2));
    }
  } catch {}
  return fresh;
}


function normalizeDb(db) {
  const out = (db && typeof db === "object") ? db : {};
  out.users = Array.isArray(out.users) ? out.users : [];
  out.payments = Array.isArray(out.payments) ? out.payments : [];
  out.audit = Array.isArray(out.audit) ? out.audit : [];
  out.rosterConfigs = (out.rosterConfigs && typeof out.rosterConfigs === "object") ? out.rosterConfigs : {};
  out.rosterSchedules = Array.isArray(out.rosterSchedules) ? out.rosterSchedules : [];
  out.commissions = Array.isArray(out.commissions) ? out.commissions : [];
  out.pixOrders = Array.isArray(out.pixOrders) ? out.pixOrders : [];
  out.cardEvents = Array.isArray(out.cardEvents) ? out.cardEvents : [];
  return out;
}

// Atenção: este método NUNCA deve zerar o banco por acidente.
// - Escreve de forma atômica
// - Cria backup antes de gravar
// - Bloqueia gravação "vazia" se já houver dados (proteção anti-apagão)
function saveDb(db, reason = "auto") {
  // Persistência principal via Postgres (se DATABASE_URL configurado)
  // Mantemos o arquivo local como fallback, mas no Render Free ele é efêmero.
  const next = normalizeDb(db);
  if (USE_PG_STORE) {
    // Atualiza em memória e agenda persistência
    schedulePgSave(next);
    // ainda tenta escrever em disco quando possível (dev/local)
  }

  ensureDataDir();
  ensureBackupDir();

  const currentOnDisk = tryReadDbFile(DB_PATH);
  const currentScore = dbScore(currentOnDisk);
  const nextScore = dbScore(next);

  // Proteção: se já existe dado, não permitir gravar um DB totalmente vazio
  if (currentScore > 0 && nextScore === 0) {
    console.warn("[DB] Bloqueado: tentativa de salvar DB vazio (proteção anti-perda).");
    return;
  }

  try {
    backupFile(DB_PATH, reason);
  } catch {}

  try {
    safeWriteFileAtomic(DB_PATH, JSON.stringify(next, null, 2));
    try { scheduleGithubSnapshot(next, reason); } catch (e) { console.error("[GITHUB] Falha ao agendar persistência:", e); }
  } catch (e) {
    console.error("[DB] Falha ao salvar DB:", e);
  }
}

// ======================================================================
// Persistência no GitHub (snapshot estável de usuários + pagamentos)
// - Evita perder usuários em redeploy, mesmo sem disco persistente.
// - Snapshot não inclui campos voláteis (lastSeenAt/lastLoginAt/audit), para não gerar commits a cada heartbeat.
// ======================================================================

function encodeGithubPath(p) {
  return String(p || "")
    .split("/")
    .map(seg => encodeURIComponent(seg))
    .join("/");
}

function parseGithubRepo(repoStr) {
  const s = String(repoStr || "").trim();
  const m = s.match(/^([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function buildGithubSnapshot(db) {
  const users = (Array.isArray(db?.users) ? db.users : []).map(u => ({
    id: u.id,
    fullName: u.fullName,
    dob: u.dob,
    phone: u.phone,
    login: u.login,
    salt: u.salt,
    passwordHash: u.passwordHash,
    isActive: !!u.isActive,
    isDeleted: !!u.isDeleted,
    createdAt: u.createdAt || ""
  })).sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));

  const payments = (Array.isArray(db?.payments) ? db.payments : []).map(p => ({
    id: p.id,
    userId: p.userId,
    month: p.month,
    paidAt: p.paidAt || "",
    amount: p.amount || "",
    method: p.method || "",
    notes: p.notes || "",
    receivedBy: p.receivedBy || ""
  })).sort((a, b) => {
    const ak = `${a.userId || ""}|${a.month || ""}|${a.paidAt || ""}|${a.id || ""}`;
    const bk = `${b.userId || ""}|${b.month || ""}|${b.paidAt || ""}|${b.id || ""}`;
    return ak.localeCompare(bk);
  });

  return { schemaVersion: 1, users, payments };
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(String(str), "utf-8").digest("hex");
}

let GH_TIMER = null;
let GH_LAST_HASH = "";
let GH_PENDING_STR = "";
let GH_PENDING_HASH = "";
let GH_IN_FLIGHT = false;

function scheduleGithubSnapshot(db, reason = "auto") {
  if (!GITHUB_ENABLED) return;

  const snap = buildGithubSnapshot(db);
  const contentStr = JSON.stringify(snap, null, 2);
  const h = sha256Hex(contentStr);

  if (h && h === GH_LAST_HASH) return;

  GH_PENDING_STR = contentStr;
  GH_PENDING_HASH = h;

  if (GH_TIMER) clearTimeout(GH_TIMER);
  GH_TIMER = setTimeout(() => {
    pushGithubSnapshot(GH_PENDING_STR, GH_PENDING_HASH, reason).catch(err => {
      console.error("[GITHUB] Falha ao persistir snapshot:", err);
    });
  }, 4000);
  GH_TIMER.unref?.();
}

async function githubRequest(method, url, bodyObj) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (bodyObj) headers["Content-Type"] = "application/json";

  const resp = await fetch(url, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });

  if (resp.status === 404) return { ok: false, status: 404, data: null };
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

async function getGithubFileSha(owner, repo, branch, filePath) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGithubPath(filePath)}?ref=${encodeURIComponent(branch)}`;
  const r = await githubRequest("GET", url);
  if (!r.ok) return null;
  return r.data?.sha || null;
}

async function putGithubFile(owner, repo, branch, filePath, contentStr, message, sha) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGithubPath(filePath)}`;
  const body = {
    message: message || "Atualização automática do banco de usuários",
    content: Buffer.from(String(contentStr), "utf-8").toString("base64"),
    branch
  };
  if (sha) body.sha = sha;

  const r = await githubRequest("PUT", url, body);
  if (!r.ok) throw new Error(`Falha GitHub PUT (${r.status}): ${JSON.stringify(r.data || {})}`);
  return r.data;
}

async function fetchGithubSnapshot() {
  if (!GITHUB_ENABLED) return null;
  const repoInfo = parseGithubRepo(GITHUB_REPO);
  if (!repoInfo) return null;

  const url = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/contents/${encodeGithubPath(GITHUB_DB_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const r = await githubRequest("GET", url);
  if (!r.ok) return null;
  const contentB64 = r.data?.content || "";
  if (!contentB64) return null;

  const txt = Buffer.from(String(contentB64).replace(/\n/g, ""), "base64").toString("utf-8");
  const snap = JSON.parse(txt);
  if (!snap || typeof snap !== "object") return null;
  if (!Array.isArray(snap.users) || !Array.isArray(snap.payments)) return null;
  return snap;
}

async function pushGithubSnapshot(contentStr, contentHash, reason = "auto") {
  if (!GITHUB_ENABLED) return;
  if (GH_IN_FLIGHT) return;

  const repoInfo = parseGithubRepo(GITHUB_REPO);
  if (!repoInfo) return;

  GH_IN_FLIGHT = true;
  try {
    const sha = await getGithubFileSha(repoInfo.owner, repoInfo.repo, GITHUB_BRANCH, GITHUB_DB_PATH);
    const msg = `Auto-save usuários (${reason})`;
    await putGithubFile(repoInfo.owner, repoInfo.repo, GITHUB_BRANCH, GITHUB_DB_PATH, contentStr, msg, sha);
    GH_LAST_HASH = contentHash || sha256Hex(contentStr);
  } finally {
    GH_IN_FLIGHT = false;
  }
}

// Restauração automática ao subir o servidor, se o DB local estiver vazio
async function bootstrapFromGithubIfEmpty() {
  try {
    if (!GITHUB_ENABLED) return;

    const hasLocal = (Array.isArray(DB?.users) && DB.users.length) || (Array.isArray(DB?.payments) && DB.payments.length);
    if (hasLocal) return;

    const snap = await fetchGithubSnapshot();
    if (!snap) return;

    const restored = {
      users: Array.isArray(snap.users) ? snap.users : [],
      payments: Array.isArray(snap.payments) ? snap.payments : [],
      audit: []
    };

    DB = mergeDbs(DB, restored);
    saveDb(DB, "github_bootstrap");
    console.log("[GITHUB] DB restaurado a partir do snapshot do GitHub.");
  } catch (e) {
    console.error("[GITHUB] Falha ao restaurar DB do GitHub:", e);
  }
}
setTimeout(() => { bootstrapFromGithubIfEmpty(); }, 1500).unref?.();



let DB = loadDb();

// Sessões em memória
const SESSIONS = new Map(); // token -> { role, userId, createdAt, lastSeenAt }
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const SESSION_IDLE_TTL_MS = 1000 * 60 * 30; // 30 min sem heartbeat

// Credenciais fixas do administrador (como solicitado), com possibilidade de override por variáveis
const ADMIN_LOGIN = "027-315-125-80";
const ADMIN_PASSWORD = "39-96-93";
const ADMIN_LOGIN_N = onlyDigits(ADMIN_LOGIN);
const ADMIN_PASSWORD_N = onlyDigits(ADMIN_PASSWORD);
const ADMIN_PASSWORD_ALT_N = "390693"; // aceita variante digitada sem pontuação

function audit(action, target, details) {
  try {
    DB.audit.push({
      id: makeId("aud"),
      at: nowIso(),
      action: String(action || ""),
      target: String(target || ""),
      details: String(details || "")
    });
    // Mantém um limite para não crescer indefinidamente
    if (DB.audit.length > 5000) DB.audit = DB.audit.slice(DB.audit.length - 5000);
    saveDb(DB);
  } catch {}
}

function createSession(role, userId, deviceId = "") {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  SESSIONS.set(token, { role, userId, deviceId: String(deviceId || ""), createdAt: now, lastSeenAt: now });
  return token;
}

function invalidateUserSessions(userId) {
  try {
    for (const [t, s] of SESSIONS.entries()) {
      if (!s) continue;
      if (s.role === "nurse" && s.userId === userId) SESSIONS.delete(t);
    }
  } catch {}
}

function tokenHash(token) {
  return sha256Hex(String(token || ""));
}

function isUserActiveSessionValid(user) {
  try {
    if (!user) return false;
    const h = String(user.activeSessionHash || "");
    const dev = String(user.activeDeviceId || "");
    if (!h || !dev) return false;

    const expMs = Date.parse(user.activeSessionExpiresAt || "") || 0;
    const lastMs = Date.parse(user.activeSessionLastSeenAt || "") || 0;
    if (!expMs || !lastMs) return false;

    const now = Date.now();
    if (now > expMs) return false;
    if ((now - lastMs) > SESSION_IDLE_TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

function clearUserActiveSession(user, reason = "expired") {
  if (!user) return;
  user.activeSessionHash = "";
  user.activeDeviceId = "";
  user.activeSessionCreatedAt = "";
  user.activeSessionLastSeenAt = "";
  user.activeSessionExpiresAt = "";
}

function setUserActiveSession(user, token, deviceId) {
  if (!user) return;
  const nowIsoStr = nowIso();
  user.activeSessionHash = tokenHash(token);
  user.activeDeviceId = String(deviceId || "");
  user.activeSessionCreatedAt = nowIsoStr;
  user.activeSessionLastSeenAt = nowIsoStr;
  user.activeSessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
}
function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  const now = Date.now();
  const createdAt = Number(s.createdAt || 0);
  const lastSeenAt = Number(s.lastSeenAt || 0);

  if ((createdAt && (now - createdAt > SESSION_TTL_MS)) || (lastSeenAt && (now - lastSeenAt > SESSION_IDLE_TTL_MS))) {
    SESSIONS.delete(token);
    return null;
  }
  return s;
}
function cleanupSessions() {
  const now = Date.now();

  // Limpa sessões em memória (TTL absoluto e inatividade)
  for (const [token, s] of SESSIONS.entries()) {
    const createdAt = Number(s?.createdAt || 0);
    const lastSeenAt = Number(s?.lastSeenAt || 0);
    const expired = (createdAt && (now - createdAt > SESSION_TTL_MS)) || (lastSeenAt && (now - lastSeenAt > SESSION_IDLE_TTL_MS));
    if (expired) SESSIONS.delete(token);
  }

  // Limpa sessões persistidas (para liberar login em outro dispositivo quando o usuário fecha o navegador)
  let dirty = false;
  for (const u of (Array.isArray(DB?.users) ? DB.users : [])) {
    if (!u || u.isDeleted) continue;
    if (u.activeSessionHash && !isUserActiveSessionValid(u)) {
      clearUserActiveSession(u, "auto_expire");
      dirty = true;
    }
  }
  if (dirty) saveDb(DB, "session_cleanup");
}
setInterval(cleanupSessions, 1000 * 60 * 10).unref?.();

function findUserByLogin(login) {
  const raw = String(login || "").trim();
  const digits = normalizeCpf(raw);
  const l = raw.toLowerCase();

  // Prefer CPF (11 dígitos) como identificador principal
  if (digits && digits.length === 11) {
    const byCpf = DB.users.find(u => normalizeCpf(u.cpf || u.login) === digits) || null;
    if (byCpf) {
      // migração suave
      if (!byCpf.cpf) byCpf.cpf = digits;
      if (String(byCpf.login || "") !== digits) byCpf.login = digits;
      return byCpf;
    }
  }

  // fallback: login textual antigo
  const direct = DB.users.find(u => String(u.login || "").trim().toLowerCase() === l) || null;
  if (direct) return direct;

  // fallback: somente dígitos
  if (!digits) return null;
  return DB.users.find(u => normalizeCpf(String(u.login || "").trim()) === digits) || null;
}

function isUserPaidMonth(userId, month) {
  const m = month || currentYYYYMM();
  return DB.payments.some(p => p.userId === userId && p.month === m && String(p.status || "confirmed") === "confirmed");
}

function isUserPaidThisMonth(userId) {
  return isUserPaidMonth(userId, currentYYYYMM());
}


function generateReferralCode(prefix) {
  const base = crypto.randomBytes(6).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();
  return `${prefix}${base}`;
}

function ensureUniqueFriendCode() {
  for (let i = 0; i < 80; i++) {
    const code = generateReferralCode("F");
    if (!DB.users.some(u => String(u.friendCode || "") === code)) return code;
  }
  return generateReferralCode("F") + String(Math.floor(Math.random() * 9));
}

function ensureUniquePartnerCode() {
  for (let i = 0; i < 80; i++) {
    const code = generateReferralCode("P");
    if (!DB.users.some(u => String(u.partnerCode || "") === code)) return code;
  }
  return generateReferralCode("P") + String(Math.floor(Math.random() * 9));
}

function findUserByFriendCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  return DB.users.find(u => !u.isDeleted && String(u.friendCode || "").toUpperCase() === c) || null;
}

function findUserByPartnerCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) return null;
  return DB.users.find(u => !u.isDeleted && String(u.partnerCode || "").toUpperCase() === c) || null;
}

function computeActiveFriendsThisMonth(referrerId) {
  const month = currentYYYYMM();
  const referred = DB.users.filter(u => !u.isDeleted && u.referrerId === referrerId && u.refType === "friend");
  let count = 0;
  for (const u of referred) {
    if (isUserPaidMonth(u.id, month)) count++;
  }
  return count;
}

function computeFriendDiscountThisMonth(userId) {
  const active = computeActiveFriendsThisMonth(userId);
  const rate = clamp(0.25 * active, 0, 1);
  return { activeFriendsThisMonth: active, discountRate: rate };
}

function computeAmountDueThisMonth(userId) {
  const { discountRate } = computeFriendDiscountThisMonth(userId);
  return round2(PRICE_MONTHLY * (1 - discountRate));
}

function findCommission(partnerUserId, referredUserId, month) {
  return DB.commissions.find(c => c.partnerUserId === partnerUserId && c.referredUserId === referredUserId && c.month === month) || null;
}

function createCommissionForPaymentIfNeeded(payment) {
  try {
    if (!payment || String(payment.status || "confirmed") !== "confirmed") return;
    const month = String(payment.month || "");
    if (!month) return;
    const referred = DB.users.find(u => u.id === payment.userId && !u.isDeleted);
    if (!referred) return;
    if (referred.refType !== "partner" || !referred.referrerId) return;

    const partnerId = referred.referrerId;
    if (!DB.users.some(u => u.id === partnerId && !u.isDeleted)) return;

    if (findCommission(partnerId, referred.id, month)) return;

    const baseAmount = round2(Number(payment.amount || 0));
    const commissionAmount = round2(baseAmount * 0.25);

    DB.commissions.push({
      id: makeId("com"),
      partnerUserId: partnerId,
      referredUserId: referred.id,
      month,
      baseAmount,
      commissionAmount,
      status: "pending",
      createdAt: nowIso()
    });
    saveDb(DB, "commission_create");
  } catch {}
}

function voidCommissionForPayment(payment) {
  try {
    if (!payment) return;
    const month = String(payment.month || "");
    const referred = DB.users.find(u => u.id === payment.userId && !u.isDeleted);
    if (!referred) return;
    if (referred.refType !== "partner" || !referred.referrerId) return;

    const c = findCommission(referred.referrerId, referred.id, month);
    if (!c) return;
    if (c.status === "void") return;
    c.status = "void";
    c.voidedAt = nowIso();
    saveDb(DB, "commission_void");
  } catch {}
}

function addPaymentConfirmed(userId, month, amount, method, notes, receivedBy) {
  const entry = {
    id: makeId("pay"),
    userId,
    month,
    paidAt: nowIso(),
    amount: (amount === null || amount === undefined) ? null : Number(amount),
    method: String(method || "manual"),
    notes: String(notes || ""),
    receivedBy: String(receivedBy || ""),
    status: "confirmed"
  };
  DB.payments.push(entry);
  saveDb(DB, "payment_confirmed");
  createCommissionForPaymentIfNeeded(entry);
  return entry;
}

function voidPaymentById(paymentId, voidedBy) {
  const p = DB.payments.find(x => x.id === paymentId);
  if (!p) return null;
  if (String(p.status || "confirmed") === "void") return p;
  p.status = "void";
  p.voidedAt = nowIso();
  p.voidedBy = String(voidedBy || "");
  saveDb(DB, "payment_void");
  voidCommissionForPayment(p);
  return p;
}


function isUserOnline(user) {
  const last = user?.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
  if (!last) return false;
  return (Date.now() - last) <= 1000 * 60 * 2; // 2 minutos
}

function getDeviceIdFromReq(req) {
  try {
    const raw = req && req.headers ? (req.headers["x-device-id"] || req.headers["X-Device-Id"] || req.headers["x-device-id".toLowerCase()] || "") : "";
    const id = String(raw || "").trim();
    if (!id) return "";
    if (id.length < 8 || id.length > 120) return "";
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) return "";
    return id;
  } catch {
    return "";
  }
}

function authFromReq(req) {
  const h = req.headers["authorization"] || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  let token = m ? m[1].trim() : "";
  if (!token) {
    const xt = req.headers["x-auth-token"] || req.headers["X-Auth-Token"] || "";
    token = String(xt || "").trim();
  }

  const deviceId = getDeviceIdFromReq(req);

  let sess = getSession(token);

  // Fallback: sessão persistida no usuário (sobrevive a restart e permite bloqueio de 1 dispositivo por conta)
  if (!sess && token) {
    const h = tokenHash(token);
    const user = (Array.isArray(DB?.users) ? DB.users : []).find(u => u && !u.isDeleted && String(u.activeSessionHash || "") === h && isUserActiveSessionValid(u)) || null;
    if (user) {
      const createdAtMs = Date.parse(user.activeSessionCreatedAt || "") || Date.now();
      const lastSeenAtMs = Date.parse(user.activeSessionLastSeenAt || "") || Date.now();
      sess = { role: "nurse", userId: user.id, deviceId: String(user.activeDeviceId || ""), createdAt: createdAtMs, lastSeenAt: lastSeenAtMs };
      SESSIONS.set(token, sess);
    }
  }

  if (!sess) return null;

  if (sess.role === "admin") {
    return { role: "admin", token, user: { id: "admin", login: ADMIN_LOGIN } };
  }

  // Nurse: exige deviceId e valida contra sessão ativa persistida
  if (!deviceId) return { invalidReason: "DEVICE_INVALID" };

  const user = DB.users.find(u => u.id === sess.userId) || null;
  if (!user || user.isDeleted) return null;

  const expectedHash = String(user.activeSessionHash || "");
  const expectedDev = String(user.activeDeviceId || "");

  if (!expectedHash || !expectedDev) return null;

  if (expectedHash !== tokenHash(token) || expectedDev !== deviceId) {
    try { SESSIONS.delete(token); } catch {}
    return { invalidReason: "SESSION_REPLACED" };
  }

  if (!isUserActiveSessionValid(user)) {
    try { SESSIONS.delete(token); } catch {}
    try {
      clearUserActiveSession(user, "expired");
      saveDb(DB, "session_expired");
    } catch {}
    return { invalidReason: "SESSION_EXPIRED" };
  }

  try { sess.lastSeenAt = Date.now(); } catch {}

  return { role: "nurse", token, user };
}


function sendAuthFailure(res, ctx) {
  const code = String(ctx?.invalidReason || "");
  if (code === "SESSION_REPLACED") {
    return res.status(401).json({ error: "Sessão encerrada porque esta conta foi acessada em outro dispositivo.", code: "SESSION_REPLACED" });
  }
  if (code === "SESSION_EXPIRED") {
    return res.status(401).json({ error: "Sessão expirada. Faça login novamente.", code: "SESSION_EXPIRED" });
  }
  if (code === "DEVICE_INVALID") {
    return res.status(401).json({ error: "Dispositivo inválido. Atualize a página e faça login novamente.", code: "DEVICE_INVALID" });
  }
  return res.status(401).json({ error: "Não autenticado.", code: code || "UNAUTH" });
}

function requireAuth(req, res, next) {
  const ctx = authFromReq(req);
  if (!ctx) return res.status(401).json({ error: "Não autenticado.", code: "UNAUTH" });
  if (ctx.invalidReason) return sendAuthFailure(res, ctx);
  req.auth = ctx;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao administrador." });
  next();
}

function requirePaidOrAdmin(req, res, next) {
  if (!req.auth) {
    const ctx = authFromReq(req);
    if (!ctx) return res.status(401).json({ error: "Não autenticado.", code: "UNAUTH" });
    if (ctx.invalidReason) return sendAuthFailure(res, ctx);
    req.auth = ctx;
  }

  if (req.auth.role === "admin") return next();

  const user = req.auth.user;
  if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });
  if (!user.isActive) return res.status(403).json({ error: "Acesso bloqueado: usuário inativo. Procure o administrador." });

  if (isTrialActive(user)) return next();

  if (isUserPaidThisMonth(user.id)) return next();

  try { maybeAutoChargeCardSubscription(user); } catch {}
  if (isUserPaidThisMonth(user.id)) return next();

  return res.status(402).json({ error: "Gratuidade encerrada. Faça o pagamento para continuar.", code: "NEEDS_PAYMENT" });
}

// Rotas de autenticação

// Cadastro público (auto-cadastro do enfermeiro)
// Observação: o acesso ao sistema continua condicionado à liberação e mensalidade (pagamento do mês).
app.post("/api/auth/signup", (req, res) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const dob = String(req.body?.dob || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const cpfRaw = String(req.body?.cpf || req.body?.login || "").trim();
    const cpf = normalizeCpf(cpfRaw);
    const referralCode = String(req.body?.referralCode || req.body?.referralCodeUsed || "").trim();
    const refType = String(req.body?.refType || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !cpf || !password) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone, CPF e senha são obrigatórios." });
    }

    // CPF obrigatório (login)
    if (!isValidCpf(cpf)) {
      return res.status(400).json({ error: "CPF inválido." });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
    }

    if (findUserByLogin(cpf)) {
      return res.status(409).json({ error: "Já existe usuário com este CPF." });
    }

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login: cpf,
      cpf,
      trialStartedAt: nowIso(),
      trialEndsAt: addDaysIso(nowIso(), TRIAL_DAYS),
      friendCode: ensureUniqueFriendCode(),
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      lastLoginAt: "",
      lastSeenAt: "",
      activeSessionHash: "",
      activeDeviceId: "",
      activeSessionCreatedAt: "",
      activeSessionLastSeenAt: "",
      activeSessionExpiresAt: ""
    };

    DB.users.push(user);
    saveDb(DB, "signup");
    // Aplica código de indicação (opcional)
    if (refType && referralCode) {
      const t = String(refType).toLowerCase();
      if (t !== "friend" && t !== "partner") {
        return res.status(400).json({ error: "Tipo de indicação inválido." });
      }
      let referrer = null;
      if (t === "friend") referrer = findUserByFriendCode(referralCode);
      if (t === "partner") referrer = findUserByPartnerCode(referralCode);
      if (!referrer) {
        return res.status(400).json({ error: "Código de indicação inválido." });
      }
      if (referrer.id === user.id || String(referrer.cpf || "") === String(user.cpf || "")) {
        return res.status(400).json({ error: "Autoindicação não é permitida." });
      }
      user.referrerId = referrer.id;
      user.refType = t;
      user.referralCodeUsed = String(referralCode).trim();
    }

    audit("user_signup", user.id, `Auto-cadastro do usuário ${user.login}`);
    return res.json({ ok: true, id: user.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao cadastrar usuário." });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const cpfRaw = String(req.body?.cpf || req.body?.login || "").trim();
    const login = normalizeCpf(cpfRaw);
    const senha = String(req.body?.senha || "").trim();
    if (!login || !senha) return res.status(400).json({ error: "CPF e senha são obrigatórios." });

    const deviceId = getDeviceIdFromReq(req);
    if (!deviceId) return res.status(400).json({ error: "Dispositivo inválido. Atualize a página e tente novamente." });

    // Admin (aceita com ou sem pontuação)
    const loginN = onlyDigits(login);
    const senhaN = onlyDigits(senha);
    if ((login === ADMIN_LOGIN && senha === ADMIN_PASSWORD) || (loginN && senhaN && loginN === ADMIN_LOGIN_N && (senhaN === ADMIN_PASSWORD_N || senhaN === ADMIN_PASSWORD_ALT_N))) {
      const token = createSession("admin", "admin", deviceId);
      audit("admin_login", "admin", "Login do administrador");
      return res.json({ token, role: "admin", login: ADMIN_LOGIN, currentMonth: currentYYYYMM() });
    }

    // Usuário enfermeiro
    const user = findUserByLogin(login);
    if (!user || user.isDeleted) return res.status(401).json({ error: "Credenciais inválidas." });
    if (ensureTrialFields(user)) saveDb(DB, "ensure_trial_login");
    if (!user.isActive) return res.status(403).json({ error: "Acesso bloqueado: usuário inativo. Procure o administrador." });

    const computed = sha256(`${user.salt || ""}:${senha}`);
    if (computed !== user.passwordHash) return res.status(401).json({ error: "Credenciais inválidas." });

    // Regra 1 pessoa por conta (1 dispositivo por vez)
    // - Ao fazer login em um novo dispositivo, a sessão anterior é encerrada automaticamente.
    // - O dispositivo antigo será deslogado na próxima requisição (401 com code SESSION_REPLACED).
    if (user.activeSessionHash) {
      if (!isUserActiveSessionValid(user)) {
        clearUserActiveSession(user, "auto_expire_on_login");
      } else if (String(user.activeDeviceId || "") !== deviceId) {
        audit("nurse_session_replaced", user.id, `Sessão substituída: ${user.activeDeviceId || "-"} -> ${deviceId}`);
      }
    }

    // Remove tokens antigos em memória (se existirem) e cria nova sessão
    invalidateUserSessions(user.id);

    const token = createSession("nurse", user.id, deviceId);
    setUserActiveSession(user, token, deviceId);

    user.lastLoginAt = nowIso();
    user.lastSeenAt = nowIso();

    saveDb(DB, "nurse_login");
    audit("nurse_login", user.id, `Login do usuário ${user.login}`);

    return res.json({
      token,
      role: "nurse",
      fullName: user.fullName,
      login: user.login,
      phone: user.phone,
      currentMonth: currentYYYYMM(),
      isPaidThisMonth: isUserPaidThisMonth(user.id),
      paidCurrentMonth: isUserPaidThisMonth(user.id),
      user: { id: user.id, fullName: user.fullName, login: user.login, phone: user.phone, currentMonth: currentYYYYMM(), isPaidThisMonth: isUserPaidThisMonth(user.id), paidCurrentMonth: isUserPaidThisMonth(user.id) }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha no login." });
  }
});


app.get("/api/auth/me", requireAuth, (req, res) => {
  const role = req.auth.role;
  if (role === "admin") return res.json({ role: "admin" });

  const u = req.auth.user;
  if (ensureTrialFields(u)) saveDb(DB, "ensure_trial_me");
  return res.json({
    role: "nurse",
    fullName: u.fullName,
    login: u.login,
    phone: u.phone,
    currentMonth: currentYYYYMM(),
    isPaidThisMonth: isUserPaidThisMonth(u.id),
    paidCurrentMonth: isUserPaidThisMonth(u.id),
    user: { id: u.id, fullName: u.fullName, login: u.login, phone: u.phone, currentMonth: currentYYYYMM(), isPaidThisMonth: isUserPaidThisMonth(u.id), paidCurrentMonth: isUserPaidThisMonth(u.id) }
  });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  const token = req?.auth?.token || "";
  try { SESSIONS.delete(token); } catch {}

  try {
    if (req.auth && req.auth.role === "nurse") {
      const u = req.auth.user;
      if (u && String(u.activeSessionHash || "") === tokenHash(token)) {
        clearUserActiveSession(u, "logout");
        u.lastSeenAt = nowIso();
        saveDb(DB, "logout");
        audit("nurse_logout", u.id, `Logout do usuário ${u.login}`);
      }
    } else if (req.auth && req.auth.role === "admin") {
      audit("admin_logout", "admin", "Logout do administrador");
    }
  } catch {}

  return res.json({ ok: true });
});


app.post("/api/auth/heartbeat", requireAuth, (req, res) => {
  try {
    const sess = getSession(req.auth.token);
    if (sess) sess.lastSeenAt = Date.now();

    if (req.auth.role === "nurse") {
      const u = req.auth.user;
      const nowIsoStr = nowIso();
      u.lastSeenAt = nowIsoStr;

      // Mantém sessão ativa (1 dispositivo) viva enquanto houver heartbeat
      if (String(u.activeSessionHash || "") === tokenHash(req.auth.token)) {
        u.activeSessionLastSeenAt = nowIsoStr;
        u.activeSessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      }

      saveDb(DB, "heartbeat");
    }
  } catch {}

  return res.json({ ok: true });
});


// Rotas administrativas
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const month = currentYYYYMM();
  const friendsByReferrer = new Map();
  for (const u of DB.users) {
    if (u && !u.isDeleted && String(u.refType || "") === "friend" && u.referrerId) {
      const arr = friendsByReferrer.get(u.referrerId) || [];
      arr.push(u);
      friendsByReferrer.set(u.referrerId, arr);
    }
  }

  const users = DB.users
    .filter(u => !u.isDeleted)
    .map(u => {
      const friendsRaw = friendsByReferrer.get(u.id) || [];
      const friends = friendsRaw
        .filter(f => !f.isDeleted)
        .map(f => ({
          id: f.id,
          fullName: f.fullName,
          cpf: f.cpf || f.login,
          isActive: !!f.isActive,
          isPaidThisMonth: isUserPaidMonth(f.id, month)
        }))
        .sort((a,b) => (a.fullName||"").localeCompare(b.fullName||""));

      return {
        id: u.id,
        fullName: u.fullName,
        dob: u.dob,
        phone: u.phone,
        cpf: u.cpf || u.login,
        login: u.login,
        isActive: !!u.isActive,
        active: !!u.isActive,
        lastLoginAt: u.lastLoginAt || "",
        lastSeenAt: u.lastSeenAt || "",
        isOnline: isUserOnline(u),
        isPaidThisMonth: isUserPaidThisMonth(u.id),
        paidCurrentMonth: isUserPaidThisMonth(u.id),
        friends
      };
    })
    .sort((a,b) => (a.fullName||"").localeCompare(b.fullName||""));
  return res.json({ users, month });
});

app.post("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const dob = String(req.body?.dob || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const cpfRaw = String(req.body?.cpf || req.body?.login || "").trim();
    const cpf = normalizeCpf(cpfRaw);
    const referralCode = String(req.body?.referralCode || req.body?.referralCodeUsed || "").trim();
    const refType = String(req.body?.refType || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !cpf || !password) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone, CPF e senha são obrigatórios." });
    }
    if (!isValidCpf(cpf)) return res.status(400).json({ error: "CPF inválido." });
    if (password.length < 4) return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
    if (findUserByLogin(cpf)) return res.status(409).json({ error: "Já existe usuário com este CPF." });

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login: cpf,
      cpf,
      trialStartedAt: nowIso(),
      trialEndsAt: addDaysIso(nowIso(), TRIAL_DAYS),
      friendCode: ensureUniqueFriendCode(),
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      lastLoginAt: "",
      lastSeenAt: "",
      activeSessionHash: "",
      activeDeviceId: "",
      activeSessionCreatedAt: "",
      activeSessionLastSeenAt: "",
      activeSessionExpiresAt: ""
    };

    // Aplica indicação se informada (mesmas regras do cadastro público)
    if (refType && referralCode) {
      const t = String(refType).toLowerCase();
      if (t !== "friend" && t !== "partner") {
        return res.status(400).json({ error: "Tipo de indicação inválido." });
      }
      let referrer = null;
      if (t === "friend") referrer = findUserByFriendCode(referralCode);
      if (t === "partner") referrer = findUserByPartnerCode(referralCode);
      if (!referrer) return res.status(400).json({ error: "Código de indicação inválido." });
      if (referrer.id === user.id || String(referrer.cpf || "") === String(user.cpf || "")) {
        return res.status(400).json({ error: "Autoindicação não é permitida." });
      }
      user.referrerId = referrer.id;
      user.refType = t;
      user.referralCodeUsed = String(referralCode).trim();
    }

    DB.users.push(user);
    saveDb(DB, "admin_user_create");
    audit("user_create", user.id, `Criado usuário ${cpf}`);
    return res.json({ ok: true, user: { id: user.id } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao cadastrar usuário." });
  }
});

app.put("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const user = DB.users.find(u => u.id === id && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const fullName = String(req.body?.fullName ?? user.fullName ?? "").trim();
    const dob = String(req.body?.dob ?? user.dob ?? "").trim();
    const phone = String(req.body?.phone ?? user.phone ?? "").trim();
    const cpfRaw = String(req.body?.cpf ?? req.body?.login ?? user.cpf ?? user.login ?? "").trim();
    const cpf = normalizeCpf(cpfRaw);
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !cpf) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone e CPF são obrigatórios." });
    }
    if (!isValidCpf(cpf)) return res.status(400).json({ error: "CPF inválido." });

    // Se mudar o CPF/login, garantir unicidade
    const existing = DB.users.find(u => !u.isDeleted && u.id !== id && normalizeCpf(u.cpf || u.login) === cpf);
    if (existing) return res.status(409).json({ error: "Já existe usuário com este CPF." });

    user.fullName = fullName;
    user.dob = dob;
    user.phone = phone;
    user.cpf = cpf;
    user.login = cpf;

    if (!user.friendCode) user.friendCode = ensureUniqueFriendCode();
    if (ensureTrialFields(user)) {
      // garante trial para registros antigos
    }

    if (password) {
      if (password.length < 4) return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
      const salt = crypto.randomBytes(10).toString("hex");
      user.salt = salt;
      user.passwordHash = sha256(`${salt}:${password}`);
      audit("user_update_password", id, `Senha atualizada para ${user.login}`);
    }

    saveDb(DB, "admin_user_update");
    audit("user_update", id, `Dados atualizados para ${user.login}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao editar usuário." });
  }
});



app.post("/api/admin/users/:id/reset-password", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const newPassword = String(req.body?.newPassword || "").trim();
    if (!newPassword) return res.status(400).json({ error: "Nova senha é obrigatória." });
    const user = DB.users.find(u => u.id === id && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const salt = crypto.randomBytes(10).toString("hex");
    user.salt = salt;
    user.passwordHash = sha256(`${salt}:${newPassword}`);
    saveDb(DB);
    audit("user_reset_password", id, `Senha resetada para ${user.login}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao resetar senha." });
  }
});

app.post("/api/admin/users/:id/active", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const active = !!req.body?.active;
    const user = DB.users.find(u => u.id === id && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
    user.isActive = active;
    saveDb(DB);
    audit("user_set_active", id, `Ativo=${active} para ${user.login}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao atualizar usuário." });
  }
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const user = DB.users.find(u => u.id === id && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
    user.isDeleted = true;
    user.isActive = false;
    saveDb(DB);
    audit("user_delete_logical", id, `Exclusão lógica de ${user.login}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao excluir usuário." });
  }
});

app.post("/api/admin/users/:id/pay", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const month = String(req.body?.month || "").trim();
    const amount = (req.body?.amount === null || req.body?.amount === undefined || req.body?.amount === "") ? null : Number(req.body.amount);
    const method = String(req.body?.method || "").trim();
    const notes = String(req.body?.notes || "").trim();

    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Mês inválido. Use AAAA-MM." });
    const user = DB.users.find(u => u.id === id && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const exists = DB.payments.some(p => p.userId === id && p.month === month && String(p.status || "confirmed") === "confirmed");
    if (exists) return res.status(409).json({ error: "Este mês já consta como pago para o usuário." });

    const entry = {
      id: makeId("pay"),
      userId: id,
      month,
      paidAt: nowIso(),
      amount: (Number.isFinite(amount) ? amount : null),
      method,
      notes,
      receivedBy: (req.auth?.user?.login || ADMIN_LOGIN || "admin")
    };
    DB.payments.push(entry);
    // Mantém limite (histórico permanente, mas com teto alto)
    if (DB.payments.length > 20000) DB.payments = DB.payments.slice(DB.payments.length - 20000);

    saveDb(DB);
    audit("payment_add", id, `Pagamento registrado: ${month} | recebido por: ${req.auth?.user?.login || ADMIN_LOGIN}`);
    return res.json({ ok: true, payment: entry });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao registrar pagamento." });
  }
});

app.get("/api/admin/users/:id/payments", requireAuth, requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const payments = DB.payments
    .filter(p => p.userId === id)
    .sort((a,b) => String(b.month).localeCompare(String(a.month)));
  return res.json({ payments });
});

app.get("/api/admin/payments", requireAuth, requireAdmin, (req, res) => {
  const usersById = new Map(DB.users.map(u => [u.id, u]));
  const payments = DB.payments
    .map(p => {
      const u = usersById.get(p.userId);
      return {
        userId: p.userId,
        userName: u?.fullName || "",
        userLogin: u?.login || "",
        month: p.month,
        paidAt: p.paidAt,
        amount: p.amount,
        method: p.method,
        notes: p.notes,
        receivedBy: p.receivedBy || ""
      };
    })
    .sort((a,b) => (String(b.paidAt||"").localeCompare(String(a.paidAt||""))));
  return res.json({ payments });
});

app.get("/api/admin/audit", requireAuth, requireAdmin, (req, res) => {
  const usersById = new Map(DB.users.map(u => [u.id, u]));
  const auditList = DB.payments
    .map(p => {
      const u = usersById.get(p.userId);
      return {
        at: p.paidAt,
        userId: p.userId,
        userName: u?.fullName || "",
        userLogin: u?.login || "",
        month: p.month,
        paidAt: p.paidAt,
        amount: p.amount,
        method: p.method,
        notes: p.notes,
        receivedBy: p.receivedBy || ""
      };
    })
    .sort((a, b) => (String(b.at || "").localeCompare(String(a.at || ""))));
  return res.json({ audit: auditList });
});
// ======================================================================
// BACKUP / RESTAURAÇÃO (ADMIN) – segurança contra perda de dados
// - Exporta DB em JSON para o administrador guardar
// - Importa/mescla backup sem apagar histórico (merge)
// ======================================================================

app.get("/api/admin/backup/list", requireAuth, requireAdmin, (req, res) => {
  try {
    const items = listBackupFiles().slice(0, 50).map(x => ({
      file: x.f,
      mtimeMs: x.t
    }));
    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao listar backups." });
  }
});

app.post("/api/admin/backup/create", requireAuth, requireAdmin, (req, res) => {
  try {
    backupFile(DB_PATH, "manual");
    audit("backup_manual", "db", "Backup manual criado");
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao criar backup." });
  }
});

app.get("/api/admin/backup/export", requireAuth, requireAdmin, (req, res) => {
  try {
    const payload = {
      schemaVersion: 1,
      exportedAt: nowIso(),
      app: "Atendimento de Enfermagem",
      db: normalizeDb(DB),
    };
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="enfermagem-backup-${new Date().toISOString().slice(0,10)}.json"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (e) {
    return res.status(500).json({ error: "Falha ao exportar backup." });
  }
});

app.post("/api/admin/backup/import", requireAuth, requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const incoming = body.db && typeof body.db === "object" ? body.db : body;
    const imported = normalizeDb(incoming);

    // Mescla: nunca apaga, apenas adiciona/atualiza pelo critério do mergeDbs
    const before = { users: DB.users.length, payments: DB.payments.length, audit: DB.audit.length };
    const merged = mergeDbs(DB, imported);

    DB = merged;
    saveDb(DB, "import");
    audit("backup_import", "db", `Import realizado. Antes users=${before.users}, payments=${before.payments}; Depois users=${DB.users.length}, payments=${DB.payments.length}`);

    return res.json({
      ok: true,
      before,
      after: { users: DB.users.length, payments: DB.payments.length, audit: DB.audit.length }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao importar backup." });
  }
});





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
// ROTA 1 – GERAR SOAP E PRESCRIÇÃO A PARTIR DA TRANSCRIÇÃO (EXISTENTE)
// ======================================================================

app.post("/api/gerar-soap", requirePaidOrAdmin, async(req, res) => {
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
2) Gere a EVOLUÇÃO DE ENFERMAGEM (texto corrido), própria para prontuário, baseada exclusivamente na transcrição.
3) Gere um PLANO DE CUIDADOS (prescrição de enfermagem), com itens objetivos, monitorização, educação em saúde e critérios claros para escalar para avaliação médica.

Regras obrigatórias:
- Não invente dados. Se faltar informação, registre como "não informado" ou "não foi referido".
- Sem emojis, sem símbolos gráficos (como ✓, ❌, bullets com ícones).
- Não faça diagnóstico médico definitivo. Foque em achados, hipóteses de enfermagem e condutas de enfermagem.
- Use linguagem prática para colar no sistema.
- Mantenha o texto seguro: inclua sinais de alarme e critérios de encaminhamento quando pertinente.

Formato de saída: JSON estrito, sem texto fora do JSON, com as chaves:
{
  "soap": "S: ...\nO: ...\nA: ...\nP: ...",
  "evolucao_enfermagem": "Evolução de enfermagem em texto corrido",
  "prescricao": "Plano de cuidados em texto corrido ou itens numerados"
}

Conteúdo mínimo esperado:
SOAP:
- S: queixa, início, sintomas associados, fatores de risco, alergias relevantes se citadas, medicações em uso se citadas.
- O: sinais vitais se presentes, exame objetivo descrito, achados relevantes, contexto (gestante/lactante quando aplicável).
- A: avaliação de enfermagem (problemas/necessidades), riscos (queda, LPP, desidratação etc) quando pertinentes.
- P: intervenções e orientações de enfermagem, monitorização, encaminhamentos, retorno, sinais de alarme.

EVOLUÇÃO DE ENFERMAGEM (texto corrido):
- Registro narrativo para prontuário, baseado apenas no que estiver na transcrição.
- Deve refletir quadro atual, intervenções/condutas de enfermagem, resposta do paciente quando citada, e plano imediato.
- Incluir segurança: sinais de alarme e critérios objetivos de reavaliação/encaminhamento quando pertinente.
- Se dados essenciais não estiverem na transcrição (por exemplo: data/hora, sinais vitais, antecedentes), use "não informado".


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
    const evolucao_enfermagem = typeof data?.evolucao_enfermagem === "string" ? data.evolucao_enfermagem.trim() : "";
    const prescricao = typeof data?.prescricao === "string" ? data.prescricao.trim() : "";

    return res.json({ soap, evolucao_enfermagem, prescricao });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar evolução/plano de cuidados." });
  }
});


// ======================================================================
// ROTA EXTRA – GERAR RELATÓRIO DE TRIAGEM HOSPITALAR A PARTIR DA TRANSCRIÇÃO
// ======================================================================

app.post("/api/gerar-triagem-hospitalar", requirePaidOrAdmin, async(req, res) => {
  try {
    const { transcricao } = req.body || {};

    const t = normalizeText(transcricao || "", 12000);
    if (!t || t.length < 30) {
      return res.json({
        nivel_risco: "não informado",
        tempo_maximo: "",
        justificativa_risco: "",
        alertas_red_flags: "",
        condutas_nao_medicamentosas: "",
        condutas_medicamentosas: "",
        medidas_exames_imediatos: "",
        passagem_medico: "",
        texto_prontuario: "",
        pendencias_checar: "",
        checagem_qualidade: "",
        relatorio_completo: ""
      });
    }

    const prompt = `
Você é um enfermeiro preceptor especializado em triagem hospitalar (porta de urgência/emergência).
Tarefa: a partir da transcrição de uma triagem gravada, gere um relatório técnico completo e acionável para uso imediato.

Regras:
- Não invente dados. Se uma informação não estiver presente, escreva "não informado" ou descreva o que precisa ser checado.
- Use linguagem técnica, objetiva e organizada.
- Inclua tratamento não medicamentoso e, quando fizer sentido, tratamento medicamentoso sugerido (sempre com ressalva de que depende de protocolos locais e prescrição médica quando aplicável).
- Classifique risco por cores (Vermelho, Laranja, Amarelo, Verde, Azul) e indique tempo máximo de atendimento.
- Foque em segurança: identificar red flags, ABCDE, dor, sangramento, dispneia, rebaixamento de consciência, sinais de sepse, choque, AVC, SCA, anafilaxia, trauma, gestação, pediatria, intoxicação quando pertinente.

Formato de saída: JSON estrito, exatamente com as chaves abaixo:
{
  "nivel_risco": "Vermelho|Laranja|Amarelo|Verde|Azul|não informado",
  "tempo_maximo": "string curta",
  "justificativa_risco": "string",
  "alertas_red_flags": "string",
  "condutas_nao_medicamentosas": "string",
  "condutas_medicamentosas": "string",
  "medidas_exames_imediatos": "string",
  "passagem_medico": "string",
  "texto_prontuario": "string",
  "pendencias_checar": "string",
  "checagem_qualidade": "string",
  "relatorio_completo": "string"
}

Transcrição:
"""${t}"""
`;

    if (!process.env.OPENAI_API_KEY) {
      return res.json({
        nivel_risco: "não informado",
        tempo_maximo: "",
        justificativa_risco: "",
        alertas_red_flags: "Sem chave OPENAI_API_KEY configurada no servidor.",
        condutas_nao_medicamentosas: "",
        condutas_medicamentosas: "",
        medidas_exames_imediatos: "",
        passagem_medico: "",
        texto_prontuario: "",
        pendencias_checar: "",
        checagem_qualidade: "",
        relatorio_completo: ""
      });
    }

    const data = await callOpenAIJson(prompt);

    const out = {
      nivel_risco: normalizeText(data?.nivel_risco || "não informado", 40) || "não informado",
      tempo_maximo: normalizeText(data?.tempo_maximo || "", 120),
      justificativa_risco: normalizeText(data?.justificativa_risco || "", 1200),
      alertas_red_flags: normalizeText(data?.alertas_red_flags || "", 2000),
      condutas_nao_medicamentosas: normalizeText(data?.condutas_nao_medicamentosas || "", 2400),
      condutas_medicamentosas: normalizeText(data?.condutas_medicamentosas || "", 2400),
      medidas_exames_imediatos: normalizeText(data?.medidas_exames_imediatos || "", 2000),
      passagem_medico: normalizeText(data?.passagem_medico || "", 1800),
      texto_prontuario: normalizeText(data?.texto_prontuario || "", 2400),
      pendencias_checar: normalizeText(data?.pendencias_checar || "", 1600),
      checagem_qualidade: normalizeText(data?.checagem_qualidade || "", 1600),
      relatorio_completo: normalizeText(data?.relatorio_completo || "", 6000)
    };

    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar triagem hospitalar." });
  }
});






// ======================================================================
// ROTA EXTRA – GERAR PASSAGEM DE PLANTÃO (ENFERMAGEM) A PARTIR DA TRANSCRIÇÃO
// ======================================================================

app.post("/api/gerar-passagem-plantao", requirePaidOrAdmin, async(req, res) => {
  try {
    const { transcricao } = req.body || {};

    const t = normalizeText(transcricao || "", 12000);
    if (!t || t.length < 30) {
      return res.json({ passagem_plantao: "" });
    }

    const prompt = `
Você é um enfermeiro humano fazendo passagem de plantão (handoff) para outro colega, com linguagem técnica, objetiva e segura.
Tarefa: a partir da transcrição abaixo, gere uma PASSAGEM DE PLANTÃO clara, enxuta e completa para uso imediato.

Regras obrigatórias:
- Não invente dados. Se faltar informação, escreva "não informado" e indique o que precisa ser checado.
- Sem emojis, sem símbolos gráficos (como ✓, ❌).
- Priorize segurança: riscos, sinais de alarme, dispositivos, medicações críticas, pendências e próximos passos.
- Se houver vários pacientes, separe por paciente e identifique cada um.
- Se houver apenas um paciente, produza um texto único e organizado.

Formato de saída: JSON estrito, sem texto fora do JSON, com a chave:
{
  "passagem_plantao": "texto em português do Brasil"
}

Sugestão de estrutura (adapte ao que existir na transcrição):
- Identificação: nome, idade, leito/setor, diagnóstico/hipótese, motivo.
- Situação atual: estado geral/consciência, dor, sinais vitais recentes, oxigênio, diurese/balanço quando pertinente.
- Evolução no turno: eventos, intercorrências, procedimentos e resposta.
- Dispositivos e cuidados: acessos, sondas, drenos, curativos, precauções/isolamento, risco de queda/LPP.
- Medicações/terapias em curso: itens e horários críticos (se citados).
- Exames/resultados: principais achados e pendências.
- Plano e pendências: o que fazer/monitorar no próximo turno e critérios de alarme.

Transcrição:
"""${t}"""
`;

    const data = await callOpenAIJson(prompt);
    const passagem = typeof data?.passagem_plantao === "string" ? data.passagem_plantao.trim() : "";

    return res.json({ passagem_plantao: passagem });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar passagem de plantão." });
  }
});

// ======================================================================
// ROTA 2 – RECOMENDAÇÕES DE PERGUNTAS COMPLEMENTARES (ANAMNESE) (EXISTENTE)
// ======================================================================

app.post("/api/recomendacoes-anamnese", requirePaidOrAdmin, async(req, res) => {
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

app.post("/api/atualizar-soap-perguntas", requirePaidOrAdmin, async(req, res) => {
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
2) Evolução de enfermagem (texto corrido) para prontuário, baseada apenas nas informações disponíveis.
3) Plano de cuidados (prescrição de enfermagem), mantendo-o objetivo e seguro.

Regras:
- Não invente dados.
- Sem emojis e sem símbolos gráficos.
- Não faça diagnóstico médico definitivo.

Formato de saída: JSON estrito:
{
  "soap": "S: ...\nO: ...\nA: ...\nP: ...",
  "evolucao_enfermagem": "Evolução de enfermagem em texto corrido",
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
    const evolucao_enfermagem = typeof data?.evolucao_enfermagem === "string" ? data.evolucao_enfermagem.trim() : "";
    const prescricao = typeof data?.prescricao === "string" ? data.prescricao.trim() : "";
    return res.json({ soap, evolucao_enfermagem, prescricao });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao atualizar evolução." });
  }
});




// ======================================================================
// ROTA 3 – GERAR PASSAGEM DE PLANTÃO (SBAR) A PARTIR DA TRANSCRIÇÃO (NOVO)
// ======================================================================

async function generateSbarTextFromTranscript(transcricao) {
  const safeTranscricao = normalizeText(transcricao || "", 25000);
  if (!safeTranscricao || safeTranscricao.length < 30) return "";

  const prompt = `
Você é um enfermeiro humano experiente em passagem de plantão hospitalar.
Tarefa: a partir da transcrição completa (perguntas e respostas) de uma coleta verbal para passagem de plantão, gere uma PASSAGEM DE PLANTÃO no padrão SBAR, com máxima completude e qualidade.

Regras obrigatórias:
- Não invente dados. Se uma informação crítica não estiver presente, escreva "não informado".
- Linguagem técnica, direta e operacional.
- Sem emojis e sem símbolos gráficos.
- Priorize segurança do paciente: dispositivos, antibióticos, alergias, isolamentos, riscos (queda, LPP, broncoaspiração), sinais de alarme, pendências e tarefas do próximo turno.
- Se houver medicações com horário (especialmente antibióticos, insulinoterapia, anticoagulação, vasoativos, analgesia), registre a próxima dose se estiver no texto; caso contrário, "não informado".
- Se houver exames pendentes, registre o que está pendente e o que fazer com o resultado.
- Se houver parâmetros de monitorização e metas, registre.
- Se houver deterioração clínica, destaque com clareza.

Saída:
- Retorne JSON estrito com a chave "sbar" contendo um texto pronto para copiar e imprimir.
- Estruture o texto exatamente nesta ordem de seções (uma por linha, com dois-pontos):
  Identificação:
  Situação:
  Background:
  Avaliação:
  Recomendação:
  Itens críticos não informados:

Formato de saída: JSON estrito:
{ "sbar": "Identificação: ...\nSituação: ...\nBackground: ...\nAvaliação: ...\nRecomendação: ...\nItens críticos não informados: ..." }

Transcrição:
"""${safeTranscricao}"""
`;

  const data = await callOpenAIJson(prompt);
  const sbar = typeof data?.sbar === "string" ? data.sbar.trim() : "";
  return sbar;
}

app.post("/api/gerar-sbar", requirePaidOrAdmin, async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    const t = normalizeText(transcricao || "", 25000);

    if (!t || t.length < 30) {
      return res.json({ sbar: "" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.json({ sbar: "Identificação: não informado\nSituação: não informado\nBackground: não informado\nAvaliação: não informado\nRecomendação: não informado\nItens críticos não informados: Sem chave OPENAI_API_KEY configurada no servidor." });
    }

    const sbar = await generateSbarTextFromTranscript(t);
    return res.json({ sbar });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar SBAR." });
  }
});

// Rota legada (mantida por compatibilidade). Retorna no campo antigo "prescricao_hospitalar".
app.post("/api/prescricao-hospitalar", requirePaidOrAdmin, async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    const t = normalizeText(transcricao || "", 25000);

    if (!t || t.length < 30) {
      return res.json({ prescricao_hospitalar: "" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.json({ prescricao_hospitalar: "Identificação: não informado\nSituação: não informado\nBackground: não informado\nAvaliação: não informado\nRecomendação: não informado\nItens críticos não informados: Sem chave OPENAI_API_KEY configurada no servidor." });
    }

    const sbar = await generateSbarTextFromTranscript(t);
    return res.json({ prescricao_hospitalar: sbar, sbar });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar SBAR." });
  }
});




// ======================================================================
// ROTA 4 – CLASSIFICAR MEDICAMENTOS EM GESTAÇÃO E LACTAÇÃO (NOVA)
// ======================================================================

app.post("/api/classificar-gestacao-lactacao", requirePaidOrAdmin, async(req, res) => {
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

app.post("/api/interacoes-medicamentosas", requirePaidOrAdmin, async(req, res) => {
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

app.post("/api/apresentacoes-dosagem-maxima", requirePaidOrAdmin, async(req, res) => {
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

app.post("/api/extrair-dados-paciente", requirePaidOrAdmin, async(req, res) => {
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

app.post("/api/classificacao-risco", requirePaidOrAdmin, async(req, res) => {
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
Você é um médico e educador clínico com experiência em feridas e curativos. A partir de uma foto de lesão, descreva e oriente de forma técnica e prudente.

Tarefas:
1) Descrever somente características VISÍVEIS, com linguagem técnica e prudente (sem inventar).
2) Sugerir conduta e cuidados locais, separando:
   - Tratamento não medicamentoso (limpeza, cobertura, frequência de troca, proteção da pele perilesional, alívio de pressão, compressão quando indicada, elevação, educação e monitorização).
   - Tratamento medicamentoso quando fizer sentido (por exemplo: analgesia, necessidade de profilaxia do tétano conforme história vacinal, e quando considerar antibiótico tópico ou sistêmico com critérios clínicos). Não prescrever antibiótico sistêmico sem critérios; se houver suspeita, orientar avaliação médica e seguir protocolo local.
3) Informar sinais de alarme e critérios objetivos para encaminhamento/avaliação urgente.
4) Incluir observações importantes (limitações da foto, necessidade de medidas/escala, tempo de evolução, comorbidades relevantes como diabetes/vasculopatia).

Regras obrigatórias:
- Não fazer diagnóstico médico definitivo.
- Não inventar tamanho/profundidade/temperatura/dor/odor ou achados que não estejam visualmente sustentados.
- Se a imagem estiver insuficiente (iluminação, foco, ângulo), diga "não informado" nos itens que não forem confiáveis.
- Evitar afirmações absolutas quando houver incerteza.
- Sem emojis e sem símbolos gráficos.

Formato de saída: JSON estrito:
{
  "descricao_tecnica": "string",
  "tratamento_nao_medicamentoso": "string",
  "tratamento_medicamentoso": "string",
  "sinais_alarme": "string",
  "observacoes": "string"
}
`;

  const data = await callOpenAIVisionJson(prompt, safeImage);

  const descricao_tecnica = typeof data?.descricao_tecnica === "string" ? data.descricao_tecnica.trim() : "";
  const tratamento_nao_medicamentoso = typeof data?.tratamento_nao_medicamentoso === "string" ? data.tratamento_nao_medicamentoso.trim() : "";
  const tratamento_medicamentoso = typeof data?.tratamento_medicamentoso === "string" ? data.tratamento_medicamentoso.trim() : "";
  const sinais_alarme = typeof data?.sinais_alarme === "string" ? data.sinais_alarme.trim() : "";
  const observacoes = typeof data?.observacoes === "string" ? data.observacoes.trim() : "";

  return {
    descricao_tecnica: descricao_tecnica || "não informado",
    tratamento_nao_medicamentoso: tratamento_nao_medicamentoso || "não informado",
    tratamento_medicamentoso: tratamento_medicamentoso || "não informado",
    sinais_alarme: sinais_alarme || "não informado",
    observacoes: observacoes || "não informado"
  };
}

app.post("/api/analisar-lesao", requirePaidOrAdmin, async(req, res) => {
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
app.post("/api/analisar-lesao-imagem", requirePaidOrAdmin, async(req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000);

    if (!safeImage) {
      return res.status(400).json({ error: "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente." });
    }

    const out = await analisarLesaoPorImagem(safeImage);
    const texto =
      "Descrição técnica:\n" + out.descricao_tecnica +
      "\n\nTratamento não medicamentoso:\n" + out.tratamento_nao_medicamentoso +
      "\n\nTratamento medicamentoso:\n" + out.tratamento_medicamentoso +
      "\n\nSinais de alarme e encaminhamento:\n" + out.sinais_alarme +
      "\n\nObservações:\n" + out.observacoes;

    return res.json({ texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao analisar a lesão." });
  }
});



// ======================================================================
// ROTA 4.6 – INTERPRETAÇÃO DE EXAME POR FOTO (NOVA)
// ======================================================================

async function interpretarExamePorImagem(safeImage) {
  const prompt = `
Você é um médico e educador clínico interpretando um resultado de exame fotografado (laboratorial, laudo de imagem, tabela, impressão de sistema, etc).

Tarefas:
1) Transcrever somente o que estiver legível. Quando algo não estiver legível, usar "não informado".
2) Identificar achados principais e valores que chamem atenção (quando estiverem legíveis).
3) Oferecer interpretação clínica didática: o que pode significar, hipóteses possíveis e como correlacionar com sintomas e exame físico.
4) Recomendar próximos passos: que informações faltam, quando repetir/confirmar, exames complementares possíveis, e critérios de encaminhamento.
5) Incluir sinais de alarme e situações em que a avaliação deve ser urgente.

Regras obrigatórias:
- Não inventar dados ou resultados.
- Se a imagem estiver insuficiente (iluminação, foco, ângulo), dizer "não informado" no que não for confiável.
- Evitar diagnóstico definitivo sem contexto clínico.
- Sem emojis e sem símbolos gráficos.

Formato de saída: JSON estrito:
{
  "transcricao_legivel": "string",
  "achados_principais": "string",
  "interpretacao": "string",
  "hipoteses": "string",
  "proximos_passos": "string",
  "sinais_alarme": "string",
  "limitacoes": "string"
}
`;

  const data = await callOpenAIVisionJson(prompt, safeImage);

  const transcricao_legivel = typeof data?.transcricao_legivel === "string" ? data.transcricao_legivel.trim() : "";
  const achados_principais = typeof data?.achados_principais === "string" ? data.achados_principais.trim() : "";
  const interpretacao = typeof data?.interpretacao === "string" ? data.interpretacao.trim() : "";
  const hipoteses = typeof data?.hipoteses === "string" ? data.hipoteses.trim() : "";
  const proximos_passos = typeof data?.proximos_passos === "string" ? data.proximos_passos.trim() : "";
  const sinais_alarme = typeof data?.sinais_alarme === "string" ? data.sinais_alarme.trim() : "";
  const limitacoes = typeof data?.limitacoes === "string" ? data.limitacoes.trim() : "";

  return {
    transcricao_legivel: transcricao_legivel || "não informado",
    achados_principais: achados_principais || "não informado",
    interpretacao: interpretacao || "não informado",
    hipoteses: hipoteses || "não informado",
    proximos_passos: proximos_passos || "não informado",
    sinais_alarme: sinais_alarme || "não informado",
    limitacoes: limitacoes || "não informado"
  };
}


async function transcreverDocumentoPorImagem(safeImage) {
  const prompt = `
Você é um profissional de saúde transcrevendo um documento ou prescrição fotografada.

Tarefa:
1) Transcrever somente o que estiver legível (sem inventar). Se houver trechos ilegíveis ou duvidosos, marque como "não informado".
2) Organizar o conteúdo de forma clara. Se for prescrição, liste os itens em linhas separadas com: nome do medicamento, concentração/apresentação, dose, via, posologia, duração e observações quando existirem.
3) Não interpretar, não sugerir conduta, não calcular doses, não orientar tratamento. Apenas transcrever e organizar.
4) Preserve informações como datas, identificação, carimbos/assinaturas quando estiverem visíveis.
5) Sem emojis e sem símbolos gráficos.

Responda EXCLUSIVAMENTE em JSON, sem markdown, neste formato:
{
  "tipo_documento": "string",
  "identificacao": "string",
  "transcricao_organizada": "string",
  "itens_prescricao": "string",
  "campos_pendentes": "string",
  "limitacoes": "string"
}
`;

  const data = await callOpenAIVisionJson(prompt, safeImage);

  const tipo_documento = typeof data?.tipo_documento === "string" ? data.tipo_documento.trim() : "";
  const identificacao = typeof data?.identificacao === "string" ? data.identificacao.trim() : "";
  const transcricao_organizada = typeof data?.transcricao_organizada === "string" ? data.transcricao_organizada.trim() : "";
  const itens_prescricao = typeof data?.itens_prescricao === "string" ? data.itens_prescricao.trim() : "";
  const campos_pendentes = typeof data?.campos_pendentes === "string" ? data.campos_pendentes.trim() : "";
  const limitacoes = typeof data?.limitacoes === "string" ? data.limitacoes.trim() : "";

  return {
    tipo_documento: tipo_documento || "não informado",
    identificacao: identificacao || "não informado",
    transcricao_organizada: transcricao_organizada || "não informado",
    itens_prescricao: itens_prescricao || "não informado",
    campos_pendentes: campos_pendentes || "não informado",
    limitacoes: limitacoes || "não informado"
  };
}


app.post("/api/interpretar-exame-imagem", requirePaidOrAdmin, async(req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000);

    if (!safeImage) {
      return res.status(400).json({ error: "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente." });
    }

    const out = await interpretarExamePorImagem(safeImage);
    const texto =
      "Transcrição legível:\n" + out.transcricao_legivel +
      "\n\nAchados principais:\n" + out.achados_principais +
      "\n\nInterpretação:\n" + out.interpretacao +
      "\n\nHipóteses possíveis:\n" + out.hipoteses +
      "\n\nPróximos passos:\n" + out.proximos_passos +
      "\n\nSinais de alarme:\n" + out.sinais_alarme +
      "\n\nLimitações:\n" + out.limitacoes;

    return res.json({ texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao interpretar o exame." });
  }

app.post("/api/transcrever-documento-imagem", requirePaidOrAdmin, async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000);

    if (!safeImage) {
      return res.status(400).json({
        error:
          "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente."
      });
    }

    const out = await transcreverDocumentoPorImagem(safeImage);
    const texto =
      "Tipo de documento:\n" + out.tipo_documento +
      "\n\nIdentificação:\n" + out.identificacao +
      "\n\nTranscrição organizada:\n" + out.transcricao_organizada +
      "\n\nItens da prescrição (se aplicável):\n" + out.itens_prescricao +
      "\n\nCampos pendentes:\n" + out.campos_pendentes +
      "\n\nLimitações:\n" + out.limitacoes;

    return res.json({ texto });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao transcrever o documento." });
  }
});

});

// ======================================================================
// ROTA 4.5 – ANÁLISE DE PRESCRIÇÃO POR FOTO (ADMINISTRAÇÃO SEGURA) (NOVA)
// ======================================================================

app.post("/api/analisar-prescricao-imagem", requirePaidOrAdmin, async(req, res) => {
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
// ROTA 4.6 – APRAZAMENTO DE PRESCRIÇÃO POR FOTO (FOLHA REFEITA + EDITÁVEL)
// ======================================================================

async function aprazarPrescricaoPorImagem(imagensDataUrl) {
  const prompt = `
Você é um enfermeiro humano e deve RECONSTRUIR uma folha de prescrição médica a partir de uma ou mais fotos (páginas).

Objetivo:
1) Transcrever somente o que estiver legível, sem inventar. Quando não der para ler com segurança, escreva "não informado".
2) Extrair e organizar os campos visíveis do cabeçalho/identificação da folha (ex.: hospital/unidade, setor/clínica, leito, paciente, prontuário, data, médico/CRM, enfermagem/COREN e quaisquer outros campos que estejam claramente presentes).
3) Extrair a lista de medicamentos e informações relevantes conforme escrito (medicamento, dose, via, frequência/posologia, diluição/velocidade/observações quando existirem).
4) Para aprazamento:
   - Se houver horários explícitos na folha, liste-os no array "horarios_explicitados" no formato HH:MM.
   - Se houver apenas frequência/intervalo (ex.: 8/8h, 12/12h, q6h, 3x/dia), preencha "intervalo_horas" e/ou "vezes_ao_dia" quando der para inferir com segurança.
   - Se não der para inferir com segurança, use null.
5) Não interpretar, não sugerir conduta, não ajustar doses. Apenas transcrever e estruturar.

Regras obrigatórias:
- Sem emojis e sem símbolos gráficos.
- JSON estrito, sem markdown.

Responda EXCLUSIVAMENTE em JSON, neste formato:
{
  "cabecalho": {
    "hospital": "string",
    "unidade": "string",
    "setor": "string",
    "clinica": "string",
    "leito": "string",
    "paciente": "string",
    "prontuario": "string",
    "data": "string",
    "medico": "string",
    "crm": "string",
    "enfermeiro": "string",
    "coren": "string"
  },
  "medicamentos": [
    {
      "medicamento": "string",
      "dose": "string",
      "via": "string",
      "frequencia": "string",
      "observacoes": "string",
      "horarios_explicitados": ["HH:MM"],
      "intervalo_horas": 0,
      "vezes_ao_dia": 0,
      "tipo": "string"
    }
  ],
  "observacoes_folha": "string",
  "limitacoes": "string"
}
`;

  const imgs = Array.isArray(imagensDataUrl) ? imagensDataUrl.filter(Boolean).slice(0, 4) : [];
  const content = [{ type: "text", text: prompt }];
  for (const url of imgs) {
    content.push({ type: "image_url", image_url: { url } });
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content }]
  });

  const raw = (completion.choices?.[0]?.message?.content || "").trim();

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
      data = JSON.parse(jsonSlice);
    } else {
      throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
    }
  }

  const cab = (data && typeof data.cabecalho === "object" && data.cabecalho) ? data.cabecalho : {};
  const medicamentos = Array.isArray(data?.medicamentos) ? data.medicamentos : [];

  function asText(v, maxLen = 220) {
    const s = typeof v === "string" ? v.trim() : "";
    return normalizeText(s, maxLen) || "";
  }

  function asNumberOrNull(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseInt(v.replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  const outCab = {
    hospital: asText(cab?.hospital, 120) || "não informado",
    unidade: asText(cab?.unidade, 120) || "não informado",
    setor: asText(cab?.setor, 120) || "não informado",
    clinica: asText(cab?.clinica, 120) || "não informado",
    leito: asText(cab?.leito, 80) || "não informado",
    paciente: asText(cab?.paciente, 140) || "não informado",
    prontuario: asText(cab?.prontuario, 80) || "não informado",
    data: asText(cab?.data, 80) || "não informado",
    medico: asText(cab?.medico, 140) || "não informado",
    crm: asText(cab?.crm, 80) || "não informado",
    enfermeiro: asText(cab?.enfermeiro, 140) || "não informado",
    coren: asText(cab?.coren, 80) || "não informado"
  };

  const outMeds = [];
  for (const m of medicamentos.slice(0, 80)) {
    const horarios = Array.isArray(m?.horarios_explicitados) ? m.horarios_explicitados : (Array.isArray(m?.horarios) ? m.horarios : []);
    const cleanHorarios = [];
    for (const h of horarios.slice(0, 24)) {
      const t = asText(h, 12);
      if (t) cleanHorarios.push(t);
    }

    outMeds.push({
      medicamento: asText(m?.medicamento || m?.nome, 160) || "não informado",
      dose: asText(m?.dose, 80) || "não informado",
      via: asText(m?.via, 40) || "não informado",
      frequencia: asText(m?.frequencia || m?.posologia, 120) || "não informado",
      observacoes: asText(m?.observacoes || m?.observacao || m?.notas, 260) || "não informado",
      horarios_explicitados: cleanHorarios,
      intervalo_horas: asNumberOrNull(m?.intervalo_horas),
      vezes_ao_dia: asNumberOrNull(m?.vezes_ao_dia),
      tipo: asText(m?.tipo, 40) || "não informado"
    });
  }

  const observacoes_folha = asText(data?.observacoes_folha, 520) || "não informado";
  const limitacoes = asText(data?.limitacoes, 520) || "não informado";

  return {
    cabecalho: outCab,
    medicamentos: outMeds,
    observacoes_folha,
    limitacoes
  };
}

app.post("/api/aprazar-prescricao-imagem", requirePaidOrAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const arr = Array.isArray(body.images_data_url) ? body.images_data_url
      : (Array.isArray(body.imagens_data_url) ? body.imagens_data_url : null);

    const imagens = (arr && arr.length ? arr : [getImageDataUrlFromBody(body)])
      .filter((x) => typeof x === "string" && x.trim())
      .slice(0, 4)
      .map((x) => normalizeImageDataUrl(x, 4_000_000))
      .filter(Boolean);

    if (!imagens.length) {
      return res.status(400).json({
        error: "Imagem inválida ou muito grande. Envie uma foto em formato de imagem (data URL) e tente novamente."
      });
    }

    const folha = await aprazarPrescricaoPorImagem(imagens);
    return res.json({ folha });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao aprazar a prescrição." });
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
Você é um médico e educador clínico respondendo perguntas sobre saúde para profissionais da área.
Responda de forma completa e didática, em português do Brasil, com linguagem técnica quando necessário e explicações claras.

Objetivo:
- Ajudar no estudo e na tomada de decisão clínica, com raciocínio e condutas baseadas em boas práticas.
- Quando a pergunta for aberta ou faltar informação, diga quais dados faltam e proponha como coletá-los.

Regras:
- Não invente dados. Se algo for incerto, diga "não informado" ou explicite a limitação.
- Sem emojis e sem símbolos gráficos.
- Não faça diagnóstico definitivo sem dados suficientes; trabalhe com hipóteses e raciocínio.
- Sempre incluir, quando pertinente: sinais de alarme e quando encaminhar/avaliar com urgência.
- Se houver recomendação de tratamento, separar em medidas não medicamentosas e medicamentosas quando fizer sentido.
- Se mencionar medicamentos, seja prudente: cite opções e pontos de segurança (contraindicações, interações relevantes, ajuste renal/hepático quando aplicável) e ressalte que deve seguir protocolos locais e avaliação clínica.

Formato de saída: JSON estrito:
{ "resposta": "..." }

Pergunta:
"""${safeQ}"""
`;

  const data = await callOpenAIJson(prompt);
  return typeof data?.resposta === "string" ? data.resposta.trim() : "";
}

app.post("/api/duvidas-medicas", requirePaidOrAdmin, async(req, res) => {
  try {
    const { duvida } = req.body || {};
    const resposta = await responderDuvidaEnfermagem(duvida);
    return res.json({ resposta });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao responder a dúvida." });
  }
});

app.post("/api/duvidas-enfermagem", requirePaidOrAdmin, async(req, res) => {
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

app.post("/api/gerar-relatorio", requirePaidOrAdmin, async(req, res) => {
  try {
    const { transcricao, tipo_documento } = req.body || {};

    if (!transcricao || !String(transcricao).trim()) {
      return res.json({
        documento: "",
        tipo_documento: "",
        finalidade: "",
        campos_pendentes: []
      });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);
    const tipoSelecionado = (typeof tipo_documento === "string" && tipo_documento.trim())
      ? tipo_documento.trim()
      : null;

    const tiposPermitidos = [
      "Declaração de comparecimento",
      "Declaração de permanência",
      "Declaração para acompanhante",
      "Declaração de recebimento de orientações",
      "Declaração de recusa de procedimento/conduta",
      "Termo de consentimento informado (procedimento de enfermagem)",
      "Termo de ciência e responsabilidade (orientações e riscos)",
      "Comunicado para escola",
      "Relatório para escola (necessidades específicas)",
      "Comunicado ao Conselho Tutelar",
      "Relatório para Conselho Tutelar (proteção à criança/adolescente)",
      "Relatório de curativo seriado",
      "Registro de procedimento de curativo",
      "Registro de retirada de pontos/suturas",
      "Registro de procedimento de vacinação",
      "Registro de evento adverso pós-vacinação (EAPV)",
      "Registro de procedimento de administração de medicamentos",
      "Registro de administração de medicamento controlado (registro interno)",
      "Registro de coleta de exames",
      "Registro de nebulização/oxigenoterapia",
      "Registro de sondagem vesical",
      "Registro de troca de sonda/traqueostomia/gastrostomia",
      "Registro de visita domiciliar",
      "Relatório de visita domiciliar",
      "Relatório de adesão e educação em saúde (HAS/DM)",
      "Relatório de acompanhamento de hipertensão (HAS)",
      "Relatório de acompanhamento de diabetes (DM)",
      "Relatório de acompanhamento de asma/DPOC",
      "Relatório de acompanhamento de saúde da criança (puericultura)",
      "Relatório de acompanhamento de pré-natal (enfermagem)",
      "Relatório de puerpério (enfermagem)",
      "Relatório para assistência social (vulnerabilidade e insumos)",
      "Solicitação de insumos (fraldas, curativos, suplementos)",
      "Solicitação de fraldas (infantil/geriátrica)",
      "Solicitação de materiais para ostomia",
      "Solicitação de dieta enteral/suplementação",
      "Solicitação de oxigenoterapia domiciliar",
      "Solicitação de equipamentos de apoio (cadeira de rodas, colchão pneumático)",
      "Solicitação de transporte sanitário",
      "Solicitação de avaliação médica",
      "Encaminhamento para Médico (demanda espontânea)",
      "Encaminhamento para sala de vacina",
      "Encaminhamento para curativos/ambulatório de feridas",
      "Encaminhamento para CAPS / saúde mental",
      "Relatório para CAPS / saúde mental (enfermagem)",
      "Encaminhamento para Serviço Social",
      "Encaminhamento para Psicologia",
      "Encaminhamento para Nutrição",
      "Encaminhamento para Fisioterapia",
      "Encaminhamento para Fonoaudiologia",
      "Encaminhamento para Odontologia",
      "Encaminhamento para especialista / rede",
      "Encaminhamento para urgência/emergência",
      "Relatório de evolução de enfermagem",
      "Relatório de intercorrência/ocorrência",
      "Ata de reunião",
      "Registro de reunião de equipe (ATA breve)",
      "Comunicado interno da equipe",
      "Outros"
    ];

    const tiposTexto = tiposPermitidos.map(t => `- ${t}`).join("\n");

    const prompt = `
Você é um enfermeiro humano redigindo documentação administrativa e assistencial de enfermagem a partir da transcrição (português do Brasil).
O texto final será colado no S.U.I.S., portanto deve estar pronto para colar: texto simples, sem emojis e sem símbolos gráficos.

Tarefa:
1) Identificar qual é o TIPO DE DOCUMENTO solicitado e a FINALIDADE (destino/uso) com base na transcrição.
2) Produzir o DOCUMENTO completo, padronizado e formal, no tipo adequado, sem inventar dados.
3) Listar campos pendentes (o que faltou informar) para que o profissional possa completar.

Se o campo "tipo_documento" vier informado no request, você deve usar EXATAMENTE esse tipo como título e estrutura, mesmo que a transcrição sugira outro.
Se não vier informado, escolha o tipo mais adequado dentre os tipos permitidos. Se não for possível, use "Outros".

Tipos permitidos (escolha exatamente um, sem variações):
${tiposTexto}

Regras obrigatórias:
- Não invente dados. Se faltar informação, use "não informado" ou deixe um campo em branco com sublinhado (ex.: "CPF: __________").
- Não faça diagnóstico médico definitivo. Descreva achados objetivos, queixa referida e condutas/orientações de enfermagem.
- Use linguagem clara, objetiva e formal.
- Evite abreviações sem definição.
- Não use listas com bullets. Se precisar numerar, use "1.", "2.", cada item em uma nova linha.

Estrutura (usar conforme o tipo):
- Primeira linha: TÍTULO EM CAIXA ALTA (igual ao tipo escolhido).
- Bloco de identificação (campos em linhas separadas):
  Unidade/Serviço: __________
  Município/UF: __________
  Paciente: __________
  CPF: __________
  Cartão SUS (CNS): __________
  Data de nascimento/Idade: __________
  Endereço: __________
  Telefone: __________
- Campo "Finalidade/Destino:" (se não estiver explícito, "não informado").
- Corpo do documento em parágrafos curtos, conforme o tipo:
  - Declarações: motivo do atendimento e data/horário (se ausentes, deixar "____/____/____" e "____:____"), e observações pertinentes.
  - Relatório de curativo seriado: diagnóstico de enfermagem/descrição da ferida (sem diagnóstico médico), local, aspecto, medidas (apenas se citadas), materiais utilizados, conduta e plano; incluir um quadro em texto para evolução seriada se a transcrição não trouxer todas as datas/medidas.
  - Relatórios de adesão/educação: medidas aferidas (se citadas), adesão, barreiras, orientações fornecidas, metas pactuadas e retorno.
  - Relatórios para escola/assistência social: limitações funcionais e necessidades, evidências mencionadas, recomendações e insumos necessários (somente os citados).
  - Saúde mental (CAPS): acolhimento, adesão, acompanhamento, sinais de alerta e encaminhamentos/fluxo acordado.
  - Encaminhamentos: serviço de destino, motivo do encaminhamento, resumo objetivo do caso, classificação de risco/sinais de alerta e orientações.
  - Solicitações: item solicitado, justificativa técnica e quantidade/periodicidade (se citadas).
  - Ata de reunião: data, pauta, participantes (se citados), deliberações, responsabilidades e prazos (se citados).
  - Registro de procedimento: data/hora (se ausentes, campo em branco), indicação, técnica resumida, materiais, tolerância, intercorrências, orientações e registro de comunicação ao paciente.
- Rodapé:
  Data: ____/____/____
  Profissional de Enfermagem: __________________________
  COREN: __________________________
  Assinatura/Carimbo: __________________________

Saída: JSON estrito, sem texto fora do JSON:
{
  "tipo_documento": "...",
  "finalidade": "...",
  "campos_pendentes": ["..."],
  "documento": "..."
}

Campo "tipo_documento" informado no request (pode ser nulo):
${tipoSelecionado ? JSON.stringify(tipoSelecionado) : "null"}

Transcrição:
"""${safeTranscricao}"""
`;

    const data = await callOpenAIJson(prompt);

    const tipo = (typeof data?.tipo_documento === "string" ? data.tipo_documento.trim() : "") || (tipoSelecionado || "");
    const finalidade = typeof data?.finalidade === "string" ? data.finalidade.trim() : "";
    const camposPendentes = normalizeArrayOfStrings(data?.campos_pendentes, 40, 140);
    const documento = typeof data?.documento === "string" ? data.documento.trim() : "";

    return res.json({
      tipo_documento: tipo,
      finalidade,
      campos_pendentes: camposPendentes,
      documento
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar documento." });
  }
});






// ======================================================================
// SAÚDE DO BACKEND (TESTE RÁPIDO)
// ======================================================================
// ======================================================================
// MÓDULO: Escala de plantão (persistência)
// - Geração pode ser feita no frontend; o backend apenas guarda configuração e escalas geradas.
// ======================================================================

function rosterUserKey(req) {
  try {
    if (!req || !req.auth) return "";
    if (req.auth.role === "admin") return "admin";
    return String(req.auth.user?.id || "");
  } catch {
    return "";
  }
}

function rosterLimitJsonSize(obj, maxChars) {
  try {
    const s = JSON.stringify(obj);
    return s.length <= maxChars;
  } catch {
    return false;
  }
}

app.get("/api/escala/config", requireAuth, (req, res) => {
  try {
    const key = rosterUserKey(req);
    if (!key) return res.status(400).json({ error: "Usuário inválido." });

    const cfg = (DB.rosterConfigs && DB.rosterConfigs[key]) ? DB.rosterConfigs[key] : null;
    return res.json({ config: cfg ? (cfg.config || null) : null, updatedAt: cfg ? (cfg.updatedAt || "") : "" });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao carregar configuração." });
  }
});

app.post("/api/escala/config", requireAuth, (req, res) => {
  try {
    const key = rosterUserKey(req);
    if (!key) return res.status(400).json({ error: "Usuário inválido." });

    const config = req.body?.config;
    if (!config || typeof config !== "object") return res.status(400).json({ error: "Config inválida." });

    // Proteção simples contra payload gigante
    if (!rosterLimitJsonSize(config, 250_000)) return res.status(413).json({ error: "Config muito grande." });

    DB.rosterConfigs[key] = { updatedAt: nowIso(), config };
    saveDb(DB, "roster_config");
    audit("roster_config_save", key, "Config de escala salva");
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao salvar configuração." });
  }
});

app.get("/api/escala/schedules", requireAuth, (req, res) => {
  try {
    const key = rosterUserKey(req);
    if (!key) return res.status(400).json({ error: "Usuário inválido." });

    const list = (Array.isArray(DB.rosterSchedules) ? DB.rosterSchedules : [])
      .filter(x => x && x.userKey === key)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 60)
      .map(x => ({ id: x.id, title: x.title, month: x.month, shiftModel: x.shiftModel, createdAt: x.createdAt }));

    return res.json({ items: list });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao listar escalas." });
  }
});

app.post("/api/escala/schedules", requireAuth, (req, res) => {
  try {
    const key = rosterUserKey(req);
    if (!key) return res.status(400).json({ error: "Usuário inválido." });

    const title = normalizeText(req.body?.title, 120) || "Escala";
    const month = normalizeText(req.body?.month, 7);
    const shiftModel = normalizeText(req.body?.shiftModel, 20);
    const data = req.body?.data;
    const summary = req.body?.summary;
    const warnings = req.body?.warnings;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: "Mês inválido." });
    if (!data || typeof data !== "object") return res.status(400).json({ error: "Dados inválidos." });

    const payload = { title, month, shiftModel, data, summary, warnings };

    if (!rosterLimitJsonSize(payload, 600_000)) return res.status(413).json({ error: "Escala muito grande." });

    const item = {
      id: makeId("ros"),
      userKey: key,
      title,
      month,
      shiftModel,
      data,
      summary,
      warnings,
      createdAt: nowIso()
    };

    DB.rosterSchedules = Array.isArray(DB.rosterSchedules) ? DB.rosterSchedules : [];
    DB.rosterSchedules.push(item);

    // Limite por usuário: mantém as 200 mais recentes
    const byUser = DB.rosterSchedules.filter(x => x && x.userKey === key)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const keepIds = new Set(byUser.slice(0, 200).map(x => x.id));
    DB.rosterSchedules = DB.rosterSchedules.filter(x => !x || x.userKey !== key || keepIds.has(x.id));

    saveDb(DB, "roster_schedule_save");
    audit("roster_schedule_save", key, `Escala salva: ${month}`);
    return res.json({ ok: true, id: item.id });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao salvar escala." });
  }
});

app.get("/api/escala/schedules/:id", requireAuth, (req, res) => {
  try {
    const key = rosterUserKey(req);
    if (!key) return res.status(400).json({ error: "Usuário inválido." });

    const id = normalizeText(req.params?.id, 50);
    const item = (Array.isArray(DB.rosterSchedules) ? DB.rosterSchedules : []).find(x => x && x.id === id) || null;
    if (!item) return res.status(404).json({ error: "Escala não encontrada." });

    if (item.userKey !== key && req.auth.role !== "admin") return res.status(403).json({ error: "Acesso negado." });

    return res.json({ item });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao carregar escala." });
  }
});

app.delete("/api/escala/schedules/:id", requireAuth, (req, res) => {
  try {
    const key = rosterUserKey(req);
    if (!key) return res.status(400).json({ error: "Usuário inválido." });

    const id = normalizeText(req.params?.id, 50);
    const before = Array.isArray(DB.rosterSchedules) ? DB.rosterSchedules.length : 0;

    DB.rosterSchedules = (Array.isArray(DB.rosterSchedules) ? DB.rosterSchedules : []).filter(x => {
      if (!x) return false;
      if (x.id !== id) return true;
      if (req.auth.role === "admin") return false;
      return x.userKey !== key; // remove apenas se for do usuário
    });

    const after = DB.rosterSchedules.length;

    if (before === after) return res.status(404).json({ error: "Escala não encontrada." });

    saveDb(DB, "roster_schedule_delete");
    audit("roster_schedule_delete", key, `Escala removida: ${id}`);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao remover escala." });
  }
});

app.get("/api/health", async (req, res) => {
  let storage = "file";
  let pg_ok = false;
  let pg_error = null;

  if (USE_PG_STORE) {
    storage = "postgres";
    try {
      await pgEnsureTable();
      pg_ok = true;
    } catch (e) {
      pg_ok = false;
      pg_error = e?.message || String(e);
    }
  }

  return res.json({
    ok: true,
    time: new Date().toISOString(),
    has_openai_key: Boolean(process.env.OPENAI_API_KEY),
    storage: {
      backend: storage,
      data_dir: DATA_DIR,
      db_path: DB_PATH,
      backups_dir: BACKUP_DIR,
      pg_ok,
      pg_state_id: USE_PG_STORE ? PG_STATE_ID : null,
      pg_error
    },
    counts: {
      users: Array.isArray(DB?.users) ? DB.users.length : 0,
      payments: Array.isArray(DB?.payments) ? DB.payments.length : 0,
      audit: Array.isArray(DB?.audit) ? DB.audit.length : 0
    }
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

function heuristicQuestions(transcricao, isTriage) {
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

if (isTriage) {
  push("Aferir sinais vitais completos (PA, FC, FR, Temp, SpO2) e reavaliar após intervenções; glicemia capilar quando indicado.");
  push("Realizar avaliação ABCDE e nível de consciência (AVPU/Glasgow); quantificar dor (escala 0–10) e caracterizar dor/sangramento.");
  push("Checar red flags do quadro: dispneia importante, dor torácica, déficit neurológico, rebaixamento de consciência, convulsão, choque, anafilaxia, sinais de sepse, sangramento ativo.");
  push("Confirmar alergias, comorbidades relevantes, medicações em uso (incluindo anticoagulantes), gestação/puerpério quando aplicável.");
  push("Definir necessidade de medidas imediatas conforme protocolo local (oxigênio, acesso venoso, monitorização, posição, jejum, isolamento) e encaminhamento prioritário.");
  return { contexto, hipotese, sugestoes: q };
}

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

app.post("/api/guia-tempo-real", requirePaidOrAdmin, async(req, res) => {
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

    const modo = String(body.modo || "").trim().toLowerCase();
    const isTriage = (modo === "triagem_hospitalar" || modo === "triagem" || modo === "hospital_triage" || modo === "triagem_hospital");

    let contexto = "";
    let hipotese = "";
    let confianca = 0;
    let sugestoes = [];

    if (process.env.OPENAI_API_KEY) {
            const promptConsulta = `
Você está auxiliando um enfermeiro durante uma consulta.
Objetivo: sugerir no máximo 3 perguntas essenciais por vez para chegar a um diagnóstico provável com eficiência.
Regras:
- Não dê diagnóstico final, apenas hipótese principal.
- Não escreva emojis.
- As perguntas devem ser curtas e objetivas.
- Use contexto do que já foi dito; não repita perguntas já respondidas.
- Se for evento "resposta", atualize as perguntas com base na última fala do paciente.

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
- Perguntas pendentes (se houver): ${(pendentes && pendentes.length) ? pendentes.join(" | ") : "nenhuma"}
- Última fala (se houver): ${ultimaFala || "nenhuma"}

Transcrição (trecho):
"""${transcricao}"""
`;

      const promptTriage = `
Você está auxiliando um enfermeiro na triagem hospitalar (porta de urgência/emergência).
Objetivo: sugerir no máximo 3 itens essenciais por vez (perguntas e/ou procedimentos) para classificar risco, detectar red flags e iniciar condutas imediatas com segurança.
Regras:
- Não invente dados. Se faltar informação, sugira como obter.
- Não escreva emojis.
- Itens devem ser curtos, objetivos e executáveis na triagem.
- Priorize: sinais vitais, nível de consciência, via aérea/respiração/circulação (ABCDE), dor, sangramento, alergias, comorbidades, medicações em uso, início/evolução, sintomas de gravidade específicos do quadro.
- Se for evento "resposta", atualize os próximos itens com base na última fala.

Retorne JSON estrito no formato:
{
  "contexto": "texto curto",
  "hipotese_principal": "cenário/síndrome principal (não diagnóstico definitivo)",
  "confianca": 0,
  "perguntas_sugeridas": ["item 1", "item 2", "item 3"]
}

Dados atuais:
- Estado: ${estado}
- Evento: ${evento}
- Cenário atual: ${hipoteseAtual || "não informado"}
- Confiança atual: ${confiancaAtual}
- Item executado (se houver): ${perguntaFeita || "nenhum"}
- Itens pendentes (se houver): ${(pendentes && pendentes.length) ? pendentes.join(" | ") : "nenhum"}
- Última fala (se houver): ${ultimaFala || "nenhuma"}

Transcrição (trecho):
"""${transcricao}"""
`;

      const prompt = isTriage ? promptTriage : promptConsulta;
      const data = await callOpenAIJson(prompt);
      contexto = typeof data?.contexto === "string" ? data.contexto.trim() : "";
      hipotese = typeof data?.hipotese_principal === "string" ? data.hipotese_principal.trim() : "";
      confianca = clampNumber(data?.confianca, 0, 95);
      sugestoes = Array.isArray(data?.perguntas_sugeridas) ? data.perguntas_sugeridas : [];
    } else {
      const h = heuristicQuestions(transcricao, isTriage);
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

(async () => {
  // Se DATABASE_URL estiver configurado, carrega o estado do Postgres antes de aceitar tráfego.
  const info = await hydrateDbFromPgIfAvailable();
  console.log("[storage]", info);

  app.listen(port, () => {
    console.log(`Servidor escutando na porta ${port}`);
  });
})();
// Status de assinatura (público para tela de login/cadastro)
app.get("/api/public/subscription/status", (req, res) => {
  try {
    const cpfRaw = String(req.query?.cpf || req.query?.login || "").trim();
    const cpf = normalizeCpf(cpfRaw);
    if (!cpf || !isValidCpf(cpf)) return res.status(400).json({ error: "CPF inválido." });
    const user = findUserByLogin(cpf);
    if (!user || user.isDeleted) return res.status(404).json({ error: "Usuário não encontrado." });
    if (ensureTrialFields(user)) saveDb(DB, "ensure_trial_public_status");

    const nowMs = Date.now();
    const rem = trialRemainingSeconds(user, nowMs);
    return res.json({
      now: nowIso(),
      trialEndsAt: user.trialEndsAt || null,
      trialRemainingSeconds: rem,
      warning5Days: warning5Days(user, nowMs),
      isPaidThisMonth: isUserPaidThisMonth(user.id)
    });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao consultar status." });
  }
});

app.get("/api/subscription/status", requireAuth, (req, res) => {
  const user = req.auth?.user;
  if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

  if (req.auth.role === "admin") {
    return res.json({
      now: nowIso(),
      trialEndsAt: null,
      trialRemainingSeconds: 0,
      isPaidThisMonth: true,
      needsPayment: false,
      warning5Days: false,
      activeFriendsThisMonth: 0,
      discountRateThisMonth: 0,
      amountDueThisMonth: 0,
      friendCode: null,
      partnerCode: null
    });
  }

  const nowMs = Date.now();
  const rem = trialRemainingSeconds(user, nowMs);
  const paid = isUserPaidThisMonth(user.id);
  const trialActive = isTrialActive(user, nowMs);
  const { activeFriendsThisMonth, discountRate } = computeFriendDiscountThisMonth(user.id);
  const due = computeAmountDueThisMonth(user.id);
  const amountDueAnnualPix = round2(PRICE_ANNUAL_PIX * (1 - discountRate));
  const amountDueAnnualCard = round2(PRICE_ANNUAL_CARD * (1 - discountRate));

  // tenta cobrar automaticamente se tiver assinatura no cartão ativa
  try { maybeAutoChargeCardSubscription(user); } catch {}
  const paidAfter = isUserPaidThisMonth(user.id);

  return res.json({
    now: nowIso(),
    month: currentYYYYMM(),
    trialEndsAt: user.trialEndsAt || null,
    trialRemainingSeconds: rem,
    isPaidThisMonth: paidAfter,
    needsPayment: (!trialActive && !paidAfter),
    warning5Days: warning5Days(user, nowMs),
    activeFriendsThisMonth,
    discountRateThisMonth: discountRate,
    amountDueThisMonth: due,
    amountDueAnnualPix,
    amountDueAnnualCard,
    friendCode: user.friendCode || null,
    partnerCode: user.partnerCode || null
  });
});

app.post("/api/referral/apply", requireAuth, (req, res) => {
  try {
    if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
    const user = req.auth.user;
    if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

    if (user.referrerId || user.refType) {
      return res.status(409).json({ error: "Este usuário já possui indicação registrada e não pode ser alterada." });
    }

    const refType = String(req.body?.refType || "").trim().toLowerCase();
    const code = String(req.body?.referralCode || "").trim();
    if (!refType || !code) return res.status(400).json({ error: "Tipo e código de indicação são obrigatórios." });
    if (refType !== "friend" && refType !== "partner") return res.status(400).json({ error: "Tipo de indicação inválido." });

    let referrer = null;
    if (refType === "friend") referrer = findUserByFriendCode(code);
    if (refType === "partner") referrer = findUserByPartnerCode(code);
    if (!referrer) return res.status(400).json({ error: "Código de indicação inválido." });

    if (referrer.id === user.id || String(referrer.cpf || "") === String(user.cpf || "")) {
      return res.status(400).json({ error: "Autoindicação não é permitida." });
    }

    user.referrerId = referrer.id;
    user.refType = refType;
    user.referralCodeUsed = code;
    saveDb(DB, "referral_apply");

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao aplicar indicação." });
  }
});


// Cliente Amigo: cadastrar amigo diretamente vinculado ao usuário logado
app.post("/api/friends/create", requireAuth, (req, res) => {
  try {
    if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
    const referrer = req.auth.user;
    if (!referrer || referrer.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

    const fullName = String(req.body?.fullName || "").trim();
    const dob = String(req.body?.dob || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const cpfRaw = String(req.body?.cpf || req.body?.login || "").trim();
    const cpf = normalizeCpf(cpfRaw);
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !cpf || !password) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone, CPF e senha são obrigatórios." });
    }
    if (!isValidCpf(cpf)) return res.status(400).json({ error: "CPF inválido." });
    if (password.length < 4) return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
    if (findUserByLogin(cpf)) return res.status(409).json({ error: "Já existe usuário com este CPF." });

    // Proíbe autoindicação por CPF
    if (String(referrer.cpf || referrer.login || "") === String(cpf)) {
      return res.status(400).json({ error: "Autoindicação não é permitida." });
    }

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login: cpf,
      cpf,
      trialStartedAt: nowIso(),
      trialEndsAt: addDaysIso(nowIso(), TRIAL_DAYS),
      friendCode: ensureUniqueFriendCode(),
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      lastLoginAt: "",
      lastSeenAt: "",
      activeSessionHash: "",
      activeDeviceId: "",
      activeSessionCreatedAt: "",
      activeSessionLastSeenAt: "",
      activeSessionExpiresAt: "",
      referrerId: referrer.id,
      refType: "friend",
      referralCodeUsed: referrer.friendCode || ""
    };

    DB.users.push(user);
    saveDb(DB, "friend_create");
    audit("friend_create", user.id, `Amigo criado por ${referrer.login}`);

    return res.json({ ok: true, friend: { id: user.id, fullName: user.fullName, cpf: user.cpf, login: user.login } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao cadastrar amigo." });
  }
});

app.get("/api/friends/list", requireAuth, (req, res) => {
  try {
    if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
    const u = req.auth.user;
    if (!u || u.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

    const month = currentYYYYMM();
    const friends = DB.users
      .filter(x => !x.isDeleted && x.referrerId === u.id && String(x.refType || "") === "friend")
      .map(x => ({
        id: x.id,
        fullName: x.fullName,
        cpf: x.cpf || x.login,
        login: x.login,
        isActive: !!x.isActive,
        isPaidThisMonth: isUserPaidMonth(x.id, month)
      }))
      .sort((a,b) => (a.fullName||"").localeCompare(b.fullName||""));

    const { activeFriendsThisMonth, discountRate } = computeFriendDiscountThisMonth(u.id);
    const amountDueThisMonth = computeAmountDueThisMonth(u.id);
    const amountDueAnnualPix = round2(PRICE_ANNUAL_PIX * (1 - discountRate));
    const amountDueAnnualCard = round2(PRICE_ANNUAL_CARD * (1 - discountRate));
    return res.json({ ok: true, month, friends, activeFriendsThisMonth, discountRateThisMonth: discountRate, amountDueThisMonth, amountDueAnnualPix, amountDueAnnualCard });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao listar amigos." });
  }
});

// Pix (manual/avulso): cria um pedido para o mês atual
app.post("/api/payments/pix/create", requireAuth, (req, res) => {
  try {
    if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
    const user = req.auth.user;
    if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

    const plan = String(req.body?.plan || req.body?.kind || "monthly").trim().toLowerCase();
    if (plan !== "monthly" && plan !== "annual") return res.status(400).json({ error: "Plano inválido." });

    const month = currentYYYYMM();

    // Para anual, evita duplicidade se qualquer mês do ciclo já constar como pago
    if (plan === "annual") {
      const start = new Date();
      const months = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(start.getTime());
        d.setMonth(d.getMonth() + i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        months.push(`${y}-${m}`);
      }
      const anyPaid = months.some(mm => isUserPaidMonth(user.id, mm));
      if (anyPaid) return res.status(409).json({ error: "Já existe pagamento registrado em um ou mais meses do ciclo anual." });
    } else {
      if (isUserPaidMonth(user.id, month)) return res.status(409).json({ error: "Este mês já consta como pago." });
    }

    const { discountRate } = computeFriendDiscountThisMonth(user.id);
    const amount = (plan === "annual") ? round2(PRICE_ANNUAL_PIX * (1 - discountRate)) : computeAmountDueThisMonth(user.id);

    const order = {
      id: makeId("pix"),
      userId: user.id,
      month,
      plan,
      amount,
      status: "pending",
      createdAt: nowIso()
    };
    DB.pixOrders.push(order);
    saveDb(DB, "pix_create");

    const pixKey = String(process.env.PIX_KEY || "CHAVE_PIX_AQUI").trim();
    const instructions = (plan === "annual")
      ? "Realize o Pix para a chave informada e aguarde a confirmação. Este pagamento anual libera 12 meses a partir do mês atual."
      : "Realize o Pix para a chave informada e aguarde a confirmação. Este pagamento libera o mês atual.";

    return res.json({
      ok: true,
      orderId: order.id,
      month,
      plan,
      amount,
      pixKey,
      instructions
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao criar pedido Pix." });
  }
});

app.post("/api/payments/pix/confirm", requireAuth, requireAdmin, (req, res) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    if (!orderId) return res.status(400).json({ error: "orderId é obrigatório." });

    const order = DB.pixOrders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
    if (order.status === "confirmed") return res.json({ ok: true });

    const user = DB.users.find(u => u.id === order.userId && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário do pedido não encontrado." });

    order.status = "confirmed";
    order.confirmedAt = nowIso();
    order.confirmedBy = req.auth?.user?.login || ADMIN_LOGIN;

    const plan = String(order.plan || "monthly").toLowerCase();

    if (plan === "annual") {
      const startDate = new Date();
      const months = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(startDate.getTime());
        d.setMonth(d.getMonth() + i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        months.push(`${y}-${m}`);
      }
      const perMonth = round2((Number(order.amount) || PRICE_ANNUAL_PIX) / 12);
      for (const month of months) {
        if (!isUserPaidMonth(user.id, month)) {
          addPaymentConfirmed(user.id, month, perMonth, "pix", `Assinatura anual (Pix) - Pedido ${order.id}`, req.auth?.user?.login || ADMIN_LOGIN);
        }
      }
    } else {
      if (!isUserPaidMonth(user.id, order.month)) {
        addPaymentConfirmed(user.id, order.month, order.amount, "pix", `Pedido Pix ${order.id}`, req.auth?.user?.login || ADMIN_LOGIN);
      }
    }

    saveDb(DB, "pix_confirm");
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao confirmar Pix." });
  }
});

// Cartão (recorrente) - integração stub (estrutura)
app.post("/api/payments/card/subscribe", requireAuth, (req, res) => {
  try {
    if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
    const user = req.auth.user;
    if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

    const plan = String(req.body?.plan || req.body?.kind || "monthly").trim().toLowerCase();
    if (plan !== "monthly" && plan !== "annual") return res.status(400).json({ error: "Plano inválido." });

    const next = new Date();
    if (plan === "monthly") next.setMonth(next.getMonth() + 1);
    if (plan === "annual") next.setFullYear(next.getFullYear() + 1);

    user.cardSubscription = {
      status: "active",
      plan,
      nextChargeAt: next.toISOString(),
      providerCustomerId: String(req.body?.providerCustomerId || ""),
      providerSubscriptionId: String(req.body?.providerSubscriptionId || ""),
      last4: String(req.body?.last4 || ""),
      brand: String(req.body?.brand || "")
    };

    // cobrança inicial
    if (plan === "monthly") {
      const month = currentYYYYMM();
      if (!isUserPaidMonth(user.id, month)) {
        const due = computeAmountDueThisMonth(user.id);
  const amountDueAnnualPix = round2(PRICE_ANNUAL_PIX * (1 - discountRate));
  const amountDueAnnualCard = round2(PRICE_ANNUAL_CARD * (1 - discountRate));
        addPaymentConfirmed(user.id, month, due, "card", due === 0 ? "Desconto 100% (Cliente Amigo)" : "Assinatura (cartão)", "card_subscribe");
      }
    } else {
      // anual: gera 12 meses
      const start = new Date();
      const months = [];
      for (let i = 0; i < 12; i++) {
        const d = new Date(start.getTime());
        d.setMonth(d.getMonth() + i);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        months.push(`${y}-${m}`);
      }
      const { discountRate } = computeFriendDiscountThisMonth(user.id);
      const annualTotal = round2(PRICE_ANNUAL_CARD * (1 - discountRate));
      const perMonth = round2(annualTotal / 12);
      for (const month of months) {
        if (!isUserPaidMonth(user.id, month)) addPaymentConfirmed(user.id, month, perMonth, "card", "Assinatura anual (cartão)", "card_subscribe");
      }
    }

    saveDb(DB, "card_subscribe");
    return res.json({ ok: true, status: user.cardSubscription.status, plan: user.cardSubscription.plan, nextChargeAt: user.cardSubscription.nextChargeAt });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao assinar no cartão." });
  }
});

app.post("/api/payments/card/cancel", requireAuth, (req, res) => {
  try {
    if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
    const user = req.auth.user;
    if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });

    if (!user.cardSubscription) return res.json({ ok: true });
    user.cardSubscription.status = "canceled";
    user.cardSubscription.canceledAt = nowIso();
    saveDb(DB, "card_cancel");
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao cancelar assinatura." });
  }
});

app.get("/api/partner/commissions", requireAuth, (req, res) => {
  if (req.auth.role === "admin") return res.status(400).json({ error: "Operação não aplicável para administrador." });
  const user = req.auth.user;
  if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });
  if (!user.partnerCode) return res.status(403).json({ error: "Usuário não é parceiro." });

  const items = DB.commissions
    .filter(c => c.partnerUserId === user.id)
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
  return res.json({ items });
});

app.post("/api/admin/users/:id/partner", requireAuth, requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || "");
    const user = DB.users.find(u => u.id === id && !u.isDeleted);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
    if (!user.partnerCode) user.partnerCode = ensureUniquePartnerCode();
    saveDb(DB, "admin_make_partner");
    return res.json({ ok: true, partnerCode: user.partnerCode });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao marcar parceiro." });
  }
});

app.post("/api/admin/payments/:paymentId/void", requireAuth, requireAdmin, (req, res) => {
  try {
    const paymentId = String(req.params.paymentId || "");
    const p = voidPaymentById(paymentId, req.auth?.user?.login || ADMIN_LOGIN);
    if (!p) return res.status(404).json({ error: "Pagamento não encontrado." });
    return res.json({ ok: true, payment: p });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao estornar pagamento." });
  }
});



