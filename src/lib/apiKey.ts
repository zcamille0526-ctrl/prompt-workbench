const STORAGE_KEY = "deepseek_api_key";

/**
 * Stores the user's DeepSeek API key in sessionStorage only — never localStorage,
 * never cookies, and never sent to Supabase. The key clears when the tab closes,
 * matching the security boundary of the shared password.
 */
export function getApiKey(): string {
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

export function setApiKey(key: string): void {
  sessionStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function hasApiKey(): boolean {
  return Boolean(getApiKey());
}
