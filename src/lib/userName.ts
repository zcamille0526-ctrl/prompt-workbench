import { isValidUserName } from "./userName.shared";

const STORAGE_KEY = "user_name";

export function getUserName(): string {
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

export function setUserName(name: string): void {
  sessionStorage.setItem(STORAGE_KEY, name);
}

export function clearUserName(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export { isValidUserName };
