import { useState } from "react";
import { useNavigate } from "react-router-dom";
import "./App.css";
import Login from "./components/Login";
import { useAuth } from "./hooks/useAuth.jsx";

function App() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [authPage, setAuthPage] = useState("login");

  const handleLogin = (userData) => {
    // Login.jsx calls onLogin with:
    //  - The full /auth/login response body: { message, user: { id, email } }
    //  - A synthesized user object after registration OTP verify: { name, email, roleName }
    // We unwrap to the user object either way, then navigate.
    if (!userData) return;

    const unwrapped = userData.user
      ? { ...userData.user, ...(userData.role ? { role: userData.role } : {}) }
      : userData;

    // Anything with an id/email is treated as "logged in".
    if (unwrapped.id || unwrapped.userId || unwrapped.email) {
      // Write user + storage FIRST, then navigate. Order matters:
      // if we navigated first, the route guard would see the previous
      // (null) user state for one render and bounce us back to "/".
      login(unwrapped);
      navigate("/dashboard", { replace: true });
    }
  };

  const handleNavigate = (page) => setAuthPage(page);

  return (
    <div className="app">
      <Login
        onLogin={handleLogin}
        onNavigate={handleNavigate}
        authPage={authPage}
      />
    </div>
  );
}

export default App;
