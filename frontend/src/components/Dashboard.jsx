import { useState, useEffect } from 'react'
import './Dashboard.css'
import { Bell, Logout } from './Icons'

function Dashboard({ user, onLogout }) {
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 900)
    return () => clearTimeout(timer)
  }, [])

  const stats = [
    { label: 'Total Customers', value: '2,847', badge: '+12% this month', type: 'success' },
    { label: 'Phones Catalogued', value: '384', badge: '12 added', type: 'info' },
    { label: 'Recommendations', value: '18,204', badge: '+8.4%', type: 'success' },
    { label: 'Active Users', value: '143', badge: 'Now online', type: 'info' }
  ]

  const segments = [
    { name: 'Flagship users', pct: 22 },
    { name: 'Mid-range users', pct: 41 },
    { name: 'Budget users', pct: 37 }
  ]

  const camSegs = [
    { name: 'Photography enthusiast', pct: 28 },
    { name: 'Selfie focused', pct: 35 },
    { name: 'Balanced', pct: 37 }
  ]

  const recentActivity = [
    { action: 'New customer registered', user: 'Aarav Sharma', time: '2 min ago', type: 'success' },
    { action: 'XGBoost model retrained', user: 'System', time: '1 hr ago', type: 'info' },
    { action: 'Phone catalog updated', user: 'Hom Raj', time: '3 hrs ago', type: 'info' },
    { action: 'Retailer report exported', user: 'Suresh Khadka', time: '5 hrs ago', type: 'warning' },
    { action: 'Failed login attempt', user: 'unknown@email.com', time: '1 day ago', type: 'error' }
  ]

  const getBadgeClass = (type) => {
    const map = {
      success: 'badge-success',
      info: 'badge-info',
      warning: 'badge-warning',
      error: 'badge-danger'
    }
    return map[type] || 'badge-info'
  }

  const getTagClass = (type) => {
    const map = {
      success: 'tag-green',
      info: 'tag-blue',
      warning: 'tag-amber',
      error: 'tag-red'
    }
    return map[type] || 'tag-blue'
  }

  return (
    <div className="dashboard-container">
      <div className="topbar">
        <div className="topbar-left">
          <span className="topbar-title">Dashboard</span>
        </div>
        <div className="topbar-right">
          <button className="btn-icon" onClick={() => {}}>
            <Bell />
          </button>
          <div className="topbar-user">
            <div className="avatar">{user?.name?.[0] || 'U'}</div>
            <span className="topbar-user-name">{user?.name?.split(' ')[0] || 'User'}</span>
          </div>
          <button className="btn-icon logout-btn" onClick={onLogout}>
            <Logout />
          </button>
        </div>
      </div>

      <div className="page-content">
        <div className="section-header">
          <div className="section-title">Welcome back, {user?.name?.split(' ')[0] || 'User'}!</div>
          <div className="section-sub">Customer Segmentation and Mobile Recommendation System Dashboard</div>
        </div>

        <div className="stats-grid">
          {stats.map((s, i) => (
            <div key={i} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.value}</div>
              <div className={`stat-badge ${getBadgeClass(s.type)}`}>↑ {s.badge}</div>
            </div>
          ))}
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <span className="card-title">Tech Tier Distribution</span>
            </div>
            <div className="card-body">
              {segments.map((s, i) => (
                <div key={i} className="insight-row">
                  <span className="insight-label">{s.name}</span>
                  <div className="insight-bar">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${s.pct}%` }}></div>
                    </div>
                  </div>
                  <span className="insight-val">{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Camera Preference Segments</span>
            </div>
            <div className="card-body">
              {camSegs.map((s, i) => (
                <div key={i} className="insight-row">
                  <span className="insight-label">{s.name}</span>
                  <div className="insight-bar">
                    <div className="progress-bar">
                      <div className="progress-fill success" style={{ width: `${s.pct}%` }}></div>
                    </div>
                  </div>
                  <span className="insight-val">{s.pct}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Recent Activity</span>
          </div>
          <div className="card-body activity-body">
            {recentActivity.map((a, i) => (
              <div key={i} className={`activity-item ${i < recentActivity.length - 1 ? 'bordered' : ''}`}>
                <div>
                  <div className="activity-action">{a.action}</div>
                  <div className="activity-user">{a.user}</div>
                </div>
                <div className="activity-meta">
                  <span className={`tag ${getTagClass(a.type)}`}>{a.type}</span>
                  <span className="activity-time">{a.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default Dashboard