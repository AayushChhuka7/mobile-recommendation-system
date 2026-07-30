import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../services/api";
import {
  getAutoRecommendations,
  getRecommendations,
} from "../services/recommend";
import {
  getMyPreferences,
  getMyProfileBundle,
  saveMyPreferences,
} from "../services/profile";
import { useAuth } from "../hooks/useAuth.jsx";
import "./Login.css";
import "./Dashboard.css";
import {
  UserIcon,
  LockIcon,
  PhoneIcon,
  MailIcon,
  SearchIcon,
  CloseIcon,
  LogoutIcon,
  SlidersIcon,
  CameraIcon,
  BatteryIcon,
  CpuIcon,
  TagIcon,
  SparklesIcon,
  GamerIcon,
  ChevronIcon,
  ThemeIcon,
  PasswordField,
  PASSWORD_HINT,
  PASSWORD_RULES,
  PASSWORD_MIN_LENGTH,
} from "./AuthShared";
import ComparePanel from "./ComparePanel.jsx";
import { formatPriceNpr } from "../utils/formatPrice.js";

// function ThemeIcon() {
//   return (
//     <svg
//       width="14"
//       height="14"
//       viewBox="0 0 24 24"
//       fill="none"
//       stroke="currentColor"
//       strokeWidth="2"
//       strokeLinecap="round"
//       strokeLinejoin="round"
//     >
//       <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
//     </svg>
//   );
// }

const CATEGORY_OPTIONS = [
  { key: "gamer", label: "Gamer", Icon: GamerIcon },
  { key: "camera", label: "Camera lover", Icon: CameraIcon },
  { key: "battery", label: "Battery focused", Icon: BatteryIcon },
  { key: "allrounder", label: "All-rounder", Icon: SparklesIcon },
];

const DEFAULT_WEIGHTS = { gaming: 3, camera: 3, battery: 3, display: 3 };

const PERSONA_WEIGHT_PRESETS = {
  gamer: { gaming: 5, camera: 2, battery: 4, display: 4 },
  camera: { gaming: 2, camera: 5, battery: 3, display: 3 },
  battery: { gaming: 2, camera: 2, battery: 5, display: 2 },
  allrounder: { gaming: 3, camera: 3, battery: 3, display: 3 },
};

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

// Resolve a persisted persona string back to the FE's PERSONA_WEIGHT_PRESETS
// key. The backend may store either a category ("gamer", "camera", ...)
// or "Custom" (when the user moved the sliders). Anything we don't
// recognise is treated as "allrounder" (the safe default).
const personaToCategory = (persona) => {
  if (
    persona === "gamer" ||
    persona === "camera" ||
    persona === "battery" ||
    persona === "allrounder"
  ) {
    return persona;
  }
  return "allrounder";
};

// Filter/sort auto-save currently fires only on explicit user actions
// (Apply button, sort dropdown change) — no debounce needed. A debounce
// helper can be reintroduced here if a future continuous-input source
// (e.g. live price slider) gets wired to auto-save.

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

  const [panelPhase, setPanelPhase] = useState("closed");
  const closeAnimMs = 180;

  const closeTimerRef = useRef(null);

  const [isCompareOpen, setIsCompareOpen] = useState(false);

  const [changePwPhase, setChangePwPhase] = useState("closed");
  const changePwCloseTimerRef = useRef(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changePwErrors, setChangePwErrors] = useState({});
  const [changePwSubmitError, setChangePwSubmitError] = useState("");
  const [isChangePwSubmitting, setIsChangePwSubmitting] = useState(false);

  const DARK_MODE_KEY = "dashboardDarkMode";
  const [isDarkMode, setIsDarkMode] = useState(
    () => localStorage.getItem(DARK_MODE_KEY) === "true",
  );

  useEffect(() => {
    localStorage.setItem(DARK_MODE_KEY, String(isDarkMode));
  }, [isDarkMode]);

  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((d) => !d);
  }, []);
  const [selectedCategory, setSelectedCategory] = useState("gamer");
  const [weights, setWeights] = useState(() => ({
    ...PERSONA_WEIGHT_PRESETS.gamer,
  }));

  const [weightsTouched, setWeightsTouched] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(true);
  const [hoveredCard, setHoveredCard] = useState(null);
  const handleCategorySelect = useCallback((key) => {
    setSelectedCategory(key);
    const preset = PERSONA_WEIGHT_PRESETS[key] || DEFAULT_WEIGHTS;
    setWeights({ ...preset });
    setWeightsTouched(false);
  }, []);

  const [budgetMin, setBudgetMin] = useState("100");
  const [budgetMax, setBudgetMax] = useState("1000");

  const [recs, setRecs] = useState(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsError, setRecsError] = useState("");
  const [recsPersona, setRecsPersona] = useState(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [pendingFilters, setPendingFilters] = useState(EMPTY_FILTERS);
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [brands, setBrands] = useState([]);
  const [osOptions, setOsOptions] = useState([]);

  const [phones, setPhones] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const profileRef = useRef(null);
  const filterRef = useRef(null);
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
        console.error("Failed to load filter options:", err);
      }
    }
    loadFilterOptions();
    return () => {
      ignore = true;
    };
  }, []);

  // Hydrate saved preferences + filter preset on mount. The whole
  // payload is fetched with one round-trip so we don't bounce between
  // /me/preferences and /me/filter-preset. If anything fails, the local
  // state defaults (which already match `EMPTY_FILTERS` and
  // `PERSONA_WEIGHT_PRESETS.gamer`) take over.
  const hydratedRef = useRef(false);
  useEffect(() => {
    let ignore = false;
    async function hydrate() {
      try {
        const [bundle] = await Promise.all([getMyProfileBundle()]);
        if (ignore || !bundle || hydratedRef.current) return;

        // 1. Restore the recommend modal state — persona + weights +
        //    budget. If `recommendationPersona` is missing (fresh user)
        //    keep the default `gamer` selection already in state.
        const persona = bundle.customerProfile?.recommendationPersona || null;
        if (persona) {
          const cat = personaToCategory(persona);
          setSelectedCategory(cat);
          setWeights({ ...PERSONA_WEIGHT_PRESETS[cat] });
          setWeightsTouched(persona === "Custom");
        }

        const maxBudget =
          typeof bundle.preference?.maxBudget === "number"
            ? bundle.preference.maxBudget
            : null;
        if (maxBudget !== null) setBudgetMax(String(maxBudget));

        hydratedRef.current = true;
      } catch (err) {
        // Hydration is best-effort — silent fallback to defaults is
        // fine. Log only in dev.
        console.warn("Profile hydration skipped:", err?.message || err);
      }
    }
    hydrate();
    return () => {
      ignore = true;
    };
  }, []);

  // Profile fields (name, phoneNo) are hydrated by AuthProvider's
  // session-validation effect on app boot, so by the time the
  // dashboard mounts the auth context already has fresh data.
  // No on-mount fetch needed here.
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

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (changePwCloseTimerRef.current)
        clearTimeout(changePwCloseTimerRef.current);
    };
  }, []);
  useEffect(() => {
    let ignore = false;

    async function loadPhones() {
      setIsLoading(true);
      setError(null);
      try {
        const extra = { page };
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

  // Auto-recommend — fire once on Dashboard mount so the user sees
  // personalised picks without clicking anything. Reuses the existing
  // `recs / recsLoading / recsError` state so the spinner + error UI
  // + clear button all keep working unchanged.
  //
  // Skip conditions:
  //   - no logged-in user (defensive; the route is auth-guarded but we
  //     also don't want this to run during a /login redirect).
  //   - recs already populated (preserve the user's picks across route
  //     re-mounts within the same session; the explicit "Clear" button
  //     resets state and the next mount will re-fetch).
  //
  // The BE reuses the same fusion pipeline as the click path — see
  // `backend/src/services/recommendService.mjs::getAutoRecommendations`.
  useEffect(() => {
    // Accept either field name — login returns `id`, /users/me
    // returns `userId`. Either is enough to prove we're
    // authenticated; the BE identifies the caller by cookie anyway.
    const uid = user?.userId || user?.id;
    if (!user || !uid) return;
    if (recs !== null) return;

    let ignore = false;
    setRecsLoading(true);
    setRecsError("");

    (async () => {
      try {
        const { results, defaultedAt } = await getAutoRecommendations();
        if (ignore) return;
        setRecs(results);
        // Tag the persona in the recs header. If both defaulted, surface
        // an explicit "auto" persona label so the user understands the
        // system cold-started.
        setRecsPersona(
          defaultedAt.persona && defaultedAt.budget
            ? "auto (cold start)"
            : "auto",
        );
      } catch (err) {
        if (ignore) return;
        // Soft-fail. An auto-recommend failure should never block the
        // listing or steer the user away — the explicit "Recommend Me"
        // button is still wired up.
        console.warn("[auto-recommend] failed:", err?.message || err);
        setRecsError(
          err?.response?.data?.message ||
            "Couldn't auto-load recommendations. Use Recommend Me to retry.",
        );
      } finally {
        if (!ignore) setRecsLoading(false);
      }
    })();

    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.userId, user?.id]);

  const handleSignOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch (err) {
      console.error("Logout error:", err);
    }
    logout();
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  const openChangePassword = useCallback(() => {
    if (changePwCloseTimerRef.current) {
      clearTimeout(changePwCloseTimerRef.current);
      changePwCloseTimerRef.current = null;
    }
    setChangePwErrors({});
    setChangePwSubmitError("");
    setChangePwPhase("open");
    setProfileOpen(false);
  }, []);

  const resetChangePwForm = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setChangePwErrors({});
    setChangePwSubmitError("");
    setIsChangePwSubmitting(false);
  }, []);

  const closeChangePassword = useCallback(() => {
    setChangePwPhase("closing");
    if (changePwCloseTimerRef.current)
      clearTimeout(changePwCloseTimerRef.current);
    changePwCloseTimerRef.current = setTimeout(() => {
      setChangePwPhase("closed");
      changePwCloseTimerRef.current = null;
      resetChangePwForm();
    }, closeAnimMs);
  }, [resetChangePwForm]);
  const validateChangePw = useCallback(() => {
    const errs = {};
    if (!currentPassword) errs.currentPassword = "Current password is required";
    if (!newPassword) errs.newPassword = "Password is required";
    else if (newPassword.length < PASSWORD_MIN_LENGTH)
      errs.newPassword = `Minimum ${PASSWORD_MIN_LENGTH} characters`;
    else if (!PASSWORD_RULES.test(newPassword))
      errs.newPassword =
        "Must include uppercase, lowercase, number, and special character";
    if (confirmPassword !== newPassword)
      errs.confirmPassword = "Passwords do not match";
    return errs;
  }, [currentPassword, newPassword, confirmPassword]);

  // Map backend `details` array (express-validator) onto the FE's
  // per-field error map, falling back to a banner for unknown fields.
  const mapChangePwFieldErrors = useCallback((details) => {
    const fieldErrors = {};
    let bannerMessage = "";
    if (!Array.isArray(details)) return { fieldErrors, bannerMessage };

    for (const entry of details) {
      const serverKey = entry?.path || entry?.field;
      const msg = entry?.msg || entry?.message;
      if (!msg) continue;

      if (serverKey === "currentPassword") fieldErrors.currentPassword = msg;
      else if (serverKey === "password") fieldErrors.newPassword = msg;
      else if (serverKey === "confirmPassword")
        fieldErrors.confirmPassword = msg;
      else bannerMessage = bannerMessage ? `${bannerMessage}; ${msg}` : msg;
    }
    return { fieldErrors, bannerMessage };
  }, []);

  const handleChangePwSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      const errs = validateChangePw();
      setChangePwErrors(errs);
      if (Object.keys(errs).length) {
        setChangePwSubmitError("");
        return;
      }

      setIsChangePwSubmitting(true);
      setChangePwSubmitError("");
      try {
        await api.patch("/users/me/password", {
          currentPassword,
          password: newPassword,
          confirmPassword,
        });
        closeChangePassword();
      } catch (err) {
        const data = err?.response?.data;
        if (err?.response?.status === 401) {
          // AUTH_INVALID_CREDENTIALS — surface on the currentPassword field.
          setChangePwErrors((prev) => ({
            ...prev,
            currentPassword: data?.message || "Current password is incorrect",
          }));
        } else {
          const { fieldErrors, bannerMessage } = mapChangePwFieldErrors(
            data?.details,
          );
          if (Object.keys(fieldErrors).length) {
            setChangePwErrors((prev) => ({ ...prev, ...fieldErrors }));
          }
          setChangePwSubmitError(
            bannerMessage ||
              data?.message ||
              "Couldn't change password. Please try again.",
          );
        }
      } finally {
        setIsChangePwSubmitting(false);
      }
    },
    [
      validateChangePw,
      currentPassword,
      newPassword,
      confirmPassword,
      closeChangePassword,
      mapChangePwFieldErrors,
    ],
  );

  const handleWeightChange = useCallback((key, value) => {
    setWeights((prev) => ({ ...prev, [key]: Number(value) }));
    setWeightsTouched(true);
  }, []);
  const handleFindPhone = useCallback(async () => {
    const max = Number(budgetMax);
    if (!Number.isFinite(max) || max <= 0) {
      setRecsError("Please enter a maximum budget before finding your phone.");
      return;
    }
    const min = Number(budgetMin);
    const budget = {
      max,
      ...(Number.isFinite(min) && min >= 0 ? { min } : {}),
    };

    setRecsLoading(true);
    setRecsError("");
    setRecs(null);
    setRecsPersona(selectedCategory);
    closeRecommend();
    const persona = weightsTouched ? "Custom" : selectedCategory;
    const preferences = weightsTouched ? { ...weights } : undefined;

    try {
      const results = await getRecommendations({
        persona,
        budget,
        preferences,
        // Issue 1 — render the full ranked catalog (up to 200) instead
        // of the historical 6-picks slice. Same fusion pipeline; the BE
        // returns phones in descending `matchScore` order.
        topN: 200,
      });
      setRecs(results);

      // Auto-save the persona + weights + budget that produced this
      // recommendation. Fire-and-forget — a save failure must never
      // disturb the rec result the user just received.
      saveMyPreferences({
        persona,
        budgetMin: Number.isFinite(min) && min >= 0 ? min : "",
        budgetMax: max,
        weights: weightsTouched ? { ...weights } : undefined,
      }).catch((err) => {
        console.warn("Preferences save failed:", err?.message || err);
      });
    } catch (err) {
      setRecsError(
        err.response?.data?.message ||
          "Couldn't get recommendations right now. Please try again.",
      );
    } finally {
      setRecsLoading(false);
    }
  }, [
    budgetMin,
    budgetMax,
    selectedCategory,
    weights,
    weightsTouched,
    closeRecommend,
  ]);
  const handleClearRecommendations = useCallback(() => {
    setRecs(null);
    setRecsError("");
    setRecsPersona(null);
  }, []);
  const handleSearch = (e) => {
    e.preventDefault();
    const term = searchInput.trim();
    setSearchTerm(term);
    // Drop the auto/explicit recs once the user starts searching so the
    // "All Phones Ranked For You" block can't bury the search results.
    // The user can hit "Clear recommendations" to bring them back, or
    // simply clear the search box.
    if (term && (recs || recsLoading)) {
      setRecs(null);
      setRecsError("");
      setRecsLoading(false);
      setRecsPersona(null);
    }
    setShowFilters(false);
    setPage(1);
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setSearchTerm("");
    setPage(1);
  };
  const openFilters = () => {
    setPendingFilters(filters);
    setShowFilters((s) => !s);
  };

  const handlePendingChange = (key, value) => {
    setPendingFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleApplyFilters = () => {
    const willHaveActiveFilters = Object.values(pendingFilters).some(Boolean);
    setFilters(pendingFilters);
    setShowFilters(false);
    setPage(1);
    // Drop the auto/explicit recs once the user narrows the catalog so
    // the "All Phones Ranked For You" block can't bury the filtered
    // results. Mirrors the search-term behaviour above.
    if (willHaveActiveFilters && (recs || recsLoading)) {
      setRecs(null);
      setRecsError("");
      setRecsLoading(false);
      setRecsPersona(null);
    }
    // Auto-save disabled — applying filters should not persist them
    // across a page refresh.
  };

  const handleClearFilters = () => {
    setPendingFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };
  const handleSortChange = (nextSort) => {
    setSort(nextSort);
    setPage(1);
    // Auto-save disabled — sort selection should not persist across
    // a page refresh.
  };

  const displayName = user?.name || user?.username || "there";
  const email = user?.email || "";
  const phone = user?.phoneNo || user?.phone || "";
  const firstName = displayName.split(" ")[0];
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const paginationStart =
    totalPages <= 5 ? 1 : Math.max(1, Math.min(totalPages - 4, page - 2));
  const pageNumbers = Array.from(
    { length: Math.min(5, totalPages) },
    (_, i) => paginationStart + i,
  );

  return (
    <div className={`dashboard-page ${isDarkMode ? "dash-dark" : ""}`}>
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
            className={`btn btn-outline dash-compare-btn ${isCompareOpen ? "active" : ""}`}
            onClick={() => setIsCompareOpen((o) => !o)}
            aria-expanded={isCompareOpen}
            aria-controls="dash-compare-panel"
            title="Compare two phones side by side"
          >
            <span>Compare</span>
          </button>
          <button
            type="button"
            className="btn btn-primary dash-recommend-btn"
            onClick={openRecommend}
            aria-haspopup="dialog"
            aria-expanded={isSearchOpen}
            title="Get personalized phone recommendations"
          >
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
              onClick={() => {
                setProfileOpen((o) => !o);
              }}
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
                    <div className="profile-name">{displayName || "—"}</div>
                  </div>
                </div>
                <ul className="profile-fields" aria-label="Account details">
                  <li className="profile-field">
                    <span className="profile-field-icon" aria-hidden="true">
                      <UserIcon />
                    </span>
                    <span className="profile-field-label">Username</span>
                    <span className="profile-field-value">
                      {displayName || "—"}
                    </span>
                  </li>
                  <li className="profile-field">
                    <span className="profile-field-icon" aria-hidden="true">
                      <MailIcon />
                    </span>
                    <span className="profile-field-label">Email</span>
                    <span className="profile-field-value">{email || "—"}</span>
                  </li>
                  <li className="profile-field">
                    <span className="profile-field-icon" aria-hidden="true">
                      <PhoneIcon />
                    </span>
                    <span className="profile-field-label">Phone</span>
                    <span className="profile-field-value">{phone || "—"}</span>
                  </li>
                </ul>
                <div className="profile-divider" />
                <div className="profile-actions">
                  <button
                    type="button"
                    className="theme-toggle-row"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleDarkMode();
                    }}
                    aria-label="Toggle dark mode"
                  >
                    <span className="theme-toggle-row-label">
                      <ThemeIcon />
                      Dark mode
                    </span>
                    <span
                      className={`theme-switch ${isDarkMode ? "on" : ""}`}
                      role="switch"
                      aria-checked={isDarkMode}
                      aria-label="Dark mode"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleDarkMode();
                      }}
                    >
                      <span className="theme-switch-knob" />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="change-password-btn"
                    onClick={openChangePassword}
                  >
                    <LockIcon />
                    Change password
                  </button>
                  {user?.role === "Admin" && (
                    <>
                      <button
                        type="button"
                        className="change-password-btn admin-link-btn"
                        onClick={() => {
                          setProfileOpen(false);
                          navigate("/admin/customer-profiles");
                        }}
                      >
                        <SlidersIcon />
                        Customer profiles
                      </button>
                      <div className="profile-divider" />
                    </>
                  )}
                  <button
                    type="button"
                    className="signout-btn"
                    onClick={handleSignOut}
                  >
                    <LogoutIcon />
                    Sign out
                  </button>
                </div>
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
            {recs
              ? `Personalized picks for the ${recsPersona} persona`
              : searchTerm
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

        {/* ---- ML recommendations (from POST /api/recommend/recommend) ----
            Sits above the standard /phones grid. The standard grid still
            renders below, so the user always has a fallback view. */}
        {recsLoading && <p className="dash-status">Finding phones for you…</p>}

        {recsError && (
          <div className="dash-status dash-status-error">
            <p>{recsError}</p>
            <button
              type="button"
              className="btn btn-small"
              onClick={handleClearRecommendations}
              style={{ marginTop: 8 }}
            >
              Dismiss
            </button>
          </div>
        )}

        {recs && !recsLoading && !searchTerm && activeFilterCount === 0 && (
          <section
            className="dash-recs-section"
            aria-label="Recommended for you"
          >
            <div className="dash-recs-header">
              <h2>
                {recsPersona
                  ? `All phones ranked for you · ${recsPersona}`
                  : "All phones ranked for you"}
              </h2>
              <button
                type="button"
                className="btn btn-outline btn-small"
                onClick={handleClearRecommendations}
              >
                Clear recommendations
              </button>
            </div>
            {recs.length === 0 ? (
              <p className="dash-status">
                No matches for the chosen persona and budget. Try widening your
                budget or picking a different category.
              </p>
            ) : (
              <div className="phone-grid">
                {recs.map((r) => {
                  const isClickable = r.id && r.inDatabase !== false;
                  const handleRecClick = () => {
                    if (isClickable) navigate(`/phones/${r.id}`);
                  };
                  const handleRecKeyDown = (e) => {
                    if (!isClickable) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleRecClick();
                    }
                  };
                  return (
                    <div
                      key={r.id || `${r.brand?.name}-${r.modelName}`}
                      className="phone-card rec-card"
                      role={isClickable ? "button" : undefined}
                      tabIndex={isClickable ? 0 : -1}
                      aria-label={
                        isClickable
                          ? `View ${r.brand?.name || ""} ${r.modelName || "phone"} details`
                          : undefined
                      }
                      onClick={handleRecClick}
                      onKeyDown={handleRecKeyDown}
                      onMouseEnter={() => r.id && setHoveredCard(r.id)}
                      onMouseLeave={() => setHoveredCard(null)}
                      style={{ cursor: isClickable ? "pointer" : "default" }}
                    >
                      <div className="phone-card-top">
                        <div className="phone-card-image">
                          {r.imageUrl ? (
                            <img
                              src={r.imageUrl}
                              alt={r.modelName}
                              onError={(e) => {
                                e.target.style.display = "none";
                                e.target.parentElement.classList.add(
                                  "no-image",
                                );
                              }}
                            />
                          ) : (
                            <span className="phone-card-emoji">📱</span>
                          )}
                          {typeof r.matchScore === "number" && (
                            <span
                              className="rec-match-badge"
                              title="Match score from the recommender"
                            >
                              {Math.min(
                                100,
                                Math.round(r.matchScore * 10) / 10,
                              ).toFixed(1)}
                              % match
                            </span>
                          )}
                          {r.matchComponents?.search_history > 0.6 && (
                            <span
                              className="rec-boosted-badge"
                              title="Ranked higher because of your recent searches & views"
                            >
                              Boosted by your activity
                            </span>
                          )}
                        </div>
                        <div className="phone-card-name">{r.modelName}</div>
                        <div className="phone-card-tagline">
                          {r.brand?.name || "Unknown brand"}
                        </div>
                      </div>

                      <div className="phone-card-details">
                        {r.keySpecs?.os && (
                          <div className="phone-spec">
                            <CpuIcon />
                            <span>{r.keySpecs.os}</span>
                          </div>
                        )}
                        {r.keySpecs?.camera && (
                          <div className="phone-spec">
                            <CameraIcon />
                            <span>{r.keySpecs.camera}</span>
                          </div>
                        )}
                        {r.keySpecs?.battery && (
                          <div className="phone-spec">
                            <BatteryIcon />
                            <span>{r.keySpecs.battery} mAh</span>
                          </div>
                        )}
                        {r.cheapestVariant?.price && (
                          <div className="phone-spec phone-price">
                            <TagIcon />
                            <span>
                              {formatPriceNpr(r.cheapestVariant.price) ?? "—"}
                              {r.cheapestVariant.ram &&
                              r.cheapestVariant.storage
                                ? ` · ${r.cheapestVariant.ram}GB/${r.cheapestVariant.storage}GB`
                                : ""}
                            </span>
                          </div>
                        )}
                      </div>

                      {Array.isArray(r.why) && r.why.length > 0 && (
                        <ul
                          className="rec-why-list"
                          aria-label="Why this match"
                        >
                          {r.why.slice(0, 3).map((reason, idx) => (
                            <li key={idx}>{reason}</li>
                          ))}
                        </ul>
                      )}

                      {r.inDatabase === false && (
                        <div className="rec-not-in-db">Not in our catalog</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
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
                onClick={() => p.id && navigate(`/phones/${p.id}`)}
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
                        {formatPriceNpr(p.cheapestVariant.price) ?? "—"}
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
              {CATEGORY_OPTIONS.map((opt) => {
                const Icon = opt.Icon;
                return (
                  <button
                    type="button"
                    key={opt.key}
                    className={`usage-chip ${selectedCategory === opt.key ? "selected" : ""}`}
                    onClick={() => handleCategorySelect(opt.key)}
                  >
                    <Icon />
                    {opt.label}
                  </button>
                );
              })}
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
                {weightsTouched
                  ? "Custom weights active — these will be sent to the recommender."
                  : "Fine-tune how much each factor matters to you"}
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
                {weightsTouched && (
                  <button
                    type="button"
                    className="btn btn-outline btn-small weight-reset-btn"
                    onClick={() => handleCategorySelect(selectedCategory)}
                  >
                    Reset to{" "}
                    {CATEGORY_OPTIONS.find((o) => o.key === selectedCategory)
                      ?.label || "persona"}{" "}
                    defaults
                  </button>
                )}
              </div>
            </div>

            <div className="questionnaire-section" style={{ marginTop: 16 }}>
              <div className="questionnaire-hint" style={{ marginBottom: 8 }}>
                Budget (EUR) — required
              </div>
              <div className="filter-range">
                <input
                  type="number"
                  min="0"
                  placeholder="Min"
                  className="filter-input"
                  value={budgetMin}
                  onChange={(e) => setBudgetMin(e.target.value)}
                  aria-label="Minimum budget"
                />
                <span className="filter-range-sep">–</span>
                <input
                  type="number"
                  min="0"
                  placeholder="Max"
                  className="filter-input"
                  value={budgetMax}
                  onChange={(e) => setBudgetMax(e.target.value)}
                  aria-label="Maximum budget"
                />
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={handleFindPhone}
              disabled={recsLoading}
            >
              {recsLoading ? "Finding…" : "Find my phone →"}
            </button>
          </div>
        </div>
      )}

      {changePwPhase !== "closed" && (
        <div
          className={`search-overlay dash-change-pw-overlay ${changePwPhase === "closing" ? "closing" : ""}`}
          onClick={closeChangePassword}
        >
          <div
            className={`search-modal dash-change-pw-modal ${changePwPhase === "closing" ? "closing" : ""}`}
            role="dialog"
            aria-label="Change password"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="search-modal-header">
              <div>
                <div className="auth-title" style={{ marginBottom: 4 }}>
                  Change password
                </div>
                <div className="auth-subtitle" style={{ marginBottom: 0 }}>
                  Enter your current password and choose a new one.
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close change password"
                onClick={closeChangePassword}
              >
                <CloseIcon />
              </button>
            </div>

            <form
              className="dash-change-pw-body"
              onSubmit={handleChangePwSubmit}
              noValidate
            >
              <PasswordField
                label="Current password"
                name="current-password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  if (changePwErrors.currentPassword)
                    setChangePwErrors((prev) => ({
                      ...prev,
                      currentPassword: "",
                    }));
                }}
                error={changePwErrors.currentPassword}
              />

              <PasswordField
                label="New password"
                name="new-password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (changePwErrors.newPassword)
                    setChangePwErrors((prev) => ({ ...prev, newPassword: "" }));
                }}
                error={changePwErrors.newPassword}
                hint={PASSWORD_HINT}
              />

              <PasswordField
                label="Re-enter new password"
                name="confirm-new-password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (changePwErrors.confirmPassword)
                    setChangePwErrors((prev) => ({
                      ...prev,
                      confirmPassword: "",
                    }));
                }}
                error={changePwErrors.confirmPassword}
              />

              {changePwSubmitError && (
                <div className="form-submit-error" role="alert">
                  {changePwSubmitError}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isChangePwSubmitting}
              >
                {isChangePwSubmitting ? "Saving..." : "Submit"}
              </button>
            </form>
          </div>
        </div>
      )}

      <ComparePanel
        open={isCompareOpen}
        onClose={() => setIsCompareOpen(false)}
      />
    </div>
  );
}

export default Dashboard;
