import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { authenticate } from "../lib/auth.js";
import { getServiceRoleClient } from "../lib/supabase.js";
import { safeLog } from "../lib/log.js";

const ENDPOINT = "/api/profile/update";

/**
 * Spec §5.1 + round-3 hardening: strict schema, only display_name allowed.
 *
 * Any extra field — most importantly is_admin, but also email / id / random
 * unknown keys — must produce a 400 rather than be silently dropped. This
 * mirrors the strict-reject style we use for prompts/examples and makes
 * both attack attempts and frontend bugs surface as visible errors.
 *
 * Order matters: trim() BEFORE min(1) so a body of "   " is rejected as
 * empty rather than passing min(1) on the raw 3-char string and then being
 * silently transformed into "" before the DB write.
 */
const ProfileUpdateSchema = z
  .object({
    display_name: z.string().trim().min(1).max(64),
  })
  .strict();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  if (req.method !== "PATCH") {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = ProfileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    safeLog({
      endpoint: ENDPOINT,
      method: "PATCH",
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

  const supabase = getServiceRoleClient();
  // Only update display_name. is_admin is intentionally absent from the
  // SET clause — even a hypothetical future bug that lets is_admin through
  // the schema would still hit a column that the service-role-only write
  // path doesn't touch here.
  const { data, error } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data.display_name })
    .eq("id", user.id)
    .select("display_name, is_admin")
    .single();

  if (error || !data) {
    safeLog({
      endpoint: ENDPOINT,
      method: "PATCH",
      status: 500,
      errorCode: "SUPABASE_UPDATE",
    });
    return res.status(500).json({ error: "PROFILE_UPDATE_FAILED" });
  }

  safeLog({
    endpoint: ENDPOINT,
    method: "PATCH",
    status: 200,
    durationMs: Date.now() - startedAt,
  });
  return res.status(200).json({
    id: user.id,
    email: user.email,
    display_name: data.display_name,
    is_admin: data.is_admin,
  });
}
