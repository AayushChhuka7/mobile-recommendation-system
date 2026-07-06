import { useState, useEffect, useCallback } from "react";
import api from "../services/api";
import "./Login.css";
import holdingPhone from "../assets/holdingphone2.jpg";

const EMAIL_REGEX = /\S+@\S+\.\S+/;
const OTP_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 60;
const EMPTY_OTP = Array(OTP_LENGTH).fill("");
const OTP_INDEXES = Array.from({ length: OTP_LENGTH }, (_, i) => i);
const TOAST_DURATION_MS = 3000; // how long the top toast stays visible
const NEPAL_CITIES = [
  "Kathmandu",
  "Lalitpur",
  "Bhaktapur",
  "Dharan",
  "Biratnagar",
  "Birgunj",
  "Pokhara",
  "Dhangadi",
];
const USAGE_OPTIONS = [
  { value: "everyday", label: "Everyday use" },
  { value: "gaming", label: "Gaming" },
  { value: "photography", label: "Photography" },
  { value: "business", label: "Business" },
];

// --- Icons: moved out of the component so they aren't redefined on every render ---
const MailIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

const LockIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const EyeIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

const UserIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const PhoneIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

// --- Shared field component: removes the label/icon/input/error duplication ---
function TextField({ label, icon, error, className = "", ...inputProps }) {
  return (
    <div className="input-group">
      <label className="input-label">{label}</label>
      {icon ? (
        <div className="input-with-icon">
          <span className="input-icon">{icon}</span>
          <input
            className={`input-field ${error ? "error" : ""} ${className}`}
            {...inputProps}
          />
        </div>
      ) : (
        <input
          className={`input-field ${error ? "error" : ""} ${className}`}
          {...inputProps}
        />
      )}
      {error && <div className="input-error">{error}</div>}
    </div>
  );
}

function OtpInputRow({ idPrefix, otp, error, onChange, onKeyDown, onPaste }) {
  return (
    <div className="otp-container">
      <div className="otp-inputs" onPaste={onPaste}>
        {OTP_INDEXES.map((index) => (
          <input
            key={index}
            id={`${idPrefix}-${index}`}
            className={`otp-input ${error ? "error" : ""}`}
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={1}
            value={otp[index]}
            onChange={(e) => onChange(index, e.target.value)}
            onKeyDown={(e) => onKeyDown(index, e)}
            autoFocus={index === 0}
            aria-label={`Digit ${index + 1} of verification code`}
          />
        ))}
      </div>
      {error && <div className="otp-error">{error}</div>}
    </div>
  );
}

function Toast({ status, message, onDone }) {
  useEffect(() => {
    if (!message) return undefined;
    const timer = setTimeout(() => {
      onDone?.();
    }, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message, onDone]);

  if (!message) return null;

  const isSuccess = status === "success";

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 18px",
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 500,
        color: "#fff",
        backgroundColor: isSuccess ? "#16a34a" : "#dc2626",
        boxShadow: "0 6px 16px rgba(0,0,0,0.18)",
        maxWidth: "90vw",
      }}
    >
      <span aria-hidden="true">{isSuccess ? "✓" : "!"}</span>
      <span>{message}</span>
    </div>
  );
}

function Login({ onLogin, onNavigate, authPage }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleName, setRoleName] = useState("Customer");
  const [showPassword, setShowPassword] = useState(false);
  const [loginErrors, setLoginErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const [step, setStep] = useState(1);
  const [registerData, setRegisterData] = useState({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
  });
  const [registerRole, setRegisterRole] = useState("Customer");
  const [questionnaire, setQuestionnaire] = useState({
    location: "",
    budget: "",
    usage: [],
  });
  const [registerErrors, setRegisterErrors] = useState({});

  const [otp, setOtp] = useState(EMPTY_OTP);
  const [otpError, setOtpError] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [otpResult, setOtpResult] = useState(null);

  const [forgotStep, setForgotStep] = useState(1);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotEmailError, setForgotEmailError] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotOtp, setForgotOtp] = useState(EMPTY_OTP);
  const [forgotOtpError, setForgotOtpError] = useState("");
  const [forgotOtpLoading, setForgotOtpLoading] = useState(false);
  const [forgotResendCooldown, setForgotResendCooldown] = useState(0);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [newPasswordErrors, setNewPasswordErrors] = useState({});
  const [resetLoading, setResetLoading] = useState(false);
  const [resetResult, setResetResult] = useState(null);
  useEffect(() => {
    const savedEmail = localStorage.getItem("rememberedEmail");
    if (savedEmail) {
      setEmail(savedEmail);
      setRememberMe(true);
    }
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (forgotResendCooldown <= 0) return;
    const timer = setTimeout(() => setForgotResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [forgotResendCooldown]);

  useEffect(() => {
    setLoginErrors({});
    setRegisterErrors({});
    setOtpError("");
    setOtpResult(null);
    setForgotStep(1);
    setForgotEmail("");
    setForgotEmailError("");
    setForgotOtp(EMPTY_OTP);
    setForgotOtpError("");
    setNewPassword("");
    setConfirmNewPassword("");
    setNewPasswordErrors({});
    setResetResult(null);
  }, [authPage]);

  const validateLogin = useCallback(() => {
    const e = {};
    if (!email) e.email = "Email is required";
    else if (!EMAIL_REGEX.test(email)) e.email = "Enter a valid email address";
    if (!password) e.password = "Password is required";
    else if (password.length < 6)
      e.password = "Password must be at least 6 characters";
    return e;
  }, [email, password]);

  const validateRegister = useCallback(() => {
    const e = {};
    if (!registerData.username) e.username = "Username is required";
    if (!registerData.email || !EMAIL_REGEX.test(registerData.email))
      e.email = "Valid email required";
    if (!registerData.password || registerData.password.length < 6)
      e.password = "Minimum 6 characters";
    if (registerData.confirmPassword !== registerData.password)
      e.confirmPassword = "Passwords do not match";
    if (registerData.phone && !/^\+?[0-9\s-]{7,15}$/.test(registerData.phone))
      e.phone = "Enter a valid phone number";
    return e;
  }, [registerData]);

  const handleLoginSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      const validationErrors = validateLogin();
      setLoginErrors(validationErrors);
      if (Object.keys(validationErrors).length) return;

      if (rememberMe) {
        localStorage.setItem("rememberedEmail", email);
      } else {
        localStorage.removeItem("rememberedEmail");
      }

      setLoading(true);
      try {
        const response = await api.post("/auth/login", {
          email,
          password,
          roleName,
        });
        onLogin(response.data);
      } catch (error) {
        console.error(error);
        alert(error.response?.data?.message || "Login failed");
      } finally {
        setLoading(false);
      }
    },
    [email, password, roleName, rememberMe, validateLogin, onLogin],
  );

  const handleRegisterNext = useCallback(
    (e) => {
      e?.preventDefault();
      const validationErrors = validateRegister();
      setRegisterErrors(validationErrors);
      if (!Object.keys(validationErrors).length) {
        setStep(2);
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
      }
    },
    [validateRegister],
  );

  const handleOtpChange = useCallback((index, value) => {
    if (!/^\d?$/.test(value)) return;
    setOtp((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setOtpError("");

    if (value && index < OTP_LENGTH - 1) {
      document.getElementById(`otp-${index + 1}`)?.focus();
    }
  }, []);

  const handleOtpKeyDown = useCallback((index, e) => {
    if (e.key === "Backspace" && !e.target.value && index > 0) {
      document.getElementById(`otp-${index - 1}`)?.focus();
    }
  }, []);

  const handleOtpPaste = useCallback((e) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, OTP_LENGTH);
    if (new RegExp(`^\\d{${OTP_LENGTH}}$`).test(pastedData)) {
      setOtp(pastedData.split(""));
      document.getElementById(`otp-${OTP_LENGTH - 1}`)?.focus();
    }
  }, []);

  const completeRegistration = useCallback(() => {
    onLogin({
      name: registerData.username,
      role: registerRole,
      email: registerData.email,
    });
  }, [registerData, registerRole, onLogin]);

  const handleOtpVerify = useCallback(
    (e) => {
      e?.preventDefault();
      const otpString = otp.join("");
      if (otpString.length !== OTP_LENGTH) {
        setOtpError("Please enter the full 6-digit code");
        return;
      }
      setOtpLoading(true);
      setOtpError("");

      setTimeout(() => {
        setOtpLoading(false);
        const verified = true;

        if (verified) {
          setOtpResult({
            status: "success",
            message: "Registration successful!!",
          });

          setTimeout(completeRegistration, TOAST_DURATION_MS);
        } else {
          setOtpResult({
            status: "error",
            message: "We couldn't verify that code. Please try again.",
          });
        }
      }, 1500);
    },
    [otp, completeRegistration],
  );

  const handleResendOtp = useCallback(() => {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    setOtp(EMPTY_OTP);
    setOtpError("");
    setOtpResult(null);
  }, []);

  const handleOtpBack = useCallback(() => {
    setOtp(EMPTY_OTP);
    setOtpError("");
    setOtpResult(null);
    setStep(1);
  }, []);

  const updateRegister = useCallback((key, value) => {
    setRegisterData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const updateQuestionnaire = useCallback((key, value) => {
    setQuestionnaire((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleUsage = useCallback((value) => {
    setQuestionnaire((prev) => {
      const has = prev.usage.includes(value);
      return {
        ...prev,
        usage: has
          ? prev.usage.filter((v) => v !== value)
          : [...prev.usage, value],
      };
    });
  }, []);

  const handleForgotEmailSubmit = useCallback(
    (e) => {
      e?.preventDefault();
      if (!forgotEmail || !EMAIL_REGEX.test(forgotEmail)) {
        setForgotEmailError("Enter a valid email address");
        return;
      }
      setForgotEmailError("");
      setForgotLoading(true);

      setTimeout(() => {
        setForgotLoading(false);
        setForgotStep(2);
        setForgotResendCooldown(RESEND_COOLDOWN_SECONDS);
      }, 1000);
    },
    [forgotEmail],
  );

  const handleForgotOtpChange = useCallback((index, value) => {
    if (!/^\d?$/.test(value)) return;
    setForgotOtp((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setForgotOtpError("");

    if (value && index < OTP_LENGTH - 1) {
      document.getElementById(`forgot-otp-${index + 1}`)?.focus();
    }
  }, []);

  const handleForgotOtpKeyDown = useCallback((index, e) => {
    if (e.key === "Backspace" && !e.target.value && index > 0) {
      document.getElementById(`forgot-otp-${index - 1}`)?.focus();
    }
  }, []);

  const handleForgotOtpPaste = useCallback((e) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, OTP_LENGTH);
    if (new RegExp(`^\\d{${OTP_LENGTH}}$`).test(pastedData)) {
      setForgotOtp(pastedData.split(""));
      document.getElementById(`forgot-otp-${OTP_LENGTH - 1}`)?.focus();
    }
  }, []);

  const handleForgotOtpVerify = useCallback(
    (e) => {
      e?.preventDefault();
      const otpString = forgotOtp.join("");
      if (otpString.length !== OTP_LENGTH) {
        setForgotOtpError("Please enter the full 6-digit code");
        return;
      }
      setForgotOtpLoading(true);
      // NOTE: replace with a real verify-otp API call when ready.
      setTimeout(() => {
        setForgotOtpLoading(false);
        setForgotStep(3);
      }, 1000);
    },
    [forgotOtp],
  );

  const handleForgotResendOtp = useCallback(() => {
    setForgotResendCooldown(RESEND_COOLDOWN_SECONDS);
    setForgotOtp(EMPTY_OTP);
    setForgotOtpError("");
  }, []);

  const handleForgotOtpBack = useCallback(() => {
    setForgotOtp(EMPTY_OTP);
    setForgotOtpError("");
    setForgotStep(1);
  }, []);

  const handleNewPasswordBack = useCallback(() => {
    setNewPasswordErrors({});
    setResetResult(null);
    setForgotStep(2);
  }, []);

  const validateNewPassword = useCallback(() => {
    const e = {};
    if (!newPassword || newPassword.length < 6)
      e.newPassword = "Minimum 6 characters";
    if (confirmNewPassword !== newPassword)
      e.confirmNewPassword = "Passwords do not match";
    return e;
  }, [newPassword, confirmNewPassword]);

  const goToLoginAfterReset = useCallback(() => {
    onNavigate("login");
  }, [onNavigate]);

  const handleResetPasswordSubmit = useCallback(
    (e) => {
      e?.preventDefault();
      const validationErrors = validateNewPassword();
      setNewPasswordErrors(validationErrors);
      if (Object.keys(validationErrors).length) return;

      setResetLoading(true);

      setTimeout(() => {
        setResetLoading(false);
        const changed = true;

        if (changed) {
          setResetResult({
            status: "success",
            message: "Password changed successfully!",
          });
          setTimeout(goToLoginAfterReset, TOAST_DURATION_MS);
        } else {
          setResetResult({
            status: "error",
            message: "Something went wrong. Please try again.",
          });
        }
      }, 1000);
    },
    [validateNewPassword, goToLoginAfterReset],
  );

  if (authPage === "register") {
    return (
      <div className="auth-page">
        <Toast
          status={otpResult?.status}
          message={otpResult?.status === "success" ? otpResult.message : null}
          onDone={completeRegistration}
        />
        <div className="auth-card register-card">
          {step === 1 ? (
            <form onSubmit={handleRegisterNext}>
              <button
                type="button"
                className="back-btn"
                onClick={() => onNavigate("login")}
                aria-label="Back to sign in"
              >
                <ChevronLeftIcon />
              </button>

              <div className="auth-title">Register Now</div>
              <div className="auth-subtitle">
                Create an account to get started
              </div>

              <TextField
                label="Username"
                icon={<UserIcon />}
                placeholder="Enter your username"
                name="username"
                autoComplete="username"
                value={registerData.username}
                onChange={(e) => updateRegister("username", e.target.value)}
                error={registerErrors.username}
              />

              <TextField
                label="Email address"
                icon={<MailIcon />}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={registerData.email}
                onChange={(e) => updateRegister("email", e.target.value)}
                error={registerErrors.email}
              />

              <TextField
                label="Password"
                icon={<LockIcon />}
                type="password"
                name="new-password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={registerData.password}
                onChange={(e) => updateRegister("password", e.target.value)}
                error={registerErrors.password}
              />

              <TextField
                label="Re-enter password"
                icon={<LockIcon />}
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={registerData.confirmPassword}
                onChange={(e) =>
                  updateRegister("confirmPassword", e.target.value)
                }
                error={registerErrors.confirmPassword}
              />

              <TextField
                label="Phone number (optional)"
                icon={<PhoneIcon />}
                type="tel"
                name="phone"
                autoComplete="tel"
                value={registerData.phone}
                onChange={(e) => updateRegister("phone", e.target.value)}
                error={registerErrors.phone}
              />

              <div className="input-group">
                <label className="input-label">Register as</label>
                <select
                  className="input-field"
                  value={registerRole}
                  onChange={(e) => setRegisterRole(e.target.value)}
                >
                  <option value="Customer">Customer</option>
                  <option value="Salesman">Salesman</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>

              {registerRole === "Customer" && (
                <div className="questionnaire-section">
                  <div className="questionnaire-title">
                    Tell us a bit about yourself
                  </div>
                  <div className="questionnaire-hint">
                    This helps us recommend the right phone for you.
                  </div>

                  <div className="input-group">
                    <label className="input-label">Where are you from?</label>
                    <select
                      className="input-field"
                      value={questionnaire.location}
                      onChange={(e) =>
                        updateQuestionnaire("location", e.target.value)
                      }
                    >
                      <option value="">Select a city</option>
                      {NEPAL_CITIES.map((city) => (
                        <option key={city} value={city}>
                          {city}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="input-group">
                    <label className="input-label">
                      What's your budget range?
                    </label>
                    <select
                      className="input-field"
                      value={questionnaire.budget}
                      onChange={(e) =>
                        updateQuestionnaire("budget", e.target.value)
                      }
                    >
                      <option value="">Select a range</option>
                      <option value="under-200">Under €200</option>
                      <option value="200-500">€200 - €500</option>
                      <option value="500-1000">€500 - €1000</option>
                      <option value="above-1000">Above €1000</option>
                    </select>
                  </div>

                  <div className="input-group">
                    <label className="input-label">
                      What will you mainly use it for?
                    </label>
                    <div className="usage-options">
                      {USAGE_OPTIONS.map((option) => {
                        const selected = questionnaire.usage.includes(
                          option.value,
                        );
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`usage-chip ${selected ? "selected" : ""}`}
                            onClick={() => toggleUsage(option.value)}
                            aria-pressed={selected}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              <button type="submit" className="btn btn-primary w-full">
                Register
              </button>

              <div className="auth-footer">
                Already have an account?{" "}
                <span className="auth-link" onClick={() => onNavigate("login")}>
                  Sign in
                </span>
              </div>
            </form>
          ) : (
            <form onSubmit={handleOtpVerify}>
              <button
                type="button"
                className="back-btn"
                onClick={handleOtpBack}
                aria-label="Back to registration form"
              >
                <ChevronLeftIcon />
              </button>

              <div className="auth-title">Verify your email</div>
              <div className="auth-subtitle">
                We've sent a 6-digit verification code to{" "}
                <strong>{registerData.email}</strong>
              </div>

              <div className="step-indicator">
                <div className="step-dot active"></div>
                <div className="step-dot active"></div>
              </div>

              <OtpInputRow
                idPrefix="otp"
                otp={otp}
                error={otpError}
                onChange={handleOtpChange}
                onKeyDown={handleOtpKeyDown}
                onPaste={handleOtpPaste}
              />

              {otpResult?.status === "error" && (
                <div className="form-submit-error">{otpResult.message}</div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full otp-verify-btn"
                disabled={otpLoading || otpResult?.status === "success"}
              >
                {otpLoading ? "Verifying..." : "Verify Email"}
              </button>

              <div className="otp-resend">
                <span>Didn't receive the code? </span>
                {resendCooldown > 0 ? (
                  <span className="otp-timer">Resend in {resendCooldown}s</span>
                ) : (
                  <span className="auth-link" onClick={handleResendOtp}>
                    Resend
                  </span>
                )}
              </div>

              <div className="auth-footer">
                Back to{" "}
                <span className="auth-link" onClick={() => onNavigate("login")}>
                  Sign in
                </span>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (authPage === "forgot") {
    return (
      <div className="auth-page">
        <Toast
          status={resetResult?.status}
          message={
            resetResult?.status === "success" ? resetResult.message : null
          }
          onDone={goToLoginAfterReset}
        />
        <div className="auth-card">
          {forgotStep === 1 && (
            <form onSubmit={handleForgotEmailSubmit}>
              <button
                type="button"
                className="back-btn"
                onClick={() => onNavigate("login")}
                aria-label="Back to sign in"
              >
                <ChevronLeftIcon />
              </button>

              <div className="auth-title">Reset your password</div>
              <div className="auth-subtitle">
                Enter your account email to get an OTP to reset your password.
              </div>

              <TextField
                label="Email address"
                icon={<MailIcon />}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                error={forgotEmailError}
              />

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={forgotLoading}
              >
                {forgotLoading ? "Sending..." : "Send OTP"}
              </button>

              <div className="auth-footer">
                <span className="auth-link" onClick={() => onNavigate("login")}>
                  Back to sign in
                </span>
              </div>
            </form>
          )}

          {forgotStep === 2 && (
            <form onSubmit={handleForgotOtpVerify}>
              <button
                type="button"
                className="back-btn"
                onClick={handleForgotOtpBack}
                aria-label="Back to email entry"
              >
                <ChevronLeftIcon />
              </button>

              <div className="auth-title">Enter the code</div>
              <div className="auth-subtitle">
                We've sent a 6-digit verification code to{" "}
                <strong>{forgotEmail}</strong>
              </div>

              <OtpInputRow
                idPrefix="forgot-otp"
                otp={forgotOtp}
                error={forgotOtpError}
                onChange={handleForgotOtpChange}
                onKeyDown={handleForgotOtpKeyDown}
                onPaste={handleForgotOtpPaste}
              />

              <button
                type="submit"
                className="btn btn-primary w-full otp-verify-btn"
                disabled={forgotOtpLoading}
              >
                {forgotOtpLoading ? "Verifying..." : "Verify Code"}
              </button>

              <div className="otp-resend">
                <span>Didn't receive the code? </span>
                {forgotResendCooldown > 0 ? (
                  <span className="otp-timer">
                    Resend in {forgotResendCooldown}s
                  </span>
                ) : (
                  <span className="auth-link" onClick={handleForgotResendOtp}>
                    Resend
                  </span>
                )}
              </div>
            </form>
          )}

          {forgotStep === 3 && (
            <form onSubmit={handleResetPasswordSubmit}>
              <button
                type="button"
                className="back-btn"
                onClick={handleNewPasswordBack}
                aria-label="Back to code entry"
              >
                <ChevronLeftIcon />
              </button>

              <div className="auth-title">Set a new password</div>
              <div className="auth-subtitle">
                Enter and confirm your new password.
              </div>

              <TextField
                label="New password"
                icon={<LockIcon />}
                type="password"
                name="new-password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                error={newPasswordErrors.newPassword}
              />

              <TextField
                label="Re-enter new password"
                icon={<LockIcon />}
                type="password"
                name="confirm-new-password"
                autoComplete="new-password"
                placeholder="••••••••"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                error={newPasswordErrors.confirmNewPassword}
              />

              {resetResult?.status === "error" && (
                <div className="form-submit-error">{resetResult.message}</div>
              )}

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={resetLoading || resetResult?.status === "success"}
              >
                {resetLoading ? "Saving..." : "Reset Password"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page login-page">
      <div className="login-container">
        <div
          className="login-left"
          style={{ backgroundImage: `url(${holdingPhone})` }}
        >
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
            <form onSubmit={handleLoginSubmit}>
              <div className="auth-title">Sign in to your account</div>
              <div className="auth-subtitle">
                Welcome back. Enter your credentials to continue.
              </div>

              <TextField
                label="Email address"
                icon={<MailIcon />}
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={loginErrors.email}
              />

              <div className="input-group">
                <label className="input-label">Password</label>
                <div className="input-with-icon password-field">
                  <span className="input-icon">
                    <LockIcon />
                  </span>
                  <input
                    className={`input-field ${loginErrors.password ? "error" : ""}`}
                    type={showPassword ? "text" : "password"}
                    name="password"
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                  >
                    {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
                {loginErrors.password && (
                  <div className="input-error">{loginErrors.password}</div>
                )}
              </div>

              <div className="input-group">
                <label className="input-label">Login As</label>
                <select
                  className="input-field"
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                >
                  <option value="Customer">Customer</option>
                  <option value="Admin">Admin</option>
                  <option value="Salesman">Salesman</option>
                </select>
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
                <span
                  className="auth-link"
                  onClick={() => onNavigate("forgot")}
                >
                  Forgot password?
                </span>
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full login-btn"
                disabled={loading}
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>

              <div className="auth-footer">
                Don't have an account?{" "}
                <span
                  className="auth-link"
                  onClick={() => onNavigate("register")}
                >
                  Create one
                </span>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Login;
