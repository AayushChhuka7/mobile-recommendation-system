import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth.jsx";
import "./Dashboard.css";

function Dashboard() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePage, setActivePage] = useState("overview");
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();

  const displayName = user?.name || user?.username || user?.email || "User";
  const role = user?.role || user?.roleName || "Customer";
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await api.post("/auth/logout");
    } catch (err) {
      // Even if the server call fails, log the user out locally.
      console.error(err);
    } finally {
      logout();
      setLoggingOut(false);
      navigate("/", { replace: true });
    }
  };

  const navItems = [
    { id: "overview", label: "Overview", icon: "🏠" },
    { id: "recommendations", label: "Recommendations", icon: "📱" },
    { id: "profile", label: "My Profile", icon: "👤" },
    { id: "settings", label: "Settings", icon: "⚙️" },
  ];

  return (
    <div className={`dashboard ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <span className="logo-icon">📱</span>
            <span className="logo-text">MobileRec</span>
          </div>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? "◀" : "▶"}
          </button>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${activePage === item.id ? "active" : ""}`}
              onClick={() => setActivePage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {sidebarOpen && <span className="nav-label">{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            className="logout-btn"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <span className="nav-icon">🚪</span>
            {sidebarOpen && (
              <span>{loggingOut ? "Signing out..." : "Sign out"}</span>
            )}
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <h1 className="page-title">
              {navItems.find((item) => item.id === activePage)?.label}
            </h1>
            <p className="page-subtitle">
              Welcome back, {displayName.split(" ")[0]} 👋
            </p>
          </div>
          <div className="user-chip">
            <div className="avatar">{initials}</div>
            <div className="user-info">
              <div className="user-name">{displayName}</div>
              <div className="user-role">{role}</div>
            </div>
          </div>
        </header>

        <div className="page-body">
          {activePage === "overview" && (
            <div className="page-grid">
              <div className="stat-card">
                <div className="stat-label">Recommendations</div>
                <div className="stat-value">0</div>
                <div className="stat-hint">Start browsing phones</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Saved Devices</div>
                <div className="stat-value">0</div>
                <div className="stat-hint">Bookmark to see them here</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Account Status</div>
                <div className="stat-value status-active">Active</div>
                <div className="stat-hint">Role: {role}</div>
              </div>
            </div>
          )}

          {activePage === "recommendations" && (
            <div className="placeholder-card">
              <div className="placeholder-icon">📱</div>
              <h2>Mobile recommendations coming soon</h2>
              <p>
                Once the recommendation engine is wired up on the backend,
                you'll see your personalized picks here.
              </p>
            </div>
          )}

          {activePage === "profile" && (
            <div className="profile-card">
              <div className="profile-header">
                <div className="avatar avatar-lg">{initials}</div>
                <div>
                  <h2>{displayName}</h2>
                  <p className="muted">{user?.email || "—"}</p>
                </div>
              </div>
              <div className="profile-grid">
                <div className="profile-field">
                  <span className="field-label">Email</span>
                  <span className="field-value">{user?.email || "—"}</span>
                </div>
                <div className="profile-field">
                  <span className="field-label">Phone</span>
                  <span className="field-value">{user?.phoneNo || user?.phone || "—"}</span>
                </div>
                <div className="profile-field">
                  <span className="field-label">Role</span>
                  <span className="field-value">{role}</span>
                </div>
                <div className="profile-field">
                  <span className="field-label">User ID</span>
                  <span className="field-value mono">{user?.userId || user?.id || "—"}</span>
                </div>
              </div>
            </div>
          )}

          {activePage === "settings" && (
            <div className="placeholder-card">
              <div className="placeholder-icon">⚙️</div>
              <h2>Settings</h2>
              <p>Account preferences and notification settings will live here.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default Dashboard;
