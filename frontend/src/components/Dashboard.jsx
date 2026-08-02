import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
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
  EditIcon,
} from "./AuthShared";
import ComparePanel from "./ComparePanel.jsx";
import FavoritesPanel from "./FavoritesPanel.jsx";
import { eurFromNpr, formatPriceNpr } from "../utils/formatPrice.js";
import bannerImg from "../assets/banner.jpg";

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

const HeartIcon = ({ filled = false }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);

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

// Browse-page sizes: page 1 shows 8 phones, later pages show 16.
// `limit` is propagated from `extra` so the caller can pick the size
// per page; `buildPhonesQuery` itself stays limit-agnostic.
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
  const location = useLocation();
  const { user, logout, setUser } = useAuth();

  // The Compare interface is a side-docked overlay rendered below,
  // not a separate page — the URL `/dashboard/compare` toggles its
  // open state so back-nav from a clicked phone restores it (the
  // bug the user originally reported).
  const isCompareOpen = location.pathname === "/dashboard/compare";
  const closeCompare = useCallback(() => navigate("/dashboard"), [navigate]);

  // Same URL-driven pattern for the "Your favourites" panel: a side-docked
  // overlay that re-hydrates on back-nav from a phone detail click.
  const isFavoritesOpen = location.pathname === "/dashboard/favorites";
  const closeFavorites = useCallback(() => navigate("/dashboard"), [navigate]);

  const [isProfileOpen, setProfileOpen] = useState(false);

  // `/dashboard/compare` and `/dashboard/recommend` are now real child
  // routes — the modal/panel open state is driven by URL via
  // `useLocation()` below, so there's no `useState` for them anymore.

  const [changePwPhase, setChangePwPhase] = useState("closed");
  const changePwCloseTimerRef = useRef(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changePwErrors, setChangePwErrors] = useState({});
  const [changePwSubmitError, setChangePwSubmitError] = useState("");
  const [isChangePwSubmitting, setIsChangePwSubmitting] = useState(false);

  // Edit-profile modal state — mirrors `changePwPhase` so the same
  // open/closing animation + CSS classes can be reused.
  const [editProfilePhase, setEditProfilePhase] = useState("closed");
  const editProfileCloseTimerRef = useRef(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editProfileErrors, setEditProfileErrors] = useState({});
  const [editProfileSubmitError, setEditProfileSubmitError] = useState("");
  const [isEditProfileSubmitting, setIsEditProfileSubmitting] = useState(false);

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

  const [budgetMin, setBudgetMin] = useState("10000");
  const [budgetMax, setBudgetMax] = useState("200000");

  // Global behavior-based recommendations — back the "Top phones for you"
  // section on the dashboard. These are derived from the user's stored
  // profile + accumulated BehaviorScore rows (search / view / compare /
  // recommend events) and refreshed via GET /api/recommend/auto. They
  // are intentionally SEPARATE from the modal-local recommendations
  // below — see long-form comment above the recommend modal.
  const [globalRecs, setGlobalRecs] = useState(null);
  const [globalRecsLoading, setGlobalRecsLoading] = useState(false);
  const [globalRecsError, setGlobalRecsError] = useState("");
  const [globalRecsPersona, setGlobalRecsPersona] = useState(null);
  // Recs render at most 30, defaulting to 9. Toggled by "See more".
  const [globalRecsExpanded, setGlobalRecsExpanded] = useState(false);

  // Modal-local parameter-based recommendations — back the
  // "Recommend Me a Phone" modal. These are an ISOLATED tool whose
  // output depends ONLY on the persona + budget + slider weights the
  // user typed in the modal. They do NOT inherit any behavioural
  // state from "Top phones for you" and they do NOT overwrite it.
  // The modal's submission is logged on the backend as a `recommend`
  // event (see backend/src/services/profileService.mjs ::
  // safeRecordRecommendationEvent), which contributes ONE behavioural
  // signal to the next auto-recommend — it never replaces the global
  // list outright.
  const [modalRecs, setModalRecs] = useState(null);
  const [modalRecsLoading, setModalRecsLoading] = useState(false);
  const [modalRecsError, setModalRecsError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  // Live-typeahead suggestions for the search bar. Reuses the same
  // /phones/search endpoint that the ComparePanel autocomplete hits
  // so the two surfaces always agree on what "matches" a query.
  const [searchSuggestions, setSearchSuggestions] = useState([]);
  const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);
  const [searchSuggestionsLoading, setSearchSuggestionsLoading] =
    useState(false);
  const searchSuggestionsRef = useRef(null);
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
  // Favourites map keyed by phone id, value is the full phone object so
  // the "Your favourites" popup can render the browse-style card without
  // re-fetching. Hydrated from localStorage on mount (see effect below).
  const FAVORITES_STORAGE_KEY = "dashboard.favorites.v1";
  // Lazy initialiser — reads localStorage synchronously on mount so the
  // popup renders with the persisted list on the first paint instead of
  // an empty map that briefly flickers to the right state. Wrapped in
  // try/catch because private-mode browsers and quota-exceeded errors
  // both throw here.
  const [favorites, setFavorites] = useState(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      // Drop any entries that aren't shaped like a phone object — a
      // stale entry from before the storage format was full phones
      // (previously it was `{ [id]: true }`) shouldn't crash the UI.
      return Object.fromEntries(
        Object.entries(parsed).filter(
          ([, v]) => v && typeof v === "object" && v.id,
        ),
      );
    } catch (err) {
      console.warn("Favourites hydrate skipped:", err?.message || err);
      return {};
    }
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Persist favourites to localStorage on every change. Empty map
  // serialises to `{}` — fine, the lazy init above ignores it.
  useEffect(() => {
    try {
      localStorage.setItem(
        FAVORITES_STORAGE_KEY,
        JSON.stringify(favorites),
      );
    } catch (err) {
      console.warn("Favourites persist skipped:", err?.message || err);
    }
  }, [favorites]);

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

        // Budget hydration disabled — saved values are stale EUR from
        // before the switch to NPR. Defaults now drive the input.
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
  // Recommend modal close: just navigate back to the dashboard root.
  // (Opening is handled by the header button → navigate("/dashboard/recommend").)
  const closeRecommend = useCallback(() => {
    navigate("/dashboard");
  }, [navigate]);

  useEffect(() => {
    return () => {
      if (changePwCloseTimerRef.current)
        clearTimeout(changePwCloseTimerRef.current);
      if (editProfileCloseTimerRef.current)
        clearTimeout(editProfileCloseTimerRef.current);
    };
  }, []);
  useEffect(() => {
    let ignore = false;

    async function loadPhones() {
      setIsLoading(true);
      setError(null);
      try {
        const extra = {
          page,
          // Page 1 requests 8 phones; every subsequent page requests
          // 16. The BE derives skip from `(page - 1) * limit`, so the
          // effective skip shifts accordingly on later pages (rows
          // appear consistently forward but FE page 2 starts at row
          // 17, not row 9 — accepted trade-off to stay frontend-only).
          limit: page === 1 ? 8 : 16,
        };
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

  // Auto-recommend — fetch the user's behavior-based picks from
  // GET /api/recommend/auto. The BE reads the stored persona + budget
  // and runs the full buildFusedWeights → FastAPI → fusionRank pipeline
  // against the latest BehaviorScore rows (so prior searches, views,
  // compares, and recommend-me-a-phone calls all contribute as long
  // as the user has hit "Refresh" after the events).
  //
  // Skip conditions:
  //   - no logged-in user (defensive; the route is auth-guarded but we
  //     also don't want this to run during a /login redirect).
  //   - globalRecs already populated (preserve the user's picks across
  //     route re-mounts within the same session; the explicit "Clear"
  //     button resets state and the next mount will re-fetch).
  //
  // The fetch is extracted into a useCallback so the user can re-trigger
  // it via the "Refresh" button after they do something that should
  // contribute to the global picks (search, compare, view, or use the
  // modal). Ignored via the `ignoreRef` so a stale response can't
  // overwrite a fresher one.
  const autoRecIgnoreRef = useRef(0);
  const fetchGlobalRecs = useCallback(async () => {
    const uid = user?.userId || user?.id;
    if (!user || !uid) return;

    const ticket = ++autoRecIgnoreRef.current;
    setGlobalRecsLoading(true);
    setGlobalRecsError("");

    try {
      const { results, defaultedAt } = await getAutoRecommendations();
      if (ticket !== autoRecIgnoreRef.current) return;
      setGlobalRecs(results);
      // Tag the persona in the recs header. If both defaulted, surface
      // an explicit "auto" persona label so the user understands the
      // system cold-started.
      setGlobalRecsPersona(
        defaultedAt.persona && defaultedAt.budget
          ? "auto (cold start)"
          : "auto",
      );
    } catch (err) {
      if (ticket !== autoRecIgnoreRef.current) return;
      // Soft-fail. An auto-recommend failure should never block the
      // listing or steer the user away — the explicit "Recommend Me"
      // button is still wired up.
      console.warn("[auto-recommend] failed:", err?.message || err);
      setGlobalRecsError(
        err?.response?.data?.message ||
          "Couldn't auto-load recommendations. Use Recommend Me to retry.",
      );
    } finally {
      if (ticket === autoRecIgnoreRef.current) {
        setGlobalRecsLoading(false);
      }
    }
  }, [user?.userId, user?.id]);

  // Fire once on Dashboard mount so the user sees personalised picks
  // without clicking anything. Subsequent re-fetches happen only when
  // the user explicitly hits "Refresh" — auto-recommend is not
  // re-triggered on every search / compare / view, so the user keeps
  // a stable view of "Top phones for you" until they opt in to refresh.
  useEffect(() => {
    const uid = user?.userId || user?.id;
    if (!user || !uid) return;
    if (globalRecs !== null) return;
    fetchGlobalRecs();
  }, [user?.userId, user?.id, globalRecs, fetchGlobalRecs]);

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

  // ---- Edit profile (username / phone) handlers ----
  // Mirrors the change-password flow: phase machine drives the modal
  // open/close animation, validation runs on submit, and the BE
  // response is mirrored into AuthContext via setUser() so the
  // dropdown value updates immediately without a refresh.
  const openEditProfile = useCallback(() => {
    if (editProfileCloseTimerRef.current) {
      clearTimeout(editProfileCloseTimerRef.current);
      editProfileCloseTimerRef.current = null;
    }
    setEditName(user?.name || "");
    setEditPhone(user?.phoneNo || user?.phone || "");
    setEditProfileErrors({});
    setEditProfileSubmitError("");
    setEditProfilePhase("open");
    setProfileOpen(false);
  }, [user]);

  const resetEditProfileForm = useCallback(() => {
    setEditName("");
    setEditPhone("");
    setEditProfileErrors({});
    setEditProfileSubmitError("");
    setIsEditProfileSubmitting(false);
  }, []);

  const closeEditProfile = useCallback(() => {
    setEditProfilePhase("closing");
    if (editProfileCloseTimerRef.current)
      clearTimeout(editProfileCloseTimerRef.current);
    editProfileCloseTimerRef.current = setTimeout(() => {
      setEditProfilePhase("closed");
      editProfileCloseTimerRef.current = null;
      resetEditProfileForm();
    }, closeAnimMs);
  }, [resetEditProfileForm]);

  const validateEditProfile = useCallback(() => {
    const errs = {};
    if (!editName || !editName.trim()) errs.name = "Username is required";
    else if (editName.trim().length > 80)
      errs.name = "Username is too long (max 80 characters)";
    if (editPhone && editPhone.trim() && editPhone.trim().length < 6)
      errs.phoneNo = "Phone number looks too short";
    return errs;
  }, [editName, editPhone]);

  const handleEditProfileSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      const errs = validateEditProfile();
      setEditProfileErrors(errs);
      if (Object.keys(errs).length) {
        setEditProfileSubmitError("");
        return;
      }
      setIsEditProfileSubmitting(true);
      setEditProfileSubmitError("");
      try {
        // PATCH /users/me — sibling of the password patch endpoint.
        // The BE persists `name` / `phoneNo` to the user row.
        const res = await api.patch("/users/me", {
          name: editName.trim(),
          phoneNo: editPhone.trim(),
        });
        // Mirror the saved values back into AuthContext so the
        // dropdown re-renders with the new display name + phone
        // without a full page reload.
        const saved =
          res?.data?.data && typeof res.data.data === "object"
            ? res.data.data
            : { name: editName.trim(), phoneNo: editPhone.trim() };
        setUser({
          name: saved.name ?? editName.trim(),
          phoneNo: saved.phoneNo ?? editPhone.trim(),
        });
        closeEditProfile();
      } catch (err) {
        const data = err?.response?.data;
        setEditProfileSubmitError(
          data?.message || "Couldn't update profile. Please try again.",
        );
      } finally {
        setIsEditProfileSubmitting(false);
      }
    },
    [validateEditProfile, editName, editPhone, closeEditProfile, setUser],
  );

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
      setModalRecsError("Please enter a maximum budget before finding your phone.");
      return;
    }
    const min = Number(budgetMin);
    // BE stores budget in EUR — convert the NPR values the user
    // typed before sending them across the wire.
    const maxEur = eurFromNpr(max);
    const minEur = eurFromNpr(min);
    const budget = {
      max: maxEur,
      ...(minEur !== null ? { min: minEur } : {}),
    };

    // The modal is an ISOLATED, parameter-only tool. Its results
    // depend strictly on the persona + budget + slider weights the user
    // typed here — no behavioural history, no auto-recs carry-over.
    // We deliberately do NOT call closeRecommend() so the modal stays
    // open and the user can see the results inline; and we do NOT
    // touch globalRecs at all so "Top phones for you" is unaffected.
    //
    // The submission is logged on the backend as a `recommend` event
    // (see backend/src/services/profileService.mjs ::
    // safeRecordRecommendationEvent). That bumps the per-tag
    // BehaviorScore rows by a small amount, so the next auto-recommend
    // fold them in as one behavioural signal — but never as a wholesale
    // replacement for the global picks.
    setModalRecsLoading(true);
    setModalRecsError("");
    setModalRecs(null);

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
      setModalRecs(results);

      // Auto-save the persona + weights + budget that produced this
      // recommendation. Fire-and-forget — a save failure must never
      // disturb the rec result the user just received. This persists
      // explicit preferences for next time; the per-event behaviour
      // score (which feeds the next auto-recommend) is written by the
      // BE controller, not here.
      saveMyPreferences({
        persona,
        budgetMin: minEur !== null ? minEur : "",
        budgetMax: maxEur,
        weights: weightsTouched ? { ...weights } : undefined,
      }).catch((err) => {
        console.warn("Preferences save failed:", err?.message || err);
      });
    } catch (err) {
      setModalRecsError(
        err?.response?.data?.message ||
          "Couldn't get recommendations right now. Please try again.",
      );
    } finally {
      setModalRecsLoading(false);
    }
  }, [
    budgetMin,
    budgetMax,
    selectedCategory,
    weights,
    weightsTouched,
  ]);

  // Clear / refresh the global behavior-based recommendations only.
  // The modal's results are independent — they are not touched here.
  const handleClearGlobalRecs = useCallback(() => {
    setGlobalRecs(null);
    setGlobalRecsError("");
    setGlobalRecsPersona(null);
    setGlobalRecsExpanded(false);
  }, []);

  // Re-fetch the global behavior-based recommendations. The user
  // presses this after they have searched, viewed, compared, or used
  // the "Recommend Me a Phone" modal and want their behavioural
  // signals folded into the global picks. The fetch path is the same
  // one used on mount (see fetchGlobalRecs).
  const handleRefreshGlobalRecs = useCallback(() => {
    fetchGlobalRecs();
  }, [fetchGlobalRecs]);
  const handleSearch = (e) => {
    e.preventDefault();
    const term = searchInput.trim();
    setSearchTerm(term);
    setShowSearchSuggestions(false);
    // Drop the global behavior-based recs once the user starts
    // searching so the "All Phones Ranked For You" block can't bury
    // the search results. We touch ONLY the global slice — the modal
    // results are independent and stay put (the modal isn't visible
    // during search anyway). The user can hit "Refresh" later to
    // re-fetch the global picks.
    if (term && (globalRecs || globalRecsLoading)) {
      setGlobalRecs(null);
      setGlobalRecsError("");
      setGlobalRecsLoading(false);
      setGlobalRecsPersona(null);
    }
    setShowFilters(false);
    setPage(1);
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setSearchTerm("");
    setSearchSuggestions([]);
    setShowSearchSuggestions(false);
    setPage(1);
  };

  // Debounced search-suggestion fetch. Fires on every keystroke into
  // the dashboard search bar; renders an inline dropdown under the
  // input. Hits the same /phones/search endpoint the ComparePanel
  // autocomplete uses so the matching semantics stay consistent.
  const searchSuggestTimerRef = useRef(null);
  const fetchSearchSuggestions = (value) => {
    const q = (value || "").trim();
    if (!q) {
      setSearchSuggestions([]);
      setShowSearchSuggestions(false);
      return;
    }
    setSearchSuggestionsLoading(true);
    api
      .get("/phones/search", { params: { q, limit: 8 } })
      .then((res) => {
        setSearchSuggestions(res?.data?.data || []);
        setShowSearchSuggestions(true);
      })
      .catch((err) => {
        console.warn("[search-suggest] failed:", err?.message || err);
        setSearchSuggestions([]);
      })
      .finally(() => setSearchSuggestionsLoading(false));
  };
  const handleSearchInputChange = (e) => {
    const value = e.target.value;
    setSearchInput(value);
    if (searchSuggestTimerRef.current)
      clearTimeout(searchSuggestTimerRef.current);
    searchSuggestTimerRef.current = setTimeout(
      () => fetchSearchSuggestions(value),
      300,
    );
  };
  const handleSearchSuggestionClick = (phone) => {
    setShowSearchSuggestions(false);
    setSearchSuggestions([]);
    setSearchInput("");
    if (phone?.id) navigate(`/phones/${phone.id}`);
  };
  // Close the suggestion dropdown on outside click — same pattern the
  // profile menu + filter popover use, just scoped to this ref.
  useEffect(() => {
    function handleOutside(e) {
      if (
        searchSuggestionsRef.current &&
        !searchSuggestionsRef.current.contains(e.target)
      ) {
        setShowSearchSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);
  const openFilters = () => {
    setPendingFilters(filters);
    setShowFilters((s) => !s);
  };

  const handlePendingChange = (key, value) => {
    setPendingFilters((prev) => ({ ...prev, [key]: value }));
  };

  const handleApplyFilters = () => {
    const willHaveActiveFilters = Object.values(pendingFilters).some(Boolean);
    // The user typed NPR prices — convert them back to EUR (the
    // storage currency of the BE) the same way the recommend flow does,
    // so `buildPhonesQuery` keeps sending EUR over the wire.
    const filtersToApply = {
      ...pendingFilters,
      minPrice:
        pendingFilters.minPrice === ""
          ? ""
          : eurFromNpr(pendingFilters.minPrice) ?? "",
      maxPrice:
        pendingFilters.maxPrice === ""
          ? ""
          : eurFromNpr(pendingFilters.maxPrice) ?? "",
    };
    setFilters(filtersToApply);
    setShowFilters(false);
    setPage(1);
    // Drop the global behavior-based recs once the user narrows the
    // catalog so the "All Phones Ranked For You" block can't bury the
    // filtered results. Mirrors the search-term behaviour above and
    // touches ONLY the global slice — the modal's results are
    // independent and stay put.
    if (willHaveActiveFilters && (globalRecs || globalRecsLoading)) {
      setGlobalRecs(null);
      setGlobalRecsError("");
      setGlobalRecsLoading(false);
      setGlobalRecsPersona(null);
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
        <div className="dash-header-actions">
          <button
            type="button"
            className="btn btn-outline dash-favorites-btn"
            onClick={() => navigate("/dashboard/favorites")}
            aria-haspopup="dialog"
            title="View your favourited phones"
          >
            <span>Your favourites</span>
            {Object.keys(favorites).length > 0 && (
              <span className="dash-favorites-badge">
                {Object.keys(favorites).length}
              </span>
            )}
          </button>
          <button
            type="button"
            className="btn btn-outline dash-compare-btn"
            onClick={() => navigate("/dashboard/compare")}
            title="Compare two phones side by side"
          >
            <span>Compare</span>
          </button>
          <button
            type="button"
            className="btn btn-primary dash-recommend-btn"
            onClick={() => navigate("/dashboard/recommend")}
            aria-haspopup="dialog"
            title="Get personalized phone recommendations"
          >
            <span>Recommend Me a Phone</span>
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
                    <button
                      type="button"
                      className="profile-field-edit"
                      onClick={openEditProfile}
                      aria-label="Edit username and phone"
                      title="Edit username & phone"
                    >
                      <EditIcon />
                    </button>
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
                    <button
                      type="button"
                      className="profile-field-edit"
                      onClick={openEditProfile}
                      aria-label="Edit username and phone"
                      title="Edit username & phone"
                    >
                      <EditIcon />
                    </button>
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
            <div
              className="dash-search-input-wrapper"
              ref={searchSuggestionsRef}
            >
              <span className="dash-search-input-icon" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                type="text"
                className="dash-search-input"
                placeholder="Search phones by name or model..."
                value={searchInput}
                onChange={handleSearchInputChange}
                onFocus={() => {
                  if (searchSuggestions.length > 0)
                    setShowSearchSuggestions(true);
                }}
                aria-label="Search phones by name or model"
                aria-autocomplete="list"
                aria-expanded={showSearchSuggestions}
                aria-controls="dash-search-suggestions"
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
              {showSearchSuggestions && (
                <ul
                  id="dash-search-suggestions"
                  className="dash-search-suggestions"
                  role="listbox"
                >
                  {searchSuggestionsLoading &&
                    searchSuggestions.length === 0 && (
                      <li className="dash-search-suggestion-empty">
                        Searching…
                      </li>
                    )}
                  {!searchSuggestionsLoading &&
                    searchSuggestions.length === 0 && (
                      <li className="dash-search-suggestion-empty">
                        No phones found
                      </li>
                    )}
                  {searchSuggestions.map((p) => (
                    <li
                      key={p.id}
                      role="option"
                      aria-selected="false"
                      className="dash-search-suggestion"
                      onMouseDown={(e) => {
                        // mousedown (not click) so the input's blur
                        // doesn't close the dropdown before the
                        // navigation handler fires.
                        e.preventDefault();
                        handleSearchSuggestionClick(p);
                      }}
                    >
                      <span
                        className="dash-search-suggestion-thumb"
                        aria-hidden="true"
                      >
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
                          <span className="phone-card-emoji">📱</span>
                        )}
                      </span>
                      <span className="dash-search-suggestion-info">
                        <span className="dash-search-suggestion-name">
                          {p.modelName}
                        </span>
                        <span className="dash-search-suggestion-brand">
                          {p.brand?.name || "Unknown brand"}
                        </span>
                      </span>
                      {p.cheapestVariant?.price && (
                        <span className="dash-search-suggestion-price">
                          {formatPriceNpr(p.cheapestVariant.price) ?? "—"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
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
                      <label className="filter-label">Price (NPR)</label>
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
        </div>

        <div className="dash-banner">
          <img src={bannerImg} alt="Shop the latest smartphones" />
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

        {/* ---- Global behavior-based recommendations ----
            Backed by GET /api/recommend/auto. The render target is the
            "Top phones for you" section. The standard /phones grid still
            renders below, so the user always has a fallback view, and
            the modal's parameter-only results are independent (see the
            param-only results are independent — see the inline phone
            card list inside the modal). */}
        {globalRecsLoading && (
          <p className="dash-status">Finding phones for you…</p>
        )}

        {globalRecsError && (
          <div className="dash-status dash-status-error">
            <p>{globalRecsError}</p>
            <button
              type="button"
              className="btn btn-small"
              onClick={handleClearGlobalRecs}
              style={{ marginTop: 8 }}
            >
              Dismiss
            </button>
          </div>
        )}

        {globalRecs && !globalRecsLoading && page === 1 && !searchTerm && (
          <section
            className="dash-recs-section"
            aria-label="Top phones for you"
          >
            <div className="dash-recs-header">
              <div className="dash-recs-title">
                <h2>Top phones for you</h2>
                {globalRecsPersona && (
                  <span className="dash-recs-eyebrow">
                    Tuned for your {globalRecsPersona.toLowerCase()} persona
                  </span>
                )}
              </div>
              <div className="dash-recs-header-actions">
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  onClick={handleRefreshGlobalRecs}
                  disabled={globalRecsLoading}
                  title="Re-fetch picks from your latest search, view, compare, and recommend activity"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  onClick={handleClearGlobalRecs}
                >
                  Clear recommendations
                </button>
              </div>
            </div>
            {globalRecs.length === 0 ? (
              <p className="dash-status">
                No matches for the chosen persona and budget. Try widening your
                budget or picking a different category.
              </p>
            ) : (
              <>
                <div className="phone-grid">
                  {globalRecs.slice(0, globalRecsExpanded ? 32 : 8).map((r) => {
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
                            {r.id && (
                              <button
                                type="button"
                                className="phone-card-favorite"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFavorites((fav) => {
                                    if (fav[r.id]) {
                                      const next = { ...fav };
                                      delete next[r.id];
                                      return next;
                                    }
                                    return { ...fav, [r.id]: r };
                                  });
                                }}
                                aria-label={
                                  favorites[r.id]
                                    ? "Remove from favorites"
                                    : "Add to favorites"
                                }
                                aria-pressed={!!favorites[r.id]}
                                title={
                                  favorites[r.id]
                                    ? "Favorited"
                                    : "Add to favorites"
                                }
                              >
                                <HeartIcon filled={!!favorites[r.id]} />
                              </button>
                            )}
                          </div>
                          <div className="phone-card-name">{r.modelName}</div>
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
                            <div className="phone-spec rec-price">
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
                          <div className="rec-not-in-db">
                            Not in our catalog
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {globalRecs.length > 10 && (
                  <div className="dash-recs-see-more">
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setGlobalRecsExpanded((v) => !v)}
                      aria-expanded={globalRecsExpanded}
                    >
                      {globalRecsExpanded ? "Show fewer" : "See more"}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {!isLoading && !error && phones.length === 0 && (
          <p className="dash-status">
            {searchTerm
              ? `No phones found for "${searchTerm}".`
              : "No phones found. Try adjusting your search or filters."}
          </p>
        )}

        {!isLoading && !error && phones.length > 0 && (
          <section
            className="dash-browse-section"
            aria-label={searchTerm ? `Search results for ${searchTerm}` : "Browse other phones"}
          >
            <div className="dash-browse-header">
              <h2>
                {searchTerm
                  ? `Search results for "${searchTerm}"`
                  : "Browse other phones"}
              </h2>
              {searchTerm && (
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  onClick={handleClearSearch}
                  style={{ marginLeft: 12 }}
                >
                  Clear search
                </button>
              )}
            </div>
            <div className="phone-grid">
              {(page === 1 ? phones.slice(0, 8) : phones).map((p) => (
                <div
                  key={p.id}
                  className={`phone-card ${hoveredCard === p.id ? "expanded" : ""}`}
                  onMouseEnter={() => setHoveredCard(p.id)}
                  onMouseLeave={() => setHoveredCard(null)}
                  onClick={() => p.id && navigate(`/phones/${p.id}`)}
                  style={{ cursor: "pointer" }}
                >
                  <div className="phone-card-hero">
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
                    <button
                      type="button"
                      className="phone-card-favorite"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFavorites((fav) => {
                          if (fav[p.id]) {
                            const next = { ...fav };
                            delete next[p.id];
                            return next;
                          }
                          return { ...fav, [p.id]: p };
                        });
                      }}
                      aria-label={
                        favorites[p.id] ? "Remove from favorites" : "Add to favorites"
                      }
                      aria-pressed={!!favorites[p.id]}
                      title={favorites[p.id] ? "Favorited" : "Add to favorites"}
                    >
                      <HeartIcon filled={!!favorites[p.id]} />
                    </button>
                  </div>

                  <div className="phone-card-body">
                    <div className="phone-card-tags" aria-hidden="true" />
                    <div className="phone-card-name">{p.modelName}</div>

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
                    </div>

                    <div className="phone-card-footer">
                      {p.cheapestVariant?.price && (
                        <div className="phone-price">
                          <span className="phone-price-label">Price</span>
                          <span className="phone-price-value">
                            {formatPriceNpr(p.cheapestVariant.price) ?? "—"}
                            {p.cheapestVariant.ram && p.cheapestVariant.storage
                              ? ` · ${p.cheapestVariant.ram}/${p.cheapestVariant.storage}GB`
                              : ""}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
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
            </div>
        )}
      </main>

      {location.pathname === "/dashboard/recommend" && (
        <div
          className="search-overlay dash-recommend-overlay"
          onClick={closeRecommend}
        >
          <div
            className={`search-modal dash-recommend-modal ${
              modalRecs && !modalRecsLoading ? "dash-recommend-modal-results" : ""
            }`}
            role="dialog"
            aria-label="Phone recommendation"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="search-modal-header">
              <div>
                <div className="auth-title" style={{ marginBottom: 4 }}>
                  {modalRecs && !modalRecsLoading
                    ? "Your matches"
                    : "Find your phone"}
                </div>
                <div className="auth-subtitle" style={{ marginBottom: 0 }}>
                  {modalRecs && !modalRecsLoading
                    ? `${Math.min(modalRecs.length, 20)} parameter-based picks — close to refine again.`
                    : "Tell us what matters most and we'll find your match."}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {modalRecs && !modalRecsLoading && (
                  <button
                    type="button"
                    className="btn btn-outline btn-small"
                    onClick={() => setModalRecs(null)}
                  >
                    Refine
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Close recommendation panel"
                  onClick={closeRecommend}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>

            {/* Scrollable body. When results are present we hide the
                form so the popup is dominated by phone cards; when no
                results yet, the form fills the popup. */}
            <div className="dash-modal-body">
              {(!modalRecs || modalRecsLoading) && (
                <>
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
                            <span>
                              {key.charAt(0).toUpperCase() + key.slice(1)}
                            </span>
                            <span className="weight-value">{value}/5</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="5"
                            value={value}
                            onChange={(e) =>
                              handleWeightChange(key, e.target.value)
                            }
                            className="weight-slider"
                          />
                        </div>
                      ))}
                      {weightsTouched && (
                        <button
                          type="button"
                          className="btn btn-outline btn-small weight-reset-btn"
                          onClick={() =>
                            handleCategorySelect(selectedCategory)
                          }
                        >
                          Reset to{" "}
                          {CATEGORY_OPTIONS.find(
                            (o) => o.key === selectedCategory,
                          )?.label || "persona"}{" "}
                          defaults
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="questionnaire-section" style={{ marginTop: 16 }}>
                    <div
                      className="questionnaire-hint"
                      style={{ marginBottom: 8 }}
                    >
                      Budget (NPR) — required
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
                    disabled={modalRecsLoading}
                  >
                    {modalRecsLoading ? "Finding…" : "Find my phone →"}
                  </button>
                </>
              )}

            {/* ---- Modal-local results (POST /api/recommend/recommend) ----
                Rendered inline inside the modal so the user can see their
                parameter-based picks without the modal closing. The slice
                is COMPLETELY independent of `globalRecs` above — these
                results are derived strictly from the persona + budget +
                slider weights the user typed, never from behavior. The
                submission is logged on the BE as a `recommend` event so
                it contributes one signal toward the next auto-recommend
                (see backend/src/services/profileService.mjs ::
                safeRecordRecommendationEvent). It never replaces the
                global picks outright. */}
            {modalRecsLoading && (
              <p
                className="dash-status"
                style={{ marginTop: 16, textAlign: "center" }}
              >
                Finding your matches…
              </p>
            )}

            {modalRecsError && (
              <div
                className="dash-status dash-status-error"
                style={{ marginTop: 16 }}
                role="alert"
              >
                <p>{modalRecsError}</p>
              </div>
            )}

            {modalRecs && !modalRecsLoading && (
              <div
                className="dash-modal-recs"
                aria-label="Your parameter-based picks"
              >
                <div className="dash-modal-recs-header">
                  <h3>Your matches</h3>
                  <span className="dash-modal-recs-hint">
                    Based only on the parameters above — not on your activity
                    history.
                  </span>
                </div>
                {modalRecs.length === 0 ? (
                  <p className="dash-status">
                    No matches for the chosen persona and budget. Try widening
                    your budget or picking a different category.
                  </p>
                ) : (
                  <div className="phone-grid dash-modal-recs-grid">
                    {modalRecs.slice(0, 20).map((r) => {
                      const isClickable = r.id && r.inDatabase !== false;
                      const handleModalRecClick = () => {
                        if (isClickable) navigate(`/phones/${r.id}`);
                      };
                      const handleModalRecKeyDown = (e) => {
                        if (!isClickable) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleModalRecClick();
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
                          onClick={handleModalRecClick}
                          onKeyDown={handleModalRecKeyDown}
                          onMouseEnter={() => r.id && setHoveredCard(r.id)}
                          onMouseLeave={() => setHoveredCard(null)}
                          style={{
                            cursor: isClickable ? "pointer" : "default",
                          }}
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
                            </div>
                            <div className="phone-card-name">{r.modelName}</div>
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
                              <div className="phone-spec rec-price">
                                <TagIcon />
                                <span>
                                  {formatPriceNpr(r.cheapestVariant.price) ??
                                    "—"}
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
                            <div className="rec-not-in-db">
                              Not in our catalog
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            </div>
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

      {editProfilePhase !== "closed" && (
        <div
          className={`search-overlay dash-edit-profile-overlay ${editProfilePhase === "closing" ? "closing" : ""}`}
          onClick={closeEditProfile}
        >
          <div
            className={`search-modal dash-edit-profile-modal ${editProfilePhase === "closing" ? "closing" : ""}`}
            role="dialog"
            aria-label="Edit profile"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="search-modal-header">
              <div>
                <div className="auth-title" style={{ marginBottom: 4 }}>
                  Edit profile
                </div>
                <div className="auth-subtitle" style={{ marginBottom: 0 }}>
                  Update your username and phone number.
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close edit profile"
                onClick={closeEditProfile}
              >
                <CloseIcon />
              </button>
            </div>

            <form
              className="dash-edit-profile-body"
              onSubmit={handleEditProfileSubmit}
              noValidate
            >
              <label className="form-field-label" htmlFor="edit-profile-name">
                Username
              </label>
              <input
                id="edit-profile-name"
                type="text"
                className="form-input"
                autoComplete="username"
                placeholder="Your name"
                value={editName}
                onChange={(e) => {
                  setEditName(e.target.value);
                  if (editProfileErrors.name)
                    setEditProfileErrors((prev) => ({ ...prev, name: "" }));
                }}
                aria-invalid={!!editProfileErrors.name}
              />
              {editProfileErrors.name && (
                <div className="form-field-error" role="alert">
                  {editProfileErrors.name}
                </div>
              )}

              <label
                className="form-field-label"
                htmlFor="edit-profile-phone"
                style={{ marginTop: 12 }}
              >
                Phone
              </label>
              <input
                id="edit-profile-phone"
                type="tel"
                className="form-input"
                autoComplete="tel"
                placeholder="+977-..."
                value={editPhone}
                onChange={(e) => {
                  setEditPhone(e.target.value);
                  if (editProfileErrors.phoneNo)
                    setEditProfileErrors((prev) => ({
                      ...prev,
                      phoneNo: "",
                    }));
                }}
                aria-invalid={!!editProfileErrors.phoneNo}
              />
              {editProfileErrors.phoneNo && (
                <div className="form-field-error" role="alert">
                  {editProfileErrors.phoneNo}
                </div>
              )}

              {editProfileSubmitError && (
                <div className="form-submit-error" role="alert">
                  {editProfileSubmitError}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={isEditProfileSubmitting}
                style={{ marginTop: 16 }}
              >
                {isEditProfileSubmitting ? "Saving..." : "Save changes"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Compare panel — side-docked overlay. `open` is driven by the
          URL so back-nav from a phone click keeps the panel visible.
          The dashboard chrome stays mounted underneath. */}
      <ComparePanel open={isCompareOpen} onClose={closeCompare} />

      {/* Favourites panel — same side-docked overlay pattern as Compare.
          Render-prop removal goes through the dashboard's setFavorites so
          both the popup and the underlying phone cards stay in sync. */}
      <FavoritesPanel
        open={isFavoritesOpen}
        onClose={closeFavorites}
        favorites={favorites}
        onRemoveFavorite={(id) => {
          setFavorites((fav) => {
            if (!fav[id]) return fav;
            const next = { ...fav };
            delete next[id];
            return next;
          });
        }}
      />
    </div>
  );
}

export default Dashboard;
