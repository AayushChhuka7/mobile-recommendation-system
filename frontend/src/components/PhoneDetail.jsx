import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getPhoneById, getSimilarPhones } from "../services/phones";
import { useAuth } from "../hooks/useAuth.jsx";
import { useEventLogger } from "../hooks/useEventLogger.jsx";
import "./Login.css";
import "./Dashboard.css";
import "./PhoneDetail.css";
import {
  ChevronLeftIcon,
  CameraIcon,
  BatteryIcon,
  CpuIcon,
  TagIcon,
} from "./AuthShared";
import { formatPriceNpr } from "../utils/formatPrice.js";

// ---- Field-label maps ----
// Each entry: { key in payload → human label + optional renderer }.
// The renderer receives the raw value and returns the string to display,
// or null/undefined to skip the row. Boolean values that aren't handled
// by a custom renderer fall back to Yes/No in `formatValue`.

const SPEC_SECTIONS = [
  {
    key: "network",
    title: "Network",
    fields: [
      ["technology", "Technology"],
      ["supports5g", "5G"],
      ["supportsNfc", "NFC"],
      ["dualSim", "Dual SIM"],
      ["simType", "SIM type"],
      ["wifi", "Wi-Fi"],
      ["bluetooth", "Bluetooth"],
      ["usbType", "USB"],
      ["headphoneJack", "Headphone jack"],
      ["gps", "GPS"],
    ],
  },
  {
    key: "display",
    title: "Display",
    fields: [
      ["type", "Type"],
      ["size", "Size"],
      ["refreshRate", "Refresh rate", (v) => (v ? `${v} Hz` : null)],
      ["resolution", "Resolution"],
      ["ppiDensity", "Pixel density", (v) => (v ? `${v} ppi` : null)],
      ["screenToBody", "Screen-to-body", (v) => (v ? `${v}%` : null)],
      ["protection", "Protection"],
    ],
  },
  {
    key: "platform",
    title: "Platform",
    fields: [
      ["os", "OS"],
      ["chipset", "Chipset"],
      ["processNode", "Process node"],
      ["cpu", "CPU"],
      ["gpu", "GPU"],
    ],
  },
  {
    key: "camera",
    title: "Camera",
    fields: [
      ["main", "Main"],
      ["lensCount", "Lens count"],
      ["aperture", "Aperture"],
      ["ois", "OIS"],
      ["sensorSize", "Sensor size"],
      ["video4k", "4K video"],
      ["selfie", "Selfie"],
      ["selfie4k", "Selfie 4K"],
    ],
  },
  {
    key: "physical",
    title: "Physical",
    fields: [
      ["dimensions", "Dimensions"],
      [
        "weight",
        "Weight",
        (v) => (typeof v === "number" && v > 0 ? `${v} g` : null),
      ],
    ],
  },
  {
    key: "battery",
    title: "Battery",
    fields: [
      [
        "capacity",
        "Capacity",
        (v) => (typeof v === "number" && v > 0 ? `${v} mAh` : null),
      ],
      [
        "wiredCharging",
        "Wired charging",
        (v) => (typeof v === "number" && v > 0 ? `${v} W` : null),
      ],
      ["reverseWireless", "Reverse wireless charging"],
    ],
  },
  {
    key: "metadata",
    title: "Release",
    fields: [
      [
        "announced",
        "Announced",
        (v) => {
          if (!v) return null;
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
        },
      ],
      ["status", "Status"],
    ],
  },
];

// ---- Helpers ----

function isMissing(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

function formatBoolean(v) {
  if (typeof v !== "boolean") return v;
  return v ? "Yes" : "No";
}

function formatValue(value) {
  if (isMissing(value)) return null;
  if (typeof value === "boolean") return formatBoolean(value);
  if (typeof value === "number") return String(value);
  return String(value);
}

function PhoneDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { logout } = useAuth();
  // Step B — log a "view" event once when the detail page mounts so
  // the per-tag BehaviourScore accumulates. The hook swallows errors,
  // and we only fire when `id` is a plausible UUID (string with some
  // length) so we don't pollute the table with garbage from a typo'd
  // URL.
  const logEvent = useEventLogger();

  const [phone, setPhone] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // 'not-found' | 'generic'
  const [reloadKey, setReloadKey] = useState(0);

  // The dark-mode toggle lives in the Dashboard's profile menu and is
  // persisted to localStorage. The PhoneDetail route is rendered
  // outside `.dashboard-page`, so we read the flag ourselves and stamp
  // a class on our own root so the PhoneDetail-specific dark overrides
  // apply. We also listen for `storage` events so a toggle in another
  // tab (or a future in-page toggle) is picked up without a reload.
  const DARK_MODE_KEY = "dashboardDarkMode";
  const [isDarkMode, setIsDarkMode] = useState(
    () => localStorage.getItem(DARK_MODE_KEY) === "true",
  );
  useEffect(() => {
    function handleStorageChange() {
      setIsDarkMode(localStorage.getItem(DARK_MODE_KEY) === "true");
    }
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);
  const pageClass = `phone-detail-page ${isDarkMode ? "phone-detail-dark" : ""}`;

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await getPhoneById(id);
        if (ignore) return;
        if (!data) {
          setError("not-found");
          setPhone(null);
          return;
        }
        setPhone(data);
      } catch (err) {
        if (ignore) return;
        if (err?.response?.status === 404) {
          setError("not-found");
        } else if (err?.response?.status === 401) {
          // Session expired mid-navigation — bounce to login.
          logout();
          navigate("/login", { replace: true });
          return;
        } else {
          setError("generic");
        }
        setPhone(null);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    load();
    return () => {
      ignore = true;
    };
  }, [id, reloadKey, navigate, logout]);

  // Step B — fire one "view" event per detail-page mount. We only fire
  // for UUID-shaped `id` so a stray edit doesn't push junk into the
  // Event table. The hook swallows errors so this is purely additive.
  useEffect(() => {
    if (!id) return;
    if (typeof id !== "string" || id.length < 32) return;
    logEvent("view", { phoneId: id });
  }, [id, logEvent]);

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate("/phones", { replace: true });
    }
  }, [navigate]);

  // ---- Loading / error states ----

  if (loading) {
    return (
      <div className={pageClass}>
        <TopBar onBack={handleBack} />
        <p
          className="dash-status"
          style={{ marginTop: 40, textAlign: "center" }}
        >
          Loading phone…
        </p>
      </div>
    );
  }

  if (error === "not-found") {
    return (
      <div className={pageClass}>
        <TopBar onBack={handleBack} />
        <div className="phone-detail-empty">
          <h1>Phone not found</h1>
          <p>
            We couldn't find a phone with that id. It may have been removed or
            the link is incorrect.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleBack}
          >
            Back to phones
          </button>
        </div>
      </div>
    );
  }

  if (error === "generic") {
    return (
      <div className={pageClass}>
        <TopBar onBack={handleBack} />
        <div className="phone-detail-error">
          <h1>Couldn't load this phone</h1>
          <p>
            Something went wrong while fetching the details. Please try again.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!phone) return null;

  return (
    <div className={pageClass}>
      <TopBar onBack={handleBack} />
      <PhoneDetailView phone={phone} />
    </div>
  );
}

function TopBar({ onBack }) {
  return (
    <div className="phone-detail-topbar">
      <button
        type="button"
        className="phone-detail-back"
        onClick={onBack}
        aria-label="Go back"
      >
        <ChevronLeftIcon />
        <span>Back</span>
      </button>
      <span className="phone-detail-breadcrumb">Phone details</span>
    </div>
  );
}

/**
 * Reusable, data-driven rendering of a phone's full specification tree.
 * Owns no router / no data-fetching — the caller passes in a `phone`
 * object (same shape as `getPhoneById` returns). Used by both the
 * `/phones/:id` route page and the Compare page's expandable panels.
 */
export function PhoneDetailView({ phone }) {
  // Hooks must be called unconditionally — place them before the
  // `if (!phone) return null` early return so React's hook order stays
  // stable across renders.
  const navigate = useNavigate();

  // ---- Related Phones state ----
  // The list is sourced EXCLUSIVELY from the existing Content-Based
  // ML cosine-similarity matrix (similarity_bundle.joblib) via the
  // backend's `GET /api/phones/:id/similar` endpoint. No
  // collaborative filtering, no hybrid, no persona, no popularity,
  // no browsing history, no wishlist, no purchase history, no
  // customer segmentation. The seed phone is excluded server-side.
  // Soft-fail (network/bundle error) hides the section; the phone
  // details above are unaffected.
  const [relatedPhones, setRelatedPhones] = useState([]);
  const [relatedLoading, setRelatedLoading] = useState(true);
  const [relatedError, setRelatedError] = useState(null);
  const [relatedHoveredId, setRelatedHoveredId] = useState(null);

  useEffect(() => {
    if (!phone?.id) return;
    // Reset on phone change so we don't briefly show the previous phone's
    // related list while the new one loads.
    setRelatedPhones([]);
    setRelatedLoading(true);
    setRelatedError(null);

    let ignore = false;
    (async () => {
      try {
        // Content-Based lookup — the BE proxies FastAPI's
        // GET /similarity/similar against the pre-computed NxN
        // cosine matrix. Limit 12 (the BE clamps 1..50).
        const list = await getSimilarPhones(phone.id, 12);
        if (ignore) return;
        // Defensive: drop any rows that somehow resolved to the
        // seed phone (the BE already excludes it, but keep the
        // client-side guard so a future BE change can't slip the
        // seed back into the grid).
        const filtered = (Array.isArray(list) ? list : [])
          .filter((p) => p && p.id !== phone.id)
          .slice(0, 12);
        setRelatedPhones(filtered);
      } catch (err) {
        if (ignore) return;
        // Soft-fail — the related section is decorative; the phone
        // details above must still render fine.
        setRelatedError(
          err?.response?.data?.message ||
            "Couldn't load related phones right now.",
        );
      } finally {
        if (!ignore) setRelatedLoading(false);
      }
    })();

    return () => {
      ignore = true;
    };
  }, [phone?.id]);

  if (!phone) return null;

  const brand = phone.brand || {};
  const specs = phone.specs || {};
  const pricing = phone.pricing || {};
  const variants = Array.isArray(phone.variants) ? phone.variants : [];
  const cheapest = pricing.cheapest || phone.cheapestVariant;
  const range = pricing.range;
  const announced = specs.metadata?.announced;
  const status = specs.metadata?.status;

  const cheapestText = formatPriceNpr(cheapest?.price);

  return (
    <>
      {/* Hero: image + brand + model */}
      <section className="phone-detail-hero" aria-label="Phone overview">
        <div className="phone-detail-image">
          {phone.imageUrl ? (
            <img
              src={phone.imageUrl}
              alt={phone.modelName || "Phone"}
              onError={(e) => {
                e.currentTarget.style.display = "none";
                e.currentTarget.parentElement.classList.add("no-image");
              }}
            />
          ) : (
            <span className="phone-card-emoji" aria-hidden="true">
              📱
            </span>
          )}
        </div>

        <div className="phone-detail-hero-body">
          {brand.name && (
            <div className="phone-detail-brand">
              {brand.logoUrl && (
                <img src={brand.logoUrl} alt={`${brand.name} logo`} />
              )}
              <span>{brand.name}</span>
            </div>
          )}

          <h1 className="phone-detail-model">
            {phone.modelName || "Unknown model"}
          </h1>

          <div className="phone-detail-meta">
            {typeof phone.antutuScore === "number" && phone.antutuScore > 0 && (
              <span className="phone-detail-pill">
                {phone.antutuScore.toLocaleString()} AnTuTu
              </span>
            )}
            {status && (
              <span
                className={`phone-detail-pill ${
                  /available|released|coming/i.test(status)
                    ? "success"
                    : "muted"
                }`}
              >
                {status}
              </span>
            )}
            {phone.isActive === false && (
              <span className="phone-detail-pill warn">Discontinued</span>
            )}
            {announced && (
              <span className="phone-detail-pill muted">
                {(() => {
                  const d = new Date(announced);
                  return Number.isNaN(d.getTime())
                    ? String(announced)
                    : d.toLocaleDateString();
                })()}
              </span>
            )}
          </div>

          {brand.country && (
            <div className="phone-detail-breadcrumb">
              Origin: {brand.country}
            </div>
          )}
        </div>
      </section>

      {/* Pricing */}
      {(cheapestText || range?.min || range?.max) && (
        <section className="phone-detail-pricing" aria-label="Pricing">
          <span className="phone-detail-price-label">From</span>
          {cheapestText ? (
            <span className="phone-detail-price-value">{cheapestText}</span>
          ) : null}
          {cheapest?.ram && cheapest?.storage && (
            <span className="phone-detail-breadcrumb">
              {cheapest.ram} GB RAM · {cheapest.storage} GB
              {cheapest.storageType ? ` ${cheapest.storageType}` : ""}
            </span>
          )}
          {range && (range.min || range.max) && (
            <span className="phone-detail-price-range">
              Range: {formatPriceNpr(range.min) || "—"} –{" "}
              {formatPriceNpr(range.max) || "—"}
            </span>
          )}
        </section>
      )}

      {/* Specs grid */}
      <section className="phone-detail-sections" aria-label="Specifications">
        {SPEC_SECTIONS.map(({ key, title, fields }) => {
          const section = specs[key];
          if (!section) return null;
          const renderedRows = fields
            .map(([fieldKey, label, renderer]) => {
              const raw = section[fieldKey];
              const display = renderer ? renderer(raw) : formatValue(raw);
              if (display === null || display === undefined) return null;
              const isBool =
                typeof raw === "boolean" && typeof display === "string";
              return (
                <div className="phone-detail-row" key={fieldKey}>
                  <span className="phone-detail-row-label">{label}</span>
                  <span
                    className={`phone-detail-row-value${
                      isBool ? (raw ? " boolean-yes" : " boolean-no") : ""
                    }`}
                  >
                    {display}
                  </span>
                </div>
              );
            })
            .filter(Boolean);
          if (renderedRows.length === 0) return null;
          return (
            <div className="phone-detail-section" key={key}>
              <h2>{title}</h2>
              <div className="phone-detail-grid">{renderedRows}</div>
            </div>
          );
        })}
      </section>

      {/* Variants */}
      {variants.length > 0 && (
        <section
          className="phone-detail-variants"
          aria-label="Available variants"
        >
          <h2>Variants</h2>
          <div className="phone-detail-variant-grid">
            {variants.map((v) => {
              const priceText = formatPriceNpr(v.price);
              if (!priceText && !v.ram && !v.storage) return null;
              return (
                <div
                  className="phone-detail-variant"
                  key={v.id || `${v.ram}-${v.storage}`}
                >
                  <span className="phone-detail-variant-spec">
                    {v.ram || "?"} GB RAM
                    {v.storage ? ` · ${v.storage} GB` : ""}
                  </span>
                  {v.storageType && (
                    <span className="phone-detail-variant-storage">
                      {v.storageType}
                    </span>
                  )}
                  {priceText && (
                    <span className="phone-detail-variant-price">
                      {priceText}
                    </span>
                  )}
                  {typeof v.isAvailable === "boolean" && (
                    <span
                      className={`phone-detail-pill phone-detail-variant-pill ${
                        v.isAvailable ? "success" : "muted"
                      }`}
                    >
                      {v.isAvailable ? "Available" : "Out of stock"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {phone.source && (
        <section
          className="phone-detail-variants"
          aria-label="Data source"
          style={{ marginTop: 16 }}
        >
          <span className="phone-detail-breadcrumb">
            Data source: {phone.source}
          </span>
        </section>
      )}

      {/* ---- Related Phones ----
          Reuses the existing GET /phones endpoint (same one the Dashboard
          already hits) — no new API. Renders exactly 12 cards in the same
          .phone-grid layout the dashboard uses, so styling, hover animation
          and card shadow are all inherited from Dashboard.css. The current
          phone is filtered out if it happens to appear in the response. */}
      <section
        className="related-phones-section"
        aria-label="Related phones"
      >
        <header className="related-phones-header">
          <h2>Related Phones</h2>
          <p className="related-phones-subtitle">
            Phones similar to this one
          </p>
        </header>

        {relatedLoading && (
          <p className="dash-status">Loading related phones…</p>
        )}

        {relatedError && !relatedLoading && (
          <p className="dash-status dash-status-error">{relatedError}</p>
        )}

        {!relatedLoading && !relatedError && relatedPhones.length > 0 && (
          <div className="phone-grid related-phones-grid">
            {relatedPhones.map((p) => {
              const isHovered = relatedHoveredId === p.id;
              const wrapperClass = `phone-card related-phone-card${
                isHovered ? " expanded" : ""
              }`;
              const goToPhone = () => {
                if (p.id) navigate(`/phones/${p.id}`);
              };
              const handleKeyDown = (e) => {
                if (!p.id) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  goToPhone();
                }
              };
              return (
                <div
                  key={p.id}
                  className={wrapperClass}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${p.brand?.name || ""} ${p.modelName || "phone"} details`}
                  onClick={goToPhone}
                  onKeyDown={handleKeyDown}
                  onMouseEnter={() => setRelatedHoveredId(p.id)}
                  onMouseLeave={() => setRelatedHoveredId(null)}
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
                          {p.cheapestVariant.ram &&
                          p.cheapestVariant.storage
                            ? ` · ${p.cheapestVariant.ram}GB/${p.cheapestVariant.storage}GB`
                            : ""}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

export default PhoneDetail;
