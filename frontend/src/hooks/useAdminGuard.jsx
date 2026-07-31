// useAdminGuard.jsx — client-side route guard for admin pages.
//
// Usage:
//   function AdminPage() {
//     const { isAdmin, loading } = useAdminGuard();
//     if (loading || !isAdmin) return <Splash />;
//     return <RealPage />;
//   }
//
// Behaviour:
//   - While `loading` is true (the boot `/users/me` validation is still
//     in flight), the hook returns `{ loading: true }` so the page can
//     show a splash instead of rendering with a stale user.
//   - If `loading` is false and there's no user → redirect to /login.
//   - If `loading` is false and the user exists but `role !== "Admin"`
//     → redirect to /dashboard (the customer's home).
//
// IMPORTANT: this is a UX guard only. The backend `requireRole("Admin")`
// middleware on the admin routes is the actual security boundary — a
// tampered localStorage cannot grant access because every admin API
// call goes back through the BE.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./useAuth.jsx";

export function useAdminGuard() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const isAdmin = !!(user && user.role === "Admin");

  useEffect(() => {
    if (loading) return; // still validating the boot session — wait
    if (!user) {
      navigate("/login", { replace: true });
      return;
    }
    if (!isAdmin) {
      navigate("/dashboard", { replace: true });
    }
  }, [loading, user, isAdmin, navigate]);

  return { user, loading, isAdmin };
}