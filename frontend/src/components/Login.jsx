import { useState, useEffect } from 'react'
import './Login.css'

function Login({ onLogin, onNavigate, authPage }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState({})
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState(1)
  const [rememberMe, setRememberMe] = useState(false)
  const [registerData, setRegisterData] = useState({
    name: '',
    email: '',
    password: '',
    confirm: ''
  })
  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [otpError, setOtpError] = useState('')
  const [otpLoading, setOtpLoading] = useState(false)
  const [resendCooldown, setResendCooldown] = useState(0)
  const [sent, setSent] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')

  useEffect(() => {
    const savedEmail = localStorage.getItem('rememberedEmail')
    if (savedEmail) {
      setEmail(savedEmail)
      setRememberMe(true)
    }
  }, [])

  useEffect(() => {
    let timer
    if (resendCooldown > 0) {
      timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000)
    }
    return () => clearTimeout(timer)
  }, [resendCooldown])

  const otpInputs = Array(6).fill(0)

  const validateLogin = () => {
    const e = {}
    if (!email) e.email = 'Email is required'
    else if (!/\S+@\S+\.\S+/.test(email)) e.email = 'Enter a valid email address'
    if (!password) e.password = 'Password is required'
    else if (password.length < 6) e.password = 'Password must be at least 6 characters'
    return e
  }

  const validateRegister = () => {
    const e = {}
    if (!registerData.name) e.name = 'Full name is required'
    if (!registerData.email || !/\S+@\S+\.\S+/.test(registerData.email)) e.email = 'Valid email required'
    if (!registerData.password || registerData.password.length < 6) e.password = 'Minimum 6 characters'
    if (registerData.password !== registerData.confirm) e.confirm = 'Passwords do not match'
    return e
  }

  const handleLoginSubmit = () => {
    const e = validateLogin()
    setErrors(e)
    if (Object.keys(e).length) return

    if (rememberMe) {
      localStorage.setItem('rememberedEmail', email)
    } else {
      localStorage.removeItem('rememberedEmail')
    }

    setLoading(true)
    setTimeout(() => {
      setLoading(false)
      onLogin({
        name: 'User',
        role: 'Customer',
        email: email
      })
    }, 1200)
  }

  const handleRegisterNext = () => {
    const e = validateRegister()
    setErrors(e)
    if (!Object.keys(e).length) {
      setStep(2)
      setResendCooldown(180)
    }
  }

  const handleOtpChange = (index, value) => {
    if (!/^\d?$/.test(value)) return
    const newOtp = [...otp]
    newOtp[index] = value
    setOtp(newOtp)
    setOtpError('')

    if (value && index < 5) {
      const nextInput = document.getElementById(`otp-${index + 1}`)
      if (nextInput) nextInput.focus()
    }
  }

  const handleOtpKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      const prevInput = document.getElementById(`otp-${index - 1}`)
      if (prevInput) prevInput.focus()
    }
  }

  const handleOtpPaste = (e) => {
    e.preventDefault()
    const pastedData = e.clipboardData.getData('text').slice(0, 6)
    if (/^\d{6}$/.test(pastedData)) {
      const digits = pastedData.split('')
      setOtp(digits)
      document.getElementById('otp-5')?.focus()
    }
  }

  const handleOtpVerify = () => {
    const otpString = otp.join('')
    if (otpString.length !== 6) {
      setOtpError('Please enter the full 6-digit code')
      return
    }
    setOtpLoading(true)
    setTimeout(() => {
      setOtpLoading(false)
      onLogin({
        name: registerData.name,
        role: 'Customer',
        email: registerData.email
      })
    }, 1500)
  }

  const handleResendOtp = () => {
    setResendCooldown(180)
    setOtp(['', '', '', '', '', ''])
    setOtpError('')
  }

  const updateRegister = (key, value) => {
    setRegisterData({ ...registerData, [key]: value })
  }

  const MailIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  )

  const LockIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  )

  const EyeIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )

  const EyeOffIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )

  if (authPage === 'register') {
    return (
      <div className="auth-page">
        <div className="auth-card register-card">
          {step === 1 ? (
            <>
              <div className="auth-title">Create an account</div>
              <div className="auth-subtitle">Enter your details to get started</div>

              <div className="step-indicator">
                <div className="step-dot active"></div>
                <div className="step-dot"></div>
              </div>

              <div className="input-group">
                <label className="input-label">Full name</label>
                <input
                  className={`input-field ${errors.name ? 'error' : ''}`}
                  placeholder="Aarav Sharma"
                  value={registerData.name}
                  onChange={(e) => updateRegister('name', e.target.value)}
                />
                {errors.name && <div className="input-error">{errors.name}</div>}
              </div>

              <div className="input-group">
                <label className="input-label">Email address</label>
                <div className="input-with-icon">
                  <span className="input-icon"><MailIcon /></span>
                  <input
                    className={`input-field ${errors.email ? 'error' : ''}`}
                    type="email"
                    placeholder="you@example.com"
                    value={registerData.email}
                    onChange={(e) => updateRegister('email', e.target.value)}
                  />
                </div>
                {errors.email && <div className="input-error">{errors.email}</div>}
              </div>

              <div className="input-group">
                <label className="input-label">Password</label>
                <div className="input-with-icon">
                  <span className="input-icon"><LockIcon /></span>
                  <input
                    className={`input-field ${errors.password ? 'error' : ''}`}
                    type="password"
                    placeholder="Min. 6 characters"
                    value={registerData.password}
                    onChange={(e) => updateRegister('password', e.target.value)}
                  />
                </div>
                {errors.password && <div className="input-error">{errors.password}</div>}
              </div>

              <div className="input-group">
                <label className="input-label">Confirm password</label>
                <div className="input-with-icon">
                  <span className="input-icon"><LockIcon /></span>
                  <input
                    className={`input-field ${errors.confirm ? 'error' : ''}`}
                    type="password"
                    placeholder="Repeat password"
                    value={registerData.confirm}
                    onChange={(e) => updateRegister('confirm', e.target.value)}
                  />
                </div>
                {errors.confirm && <div className="input-error">{errors.confirm}</div>}
              </div>

              <button className="btn btn-primary w-full" onClick={handleRegisterNext}>
                Continue
              </button>
            </>
          ) : (
            <>
              <div className="auth-title">Verify your email</div>
              <div className="auth-subtitle">
                We've sent a 6-digit verification code to <strong>{registerData.email}</strong>
              </div>

              <div className="step-indicator">
                <div className="step-dot active"></div>
                <div className="step-dot active"></div>
              </div>

              <div className="otp-container">
                <div className="otp-inputs" onPaste={handleOtpPaste}>
                  {otpInputs.map((_, index) => (
                    <input
                      key={index}
                      id={`otp-${index}`}
                      className={`otp-input ${otpError ? 'error' : ''}`}
                      type="text"
                      maxLength="1"
                      value={otp[index]}
                      onChange={(e) => handleOtpChange(index, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(index, e)}
                      autoFocus={index === 0}
                    />
                  ))}
                </div>
                {otpError && <div className="otp-error">{otpError}</div>}
              </div>

              <button
                className="btn btn-primary w-full otp-verify-btn"
                onClick={handleOtpVerify}
                disabled={otpLoading}
              >
                {otpLoading ? 'Verifying...' : 'Verify Email'}
              </button>

              <div className="otp-resend">
                <span>Didn't receive the code? </span>
                {resendCooldown > 0 ? (
                  <span className="otp-timer">Resend in {resendCooldown}s</span>
                ) : (
                  <span className="auth-link" onClick={handleResendOtp}>Resend</span>
                )}
              </div>
            </>
          )}

          <div className="auth-footer">
            {step === 1 ? 'Already have an account?' : 'Back to '}
            <span className="auth-link" onClick={() => onNavigate('login')}>
              {step === 1 ? 'Sign in' : 'Sign in'}
            </span>
          </div>
        </div>
      </div>
    )
  }

  if (authPage === 'forgot') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-title">Reset your password</div>
          <div className="auth-subtitle">
            {sent ? 'Check your inbox for a reset link.' : 'Enter your account email and we will send you a reset link.'}
          </div>

          {!sent ? (
            <>
              <div className="input-group">
                <label className="input-label">Email address</label>
                <div className="input-with-icon">
                  <span className="input-icon"><MailIcon /></span>
                  <input
                    className="input-field"
                    type="email"
                    placeholder="you@example.com"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                  />
                </div>
              </div>
              <button
                className="btn btn-primary w-full"
                onClick={() => { setSent(true) }}
              >
                Send reset link
              </button>
            </>
          ) : (
            <div className="forgot-success">
              <div className="success-icon">📧</div>
              <div className="success-text">Email sent</div>
              <div className="success-hint">Did not receive it? Check your spam folder.</div>
            </div>
          )}

          <div className="auth-footer">
            <span className="auth-link" onClick={() => onNavigate('login')}>Back to sign in</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page login-page">
      <div className="login-container">
        <div className="login-left" style={{ backgroundImage: `url(/assets/holdingphone1.jpg)` }}>
          <div className="login-overlay">
            <div className="brand-tagline">
              <h1>Welcome to</h1>
              <h2>Mobile Phone Recommendation System</h2>
              <p>Get mobile phones recommended instantly</p>
            </div>
          </div>
        </div>

        <div className="login-right">
          <div className="login-form-wrapper">
            <div className="auth-title">Sign in to your account</div>
            <div className="auth-subtitle">Welcome back. Enter your credentials to continue.</div>

            <div className="input-group">
              <label className="input-label">Email address</label>
              <div className="input-with-icon">
                <span className="input-icon"><MailIcon /></span>
                <input
                  className={`input-field ${errors.email ? 'error' : ''}`}
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {errors.email && <div className="input-error">{errors.email}</div>}
            </div>

            <div className="input-group">
              <label className="input-label">Password</label>
              <div className="input-with-icon password-field">
                <span className="input-icon"><LockIcon /></span>
                <input
                  className={`input-field ${errors.password ? 'error' : ''}`}
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  className="password-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              {errors.password && <div className="input-error">{errors.password}</div>}
            </div>

            <div className="login-options">
              <label className="remember-me">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                Remember me
              </label>
              <span className="auth-link" onClick={() => onNavigate('forgot')}>Forgot password?</span>
            </div>

            <button
              className="btn btn-primary w-full login-btn"
              onClick={handleLoginSubmit}
              disabled={loading}
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>

            <div className="auth-footer">
              Don't have an account? <span className="auth-link" onClick={() => onNavigate('register')}>Create one</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Login