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
  return (db.users?.length || 0) * 1000000 + (db.payments?.length || 0) * 1000 + (db.audit?.length || 0);
}

function mergeDbs(a, b) {
  const out = { users: [], payments: [], audit: [] };

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

function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function onlyDigits(v) {
  return String(v || "").replace(/\D+/g, "");
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
  const fresh = { users: [], payments: [], audit: [] };
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
    notes: p.notes || ""
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

function createSession(role, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  SESSIONS.set(token, { role, userId, createdAt: now, lastSeenAt: now });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.createdAt > SESSION_TTL_MS) {
    SESSIONS.delete(token);
    return null;
  }
  return s;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, s] of SESSIONS.entries()) {
    if (now - s.createdAt > SESSION_TTL_MS) SESSIONS.delete(token);
  }
}
setInterval(cleanupSessions, 1000 * 60 * 10).unref?.();

function findUserByLogin(login) {
  const raw = String(login || "").trim();
  const l = raw.toLowerCase();
  const direct = DB.users.find(u => String(u.login || "").trim().toLowerCase() === l) || null;
  if (direct) return direct;
  const ln = onlyDigits(raw);
  if (!ln) return null;
  return DB.users.find(u => onlyDigits(String(u.login || "").trim()) === ln) || null;
}

function isUserPaidThisMonth(userId) {
  const month = currentYYYYMM();
  return DB.payments.some(p => p.userId === userId && p.month === month);
}

function isUserOnline(user) {
  const last = user?.lastSeenAt ? new Date(user.lastSeenAt).getTime() : 0;
  if (!last) return false;
  return (Date.now() - last) <= 1000 * 60 * 2; // 2 minutos
}

function authFromReq(req) {
  // Aceita token via Authorization: Bearer <token> e também via X-Auth-Token (fallback para proxies).
  const hAuth = req.headers["authorization"] || "";
  const hX = req.headers["x-auth-token"] || req.headers["x-authorization"] || "";

  function extractToken(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    const m = s.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : s;
  }

  const token = extractToken(hAuth) || extractToken(hX) || extractToken(req.query && req.query.token);
  const sess = getSession(token);
  if (!sess) return null;

  if (sess.role === "admin") {
    return { role: "admin", token, user: { id: "admin", login: ADMIN_LOGIN } };
  }

  const user = DB.users.find(u => u.id === sess.userId) || null;
  if (!user || user.isDeleted) return null;
  return { role: "nurse", token, user };
}

function requireAuth(req, res, next) {
  const ctx = authFromReq(req);
  if (!ctx) return res.status(401).json({ error: "Não autenticado." });
  req.auth = ctx;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao administrador." });
  next();
}

function requirePaidOrAdmin(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: "Não autenticado." });
  if (req.auth.role === "admin") return next();

  const user = req.auth.user;
  if (!user || user.isDeleted) return res.status(403).json({ error: "Usuário inválido." });
  if (!user.isActive) return res.status(403).json({ error: "Acesso bloqueado: mensalidade em débito. Procure o administrador." });

  if (!isUserPaidThisMonth(user.id)) {
    return res.status(402).json({ error: "Acesso bloqueado: mensalidade em débito. Procure o administrador." });
  }
  next();
}

// Rotas de autenticação

// Cadastro público (auto-cadastro do enfermeiro)
// Observação: o acesso ao sistema continua condicionado à liberação e mensalidade (pagamento do mês).
app.post("/api/auth/signup", (req, res) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const dob = String(req.body?.dob || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const login = String(req.body?.login || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !login || !password) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone, CPF (login) e senha são obrigatórios." });
    }

    const cpfDigits = onlyDigits(login);
    if (!cpfDigits || cpfDigits.length !== 11) {
      return res.status(400).json({ error: "CPF inválido. Informe 11 dígitos (pode ser com pontuação)." });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
    }

    if (findUserByLogin(login)) {
      return res.status(409).json({ error: "Já existe usuário com este CPF/login." });
    }

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login,
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      lastLoginAt: "",
      lastSeenAt: ""
    };

    DB.users.push(user);
    saveDb(DB, "signup");
    audit("user_signup", user.id, `Auto-cadastro do usuário ${user.login}`);
    return res.json({ ok: true, id: user.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao cadastrar usuário." });
  }
});

app.post("/api/auth/login", (req, res) => {
  try {
    const login = String(req.body?.login || "").trim();
    const senha = String(req.body?.senha || "").trim();
    if (!login || !senha) return res.status(400).json({ error: "Login e senha são obrigatórios." });

    // Admin (aceita com ou sem pontuação)
    const loginN = onlyDigits(login);
    const senhaN = onlyDigits(senha);
    if ((login === ADMIN_LOGIN && senha === ADMIN_PASSWORD) || (loginN && senhaN && loginN === ADMIN_LOGIN_N && (senhaN === ADMIN_PASSWORD_N || senhaN === ADMIN_PASSWORD_ALT_N))) {
      const token = createSession("admin", "admin");
      audit("admin_login", "admin", "Login do administrador");
      return res.json({ token, role: "admin", login: ADMIN_LOGIN, currentMonth: currentYYYYMM() });
    }

    // Usuário enfermeiro
    const user = findUserByLogin(login);
    if (!user || user.isDeleted) return res.status(401).json({ error: "Credenciais inválidas." });
    if (!user.isActive) return res.status(403).json({ error: "Acesso bloqueado: mensalidade em débito. Procure o administrador." });

    const computed = sha256(`${user.salt || ""}:${senha}`);
    if (computed !== user.passwordHash) return res.status(401).json({ error: "Credenciais inválidas." });


    // Bloqueio por mensalidade em débito
    if (!isUserPaidThisMonth(user.id)) return res.status(403).json({ error: "Acesso bloqueado: mensalidade em débito. Procure o administrador." });

    user.lastLoginAt = nowIso();
    user.lastSeenAt = nowIso();
    saveDb(DB);

    const token = createSession("nurse", user.id);
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
  try {
    SESSIONS.delete(req.auth.token);
  } catch {}
  return res.json({ ok: true });
});

app.post("/api/auth/heartbeat", requireAuth, (req, res) => {
  try {
    const sess = getSession(req.auth.token);
    if (sess) sess.lastSeenAt = Date.now();
    if (req.auth.role === "nurse") {
      const u = req.auth.user;
      u.lastSeenAt = nowIso();
      saveDb(DB);
    }
  } catch {}
  return res.json({ ok: true });
});

// Rotas administrativas
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = DB.users
    .filter(u => !u.isDeleted)
    .map(u => ({
      id: u.id,
      fullName: u.fullName,
      dob: u.dob,
      phone: u.phone,
      login: u.login,
      isActive: !!u.isActive,
      active: !!u.isActive,
      lastLoginAt: u.lastLoginAt || "",
      lastSeenAt: u.lastSeenAt || "",
      isOnline: isUserOnline(u),
      isPaidThisMonth: isUserPaidThisMonth(u.id), paidCurrentMonth: isUserPaidThisMonth(u.id)
    }))
    .sort((a,b) => (a.fullName||"").localeCompare(b.fullName||""));
  return res.json({ users });
});

app.post("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const dob = String(req.body?.dob || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const login = String(req.body?.login || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !login || !password) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone, login e senha são obrigatórios." });
    }
    if (findUserByLogin(login)) return res.status(409).json({ error: "Já existe usuário com este login." });

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login,
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      lastLoginAt: "",
      lastSeenAt: ""
    };

    DB.users.push(user);
    saveDb(DB);
    audit("user_create", user.id, `Criado usuário ${login}`);
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
    const login = String(req.body?.login ?? user.login ?? "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !dob || !phone || !login) {
      return res.status(400).json({ error: "Nome completo, data de nascimento, telefone e login são obrigatórios." });
    }

    // Se mudar o login, garantir unicidade
    const existing = DB.users.find(u => !u.isDeleted && u.id !== id && String(u.login || "").toLowerCase() === String(login).toLowerCase());
    if (existing) return res.status(409).json({ error: "Já existe usuário com este login." });

    user.fullName = fullName;
    user.dob = dob;
    user.phone = phone;
    user.login = login;

    if (password) {
      const salt = crypto.randomBytes(10).toString("hex");
      user.salt = salt;
      user.passwordHash = sha256(`${salt}:${password}`);
      audit("user_update_password", id, `Senha atualizada para ${user.login}`);
    }

    saveDb(DB);
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

    const exists = DB.payments.some(p => p.userId === id && p.month === month);
    if (exists) return res.status(409).json({ error: "Este mês já consta como pago para o usuário." });

    const entry = {
      id: makeId("pay"),
      userId: id,
      month,
      paidAt: nowIso(),
      amount: (Number.isFinite(amount) ? amount : null),
      method,
      notes
    };
    DB.payments.push(entry);
    // Mantém limite (histórico permanente, mas com teto alto)
    if (DB.payments.length > 20000) DB.payments = DB.payments.slice(DB.payments.length - 20000);

    saveDb(DB);
    audit("payment_add", id, `Pagamento registrado: ${month}`);
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
        notes: p.notes
      };
    })
    .sort((a,b) => (String(b.paidAt||"").localeCompare(String(a.paidAt||""))));
  return res.json({ payments });
});

app.get("/api/admin/audit", requireAuth, requireAdmin, (req, res) => {
  const auditList = DB.audit.slice().sort((a,b) => String(b.at||"").localeCompare(String(a.at||"")));
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

app.post("/api/prescricao-hospitalar", requirePaidOrAdmin, async(req, res) => {
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

(async () => {
  // Se DATABASE_URL estiver configurado, carrega o estado do Postgres antes de aceitar tráfego.
  const info = await hydrateDbFromPgIfAvailable();
  console.log("[storage]", info);

  app.listen(port, () => {
    console.log(`Servidor escutando na porta ${port}`);
  });
})();
