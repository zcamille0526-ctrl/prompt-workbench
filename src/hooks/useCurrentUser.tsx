import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  getAccessToken,
  logout as logoutCall,
  type UserSummary,
} from "../lib/authClient";

type CurrentUserState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: UserSummary };

type CurrentUserContextValue = CurrentUserState & {
  /** Imperatively replace the cached user (e.g. after login or setup). */
  setUser: (user: UserSummary) => void;
  /** Refetch from /api/auth/me. Returns null on auth failure. */
  refresh: () => Promise<UserSummary | null>;
  /** Full logout: server signOut + clear sessionStorage. */
  logout: () => Promise<void>;
};

const CurrentUserContext = createContext<CurrentUserContextValue | null>(null);

/**
 * Bootstraps current-user state on first mount.
 *
 * On load: if pw.access_token exists in sessionStorage (e.g. tab reload),
 * call /api/auth/me to validate it and pull display_name + is_admin.
 * Otherwise stay anonymous.
 *
 * Step 2 will likely add 401-refresh-retry plumbing into a single fetch
 * helper; until then we treat any /me failure as "auth lost" and fall
 * back to anonymous, which is the conservative behavior.
 */
export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CurrentUserState>({ status: "loading" });

  const refresh = useCallback(async (): Promise<UserSummary | null> => {
    if (!getAccessToken()) {
      setState({ status: "anonymous" });
      return null;
    }
    try {
      const user = await fetchMe();
      setState({ status: "authenticated", user });
      return user;
    } catch {
      setState({ status: "anonymous" });
      return null;
    }
  }, []);

  const setUser = useCallback((user: UserSummary) => {
    setState({ status: "authenticated", user });
  }, []);

  const logout = useCallback(async () => {
    await logoutCall();
    setState({ status: "anonymous" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<CurrentUserContextValue>(
    () => ({ ...state, setUser, refresh, logout }),
    [state, setUser, refresh, logout]
  );

  return (
    <CurrentUserContext.Provider value={value}>
      {children}
    </CurrentUserContext.Provider>
  );
}

/**
 * Read the current user. Returns the full state machine — caller decides
 * how to render "loading" vs "anonymous" vs "authenticated".
 */
export function useCurrentUser(): CurrentUserContextValue {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error("useCurrentUser must be used inside CurrentUserProvider");
  }
  return ctx;
}
