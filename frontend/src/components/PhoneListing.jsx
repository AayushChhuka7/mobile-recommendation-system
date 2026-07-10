import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth.jsx";
import "./Login.css";
import "./Dashboard.css";
import "./PhoneListing.css";
import { UserIcon } from "./AuthShared";

// ---- Icons ----
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

function FilterIcon() {
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

function XIcon() {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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

function CpuIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
      <rect x="9" y="9" width="6" height="6" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="1" y="7" width="18" height="10" rx="2" ry="2" />
      <line x1="23" y1="11" x2="23" y2="13" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

// ---- Sort Options ----
const SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "name_asc", label: "Name A-Z" },
  { value: "name_desc", label: "Name Z-A" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "antutu", label: "Performance" },
];

// ---- Unwrap API response ----
function unwrapPhones(res) {
  const apiResponse = res?.data;
  if (!apiResponse) return [];
  if (apiResponse.data && Array.isArray(apiResponse.data))
    return apiResponse.data;
  if (apiResponse.phones && Array.isArray(apiResponse.phones))
    return apiResponse.phones;
  return [];
}

function PhoneListing() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // Phone data
  const [phones, setPhones] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Search mode (when true, we hit /phones/search; when false, /phones with filters)
  const [searchMode, setSearchMode] = useState(false);
  const [searchInput, setSearchInput] = useState(""); // text in the input
  const [searchTerm, setSearchTerm] = useState(""); // committed term used in the API call

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Filters (only used in non-search mode)
  const [sort, setSort] = useState("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minRam, setMinRam] = useState("");
  const [has5G, setHas5G] = useState(false);
  const [hasNfc, setHasNfc] = useState(false);
  const [minBattery, setMinBattery] = useState("");

  // Filter options from API
  const [brands, setBrands] = useState([]);

  // Profile dropdown
  const [isProfileOpen, setProfileOpen] = useState(false);

  // Load filter options once
  useEffect(() => {
    async function loadFilters() {
      try {
        const res = await api.get("/phones/filters");
        if (res.data?.data?.brands) {
          setBrands(res.data.data.brands);
        }
      } catch (err) {
        console.error("Failed to load filters:", err);
      }
    }
    loadFilters();
  }, []);

  // List mode — GET /phones with filters/sort/pagination
  const loadPhones = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = { page, limit: 12, sort };

      if (selectedBrand) params.brand = selectedBrand;
      if (minPrice) params.minPrice = minPrice;
      if (maxPrice) params.maxPrice = maxPrice;
      if (minRam) params.minRam = minRam;
      if (has5G) params.has5G = "true";
      if (hasNfc) params.hasNfc = "true";
      if (minBattery) params.minBattery = minBattery;

      const res = await api.get("/phones", { params });
      const phoneList = unwrapPhones(res);
      setPhones(phoneList);

      if (res.data?.meta) {
        setTotalPages(res.data.meta.totalPages || 1);
        setTotal(res.data.meta.total || 0);
      } else {
        setTotalPages(1);
        setTotal(phoneList.length);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login", { replace: true });
      } else {
        setError("Failed to load phones. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [
    page,
    sort,
    selectedBrand,
    minPrice,
    maxPrice,
    minRam,
    has5G,
    hasNfc,
    minBattery,
    navigate,
    logout,
  ]);

  // Search mode — GET /phones/search?q=term with pagination
  const loadSearchResults = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get("/phones/search", {
        params: { q: searchTerm, page, limit: 12 },
      });
      const phoneList = unwrapPhones(res);
      setPhones(phoneList);

      if (res.data?.meta) {
        setTotalPages(res.data.meta.totalPages || 1);
        setTotal(res.data.meta.total || 0);
      } else {
        setTotalPages(1);
        setTotal(phoneList.length);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        logout();
        navigate("/login", { replace: true });
      } else {
        setError("Search failed. Please try again.");
      }
    } finally {
      setIsLoading(false);
    }
  }, [searchTerm, page, navigate, logout]);

  // Drive the right loader whenever inputs change
  useEffect(() => {
    if (searchMode) {
      loadSearchResults();
    } else {
      loadPhones();
    }
  }, [searchMode, loadPhones, loadSearchResults]);

  // ---- Handlers ----

  // Submit the search form
  const handleSearch = (e) => {
    e.preventDefault();
    const term = searchInput.trim();
    if (!term) {
      // Empty submit => clear search and show all phones
      handleClearSearch();
      return;
    }
    setSearchTerm(term);
    setSearchMode(true);
    setPage(1);
    setShowFilters(false);
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setSearchTerm("");
    setSearchMode(false);
    setPage(1);
  };

  const handleApplyFilters = () => {
    setShowFilters(false);
    setPage(1);
  };

  const handleClearFilters = () => {
    setSelectedBrand("");
    setMinPrice("");
    setMaxPrice("");
    setMinRam("");
    setHas5G(false);
    setHasNfc(false);
    setMinBattery("");
    setPage(1);
  };

  const handleSignOut = async () => {
    try {
      await api.post("/auth/logout");
    } catch (err) {
      /* ignore */
    }
    logout();
    navigate("/login", { replace: true });
  };

  const displayName = user?.name || user?.username || "there";
  const email = user?.email || "";

  // Page-number window (up to 5, centered on current page)
  const start =
    totalPages <= 5
      ? 1
      : Math.max(1, Math.min(totalPages - 4, page - 2));
  const pageNumbers = Array.from(
    { length: Math.min(5, totalPages) },
    (_, i) => start + i,
  );

  return (
    <div className="dashboard-page">
      {/* Header */}
      <header className="dash-header">
        <div className="login-brand">
          <div className="brand-icon" style={{ color: "#fff" }}>
            M
          </div>
          <div>
            <div className="dash-brand-title">Mobile Recommender</div>
            <div className="dash-brand-sub">Browse phones</div>
          </div>
        </div>

        <div className="dash-header-actions">
          <div className="profile-menu" style={{ position: "relative" }}>
            <button
              type="button"
              className={`icon-btn profile-trigger ${isProfileOpen ? "active" : ""}`}
              onClick={() => setProfileOpen((o) => !o)}
            >
              <UserIcon />
            </button>
            {isProfileOpen && (
              <div className="profile-dropdown" style={{ right: 0 }}>
                <div className="profile-info">
                  <div className="profile-avatar">
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                  <div className="profile-details">
                    <div className="profile-name">{displayName}</div>
                    {email && <div className="profile-email">{email}</div>}
                  </div>
                </div>
                <div className="profile-divider" />
                <button
                  type="button"
                  className="signout-btn"
                  onClick={handleSignOut}
                >
                  <LogoutIcon /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Search & Toolbar */}
      <div className="phone-toolbar">
        <form onSubmit={handleSearch} className="phone-search-form">
          <input
            type="text"
            placeholder="Search phones by name..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="phone-search-input"
          />
          <button type="submit" className="phone-search-btn">
            <SearchIcon />
          </button>
          {searchMode && (
            <button
              type="button"
              className="btn btn-outline"
              onClick={handleClearSearch}
              style={{ marginLeft: 8 }}
            >
              Clear
            </button>
          )}
        </form>

        <div className="phone-toolbar-actions">
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
            className="phone-sort-select"
            disabled={searchMode}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            className={`btn btn-outline ${showFilters ? "active" : ""}`}
            onClick={() => setShowFilters((s) => !s)}
            disabled={searchMode}
            title={searchMode ? "Filters unavailable during search" : ""}
          >
            <FilterIcon /> Filters
          </button>
        </div>
      </div>

      <div className="phone-listing-layout">
        {/* Filter Sidebar — hidden in search mode */}
        {showFilters && !searchMode && (
          <aside className="phone-filters-sidebar">
            <div className="filter-header">
              <h3>Filters</h3>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowFilters(false)}
              >
                <XIcon />
              </button>
            </div>

            {/* Brand */}
            <div className="filter-group">
              <label className="filter-label">Brand</label>
              <select
                value={selectedBrand}
                onChange={(e) => setSelectedBrand(e.target.value)}
                className="filter-select"
              >
                <option value="">All Brands</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.name}>
                    {b.name} ({b.phoneCount})
                  </option>
                ))}
              </select>
            </div>

            {/* Price Range */}
            <div className="filter-group">
              <label className="filter-label">Price (EUR)</label>
              <div className="filter-range">
                <input
                  type="number"
                  placeholder="Min"
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  className="filter-input"
                />
                <span>–</span>
                <input
                  type="number"
                  placeholder="Max"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  className="filter-input"
                />
              </div>
            </div>

            {/* RAM */}
            <div className="filter-group">
              <label className="filter-label">Minimum RAM (GB)</label>
              <select
                value={minRam}
                onChange={(e) => setMinRam(e.target.value)}
                className="filter-select"
              >
                <option value="">Any</option>
                {[2, 4, 6, 8, 12, 16].map((r) => (
                  <option key={r} value={r}>
                    {r}GB+
                  </option>
                ))}
              </select>
            </div>

            {/* Battery */}
            <div className="filter-group">
              <label className="filter-label">Minimum Battery (mAh)</label>
              <select
                value={minBattery}
                onChange={(e) => setMinBattery(e.target.value)}
                className="filter-select"
              >
                <option value="">Any</option>
                <option value="3000">3000+</option>
                <option value="4000">4000+</option>
                <option value="5000">5000+</option>
                <option value="6000">6000+</option>
              </select>
            </div>

            {/* Features */}
            <div className="filter-group">
              <label className="filter-label">Features</label>
              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={has5G}
                  onChange={(e) => setHas5G(e.target.checked)}
                />
                5G Support
              </label>
              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={hasNfc}
                  onChange={(e) => setHasNfc(e.target.checked)}
                />
                NFC
              </label>
            </div>

            <div className="filter-actions">
              <button
                type="button"
                className="btn btn-primary w-full"
                onClick={handleApplyFilters}
              >
                Apply Filters
              </button>
              <button
                type="button"
                className="btn btn-outline w-full"
                onClick={handleClearFilters}
              >
                Clear All
              </button>
            </div>
          </aside>
        )}

        {/* Phone Grid */}
        <main
          className={`phone-grid-area ${showFilters && !searchMode ? "with-sidebar" : ""}`}
        >
          {/* Results count */}
          <div className="phone-results-count">
            {searchMode
              ? `Search results for "${searchTerm}" — ${total} phones`
              : total > 0
                ? `${total} phones found`
                : ""}
          </div>

          {isLoading && <p className="dash-status">Loading phones…</p>}
          {error && <p className="dash-status dash-status-error">{error}</p>}

          {!isLoading && !error && phones.length === 0 && (
            <p className="dash-status">
              {searchMode
                ? `No phones found for "${searchTerm}".`
                : "No phones found. Try different filters."}
            </p>
          )}

          {!isLoading && !error && phones.length > 0 && (
            <>
              <div className="phone-grid">
                {phones.map((p) => (
                  <div
                    key={p.id}
                    className="phone-card"
                    onClick={() => navigate(`/phones/${p.id}`)}
                    style={{ cursor: "pointer" }}
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
                        {p.brand?.name || "Unknown"}
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
                          <span>€{p.cheapestVariant.price}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              <div className="pagination">
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default PhoneListing;
