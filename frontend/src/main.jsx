import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./index.css";
import App from "./App.jsx";
import { AuthProvider, useAuth } from "./hooks/useAuth.jsx";

function SplashScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg, #0b0d12)",
        color: "var(--text, #e5e7eb)",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        fontSize: 14,
        opacity: 0.75,
      }}
      role="status"
      aria-live="polite"
    >
      Loading…
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  // Wait for the boot-time session check before deciding. Otherwise
  // a stale localStorage user would render the dashboard for a frame
  // and then bounce when the 401 from /users/me comes back.
  if (loading) return <SplashScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function PublicOnlyRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <SplashScreen />;
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route
            path="/login/*"
            element={
              <PublicOnlyRoute>
                <App />
              </PublicOnlyRoute>
            }
          />
          <Route
            path="/register/*"
            element={
              <PublicOnlyRoute>
                <App />
              </PublicOnlyRoute>
            }
          />
          <Route
            path="/forgot-password/*"
            element={
              <PublicOnlyRoute>
                <App />
              </PublicOnlyRoute>
            }
          />

          {/* Protected routes */}
          <Route
            path="/dashboard/*"
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          />
          <Route
            path="/phones/:id/*"
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          />

          <Route
            path="/phones/*"
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          />

          <Route
            path="/compare/*" // ← Add /*
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
