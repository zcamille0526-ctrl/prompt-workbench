import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ExampleCreateSchema } from "../src/lib/schemas.js";
import { authenticate } from "./lib/auth.js";
import { getServiceRoleClient } from "./lib/supabase.js";
import { safeLog } from "./lib/log.js";

const ENDPOINT = "/api/examples";

const MAX_EXAMPLES_PER_PROMPT = 5;

const POST_ALLOWED_FIELDS = [
  "prompt_id",
  "title",
  "variable_values",
  "model",
  "messages",
] as const;

function pickFields<T extends object>(
  data: T,
  allowed: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => allowed.includes(k))
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_WITH_CREATOR =
  "*, creator:profiles!created_by_id(display_name)";

function flattenRow(row: any): any {
  if (!row) return row;
  const { creator, ...rest } = row;
  return {
    ...rest,
    created_by_name: creator?.display_name ?? "",
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = getServiceRoleClient();

  // ---------------- GET ----------------
  if (req.method === "GET") {
    const promptId = req.query.prompt_id as string | undefined;
    if (!promptId || !UUID_RE.test(promptId)) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 400, errorCode: "BAD_PROMPT_ID" });
      return res.status(400).json({ error: "Invalid prompt_id" });
    }

    const { data: parent, error: parentErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by_id")
      .eq("id", promptId)
      .single();

    if (parentErr || !parent) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 404, errorCode: "PROMPT_NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    // Drafts: only the owner sees their examples (admin still doesn't —
    // mirrors prompts GET draft visibility).
    if (parent.is_draft && parent.created_by_id !== user.id) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 403, errorCode: "DRAFT_HIDDEN" });
      return res.status(403).json({ error: "This prompt's examples are private to its owner" });
    }

    const { data, error } = await supabase
      .from("examples")
      .select(SELECT_WITH_CREATOR)
      .eq("prompt_id", promptId)
      .order("created_at", { ascending: false });

    if (error) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 500, errorCode: "SUPABASE_SELECT" });
      return res.status(500).json({ error: error.message });
    }

    safeLog({ endpoint: ENDPOINT, method: "GET", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json((data ?? []).map(flattenRow));
  }

  // ---------------- POST ----------------
  if (req.method === "POST") {
    const parsed = ExampleCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
      return res.status(400).json({
        error: "Invalid payload",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
        ),
      });
    }

    const { data: parent, error: parentErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by_id")
      .eq("id", parsed.data.prompt_id)
      .single();

    if (parentErr || !parent) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 404, errorCode: "PROMPT_NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    // Posting examples to a draft requires draft ownership. Admins do NOT
    // bypass this — drafts stay private to their owner per spec §5.3.
    if (parent.is_draft && parent.created_by_id !== user.id) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 403, errorCode: "DRAFT_HIDDEN" });
      return res.status(403).json({ error: "Only the draft owner can add examples to it" });
    }

    const { count, error: countErr } = await supabase
      .from("examples")
      .select("*", { count: "exact", head: true })
      .eq("prompt_id", parsed.data.prompt_id);

    if (countErr) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "SUPABASE_COUNT" });
      return res.status(500).json({ error: countErr.message });
    }
    if ((count ?? 0) >= MAX_EXAMPLES_PER_PROMPT) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "MAX_EXAMPLES" });
      return res.status(400).json({
        error: `已达上限（${MAX_EXAMPLES_PER_PROMPT} 个），请先删除旧示例`,
      });
    }

    const insertData = {
      ...pickFields(parsed.data, POST_ALLOWED_FIELDS),
      created_by_id: user.id,
    };
    const { data, error } = await supabase
      .from("examples")
      .insert(insertData)
      .select(SELECT_WITH_CREATOR)
      .single();

    if (error) {
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 500, errorCode: "SUPABASE_INSERT" });
      return res.status(500).json({ error: error.message });
    }

    safeLog({ endpoint: ENDPOINT, method: "POST", status: 201, durationMs: Date.now() - startedAt });
    return res.status(201).json(flattenRow(data));
  }

  // ---------------- DELETE ----------------
  if (req.method === "DELETE") {
    const id = req.query.id as string | undefined;
    if (!id || !UUID_RE.test(id)) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 400, errorCode: "BAD_ID" });
      return res.status(400).json({ error: "Invalid id" });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("examples")
      .select("created_by_id, prompt_id")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 404, errorCode: "NOT_FOUND" });
      return res.status(404).json({ error: "Example not found" });
    }

    const { data: parent, error: parentErr } = await supabase
      .from("prompts")
      .select("created_by_id")
      .eq("id", existing.prompt_id)
      .single();

    if (parentErr || !parent) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 500, errorCode: "PARENT_LOOKUP" });
      return res.status(500).json({ error: "Failed to verify permission" });
    }

    // Spec §5.3: delete permission = example creator OR prompt creator OR admin.
    const isExampleOwner = existing.created_by_id === user.id;
    const isPromptOwner = parent.created_by_id === user.id;
    if (!isExampleOwner && !isPromptOwner && !user.is_admin) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 403, errorCode: "NOT_OWNER" });
      return res.status(403).json({
        error: "只有示例创建人、该提示词的创建人或管理员可删除此示例",
      });
    }

    const { error } = await supabase.from("examples").delete().eq("id", id);
    if (error) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 500, errorCode: "SUPABASE_DELETE" });
      return res.status(500).json({ error: error.message });
    }

    safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json({ success: true });
  }

  safeLog({ endpoint: ENDPOINT, method: req.method, status: 405 });
  return res.status(405).json({ error: "Method not allowed" });
}
