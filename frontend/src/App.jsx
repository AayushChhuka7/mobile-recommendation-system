import { useState } from 'react'
import './App.css'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import ToastContainer from './components/Toast'

function App() {
  const [user, setUser] = useState(null)
  const [authPage, setAuthPage] = useState('login')

  const handleLogin = (userData) => {
    setUser(userData)
  }

  const handleLogout = () => {
    setUser(null)
    setAuthPage('login')
  }

  const handleNavigate = (page) => {
    setAuthPage(page)
  }

  return (
    <div className="app">
      {!user ? (
        <Login 
          onLogin={handleLogin} 
          onNavigate={handleNavigate} 
          authPage={authPage}
        />
      ) : (
        <Dashboard user={user} onLogout={handleLogout} />
      )}
      <ToastContainer />
    </div>
  )
}

export default App