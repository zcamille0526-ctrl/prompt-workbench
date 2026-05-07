import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "./verify.js";
import { ExampleCreateSchema } from "../src/lib/schemas.js";
import { isValidUserName } from "../src/lib/userName.shared.js";
import { safeLog } from "./lib/log.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_EXAMPLES_PER_PROMPT = 5;

const POST_ALLOWED_FIELDS = [
  "prompt_id",
  "title",
  "variable_values",
  "model",
  "messages",
  "created_by",
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  if (!authenticate(req)) {
    safeLog({ endpoint: "/api/examples", method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const viewer = (req.query.viewer as string | undefined) ?? "";
  if (viewer && !isValidUserName(viewer)) {
    safeLog({ endpoint: "/api/examples", method: req.method, status: 400, errorCode: "INVALID_VIEWER" });
    return res.status(400).json({ error: "Invalid viewer" });
  }

  // ---------------- GET ----------------
  if (req.method === "GET") {
    const promptId = req.query.prompt_id as string | undefined;
    if (!promptId || !UUID_RE.test(promptId)) {
      safeLog({ endpoint: "/api/examples", method: "GET", status: 400, errorCode: "BAD_PROMPT_ID" });
      return res.status(400).json({ error: "Invalid prompt_id" });
    }

    // Draft prompts: only the owner can see their examples. We read the
    // parent prompt's is_draft + created_by once and gate accordingly.
    const { data: parent, error: parentErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by")
      .eq("id", promptId)
      .single();

    if (parentErr || !parent) {
      safeLog({ endpoint: "/api/examples", method: "GET", status: 404, errorCode: "PROMPT_NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    if (parent.is_draft && (!viewer || viewer !== parent.created_by)) {
      safeLog({ endpoint: "/api/examples", method: "GET", status: 403, errorCode: "DRAFT_HIDDEN" });
      return res.status(403).json({ error: "This prompt's examples are private to its owner" });
    }

    const { data, error } = await supabase
      .from("examples")
      .select("*")
      .eq("prompt_id", promptId)
      .order("created_at", { ascending: false });

    if (error) {
      safeLog({ endpoint: "/api/examples", method: "GET", status: 500, errorCode: "SUPABASE_SELECT" });
      return res.status(500).json({ error: error.message });
    }

    safeLog({ endpoint: "/api/examples", method: "GET", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(data ?? []);
  }

  // ---------------- POST ----------------
  if (req.method === "POST") {
    const parsed = ExampleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      safeLog({ endpoint: "/api/examples", method: "POST", status: 400, errorCode: "ZOD" });
      return res.status(400).json({
        error: "Invalid payload",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
        ),
      });
    }

    // Verify prompt exists and (if draft) viewer is owner — otherwise an
    // attacker could attach examples to someone else's draft.
    const { data: parent, error: parentErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by")
      .eq("id", parsed.data.prompt_id)
      .single();

    if (parentErr || !parent) {
      safeLog({ endpoint: "/api/examples", method: "POST", status: 404, errorCode: "PROMPT_NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    if (parent.is_draft && parent.created_by !== parsed.data.created_by) {
      safeLog({ endpoint: "/api/examples", method: "POST", status: 403, errorCode: "DRAFT_HIDDEN" });
      return res.status(403).json({ error: "Only the draft owner can add examples to it" });
    }

    // 5-per-prompt cap. TOCTOU race acceptable per spec (worst case: 6 in
    // flight before the next POST sees them).
    const { count, error: countErr } = await supabase
      .from("examples")
      .select("*", { count: "exact", head: true })
      .eq("prompt_id", parsed.data.prompt_id);

    if (countErr) {
      safeLog({ endpoint: "/api/examples", method: "POST", status: 500, errorCode: "SUPABASE_COUNT" });
      return res.status(500).json({ error: countErr.message });
    }
    if ((count ?? 0) >= MAX_EXAMPLES_PER_PROMPT) {
      safeLog({ endpoint: "/api/examples", method: "POST", status: 400, errorCode: "MAX_EXAMPLES" });
      return res.status(400).json({
        error: `已达上限（${MAX_EXAMPLES_PER_PROMPT} 个），请先删除旧示例`,
      });
    }

    const insertData = pickFields(parsed.data, POST_ALLOWED_FIELDS);
    const { data, error } = await supabase
      .from("examples")
      .insert(insertData)
      .select()
      .single();

    if (error) {
      safeLog({ endpoint: "/api/examples", method: "POST", status: 500, errorCode: "SUPABASE_INSERT" });
      return res.status(500).json({ error: error.message });
    }

    safeLog({ endpoint: "/api/examples", method: "POST", status: 201, durationMs: Date.now() - startedAt });
    return res.status(201).json(data);
  }

  // ---------------- DELETE ----------------
  if (req.method === "DELETE") {
    const id = req.query.id as string | undefined;
    if (!id || !UUID_RE.test(id)) {
      safeLog({ endpoint: "/api/examples", method: "DELETE", status: 400, errorCode: "BAD_ID" });
      return res.status(400).json({ error: "Invalid id" });
    }

    // Delete permission (option B): example creator OR prompt owner.
    // Need both records to evaluate; one round-trip via two reads chained.
    const { data: existing, error: fetchErr } = await supabase
      .from("examples")
      .select("created_by, prompt_id")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      safeLog({ endpoint: "/api/examples", method: "DELETE", status: 404, errorCode: "NOT_FOUND" });
      return res.status(404).json({ error: "Example not found" });
    }

    const { data: parent, error: parentErr } = await supabase
      .from("prompts")
      .select("created_by")
      .eq("id", existing.prompt_id)
      .single();

    if (parentErr || !parent) {
      safeLog({ endpoint: "/api/examples", method: "DELETE", status: 500, errorCode: "PARENT_LOOKUP" });
      return res.status(500).json({ error: "Failed to verify permission" });
    }

    if (!viewer || (viewer !== existing.created_by && viewer !== parent.created_by)) {
      safeLog({ endpoint: "/api/examples", method: "DELETE", status: 403, errorCode: "NOT_OWNER" });
      return res.status(403).json({
        error: "只有示例创建人或该提示词的创建人可删除此示例",
      });
    }

    const { error } = await supabase.from("examples").delete().eq("id", id);
    if (error) {
      safeLog({ endpoint: "/api/examples", method: "DELETE", status: 500, errorCode: "SUPABASE_DELETE" });
      return res.status(500).json({ error: error.message });
    }

    safeLog({ endpoint: "/api/examples", method: "DELETE", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json({ success: true });
  }

  safeLog({ endpoint: "/api/examples", method: req.method, status: 405 });
  return res.status(405).json({ error: "Method not allowed" });
}
