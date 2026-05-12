import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  CategoryCreateSchema,
  CategoryRenameSchema,
  CategoryMoveSchema,
} from "../src/lib/schemas.js";
import { authenticate } from "./lib/auth.js";
import { getServiceRoleClient } from "./lib/supabase.js";
import { safeLog } from "./lib/log.js";

const ENDPOINT = "/api/categories";

function badRequest(res: VercelResponse, issues: string[]) {
  return res.status(400).json({ error: "Invalid payload", details: issues });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
  const supabase = getServiceRoleClient();

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("categories")
      .select("*")
      .order("display_order", { ascending: true });
    if (error) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 500, errorCode: "SUPABASE_SELECT" });
      return res.status(500).json({ error: error.message });
    }
    safeLog({ endpoint: ENDPOINT, method: "GET", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json({ categories: data ?? [] });
  }

  // All other methods are admin-only.
  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!user.is_admin) {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 403, errorCode: "NOT_ADMIN" });
    return res.status(403).json({ error: "forbidden" });
  }

  if (req.method === "POST") {
    const parsed = CategoryCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }
    const { data, error } = await supabase.rpc("create_category", {
      p_name: parsed.data.name,
    });
    if (error) {
      if ((error as any).code === "23505") {
        safeLog({ endpoint: ENDPOINT, method: "POST", status: 409, errorCode: "DUPLICATE" });
        return res.status(409).json({ error: "duplicate_name" });
      }
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "SUPABASE_RPC" });
      return res.status(500).json({ error: (error as any).message ?? "RPC failed" });
    }
    safeLog({ endpoint: ENDPOINT, method: "POST", status: 201, durationMs: Date.now() - startedAt });
    return res.status(201).json(data);
  }

  if (req.method === "PATCH") {
    const id = req.query.id as string | undefined;
    if (!id) return res.status(400).json({ error: "missing id" });
    const parsed = CategoryRenameSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }
    const { data, error } = await supabase.rpc("rename_category", {
      category_id: id, new_name: parsed.data.name,
    });
    if (error) {
      const code = (error as any).code;
      if (code === "P0002") return res.status(404).json({ error: "not_found" });
      if (code === "23505") return res.status(409).json({ error: "duplicate_name" });
      safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 500, errorCode: "SUPABASE_RPC" });
      return res.status(500).json({ error: (error as any).message ?? "RPC failed" });
    }
    safeLog({ endpoint: ENDPOINT, method: "PATCH", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(data);
  }

  safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
  return res.status(405).json({ error: "Method not allowed" });
}
