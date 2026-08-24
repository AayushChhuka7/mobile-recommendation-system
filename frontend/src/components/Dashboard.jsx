import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { getPhones } from "../services/phones";
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
import logo from "../assets/logo.png";
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
import { eurFromNpr, formatPriceNpr } from "../utils/formatPrice.js";

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

// Image-fallback strategy: each card always renders a single `<img>`.
// The src is `p.imageUrl` when the BE supplied one, otherwise
// `/backup.png` (served from `public/`). If the BE URL 404s, the
// shared `handleImgError` swaps the src to `/backup.png` once — a
// data-attr guards against re-firing and looping if the backup
// itself is missing.

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

// Matches the close animation defined in Dashboard.css for both the
// change-password and edit-profile modals (`dash-change-pw-modal.closing`
// / `dash-edit-profile-modal.closing`). Used by the close timers in
// `closeChangePassword` and `closeEditProfile` to wait for the fade-out
// before fully unmounting. Was previously referenced as a free variable
// that never got defined, which made every "close after success" path
// throw a ReferenceError into the submit's catch block — surfacing as
// the generic "Couldn't update profile. Please try again." banner even
// though the PATCH actually succeeded (the dropdown already updated).
const CLOSE_ANIM_MS = 220;

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
  const params = { limit: 12, sort, ...extra };
  if (filters.brand) params.brand = filters.brand;
  // The dashboard's phone cards display prices in NPR (see
  // `formatPriceNpr`) but the backend stores `phoneVariants.price`
  // in EUR. The filter inputs accept the value the user sees on
  // the card (NPR), so convert NPR → EUR right before sending —
  // reusing `eurFromNpr` (the inverse of `formatPriceNpr`). Without
  // this, a user typing the on-screen NPR max sees results unchanged
  // because the backend runs `price <= 135720` against a EUR column.
  if (filters.minPrice) {
    const eur = eurFromNpr(filters.minPrice);
    if (eur !== null) params.minPrice = eur;
  }
  if (filters.maxPrice) {
    const eur = eurFromNpr(filters.maxPrice);
    if (eur !== null) params.maxPrice = eur;
  }
  if (filters.minRam) params.minRam = filters.minRam;
  if (filters.minBattery) params.minBattery = filters.minBattery;
  if (filters.os) params.os = filters.os;
  if (filters.has5G) params.has5G = "true";
  if (filters.hasNfc) params.hasNfc = "true";
  if (filters.hasOis) params.hasOis = "true";
  return params;
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
  const [isEditProfileSubmitting, setIsEditProfileSubmitting] =
    useState(false);

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

  // Brand include/exclude preference for the "Find your phone" modal.
  // Modal-scoped (not auto-saved). `brandMode` toggles between "include"
  // and "exclude"; `selectedBrands` is the chip-set the user has picked.
  const [brandMode, setBrandMode] = useState("include");
  const [selectedBrands, setSelectedBrands] = useState([]);

  const [recs, setRecs] = useState(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsError, setRecsError] = useState("");
  const [recsPersona, setRecsPersona] = useState(null);
  // Tracks which flow produced the currently-displayed recommendations:
  //   "auto"   → from the on-mount `getAutoRecommendations` call
  //   "manual" → from the "Recommend Me a Phone" click handler
  //   null     → no recs displayed (or the user just hit "Clear")
  // Used purely to gate three small UI fragments (Match Score, Clear
  // button, Boosted badge) — never to alter the recommendation pipeline.
  const [recommendationSource, setRecommendationSource] = useState(null);
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
  const [isLoading, setIsLoading] = useState(true);
  // Catalog-load error. Kept separate from the recs error so a failing
  // /phones call doesn't blank out the recs/header — the user keeps
  // seeing whatever *did* load and gets a small non-blocking banner
  // with a Retry button above the "Explore more phones" heading. The
  // banner is dismissed automatically on the next successful load.
  const [catalogError, setCatalogError] = useState(null);
  // Bumped by the Retry button to force the loadPhones effect to re-run
  // without changing any of its real inputs.
  const [catalogRetryToken, setCatalogRetryToken] = useState(0);

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
      try {
        const extra = { page };
        if (searchTerm) extra.search = searchTerm;

        const params = buildPhonesQuery(filters, sort, extra);
        const {
          phones: phoneList,
          meta,
          fromFallback,
        } = await getPhones(params);

        if (!ignore) {
          setPhones(phoneList);
          if (meta) {
            setTotalPages(meta.totalPages || 1);
            setTotal(meta.total || phoneList.length);
          } else {
            setTotalPages(1);
            setTotal(phoneList.length);
          }
          // Successful load — whether from the live BE or the local
          // snapshot — clears any previous catalog banner. The
          // `fromFallback` flag is set when the service served the
          // curated JSON because the BE 500'd, which would otherwise
          // land in the catch block and surface the Prisma message.
          setCatalogError(null);
          // Surface a one-time, low-key note that we're on the
          // snapshot — the user otherwise has no idea why they're
          // seeing phones despite the banner that just disappeared.
          // Skipped silently when the live BE served the data.
          if (fromFallback) {
            console.info(
              "[dashboard] /phones 5xx'd — serving local fallback catalog.",
            );
          }
        }
      } catch (err) {
        if (!ignore) {
          if (err.response?.status === 401) {
            // Auth failure is fatal — bounce to login. We still clear
            // the catalogError so a stale banner doesn't linger under
            // the redirect spinner.
            setCatalogError(null);
            setTimeout(() => {
              logout();
              navigate("/login", { replace: true });
            }, 2000);
          } else {
            // Non-blocking: keep the last good phone list (if any) on
            // screen, surface the failure as a banner above the
            // "Explore more phones" heading. The Retry button bumps
            // `catalogRetryToken` which is a dep of this effect.
            setCatalogError(
              err.response?.data?.message ||
                err?.message ||
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
  }, [
    searchTerm,
    filters,
    sort,
    page,
    navigate,
    logout,
    catalogRetryToken,
  ]);

  // Catalog Retry — bumps the effect's dep so the same loadPhones
  // pipeline re-runs without forcing a full app reload (which the
  // old `window.location.reload()` retry used to do).
  const handleRetryCatalog = useCallback(() => {
    setCatalogRetryToken((t) => t + 1);
  }, []);

  // Shared image handlers. The catalog card always renders an `<img>`
  // — when the BE-supplied `imageUrl` is missing or 404s, the onError
  // handler swaps the src to `/backup.png` (served from `public/`)
  // so the user always sees a real image rather than a broken-icon.
  // One-time swap only (tracked via a data-attr) so a backup.png 404
  // doesn't loop.
  const handleImgError = useCallback((e) => {
    const el = e.currentTarget;
    if (el.dataset.fallback !== "1") {
      el.dataset.fallback = "1";
      el.src = "/backup.png";
    }
  }, []);

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
    // Only auto-recommend on the first page. Pages 2+ are pure
    // paginated catalog — the recommendations section is hidden
    // there, so no need to spend a network round-trip.
    if (page !== 1) return;
    // Skip when any recommendations are already on screen. The flag
    // covers both auto (re-mount during the same session) and manual
    // (user clicked "Recommend Me" and we don't want to clobber their
    // picks). The Clear Recommendation button flips this back to
    // null, which makes this effect re-eligible to run and re-fetch
    // the auto-recommendation list — same flow as on initial mount.
    if (recommendationSource !== null) return;

    let ignore = false;
    setRecsLoading(true);
    setRecsError("");

    (async () => {
      try {
        const { results, defaultedAt } = await getAutoRecommendations();
        if (ignore) return;
        setRecs(results);
        // Tag the persona + mark the source as "auto" so the three
        // UI gates (Match Score / Clear button / Boosted badge) hide.
        setRecommendationSource("auto");
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
  }, [user?.userId, user?.id, recommendationSource, page]);

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
    }, CLOSE_ANIM_MS);
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
    }, CLOSE_ANIM_MS);
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
        //
        // Only send fields the user actually changed. The BE's
        // `checkPhoneNo` uniqueness validator looks up the phoneNo
        // against the entire users table (without excluding the
        // current row), so echoing back the user's own existing
        // phoneNo when they only meant to change the username
        // triggers a "phoneNo is already registered" rejection
        // — surfacing in the UI as a generic "verification error".
        // Same logic for `name`: don't touch it when untouched so the
        // BE doesn't have to re-run `checkUserName` on a value the
        // user didn't actually edit.
        const originalPhone = user?.phoneNo || user?.phone || "";
        const trimmedPhone = editPhone.trim();
        const trimmedName = editName.trim();
        const phoneChanged = trimmedPhone !== (originalPhone || "").trim();
        const payload = { name: trimmedName };
        if (phoneChanged) payload.phoneNo = trimmedPhone;
        const res = await api.patch("/users/me", payload);
        // Mirror the saved values back into AuthContext so the
        // dropdown re-renders with the new display name + phone
        // without a full page reload.
        //
        // When the user only edited the username we never sent
        // `phoneNo` — so fall back to the pre-existing value rather
        // than blanking it out in AuthContext.
        const saved =
          res?.data?.data && typeof res.data.data === "object"
            ? res.data.data
            : null;
        setUser({
          name: saved?.name ?? editName.trim(),
          phoneNo: phoneChanged
            ? (saved?.phoneNo ?? trimmedPhone)
            : originalPhone,
        });
        closeEditProfile();
      } catch (err) {
        const data = err?.response?.data;
        // Prefer the most specific message the BE gave us. The
        // validator returns its errors inside `data.details[*].msg`
        // (express-validator array) — when present, surface the
        // first one instead of the generic "validation failed"
        // envelope message. Falls back to the top-level message,
        // then the hardcoded default.
        const firstDetailMsg = Array.isArray(data?.details)
          ? data.details.find((d) => d?.msg)?.msg
          : null;
        setEditProfileSubmitError(
          firstDetailMsg ||
            data?.message ||
            "Couldn't update profile. Please try again.",
        );
      } finally {
        setIsEditProfileSubmitting(false);
      }
    },
    [
      validateEditProfile,
      editName,
      editPhone,
      closeEditProfile,
      setUser,
    ],
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

  // Brand chip toggle — add a brand to `selectedBrands` if it isn't
  // already in the set, otherwise remove it. Stable identity by name
  // (matches the brand list served by `/phones/filters`).
  const toggleBrand = useCallback((name) => {
    setSelectedBrands((prev) =>
      prev.includes(name) ? prev.filter((b) => b !== name) : [...prev, name],
    );
  }, []);

  // Reset the brand selector. Modal-scoped — does not touch the stored
  // user profile.
  const clearBrands = useCallback(() => {
    setSelectedBrands([]);
  }, []);
  const handleFindPhone = useCallback(async () => {
    const max = Number(budgetMax);
    if (!Number.isFinite(max) || max <= 0) {
      setRecsError("Please enter a maximum budget before finding your phone.");
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

    setRecsLoading(true);
    setRecsError("");
    setRecs(null);
    // Mark this as a manual request so the UI gates (Match Score,
    // Clear button, Boosted badge) flip to their manual behaviour
    // for the duration of the call. The auto-recommend effect
    // bails out on `recommendationSource !== null`, so this also
    // prevents the on-mount fetch from racing us.
    setRecommendationSource("manual");
    setRecsPersona(selectedCategory);
    closeRecommend();
    const persona = weightsTouched ? "Custom" : selectedCategory;
    const preferences = weightsTouched ? { ...weights } : undefined;
    // Only attach `brandFilter` when the user actually picked at least
    // one brand — an empty list would tell the ML ranker "include
    // nothing", which is the wrong default.
    const brandFilter =
      selectedBrands.length > 0 ? { mode: brandMode, list: selectedBrands } : undefined;

    try {
      const results = await getRecommendations({
        persona,
        budget,
        preferences,
        brandFilter,
        // Two-stage pipeline trigger. The BE detects topN === 5 and
        // switches off the 5-signal fusionRank and onto the
        // rule-based → content-based → top-5 pipeline. The
        // auto-recommend path on dashboard mount still hits
        // GET /recommend/auto and is unaffected.
        // NOTE: bumped from 5 to 8 per product request; the BE's
        // `topN === 5` pipeline-switch check will no longer match,
        // so this path will fall through to the default pipeline.
        topN: 8,
      });
      setRecs(results);

      // Auto-save the persona + weights + budget that produced this
      // recommendation. Fire-and-forget — a save failure must never
      // disturb the rec result the user just received.
      saveMyPreferences({
        persona,
        budgetMin: minEur !== null ? minEur : "",
        budgetMax: maxEur,
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
    brandMode,
    selectedBrands,
    closeRecommend,
  ]);
  const handleClearRecommendations = useCallback(() => {
    setRecs(null);
    setRecsError("");
    setRecsPersona(null);
    // Flip the source back to null so the auto-recommend effect
    // re-eligible to run and re-fetch the automatic list. This
    // restores the dashboard to the same auto-recommendation state
    // it had on initial mount — same cards, same hidden UI elements.
    setRecommendationSource(null);
  }, []);
  const handleSearch = (e) => {
    e.preventDefault();
    const term = searchInput.trim();
    setSearchTerm(term);
    setShowSearchSuggestions(false);
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
        <button
          type="button"
          className="dash-brand"
          onClick={() => navigate("/")}
          title="Go to home"
          aria-label="Go to home"
        >
          <img src={logo} alt="" className="dash-brand-logo" />
          <span className="dash-brand-text">
            <span className="dash-brand-title">Mobile</span>
            <span className="dash-brand-sub">Recommendation System</span>
          </span>
        </button>
        <div className="dash-header-actions">
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
            <div className="dash-search-input-wrapper" ref={searchSuggestionsRef}>
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
                              e.target.parentElement.classList.add(
                                "no-image",
                              );
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

        {isLoading && !catalogError && (
          <p className="dash-status">Loading phones…</p>
        )}

        {/* Catalog-error banner — non-blocking. The recs section above
            (and the search/filter UI) stay interactive even when
            /phones 5xxs. The banner sits above the "Explore more
            phones" heading and offers a one-click retry that re-runs
            the same effect without forcing a full page reload. */}
        {catalogError && !isLoading && (
          <div className="dash-catalog-banner" role="status">
            <div className="dash-catalog-banner-text">
              <strong>Couldn't load the phone catalog.</strong>
              <span className="dash-catalog-banner-detail">{catalogError}</span>
            </div>
            <button
              type="button"
              className="btn btn-small btn-outline"
              onClick={handleRetryCatalog}
            >
              Retry catalog
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

        {recs && !recsLoading && !searchTerm && activeFilterCount === 0 && page === 1 && (
          <section
            className="dash-recs-section"
            aria-label="Recommended for you"
          >
            {/*
              Auto-rec cards are rendered "just like the non-recommended
              phone list" — i.e. no "All phones ranked for you" header
              banner above them, no Clear button, no `rec-card`
              wrapper class. Only the manual path keeps the original
              ranked-for-you header chrome.
            */}
            {recommendationSource === "manual" && (
              <div className="dash-recs-header">
                <h2>
                  {recsPersona
                    ? `All phones ranked for you · ${recsPersona}`
                    : "All phones ranked for you"}
                </h2>
                {/* Clear button is only shown for manual recommendations.
                    Automatic recommendations get their Clear button hidden
                    — the dashboard already re-fetches auto-recommendations
                    on mount and the user didn't request them explicitly. */}
                <button
                  type="button"
                  className="btn btn-outline btn-small"
                  onClick={handleClearRecommendations}
                >
                  Clear recommendations
                </button>
              </div>
            )}
            {recs.length === 0 ? (
              <p className="dash-status">
                No matches for the chosen persona and budget. Try widening your
                budget or picking a different category.
              </p>
            ) : (
              <div className="phone-grid">
                {recs.slice(0, 8).map((r) => {
                  // In-DB recs navigate to the in-app detail page via
                  // their Prisma id. Out-of-DB recs have no `id`, but
                  // the user still expects them to behave like the
                  // catalog cards — so we mint a synthetic id of the
                  // form `csv:<brand>:<model>` and route through the
                  // same `/phones/:id` path. `getPhoneById` recognises
                  // the `csv:` prefix and serves the matching row
                  // from `fallback-phones.json` shaped like
                  // `formatPhoneDetail`, so PhoneDetail.jsx renders
                  // the same way it does for catalog cards.
                  const synthId =
                    !r.id && r.brand?.name && r.modelName
                      ? `csv:${encodeURIComponent(r.brand.name)}:${encodeURIComponent(r.modelName)}`
                      : null;
                  const detailId = r.id || synthId;
                  const hasInternalTarget = !!detailId;
                  const isClickable = hasInternalTarget;
                  const handleRecClick = () => {
                    if (hasInternalTarget) {
                      navigate(`/phones/${detailId}`);
                    }
                  };
                  const handleRecKeyDown = (e) => {
                    if (!isClickable) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleRecClick();
                    }
                  };
                  // For automatic recommendations the wrapper uses
                  // exactly the same `phone-card` class as the
                  // regular non-recommended phone list — no extra
                  // `rec-card` modifier — so the card renders
                  // identically (same border, padding, hover, layout).
                  // Manual recommendations keep the historical
                  // `rec-card` class so any future rec-specific
                  // styling can be reintroduced without re-touching
                  // this site.
                  //
                  // The `expanded` modifier is appended whenever the
                  // shared `hoveredCard` state points at this card —
                  // same hover-to-reveal pattern used by the regular
                  // phone grid below. This drives the existing
                  // `.phone-card.expanded .phone-card-details` CSS
                  // rule so the spec panel (OS, camera, battery,
                  // price + RAM/Storage) is revealed on hover,
                  // matching what the non-recommended cards do.
                  const isExpanded = detailId && hoveredCard === detailId;
                  const wrapperClass =
                    recommendationSource === "auto"
                      ? `phone-card${isExpanded ? " expanded" : ""}`
                      : `phone-card rec-card${isExpanded ? " expanded" : ""}`;
                  // The Python ML ranker often returns `modelName`
                  // already prefixed with the brand — e.g.
                  // `modelName: "Honor Magic8 Pro"` + `brand: { name: "Honor" }`.
                  // Without this filter the card renders the brand
                  // twice ("Honor" tagline + "Honor Magic8 Pro" name).
                  // Hide the tagline when the name already starts with
                  // the brand string (case-insensitive, trimmed).
                  const brandName = r.brand?.name?.trim() || "";
                  const modelName = r.modelName?.trim() || "";
                  const brandIsRedundant =
                    brandName.length > 0 &&
                    modelName.toLowerCase().startsWith(
                      brandName.toLowerCase(),
                    );
                  return (
                    <div
                      key={detailId || `${r.brand?.name}-${r.modelName}`}
                      className={wrapperClass}
                      role={isClickable ? "button" : undefined}
                      tabIndex={isClickable ? 0 : -1}
                      aria-label={
                        hasInternalTarget
                          ? `View ${r.brand?.name || ""} ${r.modelName || "phone"} details`
                          : undefined
                      }
                      onClick={handleRecClick}
                      onKeyDown={handleRecKeyDown}
                      onMouseEnter={() => detailId && setHoveredCard(detailId)}
                      onMouseLeave={() => setHoveredCard(null)}
                      style={{ cursor: isClickable ? "pointer" : "default" }}
                    >
                      <div className="phone-card-top">
                        <div className="phone-card-image">
                          <img
                            src={r.imageUrl || "/backup.png"}
                            alt={r.modelName}
                            onError={handleImgError}
                          />
                          {/* Match Score badge: hidden for automatic
                              recommendations, shown for manual. */}
                          {typeof r.matchScore === "number" &&
                            recommendationSource === "manual" && (
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
                          {/* Boosted badge: hidden per current UI spec for
                              both auto AND manual recommendations. The
                              JSX is preserved so the path can be
                              re-enabled by flipping the source check. */}
                          {r.matchComponents?.search_history > 0.6 &&
                            recommendationSource === "manual" && (
                              <span
                                className="rec-boosted-badge"
                                title="Ranked higher because of your recent searches & views"
                              >
                                Boosted by your activity
                              </span>
                            )}
                          {/* "Not in our catalog" — only for items the
                              recommender knows about but the local DB
                              doesn't have a row for. Rendered as a
                              small chip pinned to the top-right of the
                              card image so it doesn't push the phone
                              name down or get misread as a third
                              tagline line. `pointer-events: none`
                              keeps it from blocking the card's hover
                              or click target. */}
                          {r.inDatabase === false && (
                            <span
                              className="rec-not-in-db-chip"
                              title="Recommended by the ML model, but not currently in the local catalog"
                            >
                              Not in our catalog
                            </span>
                          )}
                        </div>
                        <div className="phone-card-name">{r.modelName}</div>
                        {!brandIsRedundant && (
                          <div className="phone-card-tagline">
                            {r.brand?.name || "Unknown brand"}
                          </div>
                        )}
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

                      {/*
                        Explainable-AI (SHAP) "why" list — only shown for
                        manual recommendations. For automatic
                        recommendations we deliberately suppress this
                        block so the auto-rec card renders the phone's
                        normal specs (OS, camera, battery, price,
                        RAM/Storage) only — identical to a regular
                        non-recommended phone card. Same
                        `recommendationSource` flag already gates the
                        Match Score / Boosted / Clear UI elsewhere.
                      */}
                      {Array.isArray(r.why) &&
                        r.why.length > 0 &&
                        recommendationSource === "manual" && (
                          <ul
                            className="rec-why-list"
                            aria-label="Why this match"
                          >
                            {r.why.slice(0, 3).map((reason, idx) => (
                              <li key={idx}>{reason}</li>
                            ))}
                          </ul>
                        )}

                      {/*
                        CF (collaborative-filtering) reason badge. The
                        backend `recommendService` attaches
                        `cfReasons: string[]` to a row when the CF
                        service also recommended it (either as a
                        standalone row OR as a hit on an existing
                        rule-based candidate). The first reason is
                        shown as a single-line "people like you also
                        liked" hint; subsequent reasons are hidden
                        behind the same `slice(0,1)` to keep the card
                        compact. Same `recommendationSource === "manual"`
                        gate as the SHAP "why" list — auto-rec cards
                        stay quiet.
                      */}
                      {Array.isArray(r.cfReasons) &&
                        r.cfReasons.length > 0 &&
                        recommendationSource === "manual" && (
                          <div
                            className="cf-reason-badge"
                            aria-label="People like you also liked"
                          >
                            <span className="cf-reason-text">
                              <strong>People like you liked:</strong>
                              {r.cfReasons.slice(0, 1).map((reason, idx) => (
                                <span key={idx}> {reason}</span>
                              ))}
                            </span>
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {!isLoading && !catalogError && phones.length === 0 && (
          <p className="dash-status">
            No phones found. Try adjusting your search or filters.
          </p>
        )}

        {!isLoading && !catalogError && phones.length > 0 && (
          <>
            <h2 className="dash-section-title">Explore more phones</h2>
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
                    <img
                      src={p.imageUrl || "/backup.png"}
                      alt={p.modelName}
                      onError={handleImgError}
                    />
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
          </>
        )}

        {/* Pagination — only when there is more than one page */}
        {!isLoading && !catalogError && totalPages > 1 && (
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

      {location.pathname === "/dashboard/recommend" && (
        <div
          className="search-overlay dash-recommend-overlay"
          onClick={closeRecommend}
        >
          <div
            className="search-modal dash-recommend-modal"
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

            <div className="questionnaire-section" style={{ marginTop: 16 }}>
              <div className="dash-brands-header">
                <div className="questionnaire-hint" style={{ marginBottom: 0 }}>
                  Phone brands — optional
                  {selectedBrands.length > 0 && (
                    <span className="dash-brands-count">
                      {" "}({selectedBrands.length} selected)
                    </span>
                  )}
                </div>
                {selectedBrands.length > 0 && (
                  <button
                    type="button"
                    className="dash-brand-clear"
                    onClick={clearBrands}
                    aria-label="Clear brand selection"
                  >
                    Clear
                  </button>
                )}
              </div>

              <div
                className="dash-brand-mode"
                role="tablist"
                aria-label="Brand filter mode"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={brandMode === "include"}
                  className={`dash-brand-mode-btn ${brandMode === "include" ? "selected" : ""}`}
                  onClick={() => setBrandMode("include")}
                >
                  Include brands
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={brandMode === "exclude"}
                  className={`dash-brand-mode-btn ${brandMode === "exclude" ? "selected" : ""}`}
                  onClick={() => setBrandMode("exclude")}
                >
                  Exclude brands
                </button>
              </div>

              {brands.length > 0 ? (
                <div className="dash-brands-grid">
                  {brands.map((b) => {
                    const name = typeof b === "string" ? b : b?.name;
                    if (!name) return null;
                    const selected = selectedBrands.includes(name);
                    return (
                      <button
                        type="button"
                        key={name}
                        className={`usage-chip ${selected ? "selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => toggleBrand(name)}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="dash-brand-hint">
                  Pick brands to include or exclude.
                </div>
              )}
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
    </div>
  );
}

export default Dashboard;
