// AdminCustomerDetail.jsx — admin-only detail view for a single user's
// profile bundle (user + preference + customerProfile + lastRecommendation
// + recent signals timeline).
//
// Mounted at `/admin/customer-profiles/:id` by App.jsx. Guarded by
// `useAdminGuard`. Reads the userId from the URL path (manual switch in
// App.jsx — not React Router sub-routes).

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminGuard } from "../hooks/useAdminGuard.jsx";
import {
  getCustomerProfileById,
  getCustomerBehavior,
} from "../services/adminProfiles";
import { getPhoneById } from "../services/phones";
import { ChevronIcon } from "./AuthShared";
import "./AdminCustomerDetail.css";

function formatDate(value) {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  } catch {
    return "—";
  }
}

function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "—";
  }
  return String(value);
}

function AdminCustomerDetail() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAdminGuard();

  // userId is read from window.location.pathname because App.jsx uses
  // a manual path-prefix switch (no React Router sub-routes inside
  // pages). Pattern: /admin/customer-profiles/:id
  const userId = (() => {
    const path = window.location.pathname;
    const m = path.match(/^\/admin\/customer-profiles\/([^/]+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  })();

  const [bundle, setBundle] = useState(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [fetching, setFetching] = useState(true);
  // Step B — per-tag behaviour scores for the target user. Populated
  // alongside the bundle. Renders as a top-N list in its own card.
  const [behavior, setBehavior] = useState([]);
  const [behaviorError, setBehaviorError] = useState("");
  // Map of phoneId → full phone record (imageUrl, brand.name, modelName,
  // specs, pricing). Hydrated lazily as the topResults come back from
  // the bundle endpoint so the "Top results" rail can render real
  // phone cards (image, model, price) the same way the dashboard does,
  // instead of plain "Brand · Model" text rows.
  const [topResultPhones, setTopResultPhones] = useState({});

  useEffect(() => {
    if (!isAdmin) return; // guard will redirect; skip fetch
    if (!userId) {
      setError("Missing user id in the URL.");
      setErrorCode("BAD_REQUEST");
      setFetching(false);
      return;
    }
    let ignore = false;
    (async () => {
      setFetching(true);
      setError("");
      setErrorCode("");
      setBehaviorError("");
      try {
        // Fetch the bundle and behaviour scores in parallel — they're
        // independent reads so we don't have to gate one on the other.
        // The behaviour read has its own try/catch so a 404 / 500 on
        // the new endpoint doesn't fail the page render.
        const [data, behaviorRows] = await Promise.all([
          getCustomerProfileById(userId),
          getCustomerBehavior(userId).catch((err) => {
            if (!ignore) {
              setBehaviorError(
                err?.response?.data?.message || err?.message || "—",
              );
            }
            return [];
          }),
        ]);
        if (ignore) return;
        setBundle(data);
        setBehavior(Array.isArray(behaviorRows) ? behaviorRows : []);
      } catch (err) {
        if (!ignore) {
          const status = err?.response?.status;
          const code = err?.response?.data?.code || String(status || "");
          setErrorCode(code);
          setError(
            status === 404
              ? "User not found."
              : status === 403
                ? "You don't have permission to view this page."
                : status === 401
                  ? "Your session has expired. Please log in again."
                  : err?.response?.data?.message ||
                      err?.message ||
                      "Failed to load profile."
          );
        }
      } finally {
        if (!ignore) setFetching(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [isAdmin, userId]);

  // Hydrate the topResults phones — the BE returns just phoneId /
  // overallCompatibility / searchDate, so we need to fan out one
  // GET /phones/:id per row to get the image + brand + model needed
  // to render real phone cards. Independent reads run in parallel;
  // any single failure is swallowed so the page still renders.
  useEffect(() => {
    const rows = bundle?.lastRecommendation?.topResults;
    if (!Array.isArray(rows) || rows.length === 0) {
      setTopResultPhones({});
      return undefined;
    }
    const ids = rows.map((r) => r?.phoneId).filter(Boolean);
    if (ids.length === 0) return undefined;
    let ignore = false;
    (async () => {
      const fetched = await Promise.all(
        ids.map((id) =>
          getPhoneById(id).catch(() => null),
        ),
      );
      if (ignore) return;
      const next = {};
      ids.forEach((id, i) => {
        if (fetched[i]) next[id] = fetched[i];
      });
      setTopResultPhones(next);
    })();
    return () => {
      ignore = true;
    };
  }, [bundle?.lastRecommendation]);

  if (loading || !isAdmin) {
    return (
      <div className="admin-detail-page">
        <div className="admin-list-splash">Checking access…</div>
      </div>
    );
  }

  return (
    <div className="admin-detail-page">
      <header className="admin-detail-header">
        <div className="admin-detail-header-row">
          <button
            type="button"
            className="admin-back-btn"
            onClick={() => navigate("/admin/customer-profiles")}
            aria-label="Back to customer list"
          >
            <ChevronIcon /> <span>Back to list</span>
          </button>
          {/* Page-level title lives below the back button on its own
            * line. Renders as "User profile of <name>" so the admin
            * still knows whose detail page they're on at a glance,
            * even though the per-field values (email, phone, etc.)
            * also appear in the "User" card below. */}
          <h1 className="admin-detail-title">
            {bundle?.user?.name
              ? `User profile of ${bundle.user.name}`
              : "User profile"}
          </h1>
        </div>
      </header>

      {fetching && <div className="admin-list-splash">Loading profile…</div>}

      {error && !fetching && (
        <div className="admin-list-error" role="alert">
          {error}
        </div>
      )}

      {!fetching && !error && bundle && (
        <div className="admin-detail-grid">
          {/* USER — rendered as a single info-per-row list (label above
            * value) rather than the two-column dl grid the other cards
            * use, so each field gets its own line and reads like a
            * profile detail sheet. The ":" between label and value is
            * injected in JSX so we don't need a CSS pseudo-element. */}
          <section className="admin-card">
            <h2 className="admin-card-title">User's information</h2>
            <ul className="admin-info-list">
              <li>
                <span className="admin-info-label">Name:</span>
                <span className="admin-info-value">
                  {bundle.user?.name || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Email:</span>
                <span className="admin-info-value">
                  {bundle.user?.email || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Phone:</span>
                <span className="admin-info-value">
                  {bundle.user?.phoneNo || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Role:</span>
                <span className="admin-info-value">
                  {bundle.user?.role || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Active:</span>
                <span className="admin-info-value">
                  {bundle.user?.isActive ? "Yes" : "No"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Verified:</span>
                <span className="admin-info-value">
                  {bundle.user?.isVerified ? "Yes" : "No"}
                </span>
              </li>
            </ul>
          </section>

          {/* PREFERENCE
            *
            * The schema stores: maxBudget, cameraPreference, usageType,
            * preferredBrands. The FE-persisted "weights" object is
            * reduced to cameraPreference + usageType at write time, so
            * Storage / RAM / Battery cannot be reconstructed from the
            * bundle alone (they're per-phone fields, not per-customer).
            * They render as "—" instead of being fabricated. */}
          <section className="admin-card">
            <h2 className="admin-card-title">Preference</h2>
            <ul className="admin-info-list">
              <li>
                <span className="admin-info-label">Preferred brand:</span>
                <span className="admin-info-value">
                  {bundle.preference?.preferredBrands || (
                    <span className="admin-muted">Not specified</span>
                  )}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Budget:</span>
                <span className="admin-info-value">
                  {formatNumber(bundle.preference?.maxBudget)}
                  {bundle.customerProfile?.avgBudget ? (
                    <span className="admin-muted">
                      {" "}
                      · avg {formatNumber(bundle.customerProfile.avgBudget)}
                    </span>
                  ) : null}
                </span>
              </li>
              {/* Storage / RAM are derived from the user's modal
                * recommendation rows by profileAggregator. Until the
                * user has triggered at least MIN_NEW_ROWS=5
                * recommendations the values stay null and we surface
                * a "Not tracked yet" hint rather than a bare "—". */}
              <li>
                <span className="admin-info-label">Storage:</span>
                <span className="admin-info-value">
                  {bundle.customerProfile?.preferredStorageGb != null
                    ? `${formatNumber(bundle.customerProfile.preferredStorageGb)} GB`
                    : <span className="admin-muted">Not tracked yet</span>}
                </span>
              </li>
              <li>
                <span className="admin-info-label">RAM:</span>
                <span className="admin-info-value">
                  {bundle.customerProfile?.preferredRamGb != null
                    ? `${formatNumber(bundle.customerProfile.preferredRamGb)} GB`
                    : <span className="admin-muted">Not tracked yet</span>}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Battery:</span>
                <span className="admin-info-value">
                  <span className="admin-muted">Not tracked yet</span>
                </span>
              </li>
              <li>
                <span className="admin-info-label">Camera:</span>
                <span className="admin-info-value">
                  {bundle.preference?.cameraPreference || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Usage type:</span>
                <span className="admin-info-value">
                  {bundle.preference?.usageType || "—"}
                </span>
              </li>
            </ul>
          </section>

          {/* CUSTOMER PROFILE */}
          <section className="admin-card">
            <h2 className="admin-card-title">Customer profile</h2>
            <ul className="admin-info-list">
              <li>
                <span className="admin-info-label">Budget segment:</span>
                <span className="admin-info-value">
                  {bundle.customerProfile?.budgetSegment || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Tech tier:</span>
                <span className="admin-info-value">
                  {bundle.customerProfile?.techTier || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Recommendation persona:</span>
                <span className="admin-info-value">
                  {bundle.customerProfile?.recommendationPersona || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Avg budget:</span>
                <span className="admin-info-value">
                  {formatNumber(bundle.customerProfile?.avgBudget)}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Searches:</span>
                <span className="admin-info-value">
                  {formatNumber(bundle.customerProfile?.searchCount)}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Recommendations:</span>
                <span className="admin-info-value">
                  {formatNumber(bundle.customerProfile?.totalRecommendations)}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Comparisons:</span>
                <span className="admin-info-value">
                  {formatNumber(bundle.customerProfile?.totalComparisons)}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Segment confidence:</span>
                <span className="admin-info-value">
                  {bundle.customerProfile?.segmentConfidence || "—"}
                </span>
              </li>
              <li>
                <span className="admin-info-label">Last updated:</span>
                <span className="admin-info-value">
                  {formatDate(bundle.customerProfile?.lastUpdated)}
                </span>
              </li>
            </ul>
          </section>

          {/* BEHAVIOUR SCORES — Step B.
            *
            * Rolled-up per-tag scores from the BehaviorScore table.
            * Each tag is a coarse-grained interest dimension
            * (e.g. "gaming", "camera", "battery") or a brand / tier
            * affinity ("brand:Samsung", "tier:flagship"). Scores
            * decay exponentially with each new event.
            *
            * The list is sorted score-desc by the BE; we keep the top
            * 10 for readability. An empty list means the user has no
            * behaviour events yet. */}
          <section className="admin-card admin-card-wide">
            <h2 className="admin-card-title">Behaviour scores</h2>
            {behaviorError ? (
              <p className="admin-muted">
                Couldn't load behaviour scores ({behaviorError}).
              </p>
            ) : !Array.isArray(behavior) || behavior.length === 0 ? (
              <p className="admin-muted">No behaviour events yet.</p>
            ) : (
              <ul className="admin-tag-list">
                {behavior.slice(0, 10).map((row) => (
                  <li key={row.tag} className="admin-tag-row">
                    <span className="admin-tag-label">{row.tag}</span>
                    <span className="admin-tag-score">
                      {Number(row.score).toFixed(2)}
                    </span>
                    <span className="admin-muted">
                      {formatDate(row.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* LAST RECOMMENDATION */}
          <section className="admin-card">
            <h2 className="admin-card-title">Last recommendation</h2>
            {bundle.lastRecommendation ? (
              <>
                <ul className="admin-info-list">
                  <li>
                    <span className="admin-info-label">Persona:</span>
                    <span className="admin-info-value">
                      {bundle.lastRecommendation.persona || "—"}
                    </span>
                  </li>
                  <li>
                    <span className="admin-info-label">Budget:</span>
                    <span className="admin-info-value">
                      {(() => {
                        // The BE sometimes returns the budget as a
                        // pre-formatted { amount, currency } object
                        // (from the RecommendationCall serializer) and
                        // sometimes as a bare number depending on the
                        // code path. Handle both shapes so we never
                        // surface the literal string "[object Object]".
                        const b = bundle.lastRecommendation.budget;
                        if (b == null) return "—";
                        if (typeof b === "number") return formatNumber(b);
                        if (typeof b === "object") {
                          const amt = b.amount ?? b.value ?? b.max;
                          const cur = b.currency ? ` ${b.currency}` : "";
                          return amt != null ? `${formatNumber(amt)}${cur}` : "—";
                        }
                        return String(b);
                      })()}
                    </span>
                  </li>
                  <li>
                    <span className="admin-info-label">Served at:</span>
                    <span className="admin-info-value">
                      {formatDate(bundle.lastRecommendation.servedAt)}
                    </span>
                  </li>
                </ul>
                {Array.isArray(bundle.lastRecommendation.topResults) &&
                  bundle.lastRecommendation.topResults.length > 0 && (
                    <div className="admin-subsection">
                      <h3 className="admin-subsection-title">Top results</h3>
                      {/* Real phone cards — same shape as the
                        * dashboard's recommended rail. We map each
                        * topResults row to its full phone record
                        * (fetched via getPhoneById above) so we can
                        * show the image, brand and price. While the
                        * enrichment fetch is still in flight we
                        * render a lightweight placeholder card with
                        * the brand · model string from the bundle so
                        * the row doesn't pop in after the rest of
                        * the page. */}
                      <div className="phone-grid admin-top-results-grid">
                        {bundle.lastRecommendation.topResults.map((r, i) => {
                          const phone = topResultPhones[r.phoneId];
                          const label = phone
                            ? `${phone.brand?.name || ""} · ${phone.modelName || ""}`.trim()
                            : r.brand && r.modelName
                              ? `${r.brand} · ${r.modelName}`
                              : r.modelName ||
                                (r.phoneId ? "Unknown phone" : "—");
                          const matchPct =
                            r.score != null
                              ? Math.round(Number(r.score))
                              : r.overallCompatibility != null
                                ? Math.round(Number(r.overallCompatibility))
                                : null;
                          return (
                            <div
                              key={r.phoneId || i}
                              className="phone-card"
                              onClick={() =>
                                r.phoneId &&
                                navigate(`/phones/${r.phoneId}`)
                              }
                              style={{ cursor: "pointer" }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => {
                                if (
                                  (e.key === "Enter" || e.key === " ") &&
                                  r.phoneId
                                ) {
                                  e.preventDefault();
                                  navigate(`/phones/${r.phoneId}`);
                                }
                              }}
                            >
                              <div className="phone-card-top">
                                <div
                                  className={`phone-card-image${phone?.imageUrl ? "" : " no-image"}`}
                                >
                                  {phone?.imageUrl ? (
                                    <img
                                      src={phone.imageUrl}
                                      alt={phone.modelName || label}
                                      onError={(e) => {
                                        e.currentTarget.style.display =
                                          "none";
                                        e.currentTarget.parentElement.classList.add(
                                          "no-image",
                                        );
                                      }}
                                    />
                                  ) : (
                                    <span className="phone-card-emoji">📱</span>
                                  )}
                                  {matchPct != null && (
                                    <span className="phone-card-match-badge">
                                      {matchPct}% match
                                    </span>
                                  )}
                                </div>
                                <div className="phone-card-name">
                                  {phone?.modelName || r.modelName || "—"}
                                </div>
                                <div className="phone-card-tagline">
                                  {phone?.brand?.name ||
                                    r.brand ||
                                    "Unknown brand"}
                                </div>
                              </div>
                              {phone?.pricing?.cheapest != null && (
                                <div className="phone-card-details">
                                  <div className="phone-spec phone-price">
                                    <span>
                                      NPR{" "}
                                      {formatNumber(
                                        phone.pricing.cheapest,
                                      )}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <p className="admin-muted">No recommendations yet.</p>
            )}
          </section>

          {/* RECENT SIGNALS — combined timeline.
            *
            * The backend exposes searches, browses and comparisons as
            * three separate lists (each capped at the last 5). We render
            * each in its own subsection so admins can tell the signal
            * type at a glance. If all three are empty we show a single
            * "No recent activity." line per the feature spec. */}
          <section className="admin-card admin-card-wide">
            {(!bundle.lastSearches || bundle.lastSearches.length === 0) &&
            (!bundle.lastBrowses || bundle.lastBrowses.length === 0) &&
            (!bundle.lastComparisons || bundle.lastComparisons.length === 0) ? (
              <p className="admin-muted">No recent activity.</p>
            ) : (
              <>
                <div className="admin-subsection">
                  <h3 className="admin-subsection-title">Searches</h3>
                  {Array.isArray(bundle.lastSearches) &&
                  bundle.lastSearches.length > 0 ? (
                    <ul className="admin-timeline">
                      {bundle.lastSearches.map((s, i) => (
                        <li key={`s-${i}`}>
                          <span className="admin-timeline-when">
                            {formatDate(s.searchedAt)}
                          </span>
                          <span className="admin-timeline-what">
                            {s.searchQuery || "—"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="admin-muted">No searches yet.</p>
                  )}
                </div>

                <div className="admin-subsection">
                  <h3 className="admin-subsection-title">Browses</h3>
                  {Array.isArray(bundle.lastBrowses) &&
                  bundle.lastBrowses.length > 0 ? (
                    <ul className="admin-timeline">
                      {bundle.lastBrowses.map((b, i) => (
                        <li key={`b-${i}`}>
                          <span className="admin-timeline-when">
                            {formatDate(b.viewedAt)}
                          </span>
                          <span className="admin-timeline-what">
                            <strong>{b.phoneLabel || "—"}</strong>
                            {b.brandName ? (
                              <span className="admin-muted">
                                {" "}
                                ({b.brandName})
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="admin-muted">No browses yet.</p>
                  )}
                </div>

                <div className="admin-subsection">
                  <h3 className="admin-subsection-title">Comparisons</h3>
                  {Array.isArray(bundle.lastComparisons) &&
                  bundle.lastComparisons.length > 0 ? (
                    <ul className="admin-timeline">
                      {bundle.lastComparisons.map((c, i) => {
                        // "Brand Model vs Brand Model"
                        const fmt = (p) =>
                          p && (p.brand || p.modelName)
                            ? `${p.brand ? p.brand + " · " : ""}${p.modelName || ""}`.trim()
                            : p && p.phoneId
                              ? "Unknown phone"
                              : "—";
                        return (
                          <li key={i}>
                            <span className="admin-timeline-when">
                              {formatDate(c.comparedDate)}
                            </span>
                            <span className="admin-timeline-what">
                              <strong>{fmt(c.phoneA)}</strong>
                              <span className="admin-muted"> vs </span>
                              <strong>{fmt(c.phoneB)}</strong>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="admin-muted">No comparisons yet.</p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default AdminCustomerDetail;