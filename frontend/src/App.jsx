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
import AdminCustomerList from "./components/AdminCustomerList.jsx";
import AdminCustomerDetail from "./components/AdminCustomerDetail.jsx";

function App() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = (userData) => {
    if (!userData) return;
    // Axios response shape from POST /api/auth/login:
    //   { success: true, data: { user: { id, email } }, message: "..." }
    // The "/api/users/me" response (used by useAuth to hydrate role +
    // name + phoneNo) has a different shape:
    //   { success: true, data: { userId, name, email, phoneNo, role }, ... }
    // We normalise both to a flat user record so the dashboard and
    // localStorage see a consistent shape. Anything missing here gets
    // hydrated by useAuth.login() via /users/me.
    const record = userData.data?.user
      ? userData.data.user
      : userData.user
        ? userData.user
        : userData;
    // The login endpoint returns `{ id, email }` but downstream code
    // (Dashboard auto-recommend, useAuth hydration) expects `userId`.
    // Normalise to both names so a fresh user has `userId` populated
    // the moment they land on the dashboard.
    const unwrapped = {
      ...record,
      ...(record.userId ? {} : record.id ? { userId: record.id } : {}),
      ...(record.id ? { id: record.id } : {}),
      ...(record.role ? { role: record.role } : {}),
    };
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
  // Admin: customer-profiles detail must match before the listing, same
  // reason as /phones/:id above. The role guard lives inside the
  // components via `useAdminGuard` — non-admins get redirected.
  if (path.match(/^\/admin\/customer-profiles\/[^/]+$/))
    return <AdminCustomerDetail />;
  if (path.startsWith("/admin/customer-profiles"))
    return <AdminCustomerList />;

  return <Login onLogin={handleLogin} />;
}

export default App;
