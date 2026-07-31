import { useState, useEffect, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import api from "../services/api";
import "./Login.css";
import {
  MailIcon,
  UserIcon,
  PhoneIcon,
  ChevronLeftIcon,
  TextField,
  PasswordField,
  OtpInputRow,
  Toast,
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_RULES,
  PASSWORD_HINT,
  SELF_ASSIGNABLE_ROLES,
  OTP_LENGTH,
  RESEND_COOLDOWN_SECONDS,
  EMPTY_OTP,
  TOAST_DURATION_MS,
} from "./AuthShared";

const REGISTER_ROLE_OPTIONS = [...SELF_ASSIGNABLE_ROLES, "Admin"];

function Registration({ onLogin }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Issue 2 — registration is now a 3-step flow:
  //   /register              → step 1 (basic info)
  //   /register/preferences  → step 2 (onboarding)
  //   /register/otp          → step 3 (OTP)
  const step = location.pathname.endsWith("/otp")
    ? 3
    : location.pathname.endsWith("/preferences")
      ? 2
      : 1;

  const [registerData, setRegisterData] = useState({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
    phone: "",
  });
  const [registerRole, setRegisterRole] = useState("Customer");
  const [registerErrors, setRegisterErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);

  // Issue 2 — onboarding answers. Held in component state across the
  // step-1 → step-2 navigation. Submitted alongside the basic-info
  // fields in the single POST /auth/register call from step 2.
  const [prefData, setPrefData] = useState({
    persona: "allrounder",
    budgetMin: 0,
    budgetMax: 1500,
    preferredBrands: [],
  });
  const [prefErrors, setPrefErrors] = useState({});
  const [brands, setBrands] = useState([]);

  const [otp, setOtp] = useState(EMPTY_OTP);
  const [otpError, setOtpError] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendLoading, setResendLoading] = useState(false);
  const [otpResult, setOtpResult] = useState(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);
  useEffect(() => {
    // Only the OTP step requires registerData.email to be present;
    // the new /register/preferences step is allowed even when the
    // email hasn't been entered yet — it'll just bounce back to
    // step 1 when the user clicks "Create account".
    if (step === 3 && !registerData.email) {
      navigate("/register", { replace: true });
    }
  }, [step, registerData.email, navigate]);

  // Issue 2 — load the brand list on mount so the preferences step's
  // multi-select can render. Same source as PhoneListing.jsx uses
  // (`GET /api/phones/filters` → `data.brands`).
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await api.get("/phones/filters");
        const list = res?.data?.data?.brands;
        if (!ignore && Array.isArray(list)) setBrands(list);
      } catch (err) {
        if (!ignore) {
          console.warn("Failed to load brand list for onboarding:", err?.message || err);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const validateRegister = useCallback(() => {
    const e = {};
    if (!registerData.username) e.username = "Username is required";
    if (!registerData.email || !EMAIL_REGEX.test(registerData.email))
      e.email = "Valid email required";
    if (!registerData.password) e.password = "Password is required";
    else if (registerData.password.length < PASSWORD_MIN_LENGTH)
      e.password = `Minimum ${PASSWORD_MIN_LENGTH} characters`;
    else if (!PASSWORD_RULES.test(registerData.password))
      e.password =
        "Must include uppercase, lowercase, number, and special character";
    if (registerData.confirmPassword !== registerData.password)
      e.confirmPassword = "Passwords do not match";
    if (registerData.phone && !/^\+?[0-9\s-]{7,15}$/.test(registerData.phone))
      e.phone = "Enter a valid phone number";
    return e;
  }, [registerData]);

  // Map a backend validation `details` array (express-validator) onto the
  // FE's per-field error map. Each entry has `path` (field name) and `msg`
  // (human-readable message). Unknown fields fall through to the banner.
  const mapServerFieldErrors = useCallback((details) => {
    const fieldErrors = {};
    let bannerMessage = "";
    if (!Array.isArray(details)) return { fieldErrors, bannerMessage };

    for (const entry of details) {
      const rawPath = entry?.path;
      const msg = entry?.msg || entry?.message;
      // express-validator uses `path`; older responses may use `field`.
      const serverKey = rawPath || entry?.field;
      if (!msg) continue;

      // Map backend field names to the FE's local names.
      let feKey = null;
      if (serverKey === "name") feKey = "username";
      else if (serverKey === "phoneNo") feKey = "phone";
      else if (
        serverKey === "email" ||
        serverKey === "password" ||
        serverKey === "confirmPassword"
      ) {
        feKey = serverKey;
      }

      if (feKey) {
        fieldErrors[feKey] = msg;
      } else {
        // No matching field — surface in the form-level banner.
        bannerMessage = bannerMessage ? `${bannerMessage}; ${msg}` : msg;
      }
    }
    return { fieldErrors, bannerMessage };
  }, []);

  const handleRegisterNext = useCallback(
    (e) => {
      e?.preventDefault();
      setServerError("");
      setRegisterErrors({});
      const validationErrors = validateRegister();
      setRegisterErrors(validationErrors);
      if (Object.keys(validationErrors).length) return;

      // Issue 2 — Step 1 no longer calls /auth/register. We hold
      // basic-info in component state and forward to the new
      // /register/preferences step where the user picks persona /
      // budget / brands. The combined payload is submitted in the
      // single POST /auth/register call from step 2.
      navigate("/register/preferences");
    },
    [validateRegister, navigate],
  );

  // Build the basic-info body used by both step-2 submit paths.
  const buildRegisterBody = useCallback(
    () => ({
      name: registerData.username,
      email: registerData.email,
      password: registerData.password,
      confirmPassword: registerData.confirmPassword,
      phoneNo: registerData.phone,
      roleName: registerRole,
    }),
    [registerData, registerRole],
  );

  // Client-side validation for the onboarding step. Returns an error
  // map keyed on FE field names; empty map = pass.
  const validatePreferences = useCallback(() => {
    const errs = {};
    const min = Number(prefData.budgetMin);
    const max = Number(prefData.budgetMax);
    if (!Number.isFinite(min) || min < 0) errs.budgetMin = "Enter a non-negative number";
    if (!Number.isFinite(max) || max <= 0) errs.budgetMax = "Enter a positive number";
    if (Number.isFinite(min) && Number.isFinite(max) && max <= min)
      errs.budgetMax = "Max budget must be greater than min";
    if (!["gamer", "camera", "battery", "allrounder"].includes(prefData.persona))
      errs.persona = "Pick a usage type";
    return errs;
  }, [prefData]);

  // Issue 2 — submit the single POST /auth/register call with both
  // the basic-info fields and the onboarding answers. The BE
  // upserts UserPreference + CustomerProfile in the same transaction
  // that creates the Users row + Otp row.
  const submitRegisterWithPrefs = useCallback(
    async (includePrefs) => {
      const body = buildRegisterBody();
      if (includePrefs) {
        body.persona = prefData.persona;
        body.budgetMin = Number(prefData.budgetMin);
        body.budgetMax = Number(prefData.budgetMax);
        if (Array.isArray(prefData.preferredBrands) && prefData.preferredBrands.length > 0) {
          body.preferredBrands = prefData.preferredBrands;
        }
      }

      setRegisterLoading(true);
      try {
        await api.post("/auth/register", body);
        setResendCooldown(RESEND_COOLDOWN_SECONDS);
        navigate("/register/otp");
      } catch (error) {
        console.error(error);
        const data = error.response?.data;
        const { fieldErrors, bannerMessage } = mapServerFieldErrors(
          data?.details,
        );
        if (Object.keys(fieldErrors).length) {
          // Field-level errors on the basic-info fields belong on
          // step 1; route the user back there so they can fix it.
          const basicFields = ["username", "email", "password", "confirmPassword", "phone"];
          const hit = basicFields.find((k) => fieldErrors[k]);
          if (hit) {
            setRegisterErrors(fieldErrors);
            setServerError(
              bannerMessage || data?.message || "Please review your basic info.",
            );
            navigate("/register");
            return;
          }
          setPrefErrors(fieldErrors);
        }
        setServerError(
          bannerMessage || data?.message || "Registration failed. Please try again.",
        );
      } finally {
        setRegisterLoading(false);
      }
    },
    [buildRegisterBody, prefData, mapServerFieldErrors, navigate],
  );

  const handlePrefSubmit = useCallback(
    async (e) => {
      e?.preventDefault();
      setServerError("");
      setPrefErrors({});
      const errs = validatePreferences();
      setPrefErrors(errs);
      if (Object.keys(errs).length) return;
      await submitRegisterWithPrefs(true);
    },
    [validatePreferences, submitRegisterWithPrefs],
  );

  const handlePrefSkip = useCallback(async () => {
    setServerError("");
    setPrefErrors({});
    await submitRegisterWithPrefs(false);
  }, [submitRegisterWithPrefs]);

  const handleOtpChange = useCallback((index, value) => {
    if (!/^\d?$/.test(value)) return;
    setOtp((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
    setOtpError("");
    if (value && index < OTP_LENGTH - 1)
      document.getElementById(`otp-${index + 1}`)?.focus();
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
      id: registerData.email,
      userId: registerData.email,
      name: registerData.username,
      email: registerData.email,
      phoneNo: registerData.phone,
      roleName: registerRole,
    });
  }, [registerData, registerRole, onLogin]);

  const handleOtpVerify = useCallback(
    async (e) => {
      e?.preventDefault();
      const otpString = otp.join("");
      if (otpString.length !== OTP_LENGTH) {
        setOtpError("Please enter the full 6-digit code");
        return;
      }
      setOtpLoading(true);
      setOtpError("");

      try {
        await api.post("/auth/verify", {
          email: registerData.email,
          otp: otpString,
        });

        try {
          await api.post("/auth/login", {
            email: registerData.email,
            password: registerData.password,
            roleName: registerRole,
          });
        } catch (loginErr) {
          console.error("auto-login after verify failed", loginErr);
        }

        setOtpResult({
          status: "success",
          message: "Registration successful!!",
        });
        setTimeout(completeRegistration, TOAST_DURATION_MS);
      } catch (error) {
        console.error(error);
        setOtpResult({
          status: "error",
          message:
            error.response?.data?.message ||
            "We couldn't verify that code. Please try again.",
        });
      } finally {
        setOtpLoading(false);
      }
    },
    [
      otp,
      registerData.email,
      registerData.password,
      registerRole,
      completeRegistration,
    ],
  );

  const handleResendOtp = useCallback(async () => {
    setResendLoading(true);
    try {
      await api.post("/auth/resend", { email: registerData.email });
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setOtp(EMPTY_OTP);
      setOtpError("");
      setOtpResult(null);
    } catch (error) {
      console.error(error);
      setOtpError(
        error.response?.data?.message || "Couldn't resend the code",
      );
    } finally {
      setResendLoading(false);
    }
  }, [registerData.email]);

  // Issue 2 — going back from the OTP step lands on the preferences step
  // (the new step between basic-info and OTP) so the user can adjust
  // their onboarding answers without re-entering basic-info.
  const handleOtpBack = useCallback(() => {
    setOtp(EMPTY_OTP);
    setOtpError("");
    setOtpResult(null);
    navigate("/register/preferences");
  }, [navigate]);

  const handlePrefBack = useCallback(() => {
    setPrefErrors({});
    setServerError("");
    navigate("/register");
  }, [navigate]);

  const updateRegister = useCallback((key, value) => {
    setRegisterData((prev) => ({ ...prev, [key]: value }));
    setRegisterErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setServerError("");
  }, []);

  const updatePref = useCallback((key, value) => {
    setPrefData((prev) => ({ ...prev, [key]: value }));
    setPrefErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setServerError("");
  }, []);

  const toggleBrand = useCallback((brandName) => {
    setPrefData((prev) => {
      const set = new Set(prev.preferredBrands || []);
      if (set.has(brandName)) set.delete(brandName);
      else set.add(brandName);
      return { ...prev, preferredBrands: Array.from(set) };
    });
    setServerError("");
  }, []);

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
              onClick={() => navigate("/login")}
              aria-label="Back to sign in"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Register Now</div>
            <div className="auth-subtitle">
              Create an account to get started
            </div>

            <div className="step-indicator">
              <div className="step-dot active"></div>
              <div className="step-dot"></div>
              <div className="step-dot"></div>
            </div>

            {serverError && (
              <div
                className="server-error"
                role="alert"
                style={{
                  background: "#fef2f2",
                  color: "#dc2626",
                  padding: "12px",
                  borderRadius: "8px",
                  marginBottom: "16px",
                  fontSize: "14px",
                }}
              >
                {serverError}
              </div>
            )}

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
              placeholder="Enter your email"
              value={registerData.email}
              onChange={(e) => updateRegister("email", e.target.value)}
              error={registerErrors.email}
            />

            <PasswordField
              label="Password"
              name="new-password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={registerData.password}
              onChange={(e) => updateRegister("password", e.target.value)}
              error={registerErrors.password}
              hint={PASSWORD_HINT}
            />

            <PasswordField
              label="Re-enter password"
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
                {REGISTER_ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={registerLoading}
            >
              {/* Issue 2 — Step 1 no longer registers. It validates and
                  navigates to the new /register/preferences step where
                  the actual POST /auth/register happens. */}
              {registerLoading ? "Submitting..." : "Continue"}
            </button>

            <div className="auth-footer">
              Already have an account?{" "}
              <span className="auth-link" onClick={() => navigate("/login")}>
                Sign in
              </span>
            </div>
          </form>
        ) : step === 2 ? (
          // Issue 2 — onboarding step. Filled before the OTP is sent;
          // the basic-info fields are still in component state and will
          // be sent in the same POST /auth/register from this step.
          <form onSubmit={handlePrefSubmit}>
            <button
              type="button"
              className="back-btn"
              onClick={handlePrefBack}
              aria-label="Back to registration form"
            >
              <ChevronLeftIcon />
            </button>

            <div className="auth-title">Tell us what you need</div>
            <div className="auth-subtitle">
              A few quick picks so we can rank the catalog for you. You can
              change these anytime.
            </div>

            <div className="step-indicator">
              <div className="step-dot active"></div>
              <div className="step-dot active"></div>
              <div className="step-dot"></div>
            </div>

            {serverError && (
              <div
                className="server-error"
                role="alert"
                style={{
                  background: "#fef2f2",
                  color: "#dc2626",
                  padding: "12px",
                  borderRadius: "8px",
                  marginBottom: "16px",
                  fontSize: "14px",
                }}
              >
                {serverError}
              </div>
            )}

            <div className="input-group">
              <label className="input-label">What will you mainly use it for?</label>
              <div className="onboarding-personas">
                {[
                  { key: "gamer", label: "Gaming" },
                  { key: "camera", label: "Camera" },
                  { key: "battery", label: "Battery" },
                  { key: "allrounder", label: "All-round" },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className={`persona-chip ${prefData.persona === opt.key ? "active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="persona"
                      value={opt.key}
                      checked={prefData.persona === opt.key}
                      onChange={(e) => updatePref("persona", e.target.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
              {prefErrors.persona && (
                <div className="field-error">{prefErrors.persona}</div>
              )}
            </div>

            <div className="input-group">
              <label className="input-label">Budget range (EUR)</label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "12px",
                }}
              >
                <TextField
                  label="Min"
                  type="number"
                  inputMode="numeric"
                  name="budgetMin"
                  placeholder="0"
                  value={prefData.budgetMin}
                  onChange={(e) => updatePref("budgetMin", e.target.value)}
                  error={prefErrors.budgetMin}
                />
                <TextField
                  label="Max"
                  type="number"
                  inputMode="numeric"
                  name="budgetMax"
                  placeholder="1500"
                  value={prefData.budgetMax}
                  onChange={(e) => updatePref("budgetMax", e.target.value)}
                  error={prefErrors.budgetMax}
                />
              </div>
            </div>

            <div className="input-group">
              <label className="input-label">
                Preferred brands (optional)
              </label>
              {brands.length === 0 ? (
                <p
                  className="auth-subtitle"
                  style={{ fontSize: "13px", marginBottom: "8px" }}
                >
                  Loading brand list…
                </p>
              ) : (
                <div className="onboarding-brands">
                  {brands.map((b) => {
                    const selected =
                      prefData.preferredBrands.includes(b.name);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`brand-chip ${selected ? "active" : ""}`}
                        onClick={() => toggleBrand(b.name)}
                      >
                        {b.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={registerLoading}
            >
              {registerLoading ? "Creating account…" : "Create account"}
            </button>

            <button
              type="button"
              className="btn btn-outline w-full"
              style={{ marginTop: "8px" }}
              onClick={handlePrefSkip}
              disabled={registerLoading}
            >
              Skip for now
            </button>

            <div className="auth-footer">
              Back to{" "}
              <span className="auth-link" onClick={() => navigate("/login")}>
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
                <span
                  className="auth-link"
                  onClick={resendLoading ? undefined : handleResendOtp}
                >
                  {resendLoading ? "Resending..." : "Resend"}
                </span>
              )}
            </div>

            <div className="auth-footer">
              Back to{" "}
              <span className="auth-link" onClick={() => navigate("/login")}>
                Sign in
              </span>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default Registration;
