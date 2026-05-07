import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { verifyToken } from "./verify.js";
import { safeLog } from "./lib/log.js";

// 30 s aligns with Vercel Pro's maxDuration ceiling. On Hobby plans this
// silently caps at the platform default (10 s); we surface a friendly
// error in the front-end if DeepSeek hasn't responded by then.
export const config = { maxDuration: 30 };

const ALLOWED_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

// We deliberately accept only the fields we forward. Extra params (like
// thinking, reasoning_effort, temperature) require their own validation
// before we trust them, and v1 of this feature doesn't need them.
const ChatRequestSchema = z
  .object({
    apiKey: z.string().min(1),
    model: z.enum(ALLOWED_MODELS),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string().min(1).max(20_000),
          })
          .strict()
      )
      .min(1)
      .max(40),
  })
  .strict();

type ErrorCode =
  | "INVALID_KEY"
  | "INSUFFICIENT_BALANCE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "OTHER";

function authenticate(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return verifyToken(auth.slice(7));
}

function chatError(
  res: VercelResponse,
  status: number,
  code: ErrorCode,
  message: string
) {
  return res.status(status).json({ error: { code, message } });
}

function mapUpstreamStatus(status: number): { code: ErrorCode; message: string } {
  if (status === 401) return { code: "INVALID_KEY", message: "API Key 无效，请检查后重试" };
  if (status === 402) return { code: "INSUFFICIENT_BALANCE", message: "DeepSeek 账户余额不足" };
  if (status === 429) return { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" };
  return { code: "OTHER", message: "DeepSeek 服务暂不可用，请重试" };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();

  if (!authenticate(req)) {
    safeLog({ endpoint: "/api/chat", method: req.method, status: 401 });
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    safeLog({ endpoint: "/api/chat", method: req.method, status: 405 });
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    safeLog({ endpoint: "/api/chat", method: "POST", status: 400, errorCode: "ZOD" });
    return res.status(400).json({
      error: {
        code: "OTHER" satisfies ErrorCode,
        message: "请求格式错误",
        details: parsed.error.issues.map(
          (i) => `${i.path.join(".") || "(root)"}: ${i.message}`
        ),
      },
    });
  }

  const { apiKey, model, messages } = parsed.data;

  // Abort the upstream request if it runs past 28 s — leaves headroom under
  // the 30 s function deadline so we can still send a structured error.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 28_000);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const aborted = err instanceof Error && err.name === "AbortError";
    safeLog({
      endpoint: "/api/chat",
      method: "POST",
      status: aborted ? 504 : 502,
      errorCode: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK",
    });
    return chatError(
      res,
      aborted ? 504 : 502,
      aborted ? "TIMEOUT" : "NETWORK",
      aborted ? "请求超时，请重试" : "网络错误，请重试"
    );
  }
  clearTimeout(timeoutId);

  if (!upstreamRes.ok) {
    const mapped = mapUpstreamStatus(upstreamRes.status);
    safeLog({
      endpoint: "/api/chat",
      method: "POST",
      status: upstreamRes.status,
      errorCode: `UPSTREAM_${mapped.code}`,
    });
    return chatError(res, upstreamRes.status, mapped.code, mapped.message);
  }

  let payload: unknown;
  try {
    payload = await upstreamRes.json();
  } catch {
    safeLog({ endpoint: "/api/chat", method: "POST", status: 502, errorCode: "UPSTREAM_PARSE" });
    return chatError(res, 502, "OTHER", "DeepSeek 返回了无效响应");
  }

  const content =
    (payload as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    safeLog({ endpoint: "/api/chat", method: "POST", status: 502, errorCode: "UPSTREAM_SHAPE" });
    return chatError(res, 502, "OTHER", "DeepSeek 返回了无效响应");
  }

  safeLog({
    endpoint: "/api/chat",
    method: "POST",
    status: 200,
    durationMs: Date.now() - startedAt,
  });
  return res.status(200).json({ content });
}
