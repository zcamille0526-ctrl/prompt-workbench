import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { verifyToken } from "./verify.js";
import { safeLog } from "./lib/log.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// strict: reject any unknown field (consistent with /api/prompts)
const RequestSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

function authenticate(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return verifyToken(auth.slice(7));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  if (!authenticate(req)) {
    safeLog({ endpoint: "/api/use-count", method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    safeLog({ endpoint: "/api/use-count", method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    safeLog({
      endpoint: "/api/use-count",
      method: "POST",
      status: 400,
      errorCode: "ZOD",
    });
    return res.status(400).json({
      error: "Invalid payload",
      details: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      ),
    });
  }

  // Atomic increment via SQL expression. Two concurrent requests will both
  // produce correct +1 results because Postgres serializes the UPDATE.
  // No SELECT step (avoids the read-modify-write race window).
  // Affecting 0 rows (prompt deleted between fetch and copy) is silently
  // accepted to keep the copy flow non-blocking.
  const { error } = await supabase.rpc("increment_use_count", {
    p_id: parsed.data.id,
  });

  if (error) {
    safeLog({
      endpoint: "/api/use-count",
      method: "POST",
      status: 500,
      errorCode: "SUPABASE_RPC",
    });
    return res.status(500).json({ error: error.message });
  }

  safeLog({
    endpoint: "/api/use-count",
    method: "POST",
    status: 200,
    durationMs: Date.now() - startedAt,
  });
  return res.status(200).json({ success: true });
}
