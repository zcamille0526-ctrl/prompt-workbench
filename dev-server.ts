import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
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

const app = express();
const PORT = 3001;

// 100KB limit aligns with the production bodyParser.sizeLimit; oversize POST/PUT
// are rejected before they reach handler code, matching prod behavior locally.
app.use(express.json({ limit: "100kb" }));

type VercelHandler = (
  req: VercelRequest,
  res: VercelResponse
) => Promise<unknown> | unknown;

const adapt =
  (handler: VercelHandler) =>
  async (req: ExpressRequest, res: ExpressResponse) => {
    await handler(
      req as unknown as VercelRequest,
      res as unknown as VercelResponse
    );
  };

app.all("/api/prompts", adapt(promptsHandler));
app.post("/api/use-count", adapt(useCountHandler));
app.post("/api/chat", adapt(chatHandler));
app.all("/api/examples", adapt(examplesHandler));
app.all("/api/categories", adapt(categoriesHandler));

// Phase 2 auth routes (Step 1). Vercel routes /api/auth/<x>.ts to
// /api/auth/<x>; mirror that here so AuthScreen / AuthCallback work
// against the local dev server.
app.post("/api/auth/signup", adapt(signupHandler));
app.post("/api/auth/setup-account", adapt(setupAccountHandler));
app.post("/api/auth/login", adapt(loginHandler));
// me/logout/refresh share one handler in production (Vercel Hobby plan
// caps deployments at 12 functions). Production rewrites in vercel.json
// pass `?action=me|logout|refresh`. Mirror that locally.
const sessionAdapter =
  (action: "me" | "logout" | "refresh") =>
  (req: ExpressRequest, res: ExpressResponse) => {
    (req as ExpressRequest & { query: Record<string, string> }).query = {
      ...(req.query as Record<string, string>),
      action,
    };
    return adapt(sessionHandler)(req, res);
  };
app.post("/api/auth/refresh", sessionAdapter("refresh"));
app.post("/api/auth/logout", sessionAdapter("logout"));
app.get("/api/auth/me", sessionAdapter("me"));
app.post("/api/auth/resend-invite", adapt(resendInviteHandler));
app.patch("/api/profile/update", adapt(profileUpdateHandler));

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
