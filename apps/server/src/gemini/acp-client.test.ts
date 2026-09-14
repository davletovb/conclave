import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGeminiAcpArgs, geminiOAuthCredentialPath } from "./acp-client.js";

const originalGeminiCliHome = process.env.GEMINI_CLI_HOME;

afterEach(() => {
  if (originalGeminiCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = originalGeminiCliHome;
});

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

  it("looks for OAuth where Gemini CLI looks when GEMINI_CLI_HOME is unset", () => {
    delete process.env.GEMINI_CLI_HOME;
    expect(geminiOAuthCredentialPath()).toBe(join(homedir(), ".gemini", "oauth_creds.json"));
  });

  it("respects GEMINI_CLI_HOME without reading the credential file", () => {
    process.env.GEMINI_CLI_HOME = join("/tmp", "gemini-home-for-conclave-test");
    expect(geminiOAuthCredentialPath()).toBe(
      join(process.env.GEMINI_CLI_HOME, ".gemini", "oauth_creds.json"),
    );
  });
});
