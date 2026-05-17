import { describe, expect, it } from "vitest";
import { assertProductionConfig } from "../src/config.js";

describe("production configuration", () => {
  it("rejects development defaults in production", () => {
    expect(() =>
      assertProductionConfig({
        NODE_ENV: "production",
        JWT_SECRET: "dev-secret-change-before-production",
        WEB_ORIGIN: "http://localhost:5173",
        DATABASE_URL: "file:./dev.db"
      })
    ).toThrow(/Invalid production configuration/);
  });

  it("accepts explicit production values", () => {
    expect(() =>
      assertProductionConfig({
        NODE_ENV: "production",
        JWT_SECRET: "a-production-secret-with-enough-entropy",
        WEB_ORIGIN: "https://coach.example.com",
        DATABASE_URL: "file:/data/coach.db"
      })
    ).not.toThrow();
  });
});
