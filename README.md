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

## Docker / Cloud Run

Контейнер теперь сам:

- поднимает SQLite в writable runtime-пути;
- применяет `prisma migrate deploy`;
- запускает сиды;
- стартует API на `PORT` из Cloud Run.

Сборка:

```bash
docker build -t pwa-ai-coach-back ./PWA_AI_COACH_BACK
```

Локальный запуск контейнера:

```bash
docker run --rm -p 8080:8080 \
  -e WEB_ORIGIN=http://localhost:5173 \
  -e JWT_SECRET=replace-with-a-long-secret \
  -e OPENAI_API_KEY=sk-... \
  pwa-ai-coach-back
```

По умолчанию контейнер использует:

```env
DATABASE_URL=file:/tmp/pwa-ai-coach.db
UPLOAD_DIR=/tmp/uploads
PORT=8080
```

Важно: в Cloud Run `SQLite` и `UPLOAD_DIR` будут эфемерными. После рестарта инстанса, нового деплоя или масштабирования данные могут пропасть. Для постоянного хранения в проде лучше перейти на Cloud SQL / внешний storage.

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
