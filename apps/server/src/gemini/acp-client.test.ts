import { describe, expect, it } from "vitest";
import {
  buildGeminiAcpArgs,
  buildGeminiChildEnv,
  GEMINI_ISOLATED_WORKSPACE_SETTINGS,
  isGeminiInteractiveAuthOutput,
} from "./acp-client.js";

describe("Gemini ACP launch policy", () => {
  it("starts ACP with extensions disabled, MCP restricted, and a deny-all admin policy", () => {
    const args = buildGeminiAcpArgs("pro", "/tmp/deny-tools.toml", "__no_mcp__");

    expect(args).toEqual([
      "--acp",
      "--extensions", "none",
      "--allowed-mcp-server-names", "__no_mcp__",
      "--admin-policy", "/tmp/deny-tools.toml",
      "--model", "pro",
    ]);
  });

  it("does not add a model flag when Gemini CLI should choose automatically", () => {
    const args = buildGeminiAcpArgs(undefined, "/tmp/deny-tools.toml", "__no_mcp__");
    expect(args).not.toContain("--model");
  });

  it("forces an OAuth-only workspace without inherited memory or directory context", () => {
    expect(GEMINI_ISOLATED_WORKSPACE_SETTINGS).toMatchObject({
      security: { auth: { selectedType: "oauth-personal" } },
      hooksConfig: { enabled: false },
      skills: { enabled: false },
      ide: { enabled: false },
      experimental: { autoMemory: false },
      context: {
        includeDirectoryTree: false,
        loadMemoryFromIncludeDirectories: false,
      },
    });
    expect(GEMINI_ISOLATED_WORKSPACE_SETTINGS.context.fileName).not.toBe("GEMINI.md");
  });

  it("shadows API, Vertex, sandbox, IDE and model selectors so home .env files cannot restore them", () => {
    const env = buildGeminiChildEnv({
      PATH: "/usr/bin",
      GEMINI_API_KEY: "secret",
      GOOGLE_API_KEY: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_GENAI_USE_GCA: "true",
      GOOGLE_CLOUD_ACCESS_TOKEN: "token",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_PROJECT_ID: "project-id",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_CLOUD_QUOTA_PROJECT: "quota-project",
      CLOUD_ML_PROJECT_ID: "ml-project",
      GOOGLE_GEMINI_BASE_URL: "https://example.invalid",
      GEMINI_MODEL: "forced-model",
      GEMINI_SANDBOX: "docker",
      GEMINI_CLI_IDE_WORKSPACE_PATH: "/private/repo",
    });

    expect(env.PATH).toBe("/usr/bin");
    for (const name of [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_GENAI_USE_GCA",
      "GOOGLE_CLOUD_ACCESS_TOKEN",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT_ID",
      "GOOGLE_CLOUD_LOCATION",
      "GOOGLE_CLOUD_QUOTA_PROJECT",
      "CLOUD_ML_PROJECT_ID",
      "GOOGLE_GEMINI_BASE_URL",
      "GEMINI_MODEL",
      "GEMINI_SANDBOX",
      "GEMINI_CLI_IDE_WORKSPACE_PATH",
    ]) {
      expect(Object.hasOwn(env, name)).toBe(true);
      expect(env[name]).toBe("");
    }
    expect(env.NO_BROWSER).toBe("true");
    expect(env.GEMINI_CLI_SURFACE).toBe("conclave");
    expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
  });

  it("allows known ACP stdout banners but recognizes interactive authentication output", () => {
    expect(isGeminiInteractiveAuthOutput("")).toBe(false);
    expect(isGeminiInteractiveAuthOutput("Loaded cached credentials.")).toBe(false);
    expect(isGeminiInteractiveAuthOutput("Planner hook initialized")).toBe(false);
    expect(isGeminiInteractiveAuthOutput("Code Assist login required")).toBe(true);
    expect(isGeminiInteractiveAuthOutput("Attempting to open authentication page")).toBe(true);
    expect(isGeminiInteractiveAuthOutput("Open https://accounts.google.com/o/oauth2/v2/auth?client_id=x")).toBe(true);
    expect(isGeminiInteractiveAuthOutput("Enter the verification code")).toBe(true);
  });
});
