import { useState, useEffect } from 'react'
import './Toast.css'
import { X, Check, Alert, Info } from './Icons'

let toastCallback = null

export const showToast = (message, type = 'info') => {
  if (toastCallback) {
    toastCallback(message, type)
  }
}

function ToastContainer() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    toastCallback = (message, type) => {
      const id = Date.now()
      setToasts(prev => [...prev, { id, message, type }])
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id))
      }, 3500)
    }
    return () => {
      toastCallback = null
    }
  }, [])

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  const getIcon = (type) => {
    switch (type) {
      case 'success': return <Check />
      case 'error': return <Alert />
      default: return <Info />
    }
  }

  const getColor = (type) => {
    switch (type) {
      case 'success': return 'var(--success)'
      case 'error': return 'var(--danger)'
      default: return 'var(--primary)'
    }
  }

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.type}`}>
          <span style={{ color: getColor(toast.type) }}>
            {getIcon(toast.type)}
          </span>
          <span>{toast.message}</span>
          <button 
            className="toast-close"
            onClick={() => removeToast(toast.id)}
          >
            <X />
          </button>
        </div>
      ))}
    </div>
  )
}

export default ToastContainer