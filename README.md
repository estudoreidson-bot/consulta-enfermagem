# Queimadas Telemedicina – Gerador de PPTX (Educação em Saúde)

Este repositório contém:
- `frontend/` (HTML) – interface (Pages/Cloudflare Pages/Netlify)
- `backend/` (Node/Express) – API que gera PPTX usando `pptxgenjs`

## Como rodar localmente (teste rápido)
1) Backend
```bash
cd backend
cp .env.example .env
# Preencha as variáveis no .env
npm install
npm start
```

2) Frontend
- Abra `frontend/index.html` no navegador, ou sirva com qualquer servidor estático.

## Deploy recomendado
- Frontend: Cloudflare Pages (pasta `frontend/`)
- Backend: Render/Replit/Railway (pasta `backend/`)

### Observação importante sobre o `package-lock.json`
Para o deploy ser reproduzível, gere e faça commit do lockfile:
```bash
cd backend
npm install
git add package-lock.json
git commit -m "Add lockfile"
```

## Segurança
Não versionar `.env` nem chaves. Use variáveis do ambiente no provedor.
