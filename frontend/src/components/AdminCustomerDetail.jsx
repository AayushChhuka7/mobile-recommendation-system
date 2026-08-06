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
import { formatPriceNpr } from "../utils/formatPrice.js";
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

// All budget fields on the customer profile come back from the BE in
// EUR. The rest of the app renders them as NPR (×175, snap to 0/5), so
// the admin view should match — keeps the surface consistent for the
// person comparing a customer's preferred budget against the catalog.
function formatBudgetEurAsNpr(value) {
  return formatPriceNpr(value) ?? "—";
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
        <button
          type="button"
          className="admin-back-btn"
          onClick={() => navigate("/admin/customer-profiles")}
          aria-label="Back to customer list"
        >
          <ChevronIcon /> <span>Back to list</span>
        </button>
        <div>
          <h1 className="admin-detail-title">
            {bundle?.user?.name || "Customer profile"}
          </h1>
          <p className="admin-detail-sub">
            {bundle?.user?.email || userId}
          </p>
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
          {/* USER */}
          <section className="admin-card">
            <h2 className="admin-card-title">User</h2>
            <dl className="admin-dl">
              <dt>Name</dt>
              <dd>{bundle.user?.name || "—"}</dd>
              <dt>Email</dt>
              <dd>{bundle.user?.email || "—"}</dd>
              <dt>Phone</dt>
              <dd>{bundle.user?.phoneNo || "—"}</dd>
              <dt>Role</dt>
              <dd>{bundle.user?.role || "—"}</dd>
              <dt>Active</dt>
              <dd>{bundle.user?.isActive ? "Yes" : "No"}</dd>
              <dt>Verified</dt>
              <dd>{bundle.user?.isVerified ? "Yes" : "No"}</dd>
            </dl>
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
            <dl className="admin-dl">
              <dt>Preferred brand</dt>
              <dd>
                {bundle.preference?.preferredBrands || (
                  <span className="admin-muted">Not specified</span>
                )}
              </dd>
              <dt>Budget</dt>
              <dd>
                {formatBudgetEurAsNpr(bundle.preference?.maxBudget)}
                {bundle.customerProfile?.avgBudget ? (
                  <span className="admin-muted">
                    {" "}
                    · avg {formatBudgetEurAsNpr(bundle.customerProfile.avgBudget)}
                  </span>
                ) : null}
              </dd>
              {/* Storage / RAM are derived from the user's modal
                * recommendation rows by profileAggregator. Until the
                * user has triggered at least MIN_NEW_ROWS=5
                * recommendations the values stay null and we surface
                * a "Not tracked yet" hint rather than a bare "—". */}
              <dt>Storage</dt>
              <dd>
                {bundle.customerProfile?.preferredStorageGb != null
                  ? `${formatNumber(bundle.customerProfile.preferredStorageGb)} GB`
                  : <span className="admin-muted">Not tracked yet</span>}
              </dd>
              <dt>RAM</dt>
              <dd>
                {bundle.customerProfile?.preferredRamGb != null
                  ? `${formatNumber(bundle.customerProfile.preferredRamGb)} GB`
                  : <span className="admin-muted">Not tracked yet</span>}
              </dd>
              <dt>Battery</dt>
              <dd>
                <span className="admin-muted">Not tracked yet</span>
              </dd>
              <dt>Camera</dt>
              <dd>{bundle.preference?.cameraPreference || "—"}</dd>
              <dt>Usage type</dt>
              <dd>{bundle.preference?.usageType || "—"}</dd>
            </dl>
          </section>

          {/* CUSTOMER PROFILE */}
          <section className="admin-card">
            <h2 className="admin-card-title">Customer profile</h2>
            <dl className="admin-dl">
              <dt>Budget segment</dt>
              <dd>{bundle.customerProfile?.budgetSegment || "—"}</dd>
              <dt>Tech tier</dt>
              <dd>{bundle.customerProfile?.techTier || "—"}</dd>
              <dt>Recommendation persona</dt>
              <dd>{bundle.customerProfile?.recommendationPersona || "—"}</dd>
              <dt>Avg budget</dt>
              <dd>{formatBudgetEurAsNpr(bundle.customerProfile?.avgBudget)}</dd>
              <dt>Searches</dt>
              <dd>{formatNumber(bundle.customerProfile?.searchCount)}</dd>
              <dt>Recommendations</dt>
              <dd>
                {formatNumber(bundle.customerProfile?.totalRecommendations)}
              </dd>
              <dt>Comparisons</dt>
              <dd>{formatNumber(bundle.customerProfile?.totalComparisons)}</dd>
              <dt>Segment confidence</dt>
              <dd>{bundle.customerProfile?.segmentConfidence || "—"}</dd>
              <dt>Last updated</dt>
              <dd>{formatDate(bundle.customerProfile?.lastUpdated)}</dd>
            </dl>
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
                <dl className="admin-dl">
                  <dt>Persona</dt>
                  <dd>{bundle.lastRecommendation.persona || "—"}</dd>
                  <dt>Budget</dt>
                  <dd>{formatBudgetEurAsNpr(bundle.lastRecommendation.budget)}</dd>
                  <dt>Served at</dt>
                  <dd>{formatDate(bundle.lastRecommendation.servedAt)}</dd>
                </dl>
                {Array.isArray(bundle.lastRecommendation.topResults) &&
                  bundle.lastRecommendation.topResults.length > 0 && (
                    <div className="admin-subsection">
                      <h3 className="admin-subsection-title">Top results</h3>
                      <ul className="admin-list-clean">
                        {bundle.lastRecommendation.topResults.map((r, i) => {
                          // Resolve phoneId → "Brand · Model" — the
                          // backend already joins Phones on the
                          // per-call RecommendationCall row so we
                          // just render what we get. If the phone was
                          // deleted between serving and reading we
                          // fall back to "Unknown phone" so the admin
                          // still sees *that* something was served.
                          const label =
                            r.brand && r.modelName
                              ? `${r.brand} · ${r.modelName}`
                              : r.modelName ||
                                (r.phoneId ? "Unknown phone" : "—");
                          return (
                            <li key={r.phoneId || i}>
                              <span className="admin-timeline-what">
                                <strong>{label}</strong>
                                {r.score != null ? (
                                  <span className="admin-muted">
                                    {" "}
                                    · {Math.round(Number(r.score))}% match
                                  </span>
                                ) : null}
                              </span>
                              <span className="admin-muted">
                                {formatDate(r.servedAt || bundle.lastRecommendation.servedAt)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
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
            <h2 className="admin-card-title">Recent signals</h2>

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
                  <p className="admin-muted admin-subsection-hint">
                    Each row is a phone-detail view. We keep at most
                    the last 10 unique phones the customer touched —
                    re-clicking an already-tracked phone is a no-op and
                    does not bump any score. The label is the raw
                    phone name as it appears on the catalog; we
                    intentionally don't FK-resolve here because the
                    original browse signal can be a fictional or
                    pre-release phone.
                  </p>
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