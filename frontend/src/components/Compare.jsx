import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth.jsx";
import "./Dashboard.css";
import "./Compare.css";
import {
  UserIcon,
  SearchIcon,
  CloseIcon,
  LogoutIcon,
  CameraIcon,
  BatteryIcon,
  CpuIcon,
  TagIcon,
} from "./AuthShared";

// ---- Debounce helper ----
function useDebounce(callback, delay) {
  const timerRef = useRef(null);
  return (...args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => callback(...args), delay);
  };
}

// ---- Autocomplete Input Component ----
function PhoneAutocomplete({ label, selectedPhone, onSelect, placeholder }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);

  const fetchSuggestions = async (value) => {
    if (!value || value.trim().length < 1) {
      setSuggestions([]);
      return;
    }
    setIsLoading(true);
    try {
      const res = await api.get("/phones/search", {
        params: { q: value, limit: 5 },
      });
      setSuggestions(res.data?.data || []);
      setShowDropdown(true);
    } catch (err) {
      console.error("Autocomplete error:", err);
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  };

  const debouncedFetch = useDebounce(fetchSuggestions, 300);

  const handleInputChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    if (selectedPhone && selectedPhone.modelName !== value) {
      onSelect(null);
    }
    debouncedFetch(value);
  };

  const handleSelect = (phone) => {
    setQuery(phone.modelName);
    setSuggestions([]);
    setShowDropdown(false);
    onSelect(phone);
  };

  const handleFocus = () => {
    if (suggestions.length > 0) setShowDropdown(true);
  };

  const handleBlur = () => {
    setTimeout(() => setShowDropdown(false), 200);
  };

  return (
    <div className="compare-input-group">
      <label className="compare-input-label">{label}</label>
      <div className="autocomplete-wrapper">
        <input
          type="text"
          className="input-field compare-autocomplete-input"
          placeholder={placeholder || "Search phone..."}
          value={selectedPhone ? selectedPhone.modelName : query}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          disabled={!!selectedPhone}
        />
        {isLoading && <span className="autocomplete-spinner">⟳</span>}
        {selectedPhone && (
          <button
            type="button"
            className="autocomplete-clear"
            onClick={() => {
              onSelect(null);
              setQuery("");
            }}
          >
            <CloseIcon />
          </button>
        )}
        {showDropdown && suggestions.length > 0 && (
          <ul className="autocomplete-dropdown">
            {suggestions.map((p) => (
              <li key={p.id} onMouseDown={() => handleSelect(p)}>
                <div className="ac-info">
                  <span className="ac-name">{p.modelName}</span>
                  <span className="ac-brand">{p.brand?.name}</span>
                </div>
                {p.cheapestVariant?.price && (
                  <span className="ac-price">€{p.cheapestVariant.price}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {showDropdown &&
          !isLoading &&
          suggestions.length === 0 &&
          query.length >= 1 && (
            <ul className="autocomplete-dropdown">
              <li className="ac-no-results">No phones found</li>
            </ul>
          )}
      </div>
    </div>
  );
}

// ---- Category Comparison Row ----
function CompareCategoryRow({ label, value1, value2, winner, format }) {
  const fmt = format || ((v) => (v != null ? String(v) : "—"));
  return (
    <div className="compare-category-row">
      <span className="compare-cat-label">{label}</span>
      <span
        className={`compare-cat-val ${winner === "phone1" ? "winner-val" : ""}`}
      >
        {fmt(value1)}
        {winner === "phone1" && " 🏆"}
      </span>
      <span
        className={`compare-cat-val ${winner === "phone2" ? "winner-val" : ""}`}
      >
        {fmt(value2)}
        {winner === "phone2" && " 🏆"}
      </span>
    </div>
  );
}

// ---- Get winner helper ----
function getWinner(val1, val2, higherIsBetter = true) {
  if (val1 == null && val2 == null) return null;
  if (val1 == null) return "phone2";
  if (val2 == null) return "phone1";
  if (val1 === val2) return "tie";
  return higherIsBetter
    ? val1 > val2
      ? "phone1"
      : "phone2"
    : val1 < val2
      ? "phone1"
      : "phone2";
}

// ---- Main Compare Component ----
function Compare() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [phone1, setPhone1] = useState(null);
  const [phone2, setPhone2] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isProfileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef(null);

  // Close profile on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleCompare = async () => {
    if (!phone1 || !phone2) return;
    setIsLoading(true);
    setError("");
    try {
      const res = await api.post("/phones/compare", {
        phoneIds: [phone1.id, phone2.id],
      });
      setCompareResult(res.data?.data || []);
    } catch (err) {
      setError(
        err.response?.data?.message || "Comparison failed. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setCompareResult(null);
    setPhone1(null);
    setPhone2(null);
    setError("");
  };

  const handleSignOut = async () => {
    try {
      await api.post("/auth/logout");
    } catch (e) {
      /* ignore */
    }
    logout();
    navigate("/login", { replace: true });
  };

  const displayName = user?.name || "there";

  // Build comparison categories from result
  const comparisonCategories = compareResult
    ? [
        {
          label: "Price",
          value1: parseFloat(compareResult[0]?.pricing?.cheapest?.price || 0),
          value2: parseFloat(compareResult[1]?.pricing?.cheapest?.price || 0),
          higherIsBetter: false,
          format: (v) => `€${v}`,
        },
        {
          label: "Performance (AnTuTu)",
          value1: compareResult[0]?.antutuScore,
          value2: compareResult[1]?.antutuScore,
          higherIsBetter: true,
          format: (v) => v?.toLocaleString() || "—",
        },
        {
          label: "Display Size",
          value1: parseFloat(compareResult[0]?.specs?.display?.size || 0),
          value2: parseFloat(compareResult[1]?.specs?.display?.size || 0),
          higherIsBetter: true,
          format: (v) => `${v}"`,
        },
        {
          label: "Refresh Rate",
          value1: compareResult[0]?.specs?.display?.refreshRate,
          value2: compareResult[1]?.specs?.display?.refreshRate,
          higherIsBetter: true,
          format: (v) => (v ? `${v}Hz` : "—"),
        },
        {
          label: "Main Camera",
          value1: compareResult[0]?.specs?.camera?.lensCount,
          value2: compareResult[1]?.specs?.camera?.lensCount,
          higherIsBetter: true,
          format: (v) => (v ? `${v} lenses` : "—"),
        },
        {
          label: "Battery",
          value1: compareResult[0]?.specs?.battery?.capacity,
          value2: compareResult[1]?.specs?.battery?.capacity,
          higherIsBetter: true,
          format: (v) => (v ? `${v}mAh` : "—"),
        },
        {
          label: "Charging",
          value1: compareResult[0]?.specs?.battery?.wiredCharging,
          value2: compareResult[1]?.specs?.battery?.wiredCharging,
          higherIsBetter: true,
          format: (v) => (v ? `${v}W` : "—"),
        },
        {
          label: "OS",
          value1: compareResult[0]?.specs?.platform?.os,
          value2: compareResult[1]?.specs?.platform?.os,
          higherIsBetter: true,
          format: (v) => v || "—",
        },
        {
          label: "5G",
          value1: compareResult[0]?.specs?.network?.supports5g,
          value2: compareResult[1]?.specs?.network?.supports5g,
          higherIsBetter: true,
          format: (v) => (v ? "✅" : "❌"),
        },
        {
          label: "NFC",
          value1: compareResult[0]?.specs?.network?.supportsNfc,
          value2: compareResult[1]?.specs?.network?.supportsNfc,
          higherIsBetter: true,
          format: (v) => (v ? "✅" : "❌"),
        },
        {
          label: "Headphone Jack",
          value1: compareResult[0]?.specs?.network?.headphoneJack,
          value2: compareResult[1]?.specs?.network?.headphoneJack,
          higherIsBetter: true,
          format: (v) => (v ? "✅" : "❌"),
        },
        {
          label: "Weight",
          value1: parseFloat(compareResult[0]?.specs?.physical?.weight || 0),
          value2: parseFloat(compareResult[1]?.specs?.physical?.weight || 0),
          higherIsBetter: false,
          format: (v) => `${v}g`,
        },
      ]
    : [];

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
            <div className="dash-brand-sub">Compare phones side by side</div>
          </div>
        </div>

        <div className="dash-header-actions">
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => navigate("/phones")}
          >
            ← Browse phones
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => navigate("/dashboard")}
          >
            Dashboard
          </button>

          <div className="profile-menu" ref={profileRef}>
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
                  <div className="profile-name">{displayName}</div>
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

      {/* Main Content */}
      <main className="compare-page-main">
        <div className="compare-page-header">
          <h1>Compare Phones</h1>
          <p>Select two phones to compare their specifications side by side</p>
        </div>

        {/* Selection Area */}
        <div className="compare-selection-area">
          <div className="compare-selection-grid">
            <PhoneAutocomplete
              label="Phone 1"
              selectedPhone={phone1}
              onSelect={setPhone1}
              placeholder="Search first phone..."
            />
            <div className="compare-vs-divider">
              <span>VS</span>
            </div>
            <PhoneAutocomplete
              label="Phone 2"
              selectedPhone={phone2}
              onSelect={setPhone2}
              placeholder="Search second phone..."
            />
          </div>

          <div className="compare-action-area">
            <button
              type="button"
              className="btn btn-primary compare-btn"
              onClick={handleCompare}
              disabled={!phone1 || !phone2 || isLoading}
            >
              {isLoading ? "Comparing..." : "Compare Phones"}
            </button>
            {(phone1 || phone2) && (
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleReset}
              >
                Clear selection
              </button>
            )}
          </div>

          {error && <p className="compare-error-banner">{error}</p>}
        </div>

        {/* Results Area */}
        {compareResult && compareResult.length === 2 && (
          <div className="compare-results-area">
            {/* Phone Cards */}
            <div className="compare-results-cards">
              {compareResult.map((phone, idx) => {
                const other = compareResult[1 - idx];
                const isOverallWinner =
                  (phone.antutuScore || 0) > (other?.antutuScore || 0);
                return (
                  <div
                    key={phone.id}
                    className={`compare-result-card ${isOverallWinner ? "winner" : ""}`}
                  >
                    {isOverallWinner && (
                      <span className="winner-badge">🏆 Best Pick</span>
                    )}
                    <div className="compare-result-image">
                      {phone.imageUrl ? (
                        <img src={phone.imageUrl} alt={phone.modelName} />
                      ) : (
                        <span className="compare-result-emoji">📱</span>
                      )}
                    </div>
                    <h3 className="compare-result-name">{phone.modelName}</h3>
                    <p className="compare-result-brand">{phone.brand?.name}</p>
                    <p className="compare-result-price">
                      €{phone.pricing?.cheapest?.price || "—"}
                    </p>
                    <div className="compare-result-specs">
                      {phone.specs?.platform?.chipset && (
                        <div className="compare-spec-chip">
                          <CpuIcon /> {phone.specs.platform.chipset}
                        </div>
                      )}
                      {phone.specs?.camera?.main && (
                        <div className="compare-spec-chip">
                          <CameraIcon /> {phone.specs.camera.main}
                        </div>
                      )}
                      {phone.specs?.battery?.capacity && (
                        <div className="compare-spec-chip">
                          <BatteryIcon /> {phone.specs.battery.capacity}mAh
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Category Comparison Table */}
            <div className="compare-categories-table">
              <h3>Detailed Comparison</h3>
              {comparisonCategories.map((cat) => {
                const winner = getWinner(
                  cat.value1,
                  cat.value2,
                  cat.higherIsBetter,
                );
                return (
                  <CompareCategoryRow
                    key={cat.label}
                    label={cat.label}
                    value1={cat.value1}
                    value2={cat.value2}
                    winner={winner}
                    format={cat.format}
                  />
                );
              })}
            </div>

            <button
              type="button"
              className="btn btn-outline compare-new-btn"
              onClick={handleReset}
            >
              Compare different phones
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default Compare;
