// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
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
// ROTA 4.6 – EXTRAÇÃO DE MEDICAMENTOS CITADOS (TEXTO) (NOVA)
// ======================================================================

function normalizeMedicationNameServer(s) {
  const t = (typeof s === "string" ? s : "").trim();
  if (!t) return "";
  return t.replace(/\s+/g, " ").replace(/[;,.]+$/g, "").trim();
}

function uniqueMedicationListServer(arr, maxItems = 60) {
  const a = Array.isArray(arr) ? arr : [];
  const out = [];
  const seen = new Set();
  for (const v of a) {
    const n = normalizeMedicationNameServer(v);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= maxItems) break;
  }
  return out;
}

async function extrairMedicamentosPorTexto(contexto) {
  const c = String(contexto || "").trim();
  if (!c) return [];

  const safe = normalizeText(c, 25000);

  const prompt = `
Você é um enfermeiro humano.
Tarefa: extrair SOMENTE nomes de medicamentos citados no texto (medicamentos prescritos, medicamentos em uso contínuo, fitoterápicos/suplementos e vacinas se mencionadas como medicamento).
Regras:
- Não invente. Extraia apenas o que está explicitamente escrito.
- Não inclua doenças, sintomas, diagnósticos, exames, procedimentos, alimentos, ou "soro", "oxigênio" etc.
- Se houver dose/concentração junto do nome, mantenha apenas o NOME do medicamento (ex.: "dipirona 500 mg" -> "dipirona").
- Use preferencialmente o nome genérico quando for claramente identificado; se não, mantenha o nome comercial mencionado.
- Retorne no máximo 60 itens.
Formato de saída: JSON estrito:
{ "medicamentos": ["..."] }

Texto:
\"\"\"${safe}\"\"\"
`;
  const data = await callOpenAIJson(prompt);
  return uniqueMedicationListServer(data?.medicamentos, 60);
}

app.post("/api/extrair-medicamentos", async (req, res) => {
  try {
    const { contexto } = req.body || {};
    const meds = await extrairMedicamentosPorTexto(contexto || "");
    return res.json({ medicamentos: meds });
  } catch (e) {
    console.error(e);
    return res.json({ medicamentos: [] });
  }
});


// ======================================================================
// ROTA 4.7 – EXTRAÇÃO DE MEDICAMENTOS POR IMAGEM (NOVA)
// ======================================================================

async function extrairMedicamentosPorImagem(imagemDataUrl) {
  const safeImage = normalizeImageDataUrl(imagemDataUrl, 4_000_000);
  if (!safeImage) return [];

  const prompt = `
Você é um enfermeiro humano.
Tarefa: olhar a foto e listar SOMENTE os NOMES dos medicamentos que estiverem legíveis.
Regras:
- Não invente: se estiver ilegível, ignore.
- Não inclua dose/posologia; extraia apenas o nome.
- Retorne no máximo 60 itens.
Formato de saída: JSON estrito:
{ "medicamentos": ["..."] }
`;
  const data = await callOpenAIVisionJson(prompt, safeImage);
  return uniqueMedicationListServer(data?.medicamentos, 60);
}


// ======================================================================
// ROTA 4.8 – USO NA GRAVIDEZ (NOVA)
// ======================================================================

async function avaliarUsoGravidez(medicamentos, contexto) {
  const meds = uniqueMedicationListServer(medicamentos, 60);
  if (!meds.length) return { texto: "", medicamentos: [] };

  const safeContexto = normalizeText(contexto || "", 25000);

  const prompt = `
Você é um enfermeiro humano auxiliando a equipe na checagem de SEGURANÇA MEDICAMENTOSA PARA GESTAÇÃO.
A partir da lista de medicamentos, informe para CADA medicamento:
- Categoria de risco na gestação no formato A/B/C/D/X quando houver referência clássica; se não houver base suficiente, usar "não informado".
- Orientação prática e prudente (por exemplo: "pode usar", "evitar", "usar com cautela e supervisão médica", "contraindicado", "avaliar risco-benefício").
- Principais riscos ou pontos de atenção (teratogenicidade, toxicidade fetal, restrição de crescimento, fechamento do ducto, sangramento, etc) quando aplicável.
Regras obrigatórias:
- Não invente categoria ou risco. Se não souber, escreva "não informado".
- Não prescreva e não mude conduta médica. Apenas sinalize segurança e necessidade de confirmação.
- Sem emojis e sem símbolos gráficos.
Formato de saída: JSON estrito:
{
  "itens": [
    {
      "medicamento": "string",
      "categoria_gestacao": "A|B|C|D|X|não informado",
      "orientacao": "string",
      "pontos_atencao": "string",
      "observacoes": "string"
    }
  ],
  "alerta_geral": "string"
}

Medicamentos:
${meds.map((m) => "- " + m).join("\n")}

Contexto adicional (pode estar vazio):
\"\"\"${safeContexto}\"\"\"
`;
  const data = await callOpenAIJson(prompt);

  const itens = Array.isArray(data?.itens) ? data.itens : [];
  const alerta = typeof data?.alerta_geral === "string" ? data.alerta_geral.trim() : "";

  const lines = [];
  lines.push("Uso na gravidez (checagem de segurança):");
  lines.push("Medicamentos considerados: " + meds.join(", "));
  lines.push("");

  let i = 1;
  for (const it of itens.slice(0, 60)) {
    const nome = normalizeMedicationNameServer(it?.medicamento || "") || "não informado";
    const cat = normalizeMedicationNameServer(it?.categoria_gestacao || "") || "não informado";
    const ori = normalizeText(it?.orientacao || "", 400) || "não informado";
    const pts = normalizeText(it?.pontos_atencao || "", 450) || "não informado";
    const obs = normalizeText(it?.observacoes || "", 450) || "";

    lines.push(`${i}) ${nome}`);
    lines.push(`Categoria na gestação: ${cat}`);
    lines.push(`Orientação: ${ori}`);
    lines.push(`Pontos de atenção: ${pts}`);
    if (obs) lines.push(`Observações: ${obs}`);
    lines.push("");
    i += 1;
  }

  if (alerta) {
    lines.push("Alerta geral:");
    lines.push(alerta);
  } else {
    lines.push("Alerta geral:");
    lines.push("Confirmar em protocolo/bula e com o prescritor quando houver dúvida, principalmente no primeiro trimestre, em comorbidades, e quando houver polifarmácia.");
  }

  return { texto: lines.join("\n").trim(), medicamentos: meds };
}

app.post("/api/uso-gravidez", async (req, res) => {
  try {
    const { medicamentos, contexto } = req.body || {};
    const meds = uniqueMedicationListServer(medicamentos, 60);
    if (!meds.length && contexto) {
      const fromText = await extrairMedicamentosPorTexto(contexto);
      const out = await avaliarUsoGravidez(fromText, contexto);
      return res.json(out);
    }
    const out = await avaliarUsoGravidez(meds, contexto || "");
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar uso na gravidez." });
  }
});

app.post("/api/uso-gravidez-imagem", async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const meds = await extrairMedicamentosPorImagem(imagemDataUrl);
    if (!meds.length) return res.json({ texto: "Nenhum medicamento legível foi identificado na imagem.", medicamentos: [] });
    const out = await avaliarUsoGravidez(meds, "");
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar uso na gravidez por imagem." });
  }
});


// ======================================================================
// ROTA 4.9 – USO NA LACTAÇÃO (NOVA)
// ======================================================================

async function avaliarUsoLactacao(medicamentos, contexto) {
  const meds = uniqueMedicationListServer(medicamentos, 60);
  if (!meds.length) return { texto: "", medicamentos: [] };

  const safeContexto = normalizeText(contexto || "", 25000);

  const prompt = `
Você é um enfermeiro humano auxiliando a equipe na checagem de SEGURANÇA MEDICAMENTOSA PARA LACTAÇÃO.
A partir da lista de medicamentos, informe para CADA medicamento:
- Classificação de risco na lactação quando disponível (por exemplo: Hale L1-L5). Se não houver base suficiente, usar "não informado".
- Orientação prática e prudente (por exemplo: compatível, usar com cautela, evitar, contraindicado), incluindo sugestão de conduta segura (monitorar lactente, ajustar horário, observar sedação, etc) quando aplicável.
- Principais riscos para o lactente e para a lactação (sedação, irritabilidade, diarreia, supressão da lactação, etc) quando aplicável.
Regras obrigatórias:
- Não invente classificação ou risco. Se não souber, escreva "não informado".
- Não prescreva e não mude conduta médica. Apenas sinalize segurança e necessidade de confirmação.
- Sem emojis e sem símbolos gráficos.
Formato de saída: JSON estrito:
{
  "itens": [
    {
      "medicamento": "string",
      "classificacao_lactacao": "string",
      "orientacao": "string",
      "riscos_lactente": "string",
      "observacoes": "string"
    }
  ],
  "alerta_geral": "string"
}

Medicamentos:
${meds.map((m) => "- " + m).join("\n")}

Contexto adicional (pode estar vazio):
\"\"\"${safeContexto}\"\"\"
`;
  const data = await callOpenAIJson(prompt);

  const itens = Array.isArray(data?.itens) ? data.itens : [];
  const alerta = typeof data?.alerta_geral === "string" ? data.alerta_geral.trim() : "";

  const lines = [];
  lines.push("Uso na lactação (checagem de segurança):");
  lines.push("Medicamentos considerados: " + meds.join(", "));
  lines.push("");

  let i = 1;
  for (const it of itens.slice(0, 60)) {
    const nome = normalizeMedicationNameServer(it?.medicamento || "") || "não informado";
    const cls = normalizeText(it?.classificacao_lactacao || "", 60) || "não informado";
    const ori = normalizeText(it?.orientacao || "", 420) || "não informado";
    const ris = normalizeText(it?.riscos_lactente || "", 450) || "não informado";
    const obs = normalizeText(it?.observacoes || "", 450) || "";

    lines.push(`${i}) ${nome}`);
    lines.push(`Classificação na lactação: ${cls}`);
    lines.push(`Orientação: ${ori}`);
    lines.push(`Riscos para o lactente: ${ris}`);
    if (obs) lines.push(`Observações: ${obs}`);
    lines.push("");
    i += 1;
  }

  if (alerta) {
    lines.push("Alerta geral:");
    lines.push(alerta);
  } else {
    lines.push("Alerta geral:");
    lines.push("Confirmar em protocolo/bula e com o prescritor quando houver dúvida, especialmente em prematuros, recém-nascidos e quando houver uso de múltiplos medicamentos.");
  }

  return { texto: lines.join("\n").trim(), medicamentos: meds };
}

app.post("/api/uso-lactacao", async (req, res) => {
  try {
    const { medicamentos, contexto } = req.body || {};
    const meds = uniqueMedicationListServer(medicamentos, 60);
    if (!meds.length && contexto) {
      const fromText = await extrairMedicamentosPorTexto(contexto);
      const out = await avaliarUsoLactacao(fromText, contexto);
      return res.json(out);
    }
    const out = await avaliarUsoLactacao(meds, contexto || "");
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar uso na lactação." });
  }
});

app.post("/api/uso-lactacao-imagem", async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const meds = await extrairMedicamentosPorImagem(imagemDataUrl);
    if (!meds.length) return res.json({ texto: "Nenhum medicamento legível foi identificado na imagem.", medicamentos: [] });
    const out = await avaliarUsoLactacao(meds, "");
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar uso na lactação por imagem." });
  }
});


// ======================================================================
// ROTA 4.10 – INTERAÇÕES MEDICAMENTOSAS (NOVA)
// ======================================================================

async function avaliarInteracoes(medicamentos, contexto) {
  const meds = uniqueMedicationListServer(medicamentos, 60);
  if (meds.length < 2) return { texto: "", medicamentos: meds };

  const safeContexto = normalizeText(contexto || "", 25000);

  const prompt = `
Você é um enfermeiro humano auxiliando a equipe na checagem de INTERAÇÕES MEDICAMENTOSAS clinicamente relevantes.
A partir da lista de medicamentos, avalie interações potenciais e apresente somente o que for relevante.
Para cada interação relevante, informe:
- Par de medicamentos (A + B)
- Gravidade: Contraindicada, Alta, Moderada, Baixa, ou "não informado" se não houver base suficiente
- Descrição breve do risco
- Conduta prática (evitar associação, monitorar, ajustar horários, observar sinais, solicitar avaliação médica, etc)

Regras obrigatórias:
- Não invente interações. Se não houver base, use "não informado".
- Não prescreva e não mude conduta médica. Apenas sinalize segurança e necessidade de confirmação.
- Sem emojis e sem símbolos gráficos.
Formato de saída: JSON estrito:
{
  "interacoes": [
    {
      "par": "string",
      "gravidade": "string",
      "descricao": "string",
      "conduta": "string"
    }
  ],
  "observacoes_gerais": "string"
}

Medicamentos:
${meds.map((m) => "- " + m).join("\n")}

Contexto adicional (pode estar vazio):
\"\"\"${safeContexto}\"\"\"
`;
  const data = await callOpenAIJson(prompt);

  const interacoes = Array.isArray(data?.interacoes) ? data.interacoes : [];
  const obs = typeof data?.observacoes_gerais === "string" ? data.observacoes_gerais.trim() : "";

  const lines = [];
  lines.push("Interações medicamentosas (checagem de segurança):");
  lines.push("Medicamentos considerados: " + meds.join(", "));
  lines.push("");

  if (!interacoes.length) {
    lines.push("Não foi possível confirmar interações relevantes a partir dos dados informados.");
  } else {
    let i = 1;
    for (const it of interacoes.slice(0, 80)) {
      const par = normalizeText(it?.par || "", 120) || "não informado";
      const gra = normalizeText(it?.gravidade || "", 40) || "não informado";
      const des = normalizeText(it?.descricao || "", 520) || "não informado";
      const con = normalizeText(it?.conduta || "", 520) || "não informado";

      lines.push(`${i}) ${par}`);
      lines.push(`Gravidade: ${gra}`);
      lines.push(`Risco: ${des}`);
      lines.push(`Conduta: ${con}`);
      lines.push("");
      i += 1;
    }
  }

  if (obs) {
    lines.push("Observações gerais:");
    lines.push(obs);
  } else {
    lines.push("Observações gerais:");
    lines.push("Confirmar em protocolo/bula e com o prescritor quando houver polifarmácia, comorbidades, idosos, insuficiência renal/hepática, ou quando houver sintomas após iniciar a associação.");
  }

  return { texto: lines.join("\n").trim(), medicamentos: meds };
}

app.post("/api/interacoes", async (req, res) => {
  try {
    const { medicamentos, contexto } = req.body || {};
    const meds = uniqueMedicationListServer(medicamentos, 60);
    if (meds.length < 2 && contexto) {
      const fromText = await extrairMedicamentosPorTexto(contexto);
      const out = await avaliarInteracoes(fromText, contexto);
      return res.json(out);
    }
    const out = await avaliarInteracoes(meds, contexto || "");
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar interações medicamentosas." });
  }
});

app.post("/api/interacoes-imagem", async (req, res) => {
  try {
    const imagemDataUrl = getImageDataUrlFromBody(req.body);
    const meds = await extrairMedicamentosPorImagem(imagemDataUrl);
    if (meds.length < 2) {
      return res.json({
        texto: meds.length
          ? "Apenas um medicamento legível foi identificado na imagem. Interações exigem pelo menos dois medicamentos."
          : "Nenhum medicamento legível foi identificado na imagem.",
        medicamentos: meds
      });
    }
    const out = await avaliarInteracoes(meds, "");
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao avaliar interações por imagem." });
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
// INICIALIZAÇÃO DO SERVIDOR
// ======================================================================

app.listen(port, () => {
  console.log(`Servidor escutando na porta ${port}`);
});
