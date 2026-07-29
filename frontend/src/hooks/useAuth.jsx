import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import api from "../services/api";

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
  // The stored value is treated purely as a UX hint — localStorage
  // can outlive the server's session cookie, so we ALWAYS validate
  // against `GET /users/me` on boot (see the effect below). While
  // that check is in flight, `loading` is true and route guards
  // render a splash instead of redirecting based on a stale value.
  const [user, setStoredUser] = useState(() => readStoredUser());
  const [loading, setLoading] = useState(true);

  // Track the in-flight boot-time validation. Under React.StrictMode
  // the effect runs twice on mount; we share the same promise across
  // both invocations so `setLoading(false)` always fires exactly once
  // after the real network call settles. (Previously a `validatedRef`
  // boolean flipped synchronously on the first run, which caused
  // StrictMode's second run to short-circuit before the network call
  // resolved — leaving `loading` stuck at `true` forever.)
  const validationPromiseRef = useRef(null);

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

  // Session validation: on first mount, if localStorage claims we're
  // logged in, verify that the server still recognises our session.
  // The server's `connect.sid` cookie is the source of truth — it can
  // be gone (expired / cleared) even while localStorage still holds a
  // user object. On 401 we drop the stale user so route guards kick
  // the visitor to /login. On 2xx we merge fresh profile fields.
  useEffect(() => {
    if (validationPromiseRef.current) {
      // Already in flight (or settled) from a prior mount under
      // StrictMode — share the same promise so we only flip
      // `loading` once after the real network call settles.
      return () => {};
    }

    validationPromiseRef.current = (async () => {
      const stored = readStoredUser();
      if (!stored) return; // No stored user → nothing to validate.
      try {
        const res = await api.get("/users/me");
        const profile = res?.data?.data;
        if (profile) {
          // Merge fresh server fields onto whatever localStorage had.
          // (e.g. login only returns id+email; /users/me adds name/phone
          // and now also `role` — required by the admin FE guard.)
          const next = {
            ...stored,
            id: profile.userId ?? stored.id,
            name: profile.name ?? stored.name,
            email: profile.email ?? stored.email,
            phoneNo: profile.phoneNo ?? stored.phoneNo,
            // `role` is intentionally allowed to be null/cleared — if
            // the backend returns no role (e.g. a future role-less
            // user type) we want localStorage to reflect that and not
            // keep a stale role from a previous login.
            role: profile.role ?? null,
          };
          localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
          setStoredUser(next);
        }
      } catch (err) {
        // 401 = cookie gone or session row deleted. Any other error
        // (network, 5xx) leaves the stored user alone — we'd rather
        // keep someone logged in during a transient outage than
        // bounce them out for no reason.
        if (err?.response?.status === 401) {
          localStorage.removeItem(AUTH_STORAGE_KEY);
          setStoredUser(null);
        } else {
          console.error("Session validation failed:", err);
        }
      }
    })().finally(() => {
      // Always flip `loading` once the validation (or the early
      // no-stored-user return) settles. The `.finally` lives on the
      // outer promise so it fires regardless of which branch exited.
      setLoading(false);
    });
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
    // After login: hydrate fields that the login response doesn't
    // include (name, phoneNo, role). The boot effect only runs once at
    // AuthProvider mount, so a fresh login goes through here instead.
    // Fire and forget — a refresh failure must not bounce the user
    // out (the cookie-based session is still good for the API calls
    // we're about to make).
    (async () => {
      try {
        const userId = userData && (userData.userId || userData.id);
        if (!userId) return;
        const res = await api.get("/users/me");
        const profile = res?.data?.data;
        if (!profile) return;
        setStoredUser((prev) => {
          const next = {
            ...(prev || {}),
            name: profile.name ?? prev?.name,
            phoneNo: profile.phoneNo ?? prev?.phoneNo,
            role: profile.role ?? null,
          };
          localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
          return next;
        });
      } catch (err) {
        console.warn("Post-login profile refresh failed:", err?.message || err);
      }
    })();
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
    <AuthContext.Provider value={{ user, loading, login, logout, setUser }}>
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
