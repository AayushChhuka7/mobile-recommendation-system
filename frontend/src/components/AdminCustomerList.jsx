// AdminCustomerList.jsx — admin-only page that lists every user so an
// admin can pick one and drill into the profile bundle.
//
// Mounted at `/admin/customer-profiles` by App.jsx. Guarded by
// `useAdminGuard`. Client-side search filter (by name or email).

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminGuard } from "../hooks/useAdminGuard.jsx";
import { listAllUsers } from "../services/adminProfiles";
import { SearchIcon, ChevronIcon } from "./AuthShared";
import "./AdminCustomerList.css";

function AdminCustomerList() {
  const navigate = useNavigate();
  const { isAdmin, loading } = useAdminGuard();

  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [fetching, setFetching] = useState(true);
  const [query, setQuery] = useState("");

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
    if (!q) return users;
    return users.filter((u) => {
      const name = (u.name || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [users, query]);

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
        <button
          type="button"
          className="admin-back-btn"
          onClick={() => navigate("/dashboard")}
          aria-label="Back to dashboard"
        >
          <ChevronIcon /> <span>Back to dashboard</span>
        </button>
        <div>
          <h1 className="admin-list-title">Customer profiles</h1>
          <p className="admin-list-sub">
            Admin view · {users.length} {users.length === 1 ? "user" : "users"}
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
            : "No customers match your search."}
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