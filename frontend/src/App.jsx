import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import "./App.css";
import Login from "./components/Login";
import Registration from "./components/Registration";
import ForgotPassword from "./components/ForgotPassword";
import Dashboard from "./components/Dashboard";
import PhoneListing from "./components/PhoneListing";
import { useAuth } from "./hooks/useAuth.jsx";

function App() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = (userData) => {
    if (!userData) return;

    // Extract user data — handle both shapes
    const unwrapped = userData.user
      ? { ...userData.user, ...(userData.role ? { role: userData.role } : {}) }
      : userData;

    // Store in auth context
    login(unwrapped);

    // Navigate to dashboard (single source of navigation)
    navigate("/dashboard", { replace: true });
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
        <Route path="/phones" element={<PhoneListing />} /> {/* ← ADD THIS */}
        {/* <Route path="/phones/:id" element={<PhoneDetail />} /> */}
        <Route path="*" element={<Navigate to="/login" replace />} />
        {/* <Route path="/phones" element={<PhoneListing />} /> */}
      </Routes>
    </div>
  );
}

export default App;
