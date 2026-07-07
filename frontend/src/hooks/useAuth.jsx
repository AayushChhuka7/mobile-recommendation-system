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
  const [user, setUser] = useState(() => readStoredUser());

  // Keep state in sync if another tab logs in / out.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === AUTH_STORAGE_KEY) {
        setUser(readStoredUser());
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
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
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
