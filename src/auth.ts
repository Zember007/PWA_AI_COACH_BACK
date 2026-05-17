import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { prisma } from "./db.js";

export const accessTokenTtl = "15m";
const refreshTokenDays = 30;

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(app: FastifyInstance, userId: string) {
  return app.jwt.sign({ sub: userId }, { expiresIn: accessTokenTtl });
}

export async function issueRefreshToken(userId: string) {
  const token = crypto.randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + refreshTokenDays * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt
    }
  });
  return { token, expiresAt };
}

export function setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(config.REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt
  });
}

export function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(config.REFRESH_COOKIE_NAME, { path: "/" });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  try {
    const payload = await request.jwtVerify<{ sub: string }>();
    (request as FastifyRequest & { userId: string }).userId = payload.sub;
  } catch {
    return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "Требуется вход в аккаунт" } });
  }
}

