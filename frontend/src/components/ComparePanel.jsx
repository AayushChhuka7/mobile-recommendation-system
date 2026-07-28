import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import { postCompareMl } from "../services/recommend";
import { CloseIcon, SearchIcon, CameraIcon, BatteryIcon, CpuIcon, TagIcon } from "./AuthShared";
import "./ComparePanel.css";

// ---- Debounce helper ----
function useDebounce(callback, delay) {
  const timerRef = useRef(null);
  return (...args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => callback(...args), delay);
  };
}

// ---- Autocomplete Input ----
function PhoneAutocomplete({ label, selectedPhone, onSelect, placeholder }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapperRef = useRef(null);

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

  const debouncedFetch = useDebounce(fetchSuggestions, 250);

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

  const handleClear = () => {
    onSelect(null);
    setQuery("");
    setSuggestions([]);
    setShowDropdown(false);
  };

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="cmp-input-group">
      <label className="cmp-input-label">{label}</label>
      <div className="cmp-autocomplete-wrapper" ref={wrapperRef}>
        {selectedPhone ? (
          <div className="cmp-selected-thumb" aria-hidden="true">
            {selectedPhone.imageUrl ? (
              <img
                src={selectedPhone.imageUrl}
                alt=""
                onError={(e) => {
                  e.target.style.display = "none";
                  e.target.parentElement.classList.add("no-image");
                }}
              />
            ) : (
              <span className="cmp-suggestion-emoji">📱</span>
            )}
          </div>
        ) : (
          <span className="cmp-input-icon" aria-hidden="true">
            <SearchIcon />
          </span>
        )}
        <input
          type="text"
          className={`cmp-autocomplete-input ${selectedPhone ? "has-thumb" : ""}`}
          placeholder={placeholder || "Search phone..."}
          value={selectedPhone ? selectedPhone.modelName : query}
          onChange={handleInputChange}
          onFocus={() => {
            if (suggestions.length > 0 || query.length >= 1) setShowDropdown(true);
          }}
        />
        {isLoading && <span className="cmp-spinner">⟳</span>}
        {selectedPhone && !isLoading && (
          <button
            type="button"
            className="cmp-clear-btn"
            onClick={handleClear}
            aria-label={`Clear ${label}`}
          >
            <CloseIcon />
          </button>
        )}
        {showDropdown && suggestions.length > 0 && (
          <ul className="cmp-dropdown" role="listbox">
            {suggestions.map((p) => (
              <li
                key={p.id}
                role="option"
                aria-selected="false"
                onMouseDown={() => handleSelect(p)}
              >
                <div className="cmp-suggestion-thumb" aria-hidden="true">
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt=""
                      onError={(e) => {
                        e.target.style.display = "none";
                        e.target.parentElement.classList.add("no-image");
                      }}
                    />
                  ) : (
                    <span className="cmp-suggestion-emoji">📱</span>
                  )}
                </div>
                <div className="cmp-suggestion-info">
                  <span className="cmp-suggestion-name">{p.modelName}</span>
                  <span className="cmp-suggestion-brand">
                    {p.brand?.name || "Unknown brand"}
                  </span>
                </div>
                {p.cheapestVariant?.price && (
                  <span className="cmp-suggestion-price">
                    €{p.cheapestVariant.price}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {showDropdown && !isLoading && suggestions.length === 0 && query.length >= 1 && (
          <ul className="cmp-dropdown" role="listbox">
            <li className="cmp-no-results">No phones found</li>
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- Category comparison row ----
function CompareRow({ label, value1, value2, winner, format }) {
  const fmt = format || ((v) => (v != null && v !== "" ? String(v) : "—"));
  return (
    <div className="cmp-cat-row">
      <span className="cmp-cat-label">{label}</span>
      <div className="cmp-cat-values">
        <span
          className={`cmp-cat-val ${winner === "phone1" ? "winner" : ""} ${
            winner === "phone2" ? "loser" : ""
          }`}
        >
          {fmt(value1)}
          {winner === "phone1" && (
            <span className="cmp-winner-badge">Winner</span>
          )}
        </span>
        <span className="cmp-cat-vs">vs</span>
        <span
          className={`cmp-cat-val ${winner === "phone2" ? "winner" : ""} ${
            winner === "phone1" ? "loser" : ""
          }`}
        >
          {fmt(value2)}
          {winner === "phone2" && (
            <span className="cmp-winner-badge">Winner</span>
          )}
        </span>
      </div>
    </div>
  );
}

// ---- Get winner helper ----
function getWinner(val1, val2, higherIsBetter = true) {
  if (val1 == null || val1 === "" || val1 === 0) {
    if (val2 == null || val2 === "" || val2 === 0) return null;
    return "phone2";
  }
  if (val2 == null || val2 === "" || val2 === 0) return "phone1";
  if (val1 === val2) return "tie";
  return higherIsBetter ? (val1 > val2 ? "phone1" : "phone2") : val1 < val2 ? "phone1" : "phone2";
}

// ---- Main Compare Panel Component ----
function ComparePanel({ open, onClose }) {
  const navigate = useNavigate();
  const [phone1, setPhone1] = useState(null);
  const [phone2, setPhone2] = useState(null);
  const [compareResult, setCompareResult] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationError, setValidationError] = useState("");

  // Reset state when panel is closed so reopening starts fresh
  useEffect(() => {
    if (!open) {
      // Slight delay so the close animation doesn't flash new content
      const t = setTimeout(() => {
        setPhone1(null);
        setPhone2(null);
        setCompareResult(null);
        setError("");
        setValidationError("");
      }, 250);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleCompare = useCallback(async () => {
    setValidationError("");
    if (!phone1 || !phone2) {
      setValidationError("Please select both phones before comparing.");
      return;
    }
    if (phone1.id === phone2.id) {
      setValidationError("Please choose two different phones.");
      return;
    }

    setIsLoading(true);
    setError("");
    setCompareResult(null);
    try {
      // Use the ML-powered compare endpoint. The selected phones stay in
      // state so the result cards can still render full specs (image,
      // brand, chipset, etc.) — the ML response only carries names + prices.
      const data = await postCompareMl({
        modelNameA: phone1.modelName,
        modelNameB: phone2.modelName,
      });
      if (!data) {
        throw new Error("Empty response from comparison service.");
      }
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
  }, [phone1, phone2]);

  const handleReset = () => {
    setPhone1(null);
    setPhone2(null);
    setCompareResult(null);
    setError("");
    setValidationError("");
  };

  // Derive per-dimension rows + overall winner from the ML response.
  // compareResult shape: { Phone_A, Price_A, Phone_B, Price_B,
  //   Dimension_Comparison: { Gaming: {A, B, Winner}, ... },
  //   Overall_Winner, SHAP_A, SHAP_B }
  const dimComparison =
    compareResult && typeof compareResult === "object"
      ? compareResult.Dimension_Comparison
      : null;

  const formatMlScore = (v) =>
    v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(1);

  const formatMlPrice = (price) =>
    price == null || Number.isNaN(Number(price))
      ? "—"
      : `€${Number(price).toLocaleString()}`;

  // Map the ML "Winner" string to a UI side key.
  const overallWinnerName = compareResult?.Overall_Winner || null;
  const overallWinnerKey =
    !compareResult
      ? null
      : overallWinnerName === compareResult.Phone_A
        ? "phone1"
        : overallWinnerName === compareResult.Phone_B
          ? "phone2"
          : null; // "Tie" or missing
  const isOverallTie = overallWinnerName === "Tie";

  return (
    <aside
      className={`cmp-panel ${open ? "open" : ""}`}
      aria-label="Compare phones"
      aria-hidden={!open}
    >
      <div className="cmp-panel-header">
        <div>
          <div className="cmp-panel-title">Compare Phones</div>
          <div className="cmp-panel-sub">
            Pick two phones to see a side-by-side breakdown
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close compare panel"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="cmp-panel-body">
        {!compareResult ? (
          <div className="cmp-form">
            <PhoneAutocomplete
              label="Phone 1"
              selectedPhone={phone1}
              onSelect={setPhone1}
              placeholder="Search first phone..."
            />
            <div className="cmp-vs-divider">
              <span>VS</span>
            </div>
            <PhoneAutocomplete
              label="Phone 2"
              selectedPhone={phone2}
              onSelect={setPhone2}
              placeholder="Search second phone..."
            />

            {validationError && (
              <div className="cmp-validation-error" role="alert">
                {validationError}
              </div>
            )}
            {error && (
              <div className="cmp-validation-error" role="alert">
                {error}
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={handleCompare}
              disabled={isLoading || !phone1 || !phone2}
            >
              {isLoading ? "Comparing..." : "Compare"}
            </button>
          </div>
        ) : (
          <div className="cmp-results">
            {/* Result cards: keep using the selected phone objects so we
                still have image, brand, chipset, etc. The ML response
                itself only carries names + prices. */}
            <div className="cmp-result-cards">
              {[phone1, phone2].map((phone, idx) => {
                if (!phone) return null;
                const phoneKey = idx === 0 ? "phone1" : "phone2";
                const isOverallWinner = overallWinnerKey === phoneKey;
                return (
                  <button
                    key={phone.id}
                    type="button"
                    className={`cmp-result-card ${isOverallWinner ? "winner" : ""}`}
                    onClick={() => phone?.id && navigate(`/phones/${phone.id}`)}
                    aria-label={`Open ${phone.modelName} specifications`}
                  >
                    {isOverallWinner && !isOverallTie && (
                      <span className="cmp-overall-badge">🏆 ML Pick</span>
                    )}
                    {isOverallTie && idx === 0 && (
                      <span className="cmp-overall-badge">🤝 Tie</span>
                    )}
                    <div className="cmp-result-image">
                      {phone.imageUrl ? (
                        <img src={phone.imageUrl} alt={phone.modelName} />
                      ) : (
                        <span className="cmp-result-emoji">📱</span>
                      )}
                    </div>
                    <div className="cmp-result-name">{phone.modelName}</div>
                    <div className="cmp-result-brand">
                      {phone.brand?.name || "Unknown brand"}
                    </div>
                    <div className="cmp-result-price">
                      <TagIcon />
                      <span>
                        {formatMlPrice(
                          idx === 0 ? compareResult?.Price_A : compareResult?.Price_B,
                        )}
                      </span>
                    </div>
                    <div className="cmp-result-specs">
                      {phone.specs?.platform?.chipset && (
                        <div className="cmp-spec-chip">
                          <CpuIcon />
                          <span>{phone.specs.platform.chipset}</span>
                        </div>
                      )}
                      {phone.specs?.camera?.main && (
                        <div className="cmp-spec-chip">
                          <CameraIcon />
                          <span>{phone.specs.camera.main}</span>
                        </div>
                      )}
                      {phone.specs?.battery?.capacity && (
                        <div className="cmp-spec-chip">
                          <BatteryIcon />
                          <span>{phone.specs.battery.capacity} mAh</span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Per-dimension ML scores */}
            <div className="cmp-categories">
              <h4 className="cmp-categories-title">ML Dimension Scores</h4>
              {dimComparison && Object.keys(dimComparison).length > 0 ? (
                Object.entries(dimComparison).map(([dim, vals]) => {
                  const winner =
                    vals?.Winner === compareResult?.Phone_A
                      ? "phone1"
                      : vals?.Winner === compareResult?.Phone_B
                        ? "phone2"
                        : "tie";
                  return (
                    <CompareRow
                      key={dim}
                      label={dim}
                      value1={vals?.A}
                      value2={vals?.B}
                      winner={winner}
                      format={formatMlScore}
                    />
                  );
                })
              ) : (
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>
                  No per-dimension scores returned.
                </p>
              )}
            </div>

            {/* SHAP explainers — top positive feature contributions for
                each phone. */}
            {(compareResult?.SHAP_A?.length > 0 ||
              compareResult?.SHAP_B?.length > 0) && (
              <div className="cmp-shap">
                <h4 className="cmp-categories-title">Why these scores?</h4>
                <div className="cmp-shap-grid">
                  <div>
                    <div className="cmp-shap-name">
                      {compareResult.Phone_A}
                    </div>
                    <ul className="cmp-shap-list">
                      {(compareResult.SHAP_A || []).map((s) => (
                        <li key={s.feature}>
                          <span className="cmp-shap-feat">{s.feature}</span>
                          <span className="cmp-shap-val">
                            +{Number(s.shap).toFixed(2)}
                          </span>
                        </li>
                      ))}
                      {(!compareResult.SHAP_A ||
                        compareResult.SHAP_A.length === 0) && (
                        <li className="cmp-no-results">
                          No feature data available.
                        </li>
                      )}
                    </ul>
                  </div>
                  <div>
                    <div className="cmp-shap-name">
                      {compareResult.Phone_B}
                    </div>
                    <ul className="cmp-shap-list">
                      {(compareResult.SHAP_B || []).map((s) => (
                        <li key={s.feature}>
                          <span className="cmp-shap-feat">{s.feature}</span>
                          <span className="cmp-shap-val">
                            +{Number(s.shap).toFixed(2)}
                          </span>
                        </li>
                      ))}
                      {(!compareResult.SHAP_B ||
                        compareResult.SHAP_B.length === 0) && (
                        <li className="cmp-no-results">
                          No feature data available.
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <button
              type="button"
              className="btn btn-outline w-full"
              onClick={handleReset}
            >
              Compare different phones
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

export default ComparePanel;
