PRAGMA foreign_keys=OFF;

CREATE TABLE "new_FoodLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "foodId" TEXT,
  "foodName" TEXT,
  "grams" INTEGER NOT NULL,
  "calories" INTEGER,
  "protein" REAL,
  "fat" REAL,
  "carbs" REAL,
  "source" TEXT NOT NULL DEFAULT 'catalog',
  "confidence" REAL,
  "notes" TEXT,
  "uploadId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FoodLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_FoodLog" (
  "id",
  "userId",
  "foodId",
  "foodName",
  "grams",
  "calories",
  "protein",
  "fat",
  "carbs",
  "source",
  "confidence",
  "notes",
  "uploadId",
  "createdAt"
)
SELECT
  "id",
  "userId",
  "foodId",
  "foodName",
  "grams",
  "calories",
  "protein",
  "fat",
  "carbs",
  "source",
  "confidence",
  "notes",
  "uploadId",
  "createdAt"
FROM "FoodLog";

DROP TABLE "FoodLog";
ALTER TABLE "new_FoodLog" RENAME TO "FoodLog";

PRAGMA foreign_keys=ON;
