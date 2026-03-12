import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const subagentsRoot = resolve(currentDir, "..");
const junebotRoot = resolve(subagentsRoot, "..", "junebot");

for (const envPath of [
  resolve(junebotRoot, ".env.local"),
  resolve(junebotRoot, ".env"),
  resolve(subagentsRoot, ".env.local"),
  resolve(subagentsRoot, ".env"),
]) {
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, override: false });
  }
}

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: {
    "X-Title": "Junebot Subagents CLI",
    "HTTP-Referer":
      process.env.PROD_APP_URL ||
      process.env.NEXT_PUBLIC_PROD_APP_URL ||
      "http://localhost:3000",
  },
});

export const env = {
  subagentsRoot,
  junebotRoot,
  googleWorkspaceMcpUrl:
    process.env.GOOGLE_WORKSPACE_MCP_URL ||
    "https://google-workspace-mcp-production-139b.up.railway.app/mcp",
  oauthRedirectUri:
    process.env.SUBAGENTS_OAUTH_REDIRECT_URI ||
    "http://localhost:4591/oauth/callback",
};

export const models = {
  main: openrouter.languageModel("anthropic/claude-sonnet-4.6"),
  worker: openrouter.languageModel("openai/gpt-5-nano"),
};
