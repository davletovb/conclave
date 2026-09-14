import { describe, expect, it } from "vitest";
import { buildAntigravityChildEnv, parseAntigravityModels } from "./cli.js";

describe("Antigravity CLI transport", () => {
  it("discovers only Gemini models from the live agy catalog", () => {
    const models = parseAntigravityModels([
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT OSS 120B (Medium)",
      "gemini-3.8-flash-high\tduplicate",
      "",
    ].join("\n"));

    expect(models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    ]);
  });

  it("shadows direct API, custom-endpoint and Vertex billing routes while preserving normal process env", () => {
    const env = buildAntigravityChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      GEMINI_API_KEY: "secret",
      GOOGLE_API_KEY: "secret",
      GOOGLE_GENAI_API_KEY: "secret",
      ANTIGRAVITY_API_KEY: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_ACCESS_TOKEN: "token",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_PROJECT_ID: "project-id",
      GOOGLE_CLOUD_QUOTA_PROJECT: "quota",
      GOOGLE_CLOUD_LOCATION: "global",
      CLOUD_ML_PROJECT_ID: "ml-project",
      GOOGLE_GEMINI_BASE_URL: "https://example.invalid",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/example");
    for (const name of [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_API_KEY",
      "ANTIGRAVITY_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_ACCESS_TOKEN",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT_ID",
      "GOOGLE_CLOUD_QUOTA_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "CLOUD_ML_PROJECT_ID",
      "GOOGLE_GEMINI_BASE_URL",
    ]) {
      expect(env[name]).toBe("");
    }
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  });
});
