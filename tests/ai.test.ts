import { describe, expect, it } from "vitest";
import { AgentUnavailableError, buildLabVectorStoreDocument, createAgentResponse, labFilePurposeForMime, labInputContentForUploadedFile, uploadLabsToVectorStore } from "../src/services/ai.js";

describe("AI service availability", () => {
  it("does not generate a local answer when OpenAI is not configured", async () => {
    await expect(createAgentResponse("Как добрать белок?", {} as any, [])).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("uses vision upload and input_image for lab photos", () => {
    expect(labFilePurposeForMime("image/jpeg")).toBe("vision");
    expect(labInputContentForUploadedFile("file_123", "image/jpeg")).toEqual([
      { type: "input_image", file_id: "file_123", detail: "high" }
    ]);
  });

  it("uses file input for document uploads", () => {
    expect(labFilePurposeForMime("application/pdf")).toBe("user_data");
    expect(labInputContentForUploadedFile("file_123", "application/pdf")).toEqual([
      { type: "input_file", file_id: "file_123" }
    ]);
  });

  it("skips vector store upload when no vector store is configured", async () => {
    await expect(uploadLabsToVectorStore({
      uploadId: "upload_1",
      conversationId: "conversation_1",
      originalName: "labs.jpg",
      mimeType: "image/jpeg",
      createdAt: new Date("2026-05-17T00:00:00.000Z"),
      labs: []
    })).resolves.toEqual({ status: "skipped" });
  });

  it("includes normalized source text in the vector store document", () => {
    const document = JSON.parse(buildLabVectorStoreDocument({
      uploadId: "upload_1",
      conversationId: "conversation_1",
      originalName: "labs.jpg",
      mimeType: "image/jpeg",
      createdAt: new Date("2026-05-17T00:00:00.000Z"),
      sourceText: "  Ферритин 22 \r\n \n Референс 30-150 ",
      analysisStatus: "needs_review",
      explanation: "Часть строк распознана",
      labs: []
    }));

    expect(document.sourceText).toBe("Ферритин 22\nРеференс 30-150");
    expect(document.analysisStatus).toBe("needs_review");
  });
});
