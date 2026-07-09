import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import "./App.css";
import Login from "./components/Login";
import Registration from "./components/Registration";
import ForgotPassword from "./components/ForgotPassword";
import Dashboard from "./components/Dashboard";
import { useAuth } from "./hooks/useAuth.jsx";

function App() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = (userData) => {
    if (!userData) return;

    const unwrapped = userData.user
      ? { ...userData.user, ...(userData.role ? { role: userData.role } : {}) }
      : userData;
    if (unwrapped.id || unwrapped.userId || unwrapped.email) {
      login(unwrapped);
      navigate("/dashboard", { replace: true });
    }
  };

  return (
    <div className="app">
      <Routes>
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route
          path="/register/*"
          element={<Registration onLogin={handleLogin} />}
        />
        <Route path="/forgot-password/*" element={<ForgotPassword />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </div>
  );
}

export default App;
