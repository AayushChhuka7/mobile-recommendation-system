import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth.jsx";
<<<<<<< HEAD
=======
import { useEventLogger } from "../hooks/useEventLogger.jsx";
>>>>>>> proxy-dev
import "./Login.css";
import "./Dashboard.css";
import "./PhoneListing.css";
import {
  UserIcon,
  SearchIcon,
  LogoutIcon,
  FilterIcon,
  XIcon,
  TagIcon,
  CpuIcon,
  BatteryIcon,
  CameraIcon,
} from "./AuthShared";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest First" },
  { value: "oldest", label: "Oldest First" },
  { value: "name_asc", label: "Name A-Z" },
  { value: "name_desc", label: "Name Z-A" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "antutu", label: "Performance" },
];
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
<<<<<<< HEAD
=======
  // Step B — fire-and-forget hook for behaviour events. Used for
  // search submit, filter apply, and phone-card click. The hook
  // swallows errors so it can never break a user-facing interaction.
  const logEvent = useEventLogger();
>>>>>>> proxy-dev

  const [phones, setPhones] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchMode, setSearchMode] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [sort, setSort] = useState("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedBrand, setSelectedBrand] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minRam, setMinRam] = useState("");
  const [has5G, setHas5G] = useState(false);
  const [hasNfc, setHasNfc] = useState(false);
  const [minBattery, setMinBattery] = useState("");

  const [brands, setBrands] = useState([]);

  const [isProfileOpen, setProfileOpen] = useState(false);

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

  useEffect(() => {
    if (searchMode) {
      loadSearchResults();
    } else {
      loadPhones();
    }
  }, [searchMode, loadPhones, loadSearchResults]);

  const handleSearch = (e) => {
    e.preventDefault();
    const term = searchInput.trim();
    if (!term) {
      handleClearSearch();
      return;
    }
    setSearchTerm(term);
    setSearchMode(true);
    setPage(1);
    setShowFilters(false);
<<<<<<< HEAD
=======
    // Step B — record the search signal so the per-tag BehaviourScore
    // sees gaming/chipset/brand interest over time.
    logEvent("search", {
      payload: { q: term, mode: "query" },
    });
>>>>>>> proxy-dev
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
<<<<<<< HEAD
=======
    // Step B — a filter-only "I'm looking for X" signal. The BE
    // filter logger already records the SearchHistory row server-side;
    // we just mirror it into the unified event log here so the FE
    // hook is the single source-of-truth for these signals.
    logEvent("search", {
      payload: {
        mode: "filters",
        filters: {
          brand: selectedBrand || null,
          minPrice: minPrice || null,
          maxPrice: maxPrice || null,
          minRam: minRam || null,
          minBattery: minBattery || null,
          has5G: !!has5G,
          hasNfc: !!hasNfc,
        },
        sort,
      },
    });
>>>>>>> proxy-dev
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
  const start =
    totalPages <= 5 ? 1 : Math.max(1, Math.min(totalPages - 4, page - 2));
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
<<<<<<< HEAD
                    onClick={() => navigate(`/phones/${p.id}`)}
=======
                    onClick={() => {
                      // Step B — log the click signal before navigation
                      // so the BehaviorScore sees the brand/category bump.
                      logEvent("click", { phoneId: p.id });
                      navigate(`/phones/${p.id}`);
                    }}
>>>>>>> proxy-dev
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
