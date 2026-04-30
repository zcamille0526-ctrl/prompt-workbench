import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { verifyToken } from "./verify.js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function authenticate(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return verifyToken(auth.slice(7));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authenticate(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const id = req.query.id as string | undefined;

  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("prompts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "POST") {
    const { data, error } = await supabase
      .from("prompts")
      .insert(req.body)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  if (req.method === "PUT" && id) {
    const { data, error } = await supabase
      .from("prompts")
      .update(req.body)
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE" && id) {
    const { error } = await supabase.from("prompts").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
