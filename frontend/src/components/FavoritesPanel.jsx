import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { CloseIcon, CameraIcon, BatteryIcon } from "./AuthShared";
import { formatPriceNpr } from "../utils/formatPrice.js";
import "./FavoritesPanel.css";

const FAVORITES_PER_PAGE = 12;

// Heart icon — same shape used by the dashboard's browse + rec cards so
// the popup feels visually consistent with the rest of the surface.
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

// One favourite card — mirrors the "Browse other phones" card structure
// (`.phone-card-hero` / `.phone-card-image` / `.phone-card-body`) so the
// popup blends into the dashboard chrome without bespoke styling.
function FavoriteCard({ phone, onRemove, onOpen }) {
  const handleCardClick = () => {
    if (phone?.id) onOpen(phone.id);
  };
  const handleCardKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCardClick();
    }
  };
  const handleRemove = (e) => {
    e.stopPropagation();
    onRemove(phone.id);
  };
  return (
    <div
      key={phone.id}
      className="phone-card"
      role="button"
      tabIndex={0}
      aria-label={`View ${phone.modelName || "phone"} details`}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <div className="phone-card-hero">
        <div className="phone-card-image">
          {phone.imageUrl ? (
            <img
              src={phone.imageUrl}
              alt={phone.modelName}
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
          onClick={handleRemove}
          aria-label={`Remove ${phone.modelName || "phone"} from favourites`}
          aria-pressed="true"
          title="Remove from favourites"
        >
          <HeartIcon filled />
        </button>
      </div>

      <div className="phone-card-body">
        <div className="phone-card-tags">
          {(phone.brand?.name || "Unknown").slice(0, 3).toUpperCase()}
          {phone.keySpecs?.os && (
            <span className="phone-card-tag">{phone.keySpecs.os}</span>
          )}
        </div>
        <div className="phone-card-name">{phone.modelName}</div>

        <div className="phone-card-details">
          {phone.keySpecs?.camera && (
            <div className="phone-spec">
              <CameraIcon />
              <span>{phone.keySpecs.camera}</span>
            </div>
          )}
          {phone.keySpecs?.battery && (
            <div className="phone-spec">
              <BatteryIcon />
              <span>{phone.keySpecs.battery} mAh</span>
            </div>
          )}
        </div>

        <div className="phone-card-footer">
          {phone.cheapestVariant?.price && (
            <div className="phone-price">
              <span className="phone-price-label">Price</span>
              <span className="phone-price-value">
                {formatPriceNpr(phone.cheapestVariant.price) ?? "—"}
                {phone.cheapestVariant.ram && phone.cheapestVariant.storage
                  ? ` · ${phone.cheapestVariant.ram}/${phone.cheapestVariant.storage}GB`
                  : ""}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Pagination control — mirrors the dashboard's existing pagination block
// (First / Prev / numbered pages / Next / Last). Re-uses the shared
// `.pagination`, `.btn`, and `.btn-primary` styles from Dashboard.css.
function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const start = totalPages <= 5 ? 1 : Math.max(1, Math.min(totalPages - 4, page - 2));
  const pageNumbers = Array.from(
    { length: Math.min(5, totalPages) },
    (_, i) => start + i,
  );
  return (
    <div className="pagination" aria-label="Favourites pagination">
      <button
        type="button"
        className="btn btn-outline"
        disabled={page <= 1}
        onClick={() => onChange(1)}
      >
        « First
      </button>
      <button
        type="button"
        className="btn btn-outline"
        disabled={page <= 1}
        onClick={() => onChange((p) => Math.max(1, p - 1))}
      >
        ‹ Prev
      </button>
      {pageNumbers.map((num) => (
        <button
          key={num}
          type="button"
          className={`btn ${page === num ? "btn-primary" : "btn-outline"}`}
          onClick={() => onChange(num)}
          aria-current={page === num ? "page" : undefined}
        >
          {num}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-outline"
        disabled={page >= totalPages}
        onClick={() => onChange((p) => Math.min(totalPages, p + 1))}
      >
        Next ›
      </button>
      <button
        type="button"
        className="btn btn-outline"
        disabled={page >= totalPages}
        onClick={() => onChange(totalPages)}
      >
        Last »
      </button>
    </div>
  );
}

function FavoritesPanel({ open, onClose, favorites, onRemoveFavorite }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);

  // Reset to page 1 when the panel closes so a future reopen starts at
  // the top. Done during render (not in an effect) — if the prop tells
  // us we're closing, the next render already represents the closed
  // state, so resetting here is a safe atomic transition.
  if (!open && page !== 1) {
    setPage(1);
  }

  // Derive the favourites list and clamp `page` to a valid range so the
  // rendered grid is always consistent with the source data. Slicing
  // uses `safePage` rather than `page`, so a stale page number after a
  // remove-from-favourites won't strand the user on an empty page.
  const orderedFavorites = useMemo(
    () =>
      Object.values(favorites || {}).filter(
        (p) => p && typeof p === "object" && p.id,
      ),
    [favorites],
  );
  const total = orderedFavorites.length;
  const totalPages = Math.max(1, Math.ceil(total / FAVORITES_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const goToPage = useCallback(
    (next) => {
      setPage(
        typeof next === "function"
          ? (p) => Math.min(Math.max(1, next(p)), totalPages)
          : Math.min(Math.max(1, next), totalPages),
      );
    },
    [totalPages],
  );

  const handleOpen = useCallback(
    (phoneId) => {
      if (phoneId) navigate(`/phones/${phoneId}`);
    },
    [navigate],
  );

  const pageItems = orderedFavorites.slice(
    (safePage - 1) * FAVORITES_PER_PAGE,
    safePage * FAVORITES_PER_PAGE,
  );

  return (
    <aside
      className={`fav-panel ${open ? "open" : ""}`}
      aria-label="Your favourites"
      aria-hidden={!open}
    >
      <div className="fav-panel-header">
        <div>
          <div className="fav-panel-title">Your favourites</div>
          <div className="fav-panel-sub">
            {total > 0
              ? `${total} phone${total === 1 ? "" : "s"} saved`
              : "Phones you heart will appear here"}
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          aria-label="Close favourites panel"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="fav-panel-body">
        {total === 0 ? (
          <div className="fav-empty">
            <span className="fav-empty-icon" aria-hidden="true">
              ♥
            </span>
            <p className="fav-empty-title">No favourites yet</p>
            <p className="fav-empty-sub">
              Tap the heart on any phone card to save it here for later.
            </p>
          </div>
        ) : (
          <>
            <div className="phone-grid fav-grid">
              {pageItems.map((p) => (
                <FavoriteCard
                  key={p.id}
                  phone={p}
                  onRemove={onRemoveFavorite}
                  onOpen={handleOpen}
                />
              ))}
            </div>
            <Pagination
              page={safePage}
              totalPages={totalPages}
              onChange={goToPage}
            />
          </>
        )}
      </div>
    </aside>
  );
}

export default FavoritesPanel;