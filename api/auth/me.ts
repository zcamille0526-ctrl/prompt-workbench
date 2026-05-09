import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticate } from "../lib/auth.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/auth/me";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: "GET", status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  safeLog({ endpoint: ENDPOINT, method: "GET", status: 200 });
  return res.status(200).json(user);
}
