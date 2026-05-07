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
