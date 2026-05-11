import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import promptsHandler from "./api/prompts.js";
import useCountHandler from "./api/use-count.js";
import chatHandler from "./api/chat.js";
import examplesHandler from "./api/examples.js";
import signupHandler from "./api/auth/signup.js";
import setupAccountHandler from "./api/auth/setup-account.js";
import loginHandler from "./api/auth/login.js";
import refreshHandler from "./api/auth/refresh.js";
import logoutHandler from "./api/auth/logout.js";
import meHandler from "./api/auth/me.js";
import resendInviteHandler from "./api/auth/resend-invite.js";

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

// Phase 2 auth routes (Step 1). Vercel routes /api/auth/<x>.ts to
// /api/auth/<x>; mirror that here so AuthScreen / AuthCallback work
// against the local dev server.
app.post("/api/auth/signup", adapt(signupHandler));
app.post("/api/auth/setup-account", adapt(setupAccountHandler));
app.post("/api/auth/login", adapt(loginHandler));
app.post("/api/auth/refresh", adapt(refreshHandler));
app.post("/api/auth/logout", adapt(logoutHandler));
app.get("/api/auth/me", adapt(meHandler));
app.post("/api/auth/resend-invite", adapt(resendInviteHandler));

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
