# PWA AI Coach Backend

Production-shaped Fastify API for the AI Health Coach PWA.

## Stack

- Fastify + TypeScript
- Prisma + SQLite
- Email/password auth with JWT access token and httpOnly refresh cookie
- Multipart file upload for lab photos/documents
- OpenAI Responses API adapter with hosted file search/vector store support

## Run

```bash
cp .env.example .env
pnpm install
pnpm prisma generate
pnpm prisma db push
pnpm run seed
pnpm run dev
```

Seeded login:

```text
demo@ai-coach.local / demo-password
```

## OpenAI

Set these in `.env` for real model/RAG calls:

```env
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-5.5"
OPENAI_VECTOR_STORE_IDS="vs_..."
```

Without an API key, the service uses a safe local fallback while preserving the production response contract.

## CI/CD

Workflow: [`.github/workflows/backend-ci-cd.yml`](./.github/workflows/backend-ci-cd.yml) в корне **этого** репозитория.

Только **CI**: установка зависимостей, `prisma generate`, миграции на SQLite `test.db`, `pnpm build`, `pnpm test`. Деплой — через **Railway**. Шаблон: [`split-repo-workflows/backend-ci-cd.yml`](../split-repo-workflows/backend-ci-cd.yml). Детали: [`../DEPLOYMENT.md`](../DEPLOYMENT.md).
