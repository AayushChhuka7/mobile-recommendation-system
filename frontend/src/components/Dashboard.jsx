import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
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
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1-2-2h4" />
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
      <line x1="20" y1="10" x2="20" y2="3" />
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

function SparklesIcon() {
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
      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
      <path d="M19 14l.7 1.7L21.5 16.5l-1.8.8L19 19l-.7-1.7-1.8-.8 1.8-.8z" />
    </svg>
  );
}

function ChevronIcon({ open }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.2s ease",
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

const CATEGORY_OPTIONS = [
  { key: "gamer", label: "Gamer", icon: "🎮" },
  { key: "camera", label: "Camera lover", icon: "📷" },
  { key: "battery", label: "Battery focused", icon: "🔋" },
  { key: "allrounder", label: "All-rounder", icon: "✨" },
];

// Backend supports `hasOis` and `minBattery` as query params, mapped to specs filters.
const CATEGORY_FILTERS = {
  gamer: { sort: "antutu" },
  camera: { hasOis: "true", sort: "newest" },
  battery: { minBattery: 5000, sort: "newest" },
  allrounder: { sort: "newest" },
};

const DEFAULT_WEIGHTS = { gaming: 3, camera: 3, battery: 3, display: 3 };

// Filter options for the dashboard filter panel — only fields the backend
// already accepts in /api/phones (see buildPhoneWhereClause in phoneService.mjs).
const SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "name_asc", label: "Name A-Z" },
  { value: "name_desc", label: "Name Z-A" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "antutu", label: "Performance" },
];

const RAM_OPTIONS = [
  { value: "", label: "Any" },
  { value: "2", label: "2GB+" },
  { value: "4", label: "4GB+" },
  { value: "6", label: "6GB+" },
  { value: "8", label: "8GB+" },
  { value: "12", label: "12GB+" },
  { value: "16", label: "16GB+" },
];

const BATTERY_OPTIONS = [
  { value: "", label: "Any" },
  { value: "3000", label: "3000+ mAh" },
  { value: "4000", label: "4000+ mAh" },
  { value: "5000", label: "5000+ mAh" },
  { value: "6000", label: "6000+ mAh" },
];

// Initial empty filter state.
const EMPTY_FILTERS = {
  brand: "",
  minPrice: "",
  maxPrice: "",
  minRam: "",
  minBattery: "",
  os: "",
  has5G: false,
  hasNfc: false,
  hasOis: false,
};

// Build the query params for /phones from the active filters, sort, and page.
function buildPhonesQuery(filters, sort, extra = {}) {
  const params = { limit: 6, sort, ...extra };
  if (filters.brand) params.brand = filters.brand;
  if (filters.minPrice) params.minPrice = filters.minPrice;
  if (filters.maxPrice) params.maxPrice = filters.maxPrice;
  if (filters.minRam) params.minRam = filters.minRam;
  if (filters.minBattery) params.minBattery = filters.minBattery;
  if (filters.os) params.os = filters.os;
  if (filters.has5G) params.has5G = "true";
  if (filters.hasNfc) params.hasNfc = "true";
  if (filters.hasOis) params.hasOis = "true";
  return params;
}

function unwrapPhones(res) {
  const apiResponse = res?.data;

  if (!apiResponse) {
    console.warn("No data in response");
    return [];
  }

  if (apiResponse.data && Array.isArray(apiResponse.data)) {
    return apiResponse.data;
  }

  if (apiResponse.phones && Array.isArray(apiResponse.phones)) {
    return apiResponse.phones;
  }

  console.warn("Unexpected API response shape:", apiResponse);
  return [];
}

function Dashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [isProfileOpen, setProfileOpen] = useState(false);
  const [isSearchOpen, setSearchOpen] = useState(false);
  // Tracks the recommendation panel's animation phase.
  //   "closed"  — not rendered
  //   "open"    — fully visible
  //   "closing" — playing the close animation, will unmount after a short delay
  const [panelPhase, setPanelPhase] = useState("closed");
  const closeAnimMs = 180;

  // Keep a ref to the close-timer so a quick reopen can cancel the pending unmount.
  const closeTimerRef = useRef(null);
  const [selectedCategory, setSelectedCategory] = useState("gamer");
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [hoveredCard, setHoveredCard] = useState(null);

  // ---- Search + Filter state ----
  // `searchInput` is what's in the input; `searchTerm` is the committed term
  // used in the API call (mirrors the pattern in PhoneListing.jsx).
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [pendingFilters, setPendingFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState("newest");

  // Pagination state (mirrors the pattern in PhoneListing.jsx)
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Filter options fetched from the backend (brands, OS list)
  const [brands, setBrands] = useState([]);
  const [osOptions, setOsOptions] = useState([]);

  const [phones, setPhones] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const profileRef = useRef(null);
  const filterRef = useRef(null);

  // ---- Close profile/filter popovers on outside click ----
  useEffect(() => {
    function handleClickOutside(e) {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
      if (filterRef.current && !filterRef.current.contains(e.target)) {
        setShowFilters(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ---- Load filter options (brands + OS) once on mount ----
  useEffect(() => {
    let ignore = false;
    async function loadFilterOptions() {
      try {
        const res = await api.get("/phones/filters");
        const data = res?.data?.data;
        if (ignore || !data) return;
        if (Array.isArray(data.brands)) setBrands(data.brands);
        if (Array.isArray(data.os)) setOsOptions(data.os);
      } catch (err) {
        // Non-fatal: filter dropdowns just stay empty.
        console.error("Failed to load filter options:", err);
      }
    }
    loadFilterOptions();
    return () => {
      ignore = true;
    };
  }, []);

  // ---- Keep the recommendation modal mounted for the close animation ----
  // Driven from event handlers (not effects) so we don't cascade-render.
  const openRecommend = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setSearchOpen(true);
    setPanelPhase("open");
  }, []);

  const closeRecommend = useCallback(() => {
    setSearchOpen(false);
    setPanelPhase("closing");
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setPanelPhase("closed");
      closeTimerRef.current = null;
    }, closeAnimMs);
  }, []);

  // Clean up the close timer on unmount.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // ---- Initial phone load: respect search + filters if any are set ----
  useEffect(() => {
    let ignore = false;

    async function loadPhones() {
      setIsLoading(true);
      setError(null);
      try {
        const extra = { page };
        // `search` is supported by buildPhoneWhereClause on /phones, so we
        // can combine text + filter params in a single request.
        if (searchTerm) extra.search = searchTerm;

        const params = buildPhonesQuery(filters, sort, extra);
        const res = await api.get("/phones", { params });

        if (!ignore) {
          const phoneList = unwrapPhones(res);
          setPhones(phoneList);

          const meta = res?.data?.meta;
          if (meta) {
            setTotalPages(meta.totalPages || 1);
            setTotal(meta.total || phoneList.length);
          } else {
            setTotalPages(1);
            setTotal(phoneList.length);
          }
        }
      } catch (err) {
        if (!ignore) {
          if (err.response?.status === 401) {
            setError("Session expired. Please login again.");
            setTimeout(() => {
              logout();
              navigate("/login", { replace: true });
            }, 2000);
          } else {
            setError(
              err.response?.data?.message ||
                "Couldn't load phones. Please try again.",
            );
          }
        }
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }

    loadPhones();
    return () => {
      ignore = true;
    };
  }, [searchTerm, filters, sort, page, navigate, logout]);

  const handleSignOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch (err) {
      console.error("Logout error:", err);
    }
    logout();
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  const handleWeightChange = useCallback((key, value) => {
    setWeights((prev) => ({ ...prev, [key]: Number(value) }));
  }, []);

  // "Find my phone" from the questionnaire modal — preserves the original
  // recommendation behaviour by mapping a category to a filter set.
  const handleFindPhone = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // The category drives a fresh query, clearing the explicit search/filters
      // so we don't double-apply them.
      const categoryQuery = CATEGORY_FILTERS[selectedCategory] || {};
      const params = { limit: 6, page: 1, ...categoryQuery };

      const res = await api.get("/phones", { params });

      const phoneList = unwrapPhones(res);
      setPhones(phoneList);

      const meta = res?.data?.meta;
      if (meta) {
        setTotalPages(meta.totalPages || 1);
        setTotal(meta.total || phoneList.length);
      } else {
        setTotalPages(1);
        setTotal(phoneList.length);
      }
      setPage(1);
      closeRecommend();
    } catch (err) {
      setError(
        err.response?.data?.message ||
          "Couldn't fetch recommendations. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [selectedCategory, closeRecommend]);

  // ---- Search bar handlers ----
  const handleSearch = (e) => {
    e.preventDefault();
    const term = searchInput.trim();
    setSearchTerm(term); // empty string clears the term on the next load
    setShowFilters(false);
    setPage(1); // new search → restart at page 1
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setSearchTerm("");
    setPage(1);
  };

  // ---- Filter popover handlers ----
  const openFilters = () => {
    setPendingFilters(filters);
    setShowFilters((s) => !s);
  };

  const handlePendingChange = (key, value) => {
    setPendingFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleApplyFilters = () => {
    setFilters(pendingFilters);
    setShowFilters(false);
    setPage(1);
  };

  const handleClearFilters = () => {
    setPendingFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  // When the user changes the sort, restart at page 1.
  const handleSortChange = (nextSort) => {
    setSort(nextSort);
    setPage(1);
  };

  const displayName = user?.name || user?.username || "there";
  const email = user?.email || "";
  const phone = user?.phoneNo || user?.phone || "";
  const firstName = displayName.split(" ")[0];

  // Count of currently applied filters — used to render the badge on the
  // Filter button. Derived directly from `filters` (no extra effect needed).
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  // Pagination: show a window of up to 5 page numbers, centered on the
  // current page. (Same shape as PhoneListing.jsx.)
  const paginationStart =
    totalPages <= 5 ? 1 : Math.max(1, Math.min(totalPages - 4, page - 2));
  const pageNumbers = Array.from(
    { length: Math.min(5, totalPages) },
    (_, i) => paginationStart + i,
  );

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
            className="btn btn-primary dash-recommend-btn"
            onClick={openRecommend}
            aria-haspopup="dialog"
            aria-expanded={isSearchOpen}
            title="Get personalized phone recommendations"
          >
            <SparklesIcon />
            <span>Recommend Me a Phone</span>
          </button>

          <button
            type="button"
            className="icon-btn"
            aria-label="Open questionnaire"
            onClick={openRecommend}
            title="Find my phone"
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
        {/* ---- Search bar + Filter button (above the welcome message) ---- */}
        <section className="dash-search-section" aria-label="Search phones">
          <form
            className="dash-search-form"
            onSubmit={handleSearch}
            role="search"
          >
            <div className="dash-search-input-wrapper">
              <span className="dash-search-input-icon" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                type="text"
                className="dash-search-input"
                placeholder="Search phones by name or model..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label="Search phones by name or model"
              />
              {searchInput && (
                <button
                  type="button"
                  className="dash-search-clear"
                  onClick={handleClearSearch}
                  aria-label="Clear search"
                >
                  <CloseIcon />
                </button>
              )}
            </div>
            <button type="submit" className="btn btn-primary dash-search-btn">
              Search
            </button>

            <div className="dash-filter-wrapper" ref={filterRef}>
              <button
                type="button"
                className={`btn btn-outline dash-filter-btn ${showFilters ? "active" : ""}`}
                onClick={openFilters}
                aria-expanded={showFilters}
                aria-haspopup="dialog"
              >
                <SlidersIcon />
                <span>Filter</span>
                {activeFilterCount > 0 && (
                  <span className="dash-filter-badge">{activeFilterCount}</span>
                )}
              </button>

              {showFilters && (
                <div
                  className="dash-filter-popover"
                  role="dialog"
                  aria-label="Filter phones"
                >
                  <div className="dash-filter-popover-header">
                    <h3>Filters</h3>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setShowFilters(false)}
                      aria-label="Close filters"
                    >
                      <CloseIcon />
                    </button>
                  </div>

                  <div className="dash-filter-body">
                    {/* Brand */}
                    <div className="filter-group">
                      <label className="filter-label">Brand</label>
                      <select
                        className="filter-select"
                        value={pendingFilters.brand}
                        onChange={(e) =>
                          handlePendingChange("brand", e.target.value)
                        }
                      >
                        <option value="">All brands</option>
                        {brands.map((b) => (
                          <option key={b.id} value={b.name}>
                            {b.name} ({b.phoneCount})
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Price range */}
                    <div className="filter-group">
                      <label className="filter-label">Price (EUR)</label>
                      <div className="filter-range">
                        <input
                          type="number"
                          min="0"
                          placeholder="Min"
                          className="filter-input"
                          value={pendingFilters.minPrice}
                          onChange={(e) =>
                            handlePendingChange("minPrice", e.target.value)
                          }
                        />
                        <span className="filter-range-sep">–</span>
                        <input
                          type="number"
                          min="0"
                          placeholder="Max"
                          className="filter-input"
                          value={pendingFilters.maxPrice}
                          onChange={(e) =>
                            handlePendingChange("maxPrice", e.target.value)
                          }
                        />
                      </div>
                    </div>

                    {/* Minimum RAM */}
                    <div className="filter-group">
                      <label className="filter-label">Minimum RAM</label>
                      <select
                        className="filter-select"
                        value={pendingFilters.minRam}
                        onChange={(e) =>
                          handlePendingChange("minRam", e.target.value)
                        }
                      >
                        {RAM_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Minimum battery */}
                    <div className="filter-group">
                      <label className="filter-label">Minimum battery</label>
                      <select
                        className="filter-select"
                        value={pendingFilters.minBattery}
                        onChange={(e) =>
                          handlePendingChange("minBattery", e.target.value)
                        }
                      >
                        {BATTERY_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* OS */}
                    <div className="filter-group">
                      <label className="filter-label">Operating system</label>
                      <select
                        className="filter-select"
                        value={pendingFilters.os}
                        onChange={(e) =>
                          handlePendingChange("os", e.target.value)
                        }
                      >
                        <option value="">Any</option>
                        {osOptions.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Feature toggles */}
                    <div className="filter-group">
                      <label className="filter-label">Features</label>
                      <label className="filter-checkbox">
                        <input
                          type="checkbox"
                          checked={pendingFilters.has5G}
                          onChange={(e) =>
                            handlePendingChange("has5G", e.target.checked)
                          }
                        />
                        5G support
                      </label>
                      <label className="filter-checkbox">
                        <input
                          type="checkbox"
                          checked={pendingFilters.hasNfc}
                          onChange={(e) =>
                            handlePendingChange("hasNfc", e.target.checked)
                          }
                        />
                        NFC
                      </label>
                      <label className="filter-checkbox">
                        <input
                          type="checkbox"
                          checked={pendingFilters.hasOis}
                          onChange={(e) =>
                            handlePendingChange("hasOis", e.target.checked)
                          }
                        />
                        OIS camera
                      </label>
                    </div>

                    {/* Sort */}
                    <div className="filter-group">
                      <label className="filter-label">Sort by</label>
                      <select
                        className="filter-select"
                        value={sort}
                        onChange={(e) => handleSortChange(e.target.value)}
                      >
                        {SORT_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="dash-filter-popover-footer">
                    <button
                      type="button"
                      className="btn btn-outline w-full"
                      onClick={handleClearFilters}
                    >
                      Clear all
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary w-full"
                      onClick={handleApplyFilters}
                    >
                      Apply filters
                    </button>
                  </div>
                </div>
              )}
            </div>
          </form>
        </section>

        <div className="dash-welcome">
          <h1>Welcome back, {firstName}</h1>
          <p>
            {searchTerm
              ? `Results for "${searchTerm}"`
              : activeFilterCount > 0
                ? "Phones matching your filters"
                : "Phones recommended to you"}
          </p>
        </div>

        {isLoading && <p className="dash-status">Loading phones…</p>}

        {error && (
          <div className="dash-status dash-status-error">
            <p>{error}</p>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => window.location.reload()}
              style={{ marginTop: 8 }}
            >
              Retry
            </button>
          </div>
        )}

        {!isLoading && !error && phones.length === 0 && (
          <p className="dash-status">
            No phones found. Try adjusting your search or filters.
          </p>
        )}

        {!isLoading && !error && phones.length > 0 && (
          <div className="phone-grid">
            {phones.map((p) => (
              <div
                key={p.id}
                className={`phone-card ${hoveredCard === p.id ? "expanded" : ""}`}
                onMouseEnter={() => setHoveredCard(p.id)}
                onMouseLeave={() => setHoveredCard(null)}
              >
                <div className="phone-card-top">
                  <div className="phone-card-image">
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt={p.modelName}
                        onError={(e) => {
                          e.target.style.display = "none";
                          e.target.parentElement.classList.add("no-image");
                        }}
                      />
                    ) : (
                      <span className="phone-card-emoji">📱</span>
                    )}
                  </div>
                  <div className="phone-card-name">{p.modelName}</div>
                  <div className="phone-card-tagline">
                    {p.brand?.name || "Unknown brand"}
                  </div>
                </div>

                <div className="phone-card-details">
                  {p.keySpecs?.os && (
                    <div className="phone-spec">
                      <CpuIcon />
                      <span>{p.keySpecs.os}</span>
                    </div>
                  )}
                  {p.keySpecs?.camera && (
                    <div className="phone-spec">
                      <CameraIcon />
                      <span>{p.keySpecs.camera}</span>
                    </div>
                  )}
                  {p.keySpecs?.battery && (
                    <div className="phone-spec">
                      <BatteryIcon />
                      <span>{p.keySpecs.battery} mAh</span>
                    </div>
                  )}
                  {p.cheapestVariant?.price && (
                    <div className="phone-spec phone-price">
                      <TagIcon />
                      <span>
                        €{p.cheapestVariant.price}
                        {p.cheapestVariant.ram && p.cheapestVariant.storage
                          ? ` · ${p.cheapestVariant.ram}GB/${p.cheapestVariant.storage}GB`
                          : ""}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination — only when there is more than one page */}
        {!isLoading && !error && totalPages > 1 && (
          <div className="pagination" aria-label="Pagination">
            <button
              type="button"
              className="btn btn-outline"
              disabled={page <= 1}
              onClick={() => setPage(1)}
            >
              « First
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ‹ Prev
            </button>
            {pageNumbers.map((num) => (
              <button
                key={num}
                type="button"
                className={`btn ${page === num ? "btn-primary" : "btn-outline"}`}
                onClick={() => setPage(num)}
                aria-current={page === num ? "page" : undefined}
              >
                {num}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next ›
            </button>
            <button
              type="button"
              className="btn btn-outline"
              disabled={page >= totalPages}
              onClick={() => setPage(totalPages)}
            >
              Last »
            </button>
            <span className="pagination-info">
              Page {page} of {totalPages} ({total} phones)
            </span>
          </div>
        )}
      </main>

      {panelPhase !== "closed" && (
        <div
          className={`search-overlay dash-recommend-overlay ${panelPhase === "closing" ? "closing" : ""}`}
          onClick={closeRecommend}
        >
          <div
            className={`search-modal dash-recommend-modal ${panelPhase === "closing" ? "closing" : ""}`}
            role="dialog"
            aria-label="Phone recommendation"
            onClick={(e) => e.stopPropagation()}
          >
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
                aria-label="Close recommendation panel"
                onClick={closeRecommend}
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
              <button
                type="button"
                className="dash-weights-toggle"
                onClick={() => setWeightsOpen((o) => !o)}
                aria-expanded={weightsOpen}
                aria-controls="dash-weights-body"
              >
                <span className="dash-weights-title">
                  <SlidersIcon />
                  Customize weights
                </span>
                <ChevronIcon open={weightsOpen} />
              </button>
              <div className="questionnaire-hint">
                Fine-tune how much each factor matters to you
              </div>

              <div
                id="dash-weights-body"
                className={`dash-weights-body ${weightsOpen ? "open" : ""}`}
              >
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
            </div>

            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={handleFindPhone}
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
