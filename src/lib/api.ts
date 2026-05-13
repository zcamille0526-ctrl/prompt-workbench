import { API_BASE_URL } from "./constants";
import { getAccessToken, refresh, AuthError } from "./authClient";
import type { Category } from "./schemas";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatErrorCode =
  | "INVALID_KEY"
  | "INSUFFICIENT_BALANCE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NETWORK"
  | "OTHER";

export class ChatError extends Error {
  code: ChatErrorCode;

  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ChatError";
  }
}

// ---------------------------------------------------------------------------
// Refresh deduplication
//
// When several requests fire concurrently and all get 401 (e.g. the user
// returns to a tab after a long idle and the polling tick + a click both
// run), naively each call would POST /api/auth/refresh — burning Supabase
// quota and risking the second refresh seeing the first call's rotated
// refresh_token as invalid.
//
// We collapse them into a single in-flight refresh promise. Concurrent
// callers all await the same result; whoever resolves it gets to clear the
// variable so the NEXT 401 wave triggers a fresh refresh attempt.
//
// pendingRefresh holds the access_token (or null on failure). The IIFE
// pattern means the variable is assigned before any caller can read it,
// so concurrent callers all see the same promise.

let pendingRefresh: Promise<string | null> | null = null;

async function refreshAccessTokenDeduped(): Promise<string | null> {
  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = (async () => {
    try {
      const { access_token } = await refresh();
      return access_token;
    } catch (err) {
      if (err instanceof AuthError) return null;
      // Network errors etc. — treat as refresh failure; caller will see 401.
      return null;
    } finally {
      // Clear AFTER the await chain completes so the in-flight callers all
      // see the same promise. The next 401 (after this one resolves) gets a
      // fresh attempt.
      pendingRefresh = null;
    }
  })();
  return pendingRefresh;
}

// Test-only escape hatch: reset the dedup state so per-test mocks can prove
// the dedup actually works (or not).
export function __resetRefreshDedupForTests(): void {
  pendingRefresh = null;
}

/**
 * Fetch wrapper that injects the current access_token and, on 401, tries
 * exactly one refresh+retry. Concurrent 401 callers share one refresh via
 * refreshAccessTokenDeduped().
 *
 * Returns the final Response. The body has NOT been consumed; the caller
 * decides whether to call .json() or stream it (chat streaming needs the
 * raw body).
 */
async function authedFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const buildHeaders = (token: string | null): HeadersInit => {
    const h: Record<string, string> = {
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (token) h["authorization"] = `Bearer ${token}`;
    if (init.body && !h["content-type"]) h["content-type"] = "application/json";
    return h;
  };

  const token = getAccessToken();
  const firstRes = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: buildHeaders(token),
  });

  if (firstRes.status !== 401) return firstRes;

  // The body of a 401 carries no useful retry context; drain it so the
  // connection can be released cleanly.
  try {
    await firstRes.body?.cancel();
  } catch {
    /* noop */
  }

  const newToken = await refreshAccessTokenDeduped();
  if (!newToken) return firstRes;

  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: buildHeaders(newToken),
  });
}

class ApiClient {
  // ---- Business API ----

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await authedFetch(path, options);

    if (res.status === 401) {
      throw new Error("Session expired");
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Request failed");
    }

    return res.json();
  }

  /**
   * Fire-and-forget increment of a prompt's use_count.
   *
   * Failures are intentionally swallowed: the copy flow must never break
   * because a counter request hiccupped. The next polling tick will pull
   * authoritative values from the server.
   */
  async incrementUseCount(id: string): Promise<void> {
    try {
      await this.request("/api/use-count", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
    } catch {
      // intentionally silent
    }
  }

  /**
   * Sends a chat completion request through our server-side DeepSeek proxy.
   * The user's API key is forwarded in the request body — never persisted
   * server-side. Throws ChatError with a stable code so callers can render
   * the right message without parsing strings.
   */
  async chat(
    apiKey: string,
    model: string,
    messages: ChatMessage[]
  ): Promise<string> {
    const res = await authedFetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ apiKey, model, messages }),
    });

    if (res.status === 401) {
      throw new ChatError("OTHER", "Session expired");
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new ChatError("NETWORK", "服务返回了无效响应");
    }

    if (!res.ok) {
      const err = body?.error;
      if (err && typeof err === "object" && err.code) {
        throw new ChatError(err.code, err.message || "请求失败");
      }
      throw new ChatError("OTHER", "请求失败");
    }

    if (typeof body?.content !== "string") {
      throw new ChatError("OTHER", "服务返回了无效响应");
    }
    return body.content;
  }

  /**
   * Streaming variant of chat(). Calls onDelta with each token chunk as it
   * arrives, then resolves with the full concatenated reply when the upstream
   * emits [DONE]. Errors mid-stream surface as ChatError exceptions.
   *
   * The wire format is OpenAI-compatible SSE forwarded as-is from DeepSeek:
   *   data: {"choices":[{"delta":{"content":"..."}}]}\n\n
   *   data: [DONE]\n\n
   * Plus our server may emit an SSE `event: error` frame on mid-stream
   * failure with a JSON body matching ChatError.
   */
  async chatStream(
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    onDelta: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const res = await authedFetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ apiKey, model, messages, stream: true }),
      signal,
    });

    if (res.status === 401) {
      throw new ChatError("OTHER", "Session expired");
    }

    // Non-OK responses come back as JSON {error:{code,message}} (the server
    // bails out before switching to SSE for input/upstream errors).
    if (!res.ok) {
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new ChatError("NETWORK", "服务返回了无效响应");
      }
      const err = body?.error;
      if (err && typeof err === "object" && err.code) {
        throw new ChatError(err.code, err.message || "请求失败");
      }
      throw new ChatError("OTHER", "请求失败");
    }

    if (!res.body) throw new ChatError("OTHER", "服务未返回流式响应");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    const processEvent = (block: string) => {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");

      if (eventName === "error") {
        let parsed: any = {};
        try {
          parsed = JSON.parse(data);
        } catch {
          /* noop */
        }
        throw new ChatError(parsed.code ?? "OTHER", parsed.message ?? "请求失败");
      }

      if (data === "[DONE]") return;

      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // Ignore malformed individual chunks; DeepSeek sometimes pads with
        // keep-alive comments. Don't tear down the whole stream over one bad
        // line — the [DONE] sentinel still tells us when we're finished.
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim().length > 0) processEvent(block);
      }
    }
    if (buffer.trim().length > 0) processEvent(buffer);

    return full;
  }

  // -------- Examples (saved test-run conversations) --------
  //
  // Phase 2: viewer query param removed. The server derives the caller's
  // identity from the Bearer token via authenticate(). Visibility rules
  // (draft-owner only, option-B delete) all run server-side.

  async listExamples(promptId: string): Promise<unknown[]> {
    const qs = new URLSearchParams({ prompt_id: promptId });
    return this.request(`/api/examples?${qs.toString()}`);
  }

  async createExample(input: unknown): Promise<unknown> {
    return this.request("/api/examples", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deleteExample(id: string): Promise<void> {
    const qs = new URLSearchParams({ id });
    await this.request(`/api/examples?${qs.toString()}`, { method: "DELETE" });
  }

  // -------- Categories --------

  async listCategories(): Promise<Category[]> {
    const res = await fetch(`${API_BASE_URL}/api/categories`);
    if (!res.ok) throw new Error("Failed to load categories");
    const body = await res.json();
    return body.categories ?? [];
  }

  async createCategory(name: string): Promise<Category> {
    return this.request<Category>("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async renameCategory(id: string, name: string): Promise<Category> {
    const qs = new URLSearchParams({ id });
    return this.request<Category>(`/api/categories?${qs.toString()}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async moveCategory(id: string, direction: "up" | "down"): Promise<void> {
    const qs = new URLSearchParams({ id, action: "move" });
    await this.request(`/api/categories?${qs.toString()}`, {
      method: "POST",
      body: JSON.stringify({ direction }),
    });
  }

  async deleteCategory(id: string): Promise<void> {
    const qs = new URLSearchParams({ id });
    const res = await authedFetch(`/api/categories?${qs.toString()}`, {
      method: "DELETE",
    });
    // 204 No Content is success; anything else with a body is an error.
    if (res.status === 204) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error === "in_use"
        ? `in_use:${err.used_by_count ?? 0}`
        : err.error ?? "Delete failed";
      throw new Error(msg);
    }
  }
}

export const api = new ApiClient();
