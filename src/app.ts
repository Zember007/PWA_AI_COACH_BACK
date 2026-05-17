import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import type { MultipartFile } from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import { config } from "./config.js";
import { foodItems } from "./data/mock.js";
import { prisma, readJson, writeJson } from "./db.js";
import { clearRefreshCookie, hashPassword, hashToken, issueRefreshToken, requireAuth, setRefreshCookie, signAccessToken, verifyPassword } from "./auth.js";
import { buildInsight, getUserContext, persistParsedLabs, profileToCreate, recommendProducts, recommendProductsForChat, serializeContent, serializeFoodLog, serializeLab, serializeProduct, serializeProfile } from "./services/domain.js";
import { AgentUnavailableError, analyzeFoodPhoto, analyzeLabFile, createAgentResponse, createAgentResponseStream, extractFileText, isVisionMime, uploadLabsToVectorStore, type AgentCitation, type FoodPhotoAnalysisResult, type LabAnalysisResult, type LabVectorStoreResult } from "./services/ai.js";

const authBody = z.object({ email: z.string().email(), password: z.string().min(8) });
const changePasswordBody = z.object({ currentPassword: z.string().min(8), newPassword: z.string().min(8) });
const profileBody = z.object({
  name: z.string().min(1),
  age: z.number().int().min(1).max(120),
  sex: z.string(),
  height: z.number().int().min(60).max(240),
  weight: z.number().int().min(25).max(350),
  goal: z.string(),
  activityLevel: z.string(),
  wellbeing: z.string(),
  dietRestrictions: z.array(z.string()),
  allergies: z.array(z.string()),
  currentSupplements: z.array(z.string()),
  symptoms: z.array(z.string()),
  medicalConsent: z.boolean()
});

function userId(request: unknown) {
  return (request as { userId: string }).userId;
}

function isDevelopmentOrigin(origin: string) {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "0.0.0.0" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }

    const ipVersion = net.isIP(hostname);
    if (ipVersion === 4) {
      const [first = 0, second = 0] = hostname.split(".").map(Number);
      return (
        first === 10 ||
        first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 169 && second === 254)
      );
    }

    return hostname.endsWith(".local");
  } catch {
    return false;
  }
}

function resolveCorsOrigin(origin: string | undefined) {
  if (!origin) {
    return true;
  }
  if (config.webOrigins.includes(origin)) {
    return origin;
  }
  if (process.env.NODE_ENV !== "production" && isDevelopmentOrigin(origin)) {
    return origin;
  }
  return false;
}

function corsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean | string | RegExp) => void
) {
  cb(null, resolveCorsOrigin(origin));
}

function corsHeadersForOrigin(origin: string | undefined) {
  const allowed = resolveCorsOrigin(origin);
  if (!origin || allowed === false) return {};
  return {
    "Access-Control-Allow-Origin": allowed === true ? origin : allowed,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin"
  };
}

function multipartFieldValue(fields: Record<string, unknown>, name: string) {
  const field = fields[name];
  const item = Array.isArray(field) ? field[0] : field;
  if (!item || typeof item !== "object" || !("value" in item)) return "";
  const value = (item as { value?: unknown }).value;
  return typeof value === "string" ? value.trim() : "";
}

function shouldAnalyzeFoodPhoto(mimeType: string, message: string, intent: string) {
  if (!isVisionMime(mimeType)) return false;
  if (intent === "food") return true;
  const normalized = message.toLowerCase();
  return /еда|еду|блюд|тарел|калор|ккал|грам|пищ|продукт|прием пищи|приём пищи|дневник/.test(normalized);
}

async function storeMultipartFile(file: MultipartFile) {
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedPath = path.join(config.UPLOAD_DIR, `${Date.now()}-${safeName}`);
  await pipeline(file.file, fs.createWriteStream(storedPath));
  return {
    storedPath,
    size: fs.statSync(storedPath).size
  };
}

async function analyzeAndPersistFoodPhoto(input: {
  userId: string;
  storedPath: string;
  mimeType: string;
  filename: string;
  uploadId?: string;
  log: { warn: (payload: unknown, message: string) => void };
}) {
  let analysis: FoodPhotoAnalysisResult;
  try {
    analysis = await analyzeFoodPhoto(input.storedPath, input.mimeType, input.filename);
  } catch (error) {
    input.log.warn({ err: error, uploadId: input.uploadId, mimeType: input.mimeType }, "Food photo analysis failed");
    analysis = {
      status: "needs_review",
      items: [],
      explanation: "Фото загружено, но сейчас не удалось надежно оценить блюдо. Попробуйте более четкое фото сверху или добавьте продукт вручную.",
      citations: []
    };
  }

  const entries = await Promise.all(
    analysis.items.map((item) =>
      prisma.foodLog.create({
        data: {
          userId: input.userId,
          foodName: item.name,
          grams: item.grams,
          calories: item.calories,
          protein: item.protein,
          fat: item.fat,
          carbs: item.carbs,
          source: "ai_photo",
          confidence: item.confidence,
          notes: item.notes,
          uploadId: input.uploadId
        }
      })
    )
  );

  return {
    analysis,
    foodLog: entries.map(serializeFoodLog)
  };
}

function serializeChatMessage(message: {
  id: string;
  conversationId: string;
  role: string;
  text: string;
  recommendedProductIdsJson: string;
  citationsJson: string;
  safetyJson: string;
  createdAt: Date;
}) {
  return {
    ...message,
    recommendedProductIds: readJson(message.recommendedProductIdsJson, []),
    citations: readJson(message.citationsJson, []),
    safety: readJson(message.safetyJson, {})
  };
}

async function recentConversationMessages(conversationId: string) {
  const messages = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: 18
  });
  return messages.reverse().map((message) => ({
    role: message.role,
    text: message.text,
    createdAt: message.createdAt
  }));
}

async function authResponse(app: ReturnType<typeof Fastify>, reply: any, id: string, email: string) {
  const accessToken = signAccessToken(app, id);
  const refresh = await issueRefreshToken(id);
  setRefreshCookie(reply, refresh.token, refresh.expiresAt);
  return { accessToken, user: { id, email } };
}

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
    /** PATCH /profile и др.: иначе preflight не включает PATCH в Allow-Methods и браузер даёт CORS error */
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 4 } });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const validationIssues = (error as Error & { issues?: unknown[] }).issues;
    const status = Array.isArray(validationIssues) ? 400 : typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 500) app.log.error(error);
    else app.log.warn(error);
    reply.status(status).send({
      error: {
        code: status === 500 ? "INTERNAL_ERROR" : status === 400 && Array.isArray(validationIssues) ? "VALIDATION_ERROR" : "REQUEST_ERROR",
        message: status === 500 ? "Что-то пошло не так" : Array.isArray(validationIssues) ? "Проверьте заполненные поля" : error.message
      }
    });
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  app.post("/auth/register", async (request, reply) => {
    const body = authBody.parse(request.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) return reply.status(409).send({ error: { code: "EMAIL_EXISTS", message: "Email уже зарегистрирован" } });
    const user = await prisma.user.create({
      data: { email: body.email.toLowerCase(), passwordHash: await hashPassword(body.password) }
    });
    return authResponse(app, reply, user.id, user.email);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = authBody.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      return reply.status(401).send({ error: { code: "BAD_CREDENTIALS", message: "Неверный email или пароль" } });
    }
    return authResponse(app, reply, user.id, user.email);
  });

  app.post("/auth/refresh", async (request, reply) => {
    const token = request.cookies[config.REFRESH_COOKIE_NAME];
    if (!token) return reply.status(401).send({ error: { code: "NO_REFRESH", message: "Сессия истекла" } });
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      clearRefreshCookie(reply);
      return reply.status(401).send({ error: { code: "BAD_REFRESH", message: "Сессия истекла" } });
    }
    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return authResponse(app, reply, row.userId, row.user.email);
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    const token = request.cookies[config.REFRESH_COOKIE_NAME];
    if (token) {
      await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token) }, data: { revokedAt: new Date() } });
    }
    clearRefreshCookie(reply);
    return { ok: true };
  });

  app.post("/auth/change-password", { preHandler: requireAuth }, async (request, reply) => {
    const body = changePasswordBody.parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId(request) } });
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      return reply.status(400).send({ error: { code: "BAD_PASSWORD", message: "Текущий пароль не подошёл" } });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.newPassword) }
    });
    await prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId(request) }, include: { profile: true } });
    return { user: { id: user.id, email: user.email }, profile: user.profile ? serializeProfile(user.profile) : null };
  });

  app.get("/profile", { preHandler: requireAuth }, async (request) => {
    const profile = await prisma.profile.findUnique({ where: { userId: userId(request) } });
    return { profile: profile ? serializeProfile(profile) : null };
  });

  app.patch("/profile", { preHandler: requireAuth }, async (request) => {
    const body = profileBody.partial().parse(request.body);
    const profileOwnerId = userId(request);
    const existing = await prisma.profile.findUnique({ where: { userId: profileOwnerId } });
    if (!existing) {
      const fullBody = profileBody.parse(request.body);
      const created = await prisma.profile.create({ data: profileToCreate(profileOwnerId, fullBody) });
      return { profile: serializeProfile(created) };
    }
    const data: Record<string, unknown> = { ...body };
    if (body.dietRestrictions) data.dietRestrictionsJson = writeJson(body.dietRestrictions);
    if (body.allergies) data.allergiesJson = writeJson(body.allergies);
    if (body.currentSupplements) data.currentSupplementsJson = writeJson(body.currentSupplements);
    if (body.symptoms) data.symptomsJson = writeJson(body.symptoms);
    delete data.dietRestrictions;
    delete data.allergies;
    delete data.currentSupplements;
    delete data.symptoms;
    const profile = await prisma.profile.update({ where: { userId: profileOwnerId }, data });
    return { profile: serializeProfile(profile) };
  });

  app.get("/daily-summary", { preHandler: requireAuth }, async (request) => {
    const context = await getUserContext(userId(request));
    const recommendations = recommendProducts(context.profile, context.summary, context.labs, context.products, 2);
    return { summary: context.summary, insight: buildInsight(context.summary, context.labs, context.profile), recommendations };
  });

  app.get("/food-items", { preHandler: requireAuth }, async () => ({ foodItems }));
  app.get("/food-log", { preHandler: requireAuth }, async (request) => ({
    foodLog: (await prisma.foodLog.findMany({ where: { userId: userId(request) }, orderBy: { createdAt: "desc" } })).map(serializeFoodLog)
  }));
  app.post("/food-log", { preHandler: requireAuth }, async (request) => {
    const body = z.object({
      foodId: z.string().optional(),
      name: z.string().trim().min(1).max(80).optional(),
      grams: z.number().int().min(1).max(5000),
      calories: z.number().int().min(0).max(8000).optional(),
      protein: z.number().min(0).max(500).optional(),
      fat: z.number().min(0).max(500).optional(),
      carbs: z.number().min(0).max(1000).optional(),
      source: z.enum(["catalog", "manual", "ai_photo"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      notes: z.string().trim().max(300).optional()
    }).refine((value) => value.foodId || (value.name && typeof value.calories === "number"), {
      message: "Для своего продукта нужны название и калории"
    }).parse(request.body);
    const catalogItem = body.foodId ? foodItems.find((item) => item.id === body.foodId) : undefined;
    if (body.foodId && !catalogItem) {
      const error = new Error("Продукт не найден") as Error & { statusCode: number };
      error.statusCode = 400;
      throw error;
    }
    const ratio = body.grams / 100;
    const entry = await prisma.foodLog.create({
      data: {
        userId: userId(request),
        foodId: body.foodId,
        foodName: body.name || catalogItem?.name,
        grams: body.grams,
        calories: typeof body.calories === "number" ? Math.round(body.calories) : catalogItem ? Math.round(catalogItem.caloriesPer100g * ratio) : null,
        protein: typeof body.protein === "number" ? body.protein : catalogItem ? catalogItem.proteinPer100g * ratio : null,
        fat: typeof body.fat === "number" ? body.fat : catalogItem ? catalogItem.fatPer100g * ratio : null,
        carbs: typeof body.carbs === "number" ? body.carbs : catalogItem ? catalogItem.carbsPer100g * ratio : null,
        source: body.source || (body.foodId ? "catalog" : "manual"),
        confidence: body.confidence,
        notes: body.notes
      }
    });
    return { entry: serializeFoodLog(entry) };
  });
  app.post("/food-photo", { preHandler: requireAuth }, async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: { code: "NO_FILE", message: "Файл не передан" } });
    if (!isVisionMime(file.mimetype)) return reply.status(415).send({ error: { code: "BAD_FILE", message: "Поддерживаются JPG, PNG и WEBP" } });

    const { storedPath, size } = await storeMultipartFile(file);
    const { analysis, foodLog } = await analyzeAndPersistFoodPhoto({
      userId: userId(request),
      storedPath,
      mimeType: file.mimetype,
      filename: file.filename,
      log: request.log
    });

    return {
      status: analysis.status,
      upload: {
        originalName: file.filename,
        mimeType: file.mimetype,
        size,
        status: analysis.status,
        parsedFood: analysis.items
      },
      foodLog,
      citations: analysis.citations,
      vectorStore: { status: "skipped" }
    };
  });
  app.get("/water-log", { preHandler: requireAuth }, async (request) => ({ waterLog: await prisma.waterLog.findMany({ where: { userId: userId(request) }, orderBy: { createdAt: "desc" } }) }));
  app.post("/water-log", { preHandler: requireAuth }, async (request) => {
    const body = z.object({ ml: z.number().int().min(1).max(5000), container: z.string().trim().min(1).max(40).optional() }).parse(request.body);
    return { entry: await prisma.waterLog.create({ data: { userId: userId(request), ...body } }) };
  });

  app.get("/products", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ query: z.string().optional(), category: z.string().optional() }).parse(request.query);
    const products = (await prisma.product.findMany()).map(serializeProduct);
    const filtered = products.filter((product) => {
      const categoryOk = !query.category || query.category === "Все" || product.category === query.category;
      const haystack = [product.name, product.category, product.description, ...product.tags].join(" ").toLowerCase();
      return categoryOk && (!query.query || haystack.includes(query.query.toLowerCase()));
    });
    return { products: filtered };
  });
  app.get("/products/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const product = await prisma.product.findUnique({ where: { id: params.id } });
    if (!product) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Продукт не найден" } });
    return { product: serializeProduct(product) };
  });

  app.get("/content", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ type: z.string().optional(), query: z.string().optional() }).parse(request.query);
    const items = (await prisma.contentItem.findMany({ orderBy: { publishedAt: "desc" } })).map(serializeContent);
    return {
      items: items.filter((item) => {
        const typeOk = !query.type || query.type === "all" || item.type === query.type;
        const textOk = !query.query || [item.title, item.summary, item.body, ...item.tags].join(" ").toLowerCase().includes(query.query.toLowerCase());
        return typeOk && textOk;
      })
    };
  });
  app.get("/content/:slug", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ slug: z.string() }).parse(request.params);
    const item = await prisma.contentItem.findUnique({ where: { slug: params.slug } });
    if (!item) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Материал не найден" } });
    const content = serializeContent(item);
    const related = await prisma.product.findMany({ where: { id: { in: content.relatedProductIds } } });
    return { item: content, relatedProducts: related.map(serializeProduct) };
  });

  app.get("/chat", { preHandler: requireAuth }, async (request, reply) => {
    const query = z.object({ conversationId: z.string().optional() }).parse(request.query);
    let conversation = query.conversationId
      ? await prisma.conversation.findFirst({ where: { id: query.conversationId, userId: userId(request) } })
      : await prisma.conversation.findFirst({ where: { userId: userId(request) }, orderBy: { updatedAt: "desc" } });
    if (query.conversationId && !conversation) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Чат не найден" } });
    if (!conversation) conversation = await prisma.conversation.create({ data: { userId: userId(request), title: "AI-коуч" } });
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } });
    return { conversation, messages: messages.map(serializeChatMessage) };
  });

  app.post("/chat/conversations", { preHandler: requireAuth }, async (request) => {
    const conversation = await prisma.conversation.create({ data: { userId: userId(request), title: "Новый чат" } });
    return { conversation, messages: [] };
  });

  app.post("/chat", { preHandler: requireAuth }, async (request) => {
    const body = z.object({ message: z.string().min(1), conversationId: z.string().optional() }).parse(request.body);
    const uid = userId(request);
    const conversation = body.conversationId
      ? await prisma.conversation.findFirstOrThrow({ where: { id: body.conversationId, userId: uid } })
      : await prisma.conversation.create({ data: { userId: uid, title: body.message.slice(0, 40) || "AI-коуч" } });
    await prisma.chatMessage.create({ data: { conversationId: conversation.id, role: "user", text: body.message } });
    const context = await getUserContext(uid);
    const recentMessages = await recentConversationMessages(conversation.id);
    const recs = recommendProductsForChat(body.message, context.profile, context.summary, context.labs, context.products, 2);
    const agent = await createAgentResponse(body.message, context, recs.map((rec) => rec.product.id), recentMessages);
    const assistant = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        text: agent.text,
        recommendedProductIdsJson: writeJson(agent.recommendedProductIds),
        citationsJson: writeJson(agent.citations),
        safetyJson: writeJson(agent.safety)
      }
    });
    return { conversationId: conversation.id, message: { ...assistant, recommendedProductIds: agent.recommendedProductIds, citations: agent.citations, safety: agent.safety } };
  });

  app.post("/chat/stream", { preHandler: requireAuth }, async (request, reply) => {
    if (!config.OPENAI_API_KEY) {
      return reply.status(503).send({ error: { code: "COACH_UNAVAILABLE", message: "Коуч временно недоступен. Попробуйте позже." } });
    }

    const body = z.object({ message: z.string().min(1), conversationId: z.string().optional() }).parse(request.body);
    const uid = userId(request);
    const conversation = body.conversationId
      ? await prisma.conversation.findFirstOrThrow({ where: { id: body.conversationId, userId: uid } })
      : await prisma.conversation.create({ data: { userId: uid, title: body.message.slice(0, 40) || "Коуч" } });
    await prisma.chatMessage.create({ data: { conversationId: conversation.id, role: "user", text: body.message } });
    const context = await getUserContext(uid);
    const recentMessages = await recentConversationMessages(conversation.id);
    const recs = recommendProductsForChat(body.message, context.profile, context.summary, context.labs, context.products, 2);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...corsHeadersForOrigin(request.headers.origin)
    });
    reply.hijack();

    const send = (event: string, payload: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const agent = await createAgentResponseStream(body.message, context, recs.map((rec) => rec.product.id), recentMessages, (event) => {
        if (event.type === "status") send("status", { label: event.label });
        if (event.type === "delta") send("delta", { text: event.text });
        if (event.type === "citation") send("citation", event.citation);
      });
      const assistant = await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          text: agent.text,
          recommendedProductIdsJson: writeJson(agent.recommendedProductIds),
          citationsJson: writeJson(agent.citations),
          safetyJson: writeJson(agent.safety)
        }
      });
      for (const productId of agent.recommendedProductIds) send("recommendation", { productId });
      send("done", {
        conversationId: conversation.id,
        message: { ...assistant, recommendedProductIds: agent.recommendedProductIds, citations: agent.citations, safety: agent.safety }
      });
    } catch (error) {
      const message = error instanceof AgentUnavailableError || error instanceof Error ? error.message : "Не удалось подготовить ответ";
      send("error", { message });
    } finally {
      reply.raw.end();
    }
  });

  app.post("/chat/:conversationId/files", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ conversationId: z.string() }).parse(request.params);
    const conversation = await prisma.conversation.findFirst({ where: { id: params.conversationId, userId: userId(request) } });
    if (!conversation) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Чат не найден" } });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: { code: "NO_FILE", message: "Файл не передан" } });
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"];
    if (!allowed.includes(file.mimetype)) return reply.status(415).send({ error: { code: "BAD_FILE", message: "Поддерживаются JPG, PNG, WEBP, PDF, DOC, DOCX и TXT" } });
    const uploadIntent = multipartFieldValue(file.fields, "intent");
    const userMessageText = multipartFieldValue(file.fields, "message") || (uploadIntent === "food" ? "Определи еду по фото и добавь в дневник" : "Проверь мои анализы");
    const uid = userId(request);
    const userMessage = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "user",
        text: `${userMessageText}\n\nПрикреплен файл: ${file.filename}`
      }
    });
    const { storedPath, size } = await storeMultipartFile(file);
    const extractedText = await extractFileText(storedPath, file.mimetype);
    const upload = await prisma.upload.create({
      data: {
        userId: uid,
        conversationId: conversation.id,
        originalName: file.filename,
        mimeType: file.mimetype,
        size,
        path: storedPath,
        status: "processing",
        extractedText
      }
    });

    if (shouldAnalyzeFoodPhoto(file.mimetype, userMessageText, uploadIntent)) {
      const { analysis, foodLog: serializedEntries } = await analyzeAndPersistFoodPhoto({
        userId: uid,
        storedPath,
        mimeType: file.mimetype,
        filename: file.filename,
        uploadId: upload.id,
        log: request.log
      });
      const updatedUpload = await prisma.upload.update({
        where: { id: upload.id },
        data: {
          status: analysis.status,
          vectorStoreStatus: "skipped",
          parsedLabsJson: writeJson({ kind: "food_photo", items: analysis.items })
        }
      });
      const totalCalories = serializedEntries.reduce((sum, entry) => sum + entry.calories, 0);
      const totalGrams = serializedEntries.reduce((sum, entry) => sum + entry.grams, 0);
      const assistant = await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          text: serializedEntries.length
            ? `Я оценил фото и добавил в дневник: ${serializedEntries.map((entry) => `${entry.displayName} ${entry.grams} г`).join(", ")}.\n\nИтого примерно ${totalCalories} ккал на ${totalGrams} г. Это оценка по изображению, поэтому граммовку и состав лучше поправить вручную, если порция отличалась.`
            : `Я не смог уверенно определить еду на фото "${file.filename}". ${analysis.explanation}`,
          citationsJson: writeJson(analysis.citations),
          safetyJson: writeJson({ medicalDisclaimerShown: false, blocked: false, fileRecognition: analysis.status, diaryAction: serializedEntries.length ? "food_added" : "needs_review" })
        }
      });
      return {
        status: analysis.status,
        upload: { ...updatedUpload, parsedFood: analysis.items },
        userMessage: serializeChatMessage(userMessage),
        message: { ...assistant, citations: analysis.citations },
        labs: [],
        foodLog: serializedEntries,
        citations: analysis.citations,
        vectorStore: { status: "skipped" }
      };
    }

    let analysis: LabAnalysisResult;
    try {
      analysis = await analyzeLabFile(storedPath, file.mimetype, file.filename, { extractedText });
    } catch (error) {
      request.log.warn({ err: error, uploadId: upload.id, mimeType: file.mimetype }, "Lab file analysis failed");
      analysis = {
        status: "needs_review",
        labs: [],
        explanation: "Файл загружен, но автоматическое чтение показателей сейчас не удалось. Попробуйте более четкий PDF/фото или напишите ключевые показатели сообщением.",
        citations: [],
        sourceText: extractedText
      };
    }

    let labs: Awaited<ReturnType<typeof persistParsedLabs>> = [];
    if ((analysis.status === "recognized" || analysis.status === "needs_review") && analysis.labs.length) {
      try {
        labs = await persistParsedLabs(uid, upload.id, analysis.labs);
      } catch (error) {
        request.log.warn({ err: error, uploadId: upload.id }, "Parsed lab persistence failed");
        analysis = {
          ...analysis,
          status: "needs_review",
          labs: [],
          explanation: "Файл загружен, но часть показателей не удалось надежно сохранить. Проверьте файл или отправьте показатели текстом."
        };
      }
    }

    let vectorStore: LabVectorStoreResult = { status: "skipped" };
    if (labs.length || analysis.sourceText?.trim()) {
      try {
        vectorStore = await uploadLabsToVectorStore({
          uploadId: upload.id,
          conversationId: conversation.id,
          originalName: file.filename,
          mimeType: file.mimetype,
          createdAt: upload.createdAt,
          labs: labs.length ? labs : analysis.labs,
          sourceText: analysis.sourceText,
          analysisStatus: analysis.status,
          explanation: analysis.explanation
        });
      } catch (error) {
        request.log.warn({ err: error, uploadId: upload.id }, "Lab vector store upload failed");
        vectorStore = { status: "failed", error: error instanceof Error ? error.message : "Vector store upload failed" };
      }
    }

    const updatedUpload = await prisma.upload.update({
      where: { id: upload.id },
      data: {
        status: analysis.status,
        openaiFileId: vectorStore.openaiFileId,
        vectorStoreFileId: vectorStore.vectorStoreFileId,
        vectorStoreStatus: vectorStore.status,
        parsedLabsJson: writeJson(labs),
        extractedText: analysis.sourceText || extractedText
      }
    });
    const citations: AgentCitation[] = analysis.citations;
    const assistant = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        text: labs.length
          ? `Я прочитал файл "${file.filename}" и нашел ${labs.length} показателя.\n\n${labs.map((lab) => `- ${lab.name}: ${lab.value} ${lab.unit}, референс ${lab.reference}`).join("\n")}\n\n${analysis.explanation}\n\nВажно: это не диагноз. Если показатель выходит за референс или есть симптомы, лучше обсудить результат с врачом.`
          : `Я не смог уверенно прочитать показатели в файле "${file.filename}". Попробуйте загрузить более четкое фото или PDF, где видны названия, значения, единицы измерения и референсы.`,
        citationsJson: writeJson(citations),
        safetyJson: writeJson({ medicalDisclaimerShown: true, blocked: false, fileRecognition: analysis.status })
      }
    });
    return {
      status: analysis.status,
      upload: { ...updatedUpload, parsedLabs: labs },
      userMessage: serializeChatMessage(userMessage),
      message: { ...assistant, citations },
      labs,
      citations,
      vectorStore
    };
  });

  app.get("/lab-results", { preHandler: requireAuth }, async (request) => {
    const labs = await prisma.labResult.findMany({ where: { userId: userId(request) }, orderBy: { createdAt: "desc" } });
    return { labs: labs.map(serializeLab) };
  });

  app.post("/plan/generate", { preHandler: requireAuth }, async (request) => {
    const context = await getUserContext(userId(request));
    const water = ["500 мл до 11:00", "500 мл между обедом и 18:00", "Стакан воды рядом с вечерним ритуалом"];
    const nutrition = ["Белковый завтрак", "Овощи или зелень в обед", "Легкий ужин с белком и крупой"];
    if (context.summary.protein < context.summary.proteinGoal * 0.7) nutrition.unshift("Добавить 25-30 г белка в следующий прием пищи");
    return { plan: { water, nutrition, habits: ["10 минут ходьбы после обеда", "Экранный стоп за 40 минут до сна"], supplements: ["Не добавлять новые добавки без проверки противопоказаний"], reminders: ["Вода в 11:00", "Дневник питания в 15:00"] } };
  });

  app.post("/orders/interest", { preHandler: requireAuth }, async (request) => {
    const body = z.object({ productId: z.string() }).parse(request.body);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: body.productId } });
    const order = await prisma.order.create({ data: { userId: userId(request), productId: product.id, status: "interest_registered", total: product.price } });
    return { order };
  });

  return app;
}
