import { describe, expect, it } from "vitest";
import { labTemplate, products } from "../src/data/mock.js";
import { calculateDailySummary, recommendProducts, recommendProductsForChat } from "../src/services/domain.js";

const profile = {
  name: "Алина",
  age: 32,
  sex: "Женский",
  height: 168,
  weight: 64,
  goal: "Энергия",
  activityLevel: "Умеренная",
  wellbeing: "Стресс",
  dietRestrictions: ["мало рыбы в рационе"],
  allergies: [],
  currentSupplements: ["витамин C"],
  symptoms: ["Усталость", "Стресс"],
  medicalConsent: true
};

const serializedProducts = products.map((product) => ({
  ...product
}));

describe("domain calculations", () => {
  it("calculates nutrition and water summary from logs", () => {
    const summary = calculateDailySummary([{ foodId: "chicken", grams: 100 }], [{ ml: 500 }, { ml: 250 }], profile);
    expect(summary.protein).toBe(31);
    expect(summary.water).toBe(750);
    expect(summary.waterGoal).toBe(2200);
  });

  it("filters unsafe products by allergy text", () => {
    const recommendations = recommendProducts(
      { ...profile, allergies: ["молоко"] },
      calculateDailySummary([], [], profile),
      [],
      serializedProducts,
      10
    );
    expect(recommendations.some((item) => item.product.id === "protein-vanilla")).toBe(false);
  });

  it("uses lab tags to recommend relevant products cautiously", () => {
    const labs = labTemplate.map((lab, index) => ({
      ...lab,
      id: String(index),
      createdAt: new Date().toISOString()
    }));
    const recommendations = recommendProducts(profile, calculateDailySummary([], [], profile), labs, serializedProducts, 5);
    expect(recommendations.some((item) => item.product.id === "vitd-softdrops")).toBe(true);
    expect(recommendations.every((item) => item.reason.includes("информационная рекомендация"))).toBe(true);
  });

  it("does not inject products into generic chat questions", () => {
    const recommendations = recommendProductsForChat(
      "Что съесть вечером?",
      profile,
      calculateDailySummary([], [], profile),
      [],
      serializedProducts,
      3
    );
    expect(recommendations).toHaveLength(0);
  });

  it("shows protein products in chat only when the question is contextual", () => {
    const recommendations = recommendProductsForChat(
      "Как добрать белок после тренировки?",
      profile,
      calculateDailySummary([], [], profile),
      [],
      serializedProducts,
      3
    );
    expect(recommendations.some((item) => item.product.id === "protein-vanilla")).toBe(true);
  });
});
