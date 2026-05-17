import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { prisma } from "../src/db.js";
import { persistParsedLabs } from "../src/services/domain.js";

const email = "route-test@health.local";

async function createUser(password = "current-password") {
  await prisma.user.deleteMany({ where: { email } });
  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password)
    }
  });
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, password = "current-password") {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password }
  });
  return response.json<{ accessToken: string }>().accessToken;
}

async function createProfile(userId: string) {
  return prisma.profile.create({
    data: {
      userId,
      name: "Ирина",
      age: 29,
      sex: "Женский",
      height: 170,
      weight: 62,
      goal: "Энергия",
      activityLevel: "Умеренная",
      wellbeing: "Нормальное",
      dietRestrictionsJson: "[]",
      allergiesJson: "[]",
      currentSupplementsJson: "[]",
      symptomsJson: "[]",
      medicalConsent: true
    }
  });
}

describe("cors", () => {
  it("does not allow private network origins in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/profile",
        headers: {
          origin: "http://192.168.1.10:5173",
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "authorization,content-type"
        }
      });

      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it.each(["http://0.0.0.0:5173", "http://192.168.1.10:5173"])(
    "allows development preflight requests from %s",
    async (origin) => {
      const app = await buildApp();

      const response = await app.inject({
        method: "OPTIONS",
        url: "/profile",
        headers: {
          origin,
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "authorization,content-type"
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-methods"] ?? "").toMatch(/\bPATCH\b/i);
      await app.close();
    }
  );
});

describe("authenticated routes", () => {
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { email } });
  });

  it("reports readiness when the database is reachable", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/ready"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });

  it("changes password when current password is valid", async () => {
    const app = await buildApp();
    const user = await createUser();
    const token = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "current-password", newPassword: "next-password" }
    });

    expect(response.statusCode).toBe(200);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("next-password", updated.passwordHash)).toBe(true);
    await app.close();
  });

  it("rejects protected routes without an access token", async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/me"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("rotates refresh tokens and rejects a reused refresh cookie", async () => {
    const app = await buildApp();
    await createUser();

    const loginResponse = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "current-password" }
    });
    const cookie = loginResponse.cookies[0];
    const cookieHeader = `${cookie.name}=${cookie.value}`;

    const firstRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: cookieHeader }
    });
    const secondRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { cookie: cookieHeader }
    });

    expect(firstRefresh.statusCode).toBe(200);
    expect(firstRefresh.json().accessToken).toEqual(expect.any(String));
    expect(secondRefresh.statusCode).toBe(401);
    expect(secondRefresh.json().error.code).toBe("BAD_REFRESH");
    await app.close();
  });

  it("rejects password change with wrong current password", async () => {
    const app = await buildApp();
    await createUser();
    const token = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "wrong-password", newPassword: "next-password" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("Текущий пароль не подошёл");
    await app.close();
  });

  it("rejects short new password", async () => {
    const app = await buildApp();
    await createUser();
    const token = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "current-password", newPassword: "short" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("registers without a prefilled profile and creates profile on first save", async () => {
    const app = await buildApp();
    await prisma.user.deleteMany({ where: { email } });

    const registerResponse = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "current-password" }
    });
    const token = registerResponse.json<{ accessToken: string }>().accessToken;
    const meResponse = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(registerResponse.statusCode).toBe(200);
    expect(meResponse.json().profile).toBeNull();

    const profileResponse = await app.inject({
      method: "PATCH",
      url: "/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Ирина",
        age: 29,
        sex: "Женский",
        height: 170,
        weight: 62,
        goal: "Энергия",
        activityLevel: "Умеренная",
        wellbeing: "Нормальное",
        dietRestrictions: [],
        allergies: [],
        currentSupplements: [],
        symptoms: [],
        medicalConsent: true
      }
    });

    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json().profile.name).toBe("Ирина");
    expect(profileResponse.json().profile.currentSupplements).toEqual([]);
    await app.close();
  });

  it("stores custom food and water container in the diary summary", async () => {
    const app = await buildApp();
    const user = await createUser();
    await createProfile(user.id);
    const token = await login(app);

    const foodResponse = await app.inject({
      method: "POST",
      url: "/food-log",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: "Боул с курицей",
        grams: 320,
        calories: 610,
        protein: 34,
        fat: 20,
        carbs: 72
      }
    });
    const waterResponse = await app.inject({
      method: "POST",
      url: "/water-log",
      headers: { authorization: `Bearer ${token}` },
      payload: { ml: 500, container: "бутылка" }
    });
    const summaryResponse = await app.inject({
      method: "GET",
      url: "/daily-summary",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(foodResponse.statusCode).toBe(200);
    expect(foodResponse.json().entry.displayName).toBe("Боул с курицей");
    expect(foodResponse.json().entry.source).toBe("manual");
    expect(waterResponse.statusCode).toBe(200);
    expect(waterResponse.json().entry.container).toBe("бутылка");
    expect(summaryResponse.json().summary.caloriesEaten).toBe(610);
    expect(summaryResponse.json().summary.protein).toBe(34);
    expect(summaryResponse.json().summary.water).toBe(500);
    await app.close();
  });

  it("does not stream coach answers when OpenAI is not configured", async () => {
    const app = await buildApp();
    await createUser();
    const token = await login(app);

    const response = await app.inject({
      method: "POST",
      url: "/chat/stream",
      headers: { authorization: `Bearer ${token}` },
      payload: { message: "Как добрать белок?" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toBe("Коуч временно недоступен. Попробуйте позже.");
    await app.close();
  });

  it("creates a new empty chat without deleting previous conversations", async () => {
    const app = await buildApp();
    await createUser();
    const token = await login(app);

    const first = await app.inject({
      method: "POST",
      url: "/chat/conversations",
      headers: { authorization: `Bearer ${token}` }
    });
    const second = await app.inject({
      method: "POST",
      url: "/chat/conversations",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().conversation.id).not.toBe(first.json().conversation.id);
    expect(await prisma.conversation.count({ where: { userId: (await prisma.user.findUniqueOrThrow({ where: { email } })).id } })).toBe(2);
    await app.close();
  });

  it("analyzes diary food photos without creating a coach conversation", async () => {
    const app = await buildApp();
    const user = await createUser();
    const token = await login(app);
    const boundary = "----ai-coach-food-photo-boundary";
    const body = Buffer.from([
      `--${boundary}`,
      "Content-Disposition: form-data; name=\"file\"; filename=\"meal.png\"",
      "Content-Type: image/png",
      "",
      "not-a-real-image",
      `--${boundary}--`,
      ""
    ].join("\r\n"));

    const response = await app.inject({
      method: "POST",
      url: "/food-photo",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().vectorStore.status).toBe("skipped");
    expect(await prisma.conversation.count({ where: { userId: user.id } })).toBe(0);
    await app.close();
  });

  it("keeps old lab results when new parsed labs are saved", async () => {
    const user = await createUser();

    await persistParsedLabs(user.id, "upload-old", [{
      name: "Ферритин",
      value: 22,
      unit: "нг/мл",
      reference: "30-150",
      status: "low",
      explanation: "Ниже референса",
      actions: ["обсудить с врачом"],
      relatedTags: ["железо"]
    }]);
    await persistParsedLabs(user.id, "upload-new", [{
      name: "Витамин D",
      value: 28,
      unit: "нг/мл",
      reference: "30-100",
      status: "low",
      explanation: "Ниже желательного диапазона",
      actions: ["сверить с врачом"],
      relatedTags: ["витамин D"]
    }]);

    const labs = await prisma.labResult.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } });
    expect(labs.map((lab) => lab.name)).toEqual(["Витамин D", "Ферритин"]);
  });

  it("stores uploaded chat file messages and marks vector store as skipped without configured storage", async () => {
    const app = await buildApp();
    await createUser();
    const token = await login(app);
    const conversationResponse = await app.inject({
      method: "POST",
      url: "/chat/conversations",
      headers: { authorization: `Bearer ${token}` }
    });
    const conversationId = conversationResponse.json().conversation.id;
    const boundary = "----ai-coach-test-boundary";
    const body = Buffer.from([
      `--${boundary}`,
      "Content-Disposition: form-data; name=\"message\"",
      "",
      "Проверь мои анализы",
      `--${boundary}`,
      "Content-Disposition: form-data; name=\"file\"; filename=\"labs.txt\"",
      "Content-Type: text/plain",
      "",
      "Ферритин 22 нг/мл референс 30-150",
      `--${boundary}--`,
      ""
    ].join("\r\n"));

    const response = await app.inject({
      method: "POST",
      url: `/chat/${conversationId}/files`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().vectorStore.status).toBe("skipped");
    expect(await prisma.upload.count({ where: { conversationId, vectorStoreStatus: "skipped" } })).toBe(1);
    expect(await prisma.chatMessage.count({ where: { conversationId } })).toBe(2);
    await app.close();
  });
});
