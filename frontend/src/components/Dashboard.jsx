import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import "./Login.css";
import "./Dashboard.css";
import { UserIcon } from "./AuthShared";

function SearchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1" y="7" width="18" height="10" rx="2" ry="2" />
      <line x1="23" y1="11" x2="23" y2="13" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="15" x2="4" y2="15" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="15" x2="23" y2="15" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3 3v6.59a2 2 0 0 0 .59 1.41l9.58 9.59a2 2 0 0 0 2.82 0l4.6-4.6a2 2 0 0 0 0-2.82z" />
      <line x1="7.5" y1="7.5" x2="7.51" y2="7.5" />
    </svg>
  );
}

const CATEGORY_OPTIONS = [
  { key: "gamer", label: "Gamer", icon: "🎮" },
  { key: "camera", label: "Camera lover", icon: "📷" },
  { key: "battery", label: "Battery focused", icon: "🔋" },
  { key: "allrounder", label: "All-rounder", icon: "✨" },
];

const DEFAULT_WEIGHTS = { gaming: 3, camera: 3, battery: 3, display: 3 };

const DEMO_PHONES = [
  {
    id: 1,
    name: "Nova X200",
    tagline: "Flagship performance",
    camera: "108MP Triple Camera",
    battery: "5000mAh · 65W Fast Charge",
    processor: "Snapdragon 8 Gen 3",
    price: "$799",
  },
  {
    id: 2,
    name: "Pixelia S9",
    tagline: "Photography first",
    camera: "200MP Quad Camera + OIS",
    battery: "4700mAh · 45W Fast Charge",
    processor: "Dimensity 9300",
    price: "$699",
  },
  {
    id: 3,
    name: "Aero Lite 5G",
    tagline: "All-day endurance",
    camera: "64MP Dual Camera",
    battery: "6000mAh · 33W Fast Charge",
    processor: "Snapdragon 7s Gen 2",
    price: "$449",
  },
];

function Dashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [isProfileOpen, setProfileOpen] = useState(false);
  const [isSearchOpen, setSearchOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("gamer");
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [hoveredCard, setHoveredCard] = useState(null);

  const profileRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSignOut = useCallback(() => {
    if (typeof logout === "function") {
      logout();
    } else {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    }
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  const handleWeightChange = useCallback((key, value) => {
    setWeights((prev) => ({ ...prev, [key]: Number(value) }));
  }, []);

  const displayName = user?.name || user?.username || "there";
  const email = user?.email || "";
  const phone = user?.phoneNo || user?.phone || "";
  const firstName = displayName.split(" ")[0];

  return (
    <div className="dashboard-page">
      <header className="dash-header">
        <div className="login-brand">
          <div className="brand-icon" style={{ color: "#fff" }}>
            M
          </div>
          <div>
            <div className="dash-brand-title">Mobile Recommender</div>
            <div className="dash-brand-sub">Find your perfect phone</div>
          </div>
        </div>

        <div className="dash-header-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Search phones"
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon />
          </button>

          <div className="profile-menu" ref={profileRef}>
            <button
              type="button"
              className={`icon-btn profile-trigger ${isProfileOpen ? "active" : ""}`}
              aria-label="Account menu"
              onClick={() => setProfileOpen((o) => !o)}
            >
              <UserIcon />
            </button>

            {isProfileOpen && (
              <div className="profile-dropdown">
                <div className="profile-info">
                  <div className="profile-avatar">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="profile-details">
                    <div className="profile-name">{displayName}</div>
                    {email && <div className="profile-email">{email}</div>}
                    {phone && <div className="profile-phone">{phone}</div>}
                  </div>
                </div>
                <div className="profile-divider" />
                <button
                  type="button"
                  className="signout-btn"
                  onClick={handleSignOut}
                >
                  <LogoutIcon />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="dash-main">
        <div className="dash-welcome">
          <h1>Welcome back, {firstName}</h1>
          <p>Phones recommended to you</p>
        </div>

        <div className="phone-grid">
          {DEMO_PHONES.map((phone) => (
            <div
              key={phone.id}
              className={`phone-card ${hoveredCard === phone.id ? "expanded" : ""}`}
              onMouseEnter={() => setHoveredCard(phone.id)}
              onMouseLeave={() => setHoveredCard(null)}
            >
              <div className="phone-card-top">
                <div className="phone-card-icon">📱</div>
                <div className="phone-card-name">{phone.name}</div>
                <div className="phone-card-tagline">{phone.tagline}</div>
              </div>

              <div className="phone-card-details">
                <div className="phone-spec">
                  <CameraIcon />
                  <span>{phone.camera}</span>
                </div>
                <div className="phone-spec">
                  <BatteryIcon />
                  <span>{phone.battery}</span>
                </div>
                <div className="phone-spec">
                  <CpuIcon />
                  <span>{phone.processor}</span>
                </div>
                <div className="phone-spec phone-price">
                  <TagIcon />
                  <span>{phone.price}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>

      {isSearchOpen && (
        <div className="search-overlay" onClick={() => setSearchOpen(false)}>
          <div className="search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="search-modal-header">
              <div>
                <div className="auth-title" style={{ marginBottom: 4 }}>
                  Find your phone
                </div>
                <div className="auth-subtitle" style={{ marginBottom: 0 }}>
                  Tell us what matters most and we'll find your match.
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close search"
                onClick={() => setSearchOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="usage-options" style={{ marginTop: 20 }}>
              {CATEGORY_OPTIONS.map((opt) => (
                <button
                  type="button"
                  key={opt.key}
                  className={`usage-chip ${selectedCategory === opt.key ? "selected" : ""}`}
                  onClick={() => setSelectedCategory(opt.key)}
                >
                  <span style={{ marginRight: 6 }}>{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="questionnaire-section" style={{ marginTop: 20 }}>
              <div className="questionnaire-title dash-weights-title">
                <SlidersIcon />
                Customize weights
              </div>
              <div className="questionnaire-hint">
                Fine-tune how much each factor matters to you
              </div>

              {Object.entries(weights).map(([key, value]) => (
                <div className="weight-row" key={key}>
                  <div className="weight-row-label">
                    <span>{key.charAt(0).toUpperCase() + key.slice(1)}</span>
                    <span className="weight-value">{value}/5</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    value={value}
                    onChange={(e) => handleWeightChange(key, e.target.value)}
                    className="weight-slider"
                  />
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={() => setSearchOpen(false)}
            >
              Find my phone →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
