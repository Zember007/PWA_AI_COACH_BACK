FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV PORT=8080
ENV DATABASE_URL="file:/tmp/pwa-ai-coach.db"
ENV UPLOAD_DIR="/tmp/uploads"
ENV PRISMA_HIDE_UPDATE_MESSAGE=true

RUN corepack enable

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod=false

RUN pnpm prisma generate

COPY tsconfig.json ./
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh \
  && pnpm build

EXPOSE 8080

CMD ["./docker-entrypoint.sh"]
