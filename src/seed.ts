import { defaultProfile, products, contentItems } from "./data/mock.js";
import { prisma, writeJson } from "./db.js";
import { hashPassword } from "./auth.js";
import { profileToCreate } from "./services/domain.js";

async function main() {
  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        name: product.name,
        category: product.category,
        price: product.price,
        description: product.description,
        compositionJson: writeJson(product.composition),
        goodForJson: writeJson(product.goodFor),
        notForJson: writeJson(product.notFor),
        tagsJson: writeJson(product.tags),
        rating: product.rating,
        imageTone: product.imageTone,
        nutrientsJson: writeJson(product.nutrients),
        contraindicationsJson: writeJson(product.contraindications),
        whyRecommended: product.whyRecommended
      },
      create: {
        id: product.id,
        name: product.name,
        category: product.category,
        price: product.price,
        description: product.description,
        compositionJson: writeJson(product.composition),
        goodForJson: writeJson(product.goodFor),
        notForJson: writeJson(product.notFor),
        tagsJson: writeJson(product.tags),
        rating: product.rating,
        imageTone: product.imageTone,
        nutrientsJson: writeJson(product.nutrients),
        contraindicationsJson: writeJson(product.contraindications),
        whyRecommended: product.whyRecommended
      }
    });
  }

  for (const item of contentItems) {
    await prisma.contentItem.upsert({
      where: { id: item.id },
      update: {
        slug: item.slug,
        type: item.type,
        title: item.title,
        summary: item.summary,
        body: item.body,
        category: item.category,
        tagsJson: writeJson(item.tags),
        relatedProductIdsJson: writeJson(item.relatedProductIds),
        citationsJson: writeJson(item.citations),
        publishedAt: new Date(item.publishedAt)
      },
      create: {
        id: item.id,
        slug: item.slug,
        type: item.type,
        title: item.title,
        summary: item.summary,
        body: item.body,
        category: item.category,
        tagsJson: writeJson(item.tags),
        relatedProductIdsJson: writeJson(item.relatedProductIds),
        citationsJson: writeJson(item.citations),
        publishedAt: new Date(item.publishedAt)
      }
    });
  }
  await prisma.contentItem.deleteMany({
    where: { id: { notIn: contentItems.map((item) => item.id) } }
  });

  const email = "demo@ai-coach.local";
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash: await hashPassword("demo-password")
    }
  });

  await prisma.profile.upsert({
    where: { userId: user.id },
    update: {},
    create: profileToCreate(user.id, defaultProfile)
  });

  await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await prisma.labResult.deleteMany({ where: { userId: user.id } });

  console.log(`Seed complete. Demo login: ${email} / demo-password`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
