import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { getPhoneById } from "../services/phones";
import { postCompareMl } from "../services/recommend";
import { formatPriceNpr } from "../utils/formatPrice.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { PhoneDetailView } from "./PhoneDetail";
import "./Dashboard.css";
import "./Compare.css";
import { UserIcon, CloseIcon, LogoutIcon, ChevronDownIcon } from "./AuthShared";

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
                  <span className="ac-price">{formatPriceNpr(p.cheapestVariant.price) ?? "—"}</span>
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

// ---- Pretty-print a dimension key like "Connectivity" -> "Connectivity" ----
function prettyDim(dim) {
  return dim;
}

function formatScore(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(1);
}

function formatMlPrice(price) {
  if (price == null || Number.isNaN(Number(price))) return "—";
  return formatPriceNpr(price) ?? "—";
}

// ---- Full-detail panel for a single phone (uses GET /phones/:id) ----
function PhoneFullDetailPanel({ phone, index, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inFlightRef = useRef(null);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      // Lazy-load the full detail the first time we open.
      if (next && !detail && !loading && inFlightRef.current !== phone.id) {
        loadDetail();
      }
      return next;
    });
  };

  const loadDetail = async () => {
    inFlightRef.current = phone.id;
    setLoading(true);
    setError(null);
    try {
      const data = await getPhoneById(phone.id);
      setDetail(data);
    } catch (err) {
      setError(
        err?.response?.data?.message || "Couldn't load full specifications.",
      );
    } finally {
      setLoading(false);
      inFlightRef.current = null;
    }
  };

  return (
    <div className={`compare-fulldetail-panel ${open ? "open" : ""}`}>
      <button
        type="button"
        className="compare-fulldetail-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`compare-fulldetail-${phone.id}`}
      >
        <span>
          <span className="compare-fulldetail-tag">Phone {index + 1}</span>
          <span className="compare-fulldetail-name">
            {phone.modelName || "—"}
          </span>
        </span>
        <span className="compare-fulldetail-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </button>

      {open && (
        <div
          className="compare-fulldetail-body"
          id={`compare-fulldetail-${phone.id}`}
        >
          {loading && (
            <p className="dash-status" style={{ textAlign: "center" }}>
              Loading full specifications…
            </p>
          )}
          {error && !loading && (
            <div className="phone-detail-error">
              <p>{error}</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={loadDetail}
              >
                Retry
              </button>
            </div>
          )}
          {detail && !loading && !error && <PhoneDetailView phone={detail} />}
        </div>
      )}
    </div>
  );
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
    setCompareResult(null);
    try {
      const data = await postCompareMl({
        modelNameA: phone1.modelName,
        modelNameB: phone2.modelName,
      });
      setCompareResult(data);
    } catch (err) {
      setError(
        err.response?.data?.message ||
          err.message ||
          "Comparison failed. Please try again.",
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

  // The Compare button now calls the ML compare endpoint. The result
  // shape is: { Phone_A, Price_A, Phone_B, Price_B, Dimension_Comparison,
  //              Overall_Winner, SHAP_A, SHAP_B }.
  const dimComparison =
    compareResult && typeof compareResult === "object"
      ? compareResult.Dimension_Comparison
      : null;

  const hasSelection = !!(phone1 && phone2);
  const hasResult = !!compareResult;

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
          <p>
            Select two phones to compare them with our ML model across every
            dimension (gaming, camera, battery, display, and more).
          </p>
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
              disabled={!hasSelection || isLoading}
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

        {/* ML comparison results */}
        <section className="compare-ml-area" aria-label="ML comparison results">
          <div className="compare-section-label">
            <span className="compare-ml-badge">AI</span>
            <span>ML-powered comparison</span>
          </div>

          {!hasSelection && (
            <div className="compare-ml-empty">
              <p>
                Select two phones above, then click{" "}
                <strong>Compare Phones</strong> to see how our ML model scores
                them across every dimension.
              </p>
            </div>
          )}

          {hasSelection && !isLoading && !hasResult && !error && (
            <div className="compare-ml-empty">
              <p>
                Ready to run. Click <strong>Compare Phones</strong> to compute
                per-dimension ML scores and the overall winner.
              </p>
            </div>
          )}

          {isLoading && (
            <div className="compare-ml-loading">
              <span className="autocomplete-spinner">⟳</span>{" "}
              <span>Running ML comparison…</span>
            </div>
          )}

          {hasResult && !isLoading && (
            <div className="compare-ml-results">
              <div className="compare-ml-headline">
                <div className="compare-ml-headline-side">
                  <span className="compare-ml-side-name">
                    {compareResult.Phone_A}
                  </span>
                  <span className="compare-ml-side-price">
                    {formatMlPrice(compareResult.Price_A)}
                  </span>
                </div>
                <div className="compare-ml-headline-vs">VS</div>
                <div className="compare-ml-headline-side">
                  <span className="compare-ml-side-name">
                    {compareResult.Phone_B}
                  </span>
                  <span className="compare-ml-side-price">
                    {formatMlPrice(compareResult.Price_B)}
                  </span>
                </div>
              </div>

              <div className="compare-ml-winner">
                {compareResult.Overall_Winner &&
                compareResult.Overall_Winner !== "Tie" ? (
                  <>
                    <span className="winner-badge">🏆 ML Pick</span>
                    <strong>{compareResult.Overall_Winner}</strong>
                    <span>
                      {" "}
                      wins on more dimensions than{" "}
                      {compareResult.Overall_Winner === compareResult.Phone_A
                        ? compareResult.Phone_B
                        : compareResult.Phone_A}
                      .
                    </span>
                  </>
                ) : (
                  <>
                    <span className="winner-badge muted">🤝 Even</span>
                    <strong>Overall tie</strong>
                    <span>
                      {" "}
                      — both phones win the same number of dimensions.
                    </span>
                  </>
                )}
              </div>

              {dimComparison && Object.keys(dimComparison).length > 0 && (
                <div className="compare-categories-table compare-ml-dim-table">
                  <h3>Per-dimension ML scores</h3>
                  {Object.entries(dimComparison).map(([dim, vals]) => {
                    const winner =
                      vals.Winner === compareResult.Phone_A
                        ? "phone1"
                        : vals.Winner === compareResult.Phone_B
                          ? "phone2"
                          : "tie";
                    return (
                      <CompareCategoryRow
                        key={dim}
                        label={prettyDim(dim)}
                        value1={vals.A}
                        value2={vals.B}
                        winner={winner}
                        format={formatScore}
                      />
                    );
                  })}
                </div>
              )}

              {(compareResult.SHAP_A?.length > 0 ||
                compareResult.SHAP_B?.length > 0) && (
                <div className="compare-ml-shap">
                  <h4>Why these scores? (top ML features)</h4>
                  <div className="compare-ml-shap-grid">
                    <div>
                      <div className="compare-ml-shap-name">
                        {compareResult.Phone_A}
                      </div>
                      <ul>
                        {(compareResult.SHAP_A || []).map((s) => (
                          <li key={s.feature}>
                            <span className="compare-ml-shap-feat">
                              {s.feature}
                            </span>
                            <span className="compare-ml-shap-val">
                              +{Number(s.shap).toFixed(2)}
                            </span>
                          </li>
                        ))}
                        {(!compareResult.SHAP_A ||
                          compareResult.SHAP_A.length === 0) && (
                          <li className="ac-no-results">
                            No feature data available.
                          </li>
                        )}
                      </ul>
                    </div>
                    <div>
                      <div className="compare-ml-shap-name">
                        {compareResult.Phone_B}
                      </div>
                      <ul>
                        {(compareResult.SHAP_B || []).map((s) => (
                          <li key={s.feature}>
                            <span className="compare-ml-shap-feat">
                              {s.feature}
                            </span>
                            <span className="compare-ml-shap-val">
                              +{Number(s.shap).toFixed(2)}
                            </span>
                          </li>
                        ))}
                        {(!compareResult.SHAP_B ||
                          compareResult.SHAP_B.length === 0) && (
                          <li className="ac-no-results">
                            No feature data available.
                          </li>
                        )}
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Full-detail panels — opens inline, doesn't leave the page */}
        {hasSelection && (
          <section
            className="compare-fulldetail-area"
            aria-label="Full phone specifications"
          >
            <div className="compare-section-label">Full specifications</div>
            <p className="compare-fulldetail-help">
              Expand a phone to load its complete specification sheet (same data
              as the Phone Detail page).
            </p>
            <div className="compare-fulldetail-grid">
              <PhoneFullDetailPanel phone={phone1} index={0} />
              <PhoneFullDetailPanel phone={phone2} index={1} />
            </div>
          </section>
        )}

        {hasResult && (
          <button
            type="button"
            className="btn btn-outline compare-new-btn"
            onClick={handleReset}
          >
            Compare different phones
          </button>
        )}
      </main>
    </div>
  );
}

export default Compare;
