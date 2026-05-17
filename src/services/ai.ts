import fs from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import { config, vectorStoreIds } from "../config.js";
import type { getUserContext, serializeLab } from "./domain.js";

export type AgentCitation = { title: string; sourceId?: string; url?: string };

export type AgentResult = {
  text: string;
  recommendedProductIds: string[];
  citations: AgentCitation[];
  safety: {
    medicalDisclaimerShown: boolean;
    blocked: boolean;
    escalation?: string;
    mode: "openai";
  };
};

export type AgentStreamEvent =
  | { type: "status"; label: string }
  | { type: "delta"; text: string }
  | { type: "citation"; citation: AgentCitation }
  | { type: "error"; message: string };

export type ParsedLab = Omit<ReturnType<typeof serializeLab>, "id" | "createdAt">;

export type LabAnalysisResult = {
  status: "recognized" | "needs_review" | "failed";
  labs: ParsedLab[];
  explanation: string;
  citations: AgentCitation[];
  sourceText?: string;
};

export type ParsedFoodItem = {
  name: string;
  grams: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  confidence: number;
  notes: string;
};

export type FoodPhotoAnalysisResult = {
  status: "recognized" | "needs_review" | "failed";
  items: ParsedFoodItem[];
  explanation: string;
  citations: AgentCitation[];
};

export type LabVectorStoreResult = {
  openaiFileId?: string;
  vectorStoreFileId?: string;
  status: "skipped" | "completed" | "in_progress" | "cancelled" | "failed";
  error?: string;
};

export type CoachMemoryMessage = {
  role: string;
  text: string;
  createdAt: Date | string;
};

export class AgentUnavailableError extends Error {
  statusCode = 503;

  constructor(message = "Коуч временно недоступен. Попробуйте позже.") {
    super(message);
  }
}

const coachInstructions = [
  "Ты русскоязычный wellness-коуч в приложении про питание, привычки, анализы и добавки.",
  "Не ставь диагнозы, не назначай лечение и не обещай медицинский результат.",
  "Если речь об анализах, лекарствах, беременности, хронических состояниях или выраженных симптомах, мягко советуй обсудить изменения с врачом.",
  "Пиши для обычного пользователя: ясно, тепло, без технических терминов про сервер, индексы, базы знаний или внутреннюю архитектуру.",
  "Давай короткий вывод, 2-4 практичных шага и источники только когда они действительно использованы.",
  "Рекомендованные продукты упоминай осторожно и только как тему для обсуждения или изучения.",
  "Если candidateProducts пуст, не предлагай продукты и не подталкивай к покупке.",
  "Если candidateProducts не пуст, упоминай продукт только когда он прямо связан с текущим вопросом, симптомом, анализом или дефицитом в питании."
].join("\n");

const labInstructions = [
  "Ты помогаешь аккуратно извлечь показатели из файла с лабораторными анализами.",
  "Верни только JSON по схеме. Не придумывай показатели, значения или референсы.",
  "Если часть строк читается уверенно, верни эти показатели даже если другие строки не читаются.",
  "Если значение есть, но референс отсутствует, укажи reference как \"не указан\" и status consult.",
  "Если показатель не читается уверенно, не включай его в labs и поставь status needs_review.",
  "Статусы: low, normal, high или consult. Используй consult, если нужен врач или контекст.",
  "Объяснение должно быть осторожным и понятным обычному пользователю, а при пустом labs кратко объясни причину."
].join("\n");

const foodPhotoInstructions = [
  "Ты помогаешь оценить еду по фото для дневника питания.",
  "Верни только JSON по схеме. Не ставь диагнозы и не делай медицинских рекомендаций.",
  "Определи видимые блюда или продукты на тарелке, примерную граммовку порции, калории и БЖУ для съедобной части.",
  "Используй типовые справочники пищевой ценности и здравый смысл, но явно снижай confidence, если фото нечеткое, порция закрыта, есть соус или неизвестный состав.",
  "Если уверенно видна только часть блюда, верни эту часть и объясни неопределенность в notes.",
  "Если еду нельзя распознать, верни status failed, пустой items и короткое explanation.",
  "Все значения должны быть для фактической порции на фото, не на 100 г."
].join("\n");

function requireOpenAI() {
  if (!config.OPENAI_API_KEY) throw new AgentUnavailableError();
  return new OpenAI({ apiKey: config.OPENAI_API_KEY });
}

function tools() {
  return vectorStoreIds.length
    ? [{ type: "file_search" as const, vector_store_ids: vectorStoreIds, max_num_results: 5 }]
    : [];
}

function uniqueCitations(citations: AgentCitation[]) {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.title}:${citation.sourceId || ""}:${citation.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function citationFromAnnotation(annotation: unknown): AgentCitation | null {
  if (!annotation || typeof annotation !== "object") return null;
  const item = annotation as Record<string, unknown>;
  if (item.type === "file_citation") {
    return {
      title: typeof item.filename === "string" ? item.filename : "Материал",
      sourceId: typeof item.file_id === "string" ? item.file_id : undefined
    };
  }
  if (item.type === "url_citation") {
    return {
      title: typeof item.title === "string" ? item.title : "Источник",
      url: typeof item.url === "string" ? item.url : undefined
    };
  }
  if (item.type === "container_file_citation") {
    return {
      title: typeof item.filename === "string" ? item.filename : "Материал",
      sourceId: typeof item.file_id === "string" ? item.file_id : undefined
    };
  }
  return null;
}

function citationsFromResponse(response: unknown) {
  const citations: AgentCitation[] = [];
  const output = (response as { output?: unknown[] })?.output || [];
  for (const item of output) {
    const content = (item as { content?: unknown[] })?.content || [];
    for (const part of content) {
      const annotations = (part as { annotations?: unknown[] })?.annotations || [];
      for (const annotation of annotations) {
        const citation = citationFromAnnotation(annotation);
        if (citation) citations.push(citation);
      }
    }
  }
  return uniqueCitations(citations);
}

function buildCoachInput(
  message: string,
  context: Awaited<ReturnType<typeof getUserContext>>,
  recommendedProductIds: string[],
  recentMessages: CoachMemoryMessage[] = []
) {
  return [
    {
      role: "user" as const,
      content: JSON.stringify({
        userMessage: message,
        currentConversationMemory: recentMessages.slice(-18).map((item) => ({
          role: item.role,
          text: item.text,
          createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt
        })),
        profile: context.profile,
        dailySummary: context.summary,
        labs: context.labs,
        diary: {
          foodLog: context.foodLog.slice(0, 12),
          waterLog: context.waterLog.slice(0, 12)
        },
        candidateProducts: context.products
          .filter((product) => recommendedProductIds.includes(product.id))
          .map((product) => ({
            id: product.id,
            name: product.name,
            category: product.category,
            description: product.description,
            price: product.price,
            tags: product.tags,
            goodFor: product.goodFor,
            notFor: product.notFor,
            contraindications: product.contraindications,
            whyRecommended: product.whyRecommended
          })),
        candidateProductIds: recommendedProductIds,
        safety: "Do not diagnose, treat, or replace a clinician."
      })
    }
  ];
}

export async function createAgentResponse(
  message: string,
  context: Awaited<ReturnType<typeof getUserContext>>,
  recommendedProductIds: string[],
  recentMessages: CoachMemoryMessage[] = []
): Promise<AgentResult> {
  const openai = requireOpenAI();
  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions: coachInstructions,
    input: buildCoachInput(message, context, recommendedProductIds, recentMessages),
    tools: tools(),
    text: { verbosity: "medium" },
    store: false
  });

  return {
    text: response.output_text,
    recommendedProductIds,
    citations: citationsFromResponse(response),
    safety: { medicalDisclaimerShown: true, blocked: false, mode: "openai" }
  };
}

export async function createAgentResponseStream(
  message: string,
  context: Awaited<ReturnType<typeof getUserContext>>,
  recommendedProductIds: string[],
  recentMessages: CoachMemoryMessage[],
  emit: (event: AgentStreamEvent) => void
): Promise<AgentResult> {
  const openai = requireOpenAI();
  const citations: AgentCitation[] = [];
  let text = "";

  emit({ type: "status", label: "Готовлю ответ" });
  const stream = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions: coachInstructions,
    input: buildCoachInput(message, context, recommendedProductIds, recentMessages),
    tools: tools(),
    text: { verbosity: "medium" },
    store: false,
    stream: true
  });

  for await (const event of stream) {
    if (event.type === "response.file_search_call.searching") {
      emit({ type: "status", label: "Подбираю источники" });
    }
    if (event.type === "response.output_text.delta") {
      text += event.delta;
      emit({ type: "delta", text: event.delta });
    }
    if (event.type === "response.output_text.annotation.added") {
      const citation = citationFromAnnotation(event.annotation);
      if (citation) {
        citations.push(citation);
        emit({ type: "citation", citation });
      }
    }
    if (event.type === "response.failed") {
      throw new Error(event.response.error?.message || "Не удалось подготовить ответ");
    }
    if (event.type === "error") {
      throw new Error(event.message || "Не удалось подготовить ответ");
    }
    if (event.type === "response.completed") {
      citations.push(...citationsFromResponse(event.response));
    }
  }

  return {
    text,
    recommendedProductIds,
    citations: uniqueCitations(citations),
    safety: { medicalDisclaimerShown: true, blocked: false, mode: "openai" }
  };
}

function labJsonSchema() {
  return {
    type: "json_schema",
    name: "lab_analysis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "explanation", "labs", "citations"],
      properties: {
        status: { type: "string", enum: ["recognized", "needs_review", "failed"] },
        explanation: { type: "string" },
        labs: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "value", "unit", "reference", "status", "explanation", "actions", "relatedTags"],
            properties: {
              name: { type: "string" },
              value: { type: "number" },
              unit: { type: "string" },
              reference: { type: "string" },
              status: { type: "string", enum: ["low", "normal", "high", "consult"] },
              explanation: { type: "string" },
              actions: { type: "array", items: { type: "string" } },
              relatedTags: { type: "array", items: { type: "string" } }
            }
          }
        },
        citations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "sourceId", "url"],
            properties: {
              title: { type: "string" },
              sourceId: { type: ["string", "null"] },
              url: { type: ["string", "null"] }
            }
          }
        }
      }
    }
  };
}

function foodPhotoJsonSchema() {
  return {
    type: "json_schema",
    name: "food_photo_analysis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "explanation", "items", "citations"],
      properties: {
        status: { type: "string", enum: ["recognized", "needs_review", "failed"] },
        explanation: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "grams", "calories", "protein", "fat", "carbs", "confidence", "notes"],
            properties: {
              name: { type: "string" },
              grams: { type: "integer" },
              calories: { type: "integer" },
              protein: { type: "number" },
              fat: { type: "number" },
              carbs: { type: "number" },
              confidence: { type: "number" },
              notes: { type: "string" }
            }
          }
        },
        citations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "sourceId", "url"],
            properties: {
              title: { type: "string" },
              sourceId: { type: ["string", "null"] },
              url: { type: ["string", "null"] }
            }
          }
        }
      }
    }
  };
}

function parseLabResponse(text: string): LabAnalysisResult {
  const parsed = JSON.parse(text) as LabAnalysisResult;
  return {
    status: parsed.status,
    explanation: parsed.explanation,
    labs: Array.isArray(parsed.labs) ? parsed.labs : [],
    citations: uniqueCitations(Array.isArray(parsed.citations) ? parsed.citations : [])
  };
}

function normalizeSourceText(value?: string | null) {
  return value
    ?.replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n") || "";
}

function buildLabFileAnalysisInput(uploadedFileId: string, mimeType: string, extractedText?: string) {
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; file_id: string; detail: "high" }
    | { type: "input_file"; file_id: string }
  > = [
    {
      type: "input_text",
      text: [
        "Извлеки показатели лабораторного анализа из прикрепленного файла.",
        "Нужно вернуть названия показателей, числовые значения, единицы, референсы и краткое осторожное объяснение.",
        "Не придумывай отсутствующие данные, но не отказывайся от всего файла, если можно уверенно прочитать хотя бы часть строк."
      ].join(" ")
    },
    ...labInputContentForUploadedFile(uploadedFileId, mimeType)
  ];

  if (extractedText) {
    content.push({
      type: "input_text",
      text: `Дополнительный извлеченный текст из файла. Используй его только как вспомогательный источник и не придумывай пропуски:\n${extractedText}`
    });
  }

  return [{ role: "user" as const, content }];
}

async function analyzeLabSourceText(openai: OpenAI, sourceText: string, filename: string): Promise<LabAnalysisResult> {
  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions: labInstructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              `Разбери извлеченный текст лабораторного файла "${filename}".`,
              "Это уже OCR/транскрипция, поэтому возможны артефакты.",
              "Вытащи только те показатели, которые можно уверенно восстановить из текста."
            ].join(" ")
          },
          {
            type: "input_text",
            text: sourceText
          }
        ]
      }
    ],
    text: { format: labJsonSchema() as any, verbosity: "low" },
    store: false
  });

  const result = parseLabResponse(response.output_text);
  return {
    ...result,
    status: result.labs.length && result.status !== "failed" ? result.status : "needs_review",
    citations: uniqueCitations([...result.citations, ...citationsFromResponse(response)]),
    sourceText
  };
}

async function transcribeLabFile(openai: OpenAI, uploadedFileId: string, mimeType: string, filename: string) {
  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions: [
      "Ты делаешь только аккуратную транскрипцию лабораторного файла.",
      "Не анализируй, не суммируй, не ставь диагнозы.",
      "Верни только текст, который реально читается: названия показателей, значения, единицы измерения, референсные интервалы, комментарии лаборатории.",
      "Если строка читается частично, верни только уверенно видимую часть.",
      "Если прочитать ничего нельзя, верни NO_READABLE_TEXT."
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Точно перепиши читаемые строки из лабораторного файла "${filename}". Сохраняй порядок строк.`
          },
          ...labInputContentForUploadedFile(uploadedFileId, mimeType)
        ]
      }
    ],
    text: { verbosity: "low" },
    store: false
  });

  const transcript = normalizeSourceText(response.output_text);
  return transcript === "NO_READABLE_TEXT" ? "" : transcript;
}

function selectPreferredLabAnalysis(primary: LabAnalysisResult, fallback?: LabAnalysisResult | null): LabAnalysisResult {
  if (!fallback) return primary;
  if (fallback.labs.length > primary.labs.length) return fallback;
  if (!primary.labs.length && fallback.sourceText && !primary.sourceText) return fallback;
  return {
    ...primary,
    citations: uniqueCitations([...primary.citations, ...fallback.citations]),
    sourceText: primary.sourceText || fallback.sourceText
  };
}

function parseFoodPhotoResponse(text: string): FoodPhotoAnalysisResult {
  const parsed = JSON.parse(text) as FoodPhotoAnalysisResult;
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .filter((item) => item.name && item.grams > 0 && item.calories >= 0)
        .map((item) => ({
          ...item,
          grams: Math.round(item.grams),
          calories: Math.round(item.calories),
          protein: Math.max(0, item.protein),
          fat: Math.max(0, item.fat),
          carbs: Math.max(0, item.carbs),
          confidence: Math.min(1, Math.max(0, item.confidence))
        }))
    : [];
  return {
    status: parsed.status,
    explanation: parsed.explanation,
    items,
    citations: uniqueCitations(Array.isArray(parsed.citations) ? parsed.citations : [])
  };
}

export async function analyzeLabFile(
  filePath: string,
  mimeType: string,
  filename: string,
  options?: { extractedText?: string }
): Promise<LabAnalysisResult> {
  const openai = requireOpenAI();
  const bytes = await fs.readFile(filePath);
  const extractedText = normalizeSourceText(options?.extractedText);
  const uploaded = await openai.files.create({
    file: await toFile(bytes, filename, { type: mimeType }),
    purpose: labFilePurposeForMime(mimeType)
  });

  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions: labInstructions,
    input: buildLabFileAnalysisInput(uploaded.id, mimeType, extractedText),
    text: { format: labJsonSchema() as any, verbosity: "low" },
    store: false
  });

  const parsedDirectResult = parseLabResponse(response.output_text);
  const directResult: LabAnalysisResult = {
    ...parsedDirectResult,
    sourceText: extractedText,
    status: parsedDirectResult.labs.length && parsedDirectResult.status !== "failed" ? parsedDirectResult.status : "needs_review",
    citations: uniqueCitations([...parsedDirectResult.citations, ...citationsFromResponse(response)])
  };

  let fallbackResult: LabAnalysisResult | null = null;
  if (!directResult.labs.length) {
    const transcript = normalizeSourceText(await transcribeLabFile(openai, uploaded.id, mimeType, filename));
    const mergedSourceText = normalizeSourceText([extractedText, transcript].filter(Boolean).join("\n"));
    if (mergedSourceText) {
      fallbackResult = await analyzeLabSourceText(openai, mergedSourceText, filename);
    }
  }

  const result = selectPreferredLabAnalysis(directResult, fallbackResult);
  return {
    ...result,
    status: result.labs.length && result.status !== "failed" ? result.status : "needs_review",
    sourceText: result.sourceText || extractedText,
    citations: uniqueCitations([...result.citations, ...citationsFromResponse(response)])
  };
}

export async function analyzeFoodPhoto(filePath: string, mimeType: string, filename: string): Promise<FoodPhotoAnalysisResult> {
  if (!isVisionMime(mimeType)) {
    return {
      status: "failed",
      items: [],
      explanation: "Для оценки еды нужен снимок в формате JPG, PNG или WEBP.",
      citations: []
    };
  }
  const openai = requireOpenAI();
  const bytes = await fs.readFile(filePath);
  const uploaded = await openai.files.create({
    file: await toFile(bytes, filename, { type: mimeType }),
    purpose: "vision"
  });

  const response = await openai.responses.create({
    model: config.OPENAI_MODEL,
    instructions: foodPhotoInstructions,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "Оцени еду на фото для дневника питания.",
              "Верни отдельные позиции, если блюдо состоит из явно разных частей.",
              "Нужны граммы порции, калории, белки, жиры, углеводы и confidence."
            ].join(" ")
          },
          ...labInputContentForUploadedFile(uploaded.id, mimeType)
        ]
      }
    ],
    text: { format: foodPhotoJsonSchema() as any, verbosity: "low" },
    store: false
  });

  const result = parseFoodPhotoResponse(response.output_text);
  return {
    ...result,
    status: result.items.length && result.status !== "failed" ? result.status : "needs_review",
    citations: uniqueCitations([...result.citations, ...citationsFromResponse(response)])
  };
}

export async function extractFileText(filePath: string, mimeType: string) {
  if (mimeType.startsWith("text/")) return fs.readFile(filePath, "utf8");
  return "";
}

export function isVisionMime(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp"].includes(mimeType);
}

export function labFilePurposeForMime(mimeType: string) {
  return isVisionMime(mimeType) ? "vision" : "user_data";
}

export function labInputContentForUploadedFile(fileId: string, mimeType: string) {
  return isVisionMime(mimeType)
    ? [{ type: "input_image" as const, file_id: fileId, detail: "high" as const }]
    : [{ type: "input_file" as const, file_id: fileId }];
}

export function buildLabVectorStoreDocument(input: {
  uploadId: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  createdAt: Date;
  labs: ParsedLab[];
  sourceText?: string;
  analysisStatus?: LabAnalysisResult["status"];
  explanation?: string;
}) {
  return JSON.stringify(
    {
      kind: "lab_results",
      uploadId: input.uploadId,
      conversationId: input.conversationId,
      originalName: input.originalName,
      mimeType: input.mimeType,
      createdAt: input.createdAt.toISOString(),
      analysisStatus: input.analysisStatus,
      explanation: input.explanation,
      sourceText: normalizeSourceText(input.sourceText),
      labs: input.labs
    },
    null,
    2
  );
}

export async function uploadLabsToVectorStore(input: {
  uploadId: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  createdAt: Date;
  labs: ParsedLab[];
  sourceText?: string;
  analysisStatus?: LabAnalysisResult["status"];
  explanation?: string;
}): Promise<LabVectorStoreResult> {
  if (!vectorStoreIds.length) return { status: "skipped" };

  const openai = requireOpenAI();
  const document = buildLabVectorStoreDocument(input);
  const normalizedName = `lab-results-${input.uploadId}.json`;
  const file = await openai.files.create({
    file: await toFile(Buffer.from(document, "utf8"), normalizedName, { type: "application/json" }),
    purpose: "assistants"
  });
  const vectorFile = await openai.vectorStores.files.createAndPoll(vectorStoreIds[0], {
    file_id: file.id,
    attributes: {
      kind: "lab_results",
      uploadId: input.uploadId,
      conversationId: input.conversationId,
      originalName: input.originalName.slice(0, 512)
    }
  });

  return {
    openaiFileId: file.id,
    vectorStoreFileId: vectorFile.id,
    status: vectorFile.status
  };
}
