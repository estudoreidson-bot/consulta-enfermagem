// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const OpenAI = require("openai");

// ======================================================================
// SEGURANÇA REPRODUTIVA E TIPO DE RECEITUÁRIO
// Objetivo: evitar campos "inferidos" por IA. Para reduzir margem de erro,
// o backend aplica regras determinísticas e (quando disponível) um dicionário
// curado para gravidez/lactação.
//
// Observação: gravidez/lactação variam por formulação, dose e bula do produto.
// Quando não houver dado curado, o sistema retorna "não informado" em vez de
// assumir algo.
// ======================================================================

function normalizeDrugKey(input) {
  const s = String(input || "").toLowerCase();
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Listas mínimas e conservadoras para tipo de receituário.
// Sempre que não houver correspondência, retorna Receita simples.
const RECEITUARIO_LISTS = {
  // C1: Outras substâncias sujeitas a controle especial (RCE, 2 vias, retenção).
  C1: new Set([
    "amitriptilina",
    "fluoxetina",
    "sertralina",
    "paroxetina",
    "citalopram",
    "escitalopram",
    "venlafaxina",
    "desvenlafaxina",
    "duloxetina",
    "mirtazapina",
    "bupropiona",
    "clomipramina",
    "imipramina",
    "nortriptilina",
    "trazodona",
    "quetiapina",
    "olanzapina",
    "risperidona",
    "haloperidol",
    "clorpromazina",
    "levomepromazina",
    "ziprasidona",
    "aripiprazol",
    "lítio",
    "litio",
    "valproato",
    "acido valproico",
    "carbamazepina",
    "lamotrigina",
    "topiramato"
  ]),
  // B1: Psicótropos (Notificação de Receita B - azul).
  B1: new Set([
    "diazepam",
    "clonazepam",
    "alprazolam",
    "lorazepam",
    "midazolam",
    "bromazepam",
    "nitrazepam",
    "flunitrazepam",
    "zolpidem",
    "zopiclona",
    "eszopiclona"
  ]),
  // A1/A2: Entorpecentes (Notificação de Receita A - amarela).
  A1: new Set([
    "morfina",
    "oxicodona",
    "fentanil",
    "metadona",
    "codeina",
    "tramadol",
    "buprenorfina"
  ]),
  // Antimicrobianos: receita de antimicrobiano (2 vias, retenção), conforme regulamentação.
  ATM: new Set([
    "amoxicilina",
    "amoxicilina clavulanato",
    "azitromicina",
    "claritromicina",
    "ceftriaxona",
    "cefalexina",
    "cefuroxima",
    "ciprofloxacino",
    "levofloxacino",
    "norfloxacino",
    "metronidazol",
    "sulfametoxazol trimetoprima",
    "doxiciclina",
    "clindamicina",
    "gentamicina",
    "nitrofurantoina"
  ])
};

// Dicionário curado (apenas quando há certeza operacional).
// Campos: tipo_receituario, gravidez_categoria (A/B/C/D/X), lactacao_risco.
// Se não houver chave, o sistema retorna "não informado" para gravidez/lactação.
const DRUG_SAFETY_DB = {
  "amitriptilina": {
    tipo_receituario: "Receita de Controle Especial (C1) - 2 vias (branca, com retenção)",
    gravidez_categoria: "C",
    lactacao_risco: "muito baixo risco"
  },
  "fluoxetina": {
    tipo_receituario: "Receita de Controle Especial (C1) - 2 vias (branca, com retenção)",
    gravidez_categoria: "C",
    lactacao_risco: "baixo risco"
  }
};

function getReceituarioByDrugKey(drugKey) {
  const k = normalizeDrugKey(drugKey);
  if (!k) return "Receita simples";

  // correspondência direta
  if (RECEITUARIO_LISTS.C1.has(k)) return "Receita de Controle Especial (C1) - 2 vias (branca, com retenção)";
  if (RECEITUARIO_LISTS.B1.has(k)) return "Notificação de Receita B (B1) - azul";
  if (RECEITUARIO_LISTS.A1.has(k)) return "Notificação de Receita A (entorpecentes) - amarela";
  if (RECEITUARIO_LISTS.ATM.has(k)) return "Receita de antimicrobiano - 2 vias (com retenção)";

  // heurística simples para combinações (ex.: amoxicilina + clavulanato)
  if (k.includes("amoxicilina") && k.includes("clav")) return "Receita de antimicrobiano - 2 vias (com retenção)";

  return "Receita simples";
}

function getDrugSafetyInfo(drugName) {
  const key = normalizeDrugKey(drugName);
  const base = {
    medicamento: String(drugName || "").trim() || "",
    tipo_receituario: getReceituarioByDrugKey(key),
    gravidez_categoria: "",
    lactacao_risco: ""
  };
  const curated = DRUG_SAFETY_DB[key];
  if (curated && typeof curated === "object") {
    return {
      ...base,
      ...curated,
      medicamento: base.medicamento
    };
  }
  return base;
}
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


// ======================================================================
// MONOGRAFIA DE MEDICAMENTO (estrutura para frontend)
// ======================================================================

async function gerarMonografiaMedicamento(medicamento, fontesSugeridas) {
  const nome = normalizeText(medicamento, 140);

  // Estrutura padrão (garante previsibilidade no frontend)
  function emptyOut() {
    return {
      medicamento: nome || "",
      classe: "",
      mecanismo_acao: "",
      apresentacoes: {
        solucao_oral: "",
        gotas: "",
        suspensao: "",
        xarope: "",
        comprimidos: "",
        capsulas: "",
        injetavel: "",
        supositorio: "",
        topicos: "",
        inalatorio: "",
        outros: ""
      },
      uso_clinico: [],
      tipo_receituario: "",
      posologia_adulto: {
        oral: { dose_usual: "", dose_maxima: "", observacoes: "" },
        injetavel: { dose_usual: "", dose_maxima: "", observacoes: "" },
        ajustes: ""
      },
      categoria_gravidez: "",
      uso_lactacao: "",
      uso_geriatrico: "",
      posologia_pediatrica: {
        oral: { dose_mgkg: "", dose_maxima: "", idade_minima: "", observacoes: "" },
        gotas: { dose_mgkg: "", dose_maxima: "", idade_minima: "", observacoes: "" },
        suspensao: { dose_mgkg: "", dose_maxima: "", idade_minima: "", observacoes: "" },
        injetavel: { dose_mgkg: "", dose_maxima: "", idade_minima: "", observacoes: "" },
        observacoes: ""
      },
      interacoes_medicamentosas: [],
      pontos_enfermagem: [],
      fontes_sugeridas: Array.isArray(fontesSugeridas) ? fontesSugeridas : []
    };
  }

  if (!nome) return emptyOut();

  // Se não houver chave, retorna estrutura padrão com aviso (sem quebrar o clique no frontend)
  if (!process.env.OPENAI_API_KEY) {
    const out = emptyOut();
    out.pontos_enfermagem = [
      "Sem chave OPENAI_API_KEY configurada no servidor. Configure a variável de ambiente para habilitar a monografia automática."
    ];
    return out;
  }

  const safety = getDrugSafetyInfo(nome);

  const prompt = `
Você é um médico no Brasil. Gere uma MONOGRAFIA CLÍNICA segura e prática do medicamento informado, voltada para APS e pronto atendimento.
Regras obrigatórias:
- Português do Brasil.
- Sem emojis e sem símbolos gráficos.
- Se não souber um item com segurança, use "não informado" (não invente).
- Não orientar uso off-label. Não prescrever; apenas informar.
- Seja conciso, mas completo nos campos exigidos.

Medicamento solicitado: "${nome}"

Informações de segurança já conhecidas (use como base, sem inventar além):
${JSON.stringify(safety)}

Responda EXCLUSIVAMENTE em JSON estrito (sem markdown), neste formato:
{
  "medicamento": "string",
  "classe": "string",
  "mecanismo_acao": "string",
  "apresentacoes": {
    "solucao_oral": "string",
    "gotas": "string",
    "suspensao": "string",
    "xarope": "string",
    "comprimidos": "string",
    "capsulas": "string",
    "injetavel": "string",
    "supositorio": "string",
    "topicos": "string",
    "inalatorio": "string",
    "outros": "string"
  },
  "uso_clinico": ["string"],
  "tipo_receituario": "string",
  "posologia_adulto": {
    "oral": { "dose_usual": "string", "dose_maxima": "string", "observacoes": "string" },
    "injetavel": { "dose_usual": "string", "dose_maxima": "string", "observacoes": "string" },
    "ajustes": "string"
  },
  "categoria_gravidez": "string",
  "uso_lactacao": "string",
  "uso_geriatrico": "string",
  "posologia_pediatrica": {
    "oral": { "dose_mgkg": "string", "dose_maxima": "string", "idade_minima": "string", "observacoes": "string" },
    "gotas": { "dose_mgkg": "string", "dose_maxima": "string", "idade_minima": "string", "observacoes": "string" },
    "suspensao": { "dose_mgkg": "string", "dose_maxima": "string", "idade_minima": "string", "observacoes": "string" },
    "injetavel": { "dose_mgkg": "string", "dose_maxima": "string", "idade_minima": "string", "observacoes": "string" },
    "observacoes": "string"
  },
  "interacoes_medicamentosas": ["string"],
  "pontos_enfermagem": ["string"],
  "fontes_sugeridas": [{"nome":"string","url":"string"}]
}
`;

  let data = null;
  try {
    data = await callOpenAIJson(prompt);
  } catch (e) {
    // fallback seguro
    const out = emptyOut();
    out.pontos_enfermagem = [
      "Falha ao gerar monografia automaticamente. Verifique logs do servidor e a chave OPENAI_API_KEY."
    ];
    return out;
  }

  const out = emptyOut();
  const obj = (data && typeof data === "object") ? data : {};

  function asStr(v, maxLen) {
    const s = (v === null || v === undefined) ? "" : String(v).trim();
    if (!s) return "";
    return s.slice(0, maxLen || 2000);
  }
  function asArr(v, maxItems) {
    const arr = Array.isArray(v) ? v : [];
    const outArr = [];
    for (const it of arr.slice(0, maxItems || 30)) {
      const s = asStr(it, 240);
      if (!s) continue;
      if (outArr.some(x => x.toLowerCase() === s.toLowerCase())) continue;
      outArr.push(s);
    }
    return outArr;
  }
  function asObj(v) {
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  }

  out.medicamento = asStr(obj.medicamento || obj.nome || obj.principio_ativo || nome, 180) || nome;
  out.classe = asStr(obj.classe, 220) || "";
  out.mecanismo_acao = asStr(obj.mecanismo_acao, 800) || "";

  const ap = asObj(obj.apresentacoes);
  for (const k of Object.keys(out.apresentacoes)) {
    out.apresentacoes[k] = asStr(ap[k], 600) || "";
  }

  out.uso_clinico = asArr(obj.uso_clinico, 25);
  out.tipo_receituario = asStr(obj.tipo_receituario, 220) || "";

  const pa = asObj(obj.posologia_adulto);
  const paOral = asObj(pa.oral);
  const paInj = asObj(pa.injetavel);
  out.posologia_adulto.oral.dose_usual = asStr(paOral.dose_usual, 220) || "";
  out.posologia_adulto.oral.dose_maxima = asStr(paOral.dose_maxima, 220) || "";
  out.posologia_adulto.oral.observacoes = asStr(paOral.observacoes, 600) || "";
  out.posologia_adulto.injetavel.dose_usual = asStr(paInj.dose_usual, 220) || "";
  out.posologia_adulto.injetavel.dose_maxima = asStr(paInj.dose_maxima, 220) || "";
  out.posologia_adulto.injetavel.observacoes = asStr(paInj.observacoes, 600) || "";
  out.posologia_adulto.ajustes = asStr(pa.ajustes, 600) || "";

  out.categoria_gravidez = asStr(obj.categoria_gravidez, 120) || "";
  out.uso_lactacao = asStr(obj.uso_lactacao, 600) || "";
  out.uso_geriatrico = asStr(obj.uso_geriatrico, 600) || "";

  const pp = asObj(obj.posologia_pediatrica);
  for (const sec of ["oral", "gotas", "suspensao", "injetavel"]) {
    const s = asObj(pp[sec]);
    out.posologia_pediatrica[sec].dose_mgkg = asStr(s.dose_mgkg, 220) || "";
    out.posologia_pediatrica[sec].dose_maxima = asStr(s.dose_maxima, 220) || "";
    out.posologia_pediatrica[sec].idade_minima = asStr(s.idade_minima, 120) || "";
    out.posologia_pediatrica[sec].observacoes = asStr(s.observacoes, 600) || "";
  }
  out.posologia_pediatrica.observacoes = asStr(pp.observacoes, 600) || "";

  out.interacoes_medicamentosas = asArr(obj.interacoes_medicamentosas, 25);
  out.pontos_enfermagem = asArr(obj.pontos_enfermagem, 25);

  const fs = Array.isArray(obj.fontes_sugeridas) ? obj.fontes_sugeridas : [];
  out.fontes_sugeridas = [];
  for (const it of fs.slice(0, 12)) {
    const n = asStr(it?.nome, 140);
    const u = asStr(it?.url, 600);
    if (!n && !u) continue;
    out.fontes_sugeridas.push({ nome: n || "Fonte", url: u || "" });
  }
  // garante fontes sugeridas passadas pelo frontend
  if ((!out.fontes_sugeridas.length) && Array.isArray(fontesSugeridas) && fontesSugeridas.length) {
    out.fontes_sugeridas = fontesSugeridas.slice(0, 12).map(x => ({
      nome: asStr(x?.nome, 140) || "Fonte",
      url: asStr(x?.url, 600) || ""
    }));
  }

  return out;
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

app.use(express.static(__dirname));

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
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY_MISSING");
    err.code = "OPENAI_API_KEY_MISSING";
    throw err;
  }
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
async function callOpenAIJson(prompt, maxAttempts = 3) {
  const attempts = Math.max(1, Math.min(5, parseInt(String(maxAttempts || 3), 10) || 3));
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const tightenedPrompt = i === 0
      ? prompt
      : (prompt + "\n\nATENÇÃO: Responda SOMENTE com um objeto JSON válido. Não use markdown, não use blocos de código, não inclua explicações.");

    try {
      const raw = await callOpenAI(tightenedPrompt);

      // 1) JSON direto
      try {
        return JSON.parse(raw);
      } catch {}

      // 2) extrai o primeiro bloco {...}
      try {
        const firstBrace = raw.indexOf("{");
        const lastBrace = raw.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
          return JSON.parse(jsonSlice);
        }
      } catch {}

      // 3) extrai bloco ```json ... ```
      try {
        const m = raw.match(/```\s*json\s*([\s\S]*?)```/i);
        if (m && m[1]) {
          return JSON.parse(m[1].trim());
        }
      } catch {}

      throw new Error("Resposta do modelo não pôde ser convertida em JSON.");
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Falha ao obter JSON do modelo.");
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
// Função para chamar o modelo com múltiplas imagens (data URLs) e retornar JSON
async function callOpenAIVisionJsonMulti(prompt, imagensDataUrl) {
  const imgs = Array.isArray(imagensDataUrl) ? imagensDataUrl : [];
  const content = [{ type: "text", text: prompt }];

  for (const url of imgs) {
    if (typeof url !== "string") continue;
    const u = url.trim();
    if (!u) continue;
    content.push({ type: "image_url", image_url: { url: u } });
    if (content.length >= 1 + 4) break; // texto + até 4 imagens
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [{ role: "user", content }]
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



async function extractMedicalContextFromImages(imagensDataUrl) {
  const rawArr = Array.isArray(imagensDataUrl) ? imagensDataUrl : [];
  const imgs = rawArr
    .map(u => normalizeImageDataUrl(u, 2_400_000))
    .filter(Boolean)
    .slice(0, 4);

  if (!imgs.length) return null;

  const prompt = `
Você está auxiliando na elaboração de documentos clínicos e administrativos com base em anexos.
Os anexos podem ser foto clínica de lesão/ferida/pele e/ou documentos de exames/resultados.
Tarefa: extrair informações objetivas dos anexos, sem inventar e sem afirmar diagnóstico definitivo.

Regras:
- Foto clínica: descreva apenas achados visuais objetivos (morfologia, bordas, cor, sinais de inflamação, presença de exsudato/secreção, tecido de granulação/necrose se visível, pele perilesional, edema). Não estime medidas se não for claramente possível.
- Documento de exame: transcreva e organize o essencial (nome do exame, data se houver, valores/achados, conclusão).
- Se houver incerteza, liste em "limitacoes".
- Não use emojis e não use símbolos gráficos.
- Retorne JSON estrito, sem texto fora do JSON.

Formato obrigatório:
{
  "tipo_anexo": "foto_clinica" | "documento" | "misto" | "indefinido",
  "resumo_objetivo": "string",
  "achados_exame_fisico": "string",
  "impressao_hipotese": "string",
  "exames_e_resultados": ["..."],
  "dados_identificacao": { "nome": "string", "cpf": "string", "cns": "string", "data_documento": "string" },
  "limitacoes": ["..."]
}
`;

  const data = await callOpenAIVisionJsonMulti(prompt, imgs);

  const tipo_anexo = (typeof data?.tipo_anexo === "string" ? data.tipo_anexo.trim() : "") || "indefinido";
  const resumo_objetivo = (typeof data?.resumo_objetivo === "string" ? data.resumo_objetivo.trim() : "");
  const achados_exame_fisico = (typeof data?.achados_exame_fisico === "string" ? data.achados_exame_fisico.trim() : "");
  const impressao_hipotese = (typeof data?.impressao_hipotese === "string" ? data.impressao_hipotese.trim() : "");
  const exames_e_resultados = normalizeArrayOfStrings(data?.exames_e_resultados, 40, 240);

  const di = (data?.dados_identificacao && typeof data.dados_identificacao === "object") ? data.dados_identificacao : {};
  const dados_identificacao = {
    nome: (typeof di.nome === "string" ? di.nome.trim() : ""),
    cpf: (typeof di.cpf === "string" ? di.cpf.trim() : ""),
    cns: (typeof di.cns === "string" ? di.cns.trim() : ""),
    data_documento: (typeof di.data_documento === "string" ? di.data_documento.trim() : "")
  };

  const limitacoes = normalizeArrayOfStrings(data?.limitacoes, 20, 220);

  return {
    tipo_anexo,
    resumo_objetivo,
    achados_exame_fisico,
    impressao_hipotese,
    exames_e_resultados,
    dados_identificacao,
    limitacoes
  };
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


function getImagesDataUrlFromBody(body) {
  const b = body || {};
  const arr = Array.isArray(b.images_data_url) ? b.images_data_url
    : (Array.isArray(b.imagens_data_url) ? b.imagens_data_url : null);

  if (arr && arr.length) return arr;

  const single = (typeof b.imagem_data_url === "string" && b.imagem_data_url.trim())
    ? b.imagem_data_url.trim()
    : (typeof b.image_data_url === "string" && b.image_data_url.trim())
      ? b.image_data_url.trim()
      : "";

  return single ? [single] : [];
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
  out.rosterConfigs = (out.rosterConfigs && typeof out.rosterConfigs === "object") ? out.rosterConfigs : {};
  out.rosterSchedules = Array.isArray(out.rosterSchedules) ? out.rosterSchedules : [];
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
    parentUserId: u.parentUserId || "",
    commissionRate: (typeof u.commissionRate === "number" ? u.commissionRate : null),
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

  return { schemaVersion: 2, users, payments };
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

// ======================================================================
// TESTE GRATUITO (NOVOS CADASTROS)
// - Todos os novos cadastros ganham 15 dias (configurável via TRIAL_DAYS).
// - Durante o teste, o acesso funciona mesmo sem pagamento do mês.
// - Bloqueio administrativo (isActive=false) continua valendo.
// ======================================================================
const TRIAL_DAYS = (() => {
  const n = parseInt(String(process.env.TRIAL_DAYS || "15"), 10);
  if (!Number.isFinite(n) || n < 0) return 15;
  return n;
})();

function trialEndsAtFromNowIso() {
  const ms = Date.now() + (TRIAL_DAYS * 24 * 60 * 60 * 1000);
  return new Date(ms).toISOString();
}

function isUserTrialActive(user) {
  const ends = String(user?.trialEndsAt || "").trim();
  if (!ends) return false;
  const ts = Date.parse(ends);
  if (!ts) return false;
  return Date.now() <= ts;
}

function userTrialDaysLeft(user) {
  const ends = String(user?.trialEndsAt || "").trim();
  const ts = Date.parse(ends);
  if (!ts) return 0;
  const diff = ts - Date.now();
  if (diff <= 0) return 0;
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

function isUserAccessOk(user) {
  if (!user || user.isDeleted) return false;
  if (!user.isActive) return false;
  return isUserPaidThisMonth(user.id) || isUserTrialActive(user);
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
  // Garante que req.auth exista mesmo quando esta middleware for usada diretamente
  // (algumas rotas a chamam sem passar antes por requireAuth).
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

  // Permite acesso se o usuário pagou o mês OU está dentro do período de teste.
  if (!(isUserPaidThisMonth(user.id) || isUserTrialActive(user))) {
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

    if (!fullName || !phone || !login || !password) {
      return res.status(400).json({ error: "Nome completo, telefone, CPF (Login) e senha são obrigatórios." });
    }

    // Login não precisa ser CPF. Permite letras, números e alguns caracteres seguros.
    // Evita espaços e caracteres que possam causar confusão em URLs/armazenamento.
    if (login.length < 3 || login.length > 40) {
      return res.status(400).json({ error: "Login inválido. Use entre 3 e 40 caracteres." });
    }
    if (!/^[A-Za-z0-9._@-]+$/.test(login)) {
      return res.status(400).json({ error: "Login inválido. Use apenas letras, números, ponto, sublinhado, hífen ou @." });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
    }

    if (findUserByLogin(login)) {
      return res.status(409).json({ error: "Já existe usuário com este login." });
    }

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login,
      parentUserId: "",
      commissionRate: null,
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      trialStartedAt: nowIso(),
      trialEndsAt: trialEndsAtFromNowIso(),
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
    if (!user.isActive) return res.status(403).json({ error: "Acesso bloqueado: usuário inativo. Procure o administrador." });

    const computed = sha256(`${user.salt || ""}:${senha}`);
    if (computed !== user.passwordHash) return res.status(401).json({ error: "Credenciais inválidas." });

    // Bloqueio por mensalidade em débito (exceto durante o teste gratuito)
    if (!(isUserPaidThisMonth(user.id) || isUserTrialActive(user))) {
      return res.status(403).json({ error: "Acesso bloqueado: mensalidade em débito. Procure o administrador." });
    }

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
      isPaidThisMonth: isUserAccessOk(user),
      paidCurrentMonth: isUserPaidThisMonth(user.id),
      isTrialActive: isUserTrialActive(user),
      trialStartedAt: user.trialStartedAt || "",
      trialEndsAt: user.trialEndsAt || "",
      trialDaysLeft: userTrialDaysLeft(user),
      user: {
        id: user.id,
        fullName: user.fullName,
        login: user.login,
        phone: user.phone,
        currentMonth: currentYYYYMM(),
        isPaidThisMonth: isUserAccessOk(user),
        paidCurrentMonth: isUserPaidThisMonth(user.id),
        isTrialActive: isUserTrialActive(user),
        trialStartedAt: user.trialStartedAt || "",
        trialEndsAt: user.trialEndsAt || "",
        trialDaysLeft: userTrialDaysLeft(user)
      }
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
    isPaidThisMonth: isUserAccessOk(u),
    paidCurrentMonth: isUserPaidThisMonth(u.id),
    isTrialActive: isUserTrialActive(u),
    trialStartedAt: u.trialStartedAt || "",
    trialEndsAt: u.trialEndsAt || "",
    trialDaysLeft: userTrialDaysLeft(u),
    user: {
      id: u.id,
      fullName: u.fullName,
      login: u.login,
      phone: u.phone,
      currentMonth: currentYYYYMM(),
      isPaidThisMonth: isUserAccessOk(u),
      paidCurrentMonth: isUserPaidThisMonth(u.id),
      isTrialActive: isUserTrialActive(u),
      trialStartedAt: u.trialStartedAt || "",
      trialEndsAt: u.trialEndsAt || "",
      trialDaysLeft: userTrialDaysLeft(u)
    }
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



// ======================================================================
// ROTAS DO CLIENTE (SUBUSUÁRIOS + CÁLCULO DE DESCONTO)
// - Cada subusuário cadastrado gera 25% de desconto, limitado a 100%.
// - O desconto só é aplicado se o usuário principal estiver com o mês atual em dia.
// ======================================================================

function listActiveFriends(parentUserId) {
  const pid = String(parentUserId || "");
  return (Array.isArray(DB?.users) ? DB.users : [])
    .filter(u => u && !u.isDeleted && String(u.parentUserId || "") === pid)
    .map(u => ({
      id: u.id,
      fullName: u.fullName || "",
      login: u.login || "",
      phone: u.phone || "",
      dob: u.dob || "",
      createdAt: u.createdAt || ""
    }))
    .sort((a,b) => String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
}

function computeClientBilling(parentUserId) {
  const pid = String(parentUserId || "");
  const parent = (Array.isArray(DB?.users) ? DB.users : []).find(u => u && !u.isDeleted && String(u.id || "") === pid) || null;
  const friends = listActiveFriends(parentUserId);
  const eligibleDiscount = isUserPaidThisMonth(parentUserId);
  const discountPercent = eligibleDiscount ? Math.min(25 * friends.length, 100) : 0;

  // Valores base (sem distinção PIX/Cartão)
  // Mensal: R$ 25,00
  // Anual: R$ 240,00
  const base = {
    monthly: 25,
    annual: 240
  };

  const mult = 1 - (discountPercent / 100);
  const round2 = (x) => Math.round(Number(x) * 100) / 100;

  const final = {
    monthly: round2(base.monthly * mult),
    annual: round2(base.annual * mult)
  };

  return {
    friends,
    eligibleDiscount,
    discountPercent,
    base,
    final,
    paidCurrentMonth: isUserPaidThisMonth(parentUserId),
    isTrialActive: isUserTrialActive(parent),
    trialEndsAt: parent?.trialEndsAt || "",
    trialDaysLeft: userTrialDaysLeft(parent),
    accessOk: isUserAccessOk(parent)
  };
}

app.get("/api/client/friends", requireAuth, (req, res) => {
  try {
    if (req.auth.role !== "nurse") return res.status(403).json({ error: "Acesso negado." });
    const parentId = req.auth.user?.id;
    if (!parentId) return res.status(400).json({ error: "Usuário inválido." });
    return res.json({ friends: listActiveFriends(parentId) });
  } catch (e) {
    return res.status(500).json({ error: "Falha ao carregar subusuários." });
  }
});

app.post("/api/client/friends", requireAuth, (req, res) => {
  try {
    if (req.auth.role !== "nurse") return res.status(403).json({ error: "Acesso negado." });
    const parentId = req.auth.user?.id;
    if (!parentId) return res.status(400).json({ error: "Usuário inválido." });

    const fullName = String(req.body?.fullName || "").trim();
    const dob = String(req.body?.dob || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const login = String(req.body?.login || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!fullName || !phone || !login || !password) {
      return res.status(400).json({ error: "Nome completo, telefone, CPF (Login) e senha são obrigatórios." });
    }

    if (login.length < 3 || login.length > 40) {
      return res.status(400).json({ error: "Login inválido. Use entre 3 e 40 caracteres." });
    }
    if (!/^[A-Za-z0-9._@-]+$/.test(login)) {
      return res.status(400).json({ error: "Login inválido. Use apenas letras, números, ponto, sublinhado, hífen ou @." });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: "Senha muito curta. Use pelo menos 4 caracteres." });
    }

    if (findUserByLogin(login)) {
      return res.status(409).json({ error: "Já existe usuário com este login." });
    }

    const salt = crypto.randomBytes(10).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);

    const user = {
      id: makeId("usr"),
      fullName,
      dob,
      phone,
      login,
      parentUserId: String(parentId),
      commissionRate: 0.25,
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      trialStartedAt: nowIso(),
      trialEndsAt: trialEndsAtFromNowIso(),
      lastLoginAt: "",
      lastSeenAt: "",
      activeSessionHash: "",
      activeDeviceId: "",
      activeSessionCreatedAt: "",
      activeSessionLastSeenAt: "",
      activeSessionExpiresAt: ""
    };

    DB.users.push(user);
    saveDb(DB, "add_friend");
    audit("subuser_add", parentId, `Subusuário cadastrado: ${user.login}`);
    return res.json({ ok: true, id: user.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha ao cadastrar subusuário." });
  }
});

app.get("/api/client/billing", requireAuth, (req, res) => {
  try {
    if (req.auth.role !== "nurse") return res.status(403).json({ error: "Acesso negado." });
    const parentId = req.auth.user?.id;
    if (!parentId) return res.status(400).json({ error: "Usuário inválido." });

    const out = computeClientBilling(parentId);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: "Falha ao calcular cobrança." });
  }
});

// ======================================================================
// ROTA DO CLIENTE – GERAR LINK DE PAGAMENTO (INFINITEPAY CHECKOUT)
// - O frontend abre o checkout e o cliente escolhe Pix ou Cartão na tela da InfinitePay.
// - Documentação: POST https://api.infinitepay.io/invoices/public/checkout/links
// ======================================================================

async function infinitePayCreateCheckoutLink(payload) {
  // Usa fetch nativo (Node 18+). Se não existir, falha com mensagem clara.
  const hasFetch = (typeof fetch === "function");
  if (!hasFetch) throw new Error("Ambiente sem fetch disponível para integração com a InfinitePay.");

  const resp = await fetch("https://api.infinitepay.io/invoices/public/checkout/links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : "Falha ao gerar link de pagamento.";
    const err = new Error(msg);
    err.statusCode = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

function brlToCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round(n * 100));
}

function safePhoneDigits(s) {
  return String(s || "").replace(/\D/g, "").slice(0, 20);
}

function toE164BR(phoneDigits) {
  const d = String(phoneDigits || '').replace(/\D/g, '');
  if (!d) return '';
  // Converte para E.164 (BR). Aceita 10/11 dígitos (DDD + número) e adiciona +55.
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) return '+55' + d;
  // Se já vier com DDI 55 (ex: 5511999998888), apenas prefixa +
  if (d.startsWith('55') && d.length >= 12 && d.length <= 15) return '+' + d;
  // Fallback: se parecer internacional, prefixa +
  if (d.length >= 12 && d.length <= 15) return '+' + d;
  return '';
}

app.post("/api/client/infinitepay/checkout-link", requireAuth, async (req, res) => {
  try {
    if (req.auth.role !== "nurse") return res.status(403).json({ error: "Acesso negado." });
    const parentId = req.auth.user?.id;
    if (!parentId) return res.status(400).json({ error: "Usuário inválido." });

    const handle = String(process.env.INFINITEPAY_HANDLE || "").trim();
    if (!handle) {
      return res.status(500).json({ error: "INFINITEPAY_HANDLE não configurado no servidor." });
    }

    const plan = String(req.body?.plan || "").trim().toLowerCase(); // monthly | annual

    if (!plan || !["monthly", "annual"].includes(plan)) {
      return res.status(400).json({ error: "Plano inválido." });
    }

    const billing = computeClientBilling(parentId);
    const final = billing?.final || {};

    let amountBrl = 0;
    let title = "";
    if (plan === "monthly") { amountBrl = final.monthly; title = "Mensalidade"; }
    if (plan === "annual") { amountBrl = final.annual; title = "Anuidade"; }

    const amountCents = brlToCents(amountBrl);
    if (!amountCents) return res.status(400).json({ error: "Valor inválido para cobrança." });

    const u = req.auth.user || {};
    const customerName = String(u.fullName || u.login || "").trim();
    const customerPhone = toE164BR(safePhoneDigits(u.phone || ""));

    const orderNsu = crypto.randomBytes(8).toString("hex");

    const allowedOrigin = String(process.env.ALLOWED_ORIGIN || "").trim();
    const redirectUrl = allowedOrigin ? (allowedOrigin.replace(/\/$/, "") + "/?pagamento=retorno") : undefined;

    const payload = {
      handle,
      order_nsu: orderNsu,
      items: [
        {
          quantity: 1,
          price: amountCents,
          description: `Atendimento de Enfermagem - ${title}`
        }
      ],
      // Dados do cliente são opcionais; enviamos o que já existe para facilitar preenchimento no checkout.
      customer: {
        name: customerName || undefined,
        email: (u.email ? String(u.email).trim() : undefined),
        phone_number: customerPhone || undefined
      },
      redirect_url: redirectUrl
    };

    // Remove campos undefined do payload
    function prune(obj) {
      if (!obj || typeof obj !== "object") return obj;
      if (Array.isArray(obj)) return obj.map(prune);
      const out = {};
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v === undefined || v === null || v === "") continue;
        out[k] = prune(v);
      }
      return out;
    }
    const cleanPayload = prune(payload);

    const created = await infinitePayCreateCheckoutLink(cleanPayload);

    // A API retorna, entre outros campos, o link de checkout. Mantemos nomes tolerantes.
    const url = created?.checkout_url || created?.url || created?.link || created?.checkoutUrl || "";
    const slug = created?.invoice_slug || created?.slug || "";

    if (!url) {
      return res.status(502).json({ error: "Link de pagamento não retornado pela InfinitePay." });
    }

    // Log mínimo (sem dados sensíveis)
    audit("infinitepay_link", parentId, `Gerado link ${plan} (${amountCents} centavos) slug=${slug || "-"}`);

    return res.json({
      ok: true,
      checkout_url: url,
      invoice_slug: slug,
      order_nsu: orderNsu,
      amount_cents: amountCents
    });
  } catch (e) {
    const status = Number(e?.statusCode || 0) || 502;
    const msg = String(e?.message || "Falha ao gerar link de pagamento.");
    console.error("[InfinitePay] erro ao gerar link:", msg);
    return res.status(status).json({ error: msg, code: "INFINITEPAY_ERROR" });
  }
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
      isPaidThisMonth: isUserPaidThisMonth(u.id),
      paidCurrentMonth: isUserPaidThisMonth(u.id),
      trialStartedAt: u.trialStartedAt || "",
      trialEndsAt: u.trialEndsAt || "",
      isTrialActive: isUserTrialActive(u),
      trialDaysLeft: userTrialDaysLeft(u),
      accessOk: isUserAccessOk(u)
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

    if (!fullName || !phone || !login || !password) {
      return res.status(400).json({ error: "Nome completo, telefone, CPF (Login) e senha são obrigatórios." });
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
      parentUserId: "",
      commissionRate: null,
      salt,
      passwordHash,
      isActive: true,
      isDeleted: false,
      createdAt: nowIso(),
      trialStartedAt: nowIso(),
      trialEndsAt: trialEndsAtFromNowIso(),
      lastLoginAt: "",
      lastSeenAt: "",
      activeSessionHash: "",
      activeDeviceId: "",
      activeSessionCreatedAt: "",
      activeSessionLastSeenAt: "",
      activeSessionExpiresAt: ""
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

    if ((!transcricao || !String(transcricao).trim()) && (!imagens || !imagens.length)) {
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
// ROTA EXTRA – PERGUNTAS ESSENCIAIS PARA A PASSAGEM DE PLANTÃO (APÓS GERAR)
// ======================================================================

function gerarPerguntasEssenciaisPassagemFallback(passagem) {
  const t = String(passagem || "").toLowerCase();
  const qs = [];

  const need = (kw, q) => { if (!t.includes(kw) && qs.length < 8) qs.push(q); };

  need("identifica", "Qual a identificação completa do paciente (nome, idade, leito/setor)?");
  need("situa", "Qual a situação atual e sinais vitais mais recentes?");
  need("alerg", "Há alergias conhecidas?");
  need("acesso", "Quais dispositivos/acessos estão em uso e quais cuidados associados?");
  need("sonda", "Há sonda, drenos ou curativos? Quais os cuidados e pendências?");
  need("antibi", "Quais medicações críticas estão em curso e quando é a próxima dose?");
  need("exame", "Há exames pendentes e qual a conduta conforme o resultado?");
  need("risco", "Quais riscos principais (queda, LPP, broncoaspiração, isolamento) e medidas em curso?");

  // Se já estiver muito completo, ainda sugere checagens operacionais.
  if (qs.length < 3) {
    qs.push("Há pendências específicas para o próximo turno (monitorização, reavaliações, metas)?");
    qs.push("Quais sinais de alarme devem motivar acionar o médico/equipe de resposta rápida?");
  }

  return qs.slice(0, 8);
}

app.post("/api/perguntas-essenciais-passagem-plantao", requirePaidOrAdmin, async (req, res) => {
  try {
    const passagem = normalizeText(req.body?.passagem_plantao, 12000);
    if (!passagem) return res.json({ perguntas: [] });

    if (!process.env.OPENAI_API_KEY) {
      return res.json({ perguntas: gerarPerguntasEssenciaisPassagemFallback(passagem) });
    }

    const prompt = `
Você é um enfermeiro humano experiente em passagem de plantão.
Tarefa: avaliar a passagem de plantão atual e propor PERGUNTAS ESSENCIAIS para completar lacunas e aumentar a segurança do próximo turno.

Regras:
- Não invente dados.
- Perguntas curtas, objetivas e acionáveis.
- Priorize itens críticos: identificação, situação atual, sinais vitais, dispositivos, medicações críticas, exames pendentes, riscos, metas e pendências.
- Evite redundâncias.
- No máximo 8 perguntas.
- Sem emojis e sem símbolos gráficos.

Formato de saída: JSON estrito:
{ "perguntas": ["...", "..."] }

Passagem de plantão atual:
"""${passagem}"""
`;

    const data = await callOpenAIJson(prompt);
    const perguntas = normalizeArrayOfStrings(data?.perguntas, 8, 220);
    return res.json({ perguntas });
  } catch (e) {
    console.error(e);
    return res.json({ perguntas: [] });
  }
});


// ======================================================================
// ROTA EXTRA – ATUALIZAR PASSAGEM DE PLANTÃO COM COMPLEMENTOS (Q/A)
// ======================================================================

app.post("/api/atualizar-passagem-plantao", requirePaidOrAdmin, async (req, res) => {
  try {
    const passagemAtual = normalizeText(req.body?.passagem_plantao_atual, 18000);
    const complementos = normalizeText(req.body?.complementos, 12000);
    const transcricaoBase = normalizeText(req.body?.transcricao_base, 18000);

    if (!passagemAtual) return res.json({ passagem_plantao: "" });

    if (!process.env.OPENAI_API_KEY) {
      // Sem chave, devolve a passagem atual com um rodapé curto.
      const msg = "Sem chave OPENAI_API_KEY configurada no servidor.";
      const extra = complementos ? ("\n\nComplementos registrados:\n" + complementos) : "";
      return res.json({ passagem_plantao: (passagemAtual + extra + "\n\nObservação: " + msg).trim() });
    }

    const prompt = `
Você é um enfermeiro humano experiente em passagem de plantão hospitalar.
Tarefa: atualizar a PASSAGEM DE PLANTÃO mantendo linguagem técnica, objetiva e segura.

Instruções:
- Use a passagem atual como base.
- Incorpore os complementos (perguntas e respostas) de forma coerente, sem repetir informações.
- Se houver conflito, priorize o que estiver nos complementos.
- Se algo permanecer ausente, mantenha "não informado" e/ou indique o que precisa ser checado.
- Sem emojis e sem símbolos gráficos.

Saída: JSON estrito:
{ "passagem_plantao": "texto atualizado" }

Passagem atual:
"""${passagemAtual}"""

Complementos (perguntas e respostas):
"""${complementos || ""}"""

Transcrição base (se ajudar a contextualizar, pode usar, mas não é obrigatório):
"""${transcricaoBase || ""}"""
`;

    const data = await callOpenAIJson(prompt);
    const passagem = typeof data?.passagem_plantao === "string" ? data.passagem_plantao.trim() : "";
    return res.json({ passagem_plantao: passagem || passagemAtual });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao atualizar passagem de plantão." });
  }
});


// ======================================================================
// ROTA 2 – RECOMENDAÇÕES DE PERGUNTAS COMPLEMENTARES (ANAMNESE) (EXISTENTE)
// ======================================================================

app.post("/api/recomendacoes-anamnese", requirePaidOrAdmin, async(req, res) => {
  try {
    const { soap } = req.body || {};
    if (!soap || !String(soap).trim()) {
      return res.json({ perguntas: [], itens: [] });
    }

    const safeSoap = normalizeText(soap, 10000);

    const prompt = `
Você é um enfermeiro humano. A partir do SOAP atual, gere perguntas complementares objetivas para melhorar a avaliação de enfermagem.
As perguntas devem ser guiadas por cenário, priorizando segurança, sinais de alarme, monitorização e fatores de risco.

Regras:
- Sem emojis e sem símbolos gráficos.
- Perguntas curtas, práticas e executáveis.
- No máximo 12 perguntas.
- Evite perguntas redundantes.

Classifique cada pergunta na seção do SOAP a que ela mais pertence: "S" (Subjetivo), "O" (Objetivo), "A" (Avaliação), "P" (Plano).
Se não houver uma seção clara, use "G" (Geral).

Formato de saída: JSON estrito:
{
  "itens": [
    { "secao": "S", "pergunta": "..." },
    { "secao": "O", "pergunta": "..." }
  ]
}

SOAP:
"""${safeSoap}"""
`;

    const data = await callOpenAIJson(prompt);
    const rawItems = Array.isArray(data?.itens) ? data.itens : [];
    const itens = [];
    const secOk = new Set(["S", "O", "A", "P", "G"]);

    for (const it of rawItems.slice(0, 20)) {
      if (!it || typeof it !== "object") continue;
      const sec = String(it.secao || "").trim().toUpperCase();
      const pergunta = normalizeText(String(it.pergunta || "").trim(), 180);
      if (!pergunta) continue;
      itens.push({ secao: secOk.has(sec) ? sec : "G", pergunta });
      if (itens.length >= 12) break;
    }

    // compatibilidade: ainda entrega "perguntas" como array simples
    const perguntas = itens.map(x => x.pergunta);
    return res.json({ perguntas, itens });
  } catch (e) {
    console.error(e);
    return res.json({ perguntas: [], itens: [] });
  }
});




// ======================================================================
// ROTA 2.1 – ATUALIZAR SOAP E PRESCRIÇÃO A PARTIR DE PERGUNTAS/RESPOSTAS
// ======================================================================

app.post("/api/atualizar-soap-perguntas", requirePaidOrAdmin, async(req, res) => {
  try {
    const { soap_atual, perguntas_e_respostas, transcricao_base } = req.body || {};
    const safeSoap = normalizeText(soap_atual || "", 12000);
    const safeTranscricao = normalizeText(transcricao_base || "", 20000);

    // Compatibilidade: o frontend pode enviar
    // - string com "perguntas e respostas" (fala corrida)
    // - array [{pergunta, resposta}, ...]
    let qaText = "";
    if (typeof perguntas_e_respostas === "string") {
      qaText = normalizeText(perguntas_e_respostas || "", 12000);
    } else if (Array.isArray(perguntas_e_respostas)) {
      qaText = perguntas_e_respostas
        .map((x, i) => {
          const p = normalizeText(x?.pergunta || "", 300);
          const r = normalizeText(x?.resposta || "", 600);
          if (!p && !r) return "";
          if (p && r) return `Pergunta ${i + 1}: ${p}\nResposta ${i + 1}: ${r}`;
          if (p && !r) return `Pergunta ${i + 1}: ${p}\nResposta ${i + 1}: não informado`;
          return `Pergunta ${i + 1}: não informado\nResposta ${i + 1}: ${r}`;
        })
        .filter(Boolean)
        .join("\n\n");
    }

    if (!qaText || qaText.trim().length < 5) {
      // Não há nada novo para atualizar
      return res.json({ soap: safeSoap, evolucao_enfermagem: "", prescricao: "" });
    }

    const prompt = `
Você é um enfermeiro humano atualizando a documentação do atendimento após uma rodada adicional de perguntas e/ou informações complementares.

Objetivo:
- Identificar e incorporar no registro qualquer informação NOVA presente nas falas adicionais, mesmo que não tenha sido resposta direta às perguntas sugeridas.
- Atualizar de forma coerente e segura:
  1) SOAP (S/O/A/P) com foco de enfermagem.
  2) Evolução de enfermagem (texto corrido) para prontuário, baseada apenas nas informações disponíveis.
  3) Plano de cuidados (prescrição de enfermagem), objetivo e seguro.

Regras obrigatórias:
- Não invente dados. Se não estiver presente, escreva "não informado".
- Sem emojis e sem símbolos gráficos.
- Não faça diagnóstico médico definitivo.
- Se houver informação nova que contradiz informação anterior, não apague sem critério: registre a divergência de forma clara (ex.: "relata X; anteriormente Y") e priorize segurança.

Formato de saída: JSON estrito:
{
  "soap": "S: ...\nO: ...\nA: ...\nP: ...",
  "evolucao_enfermagem": "Evolução de enfermagem em texto corrido",
  "prescricao": "Plano de cuidados atualizado"
}

SOAP atual:
"""${safeSoap}"""

Transcrição base (contexto, se necessário):
"""${safeTranscricao}"""

Falas adicionais (perguntas, respostas e informações espontâneas):
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

    // Mantém comportamento previsível mesmo se o backend estiver sem chave.
    // (Evita 500 e permite o usuário entender o motivo.)
    if (!process.env.OPENAI_API_KEY) {
      const msg = "Sem chave OPENAI_API_KEY configurada no servidor.";
      return res.json({
        sae: "Coleta de dados: não informado\n\nDiagnósticos de enfermagem sugeridos: não informado\n\nResultados esperados: não informado\n\nIntervenções: não informado\n\nObservação: " + msg,
        orientacoes: "Orientações ao paciente: não informado\n\nSinais de alerta: não informado\n\nRetorno: não informado\n\nObservação: " + msg
      });
    }

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
    // Erro de configuração: retorna 200 com aviso (mais útil para o usuário do que 500 genérico)
    if (String(e?.code || "") === "OPENAI_API_KEY_MISSING" || String(e?.message || "") === "OPENAI_API_KEY_MISSING") {
      const msg = "Sem chave OPENAI_API_KEY configurada no servidor.";
      return res.json({
        sae: "Coleta de dados: não informado\n\nDiagnósticos de enfermagem sugeridos: não informado\n\nResultados esperados: não informado\n\nIntervenções: não informado\n\nObservação: " + msg,
        orientacoes: "Orientações ao paciente: não informado\n\nSinais de alerta: não informado\n\nRetorno: não informado\n\nObservação: " + msg
      });
    }
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
// ROTA 4.3B – MONOGRAFIA DE MEDICAMENTO (BULA ORGANIZADA)
// ======================================================================

app.post("/api/medicamento-monografia", requirePaidOrAdmin, async (req, res) => {
  try {
    const medicamento = normalizeText(req.body?.medicamento, 140);

    if (!medicamento) {
      return res.status(400).json({ error: "Informe o nome do medicamento." });
    }

    const fontesSugeridas = Array.isArray(req.body?.fontes_sugeridas) ? req.body.fontes_sugeridas : [];
    const monografia = await gerarMonografiaMedicamento(medicamento, fontesSugeridas);

    return res.json({ monografia });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar a monografia do medicamento." });
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
// ROTA 4.5B – AVALIAR RECEITA POR FOTO/ARQUIVO (TRANSCRIÇÃO + LISTA DE MEDS)
// ======================================================================

app.post("/api/avaliar-receita-imagem", requirePaidOrAdmin, async (req, res) => {
  try {
    const imagens = getImagesDataUrlFromBody(req.body);
    const rawArr = normalizeArrayOfStrings(imagens, 4, 4_000_000);

    const safeImages = rawArr
      .map((u) => normalizeImageDataUrl(u, 4_000_000))
      .filter((u) => !!u);

    if (!safeImages.length) {
      return res.status(400).json({
        error:
          "Imagem inválida ou muito grande. Envie uma ou mais fotos em formato de imagem (data URL) e tente novamente."
      });
    }

    const out = await avaliarReceitaPorImagem(safeImages);
    return res.json({ avaliacao: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar a receita." });
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
async function avaliarReceitaPorImagem(imagensDataUrl) {
  const prompt = `
Você é um profissional de saúde avaliando uma receita/prescrição fotografada.

Tarefa:
1) Transcrever somente o que estiver legível (sem inventar). Se houver trechos ilegíveis ou duvidosos, marque como "não informado".
2) Identificar os medicamentos citados na receita (nome do medicamento e, quando legível, concentração/apresentação).
3) Não interpretar conduta, não ajustar doses, não orientar tratamento. Apenas transcrever e estruturar.
4) Sem emojis e sem símbolos gráficos.

Responda EXCLUSIVAMENTE em JSON, sem markdown, neste formato:
{
  "transcricao_organizada": "string",
  "medicamentos": [
    { "nome": "string", "detalhes": "string" }
  ],
  "quantidade_medicamentos": 0,
  "campos_pendentes": "string",
  "limitacoes": "string"
}
`;

  const data = await callOpenAIVisionJsonMulti(prompt, imagensDataUrl);

  const transcricao_organizada = typeof data?.transcricao_organizada === "string" ? data.transcricao_organizada.trim() : "";
  const campos_pendentes = typeof data?.campos_pendentes === "string" ? data.campos_pendentes.trim() : "";
  const limitacoes = typeof data?.limitacoes === "string" ? data.limitacoes.trim() : "";

  const medsRaw = Array.isArray(data?.medicamentos) ? data.medicamentos : [];
  const meds = [];
  const seen = new Set();

  for (const item of medsRaw) {
    const nome = (typeof item === "string") ? item.trim()
      : (typeof item?.nome === "string" ? item.nome.trim()
        : (typeof item?.medicamento === "string" ? item.medicamento.trim() : ""));
    const detalhes = (typeof item?.detalhes === "string" ? item.detalhes.trim()
      : (typeof item?.concentracao === "string" ? item.concentracao.trim() : ""));

    if (!nome) continue;

    const key = nome.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    meds.push({
      nome,
      detalhes: detalhes || "não informado"
    });

    if (meds.length >= 25) break;
  }

  const quantidade = Number.isFinite(data?.quantidade_medicamentos) ? data.quantidade_medicamentos : meds.length;

  return {
    transcricao_organizada: transcricao_organizada || "não informado",
    medicamentos: meds,
    quantidade_medicamentos: Math.max(0, quantidade || meds.length || 0),
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

});

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
    const body = req.body || {};
    const transcricao = (typeof body.transcricao === "string" ? body.transcricao : (typeof body.texto === "string" ? body.texto : (typeof body.pedido === "string" ? body.pedido : "")));
    const tipo_documento = body.tipo_documento;
    const imagens = getImagesDataUrlFromBody(body).map(u => normalizeImageDataUrl(u, 2_400_000)).filter(Boolean).slice(0, 4);

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
// ROTA 6.05 – GERAR DOCUMENTO MÉDICO (INSS/ATESTADO/ENCAMINHAMENTO/DECLARAÇÃO) A PARTIR DA TRANSCRIÇÃO (NOVA)
// Objetivo: identificar automaticamente o tipo de documento solicitado na consulta,
// extrair doença/queixa e exames mencionados, e gerar um texto formal com campos pendentes.
// ======================================================================

function inferMedicalDocumentTypeHeuristic(transcricao) {
  const t = String(transcricao || "").toLowerCase();
  if (!t) return "Outros";

  if (t.includes("inss") || t.includes("perícia") || t.includes("pericia") || t.includes("benefício") || t.includes("beneficio") || t.includes("auxílio") || t.includes("auxilio")) return "Relatório médico para INSS";
  if (t.includes("atestado")) return "Atestado médico";
  if (t.includes("declara") || t.includes("comparecimento") || t.includes("permanência") || t.includes("permanencia")) return "Declaração médica";
  if (t.includes("encaminh")) return "Encaminhamento médico";
  if (t.includes("laudo")) return "Laudo/Relatório médico";
  if (t.includes("solicita") && (t.includes("exame") || t.includes("rx") || t.includes("raio") || t.includes("resson") || t.includes("tomografia") || t.includes("laborat"))) return "Solicitação de exames";
  return "Outros";
}

function suggestMedicalDocumentQuestionsHeuristic(transcricao, tipo) {
  const q = [];
  const push = (s) => {
    const v = String(s || "").trim();
    if (!v) return;
    if (q.some(x => x.toLowerCase() === v.toLowerCase())) return;
    if (q.length < 5) q.push(v);
  };

  push("Qual o nome completo do paciente e pelo menos um identificador (CPF ou CNS)?");
  push("Qual a data da consulta e a Unidade/Serviço (município/UF)?");

  const tt = String(tipo || "").toLowerCase();

  if (tt.includes("inss")) {
    push("Qual a profissão/atividade laboral e quais tarefas agravam/limitam o quadro?");
    push("Há quanto tempo o quadro está presente (início e evolução) e se houve afastamentos prévios?");
    push("Quais exames foram realizados (data, tipo e principais achados do laudo)?");
    push("Qual conduta atual (tratamento conservador, fisioterapia, medicações) e reavaliação/seguimento?");
  } else if (tt.includes("atestado")) {
    push("Qual o período sugerido de afastamento (em dias) e a data de início?");
    push("O atestado é para afastamento laboral, escolar ou outra finalidade?");
  } else if (tt.includes("encaminh")) {
    push("Para qual serviço/profissional é o encaminhamento e qual o motivo principal?");
    push("Quais exames e tratamentos já realizados e quais estão pendentes?");
  } else if (tt.includes("solicitação")) {
    push("Quais exames exatamente e qual a hipótese/justificativa clínica?");
    push("Há preparo necessário (jejum, suspensão de medicação, ciclo menstrual, etc.)?");
  } else {
    push("Qual a finalidade/destino do documento (para quem/onde será apresentado)?");
  }

  return q.slice(0, 5);
}

async function generateMedicalDocumentFromTranscript(transcricao, tipoSelecionado, anexos) {
  const safeTranscricao = normalizeText(transcricao || "", 25000);
  if (!safeTranscricao || safeTranscricao.length < 30) {
    return {
      tipo_documento: tipoSelecionado || "",
      doenca_ou_queixa_principal: "não informado",
      exames_mencionados: [],
      campos_pendentes: ["Transcrição insuficiente para geração do documento."],
      documento: ""
    };
  }

  const tiposPermitidos = [
    "Relatório médico para INSS",
    "Atestado médico",
    "Declaração médica",
    "Encaminhamento médico",
    "Laudo/Relatório médico",
    "Solicitação de exames",
    "Outros"
  ];

  const tipoInferido = inferMedicalDocumentTypeHeuristic(safeTranscricao);
  const tipoFinal = (typeof tipoSelecionado === "string" && tipoSelecionado.trim())
    ? tipoSelecionado.trim()
    : tipoInferido;

  const tiposTexto = tiposPermitidos.map(t => `- ${t}`).join("\n");

  const prompt = `
Você é um médico humano redigindo documentação clínica e administrativa para uso real (prontuário, empresas, escolas, perícia previdenciária).
Tarefa: a partir da transcrição integral de uma consulta (perguntas e respostas), identifique o tipo de documento solicitado e gere o documento completo, formal e compatível com avaliação pericial quando aplicável.

Regras obrigatórias:
- Não invente dados. Se faltar informação, escreva "não informado" ou deixe campo em branco com sublinhado (ex.: "CPF: __________").
- Não use emojis e não use símbolos gráficos.
- Não faça diagnóstico definitivo além do que estiver explicitamente descrito. Se houver hipótese, escreva como hipótese/compatível.
- Extraia e liste exames mencionados (tipo, data se houver, principais achados citados).
- Em "Relatório médico para INSS": descreva queixa, exame físico, achados complementares, limitação funcional referida, conduta e necessidade de avaliação médico-pericial; evite linguagem exagerada; não determine incapacidade definitiva.
- Linguagem: objetiva, técnica e formal, em português.

Você deve retornar JSON estrito, sem texto fora do JSON, com as chaves:
{
  "tipo_documento": "um dos tipos permitidos",
  "doenca_ou_queixa_principal": "string",
  "exames_mencionados": ["..."],
  "campos_pendentes": ["..."],
  "documento": "texto final pronto para copiar e imprimir"
}

Tipos permitidos (escolha exatamente um, sem variações):
${tiposTexto}

Campo "tipo_documento" informado no request (pode ser nulo):
${tipoSelecionado ? JSON.stringify(tipoSelecionado) : "null"}

Estrutura mínima do documento (adapte conforme o tipo):
1) Título em caixa alta (igual ao tipo_documento).
2) Identificação:
   Paciente: __________
   Idade/Data de nascimento: __________
   CPF: __________
   CNS: __________
   Profissão/Atividade laboral: __________
   Unidade/Serviço: __________
   Município/UF: __________
   Data da consulta: ____/____/____
3) Finalidade/Destino: __________
4) Conteúdo em parágrafos curtos, com subtítulos em linha (sem bullets), quando aplicável:
   Queixa/História:
   Exame físico:
   Exames complementares:
   Impressão diagnóstica/hipótese:
   Conduta/Tratamento:
   Limitação funcional/repercussão:
   Orientações e seguimento:
   Observação pericial (quando aplicável):
5) Rodapé:
   Local e data: ______________________
   Médico responsável: ______________________
   CRM: ______________________
   Assinatura e carimbo: ______________________

Informações extraídas de anexos (exames, laudos, fotos clínicas):
${anexos ? JSON.stringify(anexos) : "Nenhum anexo informado."}

Regras específicas (quando houver anexos):
- Se houver descrição de lesão/ferida em "achados_exame_fisico" ou em "resumo_objetivo", preencher obrigatoriamente "Exame físico" e mencionar na "Queixa/História" quando pertinente.
- Em "Impressão diagnóstica/hipótese", usar "impressao_hipotese" como hipótese (não diagnóstico definitivo).
- Se o tipo for "Atestado médico" e houver achados em anexos compatíveis com lesão/condição, incluir motivo do afastamento de forma objetiva e coerente.
- Se houver exames em "exames_e_resultados", preencher "Exames complementares" com base neles.
- Nunca mencionar inteligência artificial, ferramentas, sistemas ou modelos.


Transcrição:
"""${safeTranscricao}"""
`;

  const data = await callOpenAIJson(prompt);

  const tipo_documento = (typeof data?.tipo_documento === "string" ? data.tipo_documento.trim() : "") || tipoFinal;
  const doenca_ou_queixa_principal = typeof data?.doenca_ou_queixa_principal === "string" ? data.doenca_ou_queixa_principal.trim() : "";
  const exames_mencionados = normalizeArrayOfStrings(data?.exames_mencionados, 40, 160);
  const campos_pendentes = normalizeArrayOfStrings(data?.campos_pendentes, 60, 180);
  const documento = typeof data?.documento === "string" ? data.documento.trim() : "";

  // Normaliza tipo para não sair fora dos permitidos (fallback seguro)
  const tipoOk = tiposPermitidos.includes(tipo_documento) ? tipo_documento : (tiposPermitidos.includes(tipoFinal) ? tipoFinal : "Outros");

  return {
    tipo_documento: tipoOk,
    doenca_ou_queixa_principal: doenca_ou_queixa_principal || "não informado",
    exames_mencionados,
    campos_pendentes,
    documento
  };
}

app.post("/api/gerar-documento-medico", requirePaidOrAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const transcricao = (typeof body.transcricao === "string" ? body.transcricao : (typeof body.texto === "string" ? body.texto : (typeof body.pedido === "string" ? body.pedido : "")));
    const tipo_documento = body.tipo_documento;
    const imagens = getImagesDataUrlFromBody(body).map(u => normalizeImageDataUrl(u, 2_400_000)).filter(Boolean).slice(0, 4);
    if ((!transcricao || !String(transcricao).trim()) && (!imagens || !imagens.length)) {
      return res.json({
        tipo_documento: "",
        doenca_ou_queixa_principal: "não informado",
        exames_mencionados: [],
        campos_pendentes: [],
        documento: ""
      });
    }

    const tipoSelecionado = (typeof tipo_documento === "string" && tipo_documento.trim()) ? tipo_documento.trim() : null;

    if (!process.env.OPENAI_API_KEY) {
      const tipoFallback = tipoSelecionado || inferMedicalDocumentTypeHeuristic(transcricao);
      return res.json({
        tipo_documento: tipoFallback,
        doenca_ou_queixa_principal: "não informado",
        exames_mencionados: [],
        campos_pendentes: [
          "Sem chave OPENAI_API_KEY configurada no servidor.",
          "Os anexos enviados não puderam ser analisados sem a chave configurada.",
          ...suggestMedicalDocumentQuestionsHeuristic(transcricao, tipoFallback)
        ].slice(0, 8),
        documento: ""
      });
    }

    let anexos = null;
    if (imagens && imagens.length) {
      try {
        anexos = await extractMedicalContextFromImages(imagens);
      } catch (e) {
        anexos = {
          tipo_anexo: "indefinido",
          resumo_objetivo: "",
          achados_exame_fisico: "",
          impressao_hipotese: "",
          exames_e_resultados: [],
          dados_identificacao: { nome: "", cpf: "", cns: "", data_documento: "" },
          limitacoes: ["Falha ao analisar anexos."]
        };
      }
    }

    const out = await generateMedicalDocumentFromTranscript(transcricao, tipoSelecionado, anexos);
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar documento médico." });
  }
});

// Guia em tempo real (tipo + até 5 perguntas) para documento médico durante a gravação

// ============================
// Educação em Saúde (Slides) - gera conteúdo e busca animações no IconScout
// ============================

function slugifyIconscoutTerm(term) {
  let s = String(term || "").trim().toLowerCase();
  try {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {}
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return s || "saude";
}

async function fetchTextWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(2000, timeoutMs | 0));
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; QueimadasTelemedicina/1.0; +https://reimed.netlify.app/)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractUniqueMatches(text, regex, limit = 20) {
  const out = [];
  const seen = new Set();
  if (!text) return out;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const v = String(m[0] || "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

async function iconscoutPickMediaForQuery(query, want = 2) {
  const q = String(query || "").trim();
  const slug = slugifyIconscoutTerm(q);

  const listingUrls = [
    "https://iconscout.com/pt/lottie-animations/" + slug,
    "https://iconscout.com/lottie-animations/" + slug,
  ];

  let listingHtml = null;
  for (const u of listingUrls) {
    listingHtml = await fetchTextWithTimeout(u, 12000);
    if (listingHtml) break;
  }
  if (!listingHtml) return [];

  const linkRe = /\/(?:pt\/)?lottie-animation\/[a-z0-9\-_]+/gi;
  const links = Array.from(new Set(extractUniqueMatches(listingHtml, linkRe, 10)))
    .map((p) => (p.startsWith("http") ? p : "https://iconscout.com" + p))
    .slice(0, 6);

  const results = [];

  for (const pageUrl of links) {
    if (results.length >= want) break;

    const pageHtml = await fetchTextWithTimeout(pageUrl, 12000);
    if (!pageHtml) continue;

    const mediaRe = /https?:\/\/[^"' \n\r\t\\]+?\.(?:gif|mp4|json|lottie|dotlottie)(?:\?[^"' \n\r\t\\]+)?/gi;
    const candidates = extractUniqueMatches(pageHtml, mediaRe, 80)
      .filter((u) => /iconscout|cdn/i.test(u));

    if (!candidates.length) continue;

    const pickGif = candidates.find((u) => /\.gif(\?|$)/i.test(u));
    const pickMp4 = candidates.find((u) => /\.mp4(\?|$)/i.test(u));
    const pickJson = candidates.find((u) => /\.json(\?|$)/i.test(u)) || candidates.find((u) => /\.(?:lottie|dotlottie)(\?|$)/i.test(u));
    const chosen = pickGif || pickMp4 || pickJson;

    if (!chosen) continue;

    const lower = chosen.toLowerCase();
    const media_type = lower.includes(".gif") ? "gif" : (lower.includes(".mp4") ? "mp4" : (lower.includes(".json") ? "json" : "lottie"));

    results.push({ source_page: pageUrl, media_url: chosen, media_type });
  }

  return results.slice(0, want);
}

app.post("/api/educacao-saude-slides", requirePaidOrAdmin, async (req, res) => {
  try {
    const tema = normalizeText(req.body?.tema || req.body?.tema_principal || "", 120);
    const nSlidesRaw = parseInt(String(req.body?.nSlides || req.body?.numSlides || 6), 10);
    const nSlides = Math.max(3, Math.min(12, isNaN(nSlidesRaw) ? 6 : nSlidesRaw));

    if (!tema) {
      return res.status(400).json({ error: "Tema inválido." });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "Sem chave OPENAI_API_KEY configurada no servidor." });
    }

    const prompt = `
Você é um médico e educador clínico.
Crie uma apresentação de educação em saúde para pacientes e acompanhantes.

Tema: "${tema}"
Número de slides: ${nSlides}

Regras:
- Retorne somente JSON estrito, sem markdown e sem texto fora do JSON.
- Não use emojis e não use símbolos gráficos.
- Linguagem clara, objetiva, adequada para público leigo, sem perder precisão.
- Cada slide deve ter:
  - titulo (curto, forte)
  - topicos (3 a 5 tópicos curtos e práticos)
  - resumo (1 parágrafo curto)
  - termo_busca (1 termo curto para buscar animação no IconScout; exemplo: "pressao arterial", "medicacao", "exercicio", "alimentacao", "vacina", "mosquito", etc.)

Formato esperado:
{
  "slides": [
    {
      "titulo": "",
      "topicos": ["", "", ""],
      "resumo": "",
      "termo_busca": ""
    }
  ]
}
`;

    const data = await callOpenAIJson(prompt);

    const slidesIn = Array.isArray(data?.slides) ? data.slides : [];
    const slidesNorm = slidesIn.slice(0, nSlides).map((s) => {
      const titulo = normalizeText(s?.titulo || "", 90);
      const resumo = normalizeText(s?.resumo || "", 600);
      const termo_busca = normalizeText(s?.termo_busca || "", 60);
      const topicos = normalizeArrayOfStrings(s?.topicos, 50, 120).slice(0, 7);
      return { titulo, topicos, resumo, termo_busca };
    }).filter((s) => s.titulo && s.topicos && s.topicos.length);

    for (const slide of slidesNorm) {
      const q1 = slide.termo_busca ? (tema + " " + slide.termo_busca) : (tema + " " + slide.titulo);
      const q2 = slide.titulo ? (tema + " " + slide.titulo) : tema;

      let midias = await iconscoutPickMediaForQuery(q1, 2);
      if (!midias || !midias.length) midias = await iconscoutPickMediaForQuery(q2, 2);
      if (!midias || !midias.length) midias = await iconscoutPickMediaForQuery(tema, 1);

      slide.midias = Array.isArray(midias) ? midias.slice(0, 2) : [];
    }

    return res.json({ tema, slides: slidesNorm });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar slides de educação em saúde." });
  }
});

app.post("/api/documento-medico-tempo-real", requirePaidOrAdmin, async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    const t = normalizeText(transcricao || "", 8000);
    const tipo = inferMedicalDocumentTypeHeuristic(t);
    const perguntas = suggestMedicalDocumentQuestionsHeuristic(t, tipo);
    // "gatilho": indica se há indício forte de solicitação de documento
    const gatilho = (tipo && tipo !== "Outros");
    return res.json({ tipo_documento: tipo, gatilho, perguntas });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna no guia em tempo real de documento médico." });
  }
});
// ======================================================================
// ROTA 6.1 – GUIA EM TEMPO REAL PARA DOCUMENTOS (TIPO + ATÉ 3 PERGUNTAS)
// ======================================================================

function inferDocumentTypeHeuristic(transcricao) {
  const t = String(transcricao || "").toLowerCase();
  if (!t) return "Outros";

  if (t.includes("ata") || t.includes("reunião") || t.includes("reuniao")) return "Ata de reunião";
  if (t.includes("comparecimento")) return "Declaração de comparecimento";
  if (t.includes("permanência") || t.includes("permanencia")) return "Declaração de permanência";
  if (t.includes("acompanhante")) return "Declaração para acompanhante";
  if (t.includes("curativo")) return "Relatório de curativo seriado";
  if (t.includes("visita domic") || t.includes("domicílio") || t.includes("domicilio")) return "Relatório de visita domiciliar";
  if (t.includes("caps") || t.includes("saúde mental") || t.includes("saude mental")) return "Relatório para CAPS / saúde mental (enfermagem)";
  if (t.includes("encaminh")) return "Encaminhamento para especialista / rede";
  if (t.includes("solicita") || t.includes("insumo") || t.includes("fralda") || t.includes("dieta") || t.includes("suplement")) return "Solicitação de insumos (fraldas, curativos, suplementos)";
  if (t.includes("escola")) return "Comunicado para escola";
  if (t.includes("conselho tutelar")) return "Comunicado ao Conselho Tutelar";
  if (t.includes("evolução") || t.includes("evolucao")) return "Relatório de evolução de enfermagem";
  return "Outros";
}

function suggestDocumentQuestionsHeuristic(transcricao, tipo) {
  // No máximo 3 perguntas práticas para completar o documento
  const q = [];
  const push = (s) => {
    const v = String(s || "").trim();
    if (!v) return;
    if (q.some(x => x.toLowerCase() === v.toLowerCase())) return;
    if (q.length < 3) q.push(v);
  };

  push("Qual a Unidade/Serviço e Município/UF?");
  push("Qual o nome completo do paciente e pelo menos um identificador (CPF ou CNS)?");
  if (String(tipo || "").toLowerCase().includes("comparecimento") || String(tipo || "").toLowerCase().includes("perman")) {
    push("Qual a data e o horário de início e término do atendimento/permanência?");
  } else if (String(tipo || "").toLowerCase().includes("encaminh")) {
    push("Para qual serviço/profissional é o encaminhamento e qual o motivo principal?");
  } else if (String(tipo || "").toLowerCase().includes("curativo")) {
    push("Qual o local da lesão, materiais utilizados e conduta/orientações de curativo?");
  } else if (String(tipo || "").toLowerCase().includes("ata")) {
    push("Qual a data/horário da reunião, pauta e participantes?");
  } else {
    push("Qual a finalidade/destino do documento (para quem/onde será apresentado)?");
  }

  return q.slice(0, 3);
}

async function generateDocumentLiveGuide(transcricao) {
  const safeTranscricao = normalizeText(transcricao || "", 12000);
  if (!safeTranscricao || safeTranscricao.length < 20) {
    return { tipo_documento: "", perguntas: [] };
  }

  // Com API Key, tenta uma inferência melhor
  if (process.env.OPENAI_API_KEY) {
    const prompt = `
Você está auxiliando um enfermeiro a redigir um documento a partir de uma transcrição.
Tarefa: identificar o tipo de documento mais provável e sugerir no máximo 3 perguntas essenciais (curtas e objetivas) para completar o documento.
Regras:
- Não invente dados.
- Não use emojis.
- As perguntas são apenas para guiar o profissional, não são obrigatórias.

Retorne JSON estrito no formato:
{
  "tipo_documento": "string",
  "perguntas": ["...", "...", "..."]
}

Transcrição (trecho):
"""${safeTranscricao}"""
`;
    const data = await callOpenAIJson(prompt);
    const tipo = typeof data?.tipo_documento === "string" ? data.tipo_documento.trim() : "";
    const perguntas = Array.isArray(data?.perguntas) ? data.perguntas : (Array.isArray(data?.perguntas_sugeridas) ? data.perguntas_sugeridas : []);
    const outPerg = normalizeArrayOfStrings(perguntas, 3, 220);
    return { tipo_documento: tipo || inferDocumentTypeHeuristic(safeTranscricao), perguntas: outPerg.slice(0, 3) };
  }

  const tipo = inferDocumentTypeHeuristic(safeTranscricao);
  const perguntas = suggestDocumentQuestionsHeuristic(safeTranscricao, tipo);
  return { tipo_documento: tipo, perguntas };
}

app.post("/api/documento-tempo-real", requirePaidOrAdmin, async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    const out = await generateDocumentLiveGuide(transcricao);
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna no guia em tempo real de documentos." });
  }
});

// Alias
app.post("/api/guia-documento-tempo-real", requirePaidOrAdmin, async (req, res) => {
  try {
    const { transcricao } = req.body || {};
    const out = await generateDocumentLiveGuide(transcricao);
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna no guia em tempo real de documentos." });
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



function heuristicHandoffItems(transcricao) {
  const t = String(transcricao || "").toLowerCase();
  const q = [];
  const push = (s) => {
    const x = String(s || "").trim();
    if (!x) return;
    if (!q.some(a => a.toLowerCase() === x.toLowerCase())) q.push(x);
  };

  // S: Situação
  const hasId = (t.includes("leito") || t.includes("box") || t.includes("enfermaria") || t.includes("prontu") || t.includes("nome") || t.includes("idade"));
  if (!hasId) push("Identificar paciente: nome completo, idade e leito/box (ou prontuário).");

  const hasSituation = (t.includes("intern") || t.includes("motivo") || t.includes("quadro") || t.includes("diagn") || t.includes("situa") || t.includes("admiss") || t.includes("hoje"));
  if (!hasSituation) push("Situação (S): motivo da internação/atendimento e estado atual em uma frase (estável/instável).");

  // B: Background
  const hasComorb = (t.includes("hiperten") || t.includes("diabet") || t.includes("dpo") || t.includes("asma") || t.includes("cardio") || t.includes("renal") || t.includes("hepát") || t.includes("avc") || t.includes("iam") || t.includes("cânc") || t.includes("imunoss"));
  const hasAllergy = (t.includes("alerg") || t.includes("reaç"));
  const hasMeds = (t.includes("medica") || t.includes("antib") || t.includes("anticoag") || t.includes("hepar") || t.includes("insulin") || t.includes("vasopress") || t.includes("sed") || t.includes("analg"));
  if (!hasComorb) push("Background (B): comorbidades relevantes e antecedentes que mudam conduta.");
  if (!hasAllergy) push("Background (B): alergias e reações prévias importantes.");
  if (!hasMeds) push("Background (B): medicações críticas em uso e próximos horários.");

  // A: Avaliação
  const hasVitals = (t.includes("pa") || t.includes("press") || t.includes("fc") || t.includes("frequ") || t.includes("fr") || t.includes("spo2") || t.includes("satura") || t.includes("temp"));
  const hasDevices = (t.includes("acesso") || t.includes("cateter") || t.includes("sonda") || t.includes("sng") || t.includes("sne") || t.includes("dreno") || t.includes("curat") || t.includes("oxig") || t.includes("ventil"));
  const hasLabs = (t.includes("exame") || t.includes("labor") || t.includes("rx") || t.includes("tc") || t.includes("usg") || t.includes("gasom") || t.includes("hemog") || t.includes("lactato") || t.includes("eletr"));
  if (!hasVitals) push("Avaliação (A): últimos sinais vitais e tendência (piora/melhora) + nível de consciência.");
  if (!hasDevices) push("Avaliação (A): dispositivos/terapias em curso (O2, acessos, sondas, drenos, bombas).");
  if (!hasLabs) push("Avaliação (A): principais exames relevantes e pendências (coletados/aguardando).");

  // R: Recomendação
  const hasPlan = (t.includes("conduta") || t.includes("plano") || t.includes("pendên") || t.includes("manter") || t.includes("ajust") || t.includes("reavali") || t.includes("se") || t.includes("caso"));
  if (!hasPlan) push("Recomendação (R): pendências e próximas ações (medicações, reavaliações, exames, metas e quando acionar o médico).");

  const contexto = "SBAR";
  const hipotese = "";

  return { contexto, hipotese, sugestoes: q.slice(0, 6) };
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

    // Importante: as flags de modo precisam existir antes de qualquer uso (evita ReferenceError do "isHandoff")
    const modo = String(body.modo || "").trim().toLowerCase();
    const isTriage = (modo === "triagem_hospitalar" || modo === "triagem" || modo === "hospital_triage" || modo === "triagem_hospital");
    const isHandoff = (modo === "passagem_plantao" || modo === "passagem" || modo === "handoff" || modo === "sbar");

    if (estado === "aguardando_motivo" && !isHandoff) {
      return res.json({ contexto: "", hipotese_principal: "", confianca: 0, perguntas: [] });
    }

    const transcricao = normalizeText(body.transcricao || legacyTrans || "", 12000);
    if (!transcricao || transcricao.length < 20) {
      if (isHandoff) {
        const h = heuristicHandoffItems(transcricao || "");
        const defaults = Array.isArray(h?.sugestoes) ? h.sugestoes.slice(0, 3) : [];
        return res.json({ contexto: h?.contexto || "SBAR", hipotese_principal: "", confianca: 0, perguntas: defaults });
      }
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
            const promptConsulta = `
Você está auxiliando um enfermeiro durante uma consulta.
Objetivo: sugerir no máximo 3 itens essenciais por vez (perguntas e/ou procedimentos) para orientar a avaliação com eficiência e segurança.
Regras:
- Não dê diagnóstico final, apenas hipótese principal.
- Não escreva emojis.
- Itens devem ser curtos, objetivos e executáveis.
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
	      const promptHandoff = `
Você está auxiliando um profissional de saúde a elaborar uma passagem de plantão (handoff) usando o modelo SBAR.
Objetivo: sugerir no máximo 3 itens essenciais por vez (tópicos a mencionar) para completar uma passagem segura, objetiva e útil nas próximas horas.
Regras:
- Não invente dados. Se faltar informação, sugira como registrar/checar.
- Não escreva emojis.
- Itens devem ser curtos, objetivos e executáveis.
- Priorize riscos imediatos, pendências, dispositivos/terapias em curso, alergias e limiares de alerta.
- Use o contexto do que já foi dito; não repita itens já cobertos.
- Se for evento "stream" ou "resposta", atualize os próximos itens com base na última fala.

Retorne JSON estrito no formato:
{
  "contexto": "texto curto",
  "hipotese_principal": "foco/estado atual (não diagnóstico definitivo)",
  "confianca": 0,
  "perguntas_sugeridas": ["item 1", "item 2", "item 3"]
}

Dados atuais:
- Estado: ${estado}
- Evento: ${evento}
- Foco atual: ${hipoteseAtual || "não informado"}
- Confiança atual: ${confiancaAtual}
- Item executado (se houver): ${perguntaFeita || "nenhum"}
- Itens pendentes (se houver): ${(pendentes && pendentes.length) ? pendentes.join(" | ") : "nenhum"}
- Última fala (se houver): ${ultimaFala || "nenhuma"}

Transcrição (trecho):
"""${transcricao}"""
`;

      const prompt = isHandoff ? promptHandoff : (isTriage ? promptTriage : promptConsulta);
      const data = await callOpenAIJson(prompt);
      contexto = typeof data?.contexto === "string" ? data.contexto.trim() : "";
      hipotese = typeof data?.hipotese_principal === "string" ? data.hipotese_principal.trim() : "";
      confianca = clampNumber(data?.confianca, 0, 95);
      sugestoes = Array.isArray(data?.perguntas_sugeridas) ? data.perguntas_sugeridas : [];
    } else {
      const h = isHandoff ? heuristicHandoffItems(transcricao) : heuristicQuestions(transcricao, isTriage);
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
