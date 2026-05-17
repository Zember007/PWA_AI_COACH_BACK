import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

if (process.env.NODE_ENV !== "test") {
  dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });
}

if (process.env.NODE_ENV === "test" && !process.env.UPLOAD_DIR) {
  process.env.UPLOAD_DIR = path.join(os.tmpdir(), "pwa-ai-coach-test-uploads");
}

const envSchema = z.object({
  DATABASE_URL: z.string().default("file:./dev.db"),
  PORT: z.coerce.number().default(4100),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(16).default("dev-secret-change-before-production"),
  REFRESH_COOKIE_NAME: z.string().default("ai_coach_refresh"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.5"),
  OPENAI_VECTOR_STORE_IDS: z.string().default(""),
  UPLOAD_DIR: z.string().default("./uploads")
});

const parsed = envSchema.parse(process.env);

const webOrigins = parsed.WEB_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const config = {
  ...parsed,
  /** Явно разрешённые браузерные Origin (из WEB_ORIGIN, через запятую). */
  webOrigins: webOrigins.length > 0 ? webOrigins : ["http://localhost:5173"]
};

export const vectorStoreIds = config.OPENAI_VECTOR_STORE_IDS.split(",")
  .map((id) => id.trim())
  .filter(Boolean);
