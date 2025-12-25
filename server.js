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

// Pequena validação para limitar tamanho e evitar abusos
function normalizeText(input, maxLen) {
  const s = (typeof input === "string" ? input : "").trim();
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
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
// ROTA 4.1 – TIPO DE RECEITUÁRIO POR MEDICAMENTO (NOVA)
// ======================================================================

app.post("/api/tipo-receituario", async (req, res) => {
  try {
    const { contexto } = req.body || {};
    if (!contexto || !String(contexto).trim()) {
      return res.json({ checklist: "" });
    }

    const safeContexto = normalizeText(contexto, 25000);

    const prompt = `
Você é um enfermeiro humano. Gere um CHECKLIST DE SEGURANÇA DO PACIENTE adequado ao caso (para atendimento e/ou procedimento e/ou administração de medicamentos).

Inclua itens quando aplicáveis:
- Identificação do paciente.
- Alergias e riscos.
- Sinais vitais e reavaliação.
- Materiais e técnica do procedimento.
- Consentimento quando aplicável.
- Registro de intercorrências e conduta.
- Critérios para escalar ao médico.

Regras:
- Sem emojis e sem símbolos gráficos.
- Seja objetivo.

Formato de saída: JSON estrito:
{ "checklist": "..." }

Contexto:
"""${safeContexto}"""
`;

    const data = await callOpenAIJson(prompt);
    const checklist = typeof data?.checklist === "string" ? data.checklist.trim() : "";
    return res.json({ checklist });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Falha interna ao gerar checklist." });
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
    const { transcricao, finalidade, destinatario } = req.body || {};

    if (!transcricao || !String(transcricao).trim()) {
      return res.json({ relatorio: "" });
    }

    const safeTranscricao = normalizeText(transcricao, 25000);
    const safeFinalidade = normalizeText(finalidade || "", 300);
    const safeDestinatario = normalizeText(destinatario || "", 200);

    const prompt = `
Você é um enfermeiro humano redigindo um relatório/declaração de enfermagem com base na transcrição do atendimento.

Regras:
- Português do Brasil.
- Sem emojis e sem símbolos gráficos.
- Não invente dados.
- Não faça diagnóstico médico definitivo.
- Estrutura clara e curta, pronta para imprimir.

Formato de saída: JSON estrito:
{ "relatorio": "..." }

Dados adicionais:
Finalidade: "${safeFinalidade}"
Destinatário: "${safeDestinatario}"

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
