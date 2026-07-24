import { useNavigate } from "react-router-dom";
import "./App.css";
import Login from "./components/Login";
import Registration from "./components/Registration";
import ForgotPassword from "./components/ForgotPassword";
import Dashboard from "./components/Dashboard";
import PhoneListing from "./components/PhoneListing";
import { useAuth } from "./hooks/useAuth.jsx";
import Compare from "./components/Compare.jsx";
import PhoneDetail from "./components/PhoneDetail.jsx";

function App() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = (userData) => {
    if (!userData) return;
    const unwrapped = userData.user
      ? { ...userData.user, ...(userData.role ? { role: userData.role } : {}) }
      : userData;
    login(unwrapped);
    navigate("/dashboard", { replace: true });
  };

  // Return based on current path
  const path = window.location.pathname;

  if (path.startsWith("/login")) return <Login onLogin={handleLogin} />;
  if (path.startsWith("/register"))
    return <Registration onLogin={handleLogin} />;
  if (path.startsWith("/forgot-password")) return <ForgotPassword />;
  if (path.startsWith("/dashboard")) return <Dashboard />;
  // /phones/:id must be matched before the broader /phones check below,
  // since startsWith("/phones") would otherwise swallow the detail route.
  if (path.match(/^\/phones\/[^/]+/)) return <PhoneDetail />;
  if (path.startsWith("/phones")) return <PhoneListing />;
  if (path.startsWith("/compare")) return <Compare />;

  return <Login onLogin={handleLogin} />;
}

export default App;
