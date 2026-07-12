import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";

const AUTH_STORAGE_KEY = "mobileRec.authUser";
const AuthContext = createContext(null);

function readStoredUser() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  // Lazy initializer reads from localStorage exactly once on mount.
  // `setStoredUser` is the raw React state setter; `setUser` (below) is
  // the public merge helper exposed via context.
  const [user, setStoredUser] = useState(() => readStoredUser());

  // Keep state in sync if another tab logs in / out.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === AUTH_STORAGE_KEY) {
        setStoredUser(readStoredUser());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const login = useCallback((userData) => {
    if (userData) {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(userData));
    } else {
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
    // setState after localStorage so listeners that read from storage
    // in the same tick see the new value.
    setStoredUser(userData);
  }, []);

  // Merge a partial update into the existing stored user. Used to fill in
  // fields (name, phoneNo) that the login response doesn't include but a
  // later /users/me call returns. Falls back to replacing if no user
  // exists yet (e.g. when a registration flow completes before the
  // dashboard mounts).
  const setUser = useCallback((partial) => {
    setStoredUser((prev) => {
      if (!partial) return prev;
      const next = { ...(prev || {}), ...partial };
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setStoredUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}

export { AUTH_STORAGE_KEY, readStoredUser };
