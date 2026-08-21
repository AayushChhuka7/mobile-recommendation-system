// AdminCustomerList.jsx — admin-only page that lists every user so an
// admin can pick one and drill into the profile bundle.
//
// Mounted at `/admin/customer-profiles` by App.jsx. Guarded by
// `useAdminGuard`. Client-side search filter (by name or email).

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminGuard } from "../hooks/useAdminGuard.jsx";
import { useAuth } from "../hooks/useAuth.jsx";
import { listAllUsers } from "../services/adminProfiles";
import {
  SearchIcon,
  ChevronIcon,
  FilterIcon,
  CloseIcon,
  LogoutIcon,
} from "./AuthShared";
import "./AdminCustomerList.css";

const ROLE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "customer", label: "Customer" },
  { value: "admin", label: "Admin" },
  { value: "salesman", label: "Salesman" },
];

const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

const SORT_OPTIONS = [
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
];

function AdminCustomerList() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAdminGuard();
  const { logout } = useAuth();

  // Sign-out clears the auth record (localStorage + context) and
  // pushes the user back to /login. Using `replace: true` keeps the
  // admin-list out of the back-stack so the browser back button can't
  // drop them right back onto the listing after they sign out.
  const handleSignOut = useCallback(() => {
    logout();
    navigate("/login", { replace: true });
  }, [logout, navigate]);

  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [fetching, setFetching] = useState(true);
  const [query, setQuery] = useState("");
  // Filter state — role, status, and sort. All default to "no
  // narrowing" so the page looks identical to the prior behaviour
  // until the admin opens the filter dropdown and changes a control.
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("name_asc");
  const [showFilters, setShowFilters] = useState(false);
  const filterRef = useRef(null);

  useEffect(() => {
    if (!isAdmin) return; // guard will redirect; skip fetch
    let ignore = false;
    (async () => {
      setFetching(true);
      setError("");
      try {
        const list = await listAllUsers();
        if (!ignore) setUsers(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!ignore) {
          const code = err?.response?.data?.code || err?.response?.status;
          setError(
            code === "AUTH_FORBIDDEN_ROLE"
              ? "You don't have permission to view this page."
              : err?.response?.data?.message ||
                  err?.message ||
                  "Failed to load customers."
          );
        }
      } finally {
        if (!ignore) setFetching(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [isAdmin]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const roleLower = roleFilter === "all" ? null : roleFilter.toLowerCase();
    const wantedActive =
      statusFilter === "all" ? null : statusFilter === "active";
    let out = users.filter((u) => {
      if (q) {
        const name = (u.name || "").toLowerCase();
        const email = (u.email || "").toLowerCase();
        if (!name.includes(q) && !email.includes(q)) return false;
      }
      if (roleLower) {
        const userRole = (u.role || "").toLowerCase();
        if (userRole !== roleLower) return false;
      }
      if (wantedActive !== null) {
        if (Boolean(u.isActive) !== wantedActive) return false;
      }
      return true;
    });
    // Sort — only by name for now. Comparator is stable so equal
    // names preserve their original list order.
    const dir = sortBy === "name_desc" ? -1 : 1;
    out = out.slice().sort((a, b) => {
      const an = (a.name || "").toLowerCase();
      const bn = (b.name || "").toLowerCase();
      if (an < bn) return -1 * dir;
      if (an > bn) return 1 * dir;
      return 0;
    });
    return out;
  }, [users, query, roleFilter, statusFilter, sortBy]);

  // Close the filter popover on outside click — same pattern the
  // Dashboard search bar / filter button uses.
  useEffect(() => {
    if (!showFilters) return undefined;
    function handleOutside(e) {
      if (filterRef.current && !filterRef.current.contains(e.target)) {
        setShowFilters(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showFilters]);

  const resetFilters = useCallback(() => {
    setRoleFilter("all");
    setStatusFilter("all");
    setSortBy("name_asc");
  }, []);

  const activeFilterCount =
    (roleFilter !== "all" ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (sortBy !== "name_asc" ? 1 : 0);

  if (loading || !isAdmin) {
    return (
      <div className="admin-list-page">
        <div className="admin-list-splash">Checking access…</div>
      </div>
    );
  }

  return (
    <div className="admin-list-page">
      <header className="admin-list-header">
        <div>
          <h1 className="admin-list-title">Customer profiles</h1>
          <p className="admin-list-sub">
            Total users = {users.length}
          </p>
        </div>
      </header>

      <div className="admin-list-toolbar">
        <div className="admin-list-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search by name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search customers"
          />
        </div>

        <div className="admin-list-filter-wrap" ref={filterRef}>
          <button
            type="button"
            className={`btn btn-outline admin-list-filter-btn ${showFilters ? "active" : ""}`}
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
            aria-haspopup="dialog"
            title="Filter and sort"
          >
            <FilterIcon />
            <span>Filter</span>
            {activeFilterCount > 0 && (
              <span className="admin-list-filter-badge">
                {activeFilterCount}
              </span>
            )}
          </button>

          {showFilters && (
            <div
              className="admin-list-filter-popover"
              role="dialog"
              aria-label="Filter and sort customers"
            >
              <div className="admin-list-filter-header">
                <h3>Filter &amp; sort</h3>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setShowFilters(false)}
                  aria-label="Close filters"
                >
                  <CloseIcon />
                </button>
              </div>

              <div className="admin-list-filter-body">
                <div className="admin-list-filter-group">
                  <label className="admin-list-filter-label">Sort by name</label>
                  <select
                    className="admin-list-filter-select"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    aria-label="Sort by name"
                  >
                    {SORT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="admin-list-filter-group">
                  <label className="admin-list-filter-label">Role</label>
                  <select
                    className="admin-list-filter-select"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value)}
                    aria-label="Filter by role"
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="admin-list-filter-group">
                  <label className="admin-list-filter-label">Status</label>
                  <select
                    className="admin-list-filter-select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    aria-label="Filter by status"
                  >
                    {STATUS_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="admin-list-filter-footer">
                <button
                  type="button"
                  className="btn btn-outline w-full"
                  onClick={resetFilters}
                >
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="admin-list-signout-btn"
          onClick={handleSignOut}
          title="Sign out"
          aria-label="Sign out"
        >
          <LogoutIcon />
          <span>Sign out</span>
        </button>
      </div>

      {fetching && <div className="admin-list-splash">Loading customers…</div>}

      {error && !fetching && (
        <div className="admin-list-error" role="alert">
          {error}
        </div>
      )}

      {!fetching && !error && filtered.length === 0 && (
        <div className="admin-list-empty">
          {users.length === 0
            ? "No customers in the system yet."
            : "No customers match your search or filters."}
        </div>
      )}

      {!fetching && !error && filtered.length > 0 && (
        <div className="admin-list-table-wrap">
          <table className="admin-list-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.userId}>
                  <td>{u.name || "—"}</td>
                  <td>{u.email || "—"}</td>
                  <td>
                    <span className={`admin-role-pill admin-role-${(u.role || "none").toLowerCase()}`}>
                      {u.role || "—"}
                    </span>
                  </td>
                  <td>
                    <span className={`admin-status-pill ${u.isActive ? "active" : "inactive"}`}>
                      {u.isActive ? "Active" : "Inactive"}
                    </span>
                    {!u.isVerified && (
                      <span className="admin-status-pill unverified">
                        Unverified
                      </span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-outline btn-small"
                      onClick={() =>
                        navigate(
                          `/admin/customer-profiles/${encodeURIComponent(u.userId)}`,
                        )
                      }
                    >
                      View profile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default AdminCustomerList;