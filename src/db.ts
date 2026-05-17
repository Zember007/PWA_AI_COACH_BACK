import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export function readJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(value: unknown) {
  return JSON.stringify(value);
}

