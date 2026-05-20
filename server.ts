import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Load .env file manually so the server works regardless of how PM2 starts it
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // .env not found, rely on environment variables already set
}
import promptsHandler from "./api/prompts.js";
import useCountHandler from "./api/use-count.js";
import chatHandler from "./api/chat.js";
import examplesHandler from "./api/examples.js";
import categoriesHandler from "./api/categories.js";
import signupHandler from "./api/auth/signup.js";
import setupAccountHandler from "./api/auth/setup-account.js";
import loginHandler from "./api/auth/login.js";
import sessionHandler from "./api/auth/session.js";
import resendInviteHandler from "./api/auth/resend-invite.js";
import profileUpdateHandler from "./api/profile/update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8110;

const app = express();
app.use(express.json({ limit: "100kb" }));

type VercelHandler = (req: VercelRequest, res: VercelResponse) => Promise<unknown> | unknown;

const adapt =
  (handler: VercelHandler) =>
  async (req: ExpressRequest, res: ExpressResponse) => {
    await handler(req as unknown as VercelRequest, res as unknown as VercelResponse);
  };

app.all("/api/prompts", adapt(promptsHandler));
app.post("/api/use-count", adapt(useCountHandler));
app.post("/api/chat", adapt(chatHandler));
app.all("/api/examples", adapt(examplesHandler));
app.all("/api/categories", adapt(categoriesHandler));
app.post("/api/auth/signup", adapt(signupHandler));
app.post("/api/auth/setup-account", adapt(setupAccountHandler));
app.post("/api/auth/login", adapt(loginHandler));

const sessionAdapter =
  (action: "me" | "logout" | "refresh") =>
  (req: ExpressRequest, res: ExpressResponse) => {
    Object.defineProperty(req, "query", {
      value: { ...(req.query as Record<string, string>), action },
      writable: true,
      configurable: true,
    });
    return adapt(sessionHandler)(req, res);
  };
app.post("/api/auth/refresh", sessionAdapter("refresh"));
app.post("/api/auth/logout", sessionAdapter("logout"));
app.get("/api/auth/me", sessionAdapter("me"));
app.post("/api/auth/resend-invite", adapt(resendInviteHandler));
app.patch("/api/profile/update", adapt(profileUpdateHandler));

// Serve built frontend
app.use(express.static(join(__dirname, "dist")));

// SPA fallback — all non-API routes return index.html
app.get("/{*path}", (_req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
