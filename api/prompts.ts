import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "./verify.js";
import { PromptCreateSchema, PromptUpdateSchema } from "../src/lib/schemas.js";
import { safeLog } from "./lib/log.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Field allowlists are defense-in-depth. Strict Zod schema is the primary
// gate (any unknown field returns 400). Allowlists guarantee that even if a
// future schema regression lets unknown fields through, only these columns
// are sent to Postgres.
const POST_ALLOWED_FIELDS = [
  "title",
  "content",
  "category",
  "tags",
  "variables",
  "created_by",
] as const;

const PUT_ALLOWED_FIELDS = [
  "title",
  "content",
  "category",
  "tags",
  "variables",
] as const;

function pickFields<T extends object>(
  data: T,
  allowed: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => allowed.includes(k))
  );
}

function authenticate(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return verifyToken(auth.slice(7));
}

function badRequest(res: VercelResponse, issues: string[]) {
  return res.status(400).json({
    error: "Invalid payload",
    details: issues,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  if (!authenticate(req)) {
    safeLog({ endpoint: "/api/prompts", method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const id = req.query.id as string | undefined;

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("prompts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      safeLog({
        endpoint: "/api/prompts",
        method: "GET",
        status: 500,
        errorCode: "SUPABASE_SELECT",
      });
      return res.status(500).json({ error: error.message });
    }
    safeLog({
      endpoint: "/api/prompts",
      method: "GET",
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return res.status(200).json(data);
  }

  if (req.method === "POST") {
    const parsed = PromptCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      );
      safeLog({
        endpoint: "/api/prompts",
        method: "POST",
        status: 400,
        errorCode: "ZOD",
      });
      return badRequest(res, issues);
    }
    const insertData = pickFields(parsed.data, POST_ALLOWED_FIELDS);
    const { data, error } = await supabase
      .from("prompts")
      .insert(insertData)
      .select()
      .single();
    if (error) {
      safeLog({
        endpoint: "/api/prompts",
        method: "POST",
        status: 500,
        errorCode: "SUPABASE_INSERT",
      });
      return res.status(500).json({ error: error.message });
    }
    safeLog({
      endpoint: "/api/prompts",
      method: "POST",
      status: 201,
      durationMs: Date.now() - startedAt,
    });
    return res.status(201).json(data);
  }

  if (req.method === "PUT" && id) {
    const parsed = PromptUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      );
      safeLog({
        endpoint: "/api/prompts",
        method: "PUT",
        status: 400,
        errorCode: "ZOD",
      });
      return badRequest(res, issues);
    }
    const updateData = pickFields(parsed.data, PUT_ALLOWED_FIELDS);
    const { data, error } = await supabase
      .from("prompts")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      safeLog({
        endpoint: "/api/prompts",
        method: "PUT",
        status: 500,
        errorCode: "SUPABASE_UPDATE",
      });
      return res.status(500).json({ error: error.message });
    }
    safeLog({
      endpoint: "/api/prompts",
      method: "PUT",
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE" && id) {
    const { error } = await supabase.from("prompts").delete().eq("id", id);
    if (error) {
      safeLog({
        endpoint: "/api/prompts",
        method: "DELETE",
        status: 500,
        errorCode: "SUPABASE_DELETE",
      });
      return res.status(500).json({ error: error.message });
    }
    safeLog({
      endpoint: "/api/prompts",
      method: "DELETE",
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    return res.status(200).json({ success: true });
  }

  safeLog({ endpoint: "/api/prompts", method: req.method, status: 405 });
  return res.status(405).json({ error: "Method not allowed" });
}
