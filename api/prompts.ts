import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PromptCreateSchema, PromptUpdateSchema } from "../src/lib/schemas.js";
import { authenticate } from "./lib/auth.js";
import { getServiceRoleClient } from "./lib/supabase.js";
import { safeLog } from "./lib/log.js";

const ENDPOINT = "/api/prompts";

// The list of fields the client is ALLOWED to touch on insert/update. We
// filter via an explicit allowlist rather than trusting Zod's shape because
// Zod's stripUnknown would quietly drop forged fields; pickFields +
// .strict() schema means forged fields hit a 400 before they reach the DB.
const POST_ALLOWED_FIELDS = [
  "title",
  "content",
  "category",
  "tags",
  "variables",
  "is_draft",
] as const;

const PUT_ALLOWED_FIELDS = POST_ALLOWED_FIELDS;

function pickFields<T extends object>(
  data: T,
  allowed: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([k]) => allowed.includes(k))
  );
}

/**
 * Shape the DB row into the wire format: flatten the nested creator profile
 * into created_by_name while keeping created_by_id.
 *
 * Supabase's PostgREST nested select returns the joined profile row under
 * whatever alias we use ("creator" here). We hide that alias from clients.
 */
function flattenRow(row: any): any {
  if (!row) return row;
  const { creator, ...rest } = row;
  return {
    ...rest,
    created_by_name: creator?.display_name ?? "",
  };
}

const SELECT_WITH_CREATOR =
  "*, creator:profiles!created_by_id(display_name)";

function badRequest(res: VercelResponse, issues: string[]) {
  return res.status(400).json({ error: "Invalid payload", details: issues });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  const user = await authenticate(req);
  if (!user) {
    safeLog({ endpoint: ENDPOINT, method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = getServiceRoleClient();
  const id = req.query.id as string | undefined;

  if (req.method === "GET") {
    // All published prompts + the caller's own drafts. Admin does NOT see
    // other users' drafts — drafts remain private owner-only even for admins,
    // since a draft is "work in progress not ready to share".
    const publishedQ = supabase
      .from("prompts")
      .select(SELECT_WITH_CREATOR)
      .eq("is_draft", false)
      .order("created_at", { ascending: false });

    const draftQ = supabase
      .from("prompts")
      .select(SELECT_WITH_CREATOR)
      .eq("is_draft", true)
      .eq("created_by_id", user.id)
      .order("created_at", { ascending: false });

    const [pub, drafts] = await Promise.all([publishedQ, draftQ]);

    if (pub.error || drafts.error) {
      safeLog({ endpoint: ENDPOINT, method: "GET", status: 500, errorCode: "SUPABASE_SELECT" });
      return res.status(500).json({ error: (pub.error || drafts.error)!.message });
    }

    const merged = [...(pub.data ?? []), ...(drafts.data ?? [])]
      .map(flattenRow)
      .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));

    safeLog({ endpoint: ENDPOINT, method: "GET", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(merged);
  }

  if (req.method === "POST") {
    const parsed = PromptCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      );
      safeLog({ endpoint: ENDPOINT, method: "POST", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }
    // Inject server-derived owner. Any client-sent owner field was already
    // rejected by the strict schema above.
    const insertData = {
      ...pickFields(parsed.data, POST_ALLOWED_FIELDS),
      created_by_id: user.id,
    };
    const { data, error } = await supabase
      .from("prompts")
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

  if (req.method === "PUT" && id) {
    const parsed = PromptUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
      );
      safeLog({ endpoint: ENDPOINT, method: "PUT", status: 400, errorCode: "ZOD" });
      return badRequest(res, issues);
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by_id")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      safeLog({ endpoint: ENDPOINT, method: "PUT", status: 404, errorCode: "NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    // Owner or admin. Admins can edit anyone's prompts (clean-up authority)
    // including drafts — spec §5.3 allows it explicitly.
    const isOwner = existing.created_by_id === user.id;
    if (!isOwner && !user.is_admin) {
      safeLog({ endpoint: ENDPOINT, method: "PUT", status: 403, errorCode: "NOT_OWNER" });
      return res.status(403).json({
        error: existing.is_draft
          ? "Only the draft owner can edit this prompt"
          : "Only the prompt creator or an admin can edit this prompt",
      });
    }

    const updateData = pickFields(parsed.data, PUT_ALLOWED_FIELDS);
    const { data, error } = await supabase
      .from("prompts")
      .update(updateData)
      .eq("id", id)
      .select(SELECT_WITH_CREATOR)
      .single();
    if (error) {
      safeLog({ endpoint: ENDPOINT, method: "PUT", status: 500, errorCode: "SUPABASE_UPDATE" });
      return res.status(500).json({ error: error.message });
    }
    safeLog({ endpoint: ENDPOINT, method: "PUT", status: 200, durationMs: Date.now() - startedAt });
    return res.status(200).json(flattenRow(data));
  }

  if (req.method === "DELETE" && id) {
    const { data: existing, error: fetchErr } = await supabase
      .from("prompts")
      .select("is_draft, created_by_id")
      .eq("id", id)
      .single();

    if (fetchErr || !existing) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 404, errorCode: "NOT_FOUND" });
      return res.status(404).json({ error: "Prompt not found" });
    }

    const isOwner = existing.created_by_id === user.id;
    if (!isOwner && !user.is_admin) {
      safeLog({ endpoint: ENDPOINT, method: "DELETE", status: 403, errorCode: "NOT_OWNER" });
      return res.status(403).json({
        error: existing.is_draft
          ? "Only the draft owner can delete this prompt"
          : "Only the prompt creator or an admin can delete this prompt",
      });
    }

    const { error } = await supabase.from("prompts").delete().eq("id", id);
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
