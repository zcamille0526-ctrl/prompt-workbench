import { API_BASE_URL } from "./constants";

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
}

export const api = new ApiClient();
