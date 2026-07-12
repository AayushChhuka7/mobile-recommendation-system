import { useState, useRef, useEffect, useCallback } from "react";
import api from "../services/api";
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
        <span className="cmp-input-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          type="text"
          className="cmp-autocomplete-input"
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
  }, [phone1, phone2]);

  const handleReset = () => {
    setPhone1(null);
    setPhone2(null);
    setCompareResult(null);
    setError("");
    setValidationError("");
  };

  // Build comparison categories from API result
  const categories = compareResult && compareResult.length === 2
    ? [
        {
          label: "Performance",
          value1: compareResult[0]?.antutuScore,
          value2: compareResult[1]?.antutuScore,
          higherIsBetter: true,
          format: (v) => (v ? v.toLocaleString() : "—"),
        },
        {
          label: "Camera",
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
          format: (v) => (v ? `${v} mAh` : "—"),
        },
        {
          label: "Display",
          value1: parseFloat(compareResult[0]?.specs?.display?.size || 0),
          value2: parseFloat(compareResult[1]?.specs?.display?.size || 0),
          higherIsBetter: true,
          format: (v) => (v ? `${v}"` : "—"),
        },
      ]
    : [];

  // Overall winner: count category wins
  const categoryWins = { phone1: 0, phone2: 0 };
  categories.forEach((cat) => {
    const w = getWinner(cat.value1, cat.value2, cat.higherIsBetter);
    if (w === "phone1") categoryWins.phone1++;
    else if (w === "phone2") categoryWins.phone2++;
  });
  const overallWinner =
    categoryWins.phone1 > categoryWins.phone2
      ? "phone1"
      : categoryWins.phone2 > categoryWins.phone1
        ? "phone2"
        : null;

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
            <div className="cmp-result-cards">
              {compareResult.map((phone, idx) => {
                const phoneKey = idx === 0 ? "phone1" : "phone2";
                const isOverallWinner = overallWinner === phoneKey;
                return (
                  <div
                    key={phone.id}
                    className={`cmp-result-card ${isOverallWinner ? "winner" : ""}`}
                  >
                    {isOverallWinner && (
                      <span className="cmp-overall-badge">🏆 Overall Winner</span>
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
                        €{phone.pricing?.cheapest?.price || "—"}
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
                  </div>
                );
              })}
            </div>

            <div className="cmp-categories">
              <h4 className="cmp-categories-title">Category Breakdown</h4>
              {categories.map((cat) => {
                const winner = getWinner(
                  cat.value1,
                  cat.value2,
                  cat.higherIsBetter,
                );
                return (
                  <CompareRow
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
