import { API_BASE_URL } from "./constants";

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

class ApiClient {
  private token: string | null = null;

  setToken(token: string) {
    this.token = token;
    sessionStorage.setItem("auth_token", token);
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = sessionStorage.getItem("auth_token");
    }
    return this.token;
  }

  clearToken() {
    this.token = null;
    sessionStorage.removeItem("auth_token");
  }

  async verify(password: string): Promise<boolean> {
    const res = await fetch(`${API_BASE_URL}/api/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    this.setToken(data.token);
    return true;
  }

  async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    if (!token) throw new Error("Not authenticated");

    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

    if (res.status === 401) {
      this.clearToken();
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
    const token = this.getToken();
    if (!token) throw new ChatError("OTHER", "Not authenticated");

    const res = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiKey, model, messages }),
    });

    if (res.status === 401) {
      this.clearToken();
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
    const token = this.getToken();
    if (!token) throw new ChatError("OTHER", "Not authenticated");

    const res = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiKey, model, messages, stream: true }),
      signal,
    });

    if (res.status === 401) {
      this.clearToken();
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

    // Each SSE event is delimited by a blank line. We accumulate bytes,
    // peel off complete events, and parse each one. An event is one or
    // more `field: value` lines; we only care about `event:` and `data:`.
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
    // Flush any trailing block (no terminating blank line)
    if (buffer.trim().length > 0) processEvent(buffer);

    return full;
  }

  // -------- Examples (saved test-run conversations) --------

  async listExamples(promptId: string, viewer: string): Promise<unknown[]> {
    const qs = new URLSearchParams({ prompt_id: promptId });
    if (viewer) qs.set("viewer", viewer);
    return this.request(`/api/examples?${qs.toString()}`);
  }

  async createExample(input: unknown): Promise<unknown> {
    return this.request("/api/examples", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deleteExample(id: string, viewer: string): Promise<void> {
    const qs = new URLSearchParams({ id });
    if (viewer) qs.set("viewer", viewer);
    await this.request(`/api/examples?${qs.toString()}`, { method: "DELETE" });
  }
}

export const api = new ApiClient();
