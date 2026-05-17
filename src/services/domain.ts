import type { Prisma, Profile } from "@prisma/client";
import { foodItems } from "../data/mock.js";
import { prisma, readJson, writeJson } from "../db.js";

export type PublicProfile = {
  name: string;
  age: number;
  sex: string;
  height: number;
  weight: number;
  goal: string;
  activityLevel: string;
  wellbeing: string;
  dietRestrictions: string[];
  allergies: string[];
  currentSupplements: string[];
  symptoms: string[];
  medicalConsent: boolean;
};

export function serializeProfile(profile: Profile): PublicProfile {
  return {
    name: profile.name,
    age: profile.age,
    sex: profile.sex,
    height: profile.height,
    weight: profile.weight,
    goal: profile.goal,
    activityLevel: profile.activityLevel,
    wellbeing: profile.wellbeing,
    dietRestrictions: readJson<string[]>(profile.dietRestrictionsJson, []),
    allergies: readJson<string[]>(profile.allergiesJson, []),
    currentSupplements: readJson<string[]>(profile.currentSupplementsJson, []),
    symptoms: readJson<string[]>(profile.symptomsJson, []),
    medicalConsent: profile.medicalConsent
  };
}

export function profileToCreate(userId: string, profile: PublicProfile): Prisma.ProfileCreateInput {
  return {
    user: { connect: { id: userId } },
    name: profile.name,
    age: profile.age,
    sex: profile.sex,
    height: profile.height,
    weight: profile.weight,
    goal: profile.goal,
    activityLevel: profile.activityLevel,
    wellbeing: profile.wellbeing,
    dietRestrictionsJson: writeJson(profile.dietRestrictions),
    allergiesJson: writeJson(profile.allergies),
    currentSupplementsJson: writeJson(profile.currentSupplements),
    symptomsJson: writeJson(profile.symptoms),
    medicalConsent: profile.medicalConsent
  };
}

export function serializeProduct(product: {
  id: string;
  name: string;
  category: string;
  price: number;
  description: string;
  compositionJson: string;
  goodForJson: string;
  notForJson: string;
  tagsJson: string;
  rating: number;
  imageTone: string;
  nutrientsJson: string;
  contraindicationsJson: string;
  whyRecommended: string;
}) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    price: product.price,
    description: product.description,
    composition: readJson<string[]>(product.compositionJson, []),
    goodFor: readJson<string[]>(product.goodForJson, []),
    notFor: readJson<string[]>(product.notForJson, []),
    tags: readJson<string[]>(product.tagsJson, []),
    rating: product.rating,
    imageTone: product.imageTone,
    nutrients: readJson<string[]>(product.nutrientsJson, []),
    contraindications: readJson<string[]>(product.contraindicationsJson, []),
    whyRecommended: product.whyRecommended
  };
}

export function serializeContent(item: {
  id: string;
  slug: string;
  type: string;
  title: string;
  summary: string;
  body: string;
  category: string;
  tagsJson: string;
  relatedProductIdsJson: string;
  citationsJson: string;
  publishedAt: Date;
}) {
  return {
    id: item.id,
    slug: item.slug,
    type: item.type,
    title: item.title,
    summary: item.summary,
    body: item.body,
    category: item.category,
    tags: readJson<string[]>(item.tagsJson, []),
    relatedProductIds: readJson<string[]>(item.relatedProductIdsJson, []),
    citations: readJson<string[]>(item.citationsJson, []),
    publishedAt: item.publishedAt.toISOString()
  };
}

export function serializeLab(lab: {
  id: string;
  name: string;
  value: number;
  unit: string;
  reference: string;
  status: string;
  explanation: string;
  actionsJson: string;
  relatedTagsJson: string;
  createdAt: Date;
}) {
  return {
    id: lab.id,
    name: lab.name,
    value: lab.value,
    unit: lab.unit,
    reference: lab.reference,
    status: lab.status,
    explanation: lab.explanation,
    actions: readJson<string[]>(lab.actionsJson, []),
    relatedTags: readJson<string[]>(lab.relatedTagsJson, []),
    createdAt: lab.createdAt.toISOString()
  };
}

export function nutritionForFoodLog(entry: {
  foodId?: string | null;
  foodName?: string | null;
  grams: number;
  calories?: number | null;
  protein?: number | null;
  fat?: number | null;
  carbs?: number | null;
}) {
  if (typeof entry.calories === "number") {
    return {
      calories: entry.calories,
      protein: entry.protein || 0,
      fat: entry.fat || 0,
      carbs: entry.carbs || 0
    };
  }
  const item = entry.foodId ? foodItems.find((food) => food.id === entry.foodId) : undefined;
  if (!item) return { calories: 0, protein: 0, fat: 0, carbs: 0 };
  const ratio = entry.grams / 100;
  return {
    calories: item.caloriesPer100g * ratio,
    protein: item.proteinPer100g * ratio,
    fat: item.fatPer100g * ratio,
    carbs: item.carbsPer100g * ratio
  };
}

export function displayNameForFoodLog(entry: { foodId?: string | null; foodName?: string | null }) {
  if (entry.foodName) return entry.foodName;
  return foodItems.find((food) => food.id === entry.foodId)?.name || entry.foodId || "Продукт";
}

export function serializeFoodLog(entry: {
  id: string;
  foodId: string | null;
  foodName: string | null;
  grams: number;
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbs: number | null;
  source: string;
  confidence: number | null;
  notes: string | null;
  uploadId: string | null;
  createdAt: Date;
}) {
  const nutrition = nutritionForFoodLog(entry);
  return {
    ...entry,
    displayName: displayNameForFoodLog(entry),
    calories: Math.round(nutrition.calories),
    protein: Math.round(nutrition.protein * 10) / 10,
    fat: Math.round(nutrition.fat * 10) / 10,
    carbs: Math.round(nutrition.carbs * 10) / 10,
    createdAt: entry.createdAt.toISOString()
  };
}

export function calculateDailySummary(
  foodLog: Array<{
    foodId?: string | null;
    foodName?: string | null;
    grams: number;
    calories?: number | null;
    protein?: number | null;
    fat?: number | null;
    carbs?: number | null;
  }>,
  waterLog: Array<{ ml: number }>,
  profile: PublicProfile
) {
  const baseCalories = profile.goal === "Похудение" ? 1750 : profile.goal === "Набор массы" ? 2450 : 2050;
  const proteinGoal = profile.activityLevel === "Высокая" || profile.goal === "Спорт" ? 120 : 96;
  const totals = foodLog.reduce(
    (acc, entry) => {
      const nutrition = nutritionForFoodLog(entry);
      acc.calories += nutrition.calories;
      acc.protein += nutrition.protein;
      acc.fat += nutrition.fat;
      acc.carbs += nutrition.carbs;
      return acc;
    },
    { calories: 0, protein: 0, fat: 0, carbs: 0 }
  );
  const water = waterLog.reduce((sum, entry) => sum + entry.ml, 0);

  return {
    caloriesEaten: Math.round(totals.calories),
    calorieGoal: baseCalories,
    protein: Math.round(totals.protein),
    proteinGoal,
    fat: Math.round(totals.fat),
    fatGoal: 68,
    carbs: Math.round(totals.carbs),
    carbsGoal: 230,
    water,
    waterGoal: profile.activityLevel === "Высокая" ? 2600 : 2200,
    sleepHours: 6.7,
    steps: 7420,
    energy: profile.symptoms.includes("Усталость") ? 62 : 78,
    mood: profile.symptoms.includes("Стресс") ? "Нужен спокойный темп" : "Ровное состояние"
  };
}

export async function getUserContext(userId: string) {
  const profileModel = await prisma.profile.findUniqueOrThrow({ where: { userId } });
  const [foodLog, waterLog, labs, products] = await Promise.all([
    prisma.foodLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.waterLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.labResult.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.product.findMany()
  ]);
  const profile = serializeProfile(profileModel);
  const summary = calculateDailySummary(foodLog, waterLog, profile);
  return {
    profile,
    summary,
    foodLog: foodLog.map(serializeFoodLog),
    waterLog,
    labs: labs.map(serializeLab),
    products: products.map(serializeProduct)
  };
}

export function buildInsight(summary: ReturnType<typeof calculateDailySummary>, labs: ReturnType<typeof serializeLab>[], profile: PublicProfile) {
  const parts: string[] = [];
  if (summary.water < summary.waterGoal * 0.65) parts.push("сегодня мало воды");
  if (summary.protein < summary.proteinGoal * 0.65) parts.push("белок пока ниже цели");
  if (labs.some((lab) => lab.name === "Витамин D" && lab.status === "low")) parts.push("витамин D выглядит сниженным");
  if (profile.symptoms.includes("Стресс")) parts.push("стресс может усиливать усталость");
  return parts.length
    ? `Сегодня ${parts.join(", ")}. Начни с простого: вода, белковый прием пищи и спокойный вечерний ритм.`
    : "Сегодня база выглядит ровно: вода, питание и активность идут без резких провалов.";
}

export function recommendProducts(
  profile: PublicProfile,
  summary: ReturnType<typeof calculateDailySummary>,
  labs: ReturnType<typeof serializeLab>[],
  products: ReturnType<typeof serializeProduct>[],
  limit = 3
) {
  const allergies = profile.allergies.map((item) => item.toLowerCase());
  return products
    .map((product) => {
      const safetyText = [...product.contraindications, ...product.notFor, ...product.composition].join(" ").toLowerCase();
      if (allergies.some((allergy) => allergy && safetyText.includes(allergy))) return null;
      let score = 0;
      const reasons: string[] = [];
      const tags = product.tags.join(" ").toLowerCase();
      if (tags.includes(profile.goal.toLowerCase())) {
        score += 3;
        reasons.push(`цель: ${profile.goal.toLowerCase()}`);
      }
      for (const symptom of profile.symptoms) {
        if (tags.includes(symptom.toLowerCase())) {
          score += 2;
          reasons.push(`симптом: ${symptom.toLowerCase()}`);
        }
      }
      if (summary.protein < summary.proteinGoal * 0.7 && tags.includes("протеин")) {
        score += 4;
        reasons.push("белок ниже дневной цели");
      }
      if (profile.dietRestrictions.some((item) => item.toLowerCase().includes("мало рыбы")) && tags.includes("омега")) {
        score += 3;
        reasons.push("в рационе мало рыбы");
      }
      for (const lab of labs) {
        if (lab.status !== "normal" && product.tags.some((tag) => lab.relatedTags.includes(tag))) {
          score += lab.status === "consult" ? 2 : 3;
          reasons.push(`связан с показателем: ${lab.name}`);
        }
      }
      if (product.category === "железо" && !labs.some((lab) => lab.name === "Ферритин" && lab.status === "consult")) score -= 5;
      return score > 0
        ? {
            product,
            confidence: Math.min(94, 62 + score * 5),
            reason: `Подходит, потому что ${reasons.slice(0, 3).join(", ")}. Это информационная рекомендация, не замена консультации врача.`
          }
        : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

function productMatchesMessage(message: string, product: ReturnType<typeof serializeProduct>) {
  const haystack = [
    product.name,
    product.category,
    product.description,
    ...product.tags,
    ...product.goodFor,
    ...product.nutrients
  ].join(" ").toLowerCase();

  return haystack.includes(message);
}

export function recommendProductsForChat(
  message: string,
  profile: PublicProfile,
  summary: ReturnType<typeof calculateDailySummary>,
  labs: ReturnType<typeof serializeLab>[],
  products: ReturnType<typeof serializeProduct>[],
  limit = 3
) {
  const normalized = message.toLowerCase();
  const wantsProducts = /добав|витамин|бад|протеин|омега|магни|желез|что принимать|что попить|подобра|посовет|рекоменд|купить|продукт/.test(normalized);
  const asksAboutLabs = /анализ|ферритин|витамин d|желез|дефицит|показател/.test(normalized);
  const asksAboutProtein = /белок|протеин|перекус|после тренировки|после трен|добрать белок/.test(normalized);
  const asksAboutSleepOrStress = /сон|засып|стресс|трево|вечер|восстанов/.test(normalized);
  const asksAboutFishOrOmega = /рыб|омега/.test(normalized);
  const productContextIntent = wantsProducts || asksAboutProtein || asksAboutFishOrOmega || asksAboutLabs;
  const allergies = profile.allergies.map((item) => item.toLowerCase());
  const safeProducts = products.filter((product) => {
    const safetyText = [...product.contraindications, ...product.notFor, ...product.composition].join(" ").toLowerCase();
    return !allergies.some((allergy) => allergy && safetyText.includes(allergy));
  });

  const baseRecommendations = recommendProducts(profile, summary, labs, products, Math.max(limit * 2, 6));

  const contextual = baseRecommendations.filter((item) => {
    const product = item.product;
    const directMatch = productMatchesMessage(normalized, product);
    const labMatch = asksAboutLabs && labs.some((lab) => lab.status !== "normal" && product.tags.some((tag) => lab.relatedTags.includes(tag)));
    const topicMatch =
      (asksAboutProtein && product.tags.some((tag) => /белок|протеин/.test(tag.toLowerCase()))) ||
      (asksAboutSleepOrStress && product.tags.some((tag) => /сон|стресс|восстанов/.test(tag.toLowerCase()))) ||
      (asksAboutFishOrOmega && product.tags.some((tag) => /омега|рыб/.test(tag.toLowerCase())));
    const profileNeedMatch =
      (summary.protein < summary.proteinGoal * 0.7 && product.tags.some((tag) => /белок|протеин/.test(tag.toLowerCase()))) ||
      (profile.dietRestrictions.some((item) => item.toLowerCase().includes("мало рыбы")) && product.tags.some((tag) => /омега/.test(tag.toLowerCase())));

    if (directMatch || labMatch) return true;
    if (productContextIntent && topicMatch) return true;
    if (wantsProducts && profileNeedMatch) return true;
    return false;
  });

  if (contextual.length) return contextual.slice(0, limit);
  if (asksAboutProtein) {
    return safeProducts
      .filter((product) => product.tags.some((tag) => /белок|протеин/.test(tag.toLowerCase())))
      .map((product) => ({
        product,
        confidence: 78,
        reason: "Подходит по текущему запросу про добор белка. Это информационная рекомендация, не замена консультации врача."
      }))
      .slice(0, limit);
  }
  if (asksAboutFishOrOmega) {
    return safeProducts
      .filter((product) => product.tags.some((tag) => /омега|рыб/.test(tag.toLowerCase())))
      .map((product) => ({
        product,
        confidence: 76,
        reason: "Подходит по текущему запросу про рыбу или омега-3. Это информационная рекомендация, не замена консультации врача."
      }))
      .slice(0, limit);
  }
  if (wantsProducts) return baseRecommendations.slice(0, limit);
  return [];
}

export async function persistParsedLabs(userId: string, sourceFileId: string, labs: Array<{
  name: string;
  value: number;
  unit: string;
  reference: string;
  status: string;
  explanation: string;
  actions: string[];
  relatedTags: string[];
}>) {
  const created = await Promise.all(
    labs.map((lab) =>
      prisma.labResult.create({
        data: {
          userId,
          sourceFileId,
          name: lab.name,
          value: lab.value,
          unit: lab.unit,
          reference: lab.reference,
          status: lab.status,
          explanation: lab.explanation,
          actionsJson: writeJson(lab.actions),
          relatedTagsJson: writeJson(lab.relatedTags)
        }
      })
    )
  );
  return created.map(serializeLab);
}
