import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getPhoneById } from "../services/phones";
import { useAuth } from "../hooks/useAuth.jsx";
import { useEventLogger } from "../hooks/useEventLogger.jsx";
import "./Login.css";
import "./Dashboard.css";
import "./PhoneDetail.css";
import { ChevronLeftIcon } from "./AuthShared";
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
    </>
  );
}

export default PhoneDetail;
