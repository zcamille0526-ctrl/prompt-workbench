import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import verifyHandler from "./api/verify.js";
import promptsHandler from "./api/prompts.js";
import useCountHandler from "./api/use-count.js";

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

app.post("/api/verify", adapt(verifyHandler));
app.all("/api/prompts", adapt(promptsHandler));
app.post("/api/use-count", adapt(useCountHandler));

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
