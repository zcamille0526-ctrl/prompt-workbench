import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "./verify.js";
import { PromptCreateSchema, PromptUpdateSchema } from "../src/lib/schemas.js";
import { isValidUserName } from "../src/lib/userName.shared.js";
import { safeLog } from "./lib/log.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const POST_ALLOWED_FIELDS = [
  "title",
  "content",
  "category",
  "tags",
  "variables",
  "created_by",
  "is_draft",
] as const;

const PUT_ALLOWED_FIELDS = [
  "title",
  "content",
  "category",
  "tags",
  "variables",
  "is_draft",
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
  const viewer = (req.query.viewer as string | undefined) ?? "";

  if (req.method === "GET") {
    if (viewer && !isValidUserName(viewer)) {
      safeLog({ endpoint: "/api/prompts", method: "GET", status: 400, errorCode: "INVALID_VIEWER" });
      return res.status(400).json({ error: "Invalid viewer" });
    }

    const publishedQ = supabase
      .from("prompts")
      .select("*")
      .eq("is_draft", false)
      .order("created_at", { ascending: false });

    const draftQ = viewer
      ? supabase
          .from("prompts")
          .select("*")
          .eq("is_draft", true)
          .eq("created_by", viewer)
          .order("created_at", { ascending: false })
      : null;

    const [pub, drafts] = await Promise.all([
      publishedQ,
      draftQ ?? Promise.resolve({ data: [] as unknown[], error: null }),
    ]);

    if (pub.error || drafts.error) {
      safeLog({ endpoint: "/api/prompts", method: "GET", status: 500, errorCode: "SUPABASE_SELECT" });
      return res.status(500).json({ error: (pub.error || drafts.error)!.message });
    }

    const merged = [...(pub.data ?? []), ...(drafts.data ?? [])]
      .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));

    safeLog({ endpoint: "/api/prompts", method: "GET", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(merged);
  }

  if (req.method === "POST") {
    const parsed = PromptCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      );
      safeLog({ endpoint: "/api/prompts", method: "POST", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }
    const insertData = pickFields(parsed.data, POST_ALLOWED_FIELDS);
    const { data, error } = await supabase
      .from("prompts")
      .insert(insertData)
      .select()
      .single();
    if (error) {
      safeLog({ endpoint: "/api/prompts", method: "POST", status: 500, errorCode: "SUPABASE_INSERT" });
      return res.status(500).json({ error: error.message });
    }
    safeLog({ endpoint: "/api/prompts", method: "POST", status: 201, durationMs: Date.now() - startedAt });
    return res.status(201).json(data);
  }

  if (req.method === "PUT" && id) {
    const parsed = PromptUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      );
      safeLog({ endpoint: "/api/prompts", method: "PUT", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      safeLog({ endpoint: "/api/prompts", method: "PUT", status: 404, errorCode: "NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    // Owner-only edit: viewer must match the prompt's created_by, regardless
    // of draft state. Original spec allowed any viewer to edit published
    // prompts; tightened so a teammate can't quietly clobber someone else's
    // saved work just by being signed in.
    if (!viewer || viewer !== existing.created_by) {
      const code = existing.is_draft ? "DRAFT_OWNER" : "OWNER";
      safeLog({ endpoint: "/api/prompts", method: "PUT", status: 403, errorCode: code });
      return res.status(403).json({
        error: existing.is_draft
          ? "Only the draft owner can edit this prompt"
          : "Only the prompt creator can edit this prompt",
      });
    }

    const updateData = pickFields(parsed.data, PUT_ALLOWED_FIELDS);
    const { data, error } = await supabase
      .from("prompts")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      safeLog({ endpoint: "/api/prompts", method: "PUT", status: 500, errorCode: "SUPABASE_UPDATE" });
      return res.status(500).json({ error: error.message });
    }
    safeLog({ endpoint: "/api/prompts", method: "PUT", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE" && id) {
    const { data: existing, error: fetchErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      safeLog({ endpoint: "/api/prompts", method: "DELETE", status: 404, errorCode: "NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    // Owner-only delete (mirrors the PUT rule).
    if (!viewer || viewer !== existing.created_by) {
      const code = existing.is_draft ? "DRAFT_OWNER" : "OWNER";
      safeLog({ endpoint: "/api/prompts", method: "DELETE", status: 403, errorCode: code });
      return res.status(403).json({
        error: existing.is_draft
          ? "Only the draft owner can delete this prompt"
          : "Only the prompt creator can delete this prompt",
      });
    }

    const { error } = await supabase.from("prompts").delete().eq("id", id);
    if (error) {
      safeLog({ endpoint: "/api/prompts", method: "DELETE", status: 500, errorCode: "SUPABASE_DELETE" });
      return res.status(500).json({ error: error.message });
    }
    safeLog({ endpoint: "/api/prompts", method: "DELETE", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json({ success: true });
  }

  safeLog({ endpoint: "/api/prompts", method: req.method, status: 405 });
  return res.status(405).json({ error: "Method not allowed" });
}
